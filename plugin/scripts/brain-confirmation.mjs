// brain-confirmation.mjs — POSITIVE CONFIRMATION (ADR-0098). One block that proves, from disk and from
// the registry, that this machine has the latest software, the latest knowledge, exactly one copy of it,
// that the search worker opened that copy, and that nothing else is building up. Printed after every
// install/update, by `--doctor` (and as JSON by `--doctor --json`), and as ONE SessionStart line only when
// something is wrong. Every failing line names the one command that fixes it.
//
// Readers reused, never restated: the footprint classifier (brain-footprint.mjs), per-process MCP
// readiness (mcp-readiness.mjs), the token ledger the search server already appends to on every answer
// (kb/forge-mcp-all.mjs meterLog), SOURCE.json / COVERAGE.json of the live KB, the Stable Spine's
// active.json, the Claude plugin registry, and host-update.mjs --check's recorded npm version.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { cmpVersion, footprintRoots, physical } from './brain-footprint.mjs';
import { readAll as readReadiness } from './mcp-readiness.mjs';
import { volumeOf } from './brain-location.mjs';

export const KNOWLEDGE_MAX_AGE_HOURS = 48;
export const SIGNATURE_RECORD = 'knowledge-signature.json';
export const FOOTPRINT_LINE_PREFIX = '[RuvNet Brain — FOOTPRINT ';
const CLEAN = 'npx ruvnet-brain --clean';
const UPDATE = 'npx ruvnet-brain@latest --update';

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const sha256File = (file) => { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; } };
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : 'unknown');
const ago = (ms, now) => { const h = (now - ms) / 3_600_000; return h < 48 ? `${Math.max(0, Math.round(h))}h ago` : `${Math.round(h / 24)}d ago`; };
export const formatBytes = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${Math.round(n / 1024 ** 2)} MB`);

/**
 * Record that the bytes now live were signature-verified, bound to the live COVERAGE.json so a later
 * replacement of the tree by anything unverified reads as unverified. Written by bin/install.mjs only.
 */
export function writeSignatureRecord({ brainHome, kbDir, bundleSha256, releaseTag = null, source, now = Date.now() }) {
  const coverageSha256 = sha256File(path.join(kbDir, 'COVERAGE.json'));
  const record = { schemaVersion: 1, kind: 'ruvnet-brain-knowledge-signature', verifiedAt: new Date(now).toISOString(),
    bundleSha256, releaseTag, coverageSha256, source };
  fs.mkdirSync(brainHome, { recursive: true });
  const file = path.join(brainHome, SIGNATURE_RECORD);
  fs.writeFileSync(`${file}.tmp-${process.pid}`, `${JSON.stringify(record, null, 2)}\n`);
  fs.renameSync(`${file}.tmp-${process.pid}`, file);
  return record;
}

/** The newest successful search answer the server metered (kb/forge-mcp-all.mjs meterLog), from the tail only. */
export function lastAnswerMs(ledgerFile, tailBytes = 256 * 1024) {
  let text = '';
  try {
    const size = fs.statSync(ledgerFile).size;
    const fd = fs.openSync(ledgerFile, 'r');
    const buf = Buffer.alloc(Math.min(size, tailBytes));
    try { fs.readSync(fd, buf, 0, buf.length, size - buf.length); } finally { fs.closeSync(fd); }
    text = buf.toString('utf8');
  } catch { return null; }
  for (const line of text.split('\n').reverse()) {
    try {
      const e = JSON.parse(line);
      if (e?.source === 'mcp' && e.tool === 'search_ruvnet' && !e.disabled && Date.parse(e.ts)) return Date.parse(e.ts);
    } catch { /* a partial first line */ }
  }
  return null;
}

/** Latest published version: the caller's live registry read, else host-update.mjs --check's recorded one. */
function npmLatestFrom({ npmLatest, brainHome }) {
  if (npmLatest?.version) return npmLatest;
  const file = path.join(brainHome, '.last-version-check.log');
  try {
    const version = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).find((l) => /^\d+\.\d+\.\d+/.test(l));
    if (version) return { version, checkedAt: fs.statSync(file).mtimeMs, source: 'last background check' };
  } catch { /* never checked */ }
  return null;
}

// state: 'ok' ✓ | 'fail' ✗ (structural: gates the verdict) | 'warn' ! (currency: shown with its fix, never gates)
// | 'unknown' ○. Currency is advisory on purpose: a correctly installed OLDER build (a recovery re-run of an
// earlier release, a quiet week with no new corpus) must still pass install verification (`--doctor --hooks`).
const line = (id, label, state, detail, fix = null) => ({ id, label, state, detail, fix: state === 'fail' || state === 'warn' ? fix : null });

/**
 * @param footprint inventoryFootprint()/sweepFootprint().after output (required)
 * @param npmLatest {version, checkedAt, source} from a live registry read, or null (falls back to the record)
 * @param installedVersion the package version the caller runs, used when no spine is active
 */
export function confirm({ footprint, env = process.env, home = os.homedir(), now = Date.now(), npmLatest = null,
  installedVersion = null, readiness = null } = {}) {
  const roots = footprint?.roots || footprintRoots({ env, home });
  const lines = [];
  const active = readJson(path.join(roots.brainHome, 'active.json'));
  const runtimeIdentity = readJson(path.join(roots.kbDir, 'RUNTIME-IDENTITY.json'));
  const installed = active?.version || runtimeIdentity?.brainVersion || installedVersion || null;

  // Software
  const latest = npmLatestFrom({ npmLatest, brainHome: roots.brainHome });
  if (!installed) lines.push(line('software', 'Software', 'fail', 'no installed Brain runtime found', 'npx ruvnet-brain@latest'));
  else if (!latest) lines.push(line('software', 'Software', 'unknown', `${installed} installed; npm latest could not be checked (offline?)`));
  else {
    const behind = cmpVersion(installed, latest.version) < 0;
    lines.push(line('software', 'Software', behind ? 'warn' : 'ok',
      `${installed} installed ${behind ? '<' : '='} npm latest ${latest.version} (checked ${iso(latest.checkedAt)}, ${latest.source || 'npm registry'})`, UPDATE));
  }

  // Hosts
  const runtime = active?.version || installed;
  const hosts = footprint.items.filter((i) => i.id === 'plugin' && i.class === 'must-exist');
  if (!hosts.length) lines.push(line('hosts', 'Hosts', 'unknown', 'no Claude Code or Codex plugin registered on this machine'));
  else {
    const off = hosts.filter((h) => h.version !== runtime);
    const label = (h) => `${h.host === 'claude' ? 'Claude Code' : 'Codex'} ${h.version}`;
    lines.push(line('hosts', 'Hosts', !runtime ? 'fail' : off.length ? 'warn' : 'ok',
      `${hosts.map(label).join(' · ')} ${off.length ? '≠' : '='} runtime ${runtime || 'unknown'}`, UPDATE));
  }

  // Knowledge — an unmounted moved brain is reported, never "fixed" by a reinstall beside the dead link.
  if (roots.dangling) {
    lines.push(line('knowledge', 'Knowledge', 'fail', roots.location.message,
      `mount ${roots.location.volume}, then: npx ruvnet-brain --doctor`));
    return { schemaVersion: 1, kind: 'ruvnet-brain-confirmation', ok: false, checkedAt: new Date(now).toISOString(), lines,
      location: roots.location, footprint: { kbCopies: 0, totalBytes: 0, budgetBytes: 0, breakdown: {}, cruft: [], unowned: [] } };
  }
  const source = readJson(path.join(roots.kbDir, 'SOURCE.json'));
  const builtMs = Date.parse(source?.builtUtc || '');
  const signature = readJson(path.join(roots.brainHome, SIGNATURE_RECORD));
  const coverage = sha256File(path.join(roots.kbDir, 'COVERAGE.json'));
  const signed = Boolean(signature?.coverageSha256 && coverage && signature.coverageSha256 === coverage);
  const tag = source?.corpusReleaseTag || source?.releaseTag || null;
  // Structural problems (a second copy, unverified bytes) gate; age is currency and only advises.
  const knowledgeProblems = [];
  const knowledgeAdvice = [];
  if (footprint.kbCopies !== 1) knowledgeProblems.push([`${footprint.kbCopies} copies on disk (must be exactly 1)`, footprint.kbCopyFix || (footprint.kbCopies ? CLEAN : 'npx ruvnet-brain@latest')]);
  if (!signed) knowledgeProblems.push([signature ? 'signature record does not match the live COVERAGE.json' : 'no signature verification recorded for these bytes', UPDATE]);
  if (!Number.isFinite(builtMs) || (now - builtMs) / 3_600_000 >= KNOWLEDGE_MAX_AGE_HOURS) knowledgeAdvice.push([`built ${Number.isFinite(builtMs) ? ago(builtMs, now) : 'at an unknown time'} (limit ${KNOWLEDGE_MAX_AGE_HOURS}h)`, UPDATE]);
  const where = roots.location?.state === 'linked'
    ? `at ${roots.kbDir} (moved to ${volumeOf(roots.location.real)}, mounted)` : `at ${roots.kbDir}`;
  const moved = footprint.moveLeftovers || { copies: 0, bytes: 0 };
  const knowledgeDetail = [`${footprint.kbCopies} copy ${where}${moved.copies ? ` (not counted: ${moved.copies} interrupted-move cop${moved.copies === 1 ? 'y' : 'ies'} (${formatBytes(moved.bytes)}) — see the Move lines)` : ''}`, `built ${iso(builtMs)}${Number.isFinite(builtMs) ? ` (${ago(builtMs, now)})` : ''}`,
    signed ? `signature verified ${iso(Date.parse(signature.verifiedAt))}` : 'signature NOT verified', `corpus ${tag ? (tag.length > 28 ? `${tag.slice(0, 26)}…` : tag) : 'unknown'}`].join(' · ');
  const knowledgeIssues = [...knowledgeProblems, ...knowledgeAdvice];
  lines.push(line('knowledge', 'Knowledge', knowledgeProblems.length ? 'fail' : knowledgeAdvice.length ? 'warn' : 'ok',
    knowledgeIssues.length ? `${knowledgeDetail} — ${knowledgeIssues.map(([p]) => p).join('; ')}` : knowledgeDetail, knowledgeIssues[0]?.[1]));

  // Interrupted --move-brain leftovers: one line each, reported, never removed. The set-aside original is ✗ when
  // it is the only copy (the next step is to put it back); otherwise ! with the delete that finishes the move.
  for (const i of footprint.items.filter((x) => x.kind === 'move-leftover')) {
    lines.push(line('move-leftover', 'Move', i.onlyCopy ? 'fail' : 'warn', `${i.reason}${i.onlyCopy ? ' — the ONLY copy of the Brain' : ''}: ${i.path}`, i.fix));
  }

  // In use
  const records = (readiness || readReadiness(roots.brainHome)).filter((r) => r.state === 'ready');
  const ledger = path.join(env.XDG_CACHE_HOME ? path.join(env.XDG_CACHE_HOME, 'ruvnet-brain') : roots.brainHome, 'token-ledger.jsonl');
  const answered = lastAnswerMs(ledger);
  const answerText = answered ? `last answer ${ago(answered, now)}` : 'no answer recorded yet';
  const opened = records.filter((r) => r.kbDir);
  const elsewhere = opened.filter((r) => physical(r.kbDir) !== roots.kbDir);
  if (elsewhere.length) lines.push(line('in-use', 'In use', 'fail', `search worker pid ${elsewhere[0].pid} opened ${elsewhere[0].kbDir}, not ${roots.kbDir}; ${answerText}`, 'restart Claude Code / Codex (the worker re-opens the live KB)'));
  else if (opened.length) lines.push(line('in-use', 'In use', 'ok', `search worker pid ${opened.map((r) => r.pid).join(', ')} opened this copy; ${answerText}`));
  else lines.push(line('in-use', 'In use', 'unknown', `${records.length ? 'a search worker is ready but does not report its KB path' : 'no search worker is running right now'}; ${answerText}`));

  // Footprint
  const parts = Object.entries(footprint.breakdown).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${formatBytes(v)}`);
  const foreign = footprint.unowned.reduce((n, i) => n + (i.bytes || 0), 0);
  lines.push(line('footprint', 'Footprint', footprint.withinBudget ? 'ok' : 'fail',
    `${formatBytes(footprint.totalBytes)} of ${formatBytes(footprint.budgetBytes)} budget (${parts.join(' · ')})${foreign ? `; not counted: ${formatBytes(foreign)} owned by other tools` : ''}`, CLEAN));

  // No cruft
  const cruft = footprint.cruft;
  const count = (pred) => cruft.filter(pred).length;
  const tally = [`${count((i) => /kb-copy|quarantine/.test(i.kind))} extra KB copies`,
    `${count((i) => /install-stage|forge-candidate/.test(i.kind))} abandoned builds`,
    `${count((i) => i.kind === 'npx-copy')} old installers`, `${count((i) => /plugin-generation|spine/.test(i.kind))} stale plugin generations`,
    `${count((i) => /log/.test(i.kind))} over-cap logs`,
    `${count((i) => !/kb-copy|quarantine|install-stage|forge-candidate|npx-copy|plugin-generation|spine|log/.test(i.kind))} scratch/backup leftovers`];
  const removable = cruft.filter((i) => ['remove', 'remove-if-proven', 'rotate', 'truncate', 'collect', 'prune'].includes(i.action));
  const fix = removable.length ? CLEAN : (cruft.find((i) => i.fix)?.fix || CLEAN);
  lines.push(line('cruft', 'No cruft', cruft.length ? 'fail' : 'ok', `${tally.join(' · ')}${cruft.length ? ` — ${cruft.slice(0, 3).map((i) => path.basename(i.path)).join(', ')}${cruft.length > 3 ? ', …' : ''}` : ''}`, fix));

  const ok = lines.every((l) => l.state !== 'fail');
  return { schemaVersion: 1, kind: 'ruvnet-brain-confirmation', ok, checkedAt: new Date(now).toISOString(), lines,
    location: roots.location || null,
    footprint: { kbCopies: footprint.kbCopies, kbCopyFix: footprint.kbCopyFix || null, totalBytes: footprint.totalBytes, budgetBytes: footprint.budgetBytes,
      breakdown: footprint.breakdown, cruft: cruft.map(({ path: p, kind, bytes, reason, action }) => ({ path: p, kind, bytes, reason, action })),
      unowned: footprint.unowned.map(({ path: p, kind, bytes, reason }) => ({ path: p, kind, bytes, reason })) } };
}

const MARK = { ok: '✓', fail: '✗', warn: '!', unknown: '○' };
/** The human block. `color` is an optional { green, red, yellow, dim, bold } painter. `summary:false` omits the
 * closing line, for a caller (`--doctor`) that prints the ONE verdict itself from the same `ok`. */
export function formatConfirmation(result, { color = null, summary = true } = {}) {
  const paint = (state, text) => (color ? (state === 'ok' ? color.green(text) : state === 'fail' ? color.red(text)
    : state === 'warn' ? (color.yellow || color.dim)(text) : color.dim(text)) : text);
  const out = ['  Positive confirmation'];
  for (const l of result.lines) {
    out.push(`    ${paint(l.state, MARK[l.state] || '○')} ${l.label.padEnd(10)} ${l.detail}`);
    if (l.fix) out.push(`      fix: ${l.fix}`);
  }
  const advisories = result.lines.filter((l) => l.state === 'warn').length;
  if (summary) {
    out.push(`    ${!result.ok ? 'Not green — run the fix named on each ✗ line.'
      : advisories ? `Green — ${advisories} advisory line(s) marked ! do not block; each names its fix.` : 'All checks that can be proven here are green.'}`);
  }
  return out.join('\n');
}

/**
 * THE ONE VERDICT (review S5). `--doctor` text, `--doctor --json` and the exit code all come from this:
 * failing iff ANY line is ✗ — the positive-confirmation lines plus the doctor's own checks (each a line
 * `{ id, label, state, detail, fix }`). '!' lines are advisory (currency) and never fail it.
 */
export function doctorVerdict(confirmation, checks = []) {
  const lines = [...(confirmation?.lines || []), ...checks];
  const failing = lines.filter((l) => l.state === 'fail').map((l) => l.id);
  return { ...confirmation, kind: 'ruvnet-brain-doctor', lines, ok: failing.length === 0, failing,
    advisories: lines.filter((l) => l.state === 'warn').map((l) => l.id), exitCode: failing.length ? 1 : 0 };
}

/** Is there a signature record bound to the bytes live now? */
export function signatureRecordValid({ brainHome, kbDir }) {
  const signature = readJson(path.join(brainHome, SIGNATURE_RECORD));
  const coverage = sha256File(path.join(kbDir, 'COVERAGE.json'));
  return Boolean(signature?.coverageSha256 && coverage && signature.coverageSha256 === coverage && signature.bundleSha256);
}

/**
 * Evidence that the bytes live now were signature-verified, from this machine's own refresh receipts: a
 * SUCCEEDED run whose updater APPLIED a bundle (the updater refuses unsigned or mis-signed bundles, exit
 * 3/4) and whose recorded coverage digest equals the live COVERAGE.json. Used by `--update` when it applies
 * nothing, so "fix: --update" on a missing record is a fix that works. null when no such run exists.
 */
export function signatureEvidenceFromReceipts({ brainHome, kbDir }) {
  const coverage = sha256File(path.join(kbDir, 'COVERAGE.json'));
  if (!coverage) return null;
  const dir = path.join(brainHome, 'refresh-runs');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort().reverse(); } catch { return null; }
  for (const name of names) {
    const receipt = readJson(path.join(dir, name));
    if (receipt?.status !== 'SUCCEEDED' || !Array.isArray(receipt.phases)) continue;
    const phase = (id) => receipt.phases.find((p) => p?.phase === id && p.status === 'PASS')?.evidence || null;
    const bundleSha256 = phase('bundle-assembly')?.bundleSha256;
    if (phase('update')?.terminalVerdict === 'applied' && /^[a-f0-9]{64}$/.test(bundleSha256 || '')
      && phase('coverage-generation')?.coverageSha256 === coverage) return { bundleSha256, runId: receipt.runId || name, receipt: path.join(dir, name) };
  }
  return null;
}

/** SessionStart: ONE line, only when the footprint itself is wrong (currency has its own line). */
export function footprintAlarm(result) {
  if (result.location?.state === 'unmounted') {
    const k = result.lines.find((l) => l.id === 'knowledge');
    return `${FOOTPRINT_LINE_PREFIX}BRAIN VOLUME NOT MOUNTED] ${k.detail}. Fix: ${k.fix}.`;
  }
  const bad = result.lines.filter((l) => l.state === 'fail' && ['cruft', 'footprint', 'in-use'].includes(l.id));
  const copies = result.footprint.kbCopies;
  if (copies !== 1) bad.unshift({ detail: `${copies} knowledge-base copies on disk (must be exactly 1)`, fix: result.footprint.kbCopyFix || CLEAN });
  if (!bad.length) return '';
  return `${FOOTPRINT_LINE_PREFIX}NOT CLEAN] ${bad.map((l) => l.detail).join('; ')}. Fix: ${bad[0].fix} (verify: npx ruvnet-brain --doctor).`;
}
