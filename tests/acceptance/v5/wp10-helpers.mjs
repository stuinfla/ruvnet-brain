// Work package 10 (the optional write guard) test helpers. The guard runs as the host would run it: one
// program, the hook message on stdin, its line on stdout or its refusal on stderr with exit 2.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HOME_ENV, waitFor } from './helpers.mjs';

export const Q = 'how does the quillfeather index descend its layers with marrowlight';
export const TERM_TEXT = "import { open } from 'ruflo';\nexport const store = open();\n";

/** Runs the guard program of a scratch tree with one hook message. */
export function guard(tree, home, input, { cwd = os.tmpdir(), env = {}, raw = null } = {}) {
  const r = spawnSync(process.execPath, [path.join(tree.root, 'packages', 'guard', 'guard.mjs')], {
    input: raw ?? JSON.stringify(input),
    cwd,
    env: { ...process.env, NODE_NO_WARNINGS: '1', [HOME_ENV]: home, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  let msg = null;
  try {
    msg = r.stdout.trim() ? JSON.parse(r.stdout.trim()).systemMessage : null;
  } catch {}
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, msg };
}

export const writeMsg = (file, content, transcript) => ({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file, content }, ...(transcript !== undefined ? { transcript_path: transcript } : {}) });

/** A started server whose verdict is OK (so the guard is not merely advisory). */
export async function okServer(ctx, tree, home) {
  const s = await ctx.server(tree, home);
  await waitFor(() => /RuvNet Brain OK/.test(tree.cli(home, ['status']).stdout), 30_000, 'the health verdict OK');
  return s;
}

/** A host transcript (JSONL) holding one search_ruvnet call and its result. */
export function transcript(dir, { content, isError = false, at = Date.now(), name = 'mcp__ruvnet-brain__search_ruvnet', pair = true } = {}) {
  const file = path.join(dir, `session-${Math.random().toString(16).slice(2)}.jsonl`);
  const ts = new Date(at).toISOString();
  const lines = [
    { type: 'user', timestamp: ts, message: { role: 'user', content: 'find the index code' } },
    ...(pair ? [{ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name, input: { query: Q } }] } }] : []),
    { type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content, is_error: isError }] } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

export const emptyTranscript = (dir) => {
  const f = path.join(dir, 'empty-session.jsonl');
  fs.writeFileSync(f, '');
  return f;
};
