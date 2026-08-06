// tests/unit/capability-registry.test.mjs — the contract for the "what do you own and not use" registry.
//
// These tests exist to hold ONE line that is easy to cross by accident: a capability whose probe
// could not run must report 'unknown', never 'off'. Both render as "not working" to a careless
// reader, but only one of them is a claim about the user's machine — and this project's whole
// reason for existing is that it does not make claims it did not measure.
//
// The failure that motivated the strictest test here happened while the registry was being written:
// a live read of this repo's own memory store returned {unreadable, learns:false} because a
// concurrent writer held the WAL lock, and 90 seconds later the same store read back as fully
// healthy (1201 memories, 596 distilled patterns). A `learns ? 'on' : 'off'` mapping would have
// accused a working system. So the unknown-not-off tests below FORCE real probe failures rather
// than asserting the happy path, because the happy path never catches this.

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CAPABILITIES, STATE, SCOPE, auditAll } from '../../scripts/capability-registry.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STATES = Object.values(STATE);
const SCOPES = Object.values(SCOPE);

describe('capability descriptors', () => {
  it('ships a real list, not a stub', () => {
    // 8-12 is the brief: fewer reads as an unfinished sketch, more stops being "the top things".
    expect(CAPABILITIES.length).toBeGreaterThanOrEqual(8);
    expect(CAPABILITIES.length).toBeLessThanOrEqual(12);
  });

  it('gives every entry every required field, with a unique key', () => {
    const keys = new Set();
    for (const c of CAPABILITIES) {
      expect(typeof c.key, `key of ${c.label}`).toBe('string');
      expect(c.key.length).toBeGreaterThan(0);
      expect(keys.has(c.key), `duplicate key ${c.key}`).toBe(false);
      keys.add(c.key);

      expect(typeof c.label, `label of ${c.key}`).toBe('string');
      expect(c.label.length).toBeGreaterThan(0);
      expect(typeof c.whatItBuysYou, `whatItBuysYou of ${c.key}`).toBe('string');
      expect(typeof c.detect, `detect of ${c.key}`).toBe('function');
      expect(SCOPES, `scope of ${c.key}`).toContain(c.scope);
    }
  });

  it('covers the five capabilities the console must be able to answer for', () => {
    // Named explicitly so a future refactor cannot quietly drop one and still pass the count test.
    const keys = CAPABILITIES.map((c) => c.key);
    for (const required of [
      'learning-hooks',
      'memory-distillation',
      'cross-project-lessons',
      'harness-evolution',
      'cheap-model-routing',
    ]) expect(keys, `missing required capability ${required}`).toContain(required);
  });

  it('explains the payoff in plain, concrete language', () => {
    // "improves performance" is the exact non-answer this field replaces: it tells a person nothing
    // they can weigh. A concrete sentence names what changes for THEM.
    const hype = /\b(seamless|leverage|powerful|blazing|robust|cutting[- ]edge|supercharge|unlock the power|best[- ]in[- ]class|next[- ]gen)\b/i;
    const vague = /\bimproves? (performance|efficiency|productivity)\b/i;
    for (const c of CAPABILITIES) {
      expect(c.whatItBuysYou.length, `${c.key} is too terse to be concrete`).toBeGreaterThan(40);
      expect(hype.test(c.whatItBuysYou), `${c.key} uses hype words`).toBe(false);
      expect(vague.test(c.whatItBuysYou), `${c.key} is vague about the payoff`).toBe(false);
      // Jargon a non-engineer cannot parse defeats the purpose of the field.
      expect(/\b(HNSW|embedding|LoRA|WAL|JSONL|launchd)\b/.test(c.whatItBuysYou), `${c.key} leaks jargon`).toBe(false);
    }
  });
});

describe('turnOn is null-or-verified', () => {
  it('is either null or a {human, cmd} pair with real content', () => {
    for (const c of CAPABILITIES) {
      if (c.turnOn === null) continue;
      expect(typeof c.turnOn, `turnOn of ${c.key}`).toBe('object');
      expect(typeof c.turnOn.human, `turnOn.human of ${c.key}`).toBe('string');
      expect(typeof c.turnOn.cmd, `turnOn.cmd of ${c.key}`).toBe('string');
      expect(c.turnOn.human.trim().length).toBeGreaterThan(0);
      expect(c.turnOn.cmd.trim().length).toBeGreaterThan(0);
    }
  });

  it('only names repo scripts that actually exist', () => {
    // The machine-independent half of "verified": a `node scripts/x.mjs` command that points at a
    // deleted script is exactly the confidently-wrong instruction the null rule exists to prevent,
    // and unlike an external binary this can be checked on any CI runner.
    for (const c of CAPABILITIES) {
      const cmd = c.turnOn?.cmd;
      if (!cmd) continue;
      const m = cmd.match(/^node\s+(scripts\/[\w.-]+\.mjs)/);
      if (!m) continue;
      expect(fs.existsSync(path.join(REPO, m[1])), `${c.key} points at missing script ${m[1]}`).toBe(true);
    }
  });

  it('only names external commands whose subcommand was verified against --help', () => {
    // The other half of "verified" is a human act that cannot be re-run on a CI box without the
    // tools installed, so it is PINNED here instead. Each entry records the help output that was
    // read on 2026-07-22. Adding a command not on this list fails the test on purpose: it forces
    // whoever adds it to go run `--help` first, which is the entire discipline.
    const VERIFIED = new Set([
      'ruflo memory distill run',          // `ruflo memory distill --help` → SUBCOMMANDS: run | status | config
      'ruflo hooks pretrain',              // `ruflo hooks pretrain --help` → "Bootstrap intelligence from repository"
      'claude mcp add <name> <commandOrUrl>', // `claude mcp --help` → "add [options] <name> <commandOrUrl> [args...]"
    ]);
    for (const c of CAPABILITIES) {
      const cmd = c.turnOn?.cmd;
      if (!cmd) continue;
      // Scripts THIS package ships are exempt from the external-command pin — their existence is
      // checked by the test below instead. The pattern must match the ABSOLUTE form now emitted by
      // selfScript(): the old `^node\s+scripts/` only matched a relative path, which was itself the
      // bug (a command that only runs from inside a ruvnet-brain checkout).
      if (/^node\s+"?(?:\/|[A-Za-z]:[\\/])/.test(cmd)) continue;
      expect(VERIFIED.has(cmd), `${c.key} ships an unverified command: ${cmd}`).toBe(true);
    }
  });

  it('points every self-hosted turnOn command at a script that actually exists', () => {
    // The exemption above is only safe if something checks the path. `node scripts/lesson-promote.mjs`
    // shipped as a relative path and threw `Cannot find module` for every user not standing in this
    // repo — a real executor behind an unreachable path, which is a dead button with extra steps.
    for (const c of CAPABILITIES) {
      const cmd = c.turnOn?.cmd;
      if (!cmd || !/^node\s/.test(cmd)) continue;
      const m = cmd.match(/^node\s+"?([^"\s]+\.mjs)"?/);
      if (!m) continue;
      expect(path.isAbsolute(m[1]), `${c.key}: "${cmd}" only runs from inside this repo`).toBe(true);
      expect(fs.existsSync(m[1]), `${c.key}: turnOn points at a script that does not exist: ${m[1]}`).toBe(true);
    }
  });

  it('keeps turnOn null where the CLI was checked and has no such command', () => {
    // Pinned negatives. `ruflo hooks --help` lists no enable/disable subcommand, and
    // `ruflo metaharness --help` enumerates score|genome|mcp-scan|threat-model|oia-audit|
    // audit-list|audit-trend|similarity|drift-from-history|mint|redblue|learn|gepa — no `evolve`.
    // Without these assertions the tempting fix for a red "OFF" row is to invent a command.
    const byKey = Object.fromEntries(CAPABILITIES.map((c) => [c.key, c]));
    expect(byKey['learning-hooks'].turnOn, 'ruflo has no hooks enable command').toBe(null);
    expect(byKey['harness-evolution'].turnOn, 'ruflo metaharness has no evolve subcommand').toBe(null);
  });
});

describe('detect() is safe to call', () => {
  it('never throws, and always returns a usable state and evidence', () => {
    for (const c of CAPABILITIES) {
      let r;
      expect(() => { r = c.detect(); }, `${c.key}.detect() threw`).not.toThrow();
      expect(STATES, `${c.key} returned an unknown state`).toContain(r.state);
      expect(typeof r.evidence, `${c.key} evidence is not a string`).toBe('string');
      expect(r.evidence.trim().length, `${c.key} returned empty evidence`).toBeGreaterThan(0);
    }
  });

  it('never states a bare "0" as the reason for an unknown', () => {
    // An unknown must carry WHY it could not be checked. "0 found" masquerading as a reason is how
    // "could not read" becomes "nothing there" in a reader's head.
    for (const c of CAPABILITIES) {
      const r = c.detect();
      if (r.state !== STATE.UNKNOWN) continue;
      expect(r.evidence.length, `${c.key} gave a too-short unknown reason`).toBeGreaterThan(20);
    }
  });
});

describe('unknown outranks off when a probe cannot run', () => {
  const saved = {};
  afterEach(() => {
    if ('receipts' in saved) {
      if (saved.receipts === undefined) delete process.env.METAHARNESS_RECEIPTS;
      else process.env.METAHARNESS_RECEIPTS = saved.receipts;
      delete saved.receipts;
    }
    if ('platform' in saved) {
      Object.defineProperty(process, 'platform', { value: saved.platform, configurable: true });
      delete saved.platform;
    }
  });

  it('reports unknown — not off — when a ledger exists but cannot be read', () => {
    // FORCED REAL FAILURE, not a mock: point the receipt ledger at a directory. It exists, so the
    // "never set up" branch is correctly skipped, and reading it throws EISDIR. The tempting
    // shortcut (`lines || 0`) would call this "0 receipts — never used", accusing a user whose
    // routing may have run thousands of times.
    saved.receipts = process.env.METAHARNESS_RECEIPTS;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-registry-'));
    process.env.METAHARNESS_RECEIPTS = dir;
    try {
      const r = CAPABILITIES.find((c) => c.key === 'cheap-model-routing').detect();
      expect(r.state).toBe(STATE.UNKNOWN);
      expect(r.state).not.toBe(STATE.OFF);
      expect(r.evidence).toMatch(/could not be read/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports unknown — not off — for launchd jobs on a platform without launchd', () => {
    // This is the Linux CI runner's real situation, and this repo has already shipped a macOS-only
    // assumption that went red the moment it met that runner. Telling a Linux user "your nightly
    // refresh is OFF" would be the same bug wearing a worse costume: an actionable-looking fault
    // about a subsystem that cannot exist there.
    saved.platform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const r = CAPABILITIES.find((c) => c.key === 'nightly-refresh').detect();
    expect(r.state).toBe(STATE.UNKNOWN);
    expect(r.state).not.toBe(STATE.OFF);
    expect(r.evidence).toMatch(/linux/);
  });

  it('never concludes learning is off from ruflo\'s hook table', () => {
    // REGRESSION, and the sharpest one here: the first version of this detector parsed the
    // `Enabled` column of `ruflo hooks list` and printed "all 26 hooks report Enabled: No —
    // nothing is being learned from your sessions." That was false. Verified against the installed
    // ruflo: the JSON payload has no `enabled` key at all (rows are {name, type, status:"active"}),
    // the renderer draws a column keyed `enabled` so every row formats `undefined` as "No", and
    // `hooks list --enabled` returns all 27 lines unchanged because the handler takes no arguments.
    // The handler reads no file, db, or env var — it is a hardcoded catalog of subcommands.
    // A menu cannot report a state, so 'off' is unreachable from this source, in either direction.
    const r = CAPABILITIES.find((c) => c.key === 'learning-hooks').detect();
    expect(r.state, 'a static subcommand catalog cannot establish that learning is off').not.toBe(STATE.OFF);
    expect([STATE.UNKNOWN, STATE.ABSENT]).toContain(r.state);
  });

  it('every unknown reason names the obstacle, so it can never read as a measurement', () => {
    // Sweep whatever is genuinely unknown on THIS machine and require it to explain itself. On a
    // fully-configured box this may match nothing, which is fine — the two forced tests above carry
    // the load; this one catches a badly-worded unknown wherever one happens to occur.
    for (const r of auditAll()) {
      if (r.state !== STATE.UNKNOWN) continue;
      expect(r.evidence, `${r.key} unknown without a reason`)
        .toMatch(/could not|cannot|not checked|does not exist|failed|unknown|has probably changed/i);
    }
  });
});

describe('auditAll()', () => {
  const throwing = {
    key: 'test-throwing-detector',
    label: 'Throwing detector',
    whatItBuysYou: 'Nothing — this exists only to prove a broken probe degrades honestly instead of crashing the page.',
    scope: SCOPE.MACHINE,
    turnOn: null,
    detect() { throw new Error('probe exploded'); },
  };
  const malformed = {
    key: 'test-malformed-detector',
    label: 'Malformed detector',
    whatItBuysYou: 'Nothing — this exists only to prove a nonsense state is normalised rather than rendered raw.',
    scope: SCOPE.MACHINE,
    turnOn: null,
    detect() { return { state: 'banana', evidence: '' }; },
  };
  afterEach(() => {
    for (const t of [throwing, malformed]) {
      const i = CAPABILITIES.indexOf(t);
      if (i !== -1) CAPABILITIES.splice(i, 1);
    }
  });

  it('returns one row per capability with the descriptor fields carried through', () => {
    const rows = auditAll();
    expect(rows.length).toBe(CAPABILITIES.length);
    for (const r of rows) {
      expect(STATES).toContain(r.state);
      expect(SCOPES).toContain(r.scope);
      expect(typeof r.evidence).toBe('string');
      expect(r.evidence.trim().length).toBeGreaterThan(0);
      expect(typeof r.whatItBuysYou).toBe('string');
      expect(r.turnOn === null || typeof r.turnOn === 'object').toBe(true);
    }
  });

  it('turns a throwing detector into an unknown row instead of throwing', () => {
    // A dropped row is indistinguishable from a capability that does not exist, so the broken probe
    // must still appear — carrying its own failure as the evidence.
    CAPABILITIES.push(throwing);
    let rows;
    expect(() => { rows = auditAll(); }).not.toThrow();
    const r = rows.find((x) => x.key === throwing.key);
    expect(r).toBeDefined();
    expect(r.state).toBe(STATE.UNKNOWN);
    expect(r.state).not.toBe(STATE.OFF);
    expect(r.evidence).toMatch(/probe exploded/);
  });

  it('normalises a nonsense state and empty evidence to an honest unknown', () => {
    CAPABILITIES.push(malformed);
    const r = auditAll().find((x) => x.key === malformed.key);
    expect(r.state).toBe(STATE.UNKNOWN);
    expect(r.evidence.trim().length).toBeGreaterThan(0);
  });
});

describe('house rules', () => {
  it('hardcodes no version literal', () => {
    // A gate greps the repo for X.Y.Z-dev literals; a capability list is exactly the kind of file
    // that tempts someone to pin "requires 3.4.1-dev".
    // THE PAYLOAD COPY, not scripts/. Since the L4 payload-boundary move (2026-08-06) the file at
    // `scripts/capability-registry.mjs` is a four-line re-export shim: reading THAT would satisfy this
    // assertion trivially, forever, while the real 900-line registry went unchecked — a green test
    // guarding nothing, which is the same failure shape as the inert hook that move existed to fix.
    const src = fs.readFileSync(path.join(REPO, 'plugin/scripts/capability-registry.mjs'), 'utf8');
    expect(/\b\d+\.\d+\.\d+-dev\b/.test(src), 'version literal found').toBe(false);
  });

  it('renders honestly on a machine where nothing is installed', () => {
    // Empty-first: every state this registry can emit must be one a fresh machine can legitimately
    // show. 'absent' and 'unknown' are what a bare box produces, and neither is an accusation.
    for (const r of auditAll()) expect(STATES).toContain(r.state);
  });
});
