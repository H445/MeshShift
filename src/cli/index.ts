#!/usr/bin/env node
/**
 * CLI entry point. Built to dist/cli/gltf-to-fbx.mjs.
 * Supports single-file and bulk conversion via `pnpm dlx gltf-to-fbx`.
 *
 * Conversion path: GLB/GLTF → optional three.js optimization pass
 * (decimation / merge / LODs / texture resize) → assimpjs
 * (repalash fork, FBX export enabled) → FBX 7.4 binary.
 */
import { Command } from 'commander';
import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises';
import { resolve, basename, extname, join, dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import JSZip from 'jszip';

const program = new Command();

program
  .name('gltf-to-fbx')
  .description('Convert GLB/GLTF to FBX 7.4. Preserves PBR materials, textures, and skinning.')
  .argument('<inputs...>', 'One or more input .glb/.gltf files or directories')
  .option('-o, --output <dir>', 'Output directory (default: same dir as input for single files)')
  .option('-r, --recursive', 'Recurse into subdirectories', false)
  .option('--parallel <n>', 'Concurrent conversions (default: CPU count - 1, max 8)', Number)
  .option(
    '--no-embed-textures',
    'Reference textures by path instead of embedding (passed to assimp)',
  )
  .option('--scale <n>', 'Apply uniform scale (default: 1)', Number)
  .option('--axis <axis>', 'Output axis (y-up|z-up)', 'y-up')
  .option('--json', 'Emit a JSON sidecar per file with stats', false)
  .option('--zip', 'Pack all outputs into a single .zip (bulk mode)', false)
  .option('-v, --verbose', 'Verbose per-file progress to stderr', false)
  // --- Game-engine optimization ---
  .option(
    '--target-engine <engine>',
    'Target engine preset (auto|unity|unreal|godot). Sets axis + texture size defaults.',
    'auto',
  )
  .option(
    '--max-texture-size <px>',
    'Downsample textures above this size (256|512|1024|2048|4096|8192). 8192 = no resize.',
    Number,
    2048,
  )
  .option(
    '--max-triangles <n>',
    'Decimate any mesh above N triangles (0 = no decimation, requires three.js preprocessing)',
    Number,
    0,
  )
  .option(
    '--merge-by-material',
    'Merge meshes that share a material into a single draw call (three.js preprocessing)',
    false,
  )
  .option(
    '--generate-lods <n>',
    'Generate N LOD levels in addition to LOD0 (three.js preprocessing)',
    Number,
    0,
  )
  .option('--animation <filter>', 'Animation filter (all|skeletal|none)', 'all')
  .option('--no-morph', 'Skip morph target export')
  .showHelpAfterError();

program.parse(process.argv);

const opts = program.opts();
const inputs: string[] = program.args as string[];

function validateOptions(): void {
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
  outputPath: string;
  name: string;
}

interface JobResult {
  job: FileJob;
  ok: boolean;
  outputBytes?: number;
  durationMs: number;
  stats?: Record<string, unknown>;
  error?: { name: string; message: string };
}

async function collectJobs(inputs: string[], recursive: boolean): Promise<FileJob[]> {
  const out: FileJob[] = [];
  for (const inp of inputs) {
    const abs = resolve(inp);
    const s = await stat(abs).catch(() => null);
    if (!s) {
      console.error(`✗ not found: ${inp}`);
      continue;
    }
    if (s.isDirectory()) {
      const entries = await readdir(abs, { withFileTypes: true });
      for (const e of entries) {
        const p = join(abs, e.name);
        if (e.isDirectory() && recursive) {
          out.push(...(await collectJobs([p], recursive)));
        } else if (e.isFile() && isGltf(e.name)) {
          out.push(makeJob(p));
        }
      }
    } else if (s.isFile() && isGltf(abs)) {
      out.push(makeJob(abs));
    } else {
      console.error(`✗ skipped (not a .glb/.gltf): ${inp}`);
    }
  }
  return out;
}

function isGltf(name: string): boolean {
  const n = name.toLowerCase();
  return n.endsWith('.glb') || n.endsWith('.gltf');
}

function makeJob(inputPath: string): FileJob {
  const base = basename(inputPath, extname(inputPath));
  const outputDir = opts.output ? resolve(opts.output) : dirname(inputPath);
  return {
    inputPath,
    outputPath: join(outputDir, `${base}.fbx`),
    name: basename(inputPath),
  };
}

function assertUniqueOutputs(jobs: FileJob[]): void {
  const seen = new Map<string, string>();
  for (const job of jobs) {
    const outputKey = resolve(job.outputPath).toLowerCase();
    const previous = seen.get(outputKey);
    if (previous) {
      program.error(
        `Output collision: "${previous}" and "${job.inputPath}" both map to "${job.outputPath}".`,
      );
    }
    seen.set(outputKey, job.inputPath);
  }

  if (opts.zip) {
    const zipEntries = new Map<string, string>();
    for (const job of jobs) {
      const entry = basename(job.outputPath).toLowerCase();
      const previous = zipEntries.get(entry);
      if (previous) {
        program.error(
          `Zip entry collision: "${previous}" and "${job.inputPath}" both map to "${basename(job.outputPath)}".`,
        );
      }
      zipEntries.set(entry, job.inputPath);
    }
  }
}

async function runInline(job: FileJob, index: number, total: number): Promise<JobResult> {
  const t0 = performance.now();
  try {
    const { convertGltfToFbx, optimizeGltf } = await import('../core/index.js');
    const data = await readFile(job.inputPath);

    const convertOpts = {
      name: job.name,
      targetEngine: opts.targetEngine,
      embedTextures: opts.embedTextures !== false,
      maxTextureSize: opts.maxTextureSize,
      scale: opts.scale,
      axis: opts.axis,
      animationFilter: opts.animation,
      morphTargets: opts.morph !== false,
      maxTriangles: opts.maxTriangles,
      mergeByMaterial: !!opts.mergeByMaterial,
      generateLODs: opts.generateLods,
      onProgress: (phase: string, pct: number) => {
        if (!opts.verbose) return;
        const p = Math.round(pct * 100);
        process.stderr.write(`  [${index + 1}/${total}] ${job.name} ${phase} ${p}%\n`);
      },
    };

    const hasOptimization =
      convertOpts.maxTriangles! > 0 ||
      convertOpts.mergeByMaterial === true ||
      convertOpts.generateLODs! > 0 ||
      (convertOpts.maxTextureSize ?? 2048) < 8192;

    let convertBuf: Uint8Array = data;
    if (hasOptimization) {
      if (opts.verbose) process.stderr.write(`  [${index + 1}/${total}] ${job.name} optimizing…\n`);
      const opt = await optimizeGltf(data, convertOpts);
      convertBuf = opt.data;
      if (opts.verbose) {
        process.stderr.write(
          `  [${index + 1}/${total}] ${job.name} optimized (${opt.changes.length} change${opt.changes.length === 1 ? '' : 's'})\n`,
        );
        for (const c of opt.changes) {
          process.stderr.write(`    [${c.kind}] ${c.detail}\n`);
        }
      }
    }

    const result = await convertGltfToFbx(convertBuf, convertOpts);
    const outDir = dirname(job.outputPath);
    await mkdir(outDir, { recursive: true });
    await writeFile(job.outputPath, result.data);
    if (opts.json) {
      const statsPath = job.outputPath.replace(/\.fbx$/, '.stats.json');
      await writeFile(
        statsPath,
        JSON.stringify(
          {
            ...result.stats,
            warnings: result.warnings,
            input: job.name,
            output: basename(job.outputPath),
            // CLI doesn't return optimize changes; the web UI does.
          },
          null,
          2,
        ),
      );
    }
    if (opts.verbose)
      console.error(`  [${index + 1}/${total}] ${job.name} → ${basename(job.outputPath)} ok`);
    return {
      job,
      ok: true,
      outputBytes: result.data.byteLength,
      stats: result.stats as unknown as Record<string, unknown>,
      durationMs: performance.now() - t0,
    };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return {
      job,
      ok: false,
      error: { name: e.name ?? 'Error', message: e.message ?? String(err) },
      durationMs: performance.now() - t0,
    };
  }
}

async function main() {
  const jobs = await collectJobs(inputs, opts.recursive);
  if (jobs.length === 0) {
    console.error('No .glb/.gltf files found.');
    process.exit(1);
  }
  assertUniqueOutputs(jobs);

  if (opts.output) await mkdir(resolve(opts.output), { recursive: true });

  const parallel = opts.parallel ?? Math.max(1, Math.min(8, cpus().length - 1));

  console.error(`Converting ${jobs.length} file(s) with parallelism ${parallel}…`);

  const results: JobResult[] = new Array(jobs.length);
  let cursor = 0;
  async function worker() {
    while (cursor < jobs.length) {
      const i = cursor++;
      results[i] = await runInline(jobs[i], i, jobs.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, worker));

  if (opts.zip) {
    console.error('Packing into zip…');
    const zip = new JSZip();
    for (const r of results) {
      if (r.ok) {
        const data = await readFile(r.job.outputPath);
        zip.file(basename(r.job.outputPath), data);
      }
    }
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const zipPath = join(resolve(opts.output ?? process.cwd()), 'gltf-to-fbx.zip');
    await writeFile(zipPath, buf);
    console.error(`  → ${zipPath}`);
  }

  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;
  console.error('');
  console.error('Summary:');
  for (const r of results) {
    if (r.ok) {
      console.error(
        `  ✓ ${r.job.name}  →  ${basename(r.job.outputPath)}  (${r.durationMs.toFixed(0)} ms)`,
      );
    } else {
      console.error(`  ✗ ${r.job.name}  ${r.error?.name ?? ''}: ${r.error?.message ?? ''}`);
    }
  }
  console.error(`\n${okCount} ok, ${failCount} failed.`);

  if (failCount > 0 && okCount === 0) process.exit(2);
  if (failCount > 0) process.exit(4);
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
