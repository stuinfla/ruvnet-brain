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
    const result = await runRegisteredChecker({ command: process.execPath,
      args: ['-e', `try { require('node:fs').writeFileSync(${JSON.stringify(outside)},'escape'); process.exitCode = 1; }
        catch (error) { if (!['EPERM', 'EACCES', 'EROFS'].includes(error.code)) throw error;
          console.log(JSON.stringify({ marker: 'native-checker-denial-observed', code: error.code, syscall: error.syscall })); }`], cwd: root },
      { deadline: Date.now() + 10_000, sandboxBinary: actualCodex() });
    assert.equal(result.passed, true, `Native denial probe did not finish successfully: ${JSON.stringify(result)}`);
    assert.match(result.output, /"marker":"native-checker-denial-observed","code":"(?:EPERM|EACCES|EROFS)","syscall":"open"/, JSON.stringify(result));
    assert.equal(fs.existsSync(outside), false, JSON.stringify(result));
  } finally { if (fs.existsSync(outside)) fs.unlinkSync(outside); fs.rmSync(root, { recursive: true, force: true }); }
});
