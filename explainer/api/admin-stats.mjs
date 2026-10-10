// api/admin-stats.js — owner-only usage aggregate for RuvNet Brain (Vercel serverless).
// Modeled on Ruv-Explainer's landing/netlify/functions/admin-stats.js, adapted Netlify → Vercel.
//
// Aggregates, all server-side so no token ever reaches the browser:
//   • GitHub repo reach     — stars / forks / watchers / open issues       (public API)
//   • Release downloads     — per-asset download counts on every release   (public API)
//   • GitHub traffic        — clones + views (count/uniques/14-day daily) and top referrers.
//                             These three REQUIRE an authenticated GITHUB_TOKEN with push access
//                             to stuinfla/ruvnet-brain (classic PAT `repo` scope or fine-grained
//                             "Administration: read"). Unset → those cards degrade honestly.
//   • npm downloads         — api.npmjs.org daily range, last month        (public, no token)
//   • Opt-in telemetry      — the rb:* counters api/ping.js writes to the linked Upstash/KV store.
//
// Auth: fail closed. ADMIN_TOKEN must be set in Vercel env; the same value must arrive as the
// `x-admin-token` header. No env var → 503 (never open). Compared with timingSafeEqual.
// Header only — a ?token= fallback would leak into logs and history.

import crypto from 'node:crypto';

const REPO = 'stuinfla/ruvnet-brain';
const NPM_PKG = 'ruvnet-brain';

function ghHeaders(token) {
  const h = { Accept: 'application/vnd.github+json', 'User-Agent': 'ruvnet-brain-admin' };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function readOpenWork(token) {
  const items = [];
  for (let page = 1; page <= 20; page++) {
    const rows = await ghJson(`/repos/${REPO}/issues?state=open&per_page=100&page=${page}&sort=created&direction=asc`, token);
    if (!Array.isArray(rows)) return { available: false, items: null, note: 'GitHub open-work source unavailable; owner requests and backlog are unknown.' };
    items.push(...rows.map((it) => ({ number: it.number, title: it.title, login: it.user?.login || 'unknown', isPR: Boolean(it.pull_request), url: it.html_url, at: (it.created_at || '').slice(0, 10) })));
    if (rows.length < 100) return { available: true, items, note: 'Complete current open issue and PR inventory from GitHub.' };
  }
  return { available: false, items: null, note: 'Open-work inventory exceeded its page limit; counts are unknown.' };
}

async function ghJson(path, token) {
  try {
    const r = await fetch(`https://api.github.com${path}`, { headers: ghHeaders(token) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// Exported for unit tests: constant-time equality with a length guard (timingSafeEqual throws on
// unequal lengths, which would itself be an oracle — the guard makes unequal length just "false").
function tokenMatches(given, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function kvEnv(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || '';
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || '';
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

// HGETALL over Upstash REST returns { result: [field, value, field, value, ...] } per command.
function hashFromResult(entry) {
  const arr = entry && Array.isArray(entry.result) ? entry.result : [];
  const out = {};
  for (let i = 0; i + 1 < arr.length; i += 2) out[arr[i]] = Number(arr[i + 1]) || 0;
  return out;
}

async function readTelemetry(days) {
  const kv = kvEnv();
  if (!kv) return { configured: false, note: 'No KV/Upstash store linked to the Vercel project yet — opt-in counters will appear once one is (Storage tab → Upstash for Redis).' };
  const dayKeys = [];
  for (let i = 0; i < days; i++) dayKeys.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  const cmds = [['HGETALL', 'rb:totals'], ...dayKeys.map((d) => ['HGETALL', `rb:day:${d}`]), ['HGETALL', 'rb:versions']];
  try {
    const r = await fetch(`${kv.url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${kv.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds),
    });
    if (!r.ok) return { configured: false, note: `counter store answered HTTP ${r.status} — check the KV env vars` };
    const rows = await r.json();
    return {
      configured: true,
      totals: hashFromResult(rows[0]),
      daily: dayKeys.map((d, i) => ({ date: d, ...hashFromResult(rows[1 + i]) })), // newest first
      versions: hashFromResult(rows[rows.length - 1]),
    };
  } catch (e) {
    return { configured: false, note: String((e && e.message) || e) };
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-admin-token');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!process.env.ADMIN_TOKEN) {
    return res.status(503).json({ error: 'Admin access is not configured (set ADMIN_TOKEN in Vercel env) — the admin API stays closed until it is.' });
  }
  if (!tokenMatches(req.headers['x-admin-token'], process.env.ADMIN_TOKEN)) {
    return res.status(401).json({ error: 'Wrong or missing admin token.' });
  }

  const gh = process.env.GITHUB_TOKEN || '';

  const [repo, releases, clones, views, referrers, npmRange, telemetry, issuesRaw, starsRaw, forksRaw, openWork, latestRelease] = await Promise.all([
    ghJson(`/repos/${REPO}`, gh),
    ghJson(`/repos/${REPO}/releases?per_page=20`, gh),
    gh ? ghJson(`/repos/${REPO}/traffic/clones`, gh) : Promise.resolve(null),
    gh ? ghJson(`/repos/${REPO}/traffic/views`, gh) : Promise.resolve(null),
    gh ? ghJson(`/repos/${REPO}/traffic/popular/referrers`, gh) : Promise.resolve(null),
    fetch(`https://api.npmjs.org/downloads/range/last-month/${NPM_PKG}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    readTelemetry(14),
    // People — the REAL engagement signal (public API, works with or without the token). Issue/PR
    // authors doing repeat maintainer-grade work are the strongest proof the tool is actually used;
    // clone/npm counts are bot-inflated and lie. Owner's own activity is filtered out below.
    ghJson(`/repos/${REPO}/issues?state=all&per_page=100&sort=created&direction=desc`, gh),
    ghJson(`/repos/${REPO}/stargazers?per_page=100`, gh),
    ghJson(`/repos/${REPO}/forks?per_page=100&sort=newest`, gh),
    readOpenWork(gh),
    ghJson(`/repos/${REPO}/releases/latest`, gh),
  ]);

  // ── people: group issues+PRs by external author, collect stargazers + forkers ──────────────────
  const OWNER = 'stuinfla';
  const issuesArr = Array.isArray(issuesRaw) ? issuesRaw : [];
  const byAuthor = new Map();
  for (const it of issuesArr) {
    const login = it.user && it.user.login;
    if (!login || login === OWNER) continue;                 // exclude the owner's own threads
    const isPR = Boolean(it.pull_request);
    const e = byAuthor.get(login) || { login, issues: 0, prs: 0, association: 'NONE', items: [] };
    if (isPR) e.prs++; else e.issues++;
    if (/CONTRIBUTOR|MEMBER|COLLABORATOR/.test(it.author_association || '')) e.association = it.author_association;
    e.items.push({ number: it.number, title: it.title, state: it.state, isPR, url: it.html_url, at: (it.created_at || '').slice(0, 10) });
    byAuthor.set(login, e);
  }
  const contributors = [...byAuthor.values()].sort((a, b) => (b.issues + b.prs) - (a.issues + a.prs));
  const stargazers = (Array.isArray(starsRaw) ? starsRaw : []).map((s) => s.login).filter((l) => l && l !== OWNER);
  const forks = (Array.isArray(forksRaw) ? forksRaw : []).map((f) => ({ login: f.owner && f.owner.login, at: (f.created_at || '').slice(0, 10) })).filter((f) => f.login && f.login !== OWNER);
  const engagerSet = new Set([...contributors.map((c) => c.login), ...stargazers, ...forks.map((f) => f.login)]);
  const people = {
    externalEngagers: engagerSet.size,
    totalIssues: issuesArr.filter((i) => !i.pull_request).length,
    totalPRs: issuesArr.filter((i) => i.pull_request).length,
    contributors,
    stargazers,
    forks,
  };

  const npmDaily = npmRange && Array.isArray(npmRange.downloads) ? npmRange.downloads : [];

  const releaseRows = Array.isArray(releases)
    ? releases.map((r) => ({
        tag: r.tag_name,
        name: r.name || r.tag_name,
        publishedAt: r.published_at,
        assets: (r.assets || []).map((a) => ({ name: a.name, downloads: a.download_count || 0, sizeMB: Math.round((a.size || 0) / 1048576) })),
      }))
    : [];
  const totalAssetDownloads = releaseRows.reduce(
    (sum, r) => sum + r.assets.reduce((s, a) => s + a.downloads, 0), 0);

  return res.status(200).json({
    generatedAt: new Date().toISOString(),
    repo: repo
      ? { stars: repo.stargazers_count, forks: repo.forks_count, watchers: repo.subscribers_count, openIssues: repo.open_issues_count }
      : null,
    releases: releaseRows,
    latestRelease: latestRelease ? { tag: latestRelease.tag_name, publishedAt: latestRelease.published_at, assets: (latestRelease.assets || []).map((a) => ({ name: a.name, downloads: a.download_count || 0 })) } : null,
    openWork,
    totalAssetDownloads,
    traffic: {
      configured: Boolean(gh),
      note: gh ? null : 'Set GITHUB_TOKEN (push access to the repo) in Vercel env to unlock clones / views / referrers.',
      // Unique cloners ≈ install-ish machines; the raw clone count is CI-inflated on push days.
      clones: clones ? { count: clones.count, uniques: clones.uniques, daily: clones.clones || [] } : null,
      views: views ? { count: views.count, uniques: views.uniques, daily: views.views || [] } : null,
      referrers: Array.isArray(referrers) ? referrers.map((x) => ({ referrer: x.referrer, count: x.count, uniques: x.uniques })) : null,
    },
    npm: {
      lastWeek: npmDaily.slice(-7).reduce((a, d) => a + d.downloads, 0),
      lastMonth: npmDaily.reduce((a, d) => a + d.downloads, 0),
      daily: npmDaily, // full month for the sparkline
    },
    telemetry,
    people,
    feedback: {
      discussions: `https://github.com/${REPO}/discussions`,
      issues: `https://github.com/${REPO}/issues`,
    },
  });
};

export { tokenMatches, hashFromResult, readOpenWork };
