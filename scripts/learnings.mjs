#!/usr/bin/env node
// scripts/learnings.mjs — reads the per-user GLOBAL learner state for the console's "What I've learned"
// panel. This is the showable, delightful face of the recursive learning loop (ADR-0017): honest counts
// from ~/.claude-flow/neural/stats.json + the workflow actions recently observed by learn-capture. It is
// read-only. Learnings = how YOU work (shared across all your projects); project facts stay isolated.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { learningScope, learnerCwd } from '../plugin/scripts/runtime-preferences.mjs';

const HOME = os.homedir();

/** @param {{statsPath?:string, queueDir?:string, now?:number, cwd?:string, env?:object, home?:string}} [opts] */
export function learnings({ statsPath, queueDir, now = Date.now(), cwd, env, home } = {}) {
  // The flusher and the console must inspect the same learner. A fixed HOME path made the panel
  // report a stale global learner while project-scoped captures were fed under the active project.
  // Keep injectable paths for callers/tests, but derive both defaults from the shared scope owner.
  const project = cwd || process.env.RUVNET_BRAIN_PROJECT_DIR || process.cwd();
  const scope = learningScope({ cwd: project, env: env || process.env });
  const learner = learnerCwd({ cwd: project, env: env || process.env, home: home || HOME });
  const sp = statsPath || path.join(learner, '.claude-flow', 'neural', 'stats.json');
  const qd = queueDir || (scope === 'user'
    ? path.join(home || HOME, '.cache', 'ruvnet-brain', 'learn')
    : path.join(project, '.swarm', 'ruvnet-brain-learn'));

  let stats = {};
  try { stats = JSON.parse(fs.readFileSync(sp, 'utf8')); } catch { /* no learner yet */ }
  const trajectories = Number(stats.trajectoriesRecorded) || 0;
  const patterns = Number(stats.patternsLearned) || 0;
  const lastMs = Number(stats.lastAdaptation) || 0;
  const daysSince = lastMs ? Math.floor((now - lastMs) / 86400000) : null;

  // Recently observed workflow actions (what it's currently learning from) — the learn-capture queues.
  const recentWorkflow = [];
  const seen = new Set();
  try {
    const files = fs.readdirSync(qd)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, m: fs.statSync(path.join(qd, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(0, 5);
    for (const { f } of files) {
      for (const line of fs.readFileSync(path.join(qd, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let s; try { s = JSON.parse(line); } catch { continue; }
        const a = String(s.action || '').trim();
        if (!a || seen.has(a)) continue;
        seen.add(a);
        recentWorkflow.push(a);
        if (recentWorkflow.length >= 12) break;
      }
      if (recentWorkflow.length >= 12) break;
    }
  } catch { /* no queue yet */ }

  return {
    active: trajectories > 0 || patterns > 0,
    trajectories,
    patterns,
    lastAdaptation: lastMs ? new Date(lastMs).toISOString() : null,
    daysSinceLastAdaptation: daysSince,
    recentWorkflow,
    note: scope === 'user'
      ? 'Learnings are how you work — shared across your projects and getting smarter over time. Project facts stay isolated per project; nothing here is project data.'
      : 'Learnings are how you work in this project and getting smarter over time. User-scoped learning remains isolated from this project; nothing here is project data.',
    scope,
    statsPath: sp,
    queueDir: qd,
  };
}

export function printLearnings(l) { console.log(JSON.stringify(l, null, 2)); }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) printLearnings(learnings());
