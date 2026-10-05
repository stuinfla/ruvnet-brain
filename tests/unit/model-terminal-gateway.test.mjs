import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { describe, it, expect, afterEach } from 'vitest';
import { createTerminalTransport, classifyTerminalArguments, validateUpstreamSocket, connectProxyWebSocket,
  parseTerminalInvocation, runTerminalGateway, terminalTempRoot, MAX_TERMINAL_BYTES } from '../../scripts/model-terminal-gateway.mjs';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
async function until(check) { for (let n = 0; n < 100; n++) { if (check()) return; await tick(); } throw new Error('Fixture timeout'); }
function backend() {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: null, kills: [] });
  child.kill = (signal) => { child.kills.push(signal); child.signalCode = signal; child.emit('exit', null, signal); };
  const sent = []; let buffer = '';
  child.stdin.on('data', (chunk) => {
    buffer += chunk; let at;
    while ((at = buffer.indexOf('\n')) !== -1) {
      const packet = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1); sent.push(packet);
      if (packet.method === 'initialize') child.stdout.write(JSON.stringify({ id: packet.id, result: { userAgent: 'fixture' } }) + '\n');
      if (packet.method === 'account/read') child.stdout.write(JSON.stringify({ id: packet.id, result: { account: { type: 'chatgpt' } } }) + '\n');
      if (packet.method === 'config/read') child.stdout.write(JSON.stringify({ id: packet.id, result: { config: { model_provider: 'openai', service_tier: 'default', features: { fast_mode: false } } } }) + '\n');
      if (packet.method === 'thread/read') child.stdout.write(JSON.stringify({ id: packet.id, result: { thread: { id: packet.params.threadId, modelProvider: 'openai', cwd: fs.realpathSync(os.tmpdir()) } } }) + '\n');
      if (packet.method === 'account/rateLimits/read') child.stdout.write(JSON.stringify({ id: packet.id, result: { ordinaryUsageAllowed: true } }) + '\n');
      if (packet.method === 'turn/start') child.stdout.write(JSON.stringify({ id: packet.id, result: { turn: { id: 'turn' } } }) + '\n');
    }
  });
  return { child, sent };
}
const decision = { model: 'gpt-test', effort: 'low', harness: 'codex', taskClass: 'fast', subscriptionCovered: true };
async function fixture(options = {}) {
  const native = backend(), diagnostics = new PassThrough();
  const transport = await createTerminalTransport({ child: native.child, diagnostics, startupMs: 1000,
    gatewayOptions: { decide: async () => decision, verifyDecision: () => {}, receipt: () => {}, ...options.gatewayOptions }, ...options });
  cleanups.push(() => transport.close());
  const ws = new WebSocket(`ws+unix://${transport.socketPath}:/rpc`);
  ws.on('error', () => {});
  const received = []; ws.on('message', (bytes) => received.push(JSON.parse(bytes)));
  await once(ws, 'open');
  cleanups.push(() => ws.terminate());
  return { ...native, transport, ws, received, send: (packet) => ws.send(JSON.stringify(packet)) };
}
async function socketFixture() {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cts-')); fs.chmodSync(directory, 0o700);
  const file = path.join(directory, 'socket'); const server = net.createServer();
  await new Promise((resolve) => server.listen(file, resolve)); fs.chmodSync(file, 0o600);
  cleanups.push(() => new Promise((resolve) => server.close(() => { fs.rmSync(directory, { recursive: true, force: true }); resolve(); })));
  return { file, directory };
}

async function proxyFixture({ rejectUpgrade = false } = {}) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cpw-')); fs.chmodSync(directory, 0o700);
  const file = path.join(directory, 'socket'), server = http.createServer();
  const wss = new WebSocketServer({ noServer: true }); const requests = []; let peer;
  server.on('upgrade', (request, socket, head) => {
    requests.push({ url: request.url, origin: request.headers.origin });
    if (rejectUpgrade) { socket.end('HTTP/1.1 302 Found\r\nLocation: ws://invalid.example/\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(request, socket, head, (ws) => { peer = ws; wss.emit('connection', ws); });
  });
  await new Promise((resolve) => server.listen(file, resolve)); fs.chmodSync(file, 0o600);
  const socket = net.createConnection(file), proxy = new EventEmitter();
  Object.assign(proxy, { stdin: socket, stdout: socket, stderr: new PassThrough(), exitCode: null, signalCode: null, kills: [] });
  proxy.kill = (signal) => { proxy.kills.push(signal); proxy.signalCode = signal; socket.destroy(); proxy.emit('exit', null, signal); };
  cleanups.push(() => { socket.destroy(); peer?.terminate(); wss.close(); server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { proxy, requests, peer: () => peer };
}

describe('official proxy WebSocket framing', () => {
  it('handshakes /rpc over the owned byte tunnel and preserves native approval IDs', async () => {
    const f = await proxyFixture(), child = await connectProxyWebSocket(f.proxy, { startupMs: 1000 });
    expect(f.requests).toEqual([{ url: '/rpc', origin: undefined }]);
    const sent = []; f.peer().on('message', (bytes) => sent.push(JSON.parse(bytes)));
    const response = { id: 'approval', result: { decision: 'accept' } }; child.stdin.write(JSON.stringify(response) + '\n');
    await until(() => sent.length); expect(sent).toEqual([response]);
    let returned = ''; child.stdout.on('data', (chunk) => { returned += chunk; });
    const approval = { id: 'approval', method: 'item/commandExecution/requestApproval', params: { command: 'test' } };
    f.peer().send(JSON.stringify(approval)); await until(() => returned); expect(JSON.parse(returned)).toEqual(approval);
    child.kill('SIGTERM'); expect(f.proxy.kills).toEqual(['SIGTERM']);
  });
  it('fails closed on malformed or binary daemon frames', async () => {
    for (const payload of ['not json', Buffer.from('{"method":"thread/list"}')]) {
      const f = await proxyFixture(), child = await connectProxyWebSocket(f.proxy, { startupMs: 1000 });
      let error = false; child.on('error', () => { error = true; }); f.peer().send(payload);
      await until(() => error); expect(f.proxy.kills).toEqual(['SIGTERM']);
    }
  });
  it('refuses redirect handshakes without replay or another connection', async () => {
    const f = await proxyFixture({ rejectUpgrade: true });
    await expect(connectProxyWebSocket(f.proxy, { startupMs: 1000 })).rejects.toThrow();
    expect(f.requests).toHaveLength(1); expect(f.proxy.kills).toEqual(['SIGTERM']);
  });
});

describe('native terminal Unix WebSocket transport', () => {
  it('routes each native turn while preserving initialize, tool approval, interrupt and IDs', async () => {
    const f = await fixture();
    expect(fs.statSync(f.transport.directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(f.transport.socketPath).mode & 0o777).toBe(0o600);
    const initialize = { id: 1, method: 'initialize', params: { clientInfo: { name: 'native-tui' } } };
    f.send(initialize); await until(() => f.sent.length === 1); expect(f.sent[0]).toEqual(initialize); expect(await f.transport.ready).toBe(true);
    f.send({ id: 2, method: 'turn/start', params: { threadId: 'thread', input: [{ type: 'text', text: 'fixture' }], collaborationMode: { mode: 'default', settings: { developer_instructions: 'retained' } } } });
    await until(() => f.sent.some((p) => p.method === 'turn/start'));
    const turn = f.sent.find((p) => p.method === 'turn/start');
    expect(turn.params).toMatchObject({ model: 'gpt-test', effort: 'low', serviceTier: 'default', collaborationMode: { settings: { developer_instructions: 'retained' } } });
    const approval = { id: 'approval-id', method: 'item/commandExecution/requestApproval', params: { command: 'fixture' } };
    f.child.stdout.write(JSON.stringify(approval) + '\n'); await until(() => f.received.some((p) => p.id === approval.id));
    expect(f.received.find((p) => p.id === approval.id)).toEqual(approval);
    const allowed = { id: approval.id, result: { decision: 'accept' } }; f.send(allowed);
    const interrupt = { id: 4, method: 'turn/interrupt', params: { threadId: 'thread', turnId: 'turn' } }; f.send(interrupt);
    await until(() => f.sent.some((p) => p.id === 4));
    expect(f.sent.find((p) => p.id === approval.id)).toEqual(allowed); expect(f.sent.at(-1)).toEqual(interrupt);
    expect(f.received.some((p) => String(p.id).startsWith('model-routing-gateway:'))).toBe(false);
  });
  it('accepts the native /rpc request without Origin and rejects other handshake paths or origins', async () => {
    const native = backend(); const transport = await createTerminalTransport({ child: native.child, diagnostics: new PassThrough() });
    cleanups.push(() => transport.close());
    for (const [requestPath, headers] of [['/', {}], ['/rpc', { Origin: 'http://localhost' }]]) {
      const ws = new WebSocket(`ws+unix://${transport.socketPath}:${requestPath}`, { headers });
      await new Promise((resolve) => ws.once('error', resolve)); expect(ws.readyState).not.toBe(WebSocket.OPEN);
    }
    const accepted = new WebSocket(`ws+unix://${transport.socketPath}:/rpc`); accepted.on('error', () => {});
    await once(accepted, 'open'); cleanups.push(() => accepted.terminate()); expect(await transport.connected).toBe(true);
  });
  it('refuses a second client without breaking the first', async () => {
    const f = await fixture(); const other = new WebSocket(`ws+unix://${f.transport.socketPath}:/rpc`);
    const refused = new Promise((resolve) => other.once('error', resolve));
    await refused; expect(other.readyState).not.toBe(WebSocket.OPEN);
    f.send({ id: 8, method: 'thread/list', params: {} }); await until(() => f.sent.length === 1);
    expect(f.sent[0].id).toBe(8);
  });
  it('disconnect cancels a held routing decision and kills only the proxy', async () => {
    let resolveDecision; const f = await fixture({ gatewayOptions: { decide: () => new Promise((resolve) => { resolveDecision = resolve; }), verifyDecision: () => {}, receipt: () => {} } });
    f.send({ id: 9, method: 'turn/start', params: { threadId: 't', input: [{ type: 'text', text: 'held' }] } });
    await until(() => resolveDecision); f.ws.terminate(); await until(() => f.child.kills.length);
    resolveDecision(decision); await f.transport.gateway().idle();
    expect(f.sent).toEqual([]); expect(f.child.kills).toEqual(['SIGTERM']);
    expect(fs.existsSync(f.transport.directory)).toBe(false);
  });
  it.each(['not json', '[]', '{}', '{"id":9007199254740993,"method":"turn/start"}', '{"method":"turn/start"}\n{"method":"turn/start"}'])('fails closed on malformed frame %s', async (frame) => {
    const f = await fixture(); f.ws.send(frame); await until(() => f.child.kills.length);
    expect(f.sent).toEqual([]); expect(f.transport.failed()).toBe(true);
  });
  it('rejects binary and oversized frames without forwarding them', async () => {
    const f = await fixture({ maxBytes: 128 }); f.ws.send(Buffer.from('{"method":"thread/list"}'));
    await until(() => f.child.kills.length); expect(f.sent).toEqual([]);
    const g = await fixture({ maxBytes: 128 }); g.ws.send('x'.repeat(129));
    await until(() => g.child.kills.length); expect(g.sent).toEqual([]);
  });
  it('bounds retained turn backlog and stops unresolved work on overflow', async () => {
    const f = await fixture({ maxBytes: 256, gatewayOptions: { decide: () => new Promise(() => {}), timeoutMs: 20, receipt: () => {} } });
    const packet = { id: 10, method: 'turn/start', params: { input: [{ type: 'text', text: 'held'.repeat(8) }] } };
    f.send(packet); f.send({ ...packet, id: 11 }); f.send({ ...packet, id: 12 });
    await until(() => f.child.kills.length); expect(f.sent).toEqual([]); expect(f.transport.failed()).toBe(true);
  });
  it('never forwards shared daemon shutdown and bounds startup without a TUI connection', async () => {
    const f = await fixture(); f.send({ id: 12, method: 'shutdown' });
    await until(() => f.received.length); expect(f.sent).toEqual([]); expect(f.received[0].error.message).toMatch(/shutdown refused/);
    const native = backend(); const transport = await createTerminalTransport({ child: native.child, diagnostics: new PassThrough(), startupMs: 10 });
    expect(await transport.connected).toBe(false); expect(await transport.ready).toBe(false); expect(native.child.kills).toEqual(['SIGTERM']);
    expect(fs.existsSync(transport.directory)).toBe(false);
  });
  it('backend exit and malformed backend JSON fail closed and clean the private endpoint', async () => {
    const f = await fixture(); f.child.emit('exit', 2); await until(() => !fs.existsSync(f.transport.directory));
    expect(f.transport.failed()).toBe(true);
    const g = await fixture(); g.child.stdout.write('not json\n'); await until(() => g.child.kills.length);
    expect(g.transport.failed()).toBe(true);
  });
});

describe('terminal launch boundaries', () => {
  it('selects short platform roots without trusting a potentially long TMPDIR', () => {
    expect(terminalTempRoot('darwin')).toBe('/private/tmp');
    expect(terminalTempRoot('linux')).toBe('/tmp');
    expect(() => terminalTempRoot('win32')).toThrow(/requires macOS or Linux/);
  });
  it('uses the platform default for an actual private Unix socket and removes only its owned directory', async () => {
    const f = await fixture();
    expect(path.dirname(f.transport.directory)).toBe(fs.realpathSync(terminalTempRoot()));
    expect(Buffer.byteLength(f.transport.socketPath)).toBeLessThanOrEqual(100);
    expect(fs.statSync(f.transport.directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(f.transport.socketPath).mode & 0o777).toBe(0o600);
    f.transport.close(); expect(fs.existsSync(f.transport.directory)).toBe(false);
    expect(fs.existsSync(terminalTempRoot())).toBe(true);
  });
  it('fails closed on Windows even with an explicit root while preserving admin passthrough', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    const native = backend(), calls = [];
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
    try {
      await expect(createTerminalTransport({ child: native.child, tempRoot: '/nonexistent' })).rejects.toThrow(/requires macOS or Linux/);
      await expect(runTerminalGateway({ realBinary: process.execPath, tempRoot: '/nonexistent', spawnNative: () => { calls.push('interactive'); } })).rejects.toThrow(/requires macOS or Linux/);
      expect(native.child.kills).toEqual([]); expect(calls).toEqual([]);
      const result = await runTerminalGateway({ realBinary: process.execPath, args: ['--version'], spawnNative: (_command, args) => {
        calls.push(args); const child = new EventEmitter(); setImmediate(() => child.emit('exit', 0, null)); return child;
      } });
      expect(result).toEqual({ code: 0, signal: null }); expect(calls).toEqual([['--version']]);
    } finally { Object.defineProperty(process, 'platform', descriptor); }
  });
  it('validates owned actual sockets and rejects files, symlinks and accessible sockets/directories', async () => {
    const { file, directory } = await socketFixture(); expect(validateUpstreamSocket(file)).toBe(file);
    const link = path.join(directory, 'link'); fs.symlinkSync(file, link); expect(() => validateUpstreamSocket(link)).toThrow(/Symlink/);
    const regular = path.join(directory, 'regular'); fs.writeFileSync(regular, ''); expect(() => validateUpstreamSocket(regular)).toThrow(/private Unix socket/);
    expect(() => validateUpstreamSocket(file, { uid: process.getuid() + 1 })).toThrow();
    fs.chmodSync(file, 0o660); expect(() => validateUpstreamSocket(file)).toThrow(); fs.chmodSync(file, 0o600);
    fs.chmodSync(directory, 0o755); expect(() => validateUpstreamSocket(file)).toThrow(/directory/);
  });
  it('preserves admin and interactive classification and refuses unproved/conflicting transports', () => {
    for (const args of [[], ['--', 'login'], ['--', 'help'], ['--', 'update'], ['--', 'doctor'], ['--', 'exec'], ['resume', '--last'], ['fork', 'uuid'], ['-C', '/tmp', 'prompt'], ['--image', 'test.png', 'hello']]) expect(classifyTerminalArguments(args)).toBe('interactive');
    for (const args of [['--help'], ['--version'], ['login', 'status'], ['-c', 'foo=true', 'doctor']]) expect(classifyTerminalArguments(args)).toBe('admin');
    for (const arg of ['exec', 'e', 'review', 'queue', 'app-server', 'remote-control', 'cloud', '--remote=unix://', '--no-daemon', '--remote-auth-token-env=TOKEN']) expect(() => classifyTerminalArguments([arg])).toThrow();
    expect(parseTerminalInvocation(['--real-binary', '/native', '--upstream-socket', '/sock', '--', 'resume', '--last'], {})).toEqual({ realBinary: '/native', upstreamSocket: '/sock', args: ['resume', '--last'], env: {} });
    expect(MAX_TERMINAL_BYTES).toBe(67108864);
  });
  it.each([['resume', '--last', '--no-alt-screen'], ['--', 'login'], ['--', 'translate yes']])('launches native standard service before all original arguments %j', async (...originalArgs) => {
    const { file, directory } = await socketFixture(); fs.writeFileSync(path.join(directory, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'fixture' } }));
    const calls = [], native = backend(), signalSource = new EventEmitter(); let client;
    const args = [...originalArgs, '-C', directory];
    const result = await runTerminalGateway({ realBinary: process.execPath, upstreamSocket: file, args, adaptProxy: async (proxy) => proxy,
      env: { CODEX_HOME: directory, OPENAI_API_KEY: 'removed' }, signalSource, diagnostics: new PassThrough(),
      gatewayOptions: { decide: async () => decision, verifyDecision: () => {}, receipt: () => {} },
      spawnNative: (command, actualArgs, options) => {
        calls.push({ command, args: actualArgs, options });
        if (actualArgs[0] === 'app-server') return native.child;
        const tui = new EventEmitter(); tui.kill = (signal) => tui.emit('exit', null, signal);
        client = new WebSocket(`ws+unix://${actualArgs[1].slice(7)}:/rpc`); client.on('error', () => {});
        client.once('open', () => client.send(JSON.stringify({ id: 1, method: 'initialize', params: {} })));
        client.once('message', () => { client.terminate(); setImmediate(() => tui.emit('exit', 7, null)); });
        return tui;
      } });
    expect(result).toEqual({ code: 7, signal: null }); expect(calls).toHaveLength(2);
    expect(calls[0].args).toEqual(['app-server', 'proxy', '--sock', file]);
    expect(calls[1].args.slice(2, 8)).toEqual(['-c', 'model_provider="openai"', '-c', 'service_tier="default"', '-c', 'features.fast_mode=false']);
    expect(calls[1].args.slice(8)).toEqual(args); expect(calls[1].args[1]).toMatch(/^unix:\/\//);
    expect(calls[1].options.stdio).toBe('inherit'); expect(calls[1].options.env.OPENAI_API_KEY).toBeUndefined();
    expect(native.child.kills).toEqual(['SIGTERM']); expect(signalSource.listenerCount('SIGINT')).toBe(0);
  });
  it('bounds backend initialization and forwards termination signals to the TUI', async () => {
    const { file, directory } = await socketFixture(); fs.writeFileSync(path.join(directory, 'auth.json'), JSON.stringify({ tokens: {} }));
    for (const signal of [null, 'SIGHUP']) {
      const native = backend(), signalSource = new EventEmitter(); let client; const kills = [];
      const result = await runTerminalGateway({ realBinary: process.execPath, upstreamSocket: file, env: { CODEX_HOME: directory },
        startupMs: 20, adaptProxy: async (proxy) => proxy, signalSource, diagnostics: new PassThrough(), spawnNative: (_command, args) => {
          if (args[0] === 'app-server') return native.child;
          const tui = new EventEmitter(); tui.kill = (received) => { kills.push(received); tui.emit('exit', null, received); };
          client = new WebSocket(`ws+unix://${args[1].slice(7)}:/rpc`); client.on('error', () => {});
          if (signal) client.once('open', () => signalSource.emit(signal));
          return tui;
        } });
      client.terminate(); expect(native.child.kills).toEqual(['SIGTERM']);
      expect(result).toEqual(signal ? { code: null, signal } : { code: 1, signal: null });
      expect(kills).toEqual([signal || 'SIGTERM']); expect(signalSource.listenerCount('SIGHUP')).toBe(0);
    }
  });
  it('passes admin commands unchanged with inherited terminal and no backend', async () => {
    const calls = []; const result = await runTerminalGateway({ realBinary: process.execPath, args: ['--version'], env: { OPENAI_API_KEY: 'secret' },
      spawnNative: (command, args, options) => { calls.push({ command, args, options }); const child = new EventEmitter(); setImmediate(() => child.emit('exit', 7, null)); return child; } });
    expect(result).toEqual({ code: 7, signal: null }); expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['--version']); expect(calls[0].options.stdio).toBe('inherit'); expect(calls[0].options.env.OPENAI_API_KEY).toBeUndefined();
  });
});
