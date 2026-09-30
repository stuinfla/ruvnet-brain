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
 *   A positive completion assertion ("fixed", "done", "shipped", "it will now…") PASSES only when
 *   (1) at least one verification command EXECUTED after the last state-changing action, with its
 *       result present and not an error, AND
 *   (2) the answer names the check (a "Verified:"-style line, or the executed command's own name), AND
 *   (3) the answer discloses what is NOT verified.
 *   Anything else is one correction request. No claim recognised → no verdict about the prose.
 *
 * HOSTS. Claude Code transcripts (`transcript_path`, JSONL) are parsed. Codex's Stop payload also
 * carries `transcript_path`, but its rollout format is NOT parsed anywhere in this repository
 * (project-progression-sources.mjs and turn-outcome-capture.mjs both decline it), so on Codex the
 * transcript half is UNKNOWN and only the answer-side half (2)+(3) is enforced — disclosed in the
 * correction text, never silently treated as proven.
 */
import { readSettledTranscript } from './turn-outcome-capture.mjs';

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
const NOT_A_CLAIM = /\b(?:not|never|no|nothing|none|cannot|can't|won't|isn't|aren't|wasn't|weren't|hasn't|haven't|didn't|doesn't|don't|without|unverified|untested|unproven|unknown|yet|if|unless|until|once|when|whether|should|would|could|might|may|maybe|probably|likely|expected|supposed|hopefully|assuming|pending|remaining|remains|todo|tbd|before|after|previously|earlier|already|yesterday|ago|last\s+(?:week|night|time|session|release)|claimed|claims|said|says|reported|told|neither|nor|as\s+soon\s+as|tell\s+me|I(?:'ll|’ll)|we(?:'ll|’ll)|will\s+(?!now\b)|(?:was|were)\s+working|damage\s+is\s+done)\b|\?/i;
const CLAIM_PATTERNS = [
  // "X is fixed", "the gate is now live", "tests are passing", "it's done"
  /\b(?:is|are|was|were|has\s+been|have\s+been|(?:it|that|this|what|everything|there)(?:'s|’s)|now)\s+(?:all\s+|fully\s+|now\s+|finally\s+|successfully\s+|actually\s+)*(?:fixed|done|complete|completed|resolved|shipped|deployed|live(?!\s+(?:in|inside|under|with|alongside))|implemented|landed|published|merged|released|verified|green|passing|operational|in\s+place|wired(?:\s+up)?|working(?!\s+(?:on|with|through|in|as|tree|copy|dir)))\b/i,
  // "I fixed", "I've shipped", "we deployed"
  /\b(?:I|we)(?:'ve|’ve|\s+have)?\s+(?:now\s+|just\s+|successfully\s+|also\s+|fully\s+)*(?:fixed|shipped|deployed|resolved|completed|implemented|landed|published|released|verified|finished|wired\s+up)\b/i,
  // "Done." "Fixed:" "Shipped —" "✅ Deployed" at the start of a line
  /^(?:[-*•]\s*|#+\s*|\*\*|✅\s*)*(?:done|fixed|shipped|deployed|resolved|complete|completed|implemented|all\s+done|all\s+set|all\s+green)\b\s*(?:[.!:—–-]|\*\*|$)/i,
  // "now works", "it will now block …", "works end to end"
  /\b(?:now\s+works|works\s+now|works\s+end[- ]to[- ]end|will\s+now\s+(?:work|fire|block|catch|run|stay|refuse|correct|speak|pass|succeed))\b/i,
];

/** Positive completion assertions, in message order. Deterministic; no model call. */
export function extractCompletionClaims(message) {
  const out = [];
  for (const sentence of sentences(message)) {
    if (NOT_A_CLAIM.test(sentence)) continue;
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
const segmentChecks = (segment) => !TRIVIAL.test(segment) && !segmentMutates(segment);
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

/** Ordered events for the current turn of a Claude JSONL transcript. */
export function claudeTurnEvents(lines) {
  const { boundaryFound, recs: turnRecs } = currentTurnRecords(lines);
  const results = new Map();
  for (const o of turnRecs) {
    const c = o?.message?.content;
    if (!Array.isArray(c)) continue;
    for (const r of c) {
      if (r?.type === 'tool_result' && r.tool_use_id) {
        results.set(r.tool_use_id, { error: r.is_error === true || o.toolUseResult?.interrupted === true,
          present: textOf(r.content).trim().length > 0 || String(o.toolUseResult?.stdout || '').trim().length > 0 });
      }
    }
  }
  const events = [];
  for (const o of turnRecs) {
    const c = o?.message?.content;
    if (o?.type !== 'assistant' || !Array.isArray(c)) continue;
    for (const u of c) {
      if (u?.type !== 'tool_use') continue;
      const input = u.input || {};
      const result = results.get(u.id) || { present: false, error: false };
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
  const events = turn?.events || [];
  let lastChange = -1;
  events.forEach((e, i) => { if (e.kind === 'change') lastChange = i; });
  const checks = events.slice(lastChange + 1).filter((e) => e.kind === 'check' && e.present && !e.error);
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
  const verdict = transcriptOk && namesCheck && disclosesGaps ? 'PASS' : !turn && namesCheck && disclosesGaps ? 'UNKNOWN' : 'FAIL';
  return { verdict, claims, verification, namesCheck, disclosesGaps, problems };
}

// ── promises (first-person commitments) ─────────────────────────────────────────────────────────
const PROMISE_LEAD = /\b(?:I(?:'ll|’ll|\s+will)|I(?:'m|’m|\s+am)\s+going\s+to|next,?\s+I(?:'ll|’ll|\s+will)|I\s+commit\s+to)\s+(?:now\s+|next\s+|then\s+|also\s+|immediately\s+|first\s+)*([a-z][^.!?\n]{6,158})/i;
const PROMISE_REJECT = /\?|:\*\*|\b(?:if|unless|once|when|whenever|as\s+soon\s+as|after|the\s+moment|until|whether|shortly|regularly|periodically|every\s+\d+|check\s+(?:back|again|on\s+it)|keep\s+(?:watching|an\s+eye)|maybe|might|could|would|probably|perhaps|possibly|option|alternatively|either|or\s+I\s+(?:can|could)|want\s+me|should\s+I|shall\s+I|let\s+you\s+know|wait|await|stand\s+by|hold\s+off|leave\s+(?:it|that|this)\s+to\s+you|happy\s+to|glad\s+to|be\s+honest|note\s+that|keep\s+(?:that|this)\s+in\s+mind|try\s+to|need\s+your|your\s+(?:approval|go-ahead|call|decision|confirmation))\b/i;
const TRIVIAL_PROMISE = /^(?:not|never|be|say|mention|note|admit|point|flag|stop|stay|leave|keep|summari[sz]e|explain|answer|respond|reply|report|remember|give|tell|send|paste|bring|hand|show|walk|notify|post|update\s+you|come\s+back|get\s+back|handle|only|stand|work)\b/i;

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
      if (PROMISE_REJECT.test(whole) || TRIVIAL_PROMISE.test(action.trim())) continue;
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
