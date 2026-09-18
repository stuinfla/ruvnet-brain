import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { spawnNativeHost, trackProcessTree } from '../../scripts/native-host-process.mjs';

const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitUntil(test, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!test() && Date.now() < deadline) await pause(20);
  expect(test()).toBe(true);
}

describe('native host ownership', () => {
  it('removes ownership listeners after a successful invocation', async () => {
    const before = ['exit', 'SIGINT', 'SIGTERM'].map(event => process.listenerCount(event));
    const result = await spawnNativeHost(process.execPath, ['-e', 'console.log("done")'], {stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000});
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('done');
    expect(['exit', 'SIGINT', 'SIGTERM'].map(event => process.listenerCount(event))).toEqual(before);
  });

  it('cleans an ignored grandchild before releasing ownership on normal host exit', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-normal-tree-'));
    const pidFile = path.join(root, 'grandchild.pid');
    const before = ['exit', 'SIGINT', 'SIGTERM'].map(event => process.listenerCount(event));
    try {
      const result = await spawnNativeHost(process.execPath, ['-e', `
        const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
        require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref();
      `], {stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000});
      const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
      expect(result.status).toBe(0);
      expect(result.error).toBeNull();
      expect(result.terminationConfirmed).toBe(process.platform !== 'win32');
      if (process.platform !== 'win32') await waitUntil(() => !alive(grandchild));
      expect(['exit', 'SIGINT', 'SIGTERM'].map(event => process.listenerCount(event))).toEqual(before);
    } finally {
      fs.rmSync(root, {recursive: true, force: true});
    }
  });

  it('bounds cleanup when a normal-exit grandchild inherits host stdio', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-inherited-stdio-'));
    const pidFile = path.join(root, 'grandchild.pid');
    try {
      const started = Date.now();
      const result = await spawnNativeHost(process.execPath, ['-e', `
        const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
        require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref();
      `], {stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000, terminationFallbackMs: 250});
      const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
      expect(result.status).toBe(0);
      expect(result.error).toBeNull();
      expect(Date.now() - started).toBeLessThan(1500);
      expect(result.terminationConfirmed).toBe(process.platform !== 'win32');
      if (process.platform !== 'win32') await waitUntil(() => !alive(grandchild));
    } finally {
      fs.rmSync(root, {recursive: true, force: true});
    }
  });

  it.skipIf(process.platform === 'win32')('rejects incomplete output even when the original process group is gone', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-open-output-'));
    const pidFile = path.join(root, 'detached.pid');
    let descendant;
    try {
      const result = await spawnNativeHost(process.execPath, ['-e', `
        const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'inherit'});
        require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref();
        console.log('prefix is not proof of complete output');
      `], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000, terminationFallbackMs: 100 });
      descendant = Number(fs.readFileSync(pidFile, 'utf8'));
      expect(result.processStatus).toBe(0);
      expect(result.outputComplete).toBe(false);
      expect(result.outputTrusted).toBe(false);
      expect(result.error?.message).toMatch(/output.*complete/i);
      expect(result.status).toBeNull();
    } finally {
      if (!descendant && fs.existsSync(pidFile)) descendant = Number(fs.readFileSync(pidFile, 'utf8'));
      if (descendant && alive(descendant)) process.kill(descendant, 'SIGKILL');
      if (descendant) await waitUntil(() => !alive(descendant));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('retains ownership listeners while another SIGTERM handler keeps the process alive', () => {
    const before = process.listenerCount('SIGTERM');
    const first = { pid: null };
    const second = { pid: null };
    const releaseFirst = trackProcessTree(first);
    const applicationHandler = () => {};
    process.on('SIGTERM', applicationHandler);
    try {
      process.emit('SIGTERM');
      expect(process.listenerCount('SIGTERM')).toBeGreaterThanOrEqual(before + 1);
      const releaseSecond = trackProcessTree(second);
      releaseFirst();
      expect(process.listenerCount('SIGTERM')).toBeGreaterThanOrEqual(before + 1);
      releaseSecond();
    } finally {
      process.off('SIGTERM', applicationHandler);
      releaseFirst();
    }
  });

  it('does not claim termination when descendant cleanup fails after normal host exit', async () => {
    const result = await spawnNativeHost(process.execPath, ['-e', 'console.log("done")'], {
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000,
      killProcessTree: () => { throw new Error('simulated cleanup failure'); },
    });
    expect(result.status).toBeNull();
    expect(result.terminationConfirmed).toBe(false);
    expect(result.error?.message).toMatch(/cleanup failed/);
    expect(result.stdout.trim()).toBe('done');
    expect(result.outputTrusted).toBe(true);
    expect(result.outputComplete).toBe(true);
    expect(result.processStatus).toBe(0);
  });

  it('does not launch a host when cancellation has already happened', async () => {
    const controller = new AbortController(); controller.abort();
    const result = await spawnNativeHost('must-not-exist', [], { signal: controller.signal });
    expect(result.aborted).toBe(true); expect(result.timedOut).toBe(false);
    expect(result.stderr).toBe('native host aborted before launch');
    expect(result.signal).toBeNull();
  });

  it('cancels an observed running process tree with a real termination result', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-abort-'));
    const pidFile = path.join(root, 'grandchild.pid');
    const controller = new AbortController();
    const before = ['exit', 'SIGINT', 'SIGTERM'].map(event => process.listenerCount(event));
    let grandchild;
    const pending = spawnNativeHost(process.execPath, ['-e', `
      const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000);
    `], {stdio:['pipe','pipe','pipe'], timeout:5000, signal:controller.signal});
    try {
      await waitUntil(() => fs.existsSync(pidFile));
      grandchild = Number(fs.readFileSync(pidFile, 'utf8')); controller.abort();
      const result = await pending;
      expect(result.aborted).toBe(true); expect(result.timedOut).toBe(false);
      expect(result.terminationConfirmed).toBe(process.platform !== 'win32');
      if (process.platform !== 'win32') expect(result.signal).toBe('SIGKILL');
      await waitUntil(() => !alive(grandchild));
      expect(['exit', 'SIGINT', 'SIGTERM'].map(event => process.listenerCount(event))).toEqual(before);
    } finally {
      controller.abort(); await pending;
      if (grandchild && alive(grandchild)) process.kill(grandchild, 'SIGKILL');
      fs.rmSync(root,{recursive:true,force:true});
    }
  });

  it.each(['abort', 'timeout'])('keeps %s as the first stop reason during failed termination', async (first) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-stop-once-'));
    const pidFile = path.join(root, 'pid');
    const controller = new AbortController();
    const before = ['exit', 'SIGINT', 'SIGTERM'].map(event => process.listenerCount(event));
    let kills = 0, child, closed, fireDeadline, heldDeadline, captures = 0;
    const realSetTimeout = globalThis.setTimeout.bind(globalThis);
    const timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms, ...args) => {
      if (ms === 100) {
        captures++;
        fireDeadline = () => callback(...args);
        // Scheduling is deliberately under test control; this remains a real cancellable handle.
        heldDeadline = realSetTimeout(() => {}, 60_000);
        return heldDeadline;
      }
      return realSetTimeout(callback, ms, ...args);
    });
    let pending;
    try {
      pending = spawnNativeHost(process.execPath, ['-e',
        `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`], {
        stdio: ['pipe', 'pipe', 'pipe'], timeout: 100, signal: controller.signal,
        terminationFallbackMs: 200,
        killProcessTree: (owned) => {
          kills++;
          if (!child) {
            child = owned;
            closed = new Promise(resolve => child.once('close', resolve));
          }
        },
      });
    } finally { timerSpy.mockRestore(); } // No await while the global spy is installed.
    try {
      expect(captures).toBe(1);
      expect(typeof fireDeadline).toBe('function');
      await waitUntil(() => fs.existsSync(pidFile));
      if (first === 'abort') { controller.abort(); fireDeadline(); }
      else { fireDeadline(); controller.abort(); }
      const result = await pending;
      expect(result.aborted).toBe(first === 'abort');
      expect(result.timedOut).toBe(first === 'timeout');
      expect(result.error?.message).toBe(first === 'abort'
        ? 'native host aborted' : 'native host timed out after 100ms');
      expect(kills).toBe(1); // Assert before final cleanup closes the still-running child.
      expect(result.status).toBeNull();
      expect(result.signal).toBeNull();
      expect(result.terminationConfirmed).toBe(false);
      expect(result.outputTrusted).toBe(false);
    } finally {
      clearTimeout(heldDeadline);
      // Also handles failure before readiness: abort captures the owned ChildProcess directly.
      controller.abort();
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await pending;
      if (closed) await closed;
      await waitUntil(() => ['exit', 'SIGINT', 'SIGTERM']
        .every((event, index) => process.listenerCount(event) === before[index]));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('bounds hostile stdout and reports a transport failure', async () => {
    const result = await spawnNativeHost(process.execPath, ['-e', 'process.stdout.write("x".repeat(17 * 1024 * 1024)); setInterval(() => {}, 1000)'],
      {stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000});
    expect(result.error?.message).toMatch(/output limit/);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(result.status).toBeNull();
  });

  it('bounds hostile stderr as well', async () => {
    const result = await spawnNativeHost(process.execPath, ['-e', 'process.stderr.write("x".repeat(17 * 1024 * 1024)); setInterval(() => {}, 1000)'],
      {stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000});
    expect(result.error?.message).toMatch(/output limit/);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(result.status).toBeNull();
  });

  it('retains ownership through an unconfirmed timeout fallback until close', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-fallback-'));
    const pidFile = path.join(root, 'pid');
    const before = ['exit', 'SIGINT', 'SIGTERM'].map(event => process.listenerCount(event));
    const resultPromise = spawnNativeHost(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`],
      {stdio: ['pipe', 'pipe', 'pipe'], timeout: 10, killProcessTree: () => {}, terminationFallbackMs: 25});
    try {
      await waitUntil(() => fs.existsSync(pidFile));
      const result = await resultPromise;
      expect(result.timedOut).toBe(true);
      expect(result.terminationConfirmed).toBe(false);
      expect(result.signal).toBeNull();
      expect(process.listenerCount('exit')).toBeGreaterThan(before[0]);
      process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL');
      await waitUntil(() => process.listenerCount('exit') === before[0]);
    } finally {
      fs.rmSync(root, {recursive: true, force: true});
    }
  });

  it('marks a timeout termination confirmed only after close', async () => {
    const result = await spawnNativeHost(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
      {stdio: ['pipe', 'pipe', 'pipe'], timeout: 10});
    expect(result.timedOut).toBe(true);
    expect(result.terminationConfirmed).toBe(process.platform !== 'win32');
  });

  // Windows forcibly terminates a process on OS SIGTERM/SIGINT; those are not catchable Node events.
  for (const mode of process.platform === 'win32' ? ['exit'] : ['exit', 'SIGTERM', 'SIGINT']) {
    it(`cleans owned grandchildren when the parent receives ${mode}`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-owner-'));
      const pidFile = path.join(root, 'grandchild.pid');
      const readyFile = path.join(root, 'ready');
      const hostFile = path.join(root, 'host.mjs');
      const parentFile = path.join(root, 'parent.mjs');
      const moduleUrl = new URL('../../scripts/native-host-process.mjs', import.meta.url).href;
      fs.writeFileSync(hostFile, `import {spawn} from 'node:child_process';import fs from 'node:fs';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);`);
      fs.writeFileSync(parentFile, `import {spawnNativeHost} from ${JSON.stringify(moduleUrl)};import fs from 'node:fs';
void spawnNativeHost(process.execPath,[${JSON.stringify(hostFile)}],{stdio:['pipe','pipe','pipe'],timeout:10000});
const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(pidFile)})){clearInterval(timer);fs.writeFileSync(${JSON.stringify(readyFile)},'ready');${mode === 'exit' ? 'process.exit(0);' : ''}}},10);`);
      const parent = spawn(process.execPath, [parentFile], {stdio: 'ignore'});
      const closed = new Promise(resolve => parent.once('close', resolve));
      let grandchild;
      try {
        await waitUntil(() => fs.existsSync(readyFile));
        grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
        if (mode !== 'exit') parent.kill(mode);
        await closed;
        await waitUntil(() => !alive(grandchild));
      } finally {
        parent.kill('SIGKILL');
        if (grandchild && alive(grandchild)) process.kill(grandchild, 'SIGKILL');
        fs.rmSync(root, {recursive: true, force: true});
      }
    }, 10000);
  }
});


describe('shared shipped process owner', () => {
  it('root and payload imports share the same functions and ownership registry', async () => {
    const payload = await import('../../plugin/scripts/native-host-process.mjs');
    expect(payload.spawnNativeHost).toBe(spawnNativeHost);
    expect(payload.trackProcessTree).toBe(trackProcessTree);
  });

  it('keeps the native default above the smaller hook output allowance', async () => {
    const result = await spawnNativeHost(process.execPath, ['-e', 'process.stdout.write("x".repeat(2*1024*1024))'], {
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBe(2 * 1024 * 1024);
    expect(result.outputTrusted).toBe(true);
  });

  it('rejects a multibyte hook output overflow and never trusts its partial lines', async () => {
    const result = await spawnNativeHost(process.execPath, ['-e', 'process.stdout.write("é".repeat(1000))'], {
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000, maxBuffer: 1000,
    });
    expect(result.error?.message).toMatch(/output limit/);
    expect(result.outputTrusted).toBe(false);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1000);
  });

  it('allows an explicitly configured producer to close stdin before returning complete output', async () => {
    const result = await spawnNativeHost(process.execPath, ['-e', 'require("fs").closeSync(0); setTimeout(()=>console.log("complete"),30)'], {
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000, allowEarlyStdinClose: true,
    }, 'x'.repeat(512 * 1024));
    expect(result.outputTrusted).toBe(true);
    expect(result.stdout.trim()).toBe('complete');
  });
});
