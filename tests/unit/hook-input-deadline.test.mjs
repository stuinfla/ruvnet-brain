import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';

it('bounds a continuously trickling input without waiting for idle or EOF', async () => {
  const moduleUrl = new URL('../../plugin/scripts/hook-input.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { readStdinBounded } from ${JSON.stringify(moduleUrl)};
    process.stdout.write('ready\\n');
    const start = performance.now();
    const input = await readStdinBounded({ totalMs: 150, idleMs: 100, emptyMs: 1000 });
    process.stdout.write(JSON.stringify({ elapsed: performance.now() - start, bytes: input.length }));
  `], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', stderr = '', interval, deadline;
  child.stdin.on('error', () => {});
  try {
    const result = await new Promise((resolve, reject) => {
      deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('stdin reader did not finish')); }, 2000);
      child.once('error', reject);
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (!interval && output.startsWith('ready\n')) {
          child.stdin.write('{');
          interval = setInterval(() => child.stdin.write(' '), 15);
        }
      });
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    expect(result, stderr).toEqual({ code: 0, signal: null });
    const measured = JSON.parse(output.slice('ready\n'.length));
    expect(measured.bytes).toBeGreaterThan(2);
    expect(measured.elapsed).toBeGreaterThanOrEqual(130);
    expect(measured.elapsed).toBeLessThan(600);
  } finally {
    clearInterval(interval); clearTimeout(deadline);
    child.stdin.destroy(); child.kill('SIGKILL');
  }
});
