import { spawn, execFileSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

/** Terminate the owned process tree, not only its shell or worker parent. */
export function killProcessTree(child, { timeoutMs = 2000 } = {}) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: Math.max(1, Math.ceil(timeoutMs)), windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch (error) {
    if (error.code === 'ESRCH') return;
    try { child.kill('SIGKILL'); } catch { /* preserve the tree-termination error */ }
    throw error;
  }
}

// One registry per process: normal completion removes listeners, while parent
// exit or termination signals kill all still-owned descendants synchronously.
const ownedChildren = new Map();
const signalHandlers = new Map();
const killOwnedChildren = () => {
  for (const [child, timeoutMs] of ownedChildren) {
    try { killProcessTree(child, { timeoutMs }); } catch { /* parent cannot recover during exit */ }
  }
};
function removeOwnershipListeners() {
  process.off('exit', killOwnedChildren);
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  signalHandlers.clear();
}
function processGroupGoneNow(pid) {
  if (process.platform === 'win32' || !pid) return false;
  try { process.kill(-pid, 0); return false; }
  catch (error) { if (error.code === 'ESRCH') return true; return false; }
}

async function processGroupGone(pid, timeoutMs) {
  if (process.platform === 'win32') return false;
  const deadline = performance.now() + timeoutMs;
  while (true) {
    try { process.kill(-pid, 0); }
    catch (error) {
      if (error.code === 'ESRCH') return true;
      // A just-terminated detached group can briefly report EPERM while its
      // members are being reaped. Treat that as still present and keep the
      // bounded poll honest instead of turning normal cleanup into failure.
      if (error.code !== 'EPERM') throw error;
    }
    if (performance.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function monitorOwnedGroup(child, release) {
  if (process.platform === 'win32' || !child?.pid) return;
  const check = () => {
    if (processGroupGoneNow(child.pid)) { release(); return; }
    // Returning a bounded failure must not abandon ownership of a surviving group.
    // Unreferenced polling does not keep the parent alive; exit cleanup still owns it.
    setTimeout(check, 100).unref();
  };
  setTimeout(check, 100).unref();
}

export function trackProcessTree(child, { terminationTimeoutMs = 2000 } = {}) {
  if (ownedChildren.size === 0) {
    process.on('exit', killOwnedChildren);
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const handler = () => {
        killOwnedChildren();
        // Keep this registry alive when another application handler is keeping the
        // process alive. A later invocation must still be able to clean a child
        // registered while the first signal was being handled. Only remove our
        // handlers when re-raising the signal into Node's default termination path.
        const otherHandlers = process.listeners(signal).some((listener) => listener !== handler);
        if (!otherHandlers) {
          removeOwnershipListeners();
          process.kill(process.pid, signal);
        }
      };
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
  }
  ownedChildren.set(child, terminationTimeoutMs);
  return () => {
    ownedChildren.delete(child);
    if (ownedChildren.size === 0) removeOwnershipListeners();
  };
}

/** One bounded process-tree transport for subscription host invocations. */
export function spawnNativeHost(binary, args, options, input = '') {
  return new Promise((resolve) => {
    const { timeout = 900000, killSignal: _signal, killProcessTree: terminate = killProcessTree,
      terminationFallbackMs = 2000, maxBuffer = 16 * 1024 * 1024, allowEarlyStdinClose = false, signal: abortSignal, ...spawnOptions } = options;
    if (abortSignal?.aborted) {
      resolve({ status: null, signal: null, terminationConfirmed: true, stdout: '', stderr: 'native host aborted before launch',
        error: new Error('native host aborted before launch'), aborted: true, timedOut: false, durationMs: 0 });
      return;
    }
    if (!Number.isSafeInteger(maxBuffer) || maxBuffer <= 0 || maxBuffer > 16 * 1024 * 1024) {
      throw new Error('maxBuffer must be a positive integer no greater than 16 MiB');
    }
    const OUTPUT_LIMIT = maxBuffer;
    const started = performance.now();
    let timedOut = false, aborted = false;
    const detached = process.platform !== 'win32';
    const child = spawn(binary, args, { ...spawnOptions, detached });
    const releaseOwnership = trackProcessTree(child, { terminationTimeoutMs: terminationFallbackMs });
    let stdout = '', stderr = '', stdoutBytes = 0, stderrBytes = 0;
    let failure = null, settled = false, stopping = false, fallback = null, released = false;
    let exitCleanupStarted = false, cleanupRequestFailed = false;
    let cleanupDeadline = null;
    let closeObserved = false, observedExitStatus = null, observedExitSignal = null, ioFailure = false;
    const cleanupRemaining = () => {
      cleanupDeadline ??= performance.now() + terminationFallbackMs;
      return Math.max(0, cleanupDeadline - performance.now());
    };
    const terminateWithinBudget = () => terminate(child, { timeoutMs: Math.max(1, cleanupRemaining()) });
    const release = () => { if (!released) { released = true; releaseOwnership(); } };
    const bounded = (value) => Buffer.from(value).subarray(0, OUTPUT_LIMIT).toString('utf8');
    const finish = (status, signal = null, terminationConfirmed = false) => {
      if (settled) return;
      settled = true; clearTimeout(deadline); clearTimeout(fallback);
      abortSignal?.removeEventListener('abort', abort);
      resolve({ status: failure ? null : status, signal, terminationConfirmed, stdout, stderr, error: failure, aborted, timedOut,
        processStatus: observedExitStatus, outputComplete: closeObserved,
        outputTrusted: closeObserved && observedExitStatus === 0 && !observedExitSignal && !ioFailure && !aborted && !timedOut,
        durationMs: performance.now() - started });
    };
    const append = (stream, chunk) => {
      const current = stream === 'stdout' ? stdout : stderr;
      const chunkBytes = Buffer.byteLength(chunk);
      const bytes = (stream === 'stdout' ? stdoutBytes : stderrBytes) + chunkBytes;
      if (bytes > OUTPUT_LIMIT) {
        const error = new Error(`native host ${stream} exceeded ${OUTPUT_LIMIT} byte output limit`);
        if (!failure) failure = error;
        if (stream === 'stdout') { stdout = bounded(current); stdoutBytes = Buffer.byteLength(stdout); }
        else { stderr = bounded(current); stderrBytes = Buffer.byteLength(stderr); }
        stop(error);
        return;
      }
      if (stream === 'stdout') { stdout += chunk; stdoutBytes += chunkBytes; }
      else { stderr += chunk; stderrBytes += chunkBytes; }
    };
    const appendDiagnostic = (message) => {
      const diagnostic = `${stderr ? '\n' : ''}${message}`;
      const available = Math.max(0, OUTPUT_LIMIT - stderrBytes);
      const addition = new StringDecoder('utf8').write(Buffer.from(diagnostic).subarray(0, available));
      stderr += addition;
      stderrBytes += Buffer.byteLength(addition);
    };
    const stop = (error) => {
      if (settled || stopping) return;
      stopping = true;
      ioFailure = true;
      clearTimeout(deadline);
      failure ??= error;
      appendDiagnostic(error.message);
      try { terminateWithinBudget(); } catch (terminationError) { appendDiagnostic(`process tree termination failed: ${terminationError.message}`); }
      fallback ??= setTimeout(() => {
        child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy();
        // The tree kill request is not proof that the child actually exited. Keep ownership
        // listeners installed until close; report the fallback without inventing a signal.
        finish(null, null, false);
      }, cleanupRemaining());
    };
    child.once('exit', (status, signal) => {
      observedExitStatus = status; observedExitSignal = signal;
      if (settled || stopping) return;
      // `exit` precedes `close`. Start tree cleanup here so a descendant that
      // inherited stdio cannot hold the transport open until the global timeout.
      stopping = true;
      exitCleanupStarted = true;
      clearTimeout(deadline); clearTimeout(fallback); fallback = null;
      try { terminateWithinBudget(); } catch (terminationError) {
        if (process.platform === 'win32') appendDiagnostic(`process tree termination could not be confirmed: ${terminationError.message}`);
        else {
          cleanupRequestFailed = true;
          failure ??= new Error(`process tree cleanup failed after host exit: ${terminationError.message}`);
          appendDiagnostic(failure.message);
        }
      }
      fallback = setTimeout(() => {
        if (settled) return;
        const confirmed = process.platform !== 'win32' && Boolean(child.pid) && processGroupGoneNow(child.pid);
        if (!confirmed && process.platform !== 'win32' && child.pid) {
          failure ??= new Error('process tree termination could not be confirmed within the bounded cleanup window');
          appendDiagnostic(failure.message);
          monitorOwnedGroup(child, release);
        } else {
          release();
        }
        // Exit status alone cannot attest complete output: a descendant outside the
        // original group may still hold an inherited pipe. Native callers must fail
        // this fallback too, even when the original group has already disappeared.
        failure ??= new Error('native host output was not complete within the bounded cleanup window');
        appendDiagnostic(failure.message);
        child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy();
        finish(null, signal, confirmed);
      }, cleanupRemaining());
    });
    const abort = () => { if (!stopping && !settled) { aborted = true; stop(new Error('native host aborted')); } };
    const deadline = setTimeout(() => { if (!stopping && !settled) { timedOut = true; stop(new Error(`native host timed out after ${timeout}ms`)); } }, timeout);
    child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', chunk => { append('stdout', chunk); });
    child.stderr?.on('data', chunk => { append('stderr', chunk); });
    child.stdin?.on('error', (error) => {
      if (allowEarlyStdinClose && ['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED'].includes(error.code)) return;
      stop(error);
    });
    child.once('error', error => { ioFailure = true; failure = error; append('stderr', error.message); });
    child.once('close', async (status, signal) => {
      closeObserved = true; observedExitStatus = status; observedExitSignal = signal;
      // Stop's fallback can settle the promise before close. Cancel both timers before
      // checking the detached group so no old callback races this cleanup.
      stopping = true;
      clearTimeout(deadline); clearTimeout(fallback); fallback = null;
      // A host may exit cleanly while a stdio-ignored descendant keeps the detached
      // process group alive. Clean that group before dropping ownership; the parent's
      // close event alone is not termination evidence for the tree.
      let cleanupError = null;
      let terminationConfirmed = false;
      if (child.pid) {
        try {
          // The exit handler already issued the one tree termination request. A
          // second group kill can race process-group teardown and report EPERM.
          if (!exitCleanupStarted) terminateWithinBudget();
          terminationConfirmed = !cleanupRequestFailed
            && await processGroupGone(child.pid, cleanupRemaining());
          if (cleanupRequestFailed) cleanupError = failure || new Error('process tree cleanup request failed');
          if (!terminationConfirmed && process.platform !== 'win32') {
            cleanupError = new Error('process tree termination could not be confirmed within the bounded cleanup window');
          }
        } catch (error) {
          // On Windows the root PID may disappear before taskkill can inspect its
          // descendants. Preserve the host result and report termination as unknown.
          if (process.platform === 'win32') {
            appendDiagnostic(`process tree termination could not be confirmed: ${error.message}`);
          } else {
            cleanupError = new Error(`process tree cleanup failed after host close: ${error.message}`);
          }
        }
      }
      if (cleanupError) {
        failure ??= cleanupError;
        appendDiagnostic(failure.message);
      } else if (process.platform === 'win32') {
        // taskkill can report the root PID gone while an ignored descendant survives;
        // Windows provides no bounded proof here, so never report false certainty.
        terminationConfirmed = false;
      }
      if (terminationConfirmed || process.platform === 'win32' || !child.pid
        || (cleanupError && processGroupGoneNow(child.pid))) release();
      else monitorOwnedGroup(child, release);
      finish(cleanupError ? null : status, signal, terminationConfirmed);
    });
    abortSignal?.addEventListener('abort', abort, { once: true });
    if (abortSignal?.aborted) abort();
    try { child.stdin?.end(input); } catch (error) { stop(error); }
  });
}
