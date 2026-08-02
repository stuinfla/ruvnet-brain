#!/usr/bin/env node
// swarm-slot-recycler.mjs — Claude Code TeammateIdle recycling boundary.
//
// Claude owns the shared task files and their claim locks. This hook never edits them. It reads the
// team ledger at the synchronous TeammateIdle boundary and refuses idling only when it can prove an
// unassigned pending task is ready. Claude then performs the normal locked TaskUpdate claim. Missing,
// malformed, dependency-blocked, or ambiguous state fails open: a scheduler must not invent work.
//
// Host boundary: Claude Code exposes TeammateIdle; Codex 0.146.0 exposes SubagentStop but no
// TeammateIdle/TaskCompleted event or equivalent shared-task ledger. Do not register this body in the
// Codex manifest and do not claim Codex recycling is hook-enforced.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readStdinBounded } from './hook-input.mjs';

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_TASK_BYTES = 256 * 1024;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function allowIdle() { process.exit(0); }

let raw = Buffer.alloc(0);
try {
  raw = await readStdinBounded({ maxBytes: MAX_INPUT_BYTES, idleMs: 50, emptyMs: 250 });
} catch { allowIdle(); }

let event;
try {
  event = JSON.parse(raw.toString('utf8'));
} catch { allowIdle(); }

if (!event || typeof event !== 'object' || Array.isArray(event)) allowIdle();
if (event.hook_event_name !== 'TeammateIdle') allowIdle();

const teamName = String(event.team_name || '');
const teammateName = String(event.teammate_name || '');
if (!SAFE_NAME.test(teamName) || !SAFE_NAME.test(teammateName)) allowIdle();

const tasksRoot = process.env.RUVNET_CLAUDE_TASKS_DIR
  || path.join(os.homedir(), '.claude', 'tasks');
const teamDir = path.resolve(tasksRoot, teamName);
const root = path.resolve(tasksRoot);
if (path.dirname(teamDir) !== root) allowIdle();

let files;
try {
  files = fs.readdirSync(teamDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d+\.json$/.test(entry.name))
    .map((entry) => entry.name);
} catch { allowIdle(); }

const tasks = new Map();
for (const file of files) {
  try {
    const taskPath = path.join(teamDir, file);
    const stat = fs.statSync(taskPath);
    if (!stat.isFile() || stat.size > MAX_TASK_BYTES) continue;
    const task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
    if (!task || typeof task !== 'object' || Array.isArray(task)) continue;
    const id = String(task.id || path.basename(file, '.json'));
    if (!/^\d+$/.test(id)) continue;
    tasks.set(id, task);
  } catch { /* one bad task cannot make another look ready */ }
}

const completed = new Set(
  [...tasks].filter(([, task]) => task.status === 'completed').map(([id]) => id),
);

const ready = [...tasks]
  .filter(([, task]) => task.status === 'pending')
  .filter(([, task]) => !String(task.owner || '').trim())
  .filter(([, task]) => {
    if (!Array.isArray(task.blockedBy)) return false;
    return task.blockedBy.every((id) => completed.has(String(id)));
  })
  .sort(([left], [right]) => Number(left) - Number(right));

if (!ready.length) allowIdle();

const [id, task] = ready[0];
const subject = String(task.subject || 'untitled task').replace(/[\r\n]+/g, ' ').slice(0, 160);
process.stderr.write(
  `Ready work remains. Claim task ${id} (${subject}) now with TaskUpdate owner=${teammateName} `
  + 'and status=in_progress, then execute it. Do not go idle while an unassigned, unblocked pending task exists.\n',
);
process.exit(2);
