#!/usr/bin/env node
import { Command } from 'commander';
import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises';
import { resolve, basename, extname, join, dirname, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import JSZip from 'jszip';
import {
  INPUT_FORMATS,
  OUTPUT_FORMATS,
  isSupportedInputName,
  outputFilename,
  type AssetFile,
  type ConvertPhase,
  type ConvertResult,
  type OutputFormat,
} from '../core/index.js';

const program = new Command();
const inputList = INPUT_FORMATS.map((format) => `.${format.extension}`).join(', ');
const outputList = OUTPUT_FORMATS.map((format) => format.id).join(', ');

program
  .name('modelshift')
  .description('Offline conversion between mainstream 3D asset formats.')
  .argument('<inputs...>', `One or more files or directories (${inputList})`)
  .option('-f, --format <format>', `Output format: ${outputList}`, 'fbx')
  .option('-o, --output <dir>', 'Output directory (default: same directory as each input)')
  .option('-r, --recursive', 'Recurse into subdirectories', false)
  .option('--parallel <n>', 'Concurrent conversions (default: CPU count - 1, max 8)', Number)
  .option('--no-embed-textures', 'Keep textures as companion files when supported')
  .option('--scale <n>', 'Apply uniform scale (default: 1)', Number)
  .option('--axis <axis>', 'Output axis (y-up|z-up)', 'y-up')
  .option('--json', 'Emit a JSON sidecar per asset with stats', false)
  .option('--zip', 'Pack successful outputs into modelshift.zip', false)
  .option('-v, --verbose', 'Verbose per-file progress to stderr', false)
  .option('--target-engine <engine>', 'Engine preset (auto|unity|unreal|godot)', 'auto')
  .option(
    '--max-texture-size <px>',
    'Maximum texture dimension; 8192 disables resizing',
    Number,
    8192,
  )
  .option('--max-triangles <n>', 'Triangle cap per mesh; 0 disables decimation', Number, 0)
  .option('--merge-by-material', 'Merge meshes sharing a material', false)
  .option('--generate-lods <n>', 'Generate N additional LOD levels', Number, 0)
  .option('--animation <filter>', 'Animation filter (all|skeletal|none)', 'all')
  .option('--no-morph', 'Skip morph targets')
  .showHelpAfterError();

program.parse(process.argv);
const opts = program.opts();
const inputs = program.args as string[];

function validateOptions(): void {
  if (!OUTPUT_FORMATS.some((format) => format.id === opts.format)) {
    program.error(`--format must be one of ${outputList}.`);
  }
  if (
    opts.parallel !== undefined &&
    (!Number.isInteger(opts.parallel) || opts.parallel < 1 || opts.parallel > 8)
  ) {
    program.error('--parallel must be an integer from 1 to 8.');
  }
  if (!Number.isFinite(opts.scale ?? 1) || (opts.scale ?? 1) <= 0) {
    program.error('--scale must be a positive number.');
  }
  if (!Number.isInteger(opts.maxTriangles) || opts.maxTriangles < 0) {
    program.error('--max-triangles must be a non-negative integer.');
  }
  if (!Number.isInteger(opts.generateLods) || opts.generateLods < 0 || opts.generateLods > 8) {
    program.error('--generate-lods must be an integer from 0 to 8.');
  }
  if (![256, 512, 1024, 2048, 4096, 8192].includes(opts.maxTextureSize)) {
    program.error('--max-texture-size must be one of 256, 512, 1024, 2048, 4096, or 8192.');
  }
  if (!['y-up', 'z-up'].includes(opts.axis)) {
    program.error('--axis must be either y-up or z-up.');
  }
  if (!['auto', 'unity', 'unreal', 'godot'].includes(opts.targetEngine)) {
    program.error('--target-engine must be one of auto, unity, unreal, or godot.');
  }
  if (!['all', 'skeletal', 'none'].includes(opts.animation)) {
    program.error('--animation must be one of all, skeletal, or none.');
  }
}
validateOptions();

interface FileJob {
  inputPath: string;
  outputDir: string;
  name: string;
}

interface JobResult {
  job: FileJob;
  ok: boolean;
  outputs?: Array<{ path: string; data: Uint8Array }>;
  durationMs: number;
  result?: ConvertResult;
  error?: { name: string; message: string };
}

function makeJob(inputPath: string): FileJob {
  return {
    inputPath,
    outputDir: opts.output ? resolve(opts.output) : dirname(inputPath),
    name: basename(inputPath),
  };
}

async function collectJobs(paths: string[], recursive: boolean): Promise<FileJob[]> {
  const jobs: FileJob[] = [];
  for (const input of paths) {
    const absolute = resolve(input);
    const info = await stat(absolute).catch(() => null);
    if (!info) {
      console.error(`✗ not found: ${input}`);
      continue;
    }
    if (info.isDirectory()) {
      for (const entry of await readdir(absolute, { withFileTypes: true })) {
        const path = join(absolute, entry.name);
        if (entry.isDirectory() && recursive) {
          jobs.push(...(await collectJobs([path], true)));
        } else if (entry.isFile() && isSupportedInputName(entry.name)) {
          jobs.push(makeJob(path));
        }
      }
    } else if (info.isFile() && isSupportedInputName(absolute)) {
      jobs.push(makeJob(absolute));
    } else {
      console.error(`✗ skipped (unsupported 3D input): ${input}`);
    }
  }
  return jobs;
}

function referencesFrom(name: string, data: Uint8Array): string[] {
  const extension = extname(name).toLowerCase();
  const text = new TextDecoder().decode(data);
  if (extension === '.gltf') {
    try {
      const document = JSON.parse(text) as {
        buffers?: Array<{ uri?: string }>;
        images?: Array<{ uri?: string }>;
      };
      return [...(document.buffers ?? []), ...(document.images ?? [])]
        .map((item) => item.uri)
        .filter((uri): uri is string => Boolean(uri && !/^(data:|https?:)/i.test(uri)));
    } catch {
      return [];
    }
  }
  if (extension === '.obj') {
    return Array.from(text.matchAll(/^\s*mtllib\s+(.+)$/gim), (match) => match[1].trim());
  }
  if (extension === '.mtl') {
    return Array.from(
      text.matchAll(/^\s*(?:map_\w+|bump|disp|decal)\s+(.+)$/gim),
      (match) => match[1].trim().split(/\s+/).pop() ?? '',
    ).filter(Boolean);
  }
  if (extension === '.dae') {
    return Array.from(text.matchAll(/<init_from>\s*([^<]+)\s*<\/init_from>/gim), (match) =>
      match[1].trim(),
    );
  }
  return [];
}

async function loadAssetFiles(inputPath: string): Promise<AssetFile[]> {
  const root = dirname(inputPath);
  const queue = [inputPath];
  const seen = new Set<string>();
  const files: AssetFile[] = [];
  while (queue.length > 0) {
    const path = resolve(queue.shift()!);
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const data = new Uint8Array(await readFile(path));
    const virtualName = relative(root, path).replace(/\\/g, '/');
    files.push({ name: virtualName, data });
    for (const uri of referencesFrom(path, data)) {
      const reference = resolve(dirname(path), decodeURIComponent(uri));
      if (
        await stat(reference)
          .then((value) => value.isFile())
          .catch(() => false)
      ) {
        queue.push(reference);
      } else if (opts.verbose) {
        console.error(`    missing companion: ${uri}`);
      }
    }
  }
  return files;
}

function assertUniqueOutputs(jobs: FileJob[], format: OutputFormat): void {
  const seen = new Map<string, string>();
  for (const job of jobs) {
    const path = resolve(job.outputDir, outputFilename(job.name, format)).toLowerCase();
    const previous = seen.get(path);
    if (previous) {
      program.error(
        `Output collision: "${previous}" and "${job.inputPath}" both map to "${path}".`,
      );
    }
    seen.set(path, job.inputPath);
  }
}

async function runJob(job: FileJob, index: number, total: number): Promise<JobResult> {
  const started = performance.now();
  try {
    const { convertAsset, optimizeGltf } = await import('../core/index.js');
    let sourceFiles = await loadAssetFiles(job.inputPath);
    const outputFormat = opts.format as OutputFormat;
    const convertOptions = {
      outputFormat,
      name: job.name,
      targetEngine: opts.targetEngine,
      embedTextures: opts.embedTextures !== false,
      maxTextureSize: opts.maxTextureSize,
      scale: opts.scale,
      axis: opts.axis,
      animationFilter: opts.animation,
      morphTargets: opts.morph !== false,
      maxTriangles: opts.maxTriangles,
      mergeByMaterial: Boolean(opts.mergeByMaterial),
      generateLODs: opts.generateLods,
      onProgress: (phase: ConvertPhase, pct: number) => {
        if (opts.verbose) {
          process.stderr.write(
            `  [${index + 1}/${total}] ${job.name} ${phase} ${Math.round(pct * 100)}%\n`,
          );
        }
      },
    };
    const optimize =
      convertOptions.maxTriangles > 0 ||
      convertOptions.mergeByMaterial ||
      convertOptions.generateLODs > 0 ||
      convertOptions.maxTextureSize < 8192;

    if (optimize) {
      if (opts.verbose) console.error(`  [${index + 1}/${total}] ${job.name} normalizing…`);
      const normalized = await convertAsset(sourceFiles, {
        ...convertOptions,
        outputFormat: 'glb',
      });
      const optimized = await optimizeGltf(normalized.data, convertOptions);
      sourceFiles = [
        {
          name: `${basename(job.name, extname(job.name))}.glb`,
          data: optimized.data,
        },
      ];
    }

    const result = await convertAsset(sourceFiles, convertOptions);
    await mkdir(job.outputDir, { recursive: true });
    const outputs: Array<{ path: string; data: Uint8Array }> = [];
    for (const file of result.files) {
      const path = join(job.outputDir, file.name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.data);
      outputs.push({ path, data: file.data });
    }
    if (opts.json) {
      const statsPath = join(job.outputDir, `${basename(job.name, extname(job.name))}.stats.json`);
      await writeFile(
        statsPath,
        JSON.stringify(
          {
            ...result.stats,
            warnings: result.warnings,
            input: job.name,
            outputs: result.files.map((file) => file.name),
          },
          null,
          2,
        ),
      );
    }
    return { job, ok: true, outputs, result, durationMs: performance.now() - started };
  } catch (error) {
    const detail = error as { name?: string; message?: string };
    return {
      job,
      ok: false,
      error: { name: detail.name ?? 'Error', message: detail.message ?? String(error) },
      durationMs: performance.now() - started,
    };
  }
}

async function main() {
  const jobs = await collectJobs(inputs, opts.recursive);
  if (jobs.length === 0) {
    console.error('No supported 3D files found.');
    process.exit(1);
  }
  const outputFormat = opts.format as OutputFormat;
  assertUniqueOutputs(jobs, outputFormat);
  if (opts.output) await mkdir(resolve(opts.output), { recursive: true });

  const parallel = opts.parallel ?? Math.max(1, Math.min(8, cpus().length - 1));
  console.error(
    `Converting ${jobs.length} asset(s) to ${outputFormat.toUpperCase()} with parallelism ${parallel}…`,
  );
  const results: JobResult[] = new Array(jobs.length);
  let cursor = 0;
  async function worker() {
    while (cursor < jobs.length) {
      const index = cursor++;
      results[index] = await runJob(jobs[index], index, jobs.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, () => worker()));

  if (opts.zip) {
    const zip = new JSZip();
    for (const result of results) {
      for (const output of result.outputs ?? []) zip.file(basename(output.path), output.data);
    }
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const zipPath = join(resolve(opts.output ?? process.cwd()), 'modelshift.zip');
    await writeFile(zipPath, buffer);
    console.error(`  → ${zipPath}`);
  }

  const succeeded = results.filter((result) => result.ok).length;
  console.error('\nSummary:');
  for (const result of results) {
    if (result.ok) {
      console.error(
        `  ✓ ${result.job.name} → ${(result.result?.files ?? []).map((file) => file.name).join(', ')} (${result.durationMs.toFixed(0)} ms)`,
      );
    } else {
      console.error(
        `  ✗ ${result.job.name} ${result.error?.name ?? ''}: ${result.error?.message ?? ''}`,
      );
    }
  }
  const failed = results.length - succeeded;
  console.error(`\n${succeeded} ok, ${failed} failed.`);
  if (failed > 0 && succeeded === 0) process.exit(2);
  if (failed > 0) process.exit(4);
}

main().catch((error) => {
  console.error('Fatal:', error);
  process.exit(1);
});
