#!/usr/bin/env node
/**
 * check-indexation.mjs — POSITIVE index-status confirmation for RuvNet-Brain's SEO surfaces.
 *
 * Why this exists: "indexable" is a passive assumption; "indexed" is a live fact. This probe
 * replaces the assumption with a check you can run any time. It NEVER infers "indexed" from
 * HTTP health alone — serving-ready is necessary but NOT sufficient for indexed.
 *
 * For each target it reports three independent facts:
 *   1. SERVING  — does the URL return 200 (or a clean redirect), with a self-canonical and no noindex?
 *   2. BING     — does a live `site:` query on Bing return the URL? (scrape; may be challenged)
 *   3. GOOGLE   — best-effort `site:` on Google. Datacenter IPs are often challenged → "inconclusive".
 *                 AUTHORITATIVE Google status needs Search Console; see GSC note below.
 *
 * Ground-truth upgrade path: set GSC_ACCESS_TOKEN (a Search Console OAuth token with the
 * webmasters.readonly scope) and this probe will call the URL Inspection API for a definitive
 * Google verdict instead of scraping. Until then Google is best-effort and labeled as such.
 *
 * Usage:  node scripts/check-indexation.mjs
 * Exit:   0 always (it's a report, not a gate). Parse the printed table.
 */

const TARGETS = [
  'https://isovision.ai/ruvnet-brain/',
  'https://github.com/stuinfla/ruvnet-brain',
  'https://ruvnet-brain.vercel.app/',
];

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const CHALLENGE = /captcha|unusual traffic|verify you are|challenge|are you a robot/i;

async function serving(url) {
  try {
    const res = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': UA } });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) return { ok: true, note: `${res.status}→ ${loc}` };
    if (res.status !== 200) return { ok: false, note: `HTTP ${res.status}` };
    const html = await res.text();
    const canonical = (html.match(/<link[^>]+rel=["']canonical["'][^>]*>/i) || [''])[0];
    const noindex = /content=["'][^"']*noindex/i.test(html) || res.headers.get('x-robots-tag')?.includes('noindex');
    const selfCanon = canonical.includes(url.replace(/\/$/, '')) || canonical.includes(url);
    return { ok: !noindex, note: `200${noindex ? ' ⚠NOINDEX' : ''}${selfCanon ? ' canon=self' : canonical ? ' canon=other' : ' no-canon'}` };
  } catch (e) {
    return { ok: false, note: `unreachable: ${e.message}` };
  }
}

async function siteQuery(engine, url) {
  const host = new URL(url).host;
  const path = new URL(url).pathname.replace(/\/$/, '');
  const q = encodeURIComponent(`site:${host}${path}`);
  const endpoint =
    engine === 'bing' ? `https://www.bing.com/search?q=${q}` : `https://www.google.com/search?q=${q}`;
  try {
    const res = await fetch(endpoint, { headers: { 'User-Agent': UA } });
    const body = await res.text();
    if (CHALLENGE.test(body) || res.status !== 200) return 'inconclusive (bot-challenged)';
    // Heuristic: an indexed result links back to the host+path somewhere in the results markup.
    const needle = `${host}${path}`.toLowerCase();
    const hits = (body.toLowerCase().match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    const noResults = /did not match any documents|no results found|there are no results/i.test(body);
    if (noResults) return 'NOT indexed';
    return hits > 1 ? 'INDEXED' : 'NOT indexed';
  } catch (e) {
    return `inconclusive (${e.message})`;
  }
}

async function gscInspect(url) {
  const token = process.env.GSC_ACCESS_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inspectionUrl: url, siteUrl: `sc-domain:${new URL(url).host}` }),
    });
    const j = await res.json();
    const v = j?.inspectionResult?.indexStatusResult?.verdict;
    return v ? `GSC(authoritative): ${v}` : `GSC: ${JSON.stringify(j).slice(0, 120)}`;
  } catch (e) {
    return `GSC error: ${e.message}`;
  }
}

(async () => {
  const stamp = new Date().toISOString();
  console.log(`\n  RuvNet-Brain indexation probe — ${stamp}`);
  console.log('  (SERVING = necessary; INDEXED = the fact that matters)\n');
  for (const url of TARGETS) {
    const [srv, bing, google, gsc] = await Promise.all([
      serving(url),
      siteQuery('bing', url),
      siteQuery('google', url),
      gscInspect(url),
    ]);
    console.log(`  ${url}`);
    console.log(`    SERVING : ${srv.ok ? '✓' : '✗'} ${srv.note}`);
    console.log(`    BING    : ${bing}`);
    console.log(`    GOOGLE  : ${gsc || google + '  (best-effort; set GSC_ACCESS_TOKEN for authoritative)'}`);
    console.log('');
  }
  console.log('  Reminder: the fastest way to a definitive Google YES is Search Console →');
  console.log('  URL Inspection → Request Indexing (needs a Google login). Everything else is latency.\n');
})();
