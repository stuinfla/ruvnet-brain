#!/usr/bin/env node
/**
 * decision-recall-gate.mjs — "read AgentDB before deciding" as a FACT check (ADR-105 §8, ADR-106).
 *
 * A POLICY OF decision-gate.mjs, NOT A HOOK: exit 0 allow, exit 2 + stderr refuse; composed by the
 * one PreToolUse refuser (ADR-067) on both hosts, so it adds no registration.
 *
 * WHEN IT LOOKS: a write that CREATES an ADR file (Write to a path that does not exist yet, or an
 * apply_patch `*** Add File:`), or an Edit/MultiEdit that changes an ADR's status line. Ordinary ADR
 * edits (wording, review stamps) are never checked.
 *
 * THE FACT: a `decision-record.mjs --consult` receipt for this project younger than two hours. The
 * receipt proves the consult RAN; it does not require history to have been available — an AgentDB
 * outage must not wedge decisions, so an `unavailable` receipt allows and says history was unknown.
 *
 * AT MOST ONE REFUSAL PER PATH PER SESSION (the duplicate-gate shape): the retry is allowed and
 * recorded. Only in an adopted project (canonical `.swarm/memory.db` exists). Opt-outs win
 * (ADR-105 §7): RUVNET_DECISION_RECALL_GATE=off, RUVNET_AGENTDB_FIRST=off, the brain-off sentinel.
 * Fails open on its own errors.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveProjectStore } from './project-store-resolver.mjs';
import { isAdrPath, freshConsultReceipt, brainHomeOf } from './decision-record.mjs';

const ALLOW = 0;
const REFUSE = 2;
const STATUS_LINE = /^\s*(?:status:\s*\S.*|\*\*Status\*\*\s*:.*)$/im;
/** The document's status line, ignoring fenced code (a YAML example is not the ADR's status). */
const STATUS_LINES = new RegExp(STATUS_LINE.source, 'gim');
/** Every status line of the document (frontmatter AND body), ignoring fenced code. */
export const statusOf = (text) => [...String(text || '').replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '').matchAll(STATUS_LINES)]
  .map((m) => m[0].trim()).join('\n');

function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }

/**
 * Which ADR decision, if any, this tool call makes. A status change is judged on the WHOLE document:
 * the status of the file now versus the status after this edit is applied, so a whole-file Write over
 * an existing ADR is seen (review finding 5) and a `status:` line inside a code fence is not (finding 6).
 */
export function adrDecisionIn(payload, { read = readText } = {}) {
  const tool = String(payload?.tool_name || '');
  const input = payload?.tool_input || {};
  const cwd = typeof payload?.cwd === 'string' ? payload.cwd : process.cwd();
  const abs = (p) => (path.isAbsolute(p) ? p : path.resolve(cwd, p));
  if (['Write', 'Edit', 'MultiEdit'].includes(tool) && isAdrPath(input.file_path)) {
    const before = read(abs(input.file_path));
    if (before === null) return tool === 'Write' ? { path: input.file_path, kind: 'new ADR' } : null;
    let after = before;
    if (tool === 'Write') after = String(input.content ?? '');
    else {
      const edits = tool === 'Edit' ? [input] : (Array.isArray(input.edits) ? input.edits : []);
      for (const e of edits) {
        const from = String(e.old_string ?? ''); const to = String(e.new_string ?? '');
        if (!from) continue;
        after = e.replace_all ? after.split(from).join(to) : after.replace(from, () => to);
      }
    }
    return statusOf(after) !== statusOf(before) ? { path: input.file_path, kind: 'ADR status change' } : null;
  }
  if (tool === 'apply_patch') {
    const text = typeof input === 'string' ? input : JSON.stringify(input);
    const patch = typeof input === 'string' ? input : String(input.input ?? input.patch ?? input.command ?? text);
    const added = [...patch.matchAll(/\*\*\* Add File: ([^\n\\"]+)/g)].map((m) => m[1].trim()).find(isAdrPath);
    if (added) return { path: added, kind: 'new ADR' };
    // An Update File hunk on an ADR: compare the status lines it removes with the ones it adds.
    for (const section of patch.split(/^\*\*\* (?=Update File: )/m).slice(1)) {
      const file = /^Update File: ([^\n]+)/.exec(section)?.[1]?.trim();
      if (!isAdrPath(file)) continue;
      const lines = section.split('\n');
      const side = (sign) => lines.filter((l) => l.startsWith(sign) && !l.startsWith(sign.repeat(3))).map((l) => l.slice(1)).join('\n');
      if (statusOf(side('+')) !== statusOf(side('-'))) return { path: file, kind: 'ADR status change' };
    }
  }
  return null;
}

function brainOff(env) {
  const dir = env.RUVNET_BRAIN_STATE_DIR || path.join(env.HOME || os.homedir(), '.config', 'ruvnet-brain');
  try { fs.statSync(path.join(dir, 'brain-off')); return true; } catch (e) { return !(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')); }
}

const ackFile = (brainHome) => path.join(brainHome, 'decision-recall-acks.json');
function readAcks(file) { try { const o = JSON.parse(fs.readFileSync(file, 'utf8')); return o && typeof o === 'object' ? o : {}; } catch { return {}; } }

/**
 * Publish the ledger the way decision-record.mjs's own sibling (writeConsultReceipt) already does:
 * temp file in the same directory, fsync, then rename. fs.writeFileSync on the real path truncates
 * before it writes — a process killed between those two steps leaves an empty ledger, discarding
 * every acknowledgment ever recorded, not just the one being added. rename() is atomic on POSIX, so
 * a reader (or a crash) only ever sees the old complete ledger or the new complete one.
 */
function writeAcksAtomic(file, acks) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeSync(fd, JSON.stringify(acks));
    try { fs.fsyncSync(fd); } catch { /* filesystem without fsync (some network mounts) — proceed */ }
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* nothing to close */ } }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* leave the temp rather than throw over it */ }
  }
}

/** The verdict. Returns { code, stderr?, stdout? }. */
export function evaluate(payload, { env = process.env, now = Date.now() } = {}) {
  if (['off'].includes(String(env.RUVNET_DECISION_RECALL_GATE || '').toLowerCase())
    || String(env.RUVNET_AGENTDB_FIRST || '').toLowerCase() === 'off' || brainOff(env)) return { code: ALLOW };
  const decision = adrDecisionIn(payload);
  if (!decision) return { code: ALLOW };
  let resolution;
  try { resolution = resolveProjectStore({ projectDir: payload.cwd || process.cwd(), gitTimeoutMs: 400 }); } catch { return { code: ALLOW }; }
  try { if (!fs.statSync(resolution.canonicalAgentDbPath).isFile()) return { code: ALLOW }; } catch { return { code: ALLOW }; }
  const brainHome = brainHomeOf(env);
  const receipt = freshConsultReceipt({ projectRoot: resolution.projectRoot, brainHome, now });
  if (receipt) {
    return /^ok-/.test(receipt.outcome) ? { code: ALLOW }
      : { code: ALLOW, stdout: `AgentDB history was ${receipt.outcome} when this decision was consulted (${receipt.at}); state in the ${decision.kind} that prior decisions are UNKNOWN.` };
  }
  const session = String(payload.session_id || 'no-session');
  const key = crypto.createHash('sha256').update(`${session}\u0000${resolution.projectRoot}\u0000${decision.path}`).digest('hex').slice(0, 32);
  const file = ackFile(brainHome);
  const acks = readAcks(file);
  if (acks[key]) {
    acks[key].retriedAt = new Date(now).toISOString();
    try { writeAcksAtomic(file, acks); } catch { /* the ledger never blocks a write */ }
    return { code: ALLOW, stdout: `This ${decision.kind} was written without an AgentDB consult (retry after one refusal). Record it afterwards with decision-record.mjs --record.` };
  }
  // Keep the ledger bounded: drop acknowledgements older than a week.
  for (const [k, v] of Object.entries(acks)) if (now - Date.parse(v?.at) > 7 * 86_400_000) delete acks[k];
  acks[key] = { at: new Date(now).toISOString(), kind: decision.kind };
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); writeAcksAtomic(file, acks); } catch { return { code: ALLOW }; }
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'decision-record.mjs');
  return { code: REFUSE, stderr: [
    `⛔ BLOCKED (once) — ${decision.kind} ${decision.path}: run decision-record.mjs --consult "<topic>" first (AgentDB decisions unread).`,
    'Consult first (exact curated records, then ranked, one deadline; failure is reported, never empty):',
    `  node ${JSON.stringify(script)} --consult "<the decision topic>"`,
    'Then write the ADR, and record the decision after it:',
    `  node ${JSON.stringify(script)} --record --what "…" --why "…" --shape "…" --evidence adr:${decision.path}`,
    'This path is refused at most once per session; retrying is allowed and recorded. RUVNET_DECISION_RECALL_GATE=off disables it.',
  ].join('\n') };
}

function isMain() {
  try { return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (isMain()) {
  let verdict = { code: ALLOW };
  try {
    const raw = fs.readFileSync(0, 'utf8');
    verdict = evaluate(JSON.parse(raw || '{}'));
  } catch { verdict = { code: ALLOW }; }
  if (verdict.stdout) process.stdout.write(verdict.stdout);
  if (verdict.stderr) process.stderr.write(`${verdict.stderr}\n`);
  process.exit(verdict.code);
}
