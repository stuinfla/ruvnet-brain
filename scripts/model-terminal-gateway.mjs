#!/usr/bin/env node
// Per-launch Unix WebSocket adapter for the native subscription TUI. No daemon lifecycle ownership.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { Duplex, PassThrough, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { connectNativeGateway, decideNativeTurn, nativeGatewayLaunch } from './model-routing-gateway.mjs';
import { subscriptionEnvironment, assertSubscriptionAuth } from './model-router-dispatch.mjs';

export const MAX_TERMINAL_BYTES = 64 * 1024 * 1024;
const REFUSED = 'Native terminal routing unavailable; request was not sent.';
const COMMANDS = new Set(['agents', 'exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin', 'app-server',
  'remote-control', 'app', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'resume',
  'queue', 'archive', 'delete', 'migrate-rollouts', 'unarchive', 'fork', 'cloud', 'exec-server', 'features', 'help']);
const ADMIN = new Set(['login', 'logout', 'mcp', 'plugin', 'completion', 'update', 'doctor', 'features', 'help']);
const VALUES = new Set(['-c', '--config', '--enable', '--disable', '-i', '--image', '-m', '--model',
  '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '--add-dir', '-a', '--ask-for-approval']);

/** Short Unix roots avoid long environment-provided temp paths; Windows has no qualified transport. */
export function terminalTempRoot(platform = process.platform) {
  if (!['darwin', 'linux'].includes(platform)) throw new Error('Native Unix terminal routing requires macOS or Linux');
  return platform === 'darwin' ? '/private/tmp' : '/tmp';
}

/** Keep native arguments verbatim; only proved interactive paths may enter the routed transport. */
export function classifyTerminalArguments(args = []) {
  if (args.some((arg) => /^--(?:remote(?:-auth-token-env)?|no-daemon)(?:=|$)/.test(arg))) {
    throw new Error('Explicit remote or no-daemon transport conflicts with terminal routing');
  }
  let first;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') return 'interactive'; // Native '--' ends subcommand parsing: following words are prompts.
    if (VALUES.has(arg)) { index++; continue; }
    if (arg.startsWith('-')) continue;
    first = arg; break;
  }
  if (ADMIN.has(first) || (!first && args.some((arg) => ['--help', '-h', '--version', '-V'].includes(arg)))) return 'admin';
  if (COMMANDS.has(first) && !['resume', 'fork'].includes(first)) {
    throw new Error(`Native command ${first} has no proved terminal routing transport`);
  }
  return 'interactive';
}

/** Reject symlinks and foreign/group-accessible endpoints, including their containing directory. */
export function validateUpstreamSocket(socketPath, { uid = process.getuid?.() } = {}) {
  if (!path.isAbsolute(socketPath || '') || uid == null) throw new Error('Owned absolute Unix socket required');
  const normalized = path.normalize(socketPath);
  let current = normalized;
  while (true) {
    const entry = fs.lstatSync(current);
    if (entry.isSymbolicLink()) throw new Error('Symlink in upstream socket path refused');
    if (current === normalized && (!entry.isSocket() || entry.uid !== uid || (entry.mode & 0o077))) {
      throw new Error('Upstream must be an owned private Unix socket');
    }
    if (current === path.dirname(normalized) && (!entry.isDirectory() || entry.uid !== uid || (entry.mode & 0o077))) {
      throw new Error('Upstream socket directory must be owned and private');
    }
    if (current === path.dirname(current)) break;
    current = path.dirname(current);
  }
  return normalized;
}

function jsonPacket(text) {
  const packet = JSON.parse(text);
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)
    || !(typeof packet.method === 'string' || (Object.hasOwn(packet, 'id')
      && (Object.hasOwn(packet, 'result') || Object.hasOwn(packet, 'error'))))) throw new Error(REFUSED);
  if (Object.hasOwn(packet, 'id') && !(typeof packet.id === 'string' || Number.isSafeInteger(packet.id))) throw new Error(REFUSED);
  return packet;
}

/** Official proxy is a byte tunnel: perform the daemon's /rpc WebSocket handshake over its stdio. */
export async function connectProxyWebSocket(proxy, { startupMs = 10000, maxBytes = MAX_TERMINAL_BYTES } = {}) {
  const { WebSocket } = await import('ws');
  const tunnel = Duplex.from({ readable: proxy.stdout, writable: proxy.stdin });
  // createConnection always returns the owned tunnel; even the placeholder endpoint is Unix-only.
  const ws = new WebSocket('ws+unix:///native-proxy:/rpc', { createConnection: () => tunnel,
    perMessageDeflate: false, maxPayload: maxBytes, handshakeTimeout: startupMs, followRedirects: false });
  const child = new EventEmitter(); child.on('error', () => {});
  child.stdout = new PassThrough({ highWaterMark: 65536 }); child.stderr = proxy.stderr;
  child.exitCode = null; child.signalCode = null;
  let closed = false, ready = false, buffer = '';
  const decoder = new StringDecoder('utf8');
  const fail = () => { if (!closed) { child.emit('error', new Error(REFUSED)); child.kill('SIGTERM'); } };
  child.kill = (signal) => {
    if (closed && signal !== 'SIGKILL') return;
    if (!closed) { closed = true; ws.terminate(); tunnel.destroy(); }
    const sent = proxy.kill(signal);
    if (signal !== 'SIGKILL') {
      const killer = setTimeout(() => { if (proxy.exitCode == null && proxy.signalCode == null) proxy.kill('SIGKILL'); }, 1000);
      killer.unref(); proxy.once('exit', () => clearTimeout(killer));
    } child.exitCode = proxy.exitCode; child.signalCode = proxy.signalCode;
    return sent;
  };
  child.stdin = new Writable({ highWaterMark: 65536, write(chunk, _encoding, callback) {
    try {
      buffer += decoder.write(chunk); if (Buffer.byteLength(buffer) > maxBytes) throw new Error(REFUSED);
      const lines = buffer.split('\n'); buffer = lines.pop(); let index = 0;
      const send = () => {
        if (index === lines.length) { callback(); return; }
        const line = lines[index++]; jsonPacket(line);
        if (closed || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount + Buffer.byteLength(line) > maxBytes) throw new Error(REFUSED);
        ws.send(line, { binary: false }, (error) => {
          if (error) { callback(error); fail(); return; }
          try { send(); } catch (error) { callback(error); fail(); }
        });
      }; send();
    } catch (error) { callback(error); fail(); }
  } });
  child.stdin.on('error', fail); child.stdout.on('error', fail);
  ws.on('message', (bytes, binary) => {
    try {
      if (binary || bytes.length > maxBytes || child.stdout.writableLength + bytes.length + 1 > maxBytes) throw new Error(REFUSED);
      const line = new TextDecoder('utf-8', { fatal: true }).decode(bytes); jsonPacket(line);
      if (!child.stdout.write(line + '\n')) ws.pause();
    } catch { fail(); }
  });
  child.stdout.on('drain', () => { if (!closed) ws.resume(); });
  proxy.once('error', (error) => child.emit('error', error));
  proxy.once('exit', (code, signal) => {
    child.exitCode = code; child.signalCode = signal; child.emit('exit', code, signal);
    if (!closed) { closed = true; ws.terminate(); tunnel.destroy(); }
  });
  ws.on('error', () => { if (ready) fail(); });
  ws.once('close', () => { if (ready && !closed) fail(); });
  try {
    await new Promise((resolve, reject) => {
      const rejectProxy = () => reject(new Error(REFUSED));
      proxy.once('exit', rejectProxy); proxy.once('error', rejectProxy);
      ws.once('error', rejectProxy); ws.once('close', rejectProxy);
      ws.once('open', () => { proxy.removeListener('exit', rejectProxy); proxy.removeListener('error', rejectProxy);
        ws.removeListener('error', rejectProxy); ws.removeListener('close', rejectProxy); ready = true; resolve(); });
    });
  } catch (error) { child.kill('SIGTERM'); throw error; }
  return child;
}

/** Real HTTP/WebSocket framing over one private Unix socket, converted to native JSONL streams. */
export async function createTerminalTransport({ child, diagnostics = process.stderr, gatewayOptions = {},
  tempRoot, maxBytes = MAX_TERMINAL_BYTES, startupMs = 10000, onFailure = () => {} } = {}) {
  const defaultTempRoot = terminalTempRoot();
  const { WebSocketServer, WebSocket } = await import('ws');
  if (!child?.stdin || !child?.stdout) throw new Error('Native proxy child required');
  if (!(maxBytes > 0 && maxBytes <= MAX_TERMINAL_BYTES)) throw new Error('Invalid transport byte bound');
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(tempRoot ?? defaultTempRoot), 'crt-'));
  fs.chmodSync(directory, 0o700);
  const socketPath = path.join(directory, 'r.sock');
  if (Buffer.byteLength(socketPath) > 100) { fs.rmSync(directory, { recursive: true }); throw new Error('Unix socket path too long'); }
  const server = http.createServer((_request, response) => { response.writeHead(403); response.end(); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxBytes, perMessageDeflate: false });
  const input = new PassThrough({ highWaterMark: 65536 });
  let client, claimed = false, gateway, closed = false, outputBuffer = '', failed = false;
  const decoder = new StringDecoder('utf8'), initializations = new Set();
  let resolveConnected, resolveReady;
  const connected = new Promise((resolve) => { resolveConnected = resolve; });
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const close = () => {
    if (closed) return;
    closed = true; clearTimeout(timer); gateway?.close(); input.destroy(); output.destroy();
    client?.terminate(); wss.close(); server.close();
    // This is the only child and filesystem tree owned by this launch.
    child.kill?.('SIGTERM');
    const killer = setTimeout(() => { if (child.exitCode == null && child.signalCode == null) child.kill?.('SIGKILL'); }, 1000);
    killer.unref(); child.once?.('exit', () => clearTimeout(killer));
    fs.rmSync(directory, { recursive: true, force: true }); resolveConnected(false); resolveReady(false);
  };
  const fail = () => {
    if (closed) return;
    failed = true; diagnostics.write(`[native-terminal-routing] ${REFUSED}\n`); close(); onFailure();
  };
  const output = new Writable({ highWaterMark: 65536, write(chunk, _encoding, callback) {
    try {
      outputBuffer += decoder.write(chunk);
      if (Buffer.byteLength(outputBuffer) > maxBytes) throw new Error(REFUSED);
      const lines = outputBuffer.split('\n'); outputBuffer = lines.pop();
      let index = 0;
      const send = () => {
        if (index >= lines.length) { callback(); return; }
        const line = lines[index++], packet = jsonPacket(line);
        if (initializations.has(packet.id)) {
          if (packet.error) throw new Error(REFUSED);
          initializations.delete(packet.id); clearTimeout(timer); resolveReady(true);
        }
        if (closed || client?.readyState !== WebSocket.OPEN || client.bufferedAmount + Buffer.byteLength(line) > maxBytes) throw new Error(REFUSED);
        client.send(line, { binary: false }, (error) => {
          if (error) { callback(error); fail(); return; }
          try { send(); } catch (error) { callback(error); fail(); }
        });
      };
      send();
    } catch (error) { callback(error); fail(); }
  } });
  output.on('error', fail); input.on('error', fail);
  const timer = setTimeout(fail, startupMs);
  server.on('error', fail); wss.on('error', fail);
  server.on('upgrade', (request, socket, head) => {
    // Refuse a second client for this launch, including reconnect after disconnect.
    if (closed || claimed || request.url !== '/rpc' || request.headers.origin) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    claimed = true;
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws));
  });
  wss.on('connection', (ws) => {
    client = ws;
    gateway = connectNativeGateway({ ...gatewayOptions, harness: 'codex', child, input, output, diagnostics });
    ws.on('message', (bytes, binary) => {
      try {
        if (binary || bytes.length > maxBytes || closed) throw new Error(REFUSED);
        const line = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const packet = jsonPacket(line);
        if (packet.method === 'initialize' && Object.hasOwn(packet, 'id')) initializations.add(packet.id);
        // Shared daemon ownership never crosses this per-client boundary.
        if (['shutdown', 'exit'].includes(packet.method)) {
          if (Object.hasOwn(packet, 'id')) ws.send(JSON.stringify({ id: packet.id, error: { code: -32001, message: 'Shared daemon shutdown refused' } }));
          return;
        }
        if (gateway.spoolState().queuedBytes + input.writableLength + Buffer.byteLength(line) + 1 > maxBytes) throw new Error(REFUSED);
        if (!input.write(JSON.stringify(packet) + '\n')) ws.pause();
      } catch { fail(); }
    });
    input.on('drain', () => { if (!closed) ws.resume(); });
    ws.once('close', close); ws.on('error', fail); resolveConnected(true);
  });
  child.once('error', fail); child.once('exit', fail);
  child.stdin.on('error', fail); child.stdout.on('error', fail);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject); server.listen(socketPath, () => { server.removeListener('error', reject); resolve(); });
    });
    if (closed) throw new Error(REFUSED);
    fs.chmodSync(socketPath, 0o600);
  } catch (error) { close(); throw error; }
  return { socketPath, directory, remote: `unix://${socketPath}`, connected, ready, close,
    failed: () => failed, gateway: () => gateway };
}

export function parseTerminalInvocation(argv, env = process.env) {
  const args = [...argv]; let realBinary = env.MODEL_ROUTER_REAL_CODEX, upstreamSocket;
  while (args.length && args[0] !== '--') {
    const flag = args.shift();
    if (!['--real-binary', '--upstream-socket'].includes(flag) || !args.length) throw new Error('Explicit terminal gateway options required');
    if (flag === '--real-binary') realBinary = args.shift(); else upstreamSocket = args.shift();
  }
  if (args[0] === '--') args.shift();
  return { realBinary, upstreamSocket, args, env };
}

export async function runTerminalGateway({ realBinary, upstreamSocket, args = [], env = process.env,
  spawnNative = spawn, adaptProxy = connectProxyWebSocket, gatewayOptions = {}, startupMs = 10000, tempRoot,
  signalSource = process, diagnostics = process.stderr } = {}) {
  if (!path.isAbsolute(realBinary || '')) throw new Error('Explicit absolute native executable required');
  const binary = fs.realpathSync(realBinary), clean = subscriptionEnvironment(env);
  if (env.MODEL_ROUTER_TERMINAL_ACTIVE || env.MODEL_ROUTER_GATEWAY_ACTIVE) throw new Error('Terminal routing recursion refused');
  const mode = classifyTerminalArguments(args);
  if (mode === 'admin') {
    const child = spawnNative(binary, args, { env: clean, shell: false, stdio: 'inherit' });
    return await exitOf(child);
  }
  const defaultTempRoot = terminalTempRoot();
  tempRoot ??= defaultTempRoot;
  // Reuse the established provider/config guards; this does not spawn app-server.
  const normalized = nativeGatewayLaunch({ harness: 'codex', realBinary: binary, args: ['app-server', ...args], env: clean });
  // Native global options precede the original subcommand/prompt, including a literal '--'.
  const standardOverrides = normalized.args.slice(args.length + 1);
  const socketPath = validateUpstreamSocket(upstreamSocket || path.join(clean.CODEX_HOME || path.join(os.homedir(), '.codex'), 'app-server-control', 'app-server-control.sock'));
  const auth = () => assertSubscriptionAuth('codex', { env: clean }); auth();
  clean.MODEL_ROUTER_TERMINAL_ACTIVE = '1';
  const proxy = spawnNative(binary, ['app-server', 'proxy', '--sock', socketPath], { env: clean, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let tui, transport, forcedFailure = false;
  const handlers = new Map();
  try {
    const backend = await adaptProxy(proxy, { startupMs });
    transport = await createTerminalTransport({ child: backend, diagnostics, startupMs, tempRoot,
      onFailure: () => { forcedFailure = true; tui?.kill('SIGTERM'); },
      gatewayOptions: { ...gatewayOptions, checkAuth: auth,
        decide: gatewayOptions.decide || ((prompt, harness, metadata) => decideNativeTurn(prompt, harness, { env: clean, ...metadata })) } });
    if (transport.failed()) throw new Error(REFUSED);
    tui = spawnNative(binary, ['--remote', transport.remote, ...standardOverrides, ...args], { env: clean, shell: false, stdio: 'inherit' });
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const handler = () => { transport.close(); tui.kill(signal); };
      handlers.set(signal, handler); signalSource.on(signal, handler);
    }
    const result = await exitOf(tui);
    return forcedFailure ? { code: 1, signal: null } : result;
  } finally {
    handlers.forEach((handler, signal) => signalSource.removeListener(signal, handler));
    if (transport) transport.close(); else proxy.kill('SIGTERM');
  }
}

function exitOf(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTerminalGateway(parseTerminalInvocation(process.argv.slice(2))).then(({ code, signal }) => {
    if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); }
    else process.exitCode = code ?? 1;
  }).catch((error) => { process.stderr.write(`[native-terminal-routing] ${error.message}\n`); process.exitCode = 1; });
}
