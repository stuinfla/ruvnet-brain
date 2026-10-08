/**
 * completion-claim-evidence.mjs — ADR-074's `completion` claim class, and the promise capture that
 * rides the same boundary. Pure functions only: continuation-gate.mjs (the ONE Stop chokepoint) owns
 * delivery, loop safety, cooldown and the ledger write. No hook registration of its own.
 *
 * WHY (owner, 2026-09-30): "You can never ever tell me something is done and implemented without
 * having tested it end to end... That's how I ended up with a broken corpus that hasn't been
 * successfully updated in 40 days because you never told me it was broken."
 *
 * THE RULE, deterministic, read from the host transcript of THIS turn (everything after the last
 * genuine user message):
 *   A narrowly scoped passing-check assertion is OBSERVED_CHECK only when
 *   (1) at least one verification command EXECUTED after the last state-changing action, with its
 *       result present and not an error, AND
 *   (2) the answer names the check (a "Verified:"-style line, or the executed command's own name), AND
 *   (3) the answer discloses what is NOT verified.
 *   Whole-task assertions remain UNKNOWN: this path has no trusted task/source/artifact-bound
 *   positive final-acceptance producer. Observed checks never close the owner's whole task.
 *   Anything else is one correction request. No claim recognised → no verdict about the prose.
 *
 * HOSTS. Claude Code transcripts (`transcript_path`, JSONL) are parsed. Codex's Stop payload also
 * carries `transcript_path`, but its rollout format is NOT parsed anywhere in this repository
 * (project-progression-sources.mjs and turn-outcome-capture.mjs both decline it), so on Codex the
 * transcript half is UNKNOWN and only the answer-side half (2)+(3) is enforced — disclosed in the
 * correction text, never silently treated as proven.
 */
import { readSettledTranscript } from './turn-outcome-capture.mjs';
import { GATE_COMMAND, normalizeToolOutcome } from './continuity-events.mjs';

const MAX_SENTENCE = 400;
export const PROMISE_KIND = 'assistant-commitment';
export const PROMISE_CAP_PER_TURN = 3;
export const PROMISE_CAP_OPEN = 8;

// ── answer-side parsing ─────────────────────────────────────────────────────────────────────────
/** Code, inline code, quoted strings and block quotes are someone else's words, never a claim. */
export function strippedProse(message) {
  return String(message || '')
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/"[^"\n]{0,300}"|“[^”\n]{0,300}”/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, ' '); // table rows are data cells, not sentences
}

function sentences(message) {
  return strippedProse(message)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s && s.length <= MAX_SENTENCE);
}

// A sentence that is itself a disclosure, a negation, a hedge or a condition is not a claim.
const NOT_A_CLAIM = /\b(?:not|never|no|nothing|none|cannot|can't|won't|isn't|aren't|wasn't|weren't|hasn't|haven't|didn't|doesn't|don't|without|unverified|untested|unproven|unknown|yet|if|unless|until|once|when|whether|should|would|could|might|may|maybe|probably|likely|expected|supposed|hopefully|assuming|pending|remaining|remains|todo|tbd|before|after|previously|earlier|already|yesterday|ago|last\s+(?:week|night|time|session|release)|neither|nor|as\s+soon\s+as|tell\s+me|I(?:'ll|’ll)|we(?:'ll|’ll)|will\s+(?!now\b)|(?:was|were)\s+working|damage\s+is\s+done)\b|\?/i;
const HEARSAY = /\b(?:claimed|claims|said|says|reported|told)\b/i;
const FIRST_PERSON_ASSERTION = /^(?:[-*•]\s*|#+\s*)*(?:I|we)(?:'ve|’ve|\s+have)?\s+(?:now\s+|just\s+|successfully\s+|also\s+|fully\s+)*(?:fixed|shipped|deployed|resolved|completed|implemented|landed|published|released|verified|finished|reported|wired\s+up)\b/i;
const CLAIM_PATTERNS = [
  // "X is fixed", "the gate is now live", "tests are passing", "it's done"
  /\b(?:is|are|was|were|has\s+been|have\s+been|(?:it|that|this|what|everything|there)(?:'s|’s)|now)\s+(?:all\s+|fully\s+|now\s+|finally\s+|successfully\s+|actually\s+)*(?:fixed|done|complete|completed|resolved|shipped|deployed|live(?!\s+(?:in|inside|under|with|alongside))|implemented|landed|published|merged|released|verified|green|passing|operational|in\s+place|wired(?:\s+up)?|working(?!\s+(?:on|with|through|in|as|tree|copy|dir)))\b/i,
  // "I fixed", "I've shipped", "we deployed"
  /\b(?:I|we)(?:'ve|’ve|\s+have)?\s+(?:now\s+|just\s+|successfully\s+|also\s+|fully\s+)*(?:fixed|shipped|deployed|resolved|completed|implemented|landed|published|released|verified|finished|reported|wired\s+up)\b/i,
  // "Done." "Fixed:" "Shipped —" "✅ Deployed" at the start of a line
  /^(?:[-*•]\s*|#+\s*|\*\*|✅\s*)*(?:done|fixed|shipped|deployed|resolved|complete|completed|implemented|all\s+done|all\s+set|all\s+green)\b\s*(?:[.!:—–-]|\*\*|$)/i,
  // "now works", "it will now block …", "works end to end"
  /\b(?:now\s+works|works\s+now|works\s+end[- ]to[- ]end|will\s+now\s+(?:work|fire|block|catch|run|stay|refuse|correct|speak|pass|succeed))\b/i,
];

/** Positive completion assertions, in message order. Deterministic; no model call. */
export function extractCompletionClaims(message) {
  const out = [];
  for (const sentence of sentences(message)) {
    if (NOT_A_CLAIM.test(sentence) || (HEARSAY.test(sentence) && !FIRST_PERSON_ASSERTION.test(sentence))) continue;
    if (CLAIM_PATTERNS.some((re) => re.test(sentence))) out.push({ class: 'completion', text: sentence });
  }
  return out;
}

const NAMED_CHECK = /(?:^|\n)\s*(?:[-*•]\s*|#+\s*|\*\*)*(?:verified|verification|evidence|proof|tested|checks?(?:\s+run)?|test\s+results?|measured)\b[^\n]{0,4}?(?:\*\*)?\s*[:—–]/i;
const DISCLOSES_GAPS = /\b(?:not\s+(?:yet\s+)?(?:verified|tested|checked|exercised|measured|proven|covered|run)|unverified|untested|unproven|what\s+i\s+did\s+not\s+(?:test|verify|check)|did\s+not\s+(?:test|verify|check|run|exercise)|didn't\s+(?:test|verify|check|run|exercise)|remains?\s+unknown|UNKNOWN)\b/i;

// ── transcript-side parsing (Claude Code JSONL) ─────────────────────────────────────────────────
const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n') : '');

const TMP_PATH = /^(?:\/tmp\/|\/private\/tmp\/|\/var\/folders\/|\$\{?TMPDIR|\/dev\/null)/;
const MUTATING_SEGMENT = [
  /\bgit\s+(?:commit|push|merge|rebase|reset|revert|cherry-pick|tag|am|apply|restore|stash\s+(?:pop|apply)|mv|rm|switch|checkout)\b/,
  /\bgh\s+(?:release\s+(?:create|edit|upload|delete)|pr\s+(?:create|merge|close|edit|ready)|workflow\s+run|run\s+rerun|issue\s+(?:create|close|edit|comment)|repo\s+edit|secret\s+set|variable\s+set|api\b[^|;&]*-X\s*(?:POST|PUT|PATCH|DELETE))\b/,
  /\b(?:npm|pnpm|yarn)\s+(?:publish|version|install|i|add|uninstall|remove|ci|link|unpublish|dist-tag)\b/,
  /\bnpm\s+run\s+[\w:.-]*(?:write|set|fix|deploy|publish|release|sync|install|update|apply|seed|stamp|migrate|format)[\w:.-]*/,
  /\b(?:launchctl\s+(?:load|unload|bootstrap|bootout|enable|disable|kickstart)|crontab\s+(?!-l\b)\S|schtasks\s+\/(?:create|delete|change))/i,
  /\b(?:vercel\s+(?:deploy|--prod|promote|alias)|netlify\s+deploy|docker\s+(?:push|build)|kubectl\s+(?:apply|delete|rollout)|terraform\s+apply|wrangler\s+(?:deploy|publish))\b/,
  /\s--(?:write|apply|fix|install|enable-nightly|publish|commit|seed|set|update)\b/,
  /\b(?:sed|perl)\s+(?:-[a-zA-Z]*i|-i)\b/,
];
const FILE_MUTATORS = /^(?:sudo\s+)?(?:rm|mv|cp|mkdir|touch|chmod|chown|ln|truncate|rsync|unzip|tee|install)\b/;
const TRIVIAL = /^(?:sudo\s+)?(?:ls|cat|head|tail|less|more|grep|egrep|rg|find|fd|wc|echo|printf|pwd|cd|which|type|command|sort|uniq|cut|tr|stat|file|date|sleep|true|false|export|set|source|\.|test|\[|jq|awk|sed|basename|dirname|realpath|env|git\s+(?:status|log|diff|show|branch|rev-parse|remote|config|worktree\s+list|stash\s+list))\b/;

function segments(command) {
  return String(command || '').split(/&&|\|\||;|\n|\|/).map((s) => s.trim()).filter(Boolean);
}
function segmentMutates(segment) {
  if (MUTATING_SEGMENT.some((re) => re.test(segment))) return true;
  if (FILE_MUTATORS.test(segment)) {
    const args = segment.split(/\s+/).slice(1).filter((a) => !a.startsWith('-'));
    return !args.length || !args.every((a) => TMP_PATH.test(a.replace(/^['"]|['"]$/g, '')));
  }
  return /(?:^|[^0-9&>])>{1,2}\s*(?!&|\/dev\/null)(['"]?)([^\s'"]+)/.test(segment)
    && !TMP_PATH.test((/>{1,2}\s*['"]?([^\s'"]+)/.exec(segment) || [])[1] || '');
}
const CHECK_COMMAND = new RegExp(`^${GATE_COMMAND.source}`, GATE_COMMAND.flags);
const segmentChecks = (segment) => !TRIVIAL.test(segment) && !segmentMutates(segment)
  && (CHECK_COMMAND.test(segment) || /^node\s+--test\b/.test(segment));
function checkName(segment) {
  const words = segment.replace(/^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+/, '').split(/\s+/);
  const run = words.findIndex((w) => w === 'run');
  if (/^(?:npm|pnpm|yarn)$/.test(words[0]) && run >= 0 && words[run + 1]) return words[run + 1];
  if (words[0] === 'npx' && words[1]) return words[1];
  if (words[0] === 'node' && words[1]) return words[1].split('/').pop().replace(/\.[cm]?js$/, '');
  return words.slice(0, 2).join(' ');
}

const READ_ONLY_AGENTS = /^(?:explore|plan|claude-code-guide|statusline-setup)$/i;
const MCP_MUTATING = /__(?:create|update|delete|remove|publish|deploy|push|write|send|set|merge|upload|patch|put|post|add|rename|move|approve|promote|rollback|cancel|buy|store|edit|import|reset|stop|terminate|spawn|execute)[a-z_-]*$/i;

/**
 * The current turn of a Claude JSONL transcript: every main-thread record after the last genuine
 * user message, plus that message's text. Shared by claudeTurnEvents() and grounding-turn-evidence.mjs
 * so both gates agree on where a turn starts.
 */
export function currentTurnRecords(lines) {
  const recs = [];
  for (const l of lines || []) { try { const o = JSON.parse(l); if (!o?.isSidechain) recs.push(o); } catch { /* torn line */ } }
  let start = -1;
  recs.forEach((o, i) => {
    const c = o?.message?.content;
    const isToolResult = Array.isArray(c) && c.some((x) => x?.type === 'tool_result');
    if (o?.type === 'user' && (o.message?.role || 'user') === 'user' && !isToolResult && !o.isMeta && textOf(c).trim()) start = i;
  });
  return { boundaryFound: start >= 0, prompt: start >= 0 ? textOf(recs[start].message?.content) : '', recs: recs.slice(start + 1) };
}

// Native terminal flags are necessary but do not turn an empty, partial, or pending result into
// verification. Only known checker summaries are positive; unfamiliar output stays UNKNOWN.
// This is an observed check only; no returned PASS JSON establishes task acceptance.
function checkResult(result, metadata = {}) {
  const execution = normalizeToolOutcome({ ...metadata, ...result });
  const native = normalizeToolOutcome(metadata);
  const content = result.content;
  const output = [textOf(content), textOf(content?.content), metadata.stdout].filter(Boolean).join('\n');
  const body = output.replace(/\u001b\[[0-9;]*m/g, '').replace(/^(?:Exit code\s*:?\s*-?\d+|Process exited with code\s+-?\d+|Wall time:.*)\s*$/gim, '').trim();
  const positive = /^\s*(?:(?:Tests?|Test Files|Test Suites|Suites|Checks?)\s+[1-9]\d*\s+passed\b|(?:All\s+)?(?:tests?|checks?)\s+passed\b|PASS(?:\s|$)|#\s*pass\s+[1-9]\d*\s*$)/im.test(body);
  const failed = /^\s*(?:FAIL(?:ED)?|ERROR)(?:\s|:|$)|\b[1-9]\d*\s+failed\b|^#\s*fail\s+[1-9]\d*\s*$/im.test(body);
  const incomplete = /\b(?:output (?:is )?truncated|truncated output|no results(?: found)?|no tests? (?:found|ran)|Process running with session ID|Script running with cell ID|[1-9]\d*\s+(?:skipped|pending|todo))\b|^\s*(?:started\s+(?:verification|checks?|tests?)|(?:verification|checks?|tests?)\s+(?:started|queued|running))\b/im.test(body)
    || [result, content, metadata].some(value => value?.truncated === true
      || ['started', 'submitted'].includes(String(value?.status || value?.outcome || '').toLowerCase()));
  const error = failed || ['fail', 'interrupted'].includes(execution.outcome)
    || ['fail', 'interrupted'].includes(native.outcome);
  return { present: body.length > 0, error, successful: positive && !incomplete && !error
    && native.outcome !== 'pending' && execution.successfulToolResult === true,
    terminalOutcome: execution.outcome };
}

/** Ordered events for the current turn of a Claude JSONL transcript. */
export function claudeTurnEvents(lines) {
  const { boundaryFound, recs: turnRecs } = currentTurnRecords(lines);
  const results = new Map();
  for (const [index, o] of turnRecs.entries()) {
    const c = o?.message?.content;
    if (!Array.isArray(c)) continue;
    for (const r of c) {
      if (r?.type === 'tool_result' && r.tool_use_id) {
        results.set(r.tool_use_id, { ...checkResult(r, o.toolUseResult), resultIndex: index });
      }
    }
  }
  const events = [];
  for (const [index, o] of turnRecs.entries()) {
    const c = o?.message?.content;
    if (o?.type !== 'assistant' || !Array.isArray(c)) continue;
    for (const u of c) {
      if (u?.type !== 'tool_use') continue;
      const input = u.input || {};
      const observed = results.get(u.id);
      const result = observed?.resultIndex > index ? observed : { present: false, error: false, successful: false };
      if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(u.name)) {
        events.push({ kind: 'change', what: `${u.name} ${input.file_path || input.notebook_path || ''}`.trim() });
      } else if (u.name === 'Bash') {
        for (const seg of segments(input.command)) {
          if (segmentMutates(seg)) events.push({ kind: 'change', what: seg.slice(0, 120) });
          else if (segmentChecks(seg)) events.push({ kind: 'check', what: seg.slice(0, 120), name: checkName(seg), ...result });
        }
      } else if (u.name === 'Agent' || u.name === 'Task') {
        if (!READ_ONLY_AGENTS.test(String(input.subagent_type || ''))) events.push({ kind: 'change', what: `${u.name} ${input.subagent_type || 'agent'}` });
      } else if (String(u.name || '').startsWith('mcp__')) {
        events.push(MCP_MUTATING.test(u.name) ? { kind: 'change', what: u.name }
          : { kind: 'check', what: u.name, name: u.name.split('__').pop(), ...result });
      }
    }
  }
  return { boundaryFound, events };
}

/** Verification that ran AFTER the last state change this turn, with a present, non-error result. */
export function postChangeVerification(turn) {
  const events = turn?.boundaryFound === true ? turn.events || [] : [];
  let lastChange = -1;
  events.forEach((e, i) => { if (e.kind === 'change') lastChange = i; });
  const checks = events.slice(lastChange + 1).filter((e) => e.kind === 'check' && e.present && !e.error && e.successful === true);
  return { lastChange: lastChange >= 0 ? events[lastChange].what : null, checks,
    staleChecks: events.slice(0, Math.max(0, lastChange)).filter((e) => e.kind === 'check').length };
}

export function readClaudeTurn(transcriptPath, { read = readSettledTranscript } = {}) {
  if (typeof transcriptPath !== 'string' || !/\.jsonl$/i.test(transcriptPath)) return null;
  try { return claudeTurnEvents(read(transcriptPath, { maxMs: 0 })); } catch { return null; }
}

/**
 * The completion audit. `turn` is claudeTurnEvents() output, or null when the host transcript is
 * unavailable/unparsed (then the transcript half is UNKNOWN and says so).
 */
export function auditCompletionClaims(message, { turn = null, host = 'claude' } = {}) {
  const claims = extractCompletionClaims(message);
  if (!claims.length) return { verdict: 'NONE', claims };
  const text = String(message || '');
  const verification = turn ? postChangeVerification(turn) : null;
  const names = verification?.checks.map((c) => String(c.name || '').toLowerCase()).filter((n) => n.length >= 3) || [];
  const namesCheck = NAMED_CHECK.test(text) || names.some((n) => text.toLowerCase().includes(n));
  const disclosesGaps = DISCLOSES_GAPS.test(strippedProse(text).replace(/```[\s\S]*?```/g, ''))
    || DISCLOSES_GAPS.test(text);
  const problems = [];
  if (!turn) problems.push(`this host's (${host}) transcript is unavailable or not parsed, so whether a check ran after the change is UNKNOWN`);
  else if (!verification.checks.length) {
    problems.push(verification.lastChange
      ? `no end-to-end check ran this turn after the last change (${verification.lastChange})`
      : 'no end-to-end check ran this turn');
  }
  if (!namesCheck) problems.push('the answer does not name the check that proves it');
  if (!disclosesGaps) problems.push('the answer does not disclose what is NOT verified');
  const transcriptOk = turn ? verification.checks.length > 0 : false;
  const scopedCheck = claims.every(claim => /^(?:The\s+)?(?:targeted|selected|unit|syntax)\s+(?:unit\s+)?(?:checks?|tests?)\s+(?:is|are)\s+(?:now\s+)?(?:passing|green|verified)[.!]?$/i.test(claim.text));
  // A transcript command is an observed check, not proof of the owner's whole task.
  if (transcriptOk && namesCheck && disclosesGaps && !scopedCheck) problems.push('observed checks cover only their executed scope; whole-task completion is UNKNOWN');
  const verdict = transcriptOk && namesCheck && disclosesGaps && scopedCheck ? 'OBSERVED_CHECK'
    : namesCheck && disclosesGaps ? 'UNKNOWN' : 'FAIL';
  return { verdict, claims, verification, namesCheck, disclosesGaps, problems };
}

// ── promises (first-person commitments) ─────────────────────────────────────────────────────────
const PROMISE_LEAD = /\b(?:I(?:'ll|’ll|\s+will)|I(?:'m|’m|\s+am)\s+going\s+to|next,?\s+I(?:'ll|’ll|\s+will)|I\s+commit\s+to)\s+(?:now\s+|next\s+|then\s+|also\s+|immediately\s+|first\s+)*([a-z][^.!?\n]{6,158})/i;
const PROMISE_REJECT = /\?|:\*\*|\b(?:if|unless|once|when|whenever|as\s+soon\s+as|after|the\s+moment|until|whether|shortly|regularly|periodically|every\s+\d+|check\s+(?:back|again|on\s+it)|keep\s+(?:watching|an\s+eye)|maybe|might|could|would|probably|perhaps|possibly|option|alternatively|either|or\s+I\s+(?:can|could)|want\s+me|should\s+I|shall\s+I|let\s+you\s+know|wait|await|stand\s+by|hold\s+off|leave\s+(?:it|that|this)\s+to\s+you|happy\s+to|glad\s+to|be\s+honest|note\s+that|keep\s+(?:that|this)\s+in\s+mind|try\s+to|need\s+your|your\s+(?:approval|go-ahead|call|decision|confirmation))\b/i;
const TRIVIAL_PROMISE = /^(?:not|never|be|say|mention|note|admit|point|flag|stop|stay|leave|keep|summari[sz]e|explain|answer|respond|reply|report|remember|give|tell|send|paste|bring|hand|show|walk|notify|post|update\s+you|come\s+back|get\s+back|handle|only|stand|work)\b/i;
const OWNER_DEPENDENT_OFFER = /\b(?:say\s+the\s+word|(?:just|simply)\s+(?:ask|say)|ask\s+me|let\s+me\s+know|give\s+me\s+the\s+(?:word|go|nod|ok)|on\s+your\s+(?:word|go|ok|say)|up\s+to\s+you)\b/i;
const STANDING_APPROVAL = /^(?:ask|confirm|check\s+with\s+you|clear\s+(?:it|this|that)\s+with\s+you|run\s+.+\s+by\s+you)\b.*\b(?:before|first)\b/i;

export const normalizePromise = (value) => String(value || '').toLowerCase().replace(/[`*_"“”'’]/g, '')
  .replace(/[^a-z0-9./:+-]+/g, ' ').trim().slice(0, 160);

/** Non-hedged, present-session, first-person commitments in the FINAL answer. */
export function extractCommitments(message) {
  const out = [];
  const seen = new Set();
  const lines = strippedProse(message).split('\n');
  let inPlan = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^(?:[-*•]\s*|#+\s*|\*\*)*my\s+plan\b.{0,20}[:—–]\s*$/i.test(line)) { inPlan = true; continue; }
    const item = inPlan ? /^(?:\d+[.)]|[-*•])\s+(.{6,160})$/.exec(line) : null;
    if (inPlan && !item && line) inPlan = false;
    const candidates = item ? [item[1]] : sentences(line).map((s) => PROMISE_LEAD.exec(s)?.[1]).filter(Boolean);
    const whole = item ? item[1] : line;
    for (const action of candidates) {
      if (PROMISE_REJECT.test(whole) || OWNER_DEPENDENT_OFFER.test(whole)
        || STANDING_APPROVAL.test(action.trim()) || TRIVIAL_PROMISE.test(action.trim())) continue;
      const text = action.replace(/\s+/g, ' ').trim().replace(/[,;:]$/, '');
      const key = normalizePromise(text);
      if (key.length < 6 || seen.has(key)) continue;
      seen.add(key);
      out.push({ text, key });
    }
  }
  return out.slice(0, PROMISE_CAP_PER_TURN);
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'it', 'is', 'are',
  'this', 'that', 'now', 'next', 'then', 'will', 'be', 'i', 'we', 'all', 'so', 'as', 'at', 'by', 'from']);
const tokens = (value) => normalizePromise(value).split(' ').filter((t) => t.length > 2 && !STOP.has(t));

/** A passing completion claim closes a promise only when it names the same work. */
export function claimClosesPromise(claimText, promiseText) {
  const want = tokens(promiseText);
  if (!want.length) return false;
  const have = new Set(tokens(claimText));
  const hit = want.filter((t) => have.has(t)).length;
  return hit >= 2 && hit / want.length >= 0.4;
}
