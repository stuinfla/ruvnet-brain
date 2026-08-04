// continuation-gate.test.mjs — the gate that refuses to let a turn end on unfinished work.
//
// WHY THIS FILE EXISTS. On 2026-07-24 the owner's single most emphatic standing rule — "do not stop
// until it is done and in production" — was being enforced by a mechanism that had silently switched
// itself OFF roughly 30 hours earlier, and the only symptom was nothing happening. A freshness guard
// added that same morning discarded any open item older than 24h; the four genuinely-open commitments
// on this machine were 53-56h old, so the forceable set came back empty and the gate exited quietly.
//
// It had ZERO tests. A gate whose failure mode is silence, with no test, is indistinguishable from a
// gate that is working — which is precisely why silence-shaped defects survive here. Every test below
// is written to FAIL on the broken behaviour, not merely to pass on the fixed one.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GATE = path.resolve(import.meta.dirname, '../../plugin/scripts/continuation-gate.mjs');

/** Run the gate with an isolated ledger, returning {out, forced, items}. Never touches the real one. */
function runGate(items, hookInput = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cont-gate-'));
  const ledger = path.join(dir, 'ledger.json');
  fs.writeFileSync(ledger, JSON.stringify({ items }));
  const payload = JSON.stringify({ session_id: 's-test', stop_hook_active: false, cwd: dir, ...hookInput });
  let out = '';
  try {
    out = execFileSync(process.execPath, [GATE], {
      input: payload,
      encoding: 'utf8',
      env: {
        ...process.env,
        RUVNET_WORK_LEDGER: ledger,
        RUVNET_CONTINUATION_COOLDOWN_MS: '0',
        // The sandbox is the ledger AND the artifact source. The gate now also derives open
        // work from open-issues.json (a file the issue-watch pipeline writes, so the guard is
        // not armed solely by the model remembering to arm it). Without pinning it here these
        // cases read the DEVELOPER's real SLA breaches and a "must stay silent" assertion
        // fails for a true reason — the same incomplete-sandbox shape as HOME-without-PATH.
        // Artifact-derived behaviour has its own file: continuation-gate-artifact-derived.
        RUVNET_OPEN_ISSUES_FILE: path.join(dir, 'no-such-open-issues.json'),
      },
    });
  } catch (e) { out = e.stdout || ''; }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }

  let ctx = null;
  try { ctx = JSON.parse(out).hookSpecificOutput?.additionalContext ?? null; } catch { /* no envelope */ }
  return { out, forced: ctx != null, ctx };
}

const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();

describe('continuation-gate — forces the turn to continue while work is open', () => {
  it('FORCES on an open item committed days ago — the exact case that silently broke', () => {
    // THE REGRESSION. A 24h cutoff made this return silence. Old open work is the case that most
    // needs the nudge: anything finished quickly never reaches this gate at all.
    const r = runGate([{ text: 'ship the thing', at: hoursAgo(56), done: false }]);
    expect(r.forced, 'a 56h-old open commitment MUST still force the turn to continue').toBe(true);
    expect(r.ctx).toMatch(/Do NOT end the turn/);
    expect(r.ctx).toMatch(/ship the thing/);
  });

  it('LABELS the age instead of suppressing it', () => {
    // Age is information the reader needs, never a reason to withhold. If this ever reverts to
    // filtering, the previous test fails and this one documents why the label exists.
    const r = runGate([{ text: 'old work', at: hoursAgo(72), done: false }]);
    expect(r.ctx).toMatch(/committed 3d ago — still open/);
  });

  it('stays SILENT when nothing is open — the gate must not nag on a clean ledger', () => {
    const r = runGate([{ text: 'finished work', at: hoursAgo(2), done: true }]);
    expect(r.forced, 'a fully-done ledger must produce no envelope').toBe(false);
  });

  it('stays SILENT on an EMPTY ledger', () => {
    expect(runGate([]).forced).toBe(false);
  });

  it('REFUSES an item of unknown age — the original guard, preserved', () => {
    // This is what the 24h rule was actually protecting against: a row with no parseable timestamp
    // could nag forever with no evidence it is real. That protection must survive the fix above.
    const r = runGate([{ text: 'legacy row', done: false }]);
    expect(r.forced, 'an item with no `at` is of unknown age and must not force').toBe(false);
    const bad = runGate([{ text: 'malformed', at: 'not-a-date', done: false }]);
    expect(bad.forced, 'an unparseable `at` must not force').toBe(false);
  });

  it('honours stop_hook_active — never recurses into its own continuation', () => {
    // Claude Code sets this when the turn is already continuing because of a stop hook. Ignoring it
    // is how a gate becomes an infinite loop.
    const r = runGate([{ text: 'open work', at: hoursAgo(1), done: false }], { stop_hook_active: true });
    expect(r.forced, 'must not force while a stop-hook continuation is already in flight').toBe(false);
  });

  it('requires a session_id — an empty payload is not a real Stop event', () => {
    const r = runGate([{ text: 'open work', at: hoursAgo(1), done: false }], { session_id: undefined });
    expect(r.forced).toBe(false);
  });

  it('names the event so the envelope is not discarded', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cont-gate-ev-'));
    const ledger = path.join(dir, 'l.json');
    fs.writeFileSync(ledger, JSON.stringify({ items: [{ text: 'x', at: hoursAgo(1), done: false }] }));
    let out = '';
    try {
      out = execFileSync(process.execPath, [GATE], {
        input: JSON.stringify({ session_id: 's', stop_hook_active: false, cwd: dir }),
        encoding: 'utf8',
        env: {
        ...process.env,
        RUVNET_WORK_LEDGER: ledger,
        RUVNET_CONTINUATION_COOLDOWN_MS: '0',
        // The sandbox is the ledger AND the artifact source. The gate now also derives open
        // work from open-issues.json (a file the issue-watch pipeline writes, so the guard is
        // not armed solely by the model remembering to arm it). Without pinning it here these
        // cases read the DEVELOPER's real SLA breaches and a "must stay silent" assertion
        // fails for a true reason — the same incomplete-sandbox shape as HOME-without-PATH.
        // Artifact-derived behaviour has its own file: continuation-gate-artifact-derived.
        RUVNET_OPEN_ISSUES_FILE: path.join(dir, 'no-such-open-issues.json'),
      },
      });
    } catch (e) { out = e.stdout || ''; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe('Stop');
  });
});
