#!/usr/bin/env node
import { Command } from 'commander';
import { stat, readdir } from 'node:fs/promises';
import { resolve, basename, extname, join, dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import {
  INPUT_FORMATS,
  OUTPUT_FORMATS,
  isSupportedInputName,
  outputFilename,
  type ConvertPhase,
  type ConvertResult,
  type InspectResult,
  type OutputFormat,
} from '../core/index.js';
import { throwIfAborted } from '../core/progress.js';
import { loadAssetFiles } from './assetFiles.js';
import { writeZipArchive } from './archive.js';
import { writeOutputFile } from './outputFiles.js';

declare const __MODELSHIFT_VERSION__: string;

const program = new Command();
const inputList = INPUT_FORMATS.map((format) => `.${format.extension}`).join(', ');
const outputList = OUTPUT_FORMATS.map((format) => format.id).join(', ');

program
  .name('modelshift')
  .description('Offline conversion between mainstream 3D asset formats.')
  .version(__MODELSHIFT_VERSION__)
  .argument('<inputs...>', `One or more files or directories (${inputList})`)
  .option('-f, --format <format>', `Output format: ${outputList}`, 'fbx')
  .option('-o, --output <dir>', 'Output directory (default: same directory as each input)')
  .option('-r, --recursive', 'Recurse into subdirectories', false)
  .option('--parallel <n>', 'Concurrent conversions (default: CPU count - 1, max 8)', Number)
  .option('--json', 'Emit a JSON sidecar per asset with stats', false)
  .option('--zip', 'Pack successful outputs into modelshift.zip', false)
  .option('-v, --verbose', 'Verbose per-file progress to stderr', false)
  .option('--max-triangles <n>', 'Triangle cap per mesh; 0 disables decimation', Number, 0)
  .option('--merge-by-material', 'Merge meshes sharing a material', false)
  .option('--generate-lods <n>', 'Generate N additional LOD levels', Number, 0)
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
  if (!Number.isInteger(opts.maxTriangles) || opts.maxTriangles < 0) {
    program.error('--max-triangles must be a non-negative integer.');
  }
  if (!Number.isInteger(opts.generateLods) || opts.generateLods < 0 || opts.generateLods > 8) {
    program.error('--generate-lods must be an integer from 0 to 8.');
  }
}
validateOptions();

const operationController = new AbortController();
const handleInterrupt = (signalName: NodeJS.Signals): void => {
  if (operationController.signal.aborted) return;
  console.error(`\nReceived ${signalName}; cancelling the current operation…`);
  operationController.abort(`Operation interrupted by ${signalName}.`);
};
process.once('SIGINT', () => handleInterrupt('SIGINT'));
process.once('SIGTERM', () => handleInterrupt('SIGTERM'));

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

async function collectJobs(
  paths: string[],
  recursive: boolean,
  signal?: AbortSignal,
): Promise<FileJob[]> {
  const jobs: FileJob[] = [];
  for (const input of paths) {
    throwIfAborted(signal);
    const absolute = resolve(input);
    const info = await stat(absolute).catch(() => null);
    if (!info) {
      console.error(`✗ not found: ${input}`);
      continue;
    }
    if (info.isDirectory()) {
      for (const entry of await readdir(absolute, { withFileTypes: true })) {
        throwIfAborted(signal);
        const path = join(absolute, entry.name);
        if (entry.isDirectory() && recursive) {
          jobs.push(...(await collectJobs([path], true, signal)));
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

async function runJob(
  job: FileJob,
  index: number,
  total: number,
  signal: AbortSignal,
): Promise<JobResult> {
  const started = performance.now();
  try {
    const { convertAsset, convertPreparedAsset, optimizeGltf } = await import('../core/index.js');
    let sourceFiles = await loadAssetFiles(job.inputPath, Boolean(opts.verbose), signal);
    let sourceIsPrepared = false;
    let preparedStats: InspectResult | undefined;
    const outputFormat = opts.format as OutputFormat;
    const convertOptions = {
      outputFormat,
      name: job.name,
      // Node builds intentionally preserve texture bytes; resizing requires
      // the browser's canvas-backed image pipeline.
      maxTextureSize: 8192,
      maxTriangles: opts.maxTriangles,
      mergeByMaterial: Boolean(opts.mergeByMaterial),
      generateLODs: opts.generateLods,
      signal,
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
      sourceIsPrepared = true;
      preparedStats = optimized.stats;
    }

    const result =
      sourceIsPrepared && preparedStats
        ? await convertPreparedAsset(sourceFiles[0], {
            ...convertOptions,
            knownStats: preparedStats,
          })
        : await convertAsset(sourceFiles, convertOptions);
    const outputs: Array<{ path: string; data: Uint8Array }> = [];
    for (const file of result.files) {
      const path = await writeOutputFile(job.outputDir, file.name, file.data, signal);
      outputs.push({ path, data: file.data });
    }
    if (opts.json) {
      const statsName = `${basename(job.name, extname(job.name))}.stats.json`;
      await writeOutputFile(
        job.outputDir,
        statsName,
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
        signal,
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
  const signal = operationController.signal;
  const jobs = await collectJobs(inputs, opts.recursive, signal);
  if (jobs.length === 0) {
    console.error('No supported 3D files found.');
    process.exit(1);
  }
  const outputFormat = opts.format as OutputFormat;
  assertUniqueOutputs(jobs, outputFormat);
  const parallel = opts.parallel ?? Math.max(1, Math.min(8, cpus().length - 1));
  console.error(
    `Converting ${jobs.length} asset(s) to ${outputFormat.toUpperCase()} with parallelism ${parallel}…`,
  );
  const results: JobResult[] = new Array(jobs.length);
  let cursor = 0;
  async function worker() {
    while (cursor < jobs.length) {
      const index = cursor++;
      results[index] = await runJob(jobs[index], index, jobs.length, signal);
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, () => worker()));

  if (opts.zip && !signal.aborted) {
    const zipPath = await writeZipArchive(
      opts.output ?? process.cwd(),
      results.flatMap((result) => result.outputs ?? []),
      signal,
    );
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
  if (signal.aborted) {
    process.exitCode = 130;
    return;
  }
  if (failed > 0 && succeeded === 0) process.exit(2);
  if (failed > 0) process.exit(4);
}

main().catch((error) => {
  if (operationController.signal.aborted) {
    console.error('Cancelled.');
    process.exitCode = 130;
    return;
  }
  console.error('Fatal:', error);
  process.exit(1);
});
