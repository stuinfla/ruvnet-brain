// console-nightly-three-facts.test.mjs — the Settings card's "Nightly brain refresh" must render
// three separately-measured facts, never one boolean that any of them contradicts.
//
// THE LIE (console audit 2026-09-11): the toggle rendered `nightly: true` because the LaunchAgent was
// loaded, while ~/.claude/ruvnet-brain/config.json said `nightly: false` and the brain-update job had
// `runHealth: never-ran`. Three sources — the recorded CHOICE (config.json), the ENFORCEMENT (the
// scheduler adapter's state) and the OUTCOME (the last completed run) — were collapsed into the one
// the user did not set.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { APP_JS, IMPORT, makeRunner, scratch } from './helpers/console-child.mjs';
import { reconcileNightly } from '../../scripts/onboarding-console.mjs';

let tmp, runJSON;
beforeEach(() => { tmp = scratch('console-nightly-'); ({ runJSON } = makeRunner(tmp)); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const schedule = (state, run = 'never-ran', extra = {}) => ({
  state, evidence: `adapter says ${state}`, artifact: { supported: true },
  runHealth: { state: run, evidence: `run says ${run}`, receipt: run === 'ok' ? { finishedAt: '2026-09-10T03:00:00.000Z' } : null },
  ...extra,
});

describe('Fix 3 — nightly refresh: choice, enforcement and last run are three facts', () => {
  it('choice=false but the agent is loaded (the owner’s machine): no single boolean is emitted', () => {
    const r = reconcileNightly({ choice: false, schedule: schedule('on') });
    expect(r.value).toBe(null);
    expect(r.facts).toMatchObject({ choice: false, enforcement: 'on', lastRun: 'never-ran', agree: false });
    expect(r.facts.lastRunAt).toBe(null);
  });
  it('choice=true, agent on, last run ok: the three agree and the boolean is allowed', () => {
    const r = reconcileNightly({ choice: true, schedule: schedule('on', 'ok') });
    expect(r.value).toBe(true);
    expect(r.facts).toMatchObject({ choice: true, enforcement: 'on', lastRun: 'ok', agree: true, lastRunAt: '2026-09-10T03:00:00.000Z' });
  });
  it('choice=true but the adapter is degraded: not "on", so not agreed', () => {
    const r = reconcileNightly({ choice: true, schedule: schedule('degraded') });
    expect(r.value).toBe(null);
    expect(r.facts.agree).toBe(false);
    expect(r.facts.enforcement).toBe('degraded');
  });
  it('never chosen: the value stays null (unchosen is not off) and enforcement is still reported', () => {
    const r = reconcileNightly({ choice: null, schedule: schedule('off') });
    expect(r.value).toBe(null);
    expect(r.facts).toMatchObject({ choice: null, enforcement: 'off', agree: null });
  });

  it('gatherConfig() on a machine whose config says ON but nothing is scheduled: contradiction surfaced, not hidden', () => {
    fs.mkdirSync(path.join(tmp, '.claude', 'ruvnet-brain'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.claude', 'ruvnet-brain', 'config.json'), JSON.stringify({ nightly: true }));
    const out = runJSON(`${IMPORT} process.stdout.write(JSON.stringify(m.gatherConfig()));`);
    expect(out.values.nightly).toBe(null);                    // was: false — silently contradicting the file
    expect(out.runtime.nightly.facts.choice).toBe(true);
    expect(out.runtime.nightly.facts.enforcement).toBe('off');
    expect(out.runtime.nightly.facts.lastRun).toBe('never-ran');
    expect(out.runtime.nightly.facts.agree).toBe(false);
  });

  it('the page renders the three facts under the field', () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    expect(src).toContain('nightly.facts');
    expect(src).toContain('last completed run');
  });
});
