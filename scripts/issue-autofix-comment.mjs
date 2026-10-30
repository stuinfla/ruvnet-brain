// Issue autofix REPORTER COMMENTS (ADR-107 §6). What a person who filed an issue reads from the automation.
//
// Four promises, each enforced in code rather than hoped for:
//   1. MARKER FIRST. Every body begins with BOT_MARKER. issue-watch's judgeIssue ignores an owner comment only when it
//      starts with the marker; a body without it would count as the maintainer's own reply and silence the SLA page.
//   2. HONEST. `fixed` is the only kind that says "Fixed in"; `shipping` says it is still being verified; `findings`
//      claims no fix. A hidden marker at the END makes every outcome idempotent even if the state file is wiped.
//   3. PERSONAL. The thanks sentence must name something concrete from THEIR issue and must not echo a note we already
//      sent that person; otherwise it is dropped (the caller pages the owner to write one) rather than posted generic.
//   4. SAFE. The note fields are model-written. They are scrubbed of closing keywords, other @mentions, robot markers and
//      HTML comments before they can reach a public thread.
import { BOT_MARKER, OWNER_LOGIN } from './issue-watch.mjs';
import { AutofixAbort, findClosingKeywords, CLOSING_KEYWORD_SOURCE } from './issue-autofix-policy.mjs';

export { BOT_MARKER, OWNER_LOGIN };

const OUTCOMES = new Set(['fixed', 'shipping', 'findings', 'not-fixed', 'reply']);
const MARKER_RE = /<!--\s*ruvnet-autofix v1\s+([^>]*?)\s*-->/g;
// Our own comment (and the autofix:needs-owner label that follows it) bumps issue.updatedAt a moment after the marker's
// `at`. Only an update later than this grace counts as the reporter coming back.
export const FINDINGS_GRACE_MS = 10 * 60_000;
export const SIMILARITY_LIMIT = 0.5;

const fail = (detail) => new AutofixAbort('S13', 'comment-failed', detail);

// ---------------------------------------------------------------------------------------------
// Hidden marker
// ---------------------------------------------------------------------------------------------
export function hiddenMarker({ issueNumber, outcome, version, sha, at } = {}) {
  if (!Number.isInteger(issueNumber) || issueNumber < 1) throw fail('hiddenMarker: bad issue number');
  if (!OUTCOMES.has(outcome)) throw fail(`hiddenMarker: bad outcome ${outcome}`);
  const parts = [`issue=${issueNumber}`, `outcome=${outcome}`];
  if (version != null) { if (!/^\d+\.\d+\.\d+$/.test(version)) throw fail('hiddenMarker: bad version'); parts.push(`version=${version}`); }
  if (sha != null) { if (!/^[0-9a-f]{7,40}$/.test(sha)) throw fail('hiddenMarker: bad sha'); parts.push(`sha=${sha}`); }
  if (at != null) { if (!/^[\w:.+-]+$/.test(at)) throw fail('hiddenMarker: bad timestamp'); parts.push(`at=${at}`); }
  return `<!-- ruvnet-autofix v1 ${parts.join(' ')} -->`;
}

const isBotComment = (c) => String(c?.author?.login || '').toLowerCase() === OWNER_LOGIN
  && String(c?.body || '').trimStart().startsWith(BOT_MARKER);

function markerEntries(comments) {
  const out = [];
  for (const c of Array.isArray(comments) ? comments : []) {
    if (!isBotComment(c)) continue; // a stranger quoting a marker proves nothing
    for (const m of String(c.body).matchAll(MARKER_RE)) {
      const kv = Object.fromEntries([...m[1].matchAll(/(\w+)=(\S+)/g)].map((x) => [x[1], x[2]]));
      const issue = Number(kv.issue);
      if (!Number.isInteger(issue) || !kv.outcome) continue;
      out.push({ marker: { issue, outcome: kv.outcome, version: kv.version ?? null, sha: kv.sha ?? null, at: kv.at ?? null }, createdAt: c.createdAt });
    }
  }
  return out;
}

export const parseHiddenMarkers = (comments) => markerEntries(comments).map((e) => e.marker);

export function alreadyPosted(comments, { outcome, version, issueUpdatedAt } = {}) {
  const entries = markerEntries(comments);
  if (outcome === 'reply') return entries.some(({ marker: m }) => m.outcome === 'reply'); // once per issue, ever
  if (outcome === 'findings' || outcome === 'not-fixed') {
    const times = entries.filter((e) => e.marker.outcome === outcome)
      .map((e) => Math.max(Date.parse(e.marker.at) || 0, Date.parse(e.createdAt) || 0));
    if (times.length === 0) return false;
    const updated = Date.parse(issueUpdatedAt);
    if (!Number.isFinite(updated)) return true; // cannot show the reporter came back: do not repeat ourselves
    return !(updated > Math.max(...times) + FINDINGS_GRACE_MS);
  }
  return entries.some(({ marker: m }) => m.version === (version ?? null)
    && (m.outcome === outcome || (outcome === 'shipping' && m.outcome === 'fixed'))); // "shipping" after "fixed" would be a regression
}

// ---------------------------------------------------------------------------------------------
// Thanks: specific and never repeated
// ---------------------------------------------------------------------------------------------
const trigrams = (s) => {
  const t = String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const set = new Set();
  for (let i = 0; i + 3 <= t.length; i++) set.add(t.slice(i, i + 3));
  return set;
};

export function trigramSimilarity(a, b) {
  const x = trigrams(a); const y = trigrams(b);
  if (x.size === 0 && y.size === 0) return 0;
  let both = 0;
  for (const g of x) if (y.has(g)) both++;
  return both / (x.size + y.size - both);
}

const STOP = new Set(['the', 'a', 'an', 'this', 'that', 'issue', 'bug', 'report', 'problem', 'thanks', 'thank', 'you', 'for', 'your', 'it', 'is', 'of', 'to', 'and', 'in', 'on', 'with', 'error', 'fix', 'was', 'were', 'when', 'what']);
const codeLike = (t) => /[./\\_:()[\]{}=<>\d]/.test(t) || /[a-z][A-Z]/.test(t) || /^--?[a-z]/i.test(t)
  || (/^[A-Z][A-Z0-9_]{3,}$/.test(t) && !STOP.has(t.toLowerCase())); // error codes such as ENOENT

/** Concrete things a sentence points at: code-shaped tokens (path, function, flag, version) or a quoted phrase that is not
 *  just filler. Each must appear VERBATIM in the reporter's own text. */
function specificMentions(thanks, issueText) {
  const found = [];
  for (const raw of String(thanks).split(/\s+/)) {
    const tok = raw.replace(/^[("'`*_]+/, '').replace(/[)"'`*_.,;:!?]+$/, '');
    if (tok.replace(/[^A-Za-z0-9]/g, '').length >= 4 && codeLike(tok) && issueText.includes(tok)) found.push(tok);
  }
  for (const m of String(thanks).matchAll(/[`"“]([^`"”]{4,120})[`"”]/g)) {
    const span = m[1].trim();
    const words = span.toLowerCase().split(/\W+/).filter(Boolean);
    if (span.length >= 4 && words.some((w) => !STOP.has(w)) && issueText.includes(span)) found.push(span);
  }
  return found;
}

export function checkThanks({ thanks, issueText, priorNotes = [] } = {}) {
  const text = String(thanks ?? '').trim();
  if (!text) return { ok: false, reasons: ['empty'] };
  const reasons = [];
  if (specificMentions(text, String(issueText ?? '')).length === 0) reasons.push('not-specific');
  if ((priorNotes || []).some((p) => trigramSimilarity(text, p) >= SIMILARITY_LIMIT)) reasons.push('too-similar');
  return { ok: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------
const NAMES = { windows: 'Windows', linux: 'Linux', macos: 'macOS', codex: 'Codex', grok: 'Grok' };
const ran = new Set(['macos', 'linux']); // the platforms our evidence actually ran on

/** Scrub model-written text for a public thread (see header, promise 4). */
function scrub(text, kind, max) {
  let t = String(text ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ').replace(/<!--|-->/g, ' ')
    .split(BOT_MARKER).join('')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/(^|[^\w.])@(?=[A-Za-z0-9_-])/g, '$1')
    .replace(new RegExp(CLOSING_KEYWORD_SOURCE, 'gi'), (m) => `see ${m.replace(/^\w+\s*:?\s*/, '')}`)
    .replace(/\s+/g, ' ').trim();
  if (kind !== 'fixed') t = t.replace(/\bfixed in\b/gi, 'changed in');
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

const joinNames = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * thanks: the person's note (only on the first of their issues tonight) or null; thanksOn: the issue that carries it.
 * entry: the note's perIssue entry for THIS issue; facts: {verified, notVerified} measured by machines, never by a model.
 */
export function renderComment({ kind, issueNumber, login, thanks = null, thanksOn = null, entry = {}, facts = null, version, sha, commitUrl, testPath, platformCaveat = [], at } = {}) {
  if (!OUTCOMES.has(kind)) throw fail(`renderComment: unknown kind ${kind}`);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(String(login || ''))) throw fail('renderComment: unsafe reporter login');
  const t = thanks ? scrub(thanks, kind, 700) : '';
  const hi = t ? `Hi @${login} — ${t}` : Number.isInteger(thanksOn) && thanksOn !== issueNumber ? `Hi @${login} — my note to you is on issue ${thanksOn}.` : `Hi @${login}.`;
  const wrong = scrub(entry.whatWasWrong, kind, 600);
  if (!wrong) throw fail('renderComment: entry.whatWasWrong is required');
  const list = (xs) => (xs || []).map((x) => scrub(x, kind, 200)).filter(Boolean).join('; ');
  const factsLine = facts && (facts.verified?.length || facts.notVerified?.length)
    ? [`**Checked:** ${list(facts.verified) || 'nothing yet'}.`, facts.notVerified?.length ? ` **Not checked:** ${list(facts.notVerified)}.` : ''].join('') : null;
  const needs = scrub(entry.whatItNeeds, kind, 600) || 'a maintainer’s decision.';
  const foot = (o) => hiddenMarker({ issueNumber, outcome: o, at: at ?? new Date().toISOString() });

  if (kind === 'findings') {
    return [`${BOT_MARKER} findings — RuvNet Brain`, '', hi, '',
      `I dug into this rather than guess at a patch. Here's what I found: ${wrong}`,
      `What it needs: ${needs} I've flagged it for the maintainer, so the next reply here will be from a person or a real fix.`, '', foot('findings')].join('\n');
  }
  if (kind === 'not-fixed') {
    return [`${BOT_MARKER} status — RuvNet Brain`, '', hi, '',
      `I worked on a fix for this, but it did not pass verification, so nothing was shipped. What I found: ${wrong}`,
      ...(factsLine ? [factsLine] : []),
      `What it needs: ${needs} A maintainer will take it from here.`, '', foot('not-fixed')].join('\n');
  }
  if (kind === 'reply') {
    return [`${BOT_MARKER} note — RuvNet Brain`, '', hi, '',
      `${wrong}`, `This needs the maintainer's call, so nothing has been changed: ${needs} I've flagged it, so the next reply here will be from a person.`, '', foot('reply')].join('\n');
  }

  const changed = scrub(entry.whatChanged, kind, 400);
  if (!changed) throw fail('renderComment: entry.whatChanged is required');
  if (!/^\d+\.\d+\.\d+$/.test(String(version))) throw fail('renderComment: version is required');
  if (!/^[0-9a-f]{7,40}$/.test(String(sha))) throw fail('renderComment: sha is required');
  const short = sha.slice(0, 7);
  const ref = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/commit\/[0-9a-f]{7,40}$/.test(String(commitUrl)) ? `[${short}](${commitUrl})` : `\`${short}\``;
  const test = String(testPath || '').replace(/[`\s]/g, '');
  const where = kind === 'fixed'
    ? `Fixed in **v${version}**, published to npm and GitHub and install-verified on Linux, macOS and Windows. \`npx ruvnet-brain@latest --update\` picks it up (plugin installs update on their own).`
    : `Built and merged; shipping in **v${version}**, which is still finishing verification. I'll confirm here once it is verified on all three platforms.`;
  const missing = [...new Set((platformCaveat || []).map((p) => String(p).toLowerCase()))].filter((p) => !ran.has(p) && NAMES[p]);
  const lines = [`${BOT_MARKER} fix report — RuvNet Brain`, '', hi, '',
    `**What was wrong:** ${wrong}`,
    `**What changed:** ${ref} — ${changed}${test ? ` It comes with a new test (\`${test}\`) that fails on the old code and passes now.` : ''}`,
    `**Where it is:** ${where}`];
  if (factsLine) lines.push(factsLine);
  if (missing.length) lines.push(`Our tests ran on macOS and Linux; if you can confirm on ${joinNames(missing.map((p) => NAMES[p]))}, that closes the loop.`);
  lines.push('If it still looks wrong after updating, reply here or open a new issue — a maintainer sees both.', '',
    hiddenMarker({ issueNumber, outcome: kind, version, sha }));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Posting (the only function here that writes to GitHub)
// ---------------------------------------------------------------------------------------------
export function postOutcome(ctx, { issueNumber, body, close = false, addLabels = [] } = {}) {
  if (!Number.isInteger(issueNumber) || issueNumber < 1) throw fail('postOutcome: bad issue number');
  if (typeof body !== 'string' || !body.startsWith(BOT_MARKER)) throw fail('body must begin with the bot marker');
  if (body.startsWith(`${BOT_MARKER} acknowledgment`)) throw fail('body must not impersonate the acknowledgment');
  if (findClosingKeywords(body).length) throw fail('body contains a closing keyword');
  const own = markerEntries([{ author: { login: OWNER_LOGIN }, body }]).map((e) => e.marker);
  if (own.length === 0) throw fail('body lacks the hidden dedupe marker');
  if (own.some((m) => m.issue !== issueNumber)) throw fail('hidden marker names a different issue');
  if (close && own[own.length - 1].outcome !== 'fixed') throw fail('only a fixed comment may close an issue');
  if (!(addLabels || []).every((l) => /^autofix:[a-z-]+$/.test(l))) throw fail('label outside the autofix: namespace');
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(ctx?.repo))) throw fail('bad repo');

  const gh = ctx.ghBin || process.env.GH_BIN || 'gh';
  const base = (...a) => [...a, String(issueNumber), '--repo', ctx.repo];
  const result = { commented: false, closed: false, labeled: false, error: null };
  const step = (args) => {
    try { const r = ctx.exec(gh, args); return r.status === 0 ? null : String(r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 300); }
    catch (e) { if (e?.name === 'AutofixAbort') throw e; return String(e?.message || e).slice(0, 300); }
  };
  let err = step([...base('issue', 'comment'), '--body', body]);
  if (err) return { ...result, error: `comment: ${err}` };
  result.commented = true;
  if (addLabels.length) { err = step([...base('issue', 'edit'), '--add-label', addLabels.join(',')]); if (err) result.error = `label: ${err}`; else result.labeled = true; }
  if (close) { err = step([...base('issue', 'close'), '--reason', 'completed']); if (err) result.error = [result.error, `close: ${err}`].filter(Boolean).join('; '); else result.closed = true; }
  return result;
}
