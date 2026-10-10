// ground-truth-machine.mjs — ADR-041 fixture builder.
//
// Constructs a scratch HOME whose REAL artifacts put each cohort capability into the state the manifest
// declares — then INDEPENDENTLY VERIFIES the bytes it wrote before returning. The builder writes
// artifacts only; it never emits a state word, and it never imports capability-registry.mjs. The
// manifest (tests/fixtures/ground-truth-machine/ground-truth.json) is the sole state authority; the
// detector maps artifact->state on its own. That is the separation of authorities ADR-041 requires:
// nothing here can echo the answer, because the answer is computed by code this file never touches.
//
// Grounded against scripts/capability-registry.mjs (read live, not recalled):
//   session-capture ON  = a CAPTURE_COMMAND-matching command wired at BOTH PreCompact AND SessionEnd
//                         (registry.mjs:560-569; countCaptureCommands walks [{hooks:[{command}]}], :212).
//   session-capture UNKNOWN = empty settings establish no static declaration; unchecked runtime hooks may exist.
//                         (A MISSING settings.json would be ABSENT, not OFF — so we always write one.)
//   mcp-servers    ON   = >=1 key under mcpServers in ~/.claude.json (registry.mjs:586-590).
//   mcp-servers    OFF  = the file exists with an EMPTY mcpServers object (:587).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MANIFEST_PATH = path.join(HERE, '..', 'fixtures', 'ground-truth-machine', 'ground-truth.json');

export function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

// ── THE INDEPENDENT ORACLE (ADR-041's separation of authorities — actually closed, 2026-07-24) ────────
// This file USED TO copy capability-registry.mjs:210's capture-command regex and use it to "verify" the
// artifact it had just written. That is the echo trap ADR-041 claimed to close, not a closure of it: the
// oracle and the detector shared ONE predicate, so the harness could only ever prove "the detector matches
// a string I built to match it" — never that the detector is CORRECT. A copied pattern is worse than an
// import: identical circularity, and it can silently drift. GPT-5.6-Sol caught this on 2026-07-24, and it
// is why the recall / false-alarm numbers were retracted until this fix.
//
// The oracle is now STRUCTURAL + REFERENTIAL and names no detector rule:
//   session-capture ON  = a command is wired at BOTH PreCompact and SessionEnd, AND that command invokes a
//                         capture script that REALLY EXISTS on disk (the one this fixture writes).
//   session-capture UNKNOWN = neither boundary carries such a command; runtime absence remains unproved.
// That shape is grounded in how rUv actually persists session state — a hook command at the
// compaction/session boundary invoking a real persistence script (searched live 2026-07-24:
// agentic-flow/.claude/helpers/context-persistence-hook.mjs, ADR-051, which intercepts PreCompact/
// SessionStart; and ruv-fann's session-end --save-memory Stop hook) — not reverse-engineered from the
// detector's pattern.
//
// Consequence, and the whole point of a ground truth: if the DETECTOR's predicate is wrong (it fails to
// recognise a real capture hook), the fixture still describes the machine correctly and the detector's
// error SHOWS UP as a miss in recall / a false alarm. Under the old shared-predicate design that entire
// class of bug was structurally invisible.
const CAPTURE_SCRIPT_NAME = 'agentdb-autocapture.mjs';

function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

/**
 * Build a scratch HOME (and an empty scratch project) for one manifest state ("healthy" | "dormant").
 * Returns { home, project, cleanup }. The caller runs the real detector with HOME=home --project=project.
 */
export function buildState(stateName, rootDir) {
  const manifest = readManifest();
  const want = manifest.states[stateName];
  if (!want) throw new Error(`ground-truth-machine: unknown state "${stateName}" (have: ${Object.keys(manifest.states).join(', ')})`);

  const home = path.join(rootDir, 'home');
  const project = path.join(rootDir, 'project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });

  // ── session-capture -> ~/.claude/settings.json ────────────────────────────────────────────────────
  const settingsPath = path.join(home, '.claude', 'settings.json');
  // The oracle's REFERENT: a capture script that really exists on disk. Its presence — not a pattern match
  // — is what makes "a capture hook is wired here" true independently of the detector.
  const capturePath = path.join(home, '.claude', 'hooks', CAPTURE_SCRIPT_NAME);
  if (want['session-capture'] === 'on') {
    fs.mkdirSync(path.dirname(capturePath), { recursive: true });
    fs.writeFileSync(capturePath, '#!/usr/bin/env node\n// persists session state at the compaction/session boundary\n');
    const captureGroup = [{ matcher: '.*', hooks: [{ type: 'command', command: `node ${capturePath}` }] }];
    writeJSON(settingsPath, { hooks: { PreCompact: captureGroup, SessionEnd: captureGroup } });
  } else {
    // Empty declarations support UNKNOWN only; they cannot establish runtime absence.
    writeJSON(settingsPath, { hooks: {} });
  }

  // ── mcp-servers -> ~/.claude.json ─────────────────────────────────────────────────────────────────
  const claudeJsonPath = path.join(home, '.claude.json');
  if (want['mcp-servers'] === 'on') {
    writeJSON(claudeJsonPath, { mcpServers: { 'example-notes': { command: 'node', args: ['notes-server.mjs'] } } });
  } else {
    writeJSON(claudeJsonPath, { mcpServers: {} });
  }

  // ── workflow-pattern-learning -> ~/.claude-flow/neural/stats.json ─────────────────────────────────
  // The dormant case here is IDLE rather than OFF, and the distinction is the point: a learner
  // holding real trajectories that has gone quiet is NOT off. Both states therefore carry the SAME
  // non-zero counters, and ONLY the recency of lastAdaptation differs — so a detector that ignores
  // staleness cannot pass this pair. (learning-enable.mjs: STALE_DAYS = 7.)
  const statsPath = path.join(home, '.claude-flow', 'neural', 'stats.json');
  const learnWant = want['workflow-pattern-learning'];
  if (learnWant) {
    const DAY = 86_400_000;
    // Counters are written as JSON NUMBERS deliberately: learning-enable's num() accepts nothing
    // else, and a string here would make the artifact read UNKNOWN — a fixture bug that would look
    // like a detector miss.
    const base = { trajectoriesRecorded: 457, patternsLearned: 118 };
    const lastAdaptation = learnWant === 'idle'
      ? Date.now() - (30 * DAY)   // comfortably past STALE_DAYS -> IDLE
      : Date.now() - (2 * 3600_000); // 2h ago -> ON
    writeJSON(statsPath, { ...base, lastAdaptation });
  }

  verifyArtifacts(stateName, { home, settingsPath, claudeJsonPath, want, capturePath, statsPath });

  return { home, project, cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }) };
}

/**
 * INDEPENDENT self-check: re-read the bytes and assert they satisfy the probe's OWN condition — so a
 * silently-wrong artifact (the "real-state echo one layer up" ADR-041's duel flagged) is caught before
 * the detector ever runs. This checks ARTIFACT correctness, not detector output.
 */
export function verifyArtifacts(stateName, { home, settingsPath, claudeJsonPath, want, capturePath, statsPath }) {
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const commandsAt = (boundary) => (settings.hooks?.[boundary] || [])
    .flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : []))
    .map((h) => (typeof h?.command === 'string' ? h.command : ''));
  // STRUCTURAL + REFERENTIAL — no detector predicate anywhere: a command wired at BOTH boundaries that
  // invokes a capture script which really exists on disk. If the detector's own pattern is wrong, this
  // still reads the machine correctly, so the detector's error becomes a visible miss instead of hiding.
  const wiredAt = (b) => !!capturePath && commandsAt(b).some((c) => c.includes(capturePath));
  const captureBoth = wiredAt('PreCompact') && wiredAt('SessionEnd') && fs.existsSync(capturePath);
  const wantCaptureOn = want['session-capture'] === 'on';
  if (captureBoth !== wantCaptureOn) {
    throw new Error(`ground-truth-machine[${stateName}]: settings.json does not satisfy session-capture=${want['session-capture']} (captureBoth=${captureBoth})`);
  }

  const claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
  const mcpCount = Object.keys(claudeJson.mcpServers || {}).length;
  const wantMcpOn = want['mcp-servers'] === 'on';
  if ((mcpCount > 0) !== wantMcpOn) {
    throw new Error(`ground-truth-machine[${stateName}]: .claude.json does not satisfy mcp-servers=${want['mcp-servers']} (mcpCount=${mcpCount})`);
  }

  // workflow-pattern-learning. Checked STRUCTURALLY against the artifact's own meaning — counters are
  // real JSON numbers, and the age is on the correct side of the 7-day line — never by asking the
  // detector. Re-deriving staleness here rather than importing STALE_DAYS is deliberate: importing it
  // would let one edited constant move both the oracle and the thing it grades, which is precisely the
  // echo trap ADR-041's duel flagged.
  const learnWant = want['workflow-pattern-learning'];
  if (learnWant) {
    const stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
    const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
    if (!isNum(stats.trajectoriesRecorded) || !isNum(stats.patternsLearned)) {
      throw new Error(`ground-truth-machine[${stateName}]: stats.json counters must be JSON numbers, else the artifact reads UNKNOWN`);
    }
    if (stats.trajectoriesRecorded === 0 && stats.patternsLearned === 0) {
      throw new Error(`ground-truth-machine[${stateName}]: an all-zero learner is INITIALISED_EMPTY (off), which is not what any state here wants`);
    }
    const ageDays = (Date.now() - stats.lastAdaptation) / 86_400_000;
    const wantIdle = learnWant === 'idle';
    const isStale = ageDays >= 7;
    if (isStale !== wantIdle) {
      throw new Error(`ground-truth-machine[${stateName}]: stats.json age ${ageDays.toFixed(1)}d does not satisfy workflow-pattern-learning=${learnWant}`);
    }
  }
  return true;
}
