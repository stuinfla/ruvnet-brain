// The section assembler: turns each lane's ranked passages into one result section. Per section:
// the first `maxItems` distinct files; each excerpt a window of that file's passages centred on its
// best passage, up to the section's `itemChars`; the section within its `budgetChars`; then every
// excerpt of the result within `result.capChars`. A passage is sent at most once per result.
import crypto from 'node:crypto';
import path from 'node:path';
import { estimateTokens } from '../contract/delivery.mjs';

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const perDetail = (v, detail) => (v && typeof v === 'object' ? v[detail] : v);

/** The fixed closing line: which kind of source outranks which when sources disagree. */
export const AUTHORITY_ORDER =
  'When sources disagree: code that exists outranks a measured result, which outranks a correction or negative result, then a decision record, then a README claim, then a plan, then an essay.';

// A passage cited by line range is quoted as exactly those source lines (its header is already in the
// citation line); an item with no line range (a history item) is quoted with its header first, since
// the header carries its kind, reference, date and title.
const textOf = (r) => (r.start_line == null && r.header && !r.text.startsWith(r.header) ? `${r.header}\n${r.text}` : r.text);

/** True when every passage of `take` is source lines quoted line for line, in order. */
function verbatim(take) {
  return take.every((r, k) => r.start_line != null && r.end_line - r.start_line + 1 === r.text.split('\n').length && (k === 0 || r.start_line >= take[k - 1].end_line));
}

/** The excerpt of a window. Line-cited passages are joined so the excerpt spans exactly their line
 *  range: lines between two passages (the builder leaves only blank lines out of passages) come back
 *  as empty lines, and the next piece of a split over-long line continues the same line. */
function joinTake(take) {
  if (!verbatim(take)) return take.map(textOf).join('\n');
  return take.map((r, k) => (k === 0 ? '' : '\n'.repeat(Math.max(0, r.start_line - take[k - 1].end_line))) + r.text).join('');
}

/** Cuts text to at most n characters, at a line break when one is in the second half. */
function cut(text, n) {
  if (text.length <= n) return text;
  if (n <= 0) return '';
  const at = text.lastIndexOf('\n', n);
  return text.slice(0, at > n / 2 ? at : n);
}

function standingOf(r, recipe) {
  if (r.standing) return r.standing;
  const st = recipe.standing;
  if (r.kind && st.byKind?.[r.kind]) return st.byKind[r.kind];
  return st.docExtensions.includes(path.extname(r.path).toLowerCase()) ? st.doc : st.code;
}

/** Window of passages around rows[i]: alternately one before and one after while it fits. */
function windowAround(rows, i, limit, used) {
  const take = [rows[i]];
  let size = textOf(rows[i]).length;
  let lo = i - 1;
  let hi = i + 1;
  let openLo = true;
  let openHi = true;
  const fits = (r) => !used.has(sha(r.text)) && size + 1 + textOf(r).length <= limit;
  while ((openLo && lo >= 0) || (openHi && hi < rows.length)) {
    if (openLo && lo >= 0) {
      if (fits(rows[lo])) (take.unshift(rows[lo]), (size += 1 + textOf(rows[lo]).length), lo--);
      else openLo = false;
    } else openLo = false;
    if (openHi && hi < rows.length) {
      if (fits(rows[hi])) (take.push(rows[hi]), (size += 1 + textOf(rows[hi]).length), hi++);
      else openHi = false;
    } else openHi = false;
  }
  return take;
}

function makeItem(best, take, limit, recipe, sourceOf) {
  let excerpt = joinTake(take);
  const start = take[0].start_line ?? 1;
  let end = take.at(-1).end_line ?? start + excerpt.split('\n').length - 1;
  const whole = excerpt.length;
  if (limit && excerpt.length > limit) excerpt = cut(excerpt, limit);
  // Raw text that maps line for line onto the file keeps an exact line range after a cut.
  const exact = verbatim(take);
  if (exact) end = start + excerpt.split('\n').length - 1;
  const src = sourceOf(best.repo);
  return {
    repo: best.repo,
    path: best.path,
    lines: { start, end: Math.max(start, end) },
    hash: sha(excerpt),
    standing: standingOf(best, recipe),
    date: best.date ?? src?.date ?? null,
    commit: best.commit_id ?? src?.commit ?? 'unknown',
    score: best.score,
    // The builder flags text matching a known prompt-injection form (flag = 'hostile'); an excerpt
    // that quotes any flagged passage carries the flag, so the caller can label it.
    flag: take.some((t) => t.flag === 'hostile') ? 'hostile' : null,
    excerpt,
    ...(whole > excerpt.length ? { trimmed: whole - excerpt.length } : {}),
    exact,
  };
}

/** Shortens excerpts evenly (water-filling) until their total is within `budget`. */
export function fit(items, budget) {
  const total = items.reduce((n, it) => n + it.excerpt.length, 0);
  if (total <= budget) return;
  const sizes = items.map((it) => it.excerpt.length).sort((a, b) => a - b);
  let left = budget;
  let allow = 0;
  for (let k = 0; k < sizes.length; k++) {
    const share = Math.floor(left / (sizes.length - k));
    if (sizes[k] > share) {
      allow = share;
      break;
    }
    left -= sizes[k];
    allow = sizes[k];
  }
  for (const it of items) {
    if (it.excerpt.length <= allow) continue;
    const before = it.excerpt.length;
    it.excerpt = cut(it.excerpt, allow);
    it.trimmed = (it.trimmed ?? 0) + before - it.excerpt.length;
    it.hash = sha(it.excerpt);
    if (it.exact) it.lines.end = Math.max(it.lines.start, it.lines.start + it.excerpt.split('\n').length - 1);
  }
}

/** The recipe's delivery numbers (contract 1.1), when it names them: the excerpts of one result within
 *  maxChars in all and within maxTokens estimated over their joined text. A recipe without them (any
 *  contract-v1 recipe) is left to the server's guard. */
export function holdToDelivery(items, delivery) {
  if (!delivery) return;
  if (delivery.maxChars) fit(items, delivery.maxChars);
  for (let i = 0; delivery.maxTokens && i < 20; i++) {
    const text = items.map((it) => it.excerpt).join('\n');
    const t = estimateTokens(text);
    if (t <= delivery.maxTokens) return;
    fit(items, Math.floor((text.length * delivery.maxTokens) / t) - items.length);
  }
}

/** Builds one section from a lane's ranked rows. `used` holds passage hashes already sent. */
export function section({ sec, lane, laneImpl, rows, detail, recipe, sourceOf, used }) {
  const limit = perDetail(sec.itemChars, detail);
  const items = [];
  const files = new Set();
  for (const r of rows) {
    if (items.length >= sec.maxItems) break;
    const key = `${r.repo}/${r.path}`;
    const h = sha(r.text);
    if (files.has(key) || used.has(h)) continue;
    files.add(key);
    let take = [r];
    if (limit) {
      const all = laneImpl.fileRows(lane, r.repo, r.path);
      const i = all.findIndex((x) => x.id === r.id);
      if (i >= 0) take = windowAround(all, i, limit, used);
    }
    for (const t of take) used.add(sha(t.text));
    items.push(makeItem(r, take, limit, recipe, sourceOf));
  }
  const budget = perDetail(sec.budgetChars, detail);
  if (budget) fit(items, budget);
  return items;
}

/** Removes engine-internal fields before the result leaves the engine. */
export function publicItem({ exact, ...it }) {
  return it;
}
