// Install and probe (architecture 2.5 step 3): on this operating system, install the staged bytes
// with the real installer into a fresh home, start the installed shim's server over its real
// protocol, ask every probe question through search_ruvnet, and take the one health verdict from
// `doctor` while that server runs. The receipt is bound to the sha256 of the staged release.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HOME_ENV } from '../contract/constants.mjs';
import { problems } from '../contract/validate.mjs';
import { readJson } from '../contract/home.mjs';
import { trustedPublicKey } from '../contract/signature.mjs';
import { startLauncher } from '../cli/mcp-client.mjs';
import { PACKAGES, osName, verifyStaged } from './checks.mjs';

const CITE = /^\d+\. (\S+) · lines \d+-\d+ · commit /;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function installAndProbe({ packagesDir = PACKAGES, releaseDir, timeoutMs = 120_000 }) {
  const receipt = { schema: 'ruvnet-brain/probe-receipt', version: 1, os: osName(), node: process.version, release: null, releaseNumber: null, app: null, pack: null, install: null, probes: [], doctor: null, ok: false, error: null, at: new Date().toISOString() };
  // In GitHub Actions the receipt names its run and runner, which promotion requires (evidence.mjs).
  if (process.env.GITHUB_ACTIONS === 'true') receipt.ci = { runId: process.env.GITHUB_RUN_ID ?? null, runnerOs: process.env.RUNNER_OS ?? null };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rb5-rail-probe-'));
  const env = { ...process.env, NODE_NO_WARNINGS: '1', [HOME_ENV]: home };
  const cli = (args) => spawnSync(process.execPath, [path.join(packagesDir, 'cli', 'ruvnet-brain.mjs'), ...args], { env, encoding: 'utf8', timeout: timeoutMs, cwd: os.tmpdir() });
  let server = null;
  try {
    const { release, sha256 } = verifyStaged(releaseDir, trustedPublicKey());
    Object.assign(receipt, { release: sha256, releaseNumber: release.releaseNumber, app: release.app.version, pack: release.pack.generation });
    const inst = cli(['install', '--from', releaseDir]);
    receipt.install = { exit: inst.status, tail: `${inst.stdout}\n${inst.stderr}`.trim().split('\n').slice(-3).join('\n') };
    if (inst.status !== 0) throw new Error(`the installer refused the staged release: ${receipt.install.tail}`);
    // Through the registered launcher (the installed shim's rb5 / rb5.cmd), as a host starts it.
    const launcher = path.join(home, 'shim', 'plugin', 'claude', 'bin', process.platform === 'win32' ? 'rb5.cmd' : 'rb5');
    if (!fs.existsSync(launcher)) throw new Error(`the installer did not install the launcher ${launcher}`);
    receipt.launcher = path.relative(home, launcher).split(path.sep).join('/');
    server = startLauncher(launcher, env);
    await server.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'v5-release-rail', version: '1' } });
    const probesFile = path.join(home, 'packs', release.pack.generation, 'PROBES.json');
    for (const p of readJson(probesFile).probes) {
      const res = await server.call('tools/call', { name: 'search_ruvnet', arguments: { query: p.question } }, timeoutMs);
      const text = res?.content?.map((c) => c.text).join('') ?? '';
      const files = text.split('\n').map((l) => CITE.exec(l)?.[1]).filter(Boolean);
      receipt.probes.push({ question: p.question, expect: p.expect, pass: !res?.isError && files.includes(p.expect), mode: text.split('\n')[1] ?? '' });
    }
    // The server's own self-test must have finished before its verdict can be ok; doctor reads it.
    // (Through cmd.exe the server's process id is not the child's, so any status file of this home.)
    const statusDir = path.join(home, 'state', 'status');
    const probed = () => (fs.existsSync(statusDir) ? fs.readdirSync(statusDir) : []).some((f) => /^\d+\.json$/.test(f) && readJson(path.join(statusDir, f), null)?.probe);
    const end = Date.now() + timeoutMs;
    while (Date.now() < end && !probed()) await sleep(200);
    const doc = cli(['doctor']);
    receipt.doctor = { exit: doc.status, line: (doc.stdout ?? '').split('\n')[0] };
    const failed = receipt.probes.filter((p) => !p.pass);
    if (!receipt.probes.length) throw new Error('the pack ships no probes');
    if (failed.length) throw new Error(`${failed.length} of ${receipt.probes.length} probes did not find their file through search_ruvnet, first: "${failed[0].question}"`);
    if (doc.status !== 0) throw new Error(`doctor did not report ok: ${receipt.doctor.line}`);
    receipt.ok = true;
  } catch (e) {
    receipt.error = e.message;
  } finally {
    if (server) await server.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  // A receipt the promotion step could misread is never written as ok (contract 1.1 probe-receipt).
  const bad = problems('probe-receipt', receipt);
  if (bad.length) Object.assign(receipt, { ok: false, error: `the receipt is not a probe-receipt file: ${bad[0]}` });
  return receipt;
}
