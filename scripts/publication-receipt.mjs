#!/usr/bin/env node
// Post-publication evidence producer. It only observes public bytes and isolated installs, then
// writes one append-only receipt. It has no publish, tag, release, push, or deployment capability.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
// ONE doctor rule and ONE mode vocabulary, shared with the staged-side check in
// scripts/staged-host-verifier.mjs. This file kept its own copies, spelled claudeOnly/
// codexOnly/dual against the other's claude/codex/dual, so `hosts.claudeOnly` and
// `fixtures.claude` described the same fixture and nothing could tell. The richer
// post-publication proofs below (payload assertions, MCP wiring, SOURCE.json, rpcSearch)
// stay here — they are this side's job, not duplication.
import { HOST_MODES, RECEIPT_MODE_NAMES, MODE_FROM_RECEIPT_NAME, classifyDoctor, VARIANTS } from './host-install-matrix.mjs';
import { pathToFileURL } from 'node:url';
import { evaluateCandidateReceipt, evaluatePublicationReceipt } from './release-proof.mjs';
import { verifyPayload } from './release-payload.mjs';
import { digest, sha256File } from './coverage-integrity.mjs';
import { parseCitations } from '../kb/verify-citation.mjs';

const REPO = 'stuinfla/ruvnet-brain';
const PACKAGE = 'ruvnet-brain';
const DEADLINE_MS = 30_000;

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const receiptDigest = (candidate) => String(candidate?.artifact?.sha256 || '').replace(/^sha256:/, '');
export function commandInvocation(name, args, { platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32' && /^(?:npm|npx)$/i.test(name)) return {
    executable: env.ComSpec || 'cmd.exe', args: ['/d', '/c', `${name}.cmd`, ...args],
  };
  return { executable: name, args };
}
function command(name, args, options = {}) {
  const { platform = process.platform, ...spawnOptions } = options;
  const invocation = commandInvocation(name, args, { platform, env: spawnOptions.env || process.env });
  const result = spawnSync(invocation.executable, invocation.args, { encoding: 'utf8', ...spawnOptions });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || '').trim();
    throw new Error(`${name} ${args.join(' ')} failed: ${detail || `exit ${result.status}`}`);
  }
  return String(result.stdout || '').trim();
}
function locate(name, { platform = process.platform } = {}) {
  const query = platform === 'win32' ? (name === 'node' ? 'node.exe' : `${name}.cmd`) : name;
  try {
    return command(platform === 'win32' ? 'where.exe' : 'which', [query], { platform })
      .split(/\r?\n/).find(Boolean) || null;
  } catch { return null; }
}
export function createIsolatedPath(mode, temp, { platform = process.platform, env = process.env,
  resolve = (name) => locate(name, { platform }) } = {}) {
  const bin = path.join(temp, `bin-${mode}`);
  fs.mkdirSync(bin);
  const hosts = mode === 'claudeOnly' ? ['claude'] : mode === 'codexOnly' ? ['codex'] : ['claude', 'codex'];
  const names = platform === 'win32' ? ['npm', ...hosts] : ['node', 'npm', ...hosts];
  for (const name of names) {
    const target = resolve(name);
    if (!target) throw new Error(`${name} CLI unavailable for ${mode} public host fixture`);
    if (platform === 'win32') {
      fs.writeFileSync(path.join(bin, `${name}.cmd`), `@call "${target}" %*\r\n`, { flag: 'wx' });
    } else {
      fs.symlinkSync(target, path.join(bin, name));
    }
  }
  if (platform !== 'win32') return `${bin}:/usr/bin:/bin`;
  const node = resolve('node');
  if (!node) throw new Error(`node CLI unavailable for ${mode} public host fixture`);
  return [bin, path.dirname(node), path.join(env.SystemRoot || 'C:\\Windows', 'System32'),
    path.join(env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin')].join(path.win32.delimiter);
}
export function stageVerifiedBundle({ bundlePath, bundleSha256, packageRoot }) {
  const source = path.resolve(bundlePath || '');
  let stat;
  try { stat = fs.lstatSync(source); } catch { throw new Error('verified public bundle is missing'); }
  if (!stat.isFile() || stat.isSymbolicLink() || sha256(source) !== bundleSha256) {
    throw new Error('verified bundle digest mismatch before installation');
  }
  const destination = path.join(packageRoot, 'dist', 'ruvnet-brain.zip');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  if (sha256(destination) !== bundleSha256) throw new Error('staged verified bundle digest mismatch');
  return destination;
}

async function download(url, destination, headers = {}) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'ruvnet-brain-publication-receipt', ...headers },
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok || !response.body) throw new Error(`download failed: ${url} -> HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  return destination;
}

function tagCommit(root, tag) {
  const rows = command('git', ['ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { cwd: root })
    .split('\n').filter(Boolean).map((line) => line.trim().split(/\s+/));
  const sha = rows.find(([, ref]) => ref?.endsWith('^{}'))?.[0] || rows[0]?.[0] || '';
  if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error(`GitHub tag ${tag} has no full commit SHA`);
  return sha;
}

function findManifest(root, relative, version) {
  const found = [];
  const visit = (directory, depth = 0) => {
    if (depth > 9 || !fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(child, depth + 1);
      else if (entry.isFile() && child.endsWith(relative)) found.push(child);
    }
  };
  visit(root);
  const match = found.find((file) => {
    try { return readJson(file).version === version; } catch { return false; }
  });
  if (!match) throw new Error(`installed ${relative} at version ${version} not found in virgin home`);
  return match;
}

function findMcpServer(home) {
  const matches = [];
  const visit = (directory, depth = 0) => {
    if (depth > 12 || !fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(child, depth + 1);
      else if (entry.isFile() && entry.name === 'server.mjs' && child.includes(`${path.sep}mcp${path.sep}`)) matches.push(child);
    }
  };
  visit(home);
  const server = matches.find((file) => file.includes('ruvnet-brain'));
  if (!server) throw new Error('installed host registration has no ruvnet-brain MCP server');
  return server;
}

export function assertInstalledPayload(sourceRoot, installedRoot) {
  let checked = 0;
  const visit = (source, relative = '') => {
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) throw new Error(`sealed plugin payload contains symlink: ${relative || '.'}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(source)) visit(path.join(source, name), path.join(relative, name));
      return;
    }
    if (!stat.isFile()) throw new Error(`sealed plugin payload contains unsupported entry: ${relative}`);
    const installed = path.join(installedRoot, relative);
    let installedStat;
    try { installedStat = fs.lstatSync(installed); } catch { throw new Error(`installed plugin payload is missing ${relative}`); }
    if (!installedStat.isFile() || installedStat.isSymbolicLink()) {
      throw new Error(`installed plugin payload is not a regular file: ${relative}`);
    }
    if (sha256(source) !== sha256(installed)) throw new Error(`installed plugin payload byte mismatch: ${relative}`);
    checked += 1;
  };
  visit(sourceRoot);
  if (checked === 0) throw new Error('sealed plugin payload is empty');
  return checked;
}

export function rpcSearch(server, env, query, k = 5, timeoutMs = DEADLINE_MS) {
  if (!Number.isSafeInteger(k) || k < 1 || k > 50) throw new Error(`invalid search result count: ${k}`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [server], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timer;
    const pending = new Map();
    const finish = (error, value) => {
      clearTimeout(timer);
      child.kill('SIGTERM');
      error ? reject(error) : resolve(value);
    };
    timer = setTimeout(() => finish(new Error(`installed Brain exceeded ${timeoutMs}ms deadline`)), timeoutMs);
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      let newline;
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        const handler = pending.get(message.id);
        if (handler) { pending.delete(message.id); handler(message); }
      }
    });
    child.on('error', (error) => finish(error));
    child.on('exit', (code) => {
      if (pending.size) finish(new Error(`installed Brain exited ${code}: ${stderr.slice(0, 400)}`));
    });
    const call = (id, method, params = {}) => new Promise((done) => {
      pending.set(id, done);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    (async () => {
      const initialized = await call(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'release-proof', version: '1' } });
      if (initialized.error) throw new Error(`MCP initialize failed: ${JSON.stringify(initialized.error)}`);
      const listed = await call(2, 'tools/list');
      if (!listed.result?.tools?.some((tool) => tool.name === 'search_ruvnet')) throw new Error('installed MCP does not advertise search_ruvnet');
      const started = performance.now();
      const searched = await call(3, 'tools/call', { name: 'search_ruvnet', arguments: { query, k } });
      const broadMs = Math.round(performance.now() - started);
      const text = (searched.result?.content || []).map((item) => item.text || '').join('\n');
      if (searched.error || searched.result?.isError || /search_ruvnet error:/i.test(text)) throw new Error(`installed Brain search failed: ${text.slice(0, 400)}`);
      if (!/repo=ruvnet-brain/i.test(text) || !/path\s*:/i.test(text)) throw new Error('installed Brain search returned no ruvnet-brain source citation');
      finish(null, { broadMs, text });
    })().catch((error) => finish(error));
  });
}

export function livePublicationAdapter({ root = process.cwd() } = {}) {
  const installContexts = new Map();
  const passageFileDigests = new Map();
  let installTemp = null;
  return {
    async downloadNpm({ version, destination }) {
      const metadata = JSON.parse(command('npm', ['view', `${PACKAGE}@${version}`, '--json']));
      if (metadata.version !== version || !metadata.dist?.tarball) {
        throw new Error('npm metadata is missing exact version or tarball');
      }
      await download(metadata.dist.tarball, destination);
      return { path: destination, version: metadata.version, sha: metadata.gitHead || null };
    },

    async downloadGithub({ tag, assetName, destination }) {
      const headers = process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
      const response = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`, {
        headers: { 'user-agent': 'ruvnet-brain-publication-receipt', ...headers },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`GitHub release ${tag} lookup failed: HTTP ${response.status}`);
      const release = await response.json();
      const asset = release.assets?.find((item) => item.name === assetName);
      if (!asset?.browser_download_url) throw new Error(`GitHub release ${tag} is missing sealed artifact ${assetName}`);
      await download(asset.browser_download_url, destination, headers);
      return { path: destination, tag: release.tag_name, sha: tagCommit(root, tag) };
    },

    async installHosts({ artifactPath, artifactSha256, bundlePath, bundleSha256, version }) {
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-public-install-'));
      installTemp = temp;
      const packageRoot = path.join(temp, 'package');
      command('tar', ['-xzf', artifactPath, '-C', temp]);
      stageVerifiedBundle({ bundlePath, bundleSha256, packageRoot });
      const sealedPlugin = path.join(packageRoot, 'plugin');
      const results = {};
      let bundle = null;
      const sharedModelCache = path.join(temp, 'models-cache');
      fs.mkdirSync(sharedModelCache, { recursive: true });
      // Derived from HOST_MODES, so a fourth host shape is added in ONE place and this loop
      // cannot fall behind the staged-side check the way it did.
      for (const mode of HOST_MODES.map((m) => RECEIPT_MODE_NAMES[m])) {
        const home = path.join(temp, `home-${mode}`);
        const codexHome = path.join(home, '.codex');
        const brainHome = path.join(home, '.cache', 'ruvnet-brain');
        const kb = path.join(brainHome, 'kb');
        fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
        if (mode !== 'claudeOnly') fs.mkdirSync(codexHome, { recursive: true });
        const env = {
          ...process.env,
          HOME: home,
          ...(process.platform === 'win32' ? { USERPROFILE: home } : {}),
          CODEX_HOME: codexHome,
          RUVNET_BRAIN_HOME: brainHome,
          RUVNET_BRAIN_KB: kb,
          KB_MODEL_CACHE: sharedModelCache,
          // Env comes from the ONE variant table (host-install-matrix VARIANTS.published), not a
          // second hand-written copy — this file's own header promises "ONE doctor rule and ONE mode
          // vocabulary, shared with the staged-side check", and the copy had already drifted: it
          // omitted the Codex hook-trust bypass the staged side carries, which failed the seal on
          // every release.
          ...VARIANTS.published.env({ packageRoot }),
          RUVNET_STRICT_INSTALL: '0',
          CI: 'true',
          PATH: createIsolatedPath(mode, temp),
        };
        const installer = path.join(packageRoot, 'bin', 'install.mjs');
        command(process.execPath, [
          installer, '--yes', '--force', '--version', `v${version}`,
          '--no-nightly-prompt', '--no-telemetry', '--no-stack', '--no-enhance', '--no-statusline',
          '--no-selfcheck', '--no-verify',
        ], { env, cwd: packageRoot, timeout: 1_200_000, maxBuffer: 32 * 1024 * 1024 });

        const verified = {};
        if (mode !== 'codexOnly') {
          const manifest = findManifest(path.join(home, '.claude'), path.join('.claude-plugin', 'plugin.json'), version);
          verified.claudeFiles = assertInstalledPayload(sealedPlugin, path.dirname(path.dirname(manifest)));
        }
        if (mode !== 'claudeOnly') {
          const manifest = findManifest(codexHome, path.join('.codex-plugin', 'plugin.json'), version);
          verified.codexFiles = assertInstalledPayload(sealedPlugin, path.dirname(path.dirname(manifest)));
          const config = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
          if (!/\[mcp_servers\.ruvnet-brain\]/.test(config)) throw new Error(`${mode} virgin Codex home is not wired to ruvnet-brain`);
        }
        const source = readJson(path.join(kb, 'SOURCE.json'));
        if (source.brainVersion !== version || source.releaseTag !== `v${version}`) {
          throw new Error(`${mode} installed public Brain bundle version mismatch`);
        }
        bundle ||= { brainVersion: source.brainVersion, releaseTag: source.releaseTag };
        const searched = await rpcSearch(findMcpServer(home), env,
          'How does RuvNet Brain prove a public release artifact?', 5, DEADLINE_MS);
        command(process.execPath, [installer, '--doctor', '--hooks'], {
          env, cwd: packageRoot, timeout: 300_000, maxBuffer: 32 * 1024 * 1024,
        });
        results[mode] = {
          status: 'PASS', doctorExit: 0, version, artifactSha256,
          functionalSearch: true, searchMs: searched.broadMs, hostsOnPath: mode,
          ...verified,
        };
        installContexts.set(MODE_FROM_RECEIPT_NAME[mode], { temp, home, codexHome, brainHome, kb, env, packageRoot });
      }
      return {
        ...results,
        bundle,
      };
    },

    async probeBrain({ mode = 'dual' } = {}) {
      const installContext = installContexts.get(mode);
      if (!installContext) throw new Error(`${mode} public host must be installed before Brain proof`);
      const rvfs = fs.readdirSync(installContext.kb).filter((name) => /ruvnet-brain.*\.rvf$/i.test(name));
      if (rvfs.length === 0) throw new Error('installed public Brain has no ruvnet-brain self RVF');
      const server = path.join(installContext.home, '.claude', 'ruvnet-brain', 'mcp', 'server.mjs');
      if (!fs.existsSync(server)) throw new Error('installed persistent MCP server is missing');
      const result = await rpcSearch(server, installContext.env,
        'How does RuvNet Brain prove a public release artifact?', 5, DEADLINE_MS);
      const readiness = readJson(path.join(installContext.brainHome, 'mcp-readiness.json'));
      if (readiness.state !== 'ready') throw new Error(`installed Brain readiness is ${readiness.state || 'missing'}`);
      return { status: 'PASS', selfStore: true, broadMs: result.broadMs, deadlineMs: DEADLINE_MS };
    },

    async searchInstalled({ mode, query, k }) {
      const context = installContexts.get(mode);
      if (!context) throw new Error(`${mode} public host is not installed`);
      const result = await rpcSearch(findMcpServer(context.home), context.env, query, k, DEADLINE_MS);
      return parseCitations(result.text).map((citation) => ({
        repo: citation.repo.toLowerCase(),
        path: citation.docPath,
      }));
    },

    async resolveInstalledCitation({ mode, matched, expected }) {
      const context = installContexts.get(mode);
      if (!context) throw new Error(`${mode} public host is not installed`);
      if (String(matched?.repo || '').toLowerCase() !== expected.repo || matched?.path !== expected.path) {
        return { resolved: false };
      }
      const files = [
        path.join(context.kb, `${expected.repo}.passages.jsonl`),
        path.join(context.kb, `${expected.repo}.big.passages.jsonl`),
      ].filter((file) => fs.existsSync(file));
      for (const file of files) {
        const rows = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
        try {
          for await (const line of rows) {
            let record;
            try { record = JSON.parse(line); } catch { continue; }
            if (record?.path !== expected.path) continue;
            const passageSha256 = digest(record);
            if (passageSha256 !== expected.passageSha256) return { resolved: false };
            if (!passageFileDigests.has(file)) passageFileDigests.set(file, sha256File(file));
            return { resolved: true, evidence: { passageSha256, passageFileSha256: passageFileDigests.get(file) } };
          }
        } finally { rows.close(); }
      }
      return { resolved: false };
    },

    async probePublishedSurface({ sha }) {
      const head = command('git', ['rev-parse', 'HEAD'], { cwd: root });
      if (head !== sha) throw new Error(`published-surface probe checkout ${head} does not match candidate ${sha}`);
      const result = spawnSync(process.execPath, ['scripts/published-surface-probe.mjs', '--json'], {
        cwd: root, env: process.env, encoding: 'utf8', timeout: 600_000,
      });
      let parsed;
      try { parsed = JSON.parse(String(result.stdout || '')); } catch { throw new Error(`published-surface-probe emitted invalid JSON: ${String(result.stderr || '').slice(0, 300)}`); }
      if (result.status !== 0 || parsed.verdict !== 'PASS') throw new Error(`published-surface-probe is ${parsed.verdict || `exit ${result.status}`}`);
      return { name: 'published-surface-probe', status: 'completed', conclusion: 'success', sha };
    },

    async dispose() {
      if (installTemp) fs.rmSync(installTemp, { recursive: true, force: true });
      installTemp = null;
      installContexts.clear();
      passageFileDigests.clear();
    },
  };
}

export async function generatePublicationReceipt({
  root = process.cwd(),
  candidatePath,
  outPath,
  adapter = livePublicationAdapter({ root }),
  disposeAdapter = true,
} = {}) {
  if (!candidatePath || !outPath) throw new Error('candidatePath and outPath are required');
  if (fs.existsSync(outPath)) throw new Error(`refusing to overwrite existing publication receipt: ${outPath}`);
  const candidate = readJson(candidatePath);
  const candidateResult = evaluateCandidateReceipt(candidate);
  if (candidateResult.verdict !== 'PASS') throw new Error(`candidate seal failed: ${candidateResult.failures.map(({ code }) => code).join(',')}`);
  const digest = receiptDigest(candidate);
  const evidenceRoot = path.dirname(path.resolve(candidatePath));
  const payloadManifestPath = path.join(evidenceRoot, 'payload-manifest.json');
  const payloadSignaturePath = path.join(evidenceRoot, 'payload-manifest.sig');
  const payloadManifest = readJson(payloadManifestPath);
  const payloadProof = verifyPayload({
    manifest: payloadManifest,
    signature: fs.readFileSync(payloadSignaturePath, 'utf8'),
    publicKey: crypto.createPublicKey(fs.readFileSync(path.join(root, 'keys', 'ruvnet-brain-signing.pub.pem'), 'utf8')),
    root: evidenceRoot,
  });
  if (payloadManifest.version !== candidate.version || payloadManifest.tag !== candidate.tag
    || payloadManifest.candidateSha !== candidate.sha) throw new Error('signed payload identity differs from candidate seal');
  const npmMember = payloadManifest.members.find(({ role }) => role === 'npm');
  const bundleMember = payloadManifest.members.find(({ role }) => role === 'bundle');
  if (!npmMember || !bundleMember || npmMember.sha256 !== digest) throw new Error('signed payload member set differs from candidate artifact');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ruvnet-public-evidence-'));
  try {
    const assetName = path.basename(candidate.artifact.path);
    const npm = await adapter.downloadNpm({ version: candidate.version, destination: path.join(temp, `npm-${assetName}`) });
    const github = await adapter.downloadGithub({ tag: candidate.tag, assetName, destination: path.join(temp, `github-${assetName}`) });
    const githubBundle = await adapter.downloadGithub({
      tag: candidate.tag, assetName: bundleMember.name, destination: path.join(temp, `github-${bundleMember.name}`),
    });
    const npmDigest = sha256(npm.path);
    const githubDigest = sha256(github.path);
    if (npmDigest !== digest) throw new Error(`npm public byte mismatch: ${npmDigest} != ${digest}`);
    if (githubDigest !== digest) throw new Error(`GitHub public byte mismatch: ${githubDigest} != ${digest}`);
    const githubBundleDigest = sha256(githubBundle.path);
    if (githubBundleDigest !== bundleMember.sha256) throw new Error(`GitHub public bundle byte mismatch: ${githubBundleDigest} != ${bundleMember.sha256}`);
    if (npm.version !== candidate.version || (npm.sha && npm.sha !== candidate.sha)) throw new Error('npm public identity mismatch');
    if (github.tag !== candidate.tag || github.sha !== candidate.sha) throw new Error('GitHub public identity mismatch');

    const installed = await adapter.installHosts({ artifactPath: npm.path, artifactSha256: digest,
      bundlePath: githubBundle.path, bundleSha256: githubBundleDigest, version: candidate.version });
    const brain = await adapter.probeBrain({ sha: candidate.sha, artifactSha256: digest, version: candidate.version });
    const surface = await adapter.probePublishedSurface({ sha: candidate.sha, artifactSha256: digest, version: candidate.version });
    const publication = {
      schemaVersion: 2,
      phase: 'publication',
      sha: candidate.sha,
      artifactSha256: digest,
      version: candidate.version,
      payloadId: payloadProof.payloadId,
      bundleArtifactSha256: githubBundleDigest,
      // npm does not guarantee gitHead metadata. Exact public-byte equality with the candidate's
      // SHA-bound sealed artifact is the identity proof; a present but conflicting gitHead is red.
      npm: { version: npm.version, sha: candidate.sha, artifactSha256: npmDigest },
      githubRelease: { tag: github.tag, sha: github.sha, artifactSha256: githubDigest },
      bundle: installed.bundle,
      installed: {
        claudeOnly: installed.claudeOnly,
        codexOnly: installed.codexOnly,
        dual: installed.dual,
      },
      brain,
      postPublicationChecks: [surface],
    };
    const result = evaluatePublicationReceipt(candidate, publication);
    if (result.verdict !== 'PASS') throw new Error(`publication seal failed: ${result.failures.map(({ code }) => code).join(',')}`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(publication, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return result;
  } finally {
    if (disposeAdapter) await adapter.dispose?.();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function argument(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

export async function main(args = process.argv.slice(2)) {
  try {
    const candidatePath = argument(args, '--candidate');
    const outPath = argument(args, '--out');
    const result = await generatePublicationReceipt({ candidatePath, outPath });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    console.error(`publication-receipt: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main();
