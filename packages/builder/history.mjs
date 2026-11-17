// The history lane's units (RECIPE-FINAL 2.1), ported from the measured run's
// candidates/history/fetch.mjs + passages.mjs: one unit per commit (any author), and per issue, pull
// request, comment and release note written by the repository owner, split at the recipe's character bound, header
// `repo › history › kind ref › date › title`.
//
// The reader sits behind one interface, `get(apiPath) -> array page` (read-only calls to the hosting
// API's REST paths). In CI the release rail supplies a network `get`; this package ships only the
// recorded one, which serves pages saved as <dir>/<endpoint>-<page>.json, so tests make no network call.
import fs from 'node:fs';
import path from 'node:path';

const ENDPOINTS = {
  commits: (o, r, pp, p) => `repos/${o}/${r}/commits?per_page=${pp}&page=${p}`,
  issues: (o, r, pp, p) => `repos/${o}/${r}/issues?state=all&creator=${o}&per_page=${pp}&page=${p}`,
  comments: (o, r, pp, p) => `repos/${o}/${r}/issues/comments?per_page=${pp}&page=${p}`,
  releases: (o, r, pp, p) => `repos/${o}/${r}/releases?per_page=${pp}&page=${p}`,
};

/** A `get` over recorded pages: `repos/o/r/issues/comments?...&page=2` -> <dir>/comments-2.json. */
export function recordedGet(dir) {
  return (apiPath) => {
    const m = apiPath.match(/^repos\/[^/]+\/[^/]+\/((?:issues\/)?[a-z]+)\?(?:.*&)?page=(\d+)/);
    if (!m) throw new Error(`not a history API path: ${apiPath}`);
    const file = path.join(dir, `${m[1].replace('issues/', '')}-${m[2]}.json`);
    if (!fs.existsSync(file)) return [];
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(rows)) throw new Error(`${file} is not a page (array)`);
    return rows;
  };
}

/** All pages of every endpoint for one repository. */
export async function readHistory({ owner, repo, get, perPage }) {
  const out = {};
  for (const [name, url] of Object.entries(ENDPOINTS)) {
    out[name] = [];
    for (let page = 1; ; page++) {
      const rows = await get(url(owner, repo, perPage, page));
      if (!Array.isArray(rows)) throw new Error(`history page ${name} ${page} for ${repo} is not a list`);
      out[name].push(...rows);
      if (rows.length < perPage) break;
    }
  }
  return out;
}

function splitText(text, max) {
  const paras = text.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const pieces = [];
  let cur = '';
  const push = () => {
    if (cur.trim()) pieces.push(cur.trim());
    cur = '';
  };
  for (let p of paras) {
    while (p.length > max) {
      let cut = p.lastIndexOf('\n', max);
      if (cut < max * 0.5) cut = p.lastIndexOf(' ', max);
      if (cut < max * 0.5) cut = max;
      if (cur) push();
      pieces.push(p.slice(0, cut).trim());
      p = p.slice(cut).trim();
    }
    if (!p) continue;
    if (cur && cur.length + 2 + p.length > max) push();
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  push();
  return pieces;
}

const day = (d) => String(d || '').slice(0, 10);

/**
 * Items -> units { kind, ref, date, title, header, path, piece, text }. Every commit is kept; an
 * issue, pull request, comment or release not written by `owner` is dropped and only counted.
 * `screen(text) -> { text, hits: [{ line, rule }] }` is the recipe's secret screen. It runs on each
 * WHOLE item (its title and its text) before the item is split or its header is made, so a secret
 * longer than one unit, or one the split would cut in two, is still found (Codex review F03).
 * Returns { units, dropped, secrets: [{ path, line, rule }] }.
 */
export function historyUnits(raw, { repo, owner, cfg, screen = (text) => ({ text, hits: [] }) }) {
  const dropped = { notOwner: 0, empty: 0, short: 0, merge: 0 };
  const units = [];
  const secrets = [];
  const used = new Map();
  const isOwner = (login) => typeof login === 'string' && login.toLowerCase() === owner.toLowerCase();
  const emit = (kind, ref0, date, rawTitle, rawText) => {
    const key = `${kind}:${ref0}`;
    const n = (used.get(key) ?? 0) + 1;
    used.set(key, n);
    const ref = n > 1 ? `${ref0}~${n}` : String(ref0);
    const where = `history/${kind}/${ref}`;
    const t = screen(String(rawTitle ?? ''));
    const b = screen(String(rawText ?? '').replace(/\r\n?/g, '\n'));
    // A title is usually the text's first line (commit subject, issue or release title): its secrets
    // are then the text's, recorded once.
    const titleInText = String(rawText ?? '').startsWith(String(rawTitle ?? ''));
    for (const h of [...(titleInText ? [] : t.hits), ...b.hits]) secrets.push({ path: where, line: h.line, rule: h.rule });
    const title = t.text;
    const shownRef = kind === 'commit' ? ref.slice(0, 10) : ref;
    const header = [repo, 'history', `${kind} ${shownRef}`, day(date), title].join(cfg.separator).replace(/\s+/g, ' ').slice(0, 300);
    splitText(b.text, cfg.splitChars).forEach((x, piece) => units.push({ kind, ref, date: day(date), title, header, path: where, piece, text: x }));
  };
  // Commits are repository content: kept whoever (or whatever bot) wrote them, as the measured run did.
  for (const c of raw.commits) {
    const msg = String(c.commit?.message ?? '').trim();
    const subject = msg.split('\n')[0];
    if (msg.length < cfg.minCommitChars) {
      dropped.short++;
      continue;
    }
    const versionOnly = msg.length < cfg.versionCommitMaxChars && cfg.versionCommitSubjects.some((re) => re.test(subject));
    if (versionOnly || cfg.skipCommitSubjects.some((re) => re.test(subject))) {
      dropped.merge++;
      continue;
    }
    emit('commit', c.sha, c.commit?.author?.date, subject, msg);
  }
  for (const i of raw.issues) {
    if (!isOwner(i?.user?.login)) {
      dropped.notOwner++;
      continue;
    }
    if (!String(i.body ?? '').trim()) {
      dropped.empty++;
      continue;
    }
    emit(i.pull_request ? 'pr' : 'issue', i.number, i.created_at, i.title, `${i.title}\n\n${i.body}`);
  }
  for (const c of raw.comments) {
    if (!isOwner(c?.user?.login)) {
      dropped.notOwner++;
      continue;
    }
    if (!String(c.body ?? '').trim()) {
      dropped.empty++;
      continue;
    }
    const issue = String(c.issue_url ?? '').split('/').pop();
    emit('comment', `${issue}#${c.id}`, c.created_at, `comment on #${issue}`, c.body);
  }
  for (const r of raw.releases) {
    if (!isOwner(r?.author?.login)) {
      dropped.notOwner++;
      continue;
    }
    if (String(r.body ?? '').length <= cfg.minReleaseBodyChars) {
      dropped.short++;
      continue;
    }
    emit('release', r.tag_name, r.published_at, r.name || r.tag_name, `${r.name || r.tag_name}\n\n${r.body}`);
  }
  const kept = units.filter((u) => cfg.kinds.includes(u.kind));
  const keptPaths = new Set(kept.map((u) => u.path));
  return { units: kept, dropped, secrets: secrets.filter((x) => keptPaths.has(x.path)) };
}
