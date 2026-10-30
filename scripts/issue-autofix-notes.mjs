// scripts/issue-autofix-notes.mjs — guards and the regenerate loop for PERSONAL thank-you notes (ADR-107).
//
// Owner's standing order: a thank-you note is never a form letter. Each note is written fresh by a model from the
// person's OWN words in the thread, is specific about what they did, apologises plainly when they waited more than
// WAIT_APOLOGY_DAYS, and is truthful about what was and was not verified. One note per person per night.
//
// This module decides whether a model-written note may be posted (checkNote) and drives up to MAX_REGENERATIONS
// retries with feedback (generatePersonNote). If no attempt passes it refuses; the caller then posts nothing
// personal and pages the owner. Pure: no fs, no child_process, no network — every input is passed in.
import { BOT_MARKER, OWNER_LOGIN } from './issue-watch.mjs';

export const MAX_REGENERATIONS = 3; // total attempts = 1 + MAX_REGENERATIONS
export const WAIT_APOLOGY_DAYS = 7;
const DAY_MS = 86_400_000;
const THANKS_MAX = 700;
const THANKS_MIN = 40;
const FIELD_MAX = 600;
const TRIGRAM_LIMIT = 0.45;
const GENERIC_RATIO = 0.6;
const FIELDS = ['whatWasWrong', 'whatChanged', 'whatItNeeds'];

export const BOILERPLATE = Object.freeze([
  'thank you for reporting', 'thanks for reporting', 'thanks for taking the time', 'thank you for taking the time',
  'we appreciate', 'i appreciate you', 'great catch', 'good catch', 'hope this helps', 'let us know', 'let me know if',
  "don't hesitate", 'do not hesitate', 'happy to help', 'sorry for the inconvenience', 'thanks again',
  'thank you for your patience', 'feel free to', 'your feedback', 'valuable feedback', 'keep up', 'much appreciated',
  'we value',
]);

const STOP = new Set(('a an and are as at be been being but by can could did do does for from had has have he her his '
  + 'how i if in into is it its just like me more most my no not now of on once only or our out over she so some such '
  + 'than that the their them then there these they this those to too up us very was we were what when where which '
  + 'while who whom why will with would you your yours every all any also about after again because before both each '
  + 'few here off other own same should through under until').split(' '));
// Words that carry no information about WHICH issue a sentence is about: thanks, praise, apology filler, "the project".
const GENERIC_VOCAB = new Set(('thanks thank report reports reported reporting issue issues bug bugs problem problems '
  + 'contribution contributions contribute contributing help helps helped helpful helping project projects community '
  + 'everyone everybody users user use uses using improve improves improving improvement better best appreciate '
  + 'appreciated appreciation really great much many effort efforts time times work works taking take took detailed '
  + 'detail details clear write writing written filing filed file open opened opening raise raised raising kind matters '
  + 'matter important valuable feedback make makes made sure things thing glad happy awesome amazing nice good '
  + 'wonderful excellent fantastic difference team grateful thoughtful input others people future sorry wait waiting '
  + 'waited delay delayed slow reply response long while lot truly sincerely definitely certainly look looked looking '
  + 'into get got able way ways keep going someone anyone something anything know let hope want wanted').split(' '));

const str = (v) => (typeof v === 'string' ? v : '');
const lower = (s) => str(s).toLowerCase();
const normWords = (s) => lower(s).replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/).filter(Boolean);
const uniq = (a) => [...new Set(a)];
const alnumCount = (s) => (s.match(/[A-Za-z0-9]/g) || []).length;
const sentences = (s) => str(s).split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);

// ---- interface helpers -------------------------------------------------------------------------------------------

export function reporterWords(issue, login) {
  const who = lower(login);
  const own = (Array.isArray(issue?.comments) ? issue.comments : []).filter((c) => {
    const author = lower(c?.author?.login);
    return author && author === who && author !== lower(OWNER_LOGIN);
  });
  return [str(issue?.title), str(issue?.body), ...own.map((c) => str(c.body))].filter(Boolean).join('\n\n');
}

export function waitedDays(issue, now) {
  const t = Date.parse(str(issue?.createdAt));
  if (!Number.isFinite(t) || !Number.isFinite(now)) return 0;
  return Math.max(0, Math.floor((now - t) / DAY_MS));
}

// Items whose issue has no author login are dropped: there is nobody to thank.
export function groupByPerson(items) {
  const groups = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const login = str(item?.issue?.author?.login).trim();
    if (!login) continue;
    const key = login.toLowerCase();
    if (!groups.has(key)) groups.set(key, { login, items: [] });
    groups.get(key).items.push(item);
  }
  const ts = (i) => { const t = Date.parse(str(i.issue.createdAt)); return Number.isFinite(t) ? t : Infinity; };
  return [...groups.values()].map((g) => ({
    login: g.login,
    items: g.items.slice().sort((a, b) => ts(a) - ts(b) || (a.issue.number || 0) - (b.issue.number || 0)),
  }));
}

export function noteText(note) {
  const per = Array.isArray(note?.perIssue) ? note.perIssue : [];
  return [str(note?.thanks), ...per.flatMap((e) => FIELDS.map((f) => str(e?.[f])))]
    .map((s) => s.trim()).filter(Boolean).join('\n\n');
}

// ---- what counts as the person's own, distinctive words -------------------------------------------------------------

function codeTokens(text) {
  const out = [];
  for (const raw of str(text).split(/\s+/)) {
    let t = raw.replace(/^["'`(<[{“‘]+/, '').replace(/[.,;:!?"'`>\]}”’]+$/, '');
    while (t.endsWith(')') && (t.match(/\(/g) || []).length < (t.match(/\)/g) || []).length) t = t.slice(0, -1).replace(/[.,;:!?]+$/, '');
    if (alnumCount(t) < 4) continue;
    const codeLike = /[./_():\\]/.test(t) || /[a-z][A-Z]/.test(t) || /^--?[A-Za-z]/.test(t) || /^E[A-Z]{3,}$/.test(t);
    if (codeLike) out.push(t);
  }
  return out;
}

function quotedSpans(text) {
  const out = [];
  const res = [/`([^`\n]+)`/g, /"([^"\n]+)"/g, /“([^”\n]+)”/g, /(?:^|[\s(])'([^'\n]+?)'(?=[\s.,;:!?)]|$)/g];
  for (const re of res) {
    for (const m of str(text).matchAll(re)) {
      const span = m[1].trim().replace(/\s+/g, ' ');
      if (span.length < 8) continue;
      if (!normWords(span).some((w) => w.length >= 3 && !STOP.has(w))) continue; // stop-words only
      out.push(span);
    }
  }
  return out;
}

// Extension beyond tokens and quotes: a reporter who writes plain English with no code and no quotes would otherwise
// be unquotable and always refused. Any run of 6 consecutive words of theirs with >= 3 content words also counts.
function phraseGrams(text) {
  const w = normWords(text);
  const grams = new Set();
  for (let i = 0; i + 6 <= w.length; i++) {
    const g = w.slice(i, i + 6);
    if (g.filter((x) => x.length >= 3 && !STOP.has(x)).length >= 3) grams.add(g.join(' '));
  }
  return grams;
}

function personSpans(login, items) {
  const text = items.map((i) => reporterWords(i.issue, login)).join('\n\n');
  return { literal: uniq([...codeTokens(text), ...quotedSpans(text)]), grams: phraseGrams(text), text };
}

const collapse = (s) => str(s).replace(/\s+/g, ' ');
function hasSpan(s, spans) {
  const flat = collapse(s);
  if (spans.literal.some((t) => flat.includes(t))) return true;
  const w = normWords(s);
  for (let i = 0; i + 6 <= w.length; i++) if (spans.grams.has(w.slice(i, i + 6).join(' '))) return true;
  return false;
}

// GENERIC RULE (documented choice). The thanks is generic when EITHER it carries no verbatim span of the person's
// words at all (then it is equally true of any issue), OR more than 60% of its sentences are generic. A sentence that
// carries a verbatim span counts as specific (equivalent to deleting the span and keeping the sentence's credit); any
// other sentence is generic when, after removing stop-words and the GENERIC_VOCAB of praise/apology/"the project"
// filler, fewer than 2 content words (>= 3 letters) remain. This catches a form letter with one token pasted in.
function isGenericSentence(s) {
  return normWords(s).filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !STOP.has(w) && !GENERIC_VOCAB.has(w)).length < 2;
}
function genericThanks(thanks, spans) {
  const ss = sentences(thanks);
  if (!ss.length) return true;
  if (!hasSpan(thanks, spans)) return true;
  const generic = ss.filter((s) => !hasSpan(s, spans) && isGenericSentence(s)).length;
  return generic / ss.length > GENERIC_RATIO;
}

// ---- text guards --------------------------------------------------------------------------------------------------

const stripCode = (s) => str(s).replace(/`[^`\n]*`/g, ' ');
const MENTION_RE = /(^|[^\w@`])@([A-Za-z0-9][A-Za-z0-9-]*)/g;
const CLOSING_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*(?:#\d+|[\w.-]+\/[\w.-]+#\d+|https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+)/i;
const PATH_RE = [/(^|[^\w.])\/Users\/[^\s/]+/, /(^|[^\w.])\/home\/[^\s/]+/, /\b[A-Za-z]:\\Users\b/i, /~\/\.\w/, /\/private\/var\b/, /(^|[\s`'"(=])\/tmp\//];
const SECRET_RE = [/\bgh[pos]_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/, /\bnpm_[A-Za-z0-9]{20,}/,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/, /\bsk-[A-Za-z0-9_-]{20,}/, /\bAKIA[0-9A-Z]{16}\b/, /-----BEGIN [A-Z ]*-----/];
const MODEL_RE = /\b(claude|opus|sonnet|haiku|anthropic|gpt|openai|llms?|language models?|system prompts?|prompts?|prompted|as an ai|automated pipeline|autofix|the bot|token budget)\b/i;
const CLAIM_RE = /\b(fixed|shipped|released|published|resolved|is live|are live|now live)\b/gi;
const HEDGE_RE = /\b(not|never|no|nothing|none|neither|nor|without|until|once|when|if|after|yet|unless|before|will|would|should|could|may|might|to be)\b|n't\b/i;
const VERIFY_RE = /\b(verified|verify|install-verified|tested|tests? pass(?:ed|es)?|passes|passed|confirmed|checked|reproduced|ran|runs|works|working)\b/i;
const NEG_RE = /\b(not|never|no|unverified|untested|without)\b|n't\b/i;
const PLATFORM_RE = /\b(windows|macos|mac|linux|codex|grok)\b/gi;
const platformKey = (p) => (p === 'mac' ? 'macos' : p);
const platformsIn = (s) => new Set([...lower(s).matchAll(PLATFORM_RE)].map((m) => platformKey(m[1])));

// Code the note quotes is not a claim: `resolved.projectRoot`, { db: resolved } and backticked spans are removed first
// (measured 2026-10-30: a true cause quoting resolveProjectStore's `resolved` read as "resolved").
const proseOnly = (t) => str(t).replace(/`[^`]*`/g, ' ').replace(/\{[^{}]*\}/g, ' ').replace(/[\w$]+(?:\.[\w$]+)+/g, ' ').replace(/\b\w+\(/g, ' ');
function claimsDone(raw) {
  const text = proseOnly(raw);
  for (const m of text.matchAll(CLAIM_RE)) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 24);
    if (/^\s+yet\b/i.test(after)) continue; // "shipped yet"
    // Only an ASSERTED state is a claim: "is fixed", "it shipped", "now live", "fixed in v4.7.23". The adjective in
    // "carry the resolved project root" is not (measured 2026-10-30 on a real note).
    const lead = text.slice(Math.max(0, m.index - 30), m.index).toLowerCase().split(/\s+/).filter(Boolean).slice(-3);
    const asserted = lead.some((w) => /^(is|are|was|were|be|been|being|has|have|had|it|this|that|now|got|gets|it's|that's|its)$/.test(w.replace(/[^\w']/g, '')))
      || /^\s+(in|as of)\s+(v?\d|the latest|version)/i.test(after) || /^(is|are|now)\s+live$/i.test(m[0]);
    if (!asserted) continue;
    let before = text.slice(Math.max(0, m.index - 40), m.index);
    const cut = Math.max(...[',', ';', ':', '.', '!', '?'].map((c) => before.lastIndexOf(c)));
    if (cut >= 0) before = before.slice(cut + 1);
    if (!HEDGE_RE.test(before)) return true;
  }
  return false;
}
// Platforms a text says were verified, ignoring negated sentences ("not tested on Windows" is truthful).
function claimedPlatforms(text) {
  const out = new Set();
  for (const s of sentences(text)) {
    if (!VERIFY_RE.test(s) || NEG_RE.test(s)) continue;
    for (const p of platformsIn(s)) out.add(p);
  }
  return out;
}
const verifiedPlatforms = (its) => new Set(its.flatMap((i) => (Array.isArray(i?.facts?.verified) ? i.facts.verified : []).flatMap((v) => [...platformsIn(v)])));

// ---- similarity ---------------------------------------------------------------------------------------------------

function ngrams(words, n) { const s = new Set(); for (let i = 0; i + n <= words.length; i++) s.add(words.slice(i, i + n).join(' ')); return s; }
function charTrigrams(text) { const t = normWords(text).join(' '); const s = new Set(); for (let i = 0; i + 3 <= t.length; i++) s.add(t.slice(i, i + 3)); return s; }
function jaccard(a, b) { if (!a.size && !b.size) return 0; let inter = 0; for (const x of a) if (b.has(x)) inter++; return inter / (a.size + b.size - inter); }

function similarityReasons(text, priorNotes) {
  const reasons = [];
  const w = normWords(text);
  const g6 = ngrams(w, 6);
  const tri = charTrigrams(text);
  for (const p of Array.isArray(priorNotes) ? priorNotes : []) {
    const pt = str(p?.text);
    if (!pt.trim()) continue;
    const pw = normWords(pt);
    if ([...ngrams(pw, 6)].some((g) => g6.has(g))) reasons.push('too-similar:ngram');
    if (w.length >= 5 && pw.length >= 5 && w.slice(0, 5).join(' ') === pw.slice(0, 5).join(' ')) reasons.push('too-similar:opening');
    if (w.length >= 5 && pw.length >= 5 && w.slice(-5).join(' ') === pw.slice(-5).join(' ')) reasons.push('too-similar:closing');
    if (jaccard(tri, charTrigrams(pt)) >= TRIGRAM_LIMIT) reasons.push('too-similar:trigram');
  }
  return reasons;
}

// ---- the gate -----------------------------------------------------------------------------------------------------

export function checkNote({ note, login, items, priorNotes = [], now = Date.now() } = {}) {
  const reasons = [];
  const its = (Array.isArray(items) ? items : []).filter((i) => i && i.issue);
  const thanks = str(note?.thanks);
  const per = Array.isArray(note?.perIssue) ? note.perIssue : [];
  const numbers = new Set(its.map((i) => i.issue.number));
  const entryFor = (n) => per.find((e) => e && e.number === n);
  const text = noteText(note);
  const spans = personSpans(login, its);

  // structure
  if (!thanks.trim()) reasons.push('empty');
  for (const n of numbers) if (!str(entryFor(n)?.whatWasWrong).trim()) reasons.push(`missing-issue:${n}`);
  for (const e of per) if (!numbers.has(e?.number)) reasons.push(`extra-issue:${e?.number}`);
  if (thanks.length > THANKS_MAX || per.some((e) => FIELDS.some((f) => str(e?.[f]).length > FIELD_MAX))) reasons.push('too-long');
  if (thanks.trim() && thanks.trim().length < THANKS_MIN) reasons.push('too-short');

  // personal, not a form letter
  if (thanks.trim() && !hasSpan(thanks, spans)) reasons.push('not-specific');
  if (thanks.trim() && genericThanks(thanks, spans)) reasons.push('generic');
  if (BOILERPLATE.some((p) => lower(text).includes(p))) reasons.push('boilerplate');
  reasons.push(...similarityReasons(text, priorNotes));
  if (its.some((i) => waitedDays(i.issue, now) > WAIT_APOLOGY_DAYS) && !/\b(sorry|apolog)/i.test(text)) reasons.push('no-apology');

  // safety
  const who = lower(login);
  if ([...stripCode(text).matchAll(MENTION_RE)].some((m) => m[2].toLowerCase() !== who)) reasons.push('mentions-other');
  if (CLOSING_RE.test(text)) reasons.push('closing-keyword');
  if (text.includes(BOT_MARKER) || text.includes('<!--') || text.includes('-->')) reasons.push('marker');
  if (PATH_RE.some((re) => re.test(text))) reasons.push('path-leak');
  if (SECRET_RE.some((re) => re.test(text))) reasons.push('secret');
  // The person's own backticked words (e.g. `claude mcp add`) are theirs to quote; everything else is checked.
  const ownCode = text.replace(/`([^`\n]*)`/g, (m, inner) => (spans.text.includes(inner) ? ' ' : m));
  if (MODEL_RE.test(ownCode)) reasons.push('model-internals');

  // truthfulness. A thanks sentence is attributed to an issue when it names #N; with no fixed item at all, the whole
  // thanks speaks for every issue. Platform claims in the thanks are checked against every item's verified facts.
  const anyFixed = its.some((i) => i.kind === 'fixed');
  const thanksFor = (n) => (anyFixed ? sentences(thanks).filter((s) => new RegExp(`#${n}\\b`).test(s)).join(' ') : thanks);
  const thanksClaims = claimedPlatforms(thanks);
  for (const i of its) {
    const n = i.issue.number;
    const entry = entryFor(n);
    const own = FIELDS.map((f) => str(entry?.[f])).join('\n');
    const doneClaim = i.kind !== 'fixed' && (claimsDone(own) || claimsDone(thanksFor(n)));
    const ok = verifiedPlatforms([i]);
    const named = sentences(thanks).filter((s) => new RegExp(`#${n}\\b`).test(s)).join(' ');
    const platformClaim = [...claimedPlatforms(own), ...claimedPlatforms(named)].some((p) => !ok.has(p))
      || [...thanksClaims].some((p) => !verifiedPlatforms(its).has(p) && !ok.has(p));
    if (doneClaim || platformClaim) reasons.push(`overclaim:${n}`);
  }
  const out = uniq(reasons);
  return { ok: out.length === 0, reasons: out };
}

// ---- regenerate loop ----------------------------------------------------------------------------------------------

function feedbackFor(reasons, { login, items, text }) {
  const spans = personSpans(login, items).literal.slice(0, 3).map((s) => (s.length > 60 ? s.slice(0, 60) : s));
  const msgs = [];
  for (const r of reasons) {
    const [id, arg] = r.split(':');
    const item = items.find((i) => String(i.issue.number) === arg);
    switch (id) {
      case 'empty': msgs.push('The "thanks" field was empty; write a real thank-you paragraph.'); break;
      case 'missing-issue': msgs.push(`Add a perIssue entry for #${arg} with a plain, non-empty whatWasWrong.`); break;
      case 'extra-issue': msgs.push(`Remove the perIssue entry for #${arg}; this person did not file it.`); break;
      case 'not-specific': msgs.push(`Quote, word for word, something specific this person wrote${spans.length ? `, for example: ${spans.map((s) => `"${s}"`).join(', ')}` : ''}.`); break;
      case 'generic': msgs.push('Most sentences would fit any issue; make each sentence about what this person actually found or did.'); break;
      case 'boilerplate': msgs.push(`Drop stock phrases (${BOILERPLATE.filter((p) => lower(text).includes(p)).map((p) => `"${p}"`).join(', ')}); say it in your own words.`); break;
      case 'too-similar':
        msgs.push({ ngram: 'A run of six words repeats an earlier note; rephrase in fresh words.',
          opening: 'Your opening repeats an earlier note; start differently.',
          closing: 'Your ending repeats an earlier note; end differently.',
          trigram: 'The note reads too much like an earlier one; change its structure, length and wording.' }[arg] || 'Too similar to an earlier note.');
        break;
      case 'no-apology': msgs.push('This person waited more than a week; say plainly that you are sorry it took so long.'); break;
      case 'mentions-other': msgs.push(`Do not @mention anyone other than @${login}; put package names in backticks.`); break;
      case 'closing-keyword': msgs.push('Do not write fix/close/resolve next to an issue number or issue link.'); break;
      case 'marker': msgs.push('Remove the robot marker and any HTML comments.'); break;
      case 'path-leak': msgs.push('Remove local file paths (home directories, temp folders).'); break;
      case 'secret': msgs.push('Remove anything that looks like a token or key.'); break;
      case 'model-internals': msgs.push('Do not mention the AI model, prompts or the automation behind this note.'); break;
      case 'overclaim': msgs.push(`#${arg} is "${item?.kind}": do not say it is fixed, shipped, released or live, and only name a platform as verified if it appears in: ${(item?.facts?.verified || []).join('; ') || 'nothing was verified'}.`); break;
      case 'too-long': msgs.push(`Shorten it: thanks at most ${THANKS_MAX} characters, each per-issue field at most ${FIELD_MAX}.`); break;
      case 'too-short': msgs.push('The thanks is too short; write at least a couple of real sentences.'); break;
      case 'generate-failed': msgs.push('The previous attempt produced no usable note; return a complete note object.'); break;
      default: msgs.push(`Fix: ${r}.`);
    }
  }
  return uniq(msgs);
}

export async function generatePersonNote({ login, items, priorNotes = [], now = Date.now(), generate, max = MAX_REGENERATIONS } = {}) {
  const its = Array.isArray(items) ? items : [];
  const rejections = [];
  let feedback = [];
  const total = 1 + Math.max(0, Number.isInteger(max) ? max : MAX_REGENERATIONS);
  for (let attempt = 0; attempt < total; attempt++) {
    let note = null;
    try { note = await generate({ attempt, feedback }); } catch { note = null; }
    const reasons = note && typeof note === 'object'
      ? checkNote({ note, login, items: its, priorNotes, now }).reasons
      : ['generate-failed'];
    if (!reasons.length) return { ok: true, note, attempts: attempt + 1, rejections };
    rejections.push(reasons);
    feedback = feedbackFor(reasons, { login, items: its, text: noteText(note) });
  }
  return { ok: false, note: null, attempts: total, rejections };
}
