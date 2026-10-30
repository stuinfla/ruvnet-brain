// issue-autofix-deploy.test.mjs — ADR-107 batch B: the launchd job, its registry entry and the pager rule all
// agree with each other, and the daily job cannot drift into the 30-minute read-only job's contract.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { JOB_BUDGET_MS } from '../../scripts/issue-autofix.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const LABEL = 'com.ruvnet.issue-autofix';
const PLIST = read(`deploy/${LABEL}.plist`);
const registry = JSON.parse(read('config/scheduled-jobs.json'));
const job = (label) => registry.jobs.find((j) => j.label === label);

// A tiny plist reader for this one flat shape (no dependency, works on every OS).
function parsePlist(xml) {
  const body = xml.replace(/<!--[\s\S]*?-->/g, '');
  const tokens = [...body.matchAll(/<(\/?)(dict|array|key|string|integer|true|false)\s*(\/?)>([^<]*)/g)];
  let i = 0;
  const value = () => {
    const [, close, tag, selfClose, text] = tokens[i++];
    if (close) throw new Error(`unexpected </${tag}>`);
    if (tag === 'true') return true;
    if (tag === 'false') return false;
    if (tag === 'string') { const t = text; i++; return t.replace(/&amp;/g, '&'); }
    if (tag === 'integer') { const t = Number(text); i++; return t; }
    if (tag === 'array') { const a = []; while (!(tokens[i][1] && tokens[i][2] === 'array')) a.push(value()); i++; return a; }
    if (tag === 'dict') {
      const d = {};
      while (!(tokens[i][1] && tokens[i][2] === 'dict')) { const key = tokens[i][4]; i += 2; d[key] = value(); }
      i++; return d;
    }
    throw new Error(`unsupported <${tag}${selfClose}>`);
  };
  while (tokens[i][2] !== 'dict') i++;
  return value();
}
const plist = parsePlist(PLIST);

describe('com.ruvnet.issue-autofix.plist', () => {
  it('is well-formed (plutil where available)', () => {
    const r = spawnSync('plutil', ['-lint', path.join(ROOT, `deploy/${LABEL}.plist`)], { encoding: 'utf8' });
    if (r.error) return; // no plutil off macOS; parsePlist below still reads the whole file
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
  it('label matches the file name and the registry', () => {
    expect(plist.Label).toBe(LABEL);
    expect(job(LABEL)).toBeTruthy();
  });
  it('runs the heartbeat wrapper around issue-fix.mjs --mode autofix, in that order', () => {
    const [sh, wrapper, label, dashes, node, script, ...mode] = plist.ProgramArguments;
    expect(sh).toBe('/bin/sh');
    expect(wrapper).toMatch(/\/scripts\/job-heartbeat\.sh$/);
    expect(label).toBe(LABEL);
    expect(dashes).toBe('--');
    expect(node).toMatch(/\/node$/);
    expect(script).toMatch(/\/scripts\/issue-fix\.mjs$/);
    expect(mode).toEqual(['--mode', 'autofix']);
    expect(path.basename(wrapper)).toBe('job-heartbeat.sh');
    expect(plist.ProgramArguments.join(' ')).not.toMatch(/dry-run|simulate/);
  });
  it('fires once a day at 10:30 local, never on an interval, and never at load', () => {
    expect(plist.StartCalendarInterval).toEqual({ Hour: 10, Minute: 30 });
    expect(plist).not.toHaveProperty('StartInterval');
    expect(PLIST).not.toMatch(/StartInterval/);
    expect(plist.RunAtLoad).toBe(false);
    expect(plist.ProcessType).toBe('Background');
  });
  it('gives the wrapper the 10-hour run budget (the registry maxRunHours), not the 2-hour default', () => {
    expect(plist.EnvironmentVariables.JOB_MAX_SECONDS).toBe(String(10 * 3600)); // 10 h, derived rather than spelled
    expect(Number(plist.EnvironmentVariables.JOB_MAX_SECONDS)).toBe(job(LABEL).maxRunHours * 3600);
  });
  it('its PATH reaches claude (~/.local/bin) and gh (homebrew) but is a fixed list, and HOME is set', () => {
    const parts = plist.EnvironmentVariables.PATH.split(':');
    const home = plist.EnvironmentVariables.HOME;
    expect(home).toMatch(/^\/(Users|home)\/[^/]+$/);
    expect(parts).toEqual([`${home}/.local/bin`, `${home}/.npm-global/bin`, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']);
  });
  it('carries no secret and does not arm itself (the kill switch stays in GitHub, off by default)', () => {
    expect(Object.keys(plist.EnvironmentVariables).sort()).toEqual(['HOME', 'JOB_MAX_SECONDS', 'PATH']);
    expect(PLIST).not.toMatch(/ISSUE_AUTOFIX\s*<|ANTHROPIC|GH_TOKEN|GITHUB_TOKEN|api[_-]?key/i);
  });
  it('logs go to logs/issue-autofix.{out,err}.log', () => {
    expect(plist.StandardOutPath).toMatch(/\/logs\/issue-autofix\.out\.log$/);
    expect(plist.StandardErrorPath).toMatch(/\/logs\/issue-autofix\.err\.log$/);
    // every path in the plist hangs off the same checkout the scripts are read from
    const checkout = plist.WorkingDirectory;
    for (const p of [plist.ProgramArguments[1], plist.ProgramArguments[5], plist.StandardOutPath, plist.StandardErrorPath]) expect(p.startsWith(`${checkout}/`)).toBe(true);
  });
  it('the heartbeat wrapper it names exists and honours JOB_MAX_SECONDS', () => {
    expect(fs.existsSync(path.join(ROOT, 'scripts/job-heartbeat.sh'))).toBe(true);
    expect(read('scripts/job-heartbeat.sh')).toMatch(/JOB_MAX_SECONDS/);
  });
});

describe('config/scheduled-jobs.json', () => {
  it('registers the daily job exactly as the watchdog needs it', () => {
    expect(job(LABEL)).toMatchObject({ label: LABEL, schedule: 'daily 10:30', maxAgeHours: 26, maxRunHours: 10, required: true });
    expect(job(LABEL).what).toMatch(/ISSUE_AUTOFIX is exactly on/);
    expect(job(LABEL).what).toMatch(/halts itself/);
    expect(registry.jobs.filter((j) => j.label === LABEL)).toHaveLength(1);
  });
  it('a 26 h staleness budget covers a skipped day without paging, and a 10 h run limit exceeds the 9.5 h internal deadline', () => {
    expect(job(LABEL).maxAgeHours).toBeGreaterThan(24);
    expect(job(LABEL).maxRunHours * 3_600_000).toBeGreaterThan(JOB_BUDGET_MS);
  });
  it('the 30-minute job stays read-only and points at the daily one; the old phrases the safety test needs remain', () => {
    const fix = job('com.ruvnet.issue-fix');
    expect(fix.what).toMatch(/read-only triage/i);
    expect(fix.what).toMatch(/no branch push/i);
    expect(fix.what).toMatch(/no public comment/i);
    expect(fix.what).toContain('com.ruvnet.issue-autofix');
    expect(fix.what).not.toMatch(/auto-fixes/i);
    expect(read('deploy/com.ruvnet.issue-fix.plist')).toContain('<string>unattended</string>');
  });
});

describe('the pager rule (scripts/ntfy-inbox.mjs classify)', () => {
  it('the titles the job sends are the ones the reader recognises', async () => {
    const { classify } = await import('../../scripts/ntfy-inbox.mjs');
    const m = (title) => classify({ id: 'x', title, priority: 5 });
    expect(m('AUTOFIX HALTED v4.7.23 at S11')).toMatchObject({ kind: 'autofix', key: 'autofix:halt', actionable: true });
    expect(m('AUTOFIX ABORTED #12 at S8')).toMatchObject({ kind: 'autofix', key: 'autofix:12', number: 12, actionable: true });
    expect(m('AUTOFIX SHIPPED v4.7.23')).toMatchObject({ kind: 'autofix', outcome: 'shipped', actionable: false });
    expect(m('AUTOFIX SECURITY HOLD #12')).toMatchObject({ kind: 'autofix', key: 'autofix:security:12', number: 12, actionable: true });
    expect(m('AUTOFIX SECURITY HOLD: night release v4.7.23 blocked')).toMatchObject({ key: 'autofix:security:night', actionable: true });
    expect(m('AUTOFIX PAUSED v4.7.23 at S11')).toMatchObject({ key: 'autofix:paused', actionable: true });
    expect(m('AUTOFIX STOPPED at S5')).toMatchObject({ key: 'autofix:stopped', actionable: false });
    expect(m('AUTOFIX NEEDS OWNER: write a personal thank-you to @alice')).toMatchObject({ kind: 'autofix', actionable: true });
  });

  it('every page title the job can send is classified (no title falls through to "unknown")', async () => {
    const { classify } = await import('../../scripts/ntfy-inbox.mjs');
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../scripts');
    const titles = new Set();
    for (const f of fs.readdirSync(dir).filter((n) => /^issue-autofix.*\.mjs$/.test(n))) {
      for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/[`'"](AUTOFIX [A-Z][A-Z -]+)/g)) titles.add(m[1].trim());
    }
    expect(titles.size).toBeGreaterThan(6);
    for (const t of titles) expect(classify({ id: 'x', title: `${t} #1`, priority: 3 }).kind, t).toBe('autofix');
  });
});

describe('the job cannot change its own code (the runner advances to released tags)', () => {
  it('every file in the import closure of what launchd runs is outside the editable allowlist', async () => {
    const { isEditablePath } = await import('../../scripts/issue-autofix-security.mjs');
    const { isProtectedPath } = await import('../../scripts/issue-autofix-policy.mjs');
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const seen = new Set(); const queue = ['scripts/issue-fix.mjs', 'scripts/issue-autofix-selftest.mjs', 'scripts/issue-autofix-runner.mjs', 'scripts/job-heartbeat.sh', 'scripts/notify.sh'];
    while (queue.length) {
      const rel = queue.shift();
      if (seen.has(rel)) continue;
      seen.add(rel);
      if (!rel.endsWith('.mjs')) continue;
      const src = fs.readFileSync(path.join(root, rel), 'utf8');
      for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) queue.push(path.relative(root, path.resolve(root, path.dirname(rel), m[1])));
    }
    expect(seen.size).toBeGreaterThan(20);
    const editable = [...seen].filter((f) => isEditablePath(f).ok && !isProtectedPath(f));
    expect(editable, 'files the job could rewrite and then run').toEqual([]);
  });
});

