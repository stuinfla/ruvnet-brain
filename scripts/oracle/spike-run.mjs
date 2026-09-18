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

export async function runSpike({ repo, dir, out, commit, batchSize = DEFAULT_BATCH, maxClaudeCalls = 8, maxCodexCalls = 8, effort = 'medium', skipProduce = false, dispositions = null, attestationPrivateKey = null, trustedProductionKey = null, log = () => {} }) {
  fs.mkdirSync(out, { recursive: true });
  const started = Date.now();
  const inventory = await buildInventory({ dir, repo, commit: resolveCommit(dir, commit), dispositions });
  writeJson(path.join(out, 'inventory.json'), inventory);
  log(`[spike] ${repo}@${inventory.commit.slice(0, 10)} U=${inventory.U} selected=${inventory.selectedCount}`);

  if (!inventory.inventoryComplete || inventory.U === 0) {
    throw new Error('source inventory is incomplete or requires emptiness review; label production is forbidden');
  }
  const labelsFile = path.join(out, 'labels.json');
  let labels;
  const produceStarted = Date.now();
  if (skipProduce && fs.existsSync(labelsFile)) {
    labels = JSON.parse(fs.readFileSync(labelsFile, 'utf8'));
    log('[spike] reusing existing labels.json');
  } else {
    labels = await produceQuestions({ inventory, snapshotDir: dir, batchSize, maxClaudeCalls, maxCodexCalls, effort, attestationPrivateKey, workDir: path.join(out, 'producer-work'), log });
    writeJson(labelsFile, labels);
  }
  const produceMs = Date.now() - produceStarted;

  const validateStarted = Date.now();
  const embed = await loadBgeEmbedder();
  const validation = await validateLabels({ labels, inventory, snapshotDir: dir, embed, trustedProductionKey });
  writeJson(path.join(out, 'validation.json'), validation);
  const validateMs = Date.now() - validateStarted;

  const a = validation.aggregate;
  const calls = labels.calls;
  const summary = {
    oracleComplete: validation.oracleComplete,
    repo, commit: inventory.commit, U: inventory.U, selected: inventory.selectedCount, N: 2 * inventory.selectedCount,
    strata: inventory.strata.length, coverage: { ...inventory.coverage, uncoveredFiles: undefined },
    producer: {
      claude: { requestedModel: labels.producer.claude.requestedModel, calls: calls.filter((c) => c.host === 'claude').length, ok: calls.filter((c) => c.host === 'claude' && c.ok).length, modelUsage: [...new Set(calls.flatMap((c) => c.modelUsage || []))], reportedCostEstimateUsd: calls.reduce((s, c) => s + (c.reportedCostEstimateUsd || 0), 0), timeouts: calls.filter((c) => c.host === 'claude' && c.timedOut).length },
      codex: { requestedModel: labels.producer.codex.requestedModel, calls: calls.filter((c) => c.host === 'codex').length, ok: calls.filter((c) => c.host === 'codex' && c.ok).length, timeouts: calls.filter((c) => c.host === 'codex' && c.timedOut).length, hostErrors: [...new Set(calls.flatMap((c) => c.hostErrors || []))] },
      envAudit: labels.envAudit, skipped: a.skipped, producerErrors: a.producerErrors,
    },
    validation: { total: a.total, pass: a.pass, byCheck: a.byCheck, informationalE: a.informationalE, secondary: a.secondary, codex: a.codex, judge: a.judge, cosineCalibration: a.cosineCalibration },
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
    dispositions: arg(argv,'--dispositions') ? JSON.parse(fs.readFileSync(arg(argv,'--dispositions'),'utf8')) : null,
    attestationPrivateKey: arg(argv,'--attestation-key') ? fs.readFileSync(arg(argv,'--attestation-key'),'utf8') : null,
    trustedProductionKey: arg(argv,'--production-public-key') ? fs.readFileSync(arg(argv,'--production-public-key'),'utf8') : null,
    skipProduce: argv.includes('--skip-produce'), log: (line) => process.stderr.write(`${line}\n`),
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary.oracleComplete ? 0 : 2;
}

// Entry-point guard. Compares REALPATHS on both sides: path.resolve() normalizes a path but does
// NOT follow symlinks, while import.meta.url IS symlink-resolved by Node. Through a symlink (npm bin
// shims, wrapper scripts, and every os.tmpdir() path on macOS) the two sides disagree, so main()
// never runs -- and because nothing throws, the process exits 0. A silent exit 0 is indistinguishable
// from "ran, found nothing", which is how prepareCorpusCandidate once reported SUCCESS with no
// archive on disk. Reproduced live 2026-07-27; pinned by tests/unit/entrypoint-symlink.test.mjs.
function isDirectInvocation() {
  try {
    if (!process.argv[1]) return false;
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) process.exitCode = await main();
