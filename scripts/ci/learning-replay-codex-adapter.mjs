#!/usr/bin/env node
// Fixture-generation adapter used only by scripts/learning-replay.mjs.
// The installed Codex plugin manifest calls the stable user-level wrapper. RUVNET_BRAIN_HOME makes
// that wrapper resolve this isolated generation, where this adapter observes the real lesson hook
// and blocks the first command before the model can learn the CLI syntax from its output.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const raw = fs.readFileSync(0);
let input = {};
try { input = JSON.parse(raw.toString('utf8')); } catch { /* fail closed below for tool calls */ }

const hookId = process.argv[2] || '';
const event = String(input.hook_event_name || '');
const here = path.dirname(fileURLToPath(import.meta.url));
const sequenceFile = process.env.RUVNET_REPLAY_SEQUENCE_FILE || '';
const attemptsFile = process.env.RUVNET_REPLAY_ATTEMPTS_FILE || '';
const probe = process.env.RUVNET_REPLAY_LESSON_PROBE || '';

if (event === 'PreToolUse') {
  const recorder = process.env.RUVNET_REPLAY_RECORDER || '';
  if (!recorder) process.exit(2);
  // Codex emits exec_command with tool_input.cmd; the shared Claude/Ruflo boundary consumes
  // Bash with tool_input.command. Normalize the real host envelope before the recorder parses it.
  const recorderInput = Buffer.from(JSON.stringify({
    ...input,
    tool_name: /^(?:functions[._]{1,2})?exec_command$/.test(String(input.tool_name || ''))
      ? 'Bash'
      : input.tool_name,
    tool_input: {
      ...(input.tool_input || {}),
      command: input.tool_input?.command ?? input.tool_input?.cmd ?? input.command ?? '',
    },
  }));
  const result = spawnSync(process.execPath, [recorder, attemptsFile, sequenceFile], {
    input: recorderInput,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 2);
}

if (event === 'UserPromptSubmit' && hookId === 'unprompted-speech') {
  const shim = path.join(here, 'hook-shim.mjs');
  const result = spawnSync(process.execPath, [shim, hookId, ...process.argv.slice(3)], {
    input: raw,
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_SESSION_ID: String(input.session_id || ''),
      CLAUDE_PROJECT_DIR: String(input.cwd || process.cwd()),
      RUVNET_HOOK_HOST: 'codex',
    },
  });
  if (probe && String(result.stdout || '').includes(probe) && sequenceFile) {
    try {
      fs.mkdirSync(path.dirname(sequenceFile), { recursive: true });
      fs.appendFileSync(sequenceFile, JSON.stringify({
        kind: 'lesson',
        atNs: process.hrtime.bigint().toString(),
      }) + '\n');
    } catch { /* a missing receipt makes the replay fail closed */ }
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 0);
}

process.exit(0);
