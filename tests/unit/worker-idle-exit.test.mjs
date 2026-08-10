import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ISSUE #122 — an idle brain worker must give its memory back.
 *
 * The reporter measured four concurrent `forge-mcp-all.mjs` processes at 3.7 / 3.3 / 3.0 / 15.7 GB
 * — roughly 25 GB held by sessions that had gone quiet. The only guard was:
 *
 *     setInterval(() => { if (process.ppid === 1) process.exit(0); }, 30000)
 *
 * which fires solely on reparent-to-init, so a parent that was ALIVE BUT IDLE kept a multi-gigabyte
 * server resident indefinitely, and killing them by hand did not help because the next session
 * spawned a fresh one.
 *
 * Exiting is safe because this process is NOT the MCP server the host talks to. plugin/mcp/server.mjs
 * is, it stays alive answering initialize/tools/list itself, and it owns ensureChild() — which
 * already respawns this worker after a timeout kill (server.mjs:260). The cost is one warm-up on the
 * next query; the benefit is gigabytes returned while nobody is asking anything.
 *
 * WHY STDIN IS HELD OPEN BELOW. The first version of this check piped /dev/null, which EOFs stdin
 * immediately — the worker then exits through the ordinary `stdin end` path, so BOTH the enabled and
 * disabled cases exited 0 and the test proved nothing. It looked green. stdin must stay open for the
 * idle guard to be the thing under test.
 */
const KB = path.join(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))), 'kb');
const WORKER = path.join(KB, 'forge-mcp-all.mjs');

/** Run the worker with stdin deliberately held open; resolve with how it terminated. */
function runWorker({ idleMs, killAfterMs }) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [WORKER], {
      cwd: KB,
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { ...process.env, RUVNET_BRAIN_IDLE_EXIT_MS: String(idleMs) },
    });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); }, killAfterMs);
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr });
    });
    // stdin intentionally left open — never written to, never ended.
  });
}

describe('issue #122 — the idle worker releases its memory', () => {
  it('exits on its own once idle, and says so', async () => {
    const { code, signal, stderr } = await runWorker({ idleMs: 4_000, killAfterMs: 60_000 });
    expect(signal, 'it must exit by itself, not be killed by this test').toBeNull();
    expect(code, 'a clean voluntary exit').toBe(0);
    expect(stderr, 'an operator must be able to see why a multi-GB process went away')
      .toMatch(/worker idle .* exiting to release memory/);
  }, 90_000);

  it('TEETH: with the guard disabled it stays resident, so the test can actually fail', async () => {
    // Without this case, an unconditional exit — or an exit caused by stdin EOF — would pass the
    // first assertion and the guard could be entirely broken while looking fine.
    const { code, signal } = await runWorker({ idleMs: 0, killAfterMs: 12_000 });
    expect(signal, 'disabled means it must still be alive when this test kills it').toBe('SIGKILL');
    expect(code).toBeNull();
  }, 60_000);
});

describe('issue #133 — a deliberate exit is not a crash', () => {
  it('the parent only degrades readiness on an UNCLEAN exit', () => {
    // #122 gave the worker a 15-minute idle retirement. The parent recorded that deliberate
    // process.exit(0) as "degraded / worker-exit … exited unexpectedly", so --doctor exited 1 on a
    // healthy machine where the next search would respawn the worker by design. A fix that frees
    // 3-15GB must not make the product report itself broken.
    const source = fs.readFileSync(
      path.join(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))), 'plugin', 'mcp', 'server.mjs'),
      'utf8',
    );
    expect(source, 'the exit handler must receive the code and signal to judge cleanliness')
      .toMatch(/proc\.on\('exit',\s*\(code,\s*signal\)/);
    expect(source, 'exit 0 with no signal is deliberate — idle retirement or stdin EOF')
      .toMatch(/const cleanExit = code === 0 && !signal/);
    expect(source, 'and degradation must be gated on it')
      .toMatch(/!c\.intentionalStop && !cleanExit/);
  });
});
