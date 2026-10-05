// DISTINCT-FROM hook-shim.mjs: managed execution fails closed; advisory hook fallback cannot
// authorize a command. The protocol shell owns declarations, each request owns one generation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LOCAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const contained = (root, file) => file.startsWith(`${root}${path.sep}`);

export function managedGenerationIdentity(root, { version, generation = 'source' } = {}) {
  root = fs.realpathSync(root);
  const manifestPath = path.join(root, '.claude-plugin', 'plugin.json');
  const handlerPath = path.join(root, 'mcp', 'managed-cli-interface.mjs');
  for (const file of [manifestPath, handlerPath]) {
    if (!fs.lstatSync(file).isFile() || !contained(root, fs.realpathSync(file))) {
      throw new Error('managed generation resource is not a contained regular file');
    }
  }
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  if (manifest.name !== 'ruvnet-brain' || typeof manifest.version !== 'string'
    || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.+-]+)?$/.test(manifest.version)
    || (version !== undefined && manifest.version !== version)) {
    throw new Error('managed generation manifest name/version mismatch');
  }
  const sourceDigest = digest(Buffer.concat([manifestBytes, fs.readFileSync(handlerPath)]));
  return Object.freeze({ root, handlerPath, version: manifest.version, generation, sourceDigest,
    binding: digest(JSON.stringify([root, manifest.version, generation, sourceDigest])) });
}

function selectGeneration(env, fallbackRoot) {
  const home = env.HOME || os.homedir();
  const brainHome = env.RUVNET_BRAIN_HOME || path.join(home, '.cache', 'ruvnet-brain');
  let activeBytes;
  try { activeBytes = fs.readFileSync(path.join(brainHome, 'active.json'), 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // A copied persistent shell must never manufacture an active generation from its resources.
    if (path.resolve(fallbackRoot) === path.join(home, '.claude', 'ruvnet-brain')) {
      throw new Error('managed active generation unavailable');
    }
    return { ...managedGenerationIdentity(fallbackRoot), brainHome, leased: false };
  }
  const active = JSON.parse(activeBytes);
  if (typeof active.codeRoot !== 'string' || typeof active.version !== 'string'
    || !Number.isSafeInteger(active.generation) || active.generation < 0) {
    throw new Error('managed active generation descriptor invalid');
  }
  const versions = fs.realpathSync(path.join(brainHome, 'versions'));
  const root = fs.realpathSync(path.resolve(brainHome, active.codeRoot));
  if (!contained(versions, root) || path.basename(root) !== active.version) {
    throw new Error('managed active generation escapes its version tree');
  }
  return { ...managedGenerationIdentity(root, active), brainHome, leased: true };
}

export function createManagedCliDispatcher({ fallbackRoot = LOCAL_ROOT,
  importModule = (url) => import(url) } = {}) {
  const pins = new Map();
  return async function dispatchManagedCli(toolName, args, env = process.env,
    fetchImpl = globalThis.fetch, lifecycle = {}) {
    let lease;
    try {
      const selected = selectGeneration(env, fallbackRoot);
      // ESM caches by URL. A changed file at the same immutable path must never be blessed as
      // new code while execution still uses the old cached module (nor can query strings fix dependencies).
      const pinned = pins.get(selected.root);
      if (pinned && pinned !== selected.sourceDigest) throw new Error('managed immutable generation changed; restart required');
      pins.set(selected.root, selected.sourceDigest);
      if (selected.leased) {
        const dir = path.join(selected.brainHome, 'leases');
        fs.mkdirSync(dir, { recursive: true });
        lease = path.join(dir, `mcp-managed-${process.pid}-${randomUUID()}.json`);
        fs.writeFileSync(lease, JSON.stringify({ pid: process.pid, version: selected.version, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
      }
      const handler = await importModule(pathToFileURL(selected.handlerPath).href);
      if (typeof handler.callManagedCli !== 'function') throw new Error('managed generation handler unavailable');
      return await handler.callManagedCli(toolName, args, env, fetchImpl,
        { ...lifecycle, generationBinding: selected.binding });
    } catch (error) {
      return { content: [{ type: 'text', text: `managed generation unavailable: ${error.message}` }], isError: true };
    } finally {
      if (lease) { try { fs.unlinkSync(lease); } catch { /* lease expiry preserves interrupted calls */ } }
    }
  };
}

export const dispatchManagedCli = createManagedCliDispatcher();
