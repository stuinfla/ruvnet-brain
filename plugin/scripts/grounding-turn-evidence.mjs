/**
 * grounding-turn-evidence.mjs — the pure half of ADR-0030 decision-point gate #1: "before asserting
 * what a tool or platform can or cannot do, did you CHECK a relevant source this turn, or are you
 * recalling?" Plus gates #2 (architecture needs >= 3 options) and #3 (relayed numbers need a
 * re-check), which run in SHADOW mode only: they are measured and logged, never delivered.
 *
 * WHY (owner, 2026-09-30): "a nudge without enforcement is worthless." The concrete incident: an
 * answer asserted "No hook can change the model of the current turn" from a WebFetch page summary
 * written by a small model, and a design was built on it. The existing grounding-turn-gate only
 * checked that SOME search_ruvnet stamp was newer than the turn marker — presence, not relevance or
 * order — armed only on rUv-stack prompts, and could not see WebFetch at all.
 *
 * DESIGN, deterministic and local (rUv ADR-G004 rejects LLM gate evaluation; no model is called):
 *   1. UserPromptSubmit (grounding-turn-mark.mjs) arms the turn only when the prompt ASKS for a
 *      capability / feasibility / architecture judgement AND names a subject (classifyPrompt). The
 *      caller replayed a naive output-only regex at 13.5% of turns and an order-aware one at 0.93%,
 *      mostly on harmless hedges; arming at prompt time is what keeps unarmed turns out of scope.
 *   2. The sources read this turn come from the host transcript (turnSources) — the ordered,
 *      complete record of every tool call and its result, including search_ruvnet's returned paths.
 *      A WebFetch body is a small model's summary of the page, so it is WEAK evidence; so is a
 *      subagent's relayed report and a WebSearch snippet list.
 *   3. At Stop, each capability claim in the final answer (capability-claim-evidence.mjs's own
 *      extractor, widened with this turn's vocabulary) needs one STRONG source whose path, URL,
 *      command or query names the claim's subject and that was read AFTER the last weak source about
 *      that subject (auditAssertions). Otherwise: one correction.
 *
 * Claims continuation-gate.mjs already audits (the RUVNET_TOOL behaviour class) are skipped here —
 * one correction per claim, never two gates arguing over the same sentence.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUVNET_GATE1_TERMS } from './ruvnet-gate1-pattern.mjs';
import { brainAnsweredResponse } from './grounding-answer.mjs';
import { extractClaims } from './capability-claim-evidence.mjs';
import { currentTurnRecords, strippedProse } from './completion-claim-evidence.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

// ── vocabulary ─────────────────────────────────────────────────────────────────────────────────────
/** Platform nouns a capability question is usually about, beyond the product names. */
const PLATFORM_NOUNS = ['hook', 'hooks', 'mcp', 'plugin', 'plugins', 'skill', 'skills', 'subagent', 'subagents',
  'codex', 'claude code', 'cli', 'sdk', 'api', 'npm', 'github actions', 'workflow', 'launchd', 'cron',
  'vercel', 'webfetch', 'websearch', 'hnsw', 'onnx', 'sqlite', 'rvf', 'metaharness', 'ruvllm', 'ruview',
  'agentdb', 'ruflo', 'ruvector', 'aidefence', 'agentic-flow', 'agentic-qe', 'claude flow', 'agent browser'];
const WEAK_WORDS = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'brain', 'repo', 'store', 'docs', 'data',
  'test', 'tests', 'main', 'core', 'app', 'web', 'site', 'code', 'tool', 'tools', 'model', 'models', 'agent',
  'agents', 'file', 'files', 'flow', 'swarm', 'ruv', 'sparc', 'qe']);

const brainHome = (env) => env.RUVNET_BRAIN_HOME || path.join(env.HOME || env.USERPROFILE || os.homedir(), '.cache', 'ruvnet-brain');

/** Subject phrases: Gate-1 terms, platform nouns, repo aliases and installed store names. Never throws. */
export function loadVocabulary({ env = process.env } = {}) {
  const out = new Set([...RUVNET_GATE1_TERMS, ...PLATFORM_NOUNS]);
  const kbDirs = [env.RUVNET_KB_DIR, path.join(brainHome(env), 'kb'), path.join(SCRIPTS_DIR, '..', '..', 'kb')].filter(Boolean);
  for (const dir of kbDirs) {
    try {
      const aliases = JSON.parse(fs.readFileSync(path.join(dir, 'repo-aliases.json'), 'utf8'));
      for (const [repo, list] of Object.entries(aliases || {})) { out.add(repo); for (const a of list || []) out.add(a); }
    } catch { /* absent in this location */ }
    try {
      // Installed store names — but a plain single word ("support", "concepts", "marketing") is an
      // English word far more often than a product; measured, it produced "doesn't support" claims.
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.meta.json') || name.startsWith('._')) continue; // ._: AppleDouble, not a store
        const store = name.slice(0, -'.meta.json'.length);
        if (/[-_.0-9]/.test(store) || /^(?:ru|rv|agentic|cognitum)/i.test(store)) out.add(store);
      }
    } catch { /* absent in this location */ }
  }
  return [...out].map((v) => String(v).toLowerCase().trim())
    .filter((v) => v.length >= 3 && !WEAK_WORDS.has(v) && /[a-z]/.test(v));
}

// ── tokens ─────────────────────────────────────────────────────────────────────────────────────────
const singular = (t) => (t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t);
/** Lowercased word tokens: each hyphen/dot/underscore compound (separators normalised to '-') and its
 *  parts, singularised — so `code.claude.com/docs/en/hooks` yields claude, code, hook, … */
export function tokenSet(text) {
  const set = new Set();
  const raw = String(text || '');
  const s = `${raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2')} ${raw}`.toLowerCase();
  for (const compound of s.match(/[a-z0-9]+(?:[-_.][a-z0-9]+)*/g) || []) {
    const parts = compound.split(/[-_.]/).filter(Boolean);
    set.add(singular(parts.join('-')));
    for (const part of parts) set.add(singular(part));
  }
  return set;
}
/** A subject phrase's words; a source binds the subject only when it names every one of them. */
const subjectWords = (subject) => String(subject || '').toLowerCase().split(/\s+/)
  .map((w) => singular(w.split(/[-_.]/).filter(Boolean).join('-'))).filter((w) => w.length >= 2);

// ── prompt-time classification (UserPromptSubmit) ─────────────────────────────────────────────────
const CAPABILITY_ASK = new RegExp([
  String.raw`\b(?:can|could|does|do|is|are|will|would)\s+(?:it|we|you|i|there|(?:a|an|the|any|this|that|my|our)\s+[\w-]+|[\w-]+)\s+(?:[\w-]+\s+){0,3}?(?:do|support|handle|work|run|use|call|change|switch|make|force|read|write|access|detect|block|enforce|intercept|see|know|override|rewrite|route|pick|select|stop|prevent|allow|expose|return|send|trigger|fire)\b`,
  String.raw`\bis\s+(?:it|there)\s+(?:possible|a\s+way|any\s+way)\b`, String.raw`\bpossible\s+to\b`, String.raw`\bable\s+to\b`,
  String.raw`\bcapab(?:le|ility|ilities)\b`, String.raw`\bfeasib(?:le|ility)\b`, String.raw`\blimitations?\b`,
  String.raw`\bwhat\s+(?:can|does|do)\b`, String.raw`\bhow\s+(?:does|do|can|could|would|should)\b`,
  String.raw`\bwhether\b`, String.raw`\bsupports?\b`,
].join('|'), 'i');
const ARCHITECTURE_ASK = /\barchitect(?:ure|ural)?\b|\bdesign\b|\bapproach(?:es)?\b|\bbest\s+way\b|\bshould\s+(?:we|i)\s+(?:use|build|go|pick|choose)\b|\brecommend|\bwhich\s+(?:tool|library|option|approach)\b|\btrade-?offs?\b|\bfigure\s+out\s+(?:the\s+)?(?:best|how)\b/i;
const CODE_ISH = /`([^`\n]{2,60})`|\b([A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)+|[a-z]+[A-Z][A-Za-z0-9]+|[A-Z][a-z]+[A-Z][A-Za-z0-9]*)\b/g;

/** Vocabulary phrases and code-ish identifiers the text names. */
export function subjectsIn(text, vocab) {
  const s = String(text || '');
  const lower = s.toLowerCase();
  const found = new Set();
  for (const v of vocab) {
    const re = new RegExp(`(?<![a-z0-9-])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9-])`, 'i');
    if (lower.includes(v) && re.test(s)) found.add(v);
  }
  for (const m of s.replace(/<\/?[A-Za-z_][\w-]*[^>]*>/g, ' ').matchAll(CODE_ISH)) {
    const t = (m[1] || m[2] || '').trim();
    if (t.length >= 4 && t.length <= 60 && !/^\d|\.(?:md|json|txt|png|jpg)$|^https?:|^e\.g\.?$|^i\.e\.?$/i.test(t) && !/\s/.test(t)) found.add(t.toLowerCase());
    if (found.size >= 24) break;
  }
  return [...found].slice(0, 24);
}

/** Arm the turn when the prompt asks a capability/feasibility/architecture question about a subject. */
export function classifyPrompt(text, vocab) {
  const t = String(text || '');
  const subjects = subjectsIn(t, vocab);
  const architecture = ARCHITECTURE_ASK.test(t) && subjects.length > 0;
  const capability = CAPABILITY_ASK.test(t) && subjects.length > 0;
  return { assert: capability || architecture, architecture, subjects };
}

// ── the turn's sources (Stop, from the host transcript) ───────────────────────────────────────────
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c)
  ? c.map((x) => (typeof x === 'string' ? x : x?.type === 'text' ? x.text : '')).join('\n') : '');
const NOT_A_SOURCE = /^(?:Edit|Write|MultiEdit|NotebookEdit|TodoWrite|ToolSearch|AskUserQuestion|ExitPlanMode|SendMessage|TaskStop|Monitor|Skill|Artifact.*|EnterWorktree|ExitWorktree)$/;
const MCP_MUTATING = /__(?:create|update|delete|remove|publish|deploy|push|write|send|set|merge|upload|patch|put|post|add|rename|move|approve|promote|rollback|cancel|buy|store|edit|import|reset|stop|terminate|spawn|execute)[a-z_-]*$/i;

/**
 * Did the brain actually answer? The ONE predicate (grounding-answer.mjs), shared with
 * grounding-stamp.sh: the ANSWER TEXT (never the echoed retrieval.query) must begin with the brain's
 * own header — heavy-lane banner, fast-lane card, optionally after the degraded paragraph — or the
 * response is the host's oversize notice for its own saved file. `notAfterMs`: the transcript time of
 * this tool result; a saved file modified later is not the tool's output.
 */
export function brainAnswered(r, { home = os.homedir(), notAfterMs = null } = {}) {
  return brainAnsweredResponse(r, { home, notAfterMs });
}

export function sourceOf(name, input = {}, result = '', { resultAtMs = null } = {}) {
  const n = String(name || '');
  const r = String(result || '');
  if (/(?:^|__)search_ruvnet$/.test(n)) {
    const ok = brainAnswered(r, { notAfterMs: resultAtMs == null ? null : resultAtMs + 5000 });
    const paths = [...r.matchAll(/^path : (\S+)/gm)].map((m) => m[1]).slice(0, 20);
    return { kind: 'search_ruvnet', ref: String(input.query || ''), strength: ok ? 'strong' : 'failed', ok, text: [input.query, ...paths].join(' ') };
  }
  if (n === 'WebFetch') return { kind: 'WebFetch', ref: String(input.url || ''), strength: 'weak', why: 'summarised-by-small-model', text: String(input.url || '') };
  if (n === 'WebSearch') {
    const urls = [...r.matchAll(/https?:\/\/[^\s)"'\]]+/g)].map((m) => m[0]).slice(0, 10);
    return { kind: 'WebSearch', ref: String(input.query || ''), strength: 'weak', why: 'search-snippets', text: [input.query, ...urls].join(' ') };
  }
  if (n === 'Agent' || n === 'Task') {
    return { kind: n, ref: String(input.description || input.subagent_type || ''), strength: 'weak', why: 'relayed-by-subagent',
      text: `${input.description || ''} ${String(input.prompt || '').slice(0, 400)}`, result: r.slice(0, 20000) };
  }
  if (n === 'Read' || n === 'NotebookRead') return { kind: 'Read', ref: String(input.file_path || input.notebook_path || ''), strength: 'strong', text: String(input.file_path || input.notebook_path || ''), result: r.slice(0, 20000) };
  if (n === 'Grep' || n === 'Glob') {
    const ref = [input.pattern, input.path, input.glob].filter(Boolean).join(' ');
    return { kind: n, ref, strength: 'strong', text: ref, result: r.slice(0, 20000) };
  }
  if (n === 'Bash') return { kind: 'Bash', ref: String(input.description || input.command || '').slice(0, 120), strength: 'strong', text: String(input.command || '').slice(0, 2000), result: r.slice(0, 20000) };
  if (n.startsWith('mcp__') && !MCP_MUTATING.test(n)) {
    return { kind: 'mcp', ref: n.split('__').pop(), strength: 'strong', text: `${n} ${JSON.stringify(input).slice(0, 1000)}`, result: r.slice(0, 20000) };
  }
  if (NOT_A_SOURCE.test(n)) return null;
  return null;
}

/** Every source read this turn, in order, from a Claude JSONL transcript's lines. */
export function turnSources(lines) {
  const { boundaryFound, prompt, recs } = currentTurnRecords(lines);
  const results = new Map();
  for (const o of recs) {
    const c = o?.message?.content;
    const at = Date.parse(o?.timestamp || '');
    if (Array.isArray(c)) for (const r of c) if (r?.type === 'tool_result' && r.tool_use_id) results.set(r.tool_use_id, { text: textOf(r.content), at: Number.isFinite(at) ? at : null });
  }
  const sources = [];
  for (const o of recs) {
    const c = o?.message?.content;
    if (o?.type !== 'assistant' || !Array.isArray(c)) continue;
    for (const u of c) {
      if (u?.type !== 'tool_use') continue;
      const res = results.get(u.id) || { text: '', at: null };
      const s = sourceOf(u.name, u.input || {}, res.text, { resultAtMs: res.at });
      if (s) sources.push({ ...s, order: sources.length });
    }
  }
  return { boundaryFound, prompt, sources };
}

/** Did a search_ruvnet call this turn return a real grounded answer? (Gate 1, from the transcript.) */
export const searchedThisTurn = (sources) => sources.some((s) => s.kind === 'search_ruvnet' && s.ok);

// ── does the ANSWER assert a rUv capability? (Gate 1's trigger at Stop, 4.4.0) ───────────────────
// THE FALSE ALARM (measured 2026-09-30 on this repo's own transcripts): Gate 1 arms on any prompt
// matching RUVNET_GATE1_PATTERN, and in this repository nearly every prompt does (`ruvnet-brain`,
// "rUv", "swarm"). Of 183 real deliveries of "no successful search_ruvnet call", 172 were on turns
// whose answer asserted nothing about a rUv tool — release status, git/CI checks, disk and backup
// answers, memory writes. The directive is "search BEFORE asserting what a RuvNet tool can/cannot do",
// so the Stop check now demands a search only when the final answer actually asserts that.
// Deterministic, local (ADR-G004: no model evaluates a gate). Subjects are rUv PRODUCTS (grounded in
// ruvector ADR-029 and ruflo docs/index.md); `RuvNet Brain` / `ruvnet-brain` is THIS product and is
// grounded by reading this repo, never by search_ruvnet.
const RUV_PRODUCT = String.raw`(?:@(?:ruvector|claude-flow|metaharness|ruvnet)\/[a-z0-9-]+|ruflo|ruvector(?:-core)?|rvf(?:-[a-z]+)?|agentdb|agenticow|rulake|ruview|rupixel|ruv-fann|agentic[- ]flow|agentic[- ]qe|synthlang|qudag|safla|metaharness|cve-bench|claude[- ]flow|ruv-swarm|aidefence|aimds|ruvllm|sona|agent[- ]booster|rvlite|ospipe|reasoningbank|flow-nexus|ruvnet(?!\s+brain)|r[uU]v)`;
// "rUv's/Ruflo's (own) <up to 3 words>" or the bare product, never inside a path, filename or a
// longer identifier (`ruvnet-brain`, `ruflo-core.mjs`, `kb/ruvector`).
const RUV_SUBJECT = String.raw`(?<![\w/.@-])${RUV_PRODUCT}(?![\w-]|[./][\w])(?:(?:'|’)s)?(?:\s+own)?(?:\s+(?!(?:can|does|is|are|has|have|the|a|an|and|or|but|to|of|for|with|by|in|on|at|from|if|when|after|before|that|this|these|those|which|who|two|three|it|they|we|you|i)\b)[\w.@/-]+){0,4}?`;
// Third-person verbs only: a CLI noun phrase (`ruflo memory store`, `ruvector search`) must never read
// as subject + verb. Base forms ("turn", "ship", "store") count only right after a plural product noun
// ("rUv's tools turn …") — a lookbehind, so a rejected noun never consumes the real verb after it.
// Not \b at the end: `support-ticket` is no verb.
const PLURAL_NOUN = 'tools|packages|crates|plugins|libraries|hooks|agents|skills|servers|workers|daemons|commands|apis|clis|sdks|bindings|routers|gates|controllers';
const VERBS = 'support|provide|expose|ship|offer|export|implement|include|allow|enable|accept|return|store|require|need|handle|route|record|persist|index|cache|spawn|create|generate|compute|sort|classif|scan|detect|block|prevent|replace|wrap|call|launch|keep|clamp|turn|give|make|run|use|take|let|write|default';
// "will not" is a capability claim only with a capability verb: "AgentDB will not open X" is, while
// "Ruflo will not be touched by this patch" / "will not need a rebuild" report OUR change (4.4.0 nit).
const WILL_NOT_VERBS = 'run|work|support|open|load|accept|start|install|handle|read|write|store|return|expose|allow|connect|recogni[sz]e|parse|build|compile|sync|scale|persist|import|export';
// "now" makes a recency claim only with a capability verb ("Ruflo now supports X"); "AgentDB now records
// every turn" describes behaviour this repo just wired, and is not a claim about the product.
const NOW_VERBS = /\bnow\s+(?:supports|ships|works|exposes|provides|includes|offers|accepts|allows|enables|runs|requires|has|handles|can(?:not|'t|’t)?|does(?:n't|n’t|\s+not)?)\b/i;
const CAPABILITY_VERB = String.raw`(?:(?:won't|won’t|will\s+not)\s+(?:${WILL_NOT_VERBS})\b|can(?:not|'t|’t)?\s+\w+|does(?:n't|n’t|\s+not)\s+\w+|do(?:n't|n’t|\s+not)\s+\w+|has(?:n't|n’t|\s+not)\s+\w+|has\s+(?:a|an|no|its|built-in|native)\b|(?:is|are)\s+(?:able|unable|capable|designed|built|meant|backed|limited|not\s+(?:able|available|supported))\b|only\s+(?:supports?|works|runs|accepts)|comes\s+with|works\s+(?:with|by|on|only)|(?:${VERBS})(?:e?s|ies)|(?<=\b(?:${PLURAL_NOUN})\s+)(?:${VERBS}))(?![\w-])`;
// What rUv's own docs/research/source SAY is a capability claim too, in any tense.
const DOC_VERB = String.raw`(?:says?|said|found|finds|shows?|showed|marks?|marked|documents?|documented|recommends?|prescribes?|states?|reports?|measured|took|warns?)\b`;
const DOC_NOUN = String.raw`(?:research|benchmark|readme|docs?|documentation|release\s+notes|notes|code|source|adr|guidance|skill|campaign|issue|gist)`;
const RUV_CLAIM = new RegExp(`(${RUV_SUBJECT})\\s+(?:\\([^)]{0,80}\\)\\s+)?(?:now\\s+|also\\s+|already\\s+|actually\\s+|really\\s+|still\\s+|always\\s+|never\\s+|only\\s+)?${CAPABILITY_VERB}`, 'gi');
const RUV_DOC_CLAIM = new RegExp(`(?<![\\w/.@-])${RUV_PRODUCT}(?:(?:'|’)s)?(?:\\s+own)?(?:\\s+[\\w.@/-]+){0,3}?\\s+${DOC_NOUN}\\b[^.;]{0,40}?\\b${DOC_VERB}`, 'gi');
// "Ruflo is the orchestration layer and it has no hooks API": the pronoun refers back, in the same
// sentence — only to a product that OPENS the sentence as its subject (a product inside a list or a
// parenthetical is not what "they" means: "N-API builds (ruvector, rvf, …), so they don't depend…").
// The opening subject phrase of a sentence: "The RuVector router package (`ruvector-router`)",
// "RuVector's router", "Ruflo". Words stop at a copula; a parenthetical right after it is allowed.
// OUR change to a product ("the ruflo upgrade", "the AgentDB write", "the ruflo fix") is not the product.
const CHANGE_NOUN = 'upgrade|update|fix|change|patch|install|installation|write|read|call|run|release|build|migration|restart|bump|version|commit|test|tests|check|ci|job|workflow|step|lock|config|setting|settings|issue|bug|error|failure|outage|incident|pr|branch|diff|rollout|deploy|deployment';
const OPENING_SUBJECT = String.raw`^(?:the\s+)?(${RUV_PRODUCT})(?![\w-]|[./][\w])(?:(?:'|’)s)?(?:\s+(?!(?:is|are|was|were|has|and|or|but|it|they|${CHANGE_NOUN})\b)[\w.@/-]+){0,4}?\s+(?:\([^)]{0,80}\)\s+)?`;
const RUV_COREF_CLAIM = new RegExp(`${OPENING_SUBJECT}(?:(?:is|are)\\s+(?:a|an|the)\\b|has\\b|provides?\\b|ships?\\b|${CAPABILITY_VERB})[^.;!?]{0,200}?\\b(?:and|but|so|which|because)\\s+(?:it|they)\\s+(?:also\\s+|now\\s+|still\\s+|only\\s+)?${CAPABILITY_VERB}`, 'gi');
// A DEFINITION is a capability claim too: "The RuVector router package (…) is a vector database …"
// asserts what the product is and does (4.4.1, a live miss). Only as the sentence's opening subject,
// and only "is a/an": "your ruflo is a version behind" (a status) does not open the sentence.
const RUV_DEFINE_CLAIM = new RegExp(`${OPENING_SUBJECT}(?:is|are)\\s+(?:a|an)\\s+(?!(?:version|bit|few|lot|little|couple|day|week|month|commit|no-op|success|failure|regression|bug|fix|one-line|change|problem|mistake|non-issue|win|loss)s?\\b)\\w`, 'gi');
// "this is agentic-qe's own static/heuristic estimate": a copula naming what the PRODUCT's output is.
const RUV_COPULA_OWN_CLAIM = new RegExp(`\\b(?:this|that|it)\\s+is\\s+(${RUV_PRODUCT})(?![\\w-]|[./][\\w])(?:'|’)s\\s+own\\s+(?!(?:ci|tests?|build|pipeline|run|job|workflow|checks?|bug|failure|issue|repo|release|fault|problem|mistake|error)\\b)[\\w/-]+`, 'gi');
// "is confirmed honored by the installed ruflo": the product as the passive AGENT of a behaviour.
const RUV_PASSIVE_CLAIM = new RegExp(`\\b(?:is|are)\\s+(?:\\w+\\s+){0,2}?(?:honou?red|supported|handled|enforced|rejected|ignored|accepted|respected|read|parsed)\\s+by\\s+(?:the\\s+)?(?:installed\\s+|global\\s+|current\\s+)?(${RUV_PRODUCT})(?![\\w-]|[./][\\w])`, 'gi');
// Not an assertion: a question, a hedge, a plan or hypothetical. Narrower than HEDGE above on purpose,
// and narrower still since the 4.4.0 review (S2): "now", "if" and "will not" no longer silence a whole
// sentence — "Ruflo now supports Windows natively", "RuVector cannot run on Windows, so if you need it
// use WSL" and "X will not run on Y" are claims. They are judged per claim in isAssertion instead.
const NOT_RUV_ASSERTION = /\?|\b(?:might|may|maybe|perhaps|probably|possibly|potentially|likely|unlikely|apparently|seems?|i\s+think|i\s+believe|i\s+suspect|not\s+sure|unsure|unverified|unconfirmed|not\s+verified|would|could|should|i(?:'ll|’ll)|we(?:'ll|’ll)|will(?!\s+not\b)|plan(?:ned)?\s+to|going\s+to|once)\b/i;
const FIRST_PERSON = /\b(?:I|we|me|my|our|us)\b/;

function isAssertion(s, m) {
  // "what rUv already ships" / "whether ruflo supports X" is a noun clause, not an assertion.
  if (/\b(?:what|whatever|whether)\b[^.,;:!?]{0,40}$/i.test(s.slice(0, m.index))) return false;
  // A condition in the claim's OWN clause makes it hypothetical ("Ruv can't use Brain if every update
  // breaks"); a condition in a later clause does not ("cannot run on Windows, so if you need it…").
  const start = Math.max(0, ...[...s.slice(0, m.index).matchAll(/[,;:—–]|\b(?:so|but)\b/g)].map((x) => x.index + x[0].length));
  const after = s.slice(m.index + m[0].length);
  const stop = after.search(/[,;:—–]|\b(?:so|but)\b/);
  if (/\b(?:if|unless)\b/i.test(s.slice(start, m.index + m[0].length + (stop < 0 ? after.length : stop)))) return false;
  // "now" is a recency claim about the product — unless it reports OUR change ("AgentDB now records
  // every turn … with no reliance on me remembering", a measured false alarm).
  if (/\bnow\b/i.test(s) && FIRST_PERSON.test(s)) return false;
  if (/\bnow\s+\w/i.test(m[0]) && !NOW_VERBS.test(m[0])) return false;
  // "returns 10 results", "takes about 3 s": a measurement this turn, not a capability.
  return !/^\s*(?:about\s+|around\s+|only\s+|~|≈)?\d/.test(s.slice(m.index + m[0].length));
}

// "## What AgentDB actually is" followed by "It's a SQLite database file …": the heading names the subject
// and the section's sentence-initial "It" refers to it (4.4.1, a measured known miss).
const DEFINING_HEADING = new RegExp(`^\\s*#{1,6}\\s+(?:what|how)\\s+(?:the\\s+)?(${RUV_PRODUCT})(?![\\w-])\\s+(?:(?:actually|really|even)\\s+)?(?:is|are|does|works?)\\b`, 'i');   // the product ITSELF, not "the ruflo fix"
function bindHeadingPronouns(message) {
  let subject = null;
  return String(message || '').split('\n').map((line) => {
    if (/^\s*#{1,6}\s/.test(line)) { subject = DEFINING_HEADING.exec(line)?.[1] ?? null; return line; }
    if (!subject) return line;
    return line.replace(/(^|[.!?]\s+)(?:\*\*)?It(?:'|’)s\b/g, `$1${subject} is`)
      .replace(/(^|[.!?]\s+)(?:\*\*)?It\s+(?=(?:is|has|does|can|stores|runs|uses|keeps)\b)/g, `$1${subject} `);
  }).join('\n');
}
// A table row whose FIRST cell is a product and whose other cells DESCRIBE it ("| AgentDB | Append-only
// audit trail | Concurrent-write safe KB |") asserts what the product is. Only descriptive cells count:
// letters only (no digits, hashes, dates or versions) and no status vocabulary — a status table about a
// product ("| ruflo | 3.41.2 | PASS |", "| ruflo | No version at all … |") never qualifies.
const STATUS_WORD = /\b(?:no|not|none|n\/a|missing|stale|behind|current|unverified|verified|pass(?:ed)?|fail(?:ed)?|yes|done|version|commit|ok|error|broken|pending|todo|skipped|live|shipped|absent|present|installed|upgraded|restarted|healthy|unhealthy|running|reachable|unreachable|updated|configured|enabled|disabled|failing|passing|green|red|removed|added|fixed|deployed|published|merged|stopped|started|restored|reset|rebuilt)\b/i;
// 4.5 — GENERALISED BEYOND THE WORD LIST. A list of status words always lags the next status cell
// ("Reinstalled from npm", "Deprecated in our stack", "Pinned to 0.3.1"). Two STRUCTURAL shapes mark a cell
// as a report on the product's state rather than a description of what it does, whatever the word:
//   · a version, date or commit hash anywhere in it;
//   · a leading participle (…ed/…en) that is the whole cell or is followed by a particle — "Rolled back",
//     "Migrated and verified", "Reinstalled from npm". A participle followed by a NOUN is an adjective in a
//     description ("Distributed consensus", "Embedded vector store") and still counts as a claim.
// Digits are otherwise allowed, so "| agentdb | Ships a built-in BM25 index |" is read as the claim it is.
const STATE_PARTICLE = /^(?:from|in|to|on|at|by|back|out|up|down|off|over|via|for|with|and|again|globally|locally|successfully|cleanly|manually|automatically|today|yesterday|now|earlier|already|here|there)$/i;
function isStatusCell(cell) {
  if (STATUS_WORD.test(cell)) return true;
  if (/\bv?\d+\.\d+(?:\.\d+)?\b|\b\d{4}-\d{2}-\d{2}\b|\b[0-9a-f]{7,40}\b/i.test(cell)) return true;
  const [w1, w2] = cell.split(/\s+/);
  return /^[A-Za-z]{3,}(?:ed|en)$/i.test(w1) && (!w2 || STATE_PARTICLE.test(w2));
}
function productRowClaims(message) {
  const claims = [];
  for (const line of String(message || '').split('\n')) {
    if (!/^\s*\|/.test(line) || /^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.replace(/\*\*|__|`/g, '').trim());
    const first = new RegExp(`^(${RUV_PRODUCT})$`, 'i').exec(cells[0] || '');
    if (!first || cells.length < 2) continue;
    const described = cells.slice(1).filter((c) => /^[A-Za-z][A-Za-z0-9 +/.-]{3,80}$/.test(c) && c.split(/\s+/).length >= 2 && !isStatusCell(c));
    if (described.length === cells.length - 1) claims.push({ text: line.trim(), match: `${first[1]} | ${described[0]}`, subject: first[1].toLowerCase() });
  }
  return claims;
}

/** The final answer's sentences (and table cells) that assert what a rUv product does. Never throws. */
export function ruvCapabilityClaims(rawMessage) {
  const rows = productRowClaims(String(rawMessage || '').replace(/```[\s\S]*?```/g, '\n'));
  const text = bindHeadingPronouns(rawMessage)
    .replace(/```[\s\S]*?```/g, '\n')                    // command output and code are not prose claims
    .replace(/^\s*>.*$/gm, ' ')                          // quoted material
    .replace(/"[^"\n]{0,300}"|“[^”\n]{0,300}”/g, '\n')    // quoted speech: someone else's words (a break: it may carry the full stop)
    .replace(/`([^`\n]{1,80})`/g, '$1')                  // inline code keeps its identifier
    .replace(/^\s*#{1,6}\s.*$/gm, ' ')                   // headings name a topic
    .replace(/\*\*|__/g, '')
    .replace(/\|/g, '\n');                               // table cells judged one by one
  const out = rows.slice(0, 8);
  for (const raw of text.split(/(?<=[.!?;])\s+|\n+|\s+[—–]\s+/)) {
    if (out.length >= 8) break;
    const s = raw.replace(/^[\s\-*•#>\d.)]+/, '').trim();
    if (!s || s.length > 400 || NOT_RUV_ASSERTION.test(s)) continue;
    const m = [...s.matchAll(RUV_CLAIM), ...s.matchAll(RUV_DOC_CLAIM), ...s.matchAll(RUV_COREF_CLAIM), ...s.matchAll(RUV_DEFINE_CLAIM),
      ...s.matchAll(RUV_COPULA_OWN_CLAIM), ...s.matchAll(RUV_PASSIVE_CLAIM)]
      .find((x) => isAssertion(s, x));
    if (m) out.push({ text: s, match: m[0], subject: (m[1] || m[0]).trim().split(/\s+/)[0].replace(/(?:'|’)s$/, '').toLowerCase() });
    if (out.length >= 8) break;
  }
  return out;
}

// ── Stop-time audit ────────────────────────────────────────────────────────────────────────────────
const HEDGE = /\?|\b(?:might|may|maybe|perhaps|probably|possibly|likely|unlikely|apparently|seems?|i\s+think|i\s+believe|i\s+suspect|i\s+(?:could|did)\s*n[o']?t\s+(?:confirm|verify|check)|not\s+sure|unsure|unverified|unconfirmed|not\s+verified|assum(?:e|ed|ing)|if|unless|whether|would|should|once|when)\b/i;
const NEGATIVE = /\b(?:no\s+[\w-]+\s+(?:can|could|will)|cannot|can(?:'|’)t|can\s+not|is\s*n(?:'|’)?t\s+(?:possible|supported|able)|not\s+possible|impossible|does\s*n(?:'|’)?t\s+(?:support|allow|expose|provide|exist|let|offer)|does\s+not\s+(?:support|allow|expose|provide|exist|let|offer)|there(?:'|’)?s\s+no\s+(?:way|api|hook|setting|option)|there\s+is\s+no\s+(?:way|api|hook|setting|option)|has\s+no\s+(?:way|api|hook|setting|option)|only\s+(?:supports?|allows?|exposes?))\b/i;

/** Not an assertion: a hedge or question, a table cell, a "Label: description" status line, or an
 *  instruction introducing a command block ("Run this …:"). */
const notAClaim = (s) => HEDGE.test(s) || s.includes('|') || /^[\w\s/-]{1,40}:\s/.test(s) || /:\s*$/.test(s);

function sentences(message) {
  return strippedProse(message).split(/(?<=[.!?])\s+|\n+/).map((s) => s.replace(/^[\s\-*•#>]+|\*\*/g, '').trim())
    .filter((s) => s && s.length <= 400);
}

/** Capability claims about a vocabulary subject, excluding hedges and the sentences continuation-gate owns. */
export function capabilityClaims(rawMessage, tools) {
  // Headings name a topic, they do not assert one; emphasis markers break sentence splitting.
  const message = String(rawMessage || '').replace(/^\s*#{1,6}\s.*$/gm, ' ').replace(/\*\*|__/g, '');
  const owned = new Set(extractClaims(message).map((c) => c.text));
  const out = new Map();
  const subjectRe = tools.length ? new RegExp(`(?<![a-z0-9-])(${tools.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length).join('|')})(?![a-z0-9-])`, 'i') : null;
  for (const claim of extractClaims(message, { tools })) {
    if (claim.class !== 'behavior' || owned.has(claim.text)) continue;
    const text = claim.text.replace(/^[\s\-*•#>]+|\*\*/g, '').trim();
    if (!notAClaim(text)) out.set(text, { text, subject: claim.tool.toLowerCase() });
  }
  if (subjectRe) {
    for (const s of sentences(message)) {
      const neg = NEGATIVE.exec(s);
      if (out.has(s) || owned.has(s) || notAClaim(s) || !neg) continue;
      // The subject must be what the negation is about: named before it, within a short clause.
      const m = subjectRe.exec(s);
      if (m && m.index <= neg.index + 12 && neg.index - m.index <= 40) out.set(s, { text: s, subject: m[1].toLowerCase() });
    }
  }
  return [...out.values()];
}

/**
 * Sources that name every word of the subject. A STRONG source may also bind through what it
 * returned (a file read, a command's output, a search's hits); a weak one only through what it
 * pointed at — a summary's own wording is exactly what is not trusted. A word of 5+ characters also
 * matches inside a longer compound (`displaylink` in `DisplayLinkUserAgent`).
 */
export function bindingSources(subject, sources) {
  const words = subjectWords(subject);
  if (!words.length) return [];
  const has = (tokens, w) => tokens.has(w) || (w.length >= 5 && [...tokens].some((t) => t.length > w.length && t.includes(w)));
  return sources.filter((s) => {
    const t = tokenSet(s.strength === 'strong' ? `${s.text} ${s.ref} ${s.result || ''}` : s.text);
    return words.every((w) => has(t, w));
  });
}

/**
 * The audit. `sources` null = this host's sources are unknown (Codex rollout not parsed): only claims
 * a stamp term can bind are judged, the rest are UNKNOWN and never blocked.
 */
/** Proper nouns / identifiers the ANSWER uses as a sentence subject (e.g. "Thunderbolt can't …"). */
const ANSWER_SUBJECT = /(?<=[a-z,;:]\s)([A-Z][A-Za-z0-9]*(?:[-.][A-Za-z0-9]+)*)(?=\s+(?:can(?:not|'t|’t)?|does(?:n't|n’t|\s+not)?|supports?|only|is\s*n(?:'|’)?t|has\s+no|won't|will\s+not)\b)|^([A-Z][A-Za-z0-9]*(?:[-.][A-Za-z0-9]+)+|[A-Z][a-z]+[A-Z][A-Za-z0-9]*)(?=\s+(?:can|does|supports?|only|is\s*n))/gm;
const NOT_SUBJECT = new Set(['i', 'it', 'this', 'that', 'there', 'they', 'we', 'you', 'he', 'she', 'which', 'what', 'who', 'nothing', 'none', 'one']);
export function answerSubjects(message) {
  const out = new Set();
  for (const m of strippedProse(message).matchAll(ANSWER_SUBJECT)) {
    const t = (m[1] || m[2] || '').toLowerCase();
    if (t.length >= 3 && !NOT_SUBJECT.has(t)) out.add(t);
  }
  return [...out];
}

export function auditAssertions({ message, subjects = [], vocab = [], sources = null, stampTerms = [] }) {
  const tools = [...new Set([...vocab, ...subjects, ...answerSubjects(message)])].filter((t) => t.length >= 3);
  const claims = capabilityClaims(message, tools);
  const findings = [];
  const unknown = [];
  for (const claim of claims) {
    if (sources === null) {
      const words = subjectWords(claim.subject);
      const rUv = words.some((w) => RUVNET_GATE1_TERMS.includes(w));
      if (!rUv) { unknown.push(claim); continue; }
      if (!words.every((w) => stampTerms.includes(w))) findings.push({ ...claim, reason: 'no search_ruvnet stamp for this subject this turn', read: stampTerms.map((t) => `search_ruvnet stamp: ${t}`) });
      continue;
    }
    const binding = bindingSources(claim.subject, sources.filter((s) => s.strength !== 'failed'));
    const lastWeak = Math.max(-1, ...binding.filter((s) => s.strength === 'weak').map((s) => s.order));
    const strongAfter = binding.some((s) => s.strength === 'strong' && s.order > lastWeak);
    if (!strongAfter) {
      findings.push({ ...claim, reason: lastWeak >= 0 ? 'the only sources about it this turn are weak (summarised or relayed)' : 'no source about it was read this turn',
        read: describeSources(lastWeak >= 0 ? binding : sources) });
    }
  }
  return { claims, findings, unknown };
}

export function describeSources(sources, max = 4) {
  if (!sources.length) return ['nothing'];
  const shown = sources.slice(-max).map((s) => `${s.kind} ${JSON.stringify(String(s.ref).slice(0, 70))}${s.strength === 'weak' ? ` [${s.why} = weak evidence]` : ''}`);
  return sources.length > max ? [`${sources.length - max} earlier`, ...shown] : shown;
}

export function correctionText(findings) {
  const f = findings[0];
  const lines = [
    `You asserted "${f.text.slice(0, 200)}" about ${f.subject}; no relevant source was read this turn`
      + ` (${f.reason}; read: ${f.read.join('; ')}).`,
    ...findings.slice(1, 3).map((x) => `Also unsourced: "${x.text.slice(0, 160)}" about ${x.subject}.`),
    'Check the real source now (read the file, run the command with --help, search_ruvnet, or fetch the',
    'raw page with curl — a WebFetch body is a small model\'s summary) or restate each claim as UNVERIFIED.',
    'ADR-0030 decision point #1: "Did you CHECK, or are you recalling? Name the source."',
  ];
  return lines.join('\n');
}

// ── shadow gates #2 and #3 (logged, never delivered) ──────────────────────────────────────────────
const RECOMMENDS = /\b(?:I(?:'d|’d|\s+would)?\s+(?:recommend|propose|suggest)|my\s+recommendation|recommended\s+(?:approach|option|design)|the\s+design\s+I(?:'d|’d|\s+would)\s+propose|I(?:'d|’d)\s+(?:go|build)\s+with|go\s+with\s+option)\b/i;
const OPTION_MARK = /(?:^|\n)\s*(?:#{1,4}\s*|[-*•]\s*|\*\*)?(?:option|alternative|approach)\s*(?:[A-Z1-9]|one|two|three|four)\b|\b(?:option|alternative)\s+(?:[A-D1-4])\b/gi;
export function architectureShadow({ architecture, message }) {
  if (!architecture || !RECOMMENDS.test(strippedProse(message))) return null;
  const options = new Set([...String(message).matchAll(OPTION_MARK)].map((m) => m[0].trim().toLowerCase().replace(/[^a-z0-9 ]/g, ''))).size;
  return options >= 3 ? null : { gate: 'adr-0030-2-architecture-options', options, wouldBlock: true };
}

const NUMBER = /(?<![\w.])\d+(?:[.,]\d+)?(?:\s?%|\/\d+)?(?![\w])/g;
export function relayShadow({ message, sources }) {
  if (!sources?.length) return null;
  const agentIdx = sources.filter((s) => s.kind === 'Agent' || s.kind === 'Task');
  if (!agentIdx.length) return null;
  const nums = [...new Set((strippedProse(message).match(NUMBER) || []).map((n) => n.replace(/\s/g, '')))]
    .filter((n) => /[.%/]/.test(n) || n.replace(/\D/g, '').length >= 3).filter((n) => !/^(?:19|20)\d\d$/.test(n));
  const relayed = nums.filter((n) => {
    const from = agentIdx.find((a) => String(a.result || '').includes(n));
    if (!from) return false;
    return !sources.some((s) => s.order > from.order && s.kind !== 'Agent' && s.kind !== 'Task' && String(s.result || '').includes(n));
  });
  return relayed.length ? { gate: 'adr-0030-3-relayed-number', numbers: relayed.slice(0, 8), wouldBlock: true } : null;
}

/** Append one shadow row, bounded. Never throws. */
export function logShadow(row, { env = process.env } = {}) {
  try {
    const file = env.RUVNET_ASSERTION_SHADOW_LOG || path.join(brainHome(env), 'assertion-gate-shadow.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
    if (fs.statSync(file).size > 512 * 1024) {
      const keep = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-500);
      fs.writeFileSync(file, `${keep.join('\n')}\n`);
    }
  } catch { /* shadow measurement never breaks a turn */ }
}
