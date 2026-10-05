// Adoption and telemetry observations. Unmeasured performance is unavailable.
// This endpoint does not calculate the product North Star rubric.

const REPO = 'stuinfla/ruvnet-brain';
const NPM_PKG = 'ruvnet-brain';

function ghHeaders(token) {
  const h = { Accept: 'application/vnd.github+json', 'User-Agent': 'ruvnet-brain-metrics' };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function ghJson(path, token) {
  try {
    const r = await fetch(`https://api.github.com${path}`, { headers: ghHeaders(token), signal: AbortSignal.timeout(8000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

function kvEnv(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || '';
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || '';
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

// HGETALL over Upstash REST returns { result: [field, value, field, value, ...] }
function hashFromResult(entry) {
  const arr = entry?.result;
  if (!Array.isArray(arr) || arr.length % 2) return null;
  const out = {};
  for (let i = 0; i + 1 < arr.length; i += 2) {
    const value = Number(arr[i + 1]);
    if (typeof arr[i] !== 'string' || !Number.isFinite(value) || value < 0) return null;
    Object.defineProperty(out, arr[i], { value, enumerable: true });
  }
  return out;
}

// Read telemetry counters from Upstash
async function readTelemetryData() {
  const kv = kvEnv();
  if (!kv) return null;

  try {
    const cmds = [
      ['HGETALL', 'rb:totals'],
      ['HGETALL', `rb:day:${new Date().toISOString().slice(0, 10)}`],
    ];

    const r = await fetch(`${kv.url}/pipeline`, {
      method: 'POST', signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${kv.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds),
    });

    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows)) return null;
    const totals = hashFromResult(rows[0]);
    const today = hashFromResult(rows[1]);
    return totals && today ? { totals, today } : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Cache-Control', 'max-age=300, public');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });

  const npmUrl = `https://api.npmjs.org/downloads/range/last-month/${NPM_PKG}`;
  const [repo, npmData, telemetry] = await Promise.all([
    ghJson(`/repos/${REPO}`, process.env.GITHUB_TOKEN || ''),
    fetch(npmUrl, { signal: AbortSignal.timeout(8000) })
      .then(r => r.ok ? r.json() : null).catch(() => null),
    readTelemetryData(),
  ]);
  const generatedAt = new Date().toISOString();
  const daily = Array.isArray(npmData?.downloads)
    ? npmData.downloads.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d?.day)
      && Number.isFinite(d.downloads) && d.downloads >= 0) : null;
  const repoAvailable = Number.isFinite(repo?.stargazers_count)
    && Number.isFinite(repo?.forks_count) && Number.isFinite(repo?.open_issues_count);
  const npmAvailable = daily !== null && daily.length > 0;
  const observation = (available, source, period = null) => ({
    status: available ? 'observed' : 'unavailable', source,
    checkedAt: generatedAt, cacheMaxAgeSeconds: 300, period,
  });
  return res.status(200).json({
    ok: true, timestamp: generatedAt,
    data: {
      generatedAt,
      sources: {
        github: observation(repoAvailable, `https://api.github.com/repos/${REPO}`),
        npm: observation(npmAvailable, npmUrl, npmAvailable
          ? { start: daily[0].day, end: daily.at(-1).day } : null),
        telemetry: observation(telemetry !== null, 'Configured Upstash counters'),
      },
      repo: repoAvailable ? {
        stars: repo.stargazers_count, forks: repo.forks_count, openIssues: repo.open_issues_count,
      } : null,
      npm: npmAvailable ? {
        thisWeek: daily.slice(-7).reduce((a, d) => a + d.downloads, 0),
        thisMonth: daily.reduce((a, d) => a + d.downloads, 0), daily,
      } : null,
      telemetry,
      performance: { status: 'unavailable', reason: 'No monitoring measurements connected',
        uptime: null, errorRate: null, latency: null, requestsPerSecond: null },
      trends: npmAvailable ? daily.map(d => ({ date: d.day, downloads: d.downloads })) : [],
    },
  });
}
