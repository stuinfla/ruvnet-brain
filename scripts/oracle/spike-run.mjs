#!/usr/bin/env node
/**
 * scripts/oracle/spike-run.mjs — Step 14 feasibility-spike driver (ADR-086 C3 oracle).
 *
 * One repository per invocation, every stage synchronous, every artefact written OUTSIDE the
 * checkout: inventory (source-units) → subscription-only producer (produce-questions) → deterministic
 * validation (validate-labels) → one summary JSON the report is written from. This is the spike's
 * human-run driver; Step 15 decides whether and how prepareCorpusCandidate consumes these modules,
 * which is why nothing in the pipeline imports this file.
 *
 *   node scripts/oracle/spike-run.mjs --repo <name> --dir <snapshot> --out <dir> \
 *     [--commit <sha>] [--batch 20] [--max-claude-calls 8] [--max-codex-calls 8] [--effort medium] [--skip-produce]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInventory, resolveCommit } from './source-units.mjs';
import { produceQuestions, DEFAULT_BATCH } from './produce-questions.mjs';
import { loadBgeEmbedder, validateLabels } from './validate-labels.mjs';

function arg(argv, flag) { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; }
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

export async function runSpike({ repo, dir, out, commit, batchSize = DEFAULT_BATCH, maxClaudeCalls = 8, maxCodexCalls = 8, effort = 'medium', skipProduce = false, log = () => {} }) {
  fs.mkdirSync(out, { recursive: true });
  const started = Date.now();
  const inventory = buildInventory({ dir, repo, commit: resolveCommit(dir, commit) });
  writeJson(path.join(out, 'inventory.json'), inventory);
  log(`[spike] ${repo}@${inventory.commit.slice(0, 10)} U=${inventory.U} selected=${inventory.selectedCount}`);

  const labelsFile = path.join(out, 'labels.json');
  let labels;
  const produceStarted = Date.now();
  if (skipProduce && fs.existsSync(labelsFile)) {
    labels = JSON.parse(fs.readFileSync(labelsFile, 'utf8'));
    log('[spike] reusing existing labels.json');
  } else {
    labels = await produceQuestions({ inventory, snapshotDir: dir, batchSize, maxClaudeCalls, maxCodexCalls, effort, workDir: path.join(out, 'producer-work'), log });
    writeJson(labelsFile, labels);
  }
  const produceMs = Date.now() - produceStarted;

  const validateStarted = Date.now();
  const embed = await loadBgeEmbedder();
  const validation = await validateLabels({ labels, snapshotDir: dir, embed });
  writeJson(path.join(out, 'validation.json'), validation);
  const validateMs = Date.now() - validateStarted;

  const a = validation.aggregate;
  const calls = labels.calls;
  const summary = {
    repo, commit: inventory.commit, U: inventory.U, selected: inventory.selectedCount, N: 2 * inventory.selectedCount,
    strata: inventory.strata.length, coverage: { ...inventory.coverage, uncoveredFiles: undefined },
    producer: {
      claude: { requestedModel: labels.producer.claude.requestedModel, calls: calls.filter((c) => c.host === 'claude').length, ok: calls.filter((c) => c.host === 'claude' && c.ok).length, modelUsage: [...new Set(calls.flatMap((c) => c.modelUsage || []))], reportedCostEstimateUsd: calls.reduce((s, c) => s + (c.reportedCostEstimateUsd || 0), 0), timeouts: calls.filter((c) => c.host === 'claude' && c.timedOut).length },
      codex: { requestedModel: labels.producer.codex.requestedModel, calls: calls.filter((c) => c.host === 'codex').length, ok: calls.filter((c) => c.host === 'codex' && c.ok).length, timeouts: calls.filter((c) => c.host === 'codex' && c.timedOut).length, hostErrors: [...new Set(calls.flatMap((c) => c.hostErrors || []))] },
      envAudit: labels.envAudit, skipped: a.skipped, producerErrors: a.producerErrors,
    },
    validation: { total: a.total, pass: a.pass, byCheck: a.byCheck, informationalE: a.informationalE, secondary: a.secondary, codex: a.codex, cosineCalibration: a.cosineCalibration },
    wallClockMs: { produce: produceMs, validate: validateMs, total: Date.now() - started },
    callDurationsMs: calls.map((c) => ({ host: c.host, batch: c.batchIndex, ms: c.durationMs, ok: c.ok })),
  };
  writeJson(path.join(out, 'summary.json'), summary);
  log(`[spike] ${repo}: validation ${a.pass}/${a.total} pass; codex both-yes ${a.codex.bothYes}/${a.codex.withVerdicts}; ${Math.round(summary.wallClockMs.total / 1000)}s`);
  return summary;
}

export async function main(argv = process.argv.slice(2)) {
  const repo = arg(argv, '--repo');
  const dir = arg(argv, '--dir');
  const out = arg(argv, '--out');
  if (!repo || !dir || !out) { process.stderr.write('Usage: spike-run.mjs --repo <name> --dir <snapshot> --out <dir> [--commit <sha>] [--batch 20] [--max-claude-calls 8] [--max-codex-calls 8] [--effort medium] [--skip-produce]\n'); return 64; }
  const summary = await runSpike({
    repo, dir: path.resolve(dir), out: path.resolve(out), commit: arg(argv, '--commit'),
    batchSize: Number(arg(argv, '--batch') || DEFAULT_BATCH), maxClaudeCalls: Number(arg(argv, '--max-claude-calls') || 8),
    maxCodexCalls: Number(arg(argv, '--max-codex-calls') || 8), effort: arg(argv, '--effort') || 'medium',
    skipProduce: argv.includes('--skip-produce'), log: (line) => process.stderr.write(`${line}\n`),
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main();
