// Fresh native Codex allowance probe. Metadata only: never starts a thread or inference turn.
// An ordinary-allowance check cannot reserve quota or eliminate the check-to-use credit-draw race.
import { spawn } from 'node:child_process';

export function sanitizeAllowance(result, now = new Date().toISOString()) {
  if (result?.ordinaryUsageAllowed !== true) {
    throw new Error('Native ordinary subscription allowance unavailable or exhausted; no credit fallback authorized');
  }
  return { ordinaryUsageAllowed: true, checkedAt: now, reservation: false, raceSafe: false };
}

export function readCodexAllowance({ spawnHost = spawn, env = process.env, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnHost('codex', ['app-server', '--strict-config', '-c', 'service_tier="default"',
      '-c', 'features.fast_mode=false', '--listen', 'stdio://'], {
      env, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '', settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Native subscription allowance probe timed out; dispatch blocked')), timeoutMs);
    const send = (value) => child.stdin.write(JSON.stringify(value) + '\n');
    child.stdin.on?.('error', () => { if (!settled) finish(new Error('Native allowance transport failed; dispatch blocked')); });
    child.once('error', () => finish(new Error('Native subscription allowance host unavailable; dispatch blocked')));
    child.once('exit', () => { if (!settled) finish(new Error('Native subscription allowance host exited before proof; dispatch blocked')); });
    child.stderr.on('data', () => {}); // Never forward auth, account, or configuration diagnostics.
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      buffer += chunk.toString();
      if (buffer.length > 1048576) return finish(new Error('Native allowance response exceeded limit; dispatch blocked'));
      let split;
      while ((split = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, split); buffer = buffer.slice(split + 1);
        let response;
        try { response = JSON.parse(line); } catch { continue; }
        if (response.id === 1) {
          if (response.error) return finish(new Error('Native allowance initialization failed; dispatch blocked'));
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true, supportsLunaReserve: false } });
        } else if (response.id === 2) {
          if (response.error) return finish(new Error('Native allowance read failed; dispatch blocked'));
          try { finish(null, sanitizeAllowance(response.result)); }
          catch (error) { finish(error); }
        }
      }
    });
    send({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'model_router_allowance', version: '1' }, capabilities: { experimentalApi: true },
    } });
  });
}
