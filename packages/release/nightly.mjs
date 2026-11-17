// The nightly dispatcher's decision, its one retry, and the watchdog (architecture 2.5 step 6), as
// pure functions of recorded run evidence and the time. `gather` reads that evidence with `gh`
// (read-only: run list and the outcome artifact each night uploads).
//   A run is { id, status, conclusion, createdAt, updatedAt, outcome } where outcome is the night's
//   own answer (published, no-change) read from its artifact, or null when it left none.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { RAIL } from './checks.mjs';

const HOUR = 3_600_000;
const good = (r) => RAIL.goodOutcomes.includes(r.outcome);
const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' });
export const eastern = (ms) => ET.format(new Date(ms));

/** The night's runs: those created in the last `nightHours`. */
const tonight = (runs, now) => runs.filter((r) => now - Date.parse(r.createdAt) < RAIL.nightHours * HOUR);

/**
 * Whether to dispatch a release-candidate run now. Armed only when the kill-switch variable is
 * exactly its armed value. The retry slot re-dispatches once, only when every run of the night ended
 * without an answer (failed or no outcome) and none is still running.
 */
export function decideDispatch({ killSwitch, slot, runs, now }) {
  const ks = RAIL.killSwitch;
  if (killSwitch !== ks.armedValue) return { dispatch: false, reason: `${ks.variable} is ${JSON.stringify(killSwitch ?? '')}, not "${ks.armedValue}": the nightly stands down` };
  const night = tonight(runs, now);
  if (slot === 'first') {
    if (night.length) return { dispatch: false, reason: `tonight already has ${night.length} run(s)` };
    return { dispatch: true, reason: 'armed; no run yet tonight' };
  }
  if (slot !== 'retry') return { dispatch: false, reason: `unknown slot ${slot}` };
  if (!night.length) return { dispatch: false, reason: 'no run tonight to retry' };
  if (night.some((r) => r.status !== 'completed')) return { dispatch: false, reason: 'a run is still going' };
  if (night.some(good)) return { dispatch: false, reason: 'tonight already has an answer' };
  if (night.length > 1) return { dispatch: false, reason: 'tonight was already retried once' };
  return { dispatch: true, reason: 'every run tonight failed; retrying once' };
}

/** RED when no night has ended published or no-change within the window. First line is the verdict. */
export function judge({ runs, now }) {
  const windowMs = RAIL.watchdogWindowHours * HOUR;
  const answered = runs.filter((r) => r.status === 'completed' && good(r)).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const last = answered[0] ?? null;
  const newest = [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null;
  const red = !last || now - Date.parse(last.updatedAt) > windowMs;
  const lines = [
    red
      ? `v5-watchdog RED · missed nightly: no night ended ${RAIL.goodOutcomes.join(' or ')} in ${RAIL.watchdogWindowHours} h (last: ${last ? `${last.outcome} ${eastern(Date.parse(last.updatedAt))}` : 'never'})`
      : `v5-watchdog GREEN · last night ${last.outcome} ${eastern(Date.parse(last.updatedAt))}`,
  ];
  if (newest) lines.push(`newest run ${newest.id}: ${newest.status === 'completed' ? (newest.outcome ?? `failed (${newest.conclusion})`) : newest.status}, started ${eastern(Date.parse(newest.createdAt))}`);
  return { red, lines };
}

const defaultGh = (args) => {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/** Reads the release-candidate runs of the last few days and each night's outcome artifact. */
export function gather({ repo, now, gh = defaultGh }) {
  const list = gh(['api', `repos/${repo}/actions/workflows/${RAIL.candidateWorkflow}/runs?per_page=50`]);
  if (!list.ok) throw new Error(`could not list ${RAIL.candidateWorkflow} runs: ${list.stderr.trim().slice(0, 300)}`);
  const recent = JSON.parse(list.stdout).workflow_runs.filter((r) => now - Date.parse(r.created_at) < (RAIL.watchdogWindowHours + 24) * HOUR);
  return recent.map((r) => {
    let outcome = null;
    if (r.status === 'completed' && r.conclusion === 'success') {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb5-outcome-'));
      if (gh(['run', 'download', String(r.id), '--repo', repo, '-n', RAIL.outcomeArtifact, '-D', dir]).ok) {
        try {
          outcome = JSON.parse(fs.readFileSync(path.join(dir, 'outcome.json'), 'utf8')).outcome ?? null;
        } catch {}
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return { id: r.id, status: r.status, conclusion: r.conclusion, createdAt: r.created_at, updatedAt: r.updated_at, outcome };
  });
}
