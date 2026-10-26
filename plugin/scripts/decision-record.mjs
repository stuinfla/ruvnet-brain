#!/usr/bin/env node
/**
 * decision-record.mjs — ADR-105 §8 as code: AgentDB is CONSULTED before a decision and the decision
 * is RECORDED after it, in the one canonical store, through the one door (ADR-105 §1–§3).
 *
 *   node decision-record.mjs --consult "<topic>"            consequential recall + persisted receipt
 *   node decision-record.mjs --record --what W --why Y --shape S --evidence kind:ref [...]
 *                            [--supersedes <key>]... [--status ratified|detected-unconfirmed]
 *
 * Two hooks consume the facts this file produces (ADR-106): decision-gate's `decision-recall` policy
 * reads the consult receipt before a new ADR or an ADR status change; continuation-gate reads the
 * transcript audit below at Stop. Neither hook writes memory.
 *
 * Store contract (ADR-105 §3, `ruflo memory store --help` read 2026-10-11): every write is
 * `--no-upsert --require-native --append-only --path <abs>` from a private scratch cwd with no
 * CLAUDE_FLOW_MEMORY_PATH; a row is committed only when an exact-key readback returns the same
 * bytes; any other refusal is LOUD — a hook-failures row plus the printed reason — and is never reported as
 * done. Nothing is kept on disk for a later replay (owner ruling 2026-10-12: no private outbox).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { redactText } from './continuity-events.mjs';
import { maskExcludedPaths } from './turn-capture-privacy.mjs';
import { resolveTurnDb, readSettledTranscript } from './turn-outcome-capture.mjs';
import { resolveProjectStore, storeEncryptedAtRest, ENCRYPTED_STORE_REASON } from './project-store-resolver.mjs';
import { resolveRuflo, rufloInvocation } from './ruflo-bin.mjs';
import { rufloRunDir } from './ruflo-bin.mjs';
import { currentTurnRecords } from './completion-claim-evidence.mjs';
import { recordHookFailure } from './hook-failures.mjs';
import { isDirectInvocation } from './entrypoint.mjs';

export const DECISION_SCHEMA = 'ruvnet-brain.decision-record';
export const STATUSES = Object.freeze(['ratified', 'detected-unconfirmed']);
export const EVIDENCE_KINDS = Object.freeze(['path', 'commit', 'receipt', 'adr', 'url']);
export const BOUNDS = Object.freeze({ what: 400, why: 800, shape: 1200, evidence: 8, evidenceRef: 200, supersedes: 8, value: 4096 });
export const CONSULT_MAX_AGE_MS = 2 * 3600_000;
const KEY_RE = /^decision-[a-z0-9-]{1,48}-\d{8}T\d{9}Z$/;
const SCRIPT = fileURLToPath(import.meta.url);

/** An ADR document path (README/index files are not decisions). */
export function isAdrPath(file) {
  const p = String(file || '').replace(/\\/g, '/');
  if (!/\.md$/i.test(p) || /(^|\/)(README|index)\.md$/i.test(p)) return false;
  return /(^|\/)adrs?\/[^/]+\.md$/i.test(p) || /(^|\/)ADR-[^/]+\.md$/i.test(p);
}

const bound = (s, n) => String(s ?? '').slice(0, n);
export const brainHomeOf = (env = process.env) => env.RUVNET_BRAIN_HOME || path.join(env.HOME || os.homedir(), '.cache', 'ruvnet-brain');

/** `decision-<kebab slug ≤48>-<YYYYMMDDTHHMMSSmmmZ>` (ADR-105 §8). */
export function decisionKey(what, at) {
  const slug = String(what || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '') || 'decision';
  const stamp = new Date(at).toISOString().replace(/[-:.]/g, '');
  return `decision-${slug}-${stamp}`;
}

/** Structural validation of a stored record. Returns a list of problems (empty = valid). */
export function validateDecisionRecord(r) {
  const errors = [];
  if (!r || typeof r !== 'object' || Array.isArray(r)) return ['record must be an object'];
  if (r.schema !== DECISION_SCHEMA || r.schemaVersion !== 1) errors.push('schema/schemaVersion');
  for (const f of ['project', 'projectIdentity', 'at', 'host']) if (typeof r[f] !== 'string' || !r[f]) errors.push(`${f} required`);
  if (r.session !== null && typeof r.session !== 'string') errors.push('session must be a string or null');
  if (!['claude', 'codex', 'cli'].includes(r.host)) errors.push('host must be claude, codex or cli');
  if (!STATUSES.includes(r.status)) errors.push(`status must be one of ${STATUSES.join(', ')}`);
  if (typeof r.what !== 'string' || !r.what.trim()) errors.push('what required');
  for (const f of ['what', 'why', 'shape']) if (r[f] !== undefined && (typeof r[f] !== 'string' || r[f].length > BOUNDS[f])) errors.push(`${f} exceeds ${BOUNDS[f]} chars`);
  const evidence = Array.isArray(r.evidence) ? r.evidence : [];
  if (r.evidence !== undefined && !Array.isArray(r.evidence)) errors.push('evidence must be an array');
  if (evidence.length > BOUNDS.evidence) errors.push(`evidence exceeds ${BOUNDS.evidence} items`);
  for (const e of evidence) {
    if (!e || !EVIDENCE_KINDS.includes(e.kind) || typeof e.ref !== 'string' || !e.ref || e.ref.length > BOUNDS.evidenceRef) errors.push('evidence item must be {kind: path|commit|receipt|adr|url, ref ≤200}');
  }
  if (r.status === 'ratified') {
    if (typeof r.why !== 'string' || !r.why.trim()) errors.push('why required for a ratified decision');
    if (typeof r.shape !== 'string' || !r.shape.trim()) errors.push('shape required for a ratified decision');
    if (!evidence.length) errors.push('at least one evidence item required for a ratified decision');
  }
  const sup = r.supersedes ?? [];
  if (!Array.isArray(sup) || sup.length > BOUNDS.supersedes || sup.some((k) => !KEY_RE.test(k))) errors.push('supersedes must be ≤8 exact decision keys');
  // A detected record is evidence, never authority: it may not retire a decision (append-only, no undo).
  if (Array.isArray(sup) && sup.length && r.status !== 'ratified') errors.push('only a ratified decision may supersede');
  return errors;
}

/** Redact (shared scanner), mask excluded paths, then bound — in that order (ADR-105 §8). */
export function buildDecisionRecord(input, { projectRoot, projectIdentity, host = 'cli', session = null, now = Date.now(), exclusions = [] }) {
  const clean = (s, n) => bound(maskExcludedPaths(redactText(String(s ?? '').trim()), exclusions, projectRoot), n);
  const record = {
    schema: DECISION_SCHEMA, schemaVersion: 1, project: projectRoot, projectIdentity,
    at: new Date(now).toISOString(), host, session,
    status: input.status || 'ratified',
    what: clean(input.what, BOUNDS.what),
    ...(input.why ? { why: clean(input.why, BOUNDS.why) } : {}),
    ...(input.shape ? { shape: clean(input.shape, BOUNDS.shape) } : {}),
    evidence: (input.evidence || []).slice(0, BOUNDS.evidence).map((e) => ({ kind: e.kind, ref: clean(e.ref, BOUNDS.evidenceRef) })),
    supersedes: [...new Set(input.supersedes || [])],
  };
  const errors = validateDecisionRecord(record);
  const value = JSON.stringify(record);
  if (Buffer.byteLength(value) > BOUNDS.value) errors.push(`record exceeds ${BOUNDS.value} bytes`);
  return { record, key: decisionKey(record.what, now), value, errors };
}

/**
 * Supersession is a link on the NEWER record (an append-only store cannot edit the old row).
 * Only a valid ratified record supersedes; a detected one is evidence, never authority.
 */
export function supersededKeys(records) {
  const out = new Set();
  for (const r of records) {
    if (!r || r.schema !== DECISION_SCHEMA || r.status !== 'ratified' || validateDecisionRecord(r).length) continue;
    for (const k of r.supersedes || []) out.add(k);
  }
  return out;
}

/**
 * Supersession tombstones (review finding 1). A newer record's `supersedes` is only visible to recall
 * when that newer record is itself read, so a superseder that ranking or the deadline left out let the
 * old decision be served as live. Each superseded key therefore also gets an append-only tombstone row
 * `supersession-<old key>` in the same namespace; recall sees it in the key enumeration it already does,
 * with no extra read. The prefix never matches recall's `^decision[-_]` decision-key test.
 */
export const SUPERSESSION_SCHEMA = 'ruvnet-brain.decision-supersession';
export const TOMBSTONE_PREFIX = 'supersession-';
export const tombstoneKey = (oldKey) => `${TOMBSTONE_PREFIX}${oldKey}`;
export function tombstonedKeys(keys) {
  return new Set((keys || []).filter((k) => typeof k === 'string' && k.startsWith(`${TOMBSTONE_PREFIX}decision-`))
    .map((k) => k.slice(TOMBSTONE_PREFIX.length)));
}

function runRuflo(ruflo, db, args, { spawn = spawnSync } = {}) {
  const cwd = rufloRunDir(db);
  try {
    const { executable, args: argv } = rufloInvocation(ruflo, args);
    const r = spawn(executable, argv, { cwd, encoding: 'utf8', timeout: 60_000, windowsHide: true,
      env: { ...process.env, RUFLO_DAEMON_AUTOSTART: '0', CLAUDE_FLOW_AUTO_UPDATE: 'false', CLAUDE_FLOW_MEMORY_PATH: undefined } });
    return { status: Number.isInteger(r.status) ? r.status : 1, stdout: String(r.stdout || ''), output: `${r.stderr || ''}\n${r.stdout || ''}${r.error ? `\n${r.error.message}` : ''}` };
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

export function defaultStore({ ruflo, db, namespace, key, value }) {
  return runRuflo(ruflo, db, ['memory', 'store', '--key', key, '--value', value, '--namespace', namespace,
    '--no-upsert', '--require-native', '--append-only', '--provenance', 'agent_output', '--path', db]);
}
export function defaultReadBack({ ruflo, db, namespace, key }) {
  const r = runRuflo(ruflo, db, ['memory', 'retrieve', '--key', key, '--namespace', namespace, '--value-only', '--path', db]);
  return { content: r.status === 0 ? r.stdout.trim() : null };
}

/**
 * The §3 door. committed | already-stored | quarantined | refused — never "committed" without an
 * exact readback of the same bytes, and a refusal is never treated as a duplicate.
 */
export function storeDecision({ ruflo, db, namespace, key, value, store = defaultStore, readBack = defaultReadBack }) {
  const prior = readBack({ ruflo, db, namespace, key });
  if (typeof prior.content === 'string' && prior.content === value) return { state: 'already-stored', key };
  if (typeof prior.content === 'string' && prior.content && prior.content !== value) return { state: 'quarantined', key, reason: 'a different stored row holds this key' };
  if (storeEncryptedAtRest(db)) { // #439: the native-only store below is refused on every attempt; say why instead
    recordHookFailure({ hook: 'decision-record', event: 'record', error: `not recorded: ${ENCRYPTED_STORE_REASON}`.slice(0, 160) });
    return { state: 'refused', key, reason: ENCRYPTED_STORE_REASON };
  }
  const result = store({ ruflo, db, namespace, key, value });
  const back = readBack({ ruflo, db, namespace, key });
  if (result.status === 0 && back.content === value) return { state: 'committed', key };
  if (typeof back.content === 'string' && back.content && back.content !== value) return { state: 'quarantined', key, reason: 'a different stored row holds this key' };
  const reason = redactText(String(result.output || '').trim().split('\n').filter(Boolean).slice(-1)[0] || `store exited ${result.status}`).slice(0, 300);
  recordHookFailure({ hook: 'decision-record', event: 'record', error: `not recorded: ${reason}`.slice(0, 160) });
  return { state: 'refused', key, reason };
}

// ── consult receipt (read before deciding) ─────────────────────────────────────────────────────
export const consultFile = (projectRoot, brainHome) => path.join(brainHome, 'decision-consult',
  `${crypto.createHash('sha256').update(String(projectRoot)).digest('hex').slice(0, 24)}.json`);

export function writeConsultReceipt({ projectRoot, brainHome, outcome, topic, records = [], categories = null, now = Date.now() }) {
  const file = consultFile(projectRoot, brainHome);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, kind: 'decision-consult', projectRoot, at: new Date(now).toISOString(), outcome,
    topicDigest: crypto.createHash('sha256').update(String(topic)).digest('hex'), records, categories }), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

/** The receipt for this project if it is younger than maxAgeMs, else null. Any outcome counts: it proves the consult ran. */
export function freshConsultReceipt({ projectRoot, brainHome, now = Date.now(), maxAgeMs = CONSULT_MAX_AGE_MS }) {
  try {
    const r = JSON.parse(fs.readFileSync(consultFile(projectRoot, brainHome), 'utf8'));
    const age = now - Date.parse(r.at);
    return r.kind === 'decision-consult' && r.projectRoot === projectRoot && age >= 0 && age <= maxAgeMs ? r : null;
  } catch { return null; }
}

// ── transcript audit (write after deciding) ────────────────────────────────────────────────────
const RECORD_COMMAND = /decision-record\.mjs["']?\s[^\n|;&]*--record\b/;

/**
 * From the CURRENT turn's transcript records: ADR files this turn CREATED (Write result type
 * `create`, measured on real Claude transcripts) and whether a successful `--record` ran after the
 * last of them. Pure over parsed records.
 */
export function auditDecisionTurn(records) {
  const results = new Map();
  for (const o of records) {
    const c = o?.message?.content;
    if (!Array.isArray(c)) continue;
    for (const r of c) if (r?.type === 'tool_result' && r.tool_use_id) results.set(r.tool_use_id, { error: r.is_error === true, use: o.toolUseResult });
  }
  const created = [];
  let lastCreate = -1;
  let recordedAt = -1;
  let i = 0;
  for (const o of records) {
    const c = o?.message?.content;
    if (o?.type !== 'assistant' || !Array.isArray(c)) continue;
    for (const u of c) {
      if (u?.type !== 'tool_use') continue;
      i += 1;
      const result = results.get(u.id);
      if (!result || result.error) continue;
      if (u.name === 'Write' && isAdrPath(u.input?.file_path) && result.use?.type === 'create') { created.push(u.input.file_path); lastCreate = i; }
      if (u.name === 'Bash' && RECORD_COMMAND.test(String(u.input?.command || ''))) recordedAt = i;
    }
  }
  return { created, recorded: created.length > 0 && recordedAt > lastCreate };
}

/** Stop-side debt: an ADR created this turn in an ADOPTED project with no later decision record. */
export function decisionRecordDebt({ transcriptPath, cwd, read = readSettledTranscript, env = process.env }) {
  if (String(env.RUVNET_DECISION_RECORD_CHECK || '').toLowerCase() === 'off' || String(env.RUVNET_AGENTDB_FIRST || '').toLowerCase() === 'off') return null;
  if (typeof transcriptPath !== 'string' || !/\.jsonl$/i.test(transcriptPath) || !cwd) return null;
  let audit;
  try { audit = auditDecisionTurn(currentTurnRecords(read(transcriptPath, { maxMs: 0 })).recs); } catch { return null; }
  if (!audit.created.length || audit.recorded) return null;
  try { if (!fs.statSync(resolveProjectStore({ projectDir: cwd, gitTimeoutMs: 500 }).canonicalAgentDbPath).isFile()) return null; } catch { return null; }
  return { created: audit.created, command: `node ${JSON.stringify(SCRIPT)} --record --what "…" --why "…" --shape "…" --evidence adr:${audit.created.at(-1)}` };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = { evidence: [], supersedes: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (['--consult', '--record'].includes(a)) { o.mode = a.slice(2); if (a === '--consult') o.topic = next(); }
    else if (a === '--what') o.what = next();
    else if (a === '--why') o.why = next();
    else if (a === '--shape') o.shape = next();
    else if (a === '--status') o.status = next();
    else if (a === '--project') o.project = next();
    else if (a === '--supersedes') o.supersedes.push(next());
    else if (a === '--evidence') {
      const v = next(); const at = v.indexOf(':');
      if (at < 1) throw new Error('--evidence must be kind:ref');
      o.evidence.push({ kind: v.slice(0, at), ref: v.slice(at + 1) });
    } else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

export async function main(argv = process.argv.slice(2), { env = process.env, out = process.stdout, err = process.stderr, recallFn, store, readBack } = {}) {
  let o;
  try { o = parseArgs(argv); } catch (e) { err.write(`decision-record: ${e.message}\n`); return 2; }
  if (!o.mode) { err.write('decision-record: one of --consult "<topic>", --record is required\n'); return 2; }
  const projectDir = path.resolve(o.project || process.cwd());
  const brainHome = brainHomeOf(env);
  let target;
  try { target = resolveTurnDb({ projectDir, brainHome, gitTimeoutMs: 1000 }); } catch (e) { err.write(`decision-record: project store unresolved: ${redactText(e.message)}\n`); return 3; }
  if (o.mode === 'consult') {
    const recall = recallFn || (await import('./agentdb-recall.mjs')).recall;
    const r = await recall({ prompt: o.topic, projectDir, env, consequential: true });
    const projectRoot = target.projectRoot;
    if (projectRoot) writeConsultReceipt({ projectRoot, brainHome, outcome: r.outcome || 'unavailable', topic: o.topic,
      records: (r.receipt?.records || []).map((x) => x.key), categories: r.receipt?.categories || r.categories || null });
    if (r.block) out.write(`${r.block}\n`);
    const ok = /^ok-/.test(r.outcome || '');
    out.write(`decision consult: ${r.outcome || 'unavailable'}${ok ? '' : ' — history is UNKNOWN for this decision; say so in the decision'}${r.reason ? ` (${r.reason})` : ''}\n`);
    return ok ? 0 : 3;
  }
  if (target.skipped) { err.write(`decision-record: not recorded — ${target.skipped}\n`); return 3; }
  const ruflo = resolveRuflo({ env });
  if (!ruflo) { err.write('decision-record: not recorded — global ruflo not found\n'); return 3; }
  try { if (!fs.statSync(target.db).isFile()) throw new Error(); } catch { err.write('decision-record: not recorded — project has no canonical store (.swarm/memory.db)\n'); return 3; }
  const identity = resolveProjectStore({ projectDir, gitTimeoutMs: 1000 }).projectIdentity.id;
  const built = buildDecisionRecord(o, { projectRoot: target.projectRoot, projectIdentity: identity,
    host: env.RUVNET_HOOK_HOST === 'codex' ? 'codex' : env.CLAUDE_PLUGIN_ROOT || env.CLAUDECODE ? 'claude' : 'cli',
    exclusions: target.contentPathExcludes || [] });
  if (built.errors.length) { err.write(`decision-record: invalid — ${built.errors.join('; ')}\n`); return 2; }
  const namespace = path.basename(target.projectRoot);
  // Review finding 2: the store is append-only, so a wrong --supersedes key would hide a real decision
  // with no undo. Every key must read back as a decision record of THIS project before anything is written.
  for (const key of built.record.supersedes) {
    const back = (readBack || defaultReadBack)({ ruflo, db: target.db, namespace, key });
    let row = null; try { row = back.content ? JSON.parse(back.content) : null; } catch { /* not a record */ }
    if (row?.schema !== DECISION_SCHEMA || row.project !== target.projectRoot) {
      err.write(`decision-record: invalid — --supersedes ${key} is not an existing decision record of this project; nothing was written\n`);
      return 2;
    }
    out.write(`decision-record: supersedes ${key} — ${String(row.what).slice(0, 120)}\n`);
  }
  const r = storeDecision({ ruflo, db: target.db, namespace, key: built.key, value: built.value, ...(store ? { store } : {}), ...(readBack ? { readBack } : {}) });
  out.write(`decision-record: ${r.state} ${r.key} (namespace ${namespace})${r.reason ? ` — ${r.reason}` : ''}${r.state === 'refused' && r.reason === ENCRYPTED_STORE_REASON ? ' — NOT recorded (logged to hook-failures). Keep this project\'s store unencrypted to record decisions here' : ''}${r.state === 'refused' && r.reason !== ENCRYPTED_STORE_REASON ? ` — NOT recorded (logged to hook-failures). A store that committed but did not read back may still hold it: run \`ruflo memory retrieve -k ${r.key} -n ${namespace} --path ${target.db}\` before re-running --record` : ''}\n`);
  if (!['committed', 'already-stored'].includes(r.state)) return 3;
  let ok = true;
  for (const oldKey of built.record.supersedes) {
    const value = JSON.stringify({ schema: SUPERSESSION_SCHEMA, schemaVersion: 1, project: target.projectRoot, superseded: oldKey, by: built.key, at: built.record.at });
    let t = storeDecision({ ruflo, db: target.db, namespace, key: tombstoneKey(oldKey), value, ...(store ? { store } : {}), ...(readBack ? { readBack } : {}) });
    if (t.state === 'quarantined') {
      // A tombstone from an EARLIER superseder of the same decision already retires it: not a conflict.
      let prior = null;
      try { prior = JSON.parse((readBack || defaultReadBack)({ ruflo, db: target.db, namespace, key: t.key }).content || 'null'); } catch { /* conflict stands */ }
      if (prior?.schema === SUPERSESSION_SCHEMA && prior.superseded === oldKey && prior.project === target.projectRoot) t = { state: 'already-stored', key: t.key };
    }
    out.write(`decision-record: tombstone ${t.state} ${t.key}${t.reason ? ` — ${t.reason}` : ''}\n`);
    ok &&= ['committed', 'already-stored'].includes(t.state);
  }
  return ok ? 0 : 3;
}

function isMain() {
  try { return isDirectInvocation(import.meta.url); } catch { return false; }
}
if (isMain()) main().then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`decision-record: ${e.message}\n`); process.exitCode = 1; });
