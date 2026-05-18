#!/usr/bin/env bun
/**
 * CLI entry point for the Lore eval suite.
 *
 * Usage:
 *   bun packages/core/eval/run.ts                              # fixture mode, all dims
 *   bun packages/core/eval/run.ts --mode live                  # live mode, all dims
 *   bun packages/core/eval/run.ts --mode live --dimensions context,recall
 *   bun packages/core/eval/run.ts --mode live --gateway localhost:8787
 *   bun packages/core/eval/run.ts --baselines auto-mem0 --dimensions recall,preferences
 *   bun packages/core/eval/run.ts --summarize results/latest.jsonl
 *   bun packages/core/eval/run.ts --output results/eval-2025-05-16.jsonl
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { EvalConfig, EvalResult, Dimension, BaselineMode } from "./types";
import { ALL_DIMENSIONS, ALL_BASELINES } from "./types";
import { runEval, printSummary } from "./harness";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    mode: { type: "string", default: "fixture" },
    dimensions: { type: "string", default: "all" },
    baselines: { type: "string", default: "" },
    gateway: { type: "string", default: "" },
    model: { type: "string", default: "" },
    "judge-model": { type: "string", default: "" },
    concurrency: { type: "string", default: "3" },
    output: { type: "string", default: "" },
    record: { type: "string", default: "" },
    replay: { type: "string", default: "" },
    scenarios: { type: "string", default: "" },
    summarize: { type: "string", default: "" },
    help: { type: "boolean", default: false },
  },
  strict: true,
  allowPositionals: false,
});

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

if (args.help) {
  console.log(`
Lore Eval Suite

Usage:
  bun packages/core/eval/run.ts [options]

Options:
  --mode <fixture|live>       Execution mode (default: fixture)
  --dimensions <dim,...>      Comma-separated dimensions or "all"
                              Available: context, recall, preferences, cross-project, cost
  --baselines <mode,...>      Additional baselines to run
                              Available: lore, tail-window, compaction, raw,
                              lore-context-only, lore-memory-only, auto-mem0
  --gateway <host:port>       Gateway address for live mode (default: 127.0.0.1:8787)
  --model <name>              Model for conversation/QA (default: auto-detected)
  --judge-model <name>        Model for LLM-as-judge (default: same as --model)
  --concurrency <n>           Parallel question limit (default: 3)
  --output <path>             Output JSONL path (default: auto-generated)
  --record <dir>              Record session replay data to directory (first run)
  --replay <dir>              Replay session data from directory (skip upstream API calls)
  --scenarios <id,...>        Run only specific scenarios (e.g., pr-3-evolution)
  --summarize <path>          Print summary from existing JSONL file and exit
  --help                      Show this help
`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Summarize mode (read existing results, print, exit)
// ---------------------------------------------------------------------------

if (args.summarize) {
  const filePath = resolve(args.summarize);
  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const lines = readFileSync(filePath, "utf-8").trim().split("\n");
  const results: EvalResult[] = lines
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  printSummary(results);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Build config
// ---------------------------------------------------------------------------

function parseDimensions(raw: string): Dimension[] {
  if (raw === "all") return [...ALL_DIMENSIONS];
  return raw.split(",").map((d) => d.trim() as Dimension);
}

function parseBaselines(raw: string): BaselineMode[] {
  if (!raw) {
    // Default baselines depend on dimensions
    return ["lore", "tail-window", "compaction"];
  }
  return raw.split(",").map((b) => b.trim() as BaselineMode);
}

function parseGateway(raw: string): { host: string; port: number } | undefined {
  if (!raw) return undefined;
  const [host, portStr] = raw.split(":");
  return { host: host || "127.0.0.1", port: parseInt(portStr || "8787", 10) };
}

const outputPath =
  args.output ||
  resolve(
    import.meta.dir,
    "results",
    `eval-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-")}.jsonl`,
  );

if (args.record && args.replay) {
  console.error("Cannot use --record and --replay together");
  process.exit(1);
}

const config: EvalConfig = {
  mode: (args.mode as "fixture" | "live") || "fixture",
  gateway: parseGateway(args.gateway || ""),
  model: args.model || "claude-sonnet-4-6",
  judgeModel: args["judge-model"] || args.model || "claude-sonnet-4-6",
  concurrency: parseInt(args.concurrency || "3", 10),
  outputPath,
  dimensions: parseDimensions(args.dimensions || "all"),
  baselines: parseBaselines(args.baselines || ""),
  recordDir: args.record ? resolve(args.record) : undefined,
  replayDir: args.replay ? resolve(args.replay) : undefined,
  scenarios: args.scenarios ? args.scenarios.split(",").map((s) => s.trim()) : undefined,
};

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log(`Lore Eval Suite`);
console.log(`  Mode:       ${config.mode}`);
console.log(`  Dimensions: ${config.dimensions.join(", ")}`);
console.log(`  Baselines:  ${config.baselines.join(", ")}`);
if (config.recordDir) console.log(`  Recording:  ${config.recordDir}`);
if (config.replayDir) console.log(`  Replaying:  ${config.replayDir}`);
if (config.scenarios) console.log(`  Scenarios:  ${config.scenarios.join(", ")}`);
console.log(`  Output:     ${config.outputPath}`);
console.log(`  Model:      ${config.model}`);
console.log("");

const results = await runEval(config);
console.log("");
printSummary(results);

console.log(`\nResults written to: ${config.outputPath}`);
console.log(`Total questions: ${results.length}`);
