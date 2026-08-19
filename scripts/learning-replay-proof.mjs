import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  INVARIANT,
  LOAD_BEARING,
  MUTANT_RESULT_FILES,
  PORTFOLIO_RESULT_FILES,
  RESULT_FILE,
  ROOT,
  TRAP,
  VERDICT,
  aggregate,
} from './learning-replay-contract.mjs';

const KEEP_RUNS = 14;
const PROOF_SCHEMA = 2;
const PROOF_ROOT = path.join(ROOT, 'data', 'learning-replay-transcripts');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const HOST_HOME_PATHS = [...new Set([os.homedir(), process.env.HOME].filter(Boolean))]
  .sort((left, right) => right.length - left.length);
export function redactHostPaths(value) {
  return HOST_HOME_PATHS.reduce(
    (text, home) => text.split(home).join('$HOME'),
    String(value || ''),
  );
}
const remove = (target) => {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* already gone */ }
};

export function headSha(repo = ROOT) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function checkSourceIdentity({ repo = ROOT, loadBearing = LOAD_BEARING } = {}) {
  const sha = headSha(repo);
  if (!sha) return { clean: false, sha: null, why: 'source is not a readable Git commit' };
  const status = spawnSync('git', [
    'status', '--porcelain', '--untracked-files=all', '--', ...loadBearing,
  ], { cwd: repo, encoding: 'utf8' });
  if (status.status !== 0) {
    return { clean: false, sha, why: `source identity check failed: ${status.stderr || status.status}` };
  }
  const dirty = status.stdout.split('\n').map((value) => value.trim()).filter(Boolean);
  return dirty.length
    ? { clean: false, sha, why: `load-bearing source has uncommitted changes: ${dirty.join(', ')}`, dirty }
    : { clean: true, sha, why: `clean source commit ${sha}` };
}

function inside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function execRecord(execution) {
  if (!execution) return null;
  return {
    ran: execution.ran === true,
    argv: Array.isArray(execution.argv) ? execution.argv.map(redactHostPaths) : null,
    exit: Number.isInteger(execution.exit) ? execution.exit : null,
    exitOk: execution.exitOk === true,
    retrieved: execution.retrieved === true,
    why: redactHostPaths(execution.why).slice(0, 400),
    output: redactHostPaths(execution.output).slice(0, 400),
  };
}

function armRecord(arm, treated) {
  if (!arm || typeof arm !== 'object') return null;
  const record = {
    class: arm.class || 'none',
    subcommandCorrect: arm.subcommandCorrect === true,
    command: redactHostPaths(arm.command).slice(0, 800),
    exec: execRecord(arm.exec),
    model: arm.modelUsed || arm.model || null,
  };
  if (treated) {
    record.forcedCommand = arm.forcedCommand === true;
    record.lessonIndex = Number.isInteger(arm.lessonIndex) ? arm.lessonIndex : -1;
    record.firstToolIndex = Number.isInteger(arm.firstToolIndex) ? arm.firstToolIndex : -1;
    record.lessonBeforeFirstToolCall = arm.lessonBeforeFirstToolCall === true;
  } else {
    record.lessonDelivered = arm.lessonDelivered === true;
  }
  return record;
}

function writeProof({ sourceSha, trap, mutant = null, run, arm, record, proofRoot = PROOF_ROOT }) {
  const envelope = { schema: PROOF_SCHEMA, sourceSha, trap, mutant, run, arm, record };
  const bytes = `${JSON.stringify(envelope, null, 2)}\n`;
  const hash = sha256(bytes);
  const file = path.join(proofRoot, sourceSha, `${hash}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
  return { path: path.relative(ROOT, file), sha256: hash, sourceSha, mutant };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function verifyProof({ ref, artifactArm, sourceSha, trap, mutant, run, arm, repo }) {
  if (!ref || typeof ref !== 'object' || !ref.path || !ref.sha256 || !ref.sourceSha) {
    return { ok: false, why: `${arm} transcript reference is incomplete` };
  }
  const file = path.resolve(repo, ref.path);
  if (!inside(repo, file)) return { ok: false, why: `${arm} transcript escapes repository` };
  if (!fs.existsSync(file)) return { ok: false, why: `${arm} transcript does not exist` };
  const bytes = fs.readFileSync(file);
  if (sha256(bytes) !== ref.sha256) return { ok: false, why: `${arm} transcript hash mismatch` };
  let envelope;
  try { envelope = JSON.parse(bytes.toString('utf8')); }
  catch (error) { return { ok: false, why: `${arm} transcript is unparseable: ${error.message}` }; }
  if (ref.sourceSha !== sourceSha || envelope.sourceSha !== sourceSha) {
    return { ok: false, why: `${arm} transcript source identity mismatch` };
  }
  if ((ref.mutant ?? null) !== mutant || (envelope.mutant ?? null) !== mutant) {
    return { ok: false, why: `${arm} transcript mutant identity mismatch` };
  }
  if (envelope.schema !== PROOF_SCHEMA || envelope.trap !== trap
    || envelope.run !== run || envelope.arm !== arm || !envelope.record) {
    return { ok: false, why: `${arm} transcript envelope identity mismatch` };
  }
  const duplicate = { ...artifactArm };
  delete duplicate.transcript;
  if (!sameJson(duplicate, envelope.record)) {
    return { ok: false, why: `${arm} causal run data does not match hashed transcript` };
  }
  return { ok: true, record: envelope.record, file };
}

function oracleInput({ row, treated, control }) {
  return {
    i: row.i,
    treatedClass: treated.class,
    controlClass: control.class,
    lessonBeforeFirstToolCall: treated.lessonBeforeFirstToolCall,
    treatedSubcommandCorrect: treated.subcommandCorrect,
    treatedExecOk: treated.exec?.exitOk === true,
    treatedRetrieved: treated.exec?.retrieved === true,
    treatedExecWhy: treated.exec?.why || null,
    controlWorked: control.exec?.exitOk === true && control.exec?.retrieved === true,
    error: row.error || null,
    treated,
    control,
  };
}

function verifyRuns(artifact, repo) {
  if (!Array.isArray(artifact.runs)) return { ok: false, why: 'runs are missing' };
  const inputs = [];
  for (let index = 0; index < artifact.runs.length; index++) {
    const row = artifact.runs[index];
    if (!row?.treated || !row?.control) return { ok: false, why: `run ${index + 1} lacks a treated or control arm` };
    const run = Number.isInteger(row.i) ? row.i : index + 1;
    const treated = verifyProof({
      ref: row.treated.transcript,
      artifactArm: row.treated,
      sourceSha: artifact.sha,
      trap: artifact.trap,
      mutant: artifact.mutant || null,
      run,
      arm: 'treated',
      repo,
    });
    if (!treated.ok) return treated;
    const control = verifyProof({
      ref: row.control.transcript,
      artifactArm: row.control,
      sourceSha: artifact.sha,
      trap: artifact.trap,
      mutant: artifact.mutant || null,
      run,
      arm: 'control',
      repo,
    });
    if (!control.ok) return control;
    inputs.push(oracleInput({ row, treated: treated.record, control: control.record }));
  }
  return { ok: true, inputs };
}

function aggregateMismatch(artifact, recomputed) {
  const fields = [
    'verdict', 'n', 'passes', 'fails', 'unknowns', 'controlTokenRuns',
    'controlWorkedRuns', 'treatedTokenRuns', 'rate',
  ];
  for (const field of fields) {
    if (artifact[field] !== recomputed[field]) return `${field} does not match recomputed evidence`;
  }
  const gates = ['treatedSubcommandRuns', 'treatedExecutedRuns', 'treatedRetrievedRuns'];
  for (const field of gates) {
    if (artifact.executionGate?.[field] !== recomputed[field]) {
      return `executionGate.${field} does not match recomputed evidence`;
    }
  }
  for (let index = 0; index < recomputed.runs.length; index++) {
    const claimed = artifact.runs[index];
    const actual = recomputed.runs[index];
    if (claimed.verdict !== actual.verdict || claimed.why !== actual.why) {
      return `run ${actual.i} verdict/reason does not match recomputed evidence`;
    }
  }
  return null;
}

function currency(artifact, repo, maxAgeDays) {
  if (!artifact.sha) return { ok: false, why: 'artifact states no SHA' };
  const head = headSha(repo);
  if (head && artifact.sha !== head) {
    const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', artifact.sha, head], { cwd: repo });
    if (ancestor.status !== 0) return { ok: false, why: `artifact source ${artifact.sha} is not an ancestor of HEAD` };
    const diff = spawnSync('git', [
      'diff', '--name-only', `${artifact.sha}..${head}`, '--', ...LOAD_BEARING,
    ], { cwd: repo, encoding: 'utf8' });
    const changed = diff.status === 0
      ? diff.stdout.split('\n').map((value) => value.trim()).filter(Boolean)
      : [];
    if (changed.length) return { ok: false, why: `load-bearing files changed: ${changed.join(', ')}` };
  }
  const age = artifact.at ? (Date.now() - Date.parse(artifact.at)) / 86_400_000 : Infinity;
  if (!(age <= maxAgeDays)) return { ok: false, why: `artifact is older than ${maxAgeDays} days` };
  return { ok: true };
}

export function checkArtifact({ file = RESULT_FILE, repo = ROOT, maxAgeDays = 14 } = {}) {
  if (!fs.existsSync(file)) return { status: VERDICT.UNKNOWN, why: 'result artifact does not exist' };
  let artifact;
  try { artifact = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { return { status: VERDICT.UNKNOWN, why: `result artifact unparseable: ${error.message}` }; }
  if (artifact.invariant !== INVARIANT) return { status: VERDICT.UNKNOWN, why: 'artifact invariant mismatch' };
  const source = checkSourceIdentity({ repo });
  if (!source.clean) return { status: VERDICT.UNKNOWN, why: source.why, artifact };
  const current = currency(artifact, repo, maxAgeDays);
  if (!current.ok) return { status: VERDICT.UNKNOWN, why: current.why, artifact };
  const evidence = verifyRuns(artifact, repo);
  if (!evidence.ok) return { status: VERDICT.UNKNOWN, why: evidence.why, artifact };
  const recomputed = aggregate(evidence.inputs);
  if (recomputed.verdict === VERDICT.UNKNOWN) {
    return { status: VERDICT.UNKNOWN, why: recomputed.why, artifact, recomputed };
  }
  const mismatch = aggregateMismatch(artifact, recomputed);
  if (mismatch) return { status: VERDICT.FAIL, why: mismatch, artifact, recomputed };
  return {
    status: recomputed.verdict,
    why: `${recomputed.verdict} — ${recomputed.passes}/${recomputed.n} recomputed runs on ${artifact.sha.slice(0, 8)}`,
    artifact,
    recomputed,
  };
}

function causalMutantCheck(artifact, recomputed, mutant) {
  if (recomputed.unknowns !== 0) return 'mutant contains UNKNOWN runs';
  if (recomputed.verdict !== VERDICT.FAIL || recomputed.passes !== 0 || recomputed.n < 1) {
    return 'mutant did not fail with zero passes';
  }
  for (const run of recomputed.runs) {
    if (run.treated?.exec?.ran !== true || run.control?.exec?.ran !== true) {
      return 'mutant arms were not both executed';
    }
    if (run.treatedClass === 'none' || run.controlClass === 'none') return 'mutant arms are not comparable';
    if (!/treated arm produced|lesson was NOT|RETRIEVED NOTHING|did not execute|WRONG SUBCOMMAND/i.test(run.why)) {
      return `mutant failure reason is not causal: ${run.why}`;
    }
  }
  const learned = recomputed.runs.some((run) => run.treated?.lessonBeforeFirstToolCall === true
    || run.treated?.lessonDelivered === true || run.control?.lessonDelivered === true
    || run.treatedClass === 'flagged' || run.controlClass === 'flagged'
    || run.treated?.exec?.retrieved === true || run.control?.exec?.retrieved === true);
  if (learned) return `${mutant}: learned effect survived`;
  if (!['delete-lesson', 'brain-off-treated'].includes(mutant)) return 'unexpected mutant identity';
  return null;
}

export function checkMutantArtifacts({
  files = MUTANT_RESULT_FILES,
  repo = ROOT,
  maxAgeDays = 14,
} = {}) {
  const checked = [];
  for (const trap of [TRAP.MEMORY_SEARCH, TRAP.POST_TASK]) {
    for (const mutant of ['delete-lesson', 'brain-off-treated']) {
      const file = files[trap]?.[mutant];
      if (!file) return { status: VERDICT.UNKNOWN, why: `${trap}/${mutant}: artifact absent`, checked };
      const result = checkArtifact({ file, repo, maxAgeDays });
      if (result.status === VERDICT.UNKNOWN) return { ...result, why: `${trap}/${mutant}: ${result.why}`, checked };
      if (result.artifact?.mutant !== mutant || result.artifact?.trap !== trap) {
        return { status: VERDICT.FAIL, why: `${trap}/${mutant}: artifact identity mismatch`, checked };
      }
      const causal = causalMutantCheck(result.artifact, result.recomputed, mutant);
      if (causal) return { status: VERDICT.FAIL, why: `${trap}/${mutant}: ${causal}`, checked };
      checked.push(`${trap}/${mutant}`);
    }
  }
  return { status: VERDICT.PASS, why: 'all four mutants failed for the expected causal reason', checked };
}

export function checkPortfolio({
  files = PORTFOLIO_RESULT_FILES,
  mutantFiles = MUTANT_RESULT_FILES,
  repo = ROOT,
  maxAgeDays = 14,
} = {}) {
  const artifacts = [];
  for (const trap of [TRAP.MEMORY_SEARCH, TRAP.POST_TASK]) {
    const result = checkArtifact({ file: files[trap], repo, maxAgeDays });
    if (result.status !== VERDICT.PASS) return { ...result, why: `${trap}: ${result.why}`, artifacts };
    const metrics = result.recomputed;
    const artifact = result.artifact;
    if (artifact.trap !== trap || metrics.n < 3 || metrics.passes < 2
      || metrics.controlTokenRuns !== 0 || metrics.controlWorkedRuns !== 0) {
      return { status: VERDICT.FAIL, why: `${trap}: recomputed evidence lacks N>=3 causal separation`, artifacts };
    }
    if (artifact.promotion?.projectCount < 2 || artifact.promotion?.promoted !== true
      || new Set(artifact.promotion?.sourceProjects || []).size < 2) {
      return { status: VERDICT.FAIL, why: `${trap}: cross-project promotion is unproven`, artifacts };
    }
    if (artifact.refresh?.lessonSurvived !== true) {
      return { status: VERDICT.FAIL, why: `${trap}: lesson did not survive refresh`, artifacts };
    }
    artifacts.push({ artifact, recomputed: metrics });
  }
  if (artifacts[0].artifact.record?.lessonId === artifacts[1].artifact.record?.lessonId
    || artifacts[0].artifact.taskHash === artifacts[1].artifact.taskHash) {
    return { status: VERDICT.FAIL, why: 'portfolio traps are not independent', artifacts };
  }
  const mutants = checkMutantArtifacts({ files: mutantFiles, repo, maxAgeDays });
  if (mutants.status !== VERDICT.PASS) return { ...mutants, why: `portfolio mutants: ${mutants.why}`, artifacts };
  return { status: VERDICT.PASS, why: 'portfolio recomputed both traps and all causal mutants', artifacts, mutants };
}

export function cleanupFixtureDaemons(dirs) {
  const base = path.resolve(dirs.base);
  const processes = spawnSync('ps', ['-axo', 'pid=,command='], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (processes.status !== 0) return { found: 0, stopped: 0, errors: ['process census failed'] };
  const matches = String(processes.stdout || '').split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) return [];
    const pid = Number(match[1]);
    const command = match[2];
    return command.includes('daemon start --foreground') && command.includes('--workspace')
      && command.includes(base) && pid !== process.pid ? [{ pid }] : [];
  });
  const errors = [];
  let stopped = 0;
  for (const match of matches) {
    try { process.kill(match.pid, 'SIGTERM'); stopped++; }
    catch (error) { if (error?.code !== 'ESRCH') errors.push(`${match.pid}: ${error.message}`); }
  }
  return { found: matches.length, stopped, errors };
}

function manifestFor(directory) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'run-manifest.json'), 'utf8'));
    const time = Date.parse(manifest.createdAt);
    if (!Number.isFinite(time) || !Number.isFinite(Number(manifest.sequence))) return null;
    return { directory, time, sequence: Number(manifest.sequence) };
  } catch { return null; }
}

export function pruneArchive(dirs, { keepRuns = KEEP_RUNS, preservePaths = [] } = {}) {
  cleanupFixtureDaemons(dirs);
  for (const entry of fs.readdirSync(dirs.base, { withFileTypes: true })) {
    if (['transcripts', 'run-manifest.json'].includes(entry.name)) continue;
    remove(path.join(dirs.base, entry.name));
  }
  const root = path.dirname(dirs.base);
  const protectedFiles = preservePaths.map((value) => path.resolve(value));
  const runs = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => manifestFor(path.join(root, entry.name)))
    .filter(Boolean)
    .sort((left, right) => left.time - right.time || left.sequence - right.sequence);
  const candidates = runs.filter((run) => !protectedFiles.some((file) => inside(run.directory, file)));
  const excess = Math.max(0, candidates.length - keepRuns);
  for (const old of candidates.slice(0, excess)) remove(old.directory);
}

export function writeArtifact(file, aggregateResult, meta = {}) {
  const sourceSha = headSha();
  const trap = meta.trap || TRAP.MEMORY_SEARCH;
  const mutant = meta.mutant || null;
  const proofRoot = meta.proofRoot || PROOF_ROOT;
  const runs = (aggregateResult.runs || []).map((run) => {
    const treated = armRecord(run.treated, true);
    const control = armRecord(run.control, false);
    return {
      i: run.i,
      verdict: run.verdict,
      why: run.why,
      error: run.error || null,
      treated: {
        ...treated,
        transcript: writeProof({ sourceSha, trap, mutant, run: run.i, arm: 'treated', record: treated, proofRoot }),
      },
      control: {
        ...control,
        transcript: writeProof({ sourceSha, trap, mutant, run: run.i, arm: 'control', record: control, proofRoot }),
      },
    };
  });
  const artifact = {
    invariant: INVARIANT,
    verdict: aggregateResult.verdict,
    why: aggregateResult.why,
    sha: sourceSha,
    at: new Date().toISOString(),
    host: meta.host || null,
    model: meta.model || null,
    modelResolved: runs.map((run) => run.treated.model).find(Boolean) || null,
    mutant,
    trap,
    taskHash: meta.task ? sha256(meta.task) : null,
    n: aggregateResult.n,
    passes: aggregateResult.passes,
    fails: aggregateResult.fails,
    unknowns: aggregateResult.unknowns,
    controlTokenRuns: aggregateResult.controlTokenRuns,
    controlWorkedRuns: aggregateResult.controlWorkedRuns,
    treatedTokenRuns: aggregateResult.treatedTokenRuns,
    executionGate: {
      treatedSubcommandRuns: aggregateResult.treatedSubcommandRuns,
      treatedExecutedRuns: aggregateResult.treatedExecutedRuns,
      treatedRetrievedRuns: aggregateResult.treatedRetrievedRuns,
    },
    rate: aggregateResult.rate,
    threshold: '>=2/3',
    costUsd: meta.costUsd != null ? +meta.costUsd.toFixed(4) : null,
    wallSeconds: meta.wallMs != null ? +(meta.wallMs / 1000).toFixed(1) : null,
    premise: meta.flag ? { verified: meta.flag.ok, evidence: meta.flag.evidence } : null,
    record: meta.record ? {
      lessonId: meta.record.lesson?.id,
      key: meta.record.key,
      storeExit: meta.record.storeExit,
      readBackExit: meta.record.readBackExit,
      ok: meta.record.ok,
    } : null,
    promotion: meta.record ? {
      rule: 'ADR-G008 win twice',
      projectCount: meta.record.projectCount,
      sourceProjects: meta.record.sources?.map((source) => source.project) || [],
      promoted: meta.record.promoted === true,
    } : null,
    seed: meta.seed ? { key: meta.seed.key, storeExit: meta.seed.storeExit, ok: meta.seed.ok } : null,
    refresh: meta.refresh || null,
    runs,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // AN ENVIRONMENT THAT CANNOT MEASURE MUST NOT OVERWRITE ONE THAT DID.
  //
  // Measured 2026-08-19: `learning-replay` had been red on main since 2026-08-11. The artifact was
  // re-recorded that morning at 07:15Z carrying `verdict: UNKNOWN` and
  // "3/3 run(s) could not be measured; executor error: spawnSync codex ENOENT" — written by a
  // nightly container with no `codex` on PATH. `codex` resolves fine on the owner's machine
  // (0.148.0), so a real PASS was replaced by "I could not look", and every CI run afterwards
  // correctly refused a non-PASS verdict. The gate was right; its INPUT had been destroyed by a
  // host that was never able to produce one.
  //
  // This is the same distinction `restore-local-ingests.mjs` needed and the same one
  // `degradation-watch` needed: CANNOT-MEASURE is not MEASURED-AND-FAILED, and collapsing them
  // turns a missing tool into a false verdict. A real FAIL still overwrites — that is a
  // measurement and it must land. Only the unmeasurable case is refused.
  // "PARTIALLY MEASURED" IS NOT "COULD NOT MEASURE" — and the first version of this guard got that
  // wrong within the hour, which is the same conflation it exists to prevent, committed inside it.
  //
  // The predicate was a substring match on "could not be measured". A real run then reported
  // "1/3 run(s) could not be measured; 1/3 passed" — one FAIL, one UNKNOWN, one PASS, i.e. a genuine
  // mixed result carrying a live regression signal — and the guard swallowed it, leaving a PASS from
  // 2026-08-03 standing. It suppressed exactly the finding it should have let through.
  //
  // A host that cannot measure produces NO measurements: every run unknown. If even one run yielded
  // a pass or a fail, the executor plainly ran and the result is real, however unwelcome.
  const runsTotal = Number(artifact.n ?? 0);
  const runsUnknown = Number(artifact.unknowns ?? 0);
  const nothingMeasured = runsTotal > 0 && runsUnknown === runsTotal;
  const unmeasurable = artifact.verdict === 'UNKNOWN'
    && nothingMeasured
    && /ENOENT|executor error/i.test(String(artifact.why ?? ''));
  if (unmeasurable && fs.existsSync(file)) {
    try {
      const prior = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (prior?.verdict && prior.verdict !== 'UNKNOWN') {
        process.stderr.write(
          `[learning-replay] REFUSING to overwrite a ${prior.verdict} recorded ${prior.at} with an\n`
          + `  unmeasurable UNKNOWN — this host cannot run the executor (${artifact.why}).\n`
          + '  The prior measurement stands. Re-record on a host that has the executor.\n',
        );
        return prior;
      }
    } catch { /* unreadable prior is not a reason to keep a bad one — fall through and write */ }
  }

  fs.writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}
