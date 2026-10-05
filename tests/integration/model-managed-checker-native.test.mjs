import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { runRegisteredChecker } from '../../scripts/model-managed-workflow-service.mjs';
import { nativeWorkflowBinaries } from '../../scripts/model-routing-execution-adapters.mjs';

function actualCodex() {
  let binary;
  try { binary = nativeWorkflowBinaries().codex; }
  catch { binary = fs.realpathSync(execFileSync('which', ['codex'], { encoding: 'utf8', timeout: 3000 }).trim()); }
  assert.ok(path.isAbsolute(binary));
  const version = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 3000 });
  assert.match(version, /codex/i); return binary;
}

test('actual native read-only sandbox runs exact-file syntax checker without inference', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-managed-check-')));
  try {
    const file = path.join(root, 'valid.mjs'); fs.writeFileSync(file, 'export const ready = true;\n');
    const result = await runRegisteredChecker({ command: process.execPath, args: ['--check', file], cwd: root },
      { deadline: Date.now() + 10_000, sandboxBinary: actualCodex() });
    assert.equal(result.passed, true, `Native syntax checker failed: ${JSON.stringify(result)}`);
    assert.equal(result.exitCode, 0, JSON.stringify(result));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('actual native read-only sandbox denies checker write outside authorized scope', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-managed-check-')));
  const outside = path.join(process.cwd(), 'tests/unit', `checker-escape-${crypto.randomUUID()}.txt`);
  try {
    const probe = path.join(root, 'denial-probe.mjs');
    fs.writeFileSync(probe, `import fs from 'node:fs'; process.stdout.write('native-checker-started\\n');
      try { fs.writeFileSync(${JSON.stringify(outside)},'escape'); process.exitCode = 1; }
      catch (error) { if (!['EPERM', 'EACCES', 'EROFS'].includes(error.code)) throw error;
        console.log(JSON.stringify({ marker: 'native-checker-denial-observed', code: error.code, syscall: error.syscall })); }`);
    const result = await runRegisteredChecker({ command: process.execPath,
      args: [probe], cwd: root },
      { deadline: Date.now() + 10_000, sandboxBinary: actualCodex() });
    assert.equal(result.passed, true, `Native denial probe did not finish successfully: ${JSON.stringify(result)}`);
    assert.match(result.output, /native-checker-started/, JSON.stringify(result));
    assert.match(result.output, /"marker":"native-checker-denial-observed","code":"(?:EPERM|EACCES|EROFS)","syscall":"open"/, JSON.stringify(result));
    assert.equal(fs.existsSync(outside), false, JSON.stringify(result));
  } finally { if (fs.existsSync(outside)) fs.unlinkSync(outside); fs.rmSync(root, { recursive: true, force: true }); }
});

test('diagnostic native checker preserves actual stdout, stderr, syntax errors and exit codes', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-managed-check-')));
  try {
    const invalid = path.join(root, 'invalid.mjs'), probe = path.join(root, 'execution-probe.mjs');
    fs.writeFileSync(invalid, 'export const invalid = ;\n');
    fs.writeFileSync(probe, "process.stdout.write('native-file-executed\\n'); process.stderr.write('native-file-stderr\\n'); process.exitCode = 23;\n");
    const binary = actualCodex(), results = [];
    for (const [name, command, args] of [
      ['echo-execution', '/bin/echo', ['native-echo-executed']],
      ['shell-exit', '/bin/sh', ['-c', 'exit 37']],
      ['invalid-syntax', process.execPath, ['--check', invalid]],
      ['file-execution', process.execPath, [probe]],
      ['singleline-e', process.execPath, ['-e', "process.stdout.write('native-e-executed\\n'); process.stderr.write('native-e-stderr\\n'); process.exitCode = 29;"]],
    ]) results.push({ name, ...await runRegisteredChecker({ command, args, cwd: root },
      { deadline: Date.now() + 10_000, sandboxBinary: binary }) });
    fs.writeSync(1, `Exact native execution diagnostics: ${JSON.stringify({ binary, node: process.execPath, results })}\n`);
    assert.match(results[0].output, /native-echo-executed/, JSON.stringify(results));
    assert.equal(results[1].exitCode, 37, JSON.stringify(results));
    assert.equal(results[2].passed, false, JSON.stringify(results));
    assert.match(results[2].output, /SyntaxError/, JSON.stringify(results));
    assert.equal(results[3].exitCode, 23, JSON.stringify(results));
    assert.match(results[3].output, /native-file-executed[\s\S]*native-file-stderr/, JSON.stringify(results));
    assert.equal(results[4].exitCode, 29, JSON.stringify(results));
    assert.match(results[4].output, /native-e-executed[\s\S]*native-e-stderr/, JSON.stringify(results));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
