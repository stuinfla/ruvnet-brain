/**
 * continuity-events.mjs — the MATERIAL EVENTS a later session needs, read from real sources.
 *
 * WHY (measured 2026-10-01 on this repo's real `.swarm/memory.db`, read-only, last 5 days): 367
 * commits on all refs (198 on main) and 20 tags happened; the store held 624 `turns` rows (323 distinct
 * outcomes — two writers recording the same turn), 3 hand-written `decision-*` rows, 0 lesson rows, and
 * only 54 of the 367 commit SHAs appeared anywhere in it. The progression head restored at SessionStart
 * carried the same goal in all 41 snapshots and named a pre-4.4.0 HEAD four hours after 4.4.0 shipped.
 * Prose turn summaries are not a project record: nothing in them is keyed, typed or deduplicated.
 *
 * So this module turns what is OBSERVABLE at a capture boundary into small typed events:
 *
 *   commit     git, by SHA (subject, files, merge flag, branch)        authoritative
 *   release    local git tag observations, by tag + target SHA         publication unverified
 *   gate       a test / check / release command and its exit outcome   authoritative (tool result)
 *   finding    an Agent/Task completion's reported result             not authoritative (agent text)
 *   decision   a line the assistant marked as a decision, or explicit  explicit only is authoritative
 *   lesson     an owner correction / standing rule, or explicit        explicit only is authoritative
 *   open-item  explicit only (the work ledger is read live, not copied) authoritative
 *
 * Each event is redacted (redactProgression), bounded (SUMMARY_LIMIT), and carries a content-derived
 * `id` so the same commit, decision or lesson is recorded once however many boundaries see it.
 *
 * PRIVACY. Turn capture never stores user text (a 2026-07-13 measurement: prompt echoes were 87% of a
 * store's noise). Lessons are the one exception the owner asked for ("owner corrections & standing
 * rules"): only the SENTENCES of a user message that state a durable rule (DURABLE_RULE below), at most
 * SUMMARY_LIMIT characters, redacted, marked `authoritative: false, source: 'owner-correction-detected',
 * detail.status: 'detected-unconfirmed'`, written only to the project's own local store; the brief never
 * presents one as a standing rule. RUVNET_CONTINUITY_LESSON_DETECT=off turns that detector off.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { redactProgression } from './project-progression-contract.mjs';
import { resolveProjectStore } from './project-store-resolver.mjs';

export const CONTINUITY_NAMESPACE = 'continuity-events';
export const EVENT_SCHEMA = 'ruvnet-brain.continuity-event';
export const EVENT_KINDS = Object.freeze(['commit', 'release', 'gate', 'finding', 'decision', 'lesson', 'open-item']);
export const SUMMARY_LIMIT = 400;
/** First capture in a repository looks back this far; later ones look back from the last capture. */
export const INITIAL_LOOKBACK_MS = 3 * 86_400_000;
export const MAX_COMMITS_PER_BOUNDARY = 50;
export const MAX_TAGS_PER_BOUNDARY = 10;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const collapse = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const truncate = (value, limit) => (value.length <= limit ? value : `${value.slice(0, limit - 1)}…`);
// A key block whose END marker is missing (a partial paste) is redacted to the end of the text, and a key
// tail whose BEGIN marker is missing is redacted back to the start of its base64 run. Over-redaction is
// the safe direction. Both passes are linear in the text (a backtracking tail regex measured 1.5 s on 20 KB).
const KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/g;
const KEY_BODY = /[A-Za-z0-9+/=\s]/;
/** Text beyond this is never stored; cutting HERE is safe because both key passes handle a cut block. */
const MAX_SCAN = 64 * 1024;
function redactKeyTails(value) {
  let out = ''; let last = 0; let m;
  KEY_END.lastIndex = 0;
  while ((m = KEY_END.exec(value))) {
    let start = m.index;
    while (start > last && KEY_BODY.test(value[start - 1])) start -= 1;
    out += `${value.slice(last, start)} [REDACTED:private-key]`;
    last = m.index + m[0].length;
  }
  return out + value.slice(last);
}
/** Redact the WHOLE text first; only then may it be shortened (review S2: truncate-first cut off the END
 * marker, so the key regex never matched and the BEGIN line plus key body survived). */
// Shapes the shared progression list misses (re-review S3, a6) — gate commands and output tails carry them.
// LINEAR by construction, and timed per pattern on 64 KB / 100 KB adversarial input in
// tests/unit/continuity-events.test.mjs: every repeated name is ONE character class anchored at a word boundary
// (or bounded, e.g. a URL scheme of at most 32 characters) and judged in a callback; a `[\w]*(?:KEY|…)[\w]*`
// pattern backtracked quadratically (1.6 s on 60 KB), and so did an unbounded URL scheme (1.2 s on 64 KB).
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i;
const VALUE = String.raw`"[^"\n]*"?|'[^'\n]*'?|[^\s;,&|]+`; // a quoted value may be unterminated: redact to end of line
const named = (name, sep) => `${name}${sep}[REDACTED:secret]`;
export const CONTINUITY_SECRETS = [
  // ENV-style assignments: NPM_TOKEN=…, AWS_SECRET_ACCESS_KEY=…, DB_PASSWORD="…", GH_API_KEY=…, --password=…
  [new RegExp(String.raw`\b([A-Za-z0-9_]+)(\s*=\s*)(${VALUE})`, 'g'), (m, name, eq) => (SECRET_NAME.test(name) ? named(name, eq) : m)],
  // JSON values, string or number: "password": "…", "apiKey":"…", "pin": 98765…
  [/"([A-Za-z0-9_-]+)"(\s*:\s*)("(?:[^"\\\n]|\\.)*"|-?\d[\d.eE+-]*)/g, (m, name, colon) => (SECRET_NAME.test(name) ? `"${name}"${colon}"[REDACTED:secret]"` : m)],
  // URL userinfo up to the LAST '@' before the host (a password may contain '@'); scheme length is bounded.
  [/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]+:[^\s/]*@/gi, '$1[REDACTED:userinfo]@'],
  // Authorization headers of any scheme, and a quoted Bearer value
  [/\b(Authorization\s*:\s*)(?:Basic|Bearer|Token|Digest)?\s*[^\s"']+/gi, '$1[REDACTED:authorization]'],
  [/\b(Bearer\s+)(["'])[^"'\n]*\2/gi, '$1[REDACTED:bearer-token]'],
  // X-…-Key / X-Auth-Token / X-Secret… headers (name length bounded)
  [new RegExp(String.raw`\b(X-[A-Za-z0-9-]{1,64})(\s*:\s*)(${VALUE})`, 'gi'), (m, name, colon) => (SECRET_NAME.test(name) ? named(name, colon) : m)],
  // CLI flags: --password <v>, --pass <v>, --token <v>, --api-key <v>
  [new RegExp(String.raw`(--(?:password|passwd|pass|token|secret|api-key|apikey|access-key|auth-token)(?:\s+|=))(${VALUE})`, 'gi'), '$1[REDACTED:secret]'],
  // mysql-family -p<password> (attached), within one command line
  [/(\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^\n]{0,200}?\s-p)(\S+)/g, '$1[REDACTED:secret]'],
  // -u / --user user:password (curl and friends)
  [/((?:^|\s)(?:-u|--user)\s+)([^\s:]+):(\S+)/g, '$1$2:[REDACTED:secret]'],
  // JS/TS object keys without quotes: { apiKey: "…" }, clientSecret: '…'
  [/\b([A-Za-z_][A-Za-z0-9_]*)(\s*:\s*)("[^"\n]*"?|'[^'\n]*'?|`[^`\n]*`?)/g, (m, name, colon) => (SECRET_NAME.test(name) ? named(name, colon) : m)],
  // export / setenv / set NAME value (no '=')
  [new RegExp(String.raw`\b((?:export|setenv|set)\s+)([A-Za-z0-9_]+)(\s+)(${VALUE})`, 'g'), (m, kw, name, sp) => (SECRET_NAME.test(name) ? `${kw}${named(name, sp)}` : m)],
  // Well-known token shapes
  [/\b(?:npm_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16})\b/g, '[REDACTED:token]'],
];
export function redactText(text) {
  let value = String(text ?? '').slice(0, MAX_SCAN);
  if (value.includes('PRIVATE KEY-----')) value = redactKeyTails(value.replace(KEY_BLOCK, '[REDACTED:private-key]'));
  for (const [pattern, replacement] of CONTINUITY_SECRETS) value = value.replace(pattern, replacement);
  return redactProgression(value).value;
}
/** Redact, then collapse whitespace, then bound. The ONLY way event text is shortened. */
const bound = (text, limit = SUMMARY_LIMIT) => truncate(collapse(redactText(text)), limit);

/** Compact, lexically sortable UTC stamp: 20261001T134539123Z. */
export function stamp(at) {
  return new Date(at).toISOString().replace(/[-:]/g, '').replace('.', '');
}

/**
 * Build one event. `basis` is what makes two observations the SAME event (a SHA, a tag, normalized
 * text); it is hashed with the kind into `id`, which ends the AgentDB key, so dedupe is a key lookup.
 */
export function makeEvent({ kind, at = Date.now(), host = 'claude', session = null, source, authoritative,
  summary, detail = {}, basis, project = null }) {
  if (!EVENT_KINDS.includes(kind)) throw new TypeError(`unknown continuity event kind: ${kind}`);
  if (typeof source !== 'string' || !source) throw new TypeError('a continuity event needs a source');
  if (!collapse(summary)) throw new TypeError('a continuity event needs a summary');
  const id = sha256(`${kind}\u0000${collapse(basis ?? summary).toLowerCase()}`).slice(0, 16);
  const { value } = redactProgression({
    schema: EVENT_SCHEMA,
    schemaVersion: 1,
    kind,
    id,
    at: new Date(at).toISOString(),
    host,
    session,
    project,
    source,
    authoritative: Boolean(authoritative),
    summary: bound(summary),
    detail,
  });
  return value;
}

export const eventKey = (event) => `cevt-${stamp(event.at)}-${event.kind}-${event.id}`;
export const eventIdOf = (key) => {
  const match = /^cevt-\d{8}T\d{9}Z-([a-z-]+)-([0-9a-f]{16})$/.exec(String(key));
  return match ? `${match[1]}:${match[2]}` : null;
};

function git(cwd, args, { deadlineAt = Infinity, signal, run = execFileSync } = {}) {
  const check = () => { if (signal?.aborted || Date.now() >= deadlineAt) throw new Error(signal?.aborted ? 'continuity Git capture aborted; unavailable' : 'continuity Git capture deadline exceeded; unavailable'); };
  check();
  try {
    const out = run('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      timeout: Math.max(1, Math.floor(Math.min(3000, deadlineAt - Date.now()))), killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });
    check(); return out;
  } catch (error) { check(); if (error.code === 'ETIMEDOUT') throw new Error('continuity Git capture timed out; unavailable'); return null; }
}

/**
 * Commits on the current branch since `sinceMs`, newest first, bounded. Reads git only: a commit made
 * outside any session (a terminal, CI fast-forward pulled later) is still recorded at the next boundary.
 */
export function collectCommits({ checkoutRoot, sinceMs, host, session, project, max = MAX_COMMITS_PER_BOUNDARY, deadlineAt = Infinity, signal, run }) {
  const options = { deadlineAt, signal, run };
  const out = git(checkoutRoot, ['log', `-n${max}`, `--since=${new Date(sinceMs).toISOString()}`,
    '--format=%x1e%H%x1f%P%x1f%cI%x1f%an%x1f%s', '--name-only', 'HEAD'], options);
  if (!out) return [];
  const branch = (git(checkoutRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], options) || '').trim() || 'detached';
  const events = [];
  for (const record of out.split('\x1e').map((r) => r.trim()).filter(Boolean)) {
    const [header, ...fileLines] = record.split('\n');
    const [sha, parents, committedAt, author, subject] = header.split('\x1f');
    if (!/^[0-9a-f]{40}$/.test(sha || '')) continue;
    const files = fileLines.map((f) => f.trim()).filter(Boolean);
    const merge = String(parents || '').trim().split(/\s+/).filter(Boolean).length > 1;
    events.push(makeEvent({
      kind: 'commit', at: Date.parse(committedAt) || Date.now(), host, session, project, source: 'git', authoritative: true,
      summary: `${sha.slice(0, 8)} ${subject}`, basis: sha,
      detail: { sha, branch, merge, author, files: files.slice(0, 20), fileCount: files.length },
    }));
  }
  return events;
}

/** Tags created since `sinceMs` (code releases `v*` and corpus releases), bounded. */
export function collectReleases({ checkoutRoot, sinceMs, host, session, project, max = MAX_TAGS_PER_BOUNDARY, deadlineAt = Infinity, signal, run }) {
  const out = git(checkoutRoot, ['for-each-ref', 'refs/tags', '--sort=-creatordate', `--count=${max * 4}`,
    '--format=%(refname:short)%1f%(objectname)%1f%(*objectname)%1f%(creatordate:iso-strict)'], { deadlineAt, signal, run });
  if (!out) return [];
  const events = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const [tag, object, peeled, created] = line.split('\x1f');
    const at = Date.parse(created);
    if (!tag || !Number.isFinite(at) || at < sinceMs) continue;
    const sha = peeled || object;
    events.push(makeEvent({
      kind: 'release', at, host, session, project, source: 'git-tag', authoritative: false,
      summary: `LOCAL TAG ${tag} -> ${String(sha).slice(0, 8)} (publication unverified)`, basis: `${tag}@${sha}`,
      detail: { tag, sha, channel: tag.startsWith('corpus-') ? 'corpus' : 'code', publicationVerified: false },
    }));
    if (events.length >= max) break;
  }
  return events;
}

// A command whose OUTCOME is project state: tests, checks, qualification, release gates.
export const GATE_COMMAND = /\b(?:npm\s+(?:run\s+)?test\b|npx\s+vitest\b|vitest\s+run\b|jest\b|pytest\b|cargo\s+(?:test|clippy)\b|go\s+test\b|npm\s+run\s+[\w:.-]*(?:check|qualify|test|gate|lint|verify)[\w:.-]*|node\s+scripts\/(?:release-qualification|full-suite-gate|single-source-check|wired-check|hook-retirement-check)[\w.-]*|gh\s+(?:run\s+(?:watch|view)|workflow\s+run)\b)/i;
const DECISION_LINE = /^\s*(?:[-*>]\s*)?(?:\*\*)?\s*(?:decision|decided|we decided|i decided|the decision|chose|we chose|choosing|going with)\b\s*(?:\*\*)?\s*[:—-]?\s*\S/i;
const LESSON_LINE = /^\s*(?:[-*>]\s*)?(?:\*\*)?\s*(?:lesson(?: learned)?|standing rule|rule going forward)\b\s*(?:\*\*)?\s*[:—-]\s*\S/i;
// DURABLE-RULE PHRASING ONLY (review S1a). The old pattern matched bare "never" / "do not" / "you must", so
// "Fix the login bug, and do not touch the CSS" and "never mind, go ahead" were saved as standing lessons.
// A sentence counts only when it states a rule that outlives the task: "from now on", "going forward",
// "never again", "standing rule", "as a rule", or a sentence that OPENS with "Always …" / "Never …" (not
// "never mind") / "Remember that|to …". Questions never count. tests/unit/continuity-events.test.mjs keeps
// the negative corpus of ordinary imperatives that must yield nothing.
const DURABLE_RULE = /\b(?:from now on|going forward|never again|don'?t ever|do not ever|(?:standing|permanent|golden|hard) rule|as a (?:general )?rule)\b|^(?:always\s+\w|never\s+(?!mind\b)\w|remember\s+(?:that|to)\b|remember\s*:)/i;
/** The sentences of an owner message that state a durable rule (empty when none do). */
export function durableRuleSentences(text) {
  return String(text ?? '').split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim())
    .filter((s) => s && !s.endsWith('?') && DURABLE_RULE.test(s.replace(/^[-*>\s]+/, '')));
}

const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n') : '');
const resultText = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((c) => (typeof c === 'string' ? c : c?.type === 'text' ? c.text : '')).join('\n') : '');

/** The records of the CURRENT turn: everything after the last genuine user message, plus that message. */
export function currentTurnRecords(lines) {
  const recs = [];
  for (const line of lines) { try { recs.push(JSON.parse(line)); } catch { /* partial or foreign line */ } }
  let start = -1;
  recs.forEach((o, i) => {
    const role = o?.message?.role || o?.role;
    const c = o?.message?.content;
    const isToolResult = Array.isArray(c) && c.some((x) => x && x.type === 'tool_result');
    if (role === 'user' && !isToolResult && textOf(c).trim()) start = i;
  });
  return { userMessage: start >= 0 ? textOf(recs[start].message?.content) : '', records: recs.slice(start + 1) };
}

export { exitOutcome as normalizeToolOutcome };

function exitOutcome(result) {
  const text = resultText(result?.content);
  const response = result?.content && typeof result.content === 'object' && !Array.isArray(result.content)
    ? result.content : result;
  const codes = [...text.matchAll(/^(?:Exit code\s*:?|Process exited with code)\s+(-?\d+)\s*$/gim)].map(match => Number(match[1]));
  for (const value of [result, response]) for (const key of ['exit_code', 'exitCode', 'status']) {
    if (Number.isSafeInteger(value?.[key])) codes.push(value[key]);
  }
  const distinct = [...new Set(codes)], code = distinct.length === 1 ? distinct[0] : null;
  const states = [result, response].flatMap(value => [value?.status, value?.outcome]).filter(value => typeof value === 'string').map(value => value.toLowerCase());
  const uncertain = states.some(value => ['unknown', 'unavailable'].includes(value));
  const failed = states.some(value => ['fail', 'failed', 'failure', 'error', 'denied'].includes(value)) || [result, response].some(value => value?.is_error === true || value?.isError === true
    || value?.success === false || value?.ok === false || Boolean(value?.error)) || codes.some(value => value !== 0);
  const interrupted = [result, response].some(value => value?.interrupted === true || value?.cancelled === true || value?.canceled === true || Boolean(value?.signal))
    || states.some(value => ['cancelled', 'canceled', 'interrupted', 'aborted', 'timeout', 'timed_out'].includes(value));
  const running = /\bProcess running with session ID\b|\bScript running with cell ID\b/i.test(text)
    || states.some(value => ['running', 'pending', 'queued'].includes(value))
    || [result, response].some(value => value?.completed === false);
  // Captured Claude Write/create terminal: correlate the exact request and response, not just
  // the hook name. Failure, cancellation, unfinished and unknown evidence still dominate below.
  const capturedWrite = result?.hook_event_name === 'PostToolUse' && result?.tool_name === 'Write'
    && typeof result.tool_use_id === 'string' && result.tool_use_id.length > 0 && response?.type === 'create'
    && typeof result.tool_input?.file_path === 'string' && result.tool_input.file_path.length > 0 && result.tool_input.file_path === response.filePath
    && typeof result.tool_input?.content === 'string' && result.tool_input.content === response.content
    && Array.isArray(response.structuredPatch) && response.structuredPatch.length === 0 && response.originalFile === null && response.userModified === false;
  const outcome = failed ? 'fail' : interrupted ? 'interrupted' : running ? 'pending' : !uncertain && (code === 0 || capturedWrite) ? 'pass' : 'unknown';
  const tail = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(-1)[0] || '';
  const nativeSuccess = capturedWrite || [result, response].some(value => value?.is_error === false || value?.isError === false || value?.success === true || value?.ok === true);
  return { outcome, exitCode: running || interrupted ? null : code, tail: bound(tail, 200),
    uncertain, successfulToolResult: !failed && !interrupted && !running && !uncertain && (code === 0 || nativeSuccess) };
}

/**
 * Typed events from one Claude JSONL turn. Codex rollouts are not parsed (project-progression-sources
 * declares that format unknown); Codex gets decisions/lessons from `last_assistant_message` only.
 */
export function collectTurnEvents({ lines = null, lastAssistantMessage = '', host, session, project, env = process.env, at = Date.now() }) {
  const events = [];
  const turn = lines ? currentTurnRecords(lines) : { userMessage: '', records: [] };
  const uses = new Map();
  const assistantTexts = [];
  for (const rec of turn.records) {
    const role = rec?.message?.role || rec?.role;
    const content = rec?.message?.content;
    if (role === 'assistant') {
      const t = textOf(content);
      if (t.trim()) assistantTexts.push(t);
      if (Array.isArray(content)) for (const u of content) if (u?.type === 'tool_use' && u.id) uses.set(u.id, u);
    } else if (role === 'user' && Array.isArray(content)) {
      for (const r of content) {
        if (r?.type !== 'tool_result') continue;
        const use = uses.get(r.tool_use_id);
        if (!use) continue;
        const input = use.input || {};
        if (use.name === 'Bash' && typeof input.command === 'string' && GATE_COMMAND.test(input.command)) {
          const command = bound(input.command, 200);
          const { outcome, exitCode, tail } = exitOutcome(r);
          events.push(makeEvent({ kind: 'gate', at, host, session, project, source: 'tool-result', authoritative: ['pass', 'fail'].includes(outcome),
            summary: `${outcome.toUpperCase()} ${command}${tail ? ` — ${tail}` : ''}`,
            basis: `${session}\u0000${use.id}`, detail: { command, outcome, exitCode, description: bound(input.description || '', 120) } }));
        } else if (use.name === 'Agent' || use.name === 'Task') {
          const text = resultText(r.content);
          if (!collapse(text)) continue;
          events.push(makeEvent({ kind: 'finding', at, host, session, project, source: 'agent-result', authoritative: false,
            summary: text, basis: text.slice(0, 600),
            detail: { agent: bound(input.subagent_type || input.name || 'agent', 60), task: bound(input.description || '', 120) } }));
        }
      }
    }
  }
  if (lastAssistantMessage && !assistantTexts.includes(lastAssistantMessage)) assistantTexts.push(lastAssistantMessage);
  for (const text of assistantTexts) {
    for (const line of text.split('\n')) {
      if (DECISION_LINE.test(line)) {
        events.push(makeEvent({ kind: 'decision', at, host, session, project, source: 'assistant-detected', authoritative: false, summary: line.replace(/\*\*/g, '') }));
      } else if (LESSON_LINE.test(line)) {
        events.push(makeEvent({ kind: 'lesson', at, host, session, project, source: 'assistant-detected', authoritative: false, summary: line.replace(/\*\*/g, '') }));
      }
    }
  }
  const owner = String(turn.userMessage || '');
  const rules = String(env.RUVNET_CONTINUITY_LESSON_DETECT || '').toLowerCase() !== 'off' && owner.length <= 4000
    ? durableRuleSentences(owner) : [];
  if (collapse(rules.join(' ')).length >= 20) {
    // Only the rule sentence(s) are kept, never the rest of the prompt. Heuristic, so never authoritative:
    // the brief shows it under "DETECTED, UNCONFIRMED", not as a standing rule.
    events.push(makeEvent({ kind: 'lesson', at, host, session, project, source: 'owner-correction-detected', authoritative: false,
      summary: rules.join(' '), detail: { status: 'detected-unconfirmed' } }));
  }
  const seen = new Set();
  return events.filter((e) => (seen.has(`${e.kind}:${e.id}`) ? false : seen.add(`${e.kind}:${e.id}`)));
}

/**
 * The owner's own user-level AgentDB hooks (~/.claude/settings.json). Read, never modified. Used to
 * DEFER: where one of them already records a thing, the product does not record it a second time.
 */
export function userLevelAgentdbHooks({ home = os.homedir(), event, projectDir, env = process.env, deadlineAt = Infinity, signal } = {}) {
  const found = { turnCapture: false, autocapture: false, ensure: false, ownership: 'unknown', collisionCandidate: false,
    settings: path.join(home, '.claude', 'settings.json') };
  if (!['Stop', 'PreCompact', 'SessionEnd', 'SessionStart'].includes(event) || !projectDir
    || String(env.RUVNET_HOOK_HOST || 'claude') !== 'claude') return found;
  let doc;
  try { doc = JSON.parse(fs.readFileSync(found.settings, 'utf8')); } catch { return found; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.disableAllHooks === true || doc.allowManagedHooksOnly === true) return found;
  let target, executable;
  try {
    for (const file of [path.join(projectDir, '.claude', 'settings.json'), path.join(projectDir, '.claude', 'settings.local.json')]) {
      let local;
      try { local = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!local || typeof local !== 'object' || Array.isArray(local) || local.disableAllHooks === true || local.allowManagedHooksOnly === true) return found;
    }
    deadlineAt = Math.min(deadlineAt, Number(env.RUVNET_SESSION_START_DEADLINE_AT) || Infinity);
    if (signal?.aborted || Date.now() >= deadlineAt) return found;
    target = resolveProjectStore({ projectDir, gitTimeoutMs: Math.max(1, Math.floor(Math.min(500, deadlineAt - Date.now()))), deadlineAt }).canonicalAgentDbPath;
    if (signal?.aborted || Date.now() >= deadlineAt) return found;
    // Bind the direct command to the declared entry of the user's one managed GLOBAL Ruflo.
    // Arbitrary Node handlers, filenames and source comments do not prove their actual target.
    if (!process.getuid) return found; // Native Windows ACL ownership is not attested by POSIX uid metadata.
    const root = path.join(home, '.npm-global', 'lib', 'node_modules', 'ruflo');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const declared = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.ruflo;
    if (manifest.name !== 'ruflo' || typeof declared !== 'string' || path.isAbsolute(declared) || declared.split(/[\\/]/).includes('..')) return found;
    executable = fs.realpathSync.native(path.join(home, '.npm-global', 'bin', 'ruflo'));
    const entry = fs.realpathSync.native(path.join(root, declared));
    const relative = path.relative(fs.realpathSync.native(root), entry);
    const stat = fs.statSync(entry);
    if (executable !== entry || relative.startsWith('..') || path.isAbsolute(relative) || !stat.isFile() || stat.uid !== process.getuid()) return found;
    fs.accessSync(executable, fs.constants.X_OK);
  } catch { return found; }
  const groups = doc?.hooks?.[event];
  for (const group of Array.isArray(groups) ? groups : []) {
    if (group?.enabled === false || group?.disabled === true || (group?.matcher && group.matcher !== '*')) continue;
    for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
      if (hook?.type !== 'command' || hook.enabled === false || hook.disabled === true || typeof hook.command !== 'string') continue;
      const command = hook.command.trim();
      if (/[$`;&|<>\r\n]/.test(command)) continue;
      const tokens = []; const words = /"([^"\\]*)"|'([^']*)'|([^\s"'\\]+)/g;
      let match, previous = 0, valid = true;
      while ((match = words.exec(command))) {
        if (command.slice(previous, match.index).trim()) { valid = false; break; }
        tokens.push(match[1] ?? match[2] ?? match[3]); previous = words.lastIndex;
      }
      if (!valid || command.slice(previous).trim() || tokens[1] !== 'memory') continue;
      try { if (!path.isAbsolute(tokens[0]) || fs.realpathSync.native(tokens[0]) !== executable) continue; } catch { continue; }
      const options = tokens[2] === 'store' ? ['--path', '-p', '--namespace', '-n', '--key', '-k', '--value']
        : tokens[2] === 'retrieve' ? ['--path', '-p', '--namespace', '-n', '--key', '-k']
          : tokens[2] === 'init' ? ['--path', '-p'] : [];
      for (let i = 3; i < tokens.length; i += 2) {
        if (!options.includes(tokens[i]) || !tokens[i + 1] || tokens[i + 1].startsWith('-')) { valid = false; break; }
      }
      if (!valid) continue;
      const flag = names => {
        const positions = tokens.flatMap((token, i) => names.includes(token) ? [i] : []);
        return positions.length === 1 ? tokens[positions[0] + 1] : undefined;
      };
      const db = flag(['--path', '-p']);
      if (!db || !path.isAbsolute(db) || db.split(/[\\/]/).includes('..') || path.resolve(db) !== target) continue;
      const namespace = flag(['--namespace', '-n']);
      const captureRegistration = tokens[2] === 'store' && flag(['--key', '-k']) && flag(['--value'])
        && ((event === 'Stop' && namespace === 'turns') || (['PreCompact', 'SessionEnd'].includes(event) && namespace === 'sessions'));
      const ensureRegistration = event === 'SessionStart' && ['init', 'retrieve'].includes(tokens[2]);
      if (captureRegistration || ensureRegistration) found.collisionCandidate = true;
    }
  }
  if (found.collisionCandidate) {
    found.target = target; found.event = event;
    found.reason = 'canonical registration alone does not prove capture of the current turn/session';
  }
  return found;
}
