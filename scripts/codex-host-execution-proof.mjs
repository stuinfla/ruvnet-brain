// Explicitly authorized owned startup, NOT a read-only doctor action. Never imported by doctor.
// packageSha256/workerSha256 must come from independently authenticated release receipts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { probeFreshCodexDeclarations, classifyFreshCodexDeclarations } from './codex-fresh-host-proof.mjs';
import { runtimeSnapshot } from './model-routing-launchers.mjs';
import { maintenanceStatus } from '../plugin/scripts/development-maintenance.mjs';
import { proofFile, proofDigest, verifyReleasedHostRuntime, assertHostRuntimeUnchanged } from './codex-host-proof-runtime.mjs';

const OWNER = 'ruvnet-brain@ruvnet-brain';
// The diagnostic verifies the canonical ordinary-work route, never selects a separate model.
const ordinaryRoute = JSON.parse(fs.readFileSync(new URL('../config/model-router/routing-policy.template.json', import.meta.url), 'utf8')).routes.codex.medium;
const failure = (reason) => ({ ok: false, state: 'fresh-execution-unproven', scope: 'one-owned-codex-session-start-and-brain-search', reason,
  existingWindows: 'unproven', otherHooks: 'unknown', ongoingLiveness: 'unknown', startupHealth: 'unknown' });
export function startupDeclaration(listed, cwd) {
  const groups = listed?.data;
  if (!Array.isArray(groups) || groups.length !== 1 || groups[0]?.cwd !== cwd
    || !Array.isArray(groups[0].hooks) || !Array.isArray(groups[0].warnings) || !Array.isArray(groups[0].errors)
    || groups[0].warnings.length || groups[0].errors.length) throw new Error('Native registry errors, warnings, or scope prevent execution');
  const starts = groups[0].hooks.filter((row) => row.eventName === 'sessionStart' && row.enabled !== false);
  const triggered = new Set(['sessionStart', 'userPromptSubmit', 'stop', 'sessionEnd']);
  if (groups[0].hooks.some((row) => triggered.has(row.eventName) && row.enabled !== false
    && (row.pluginId !== OWNER || row.handlerType !== 'command' || !['trusted', 'managed'].includes(row.trustStatus)))) throw new Error('Foreign or non-command enabled turn/startup handler prevents owned execution');
  // Independently bound published siblings (e.g. learn-flush) may share this event/source file.
  const bodies = starts.filter((row) => /\s(?:\d+\s+)?session-start\s*$/.test(row.command || ''));
  if (bodies.length !== 1 || !Number.isSafeInteger(bodies[0].displayOrder) || bodies[0].displayOrder < 0) throw new Error('Exact published SessionStart body identity is unavailable');
  return bodies[0];
}
export function classifyOwnedExecution({ body, nonce, runtime, cwd, threadId, hookRuns, declaration, turnContext, search, mcp }) {
  if (body?.schema !== 1 || body.state !== 'body-executed' || body.nonce !== nonce || body.cwd !== cwd
    || body.version !== runtime.version || body.sourcePath !== path.join(runtime.codeRoot, 'scripts/session-start-core.mjs')
    || runtime.bindings.find((row) => row.path === body.sourcePath)?.sha256 !== body.sourceSha256
    || body.bodyFailed !== false || body.bannerFallback !== false || body.restore?.failed !== false
    || !Array.isArray(body.stages) || !body.stages.length || body.stages.some((stage) => stage.skipped !== false)
    || !body.stages.some((stage) => stage.name === 'banner')) throw new Error('Positive startup stage evidence is missing, failed, or skipped');
  const starts = hookRuns.filter((row) => row.threadId === threadId && row.run?.eventName === 'sessionStart' && row.run.displayOrder === declaration.displayOrder);
  if (starts.length !== 1 || starts[0].run.sourcePath !== declaration.sourcePath || starts[0].run.handlerType !== 'command'
    || starts[0].run.source !== 'plugin' || starts[0].run.status !== 'completed') throw new Error('Native startup notification is missing or mismatched');
  if (turnContext?.type !== 'turn_context' || turnContext.payload?.model !== ordinaryRoute.model
    || turnContext.payload.effort !== ordinaryRoute.effort || turnContext.payload.cwd !== cwd
    || ![null, undefined, 'default'].includes(turnContext.payload.service_tier)) throw new Error('Actual native ordinary-work Standard turn telemetry is unproven');
  const text = search?.content?.filter((row) => row.type === 'text').map((row) => row.text).join('\n') || '';
  const citation = /^path\s*:\s*(ruflo\/[^\r\n]+)$/m.exec(text)?.[1];
  if (search?.isError !== false || !citation || !/#1\s+repo=ruflo\b/.test(text) || !text.includes('full document')) throw new Error('Same-thread Brain search lacks the expected non-error cited result');
  if (!mcp?.owned || mcp.server !== 'ruvnet-brain' || mcp.readiness?.state !== 'ready' || mcp.readiness.workerPid !== mcp.workerPid
    || mcp.readiness.pid !== mcp.pid || !String(mcp.readiness.generation).startsWith(`${runtime.generation}:`)
    || mcp.shellSha256 !== runtime.bindings.find((row) => row.path === runtime.mcpShell)?.sha256
    || mcp.workerSha256 !== runtime.bindings.find((row) => row.path === runtime.worker)?.sha256) throw new Error('Owned same-thread loaded MCP source and generation are unproven');
  return { ok: true, state: 'fresh-execution-proven', scope: 'one-owned-codex-session-start-and-brain-search',
    threadId, startupStages: body.stages, restore: body.restore, startupHealth: 'unknown', mcpReadiness: 'same-thread-cited-search-proven',
    model: ordinaryRoute.model, effort: ordinaryRoute.effort, serviceTier: 'default', citation, searchSha256: proofDigest(JSON.stringify(search)),
    existingWindows: 'unproven', otherHooks: 'unknown', ongoingLiveness: 'unknown' };
}

function processes(deadline) {
  if (Date.now() >= deadline) throw new Error('Owned process inventory deadline exceeded');
  const output = execFileSync('/bin/ps', ['-axo', 'uid=,pid=,ppid=,lstart=,command='], { encoding: 'utf8', timeout: Math.min(500, deadline - Date.now()), maxBuffer: 2 * 1024 * 1024 });
  return output.split('\n').filter(Boolean).map((line) => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9 || !parts.slice(0, 3).every((part) => /^\d+$/.test(part))) throw new Error('Owned process inventory is malformed');
    return { uid: Number(parts[0]), pid: Number(parts[1]), ppid: Number(parts[2]), birth: parts.slice(3, 8).join(' '), command: parts.slice(8).join(' ') };
  });
}

/** Explicit caller authorization permits ordinary production startup maintenance. No shared daemon. */
export async function produceOwnedCodexExecutionProof({ authorizeOwnedStartup = false, binary, codexHome, cwd, brainHome,
  releasedPluginRoot, version, packageArchive, packageSha256, workerSha256, mcpShell, terminalConfig, expectedRoutingDigest,
  timeoutMs = 90_000, env = process.env, dependencies = {} } = {}) {
  const deadline = Date.now() + timeoutMs; const owned = new Map(); const children = []; let watcher; let child; let directory;
  let trackingFailure; let outputBytes = 0; let inferenceRequests = 0; let closeWire = () => {}; let result = failure('Execution was not attempted');
  const scan = dependencies.processes || processes;
  const spawnHost = dependencies.spawn || spawn;
  const proofEnv = { ...env };
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV', 'ENV']) delete proofEnv[key];
  // Reserve retirement time within the same absolute deadline, rather than adding another timeout.
  const remaining = () => { const ms = deadline - 2000 - Date.now(); if (ms <= 0) throw new Error('Owned execution absolute deadline exceeded'); return ms; };
  const observe = () => {
    const rows = scan(deadline); let changed = true;
    for (const process of children) {
      const row = rows.find((item) => item.pid === process.pid);
      if (row && process.exitCode === null && process.signalCode === null && !owned.has(row.pid) && row.uid === globalThis.process.getuid()) owned.set(row.pid, row);
      if (process.pid && process.exitCode === null && process.signalCode === null && (!row || owned.get(row.pid)?.birth !== row.birth)) trackingFailure = true;
    }
    while (changed) { changed = false; for (const row of rows) {
      const parent = owned.get(row.ppid); const liveParent = rows.find((item) => item.pid === row.ppid);
      if (!owned.has(row.pid) && row.uid === globalThis.process.getuid() && parent && liveParent?.birth === parent.birth) { owned.set(row.pid, row); changed = true; }
    } }
    return rows;
  };
  const launch = (...args) => { const process = spawnHost(...args); children.push(process); observe(); return process; };
  try {
    if (!authorizeOwnedStartup || process.platform === 'win32' || !Number.isFinite(timeoutMs) || timeoutMs < 3000 || timeoutMs > 120_000
      || !/^[a-f0-9]{64}$/.test(expectedRoutingDigest || '')
      || ![binary, codexHome, cwd, brainHome, releasedPluginRoot, mcpShell, terminalConfig].every((file) => path.isAbsolute(file || ''))) throw new Error('Explicit owned Unix startup authorization, authenticated routing identity, and bounded absolute paths required');
    cwd = fs.realpathSync(cwd); codexHome = fs.realpathSync(codexHome); brainHome = fs.realpathSync(brainHome);
    if (maintenanceStatus(cwd).suspended) throw new Error('Development hooks are suspended; startup execution is unproven');
    watcher = setInterval(() => { try { observe(); } catch { trackingFailure = true; } }, 100);
    const declarations = await (dependencies.declarations || probeFreshCodexDeclarations)({ binary, codexHome, cwd, releasedPluginRoot,
      expectedVersion: version, timeoutMs: Math.min(12_000, remaining()), env: proofEnv, spawnChild: launch });
    if (!declarations.ok) throw new Error(declarations.reason);
    if (declarations.nativeVersion !== 'codex-cli 0.160.0') throw new Error('Owned execution schema is verified only for native Codex 0.160.0');
    const pluginRoot = declarations.pluginRoot;
    const runtime = await (dependencies.verifyRuntime || verifyReleasedHostRuntime)({ version, packageArchive, packageSha256, workerSha256,
      brainHome, pluginRoot, mcpShell, timeoutMs: remaining() });
    const configBytes = proofFile(terminalConfig); const config = JSON.parse(configBytes);
    const nodeBinary = fs.realpathSync(process.execPath); const nodeBytes = proofFile(nodeBinary, 256 * 1024 * 1024);
    const magic = nodeBytes.subarray(0, 4).toString('hex');
    if (!['cffaedfe', 'feedfacf', 'cefaedfe', 'feedface', 'cafebabe', 'bebafeca', '7f454c46'].includes(magic)) throw new Error('Actual native Node interpreter required');
    const nodeSha256 = proofDigest(nodeBytes);
    if (config.managedBy !== 'ruvnet-brain-terminal-launchers' || fs.realpathSync(config.realCodex) !== fs.realpathSync(binary)
      || fs.realpathSync(config.nodeBinary) !== nodeBinary
      || config.runtimeDigest !== expectedRoutingDigest || runtimeSnapshot(config.runtimeRoot).digest !== expectedRoutingDigest) throw new Error('Installed immutable Standard gateway closure is unproven');
    const gateway = path.join(config.runtimeRoot, 'scripts/model-routing-gateway.mjs');
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-owned-host-'))); fs.chmodSync(directory, 0o700);
    const nonce = crypto.randomBytes(32).toString('hex'); const proofPath = path.join(directory, 'startup.json');
    fs.writeFileSync(proofPath, JSON.stringify({ schema: 1, state: 'pending', nonce }), { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(path.join(directory, 'routing.jsonl'), '', { mode: 0o600, flag: 'wx' });
    const clean = { ...proofEnv, CODEX_HOME: codexHome, RUVNET_BRAIN_HOME: brainHome, RUVNET_BRAIN_HOST_PROOF_PATH: proofPath,
      RUVNET_BRAIN_HOST_PROOF_NONCE: nonce, MODEL_ROUTER_DECISIONS: path.join(directory, 'routing.jsonl') };
    clean.PATH = `${path.dirname(nodeBinary)}${path.delimiter}${proofEnv.PATH || ''}`;
    for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'CODEX_API_KEY', 'RUVNET_BRAIN_TEST', 'RUVNET_BRAIN_CHILD_MCP']) delete clean[key];
    child = launch(nodeBinary, [gateway, '--harness', 'codex', '--real-binary', binary, 'app-server', '--listen', 'stdio://',
      '-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false', '-c', 'features.code_mode=false',
      '-c', 'features.code_mode_host=false', '-c', 'features.multi_agent=false', '-c', 'web_search="disabled"'],
    { cwd, env: clean, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const pending = new Map(); const notices = []; let nextId = 1; let buffer = ''; let wireFailure;
    const consume = (chunk) => { outputBytes += chunk.length; if (outputBytes > 8 * 1024 * 1024) throw new Error('Cumulative owned execution output exceeded bound'); };
    const reject = (error) => { wireFailure = error; for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
    closeWire = () => reject(new Error('Owned proof client closed'));
    child.stdin.on('error', () => reject(new Error('Owned native input failed')));
    child.on('error', () => reject(new Error('Owned native launch failed')));
    child.on('exit', () => reject(new Error('Owned native process exited before proof')));
    child.stderr.on('data', (chunk) => { try { consume(chunk); } catch (error) { reject(error); } });
    child.stdout.on('data', (chunk) => { try {
      consume(chunk); buffer += chunk;
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'); const row = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (row.method) {
          if (row.id !== undefined) throw new Error('Native tool or approval request refused by proof client');
          notices.push(row); if (notices.length > 20_000) throw new Error('Native notification count exceeds bound');
        } else { const item = pending.get(row.id); if (item) { pending.delete(row.id); clearTimeout(item.timer);
          row.error ? item.reject(new Error(`Native ${item.method} refused`)) : item.resolve(row.result); } }
      }
    } catch (error) { reject(error); } });
    const rpc = (method, params) => new Promise((resolve, rejectRequest) => {
      if (wireFailure) { rejectRequest(wireFailure); return; }
      const id = nextId++; const timer = setTimeout(() => { pending.delete(id); rejectRequest(new Error(`Native ${method} deadline exceeded`)); }, remaining());
      pending.set(id, { resolve, reject: rejectRequest, timer, method });
      if (method === 'turn/start') inferenceRequests++;
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    await rpc('initialize', { clientInfo: { name: 'rnb_owned_startup_proof', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write('{"method":"initialized"}\n');
    const before = await rpc('hooks/list', { cwds: [cwd] }); const declaration = startupDeclaration(before, cwd);
    const target = { manifest: JSON.parse(proofFile(path.join(releasedPluginRoot, '.codex-plugin/plugin.json'))),
      hooks: JSON.parse(proofFile(path.join(releasedPluginRoot, 'hooks/codex-hooks.json'))), hashes: declarations.sourceHashes };
    const bound = classifyFreshCodexDeclarations({ plugin: { installed: true, enabled: true, version }, listed: before, target, expectedVersion: version, codexHome, cwd });
    if (!bound.ok || trackingFailure) throw new Error(bound.reason || 'Owned descendant tracking is unproven');
    const thread = (await rpc('thread/start', { cwd, ephemeral: false, serviceTier: 'default', sandbox: 'read-only', approvalPolicy: 'untrusted' })).thread;
    if (!thread?.id || !path.isAbsolute(thread.path || '')) throw new Error('Owned persistent thread identity is unavailable');
    await rpc('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Without tools or file changes, explain 2 + 2 in one sentence.' }] });
    while (!notices.some((row) => row.method === 'turn/completed' && row.params?.threadId === thread.id)) {
      if (wireFailure) throw wireFailure; remaining(); await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining())));
    }
    const completed = notices.find((row) => row.method === 'turn/completed' && row.params?.threadId === thread.id);
    if (completed.params.turn.status !== 'completed') throw new Error('Owned native turn did not complete');
    if (notices.some((row) => ['item/started', 'item/completed'].includes(row.method) && row.params?.threadId === thread.id
      && !['userMessage', 'agentMessage', 'reasoning', 'plan'].includes(row.params?.item?.type))) throw new Error('Unexpected model tool action invalidates the one-plaintext-turn proof');
    const inventory = await rpc('mcpServerStatus/list', { threadId: thread.id, limit: 100, detail: 'toolsAndAuthOnly' });
    const servers = inventory.data?.filter((row) => row.name === 'ruvnet-brain');
    if (servers?.length !== 1 || servers[0].runtimeStatus !== 'connected') throw new Error('Same-thread Brain MCP is not connected');
    const search = await rpc('mcpServer/tool/call', { threadId: thread.id, server: 'ruvnet-brain', tool: 'search_ruvnet', arguments: { query: 'Ruflo architecture', k: 1 } });
    const after = await rpc('hooks/list', { cwds: [cwd] });
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Native registry changed during execution');
    const live = observe(); const shells = live.filter((row) => owned.get(row.pid)?.birth === row.birth && row.command.endsWith(` ${mcpShell}`));
    if (shells.length !== 1) throw new Error('Owned Brain MCP shell identity is ambiguous');
    const shell = shells[0]; const readiness = JSON.parse(proofFile(path.join(brainHome, 'mcp-readiness.d', `${shell.pid}.json`)));
    const worker = live.find((row) => row.pid === readiness.workerPid && row.ppid === shell.pid && row.command.endsWith(` ${runtime.worker}`));
    if (!worker || owned.get(worker.pid)?.birth !== worker.birth) throw new Error('Loaded Brain worker ancestry is unproven');
    const transcript = fs.realpathSync(thread.path);
    if (!transcript.startsWith(`${fs.realpathSync(path.join(codexHome, 'sessions'))}${path.sep}`)) throw new Error('Native turn transcript escaped owned sessions');
    const rows = proofFile(transcript, 8 * 1024 * 1024).toString().trim().split('\n').map((line) => JSON.parse(line));
    if (rows.find((row) => row.type === 'session_meta')?.payload?.id !== thread.id) throw new Error('Native durable telemetry differs from owned thread');
    const contexts = rows.filter((row) => row.type === 'turn_context'); if (contexts.length !== 1) throw new Error('Exact one-turn native telemetry is unproven');
    const body = JSON.parse(proofFile(proofPath));
    if (!owned.has(body.pid) || body.startedAt < deadline - timeoutMs || body.finishedAt > Date.now()) throw new Error('Startup body is not tied to owned process lifetime');
    assertHostRuntimeUnchanged(runtime, brainHome);
    if (trackingFailure || !proofFile(terminalConfig).equals(configBytes) || runtimeSnapshot(config.runtimeRoot).digest !== config.runtimeDigest
      || proofDigest(proofFile(nodeBinary, 256 * 1024 * 1024)) !== nodeSha256
      || proofDigest(proofFile(binary, 256 * 1024 * 1024)) !== declarations.nativeBinarySha256) throw new Error('Owned tracking, interpreter, native binary, or routing runtime changed during proof');
    result = { ...classifyOwnedExecution({ body, nonce, runtime, cwd, threadId: thread.id, hookRuns: notices.filter((row) => row.method === 'hook/completed').map((row) => row.params),
      declaration, turnContext: contexts[0], search, mcp: { owned: true, server: 'ruvnet-brain', pid: shell.pid, workerPid: worker.pid, readiness,
        shellSha256: proofDigest(proofFile(mcpShell)), workerSha256: proofDigest(proofFile(runtime.worker, 32 * 1024 * 1024)) } }),
      runtime, nativeBinary: declarations.nativeBinary, nativeBinarySha256: declarations.nativeBinarySha256, nativeVersion: declarations.nativeVersion,
      nodeBinary, nodeSha256, codexHome, cwd, routingRuntimeDigest: config.runtimeDigest, transcriptSha256: proofDigest(proofFile(transcript, 8 * 1024 * 1024)),
      optOuts: ['shell_tool', 'unified_exec', 'code_mode', 'code_mode_host', 'multi_agent', 'web_search'], ordinaryStartupMaintenance: 'permitted', nativeCacheRefresh: 'possible' };
    await rpc('thread/unsubscribe', { threadId: thread.id });
    // A ~40ms detach launcher can fork/reparent between ps samples. Retain the positively bound
    // execution component, but never turn sampled ancestry into a full convergence/cleanup claim.
    result = { ...result, ...failure('Exhaustive detached startup descendant retirement is unproven'), executionEvidence: result };
  } catch (error) { result = failure(error.message); }
  finally {
    clearInterval(watcher); closeWire(); let unverified = false;
    try { if (children.length) {
      observe(); for (const signal of ['SIGTERM', 'SIGKILL']) {
        const live = scan(deadline); const matches = live.filter((row) => owned.get(row.pid)?.birth === row.birth && row.uid === process.getuid());
        for (const row of matches) { try { (dependencies.kill || process.kill)(row.pid, signal); } catch { /* verify actual disappearance below */ } }
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(250, deadline - Date.now()))));
      }
      unverified = scan(deadline).some((row) => owned.get(row.pid)?.birth === row.birth);
    } } catch { unverified = true; }
    for (const process of children) { process.stdin?.destroy(); process.stdout?.destroy(); process.stderr?.destroy(); process.unref?.(); }
    if (unverified || trackingFailure) result = failure('Owned descendant retirement or tracking is unverified');
    result = { ...result, inferenceRequests, outputBytes, retirement: unverified || trackingFailure ? 'unverified' : 'discovered-owned-processes-retired',
      cleanupScope: 'observed-owned-processes-only', exhaustiveDescendants: 'unproven', directory };
    if (directory) fs.writeFileSync(path.join(directory, 'receipt.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  }
  return result;
}

const CLI_FIELDS = new Set(['binary', 'codexHome', 'cwd', 'brainHome', 'releasedPluginRoot', 'version',
  'packageArchive', 'packageSha256', 'workerSha256', 'mcpShell', 'terminalConfig', 'expectedRoutingDigest', 'timeoutMs']);
export async function executionProofMain(args, { run = produceOwnedCodexExecutionProof, output = (text) => process.stdout.write(text), platform = process.platform } = {}) {
  const usage = 'Usage: npm run host:codex:execution-proof -- --authorize-owned-startup --options /absolute/proof-inputs.json\n'
    + 'Explicit opt-in: one native subscription turn, production startup maintenance, and one Brain search.\n'
    + 'Requires independently authenticated release/routing inputs. Overall convergence remains UNPROVEN.\n';
  if (args.length === 1 && args[0] === '--help') { output(usage); return 0; }
  try {
    if (args.length !== 3 || args[0] !== '--authorize-owned-startup' || args[1] !== '--options'
      || !path.isAbsolute(args[2]) || platform === 'win32') throw new Error('Explicit Unix startup authorization and absolute options file required');
    const options = JSON.parse(proofFile(args[2], 64 * 1024));
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some((key) => !CLI_FIELDS.has(key))
      || Object.entries(options).some(([key, value]) => key === 'timeoutMs' ? typeof value !== 'number' : typeof value !== 'string')) throw new Error('Invalid proof options; environment, dependencies, and embedded authorization are forbidden');
    const result = await run({ ...options, authorizeOwnedStartup: true });
    output(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  } catch (error) { output(`${JSON.stringify(failure(error.message))}\n${usage}`); return 2; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await executionProofMain(process.argv.slice(2));
}
