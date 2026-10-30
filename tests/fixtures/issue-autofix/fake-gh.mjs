#!/usr/bin/env node
// Fixture stand-in for `gh` (ADR-107 simulation). A state machine over the JSON file named by FAKE_GH_STATE;
// every call is appended to FAKE_GH_LOG. Only the subcommands the autofix job uses exist: anything else exits 99,
// so a new, unreviewed gh call fails the simulation instead of silently passing.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const file = process.env.FAKE_GH_STATE;
const st = JSON.parse(fs.readFileSync(file, 'utf8'));
const stdin = argv.includes('--input') ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify({ argv, stdin: stdin || undefined })}\n`);
const nowIso = () => new Date(Date.now() + (st.clockOffsetMs || 0)).toISOString();
const flag = (n) => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
const raw = () => Object.fromEntries(argv.flatMap((a, i) => (a === '--raw-field' ? [argv[i + 1].split(/=(.*)/s).slice(0, 2)] : [])));
const save = () => fs.writeFileSync(file, JSON.stringify(st, null, 2));
const out = (v) => { save(); process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v)); process.exit(0); };
const fail = (code, msg) => { save(); process.stderr.write(`${msg}\n`); process.exit(code); };
const pick = (o, fields) => Object.fromEntries(fields.filter((f) => f in o).map((f) => [f, o[f]]));
const fields = () => (flag('--json') || '').split(',').filter(Boolean);
const [g, s, third] = argv;
const issue = (n) => st.issues.find((i) => i.number === Number(n));
const sha = (branch) => spawnSync('git', ['--git-dir', st.origin, 'rev-parse', `refs/heads/${branch}`], { encoding: 'utf8' }).stdout.trim();

// A dropped connection: every call fails the way gh does when api.github.com is unreachable.
if (st.offline) fail(1, 'error connecting to api.github.com');
if (st.offlineOn && argv.join(' ').startsWith(st.offlineOn)) fail(1, 'error connecting to api.github.com');

if (g === 'variable' && s === 'get') { if (st.variable == null) fail(1, 'HTTP 404: Not Found'); out(`${st.variable}\n`); }
if (g === 'issue' && s === 'list') {
  let l = st.issues.filter((i) => i.state === 'OPEN');
  if (flag('--label')) l = l.filter((i) => i.labels.some((x) => x.name === flag('--label')));
  out(l.map((i) => pick(i, fields())));
}
if (g === 'issue' && s === 'view') { const i = issue(third); if (!i) fail(1, 'not found'); out(pick(i, fields())); }
if (g === 'issue' && s === 'comment') {
  const i = issue(third); i.comments.push({ author: { login: 'stuinfla' }, body: flag('--body'), createdAt: nowIso() });
  i.updatedAt = nowIso(); out('https://github.com/x/y/issues/1#issuecomment-1\n');
}
if (g === 'issue' && s === 'edit') {
  const i = issue(third); for (const l of (flag('--add-label') || '').split(',').filter(Boolean)) i.labels.push({ name: l });
  i.updatedAt = nowIso(); out('');
}
if (g === 'issue' && s === 'close') { const i = issue(third); i.state = 'CLOSED'; i.stateReason = flag('--reason'); out(''); }
if (g === 'pr' && s === 'list') {
  // GitHub marks a PR merged when its head becomes an ancestor of main (a fast-forward push does exactly that).
  for (const p of st.prs.filter((x) => x.state === 'OPEN')) {
    if (spawnSync('git', ['--git-dir', st.origin, 'merge-base', '--is-ancestor', `refs/heads/${p.headRefName}`, 'refs/heads/main']).status === 0) p.state = 'MERGED';
  }
  const m = (flag('--search') || '').match(/^(\d+) in:body/);
  let l = st.prs.filter((p) => p.state === 'OPEN');
  if (flag('--head')) l = l.filter((p) => p.headRefName === flag('--head'));
  if (m) l = l.filter((p) => new RegExp(`\\b${m[1]}\\b`).test(p.body || ''));
  out(l.map((p) => pick(p, fields())));
}
if (g === 'pr' && s === 'create') {
  const number = st.prs.length + 1;
  st.prs.push({ number, headRefName: flag('--head'), title: flag('--title'), body: flag('--body'), state: 'OPEN' });
  out(`https://github.com/stuinfla/ruvnet-brain/pull/${number}\n`);
}
if (g === 'pr' && s === 'checks') {
  if (st.flipVariableOnPrChecks) st.variable = 'off';
  if (st.dropAfterPrChecks) st.offline = true;
  fail(st.prChecks === 'pass' ? 0 : 1, st.prChecks === 'pass' ? '' : 'canonical-qa\tfail');
}
if (g === 'pr' && s === 'close') { st.prs.find((p) => p.number === Number(third)).state = 'CLOSED'; out(''); }
if (g === 'release' && s === 'view') out({ tagName: st.releasesLatest });
if (g === 'workflow' && s === 'run') {
  const f = raw(); const id = 700 + (st.releaseRuns || []).length;
  const ok = st.releaseOutcome === 'success';
  (st.releaseRuns ||= []).push({ databaseId: id, displayTitle: `protected-release ${f.mode} ${f.version}`, createdAt: nowIso(), status: 'completed',
    conclusion: ok ? 'success' : 'failure', headSha: f.candidate_sha, candidate: f.candidate_sha,
    jobs: [{ name: 'publish', conclusion: ok ? 'success' : 'failure' }, { name: 'finalize-public-verification', conclusion: ok ? 'success' : 'skipped' }] });
  if (st.publishOnRelease) { st.npmLatest = f.version; st.releasesLatest = `v${f.version}`; }
  out('');
}
if (g === 'run' && s === 'list') {
  const wf = flag('--workflow');
  if (flag('--status')) out((st.activeRuns || []).filter((r) => r.workflow === wf && r.status === flag('--status')).map((r) => ({ databaseId: r.id, status: r.status })));
  if (wf === 'release-candidate-preflight.yml') {
    if (st.preflight === 'none') out([]);
    out([{ databaseId: 500, headSha: sha(flag('--branch')), status: 'completed', conclusion: st.preflight }]);
  }
  if (wf === 'protected-release.yml') out((st.releaseRuns || []).map((r) => pick(r, fields())));
  out([]);
}
if (g === 'run' && s === 'watch') {
  const id = Number(third); const r = id === 500 ? { conclusion: st.preflight } : st.releaseRuns.find((x) => x.databaseId === id);
  fail(r.conclusion === 'success' ? 0 : 1, '');
}
if (g === 'run' && s === 'view') {
  const id = Number(third);
  if (id === 500) out(pick({ status: 'completed', conclusion: st.preflight, headSha: sha(st.preflightBranch || `release/${st.nextVersion}`) }, fields()));
  out(pick(st.releaseRuns.find((x) => x.databaseId === id), fields()));
}
if (g === 'api') {
  const path = s;
  if (/actions\/runs\/\d+\/artifacts$/.test(path)) {
    const run = st.releaseRuns.find((r) => `repos/stuinfla/ruvnet-brain/actions/runs/${r.databaseId}/artifacts` === path);
    out({ artifacts: st.artifacts === false ? [] : [{ id: 4242, name: `publication-evidence-${run?.candidate}`, expired: false }] });
  }
  if (/\/dispatches$/.test(path)) { (st.dispatches ||= []).push(JSON.parse(stdin)); out(''); }
}
fail(99, `fake-gh: unsupported call: gh ${argv.join(' ')}`);
