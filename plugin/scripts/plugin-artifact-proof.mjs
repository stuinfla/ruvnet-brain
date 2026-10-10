// Immutable Git blobs prove the active Claude surface, independently of stale provider metadata.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export const gitBlobHash = bytes => crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const safePath = name => typeof name === 'string' && name && !name.includes('\\') && !path.posix.isAbsolute(name)
  && !name.split('/').some(part => part === '..' || part === '' || part === '.') && !name.includes('\0');
const within = (root, file) => file === root || file.startsWith(root + path.sep);
export function pinnedGithubRepo(source) {
  if (source?.source === 'github' && /^[A-Za-z0-9][A-Za-z0-9_-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(source.repo || '')) return source.repo;
  if (source?.source === 'url') return /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9_-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*?)(?:\.git)?$/.exec(source.url || '')?.[1] || null;
  return null;
}
export async function pinnedClaudeTarget(source, commit, { request = fetch, cache = new Map() } = {}) {
  const repo = pinnedGithubRepo(source);
  if (!repo || !/^[a-f0-9]{40}$/i.test(commit || '')) throw Error('pinned artifact owner is not a known GitHub repository');
  const subdir = source.path ? String(source.path).replace(/^\.\//, '').replace(/\/$/, '') : '';
  if (subdir && !safePath(subdir)) throw Error('pinned plugin path escapes repository');
  const key = `${repo}:${commit}:${subdir}`;
  if (cache.has(key)) return cache.get(key);
  const get = async url => {
    const response = await request(url, { signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'ruvnet-brain/claude-artifact-proof' } });
    if (!response.ok) throw Error(`immutable GitHub artifact HTTP ${response.status}`);
    return response;
  };
  const tree = await (await get(`https://api.github.com/repos/${repo}/git/trees/${commit}?recursive=1`)).json();
  if (!Array.isArray(tree.tree) || tree.truncated !== false || !tree.tree.length || tree.tree.length > 5000) throw Error('immutable repository tree is incomplete or unbounded');
  const prefix = subdir ? subdir + '/' : '';
  const entries = tree.tree.filter(entry => entry.path?.startsWith(prefix)).map(entry => ({ ...entry, path: entry.path.slice(prefix.length) })).filter(entry => entry.path);
  if (entries.some(entry => !safePath(entry.path) || !/^[a-f0-9]{40}$/i.test(entry.sha || ''))) throw Error('immutable repository path or hash malformed');
  const manifestPath = '.claude-plugin/plugin.json', manifestEntry = entries.find(entry => entry.path === manifestPath && entry.type === 'blob');
  if (!manifestEntry) throw Error('immutable Claude manifest absent');
  const resource = prefix + manifestPath;
  const response = await get(`https://raw.githubusercontent.com/${repo}/${commit}/${resource.split('/').map(encodeURIComponent).join('/')}`);
  const manifestBytes = Buffer.from(await response.arrayBuffer());
  if (gitBlobHash(manifestBytes) !== manifestEntry.sha) throw Error('immutable Claude manifest does not match pinned Git blob');
  const result = { repo, commit, manifest: JSON.parse(manifestBytes.toString('utf8')), entries, manifestBlob: manifestEntry.sha };
  cache.set(key, result);
  return result;
}

export function verifyClaudeArtifact(target, installPath) {
  const proof = { ok: false, scope: 'active-claude-artifact', repo: target.repo, pinnedCommit: target.commit,
    immutableManifestBlob: target.manifestBlob, declaredVersion: target.manifest.version || null,
    compared: [], outsideClaudeProof: [], mismatches: [], actualClaudeSourceMatched: false, entireRepositoryMatched: false,
    limits: ['Active resource directories and default Claude files reject extras; other cached files and dynamically computed runtime references are unverified.'] };
  try {
    const root = fs.realpathSync(installPath);
    const actualManifest = path.join(root, '.claude-plugin/plugin.json');
    if (!within(root, fs.realpathSync(actualManifest)) || fs.lstatSync(actualManifest).isSymbolicLink()) throw Error('unsafe cached Claude manifest');
    proof.actualVersion = JSON.parse(fs.readFileSync(actualManifest, 'utf8')).version || null;
    const entries = new Map(target.entries.map(entry => [entry.path, entry]));
    const selected = new Set(), activeDirectories = new Set(['.claude-plugin', 'commands', 'agents', 'skills', 'hooks']);
    const add = (name, required = true) => {
      name = name.replace(/^\.\//, '').replace(/\/$/, '');
      if (!safePath(name)) throw Error('declared Claude resource path is unsafe');
      const found = target.entries.filter(entry => entry.path === name || entry.path.startsWith(name + '/'));
      if (required && !found.length) throw Error(`declared Claude resource absent from pinned tree: ${name}`);
      if (found.some(entry => entry.type === 'tree' && entry.path === name || entry.path.startsWith(name + '/'))) activeDirectories.add(name);
      for (const entry of found) if (entry.type !== 'tree') selected.add(entry.path);
    };
    add('.claude-plugin');
    for (const directory of ['commands', 'agents', 'skills', 'hooks']) add(directory, false);
    // Root instructions/configuration can affect Claude even without a resource-directory entry.
    for (const entry of target.entries) if (!entry.path.includes('/') && entry.type === 'blob') selected.add(entry.path);
    for (const key of ['commands', 'agents', 'skills', 'hooks', 'mcpServers', 'lspServers', 'settings']) {
      const value = target.manifest[key];
      if (value !== undefined && !['hooks', 'mcpServers', 'lspServers', 'settings'].includes(key) && !(typeof value === 'string' || Array.isArray(value) && value.every(item => typeof item === 'string'))) throw Error('unsupported Claude resource declaration');
      for (const name of (Array.isArray(value) ? value : [value])) if (typeof name === 'string') add(name);
      if (value && typeof value === 'object') {
        const refs = JSON.stringify(value).matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9_./-]+)/g);
        for (const ref of refs) add(ref[1]);
      }
    }
    const pending = [...selected], seen = new Set();
    for (let index = 0; index < pending.length; index++) {
      const name = pending[index]; if (seen.has(name)) continue; seen.add(name);
      const entry = entries.get(name);
      if (!entry || entry.type !== 'blob' || !['100644', '100755', '120000'].includes(entry.mode)) throw Error(`unverifiable active Claude entry: ${name}`);
      const file = path.join(root, ...name.split('/'));
      const stat = fs.lstatSync(file); let bytes;
      if (entry.mode === '120000') {
        if (!stat.isSymbolicLink()) throw Error(`declared symlink changed: ${name}`);
        const link = fs.readlinkSync(file), resolved = path.resolve(path.dirname(file), link);
        if (!within(root, resolved) || !within(root, fs.realpathSync(file))) throw Error(`Claude symlink escapes artifact: ${name}`);
        bytes = Buffer.from(link); const dependency = path.relative(root, resolved).split(path.sep).join('/'); add(dependency);
      } else {
        if (!stat.isFile() || stat.isSymbolicLink() || !within(root, fs.realpathSync(file)) || stat.size > 8 * 1024 * 1024) throw Error(`unsafe Claude artifact file: ${name}`);
        bytes = fs.readFileSync(file);
      }
      const actual = gitBlobHash(bytes), matched = actual === entry.sha;
      proof.compared.push({ path: name, expectedBlob: entry.sha, actualBlob: actual, matched });
      if (!matched) proof.mismatches.push(name);
      // Expand only references from bytes already independently matched to their immutable Git blob.
      if (matched && bytes.length < 1024 * 1024 && !bytes.includes(0)) {
        const refs = bytes.toString('utf8').matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9_./-]+)/g);
        for (const ref of refs) add(ref[1]);
        // Literal local imports/config arguments form a bounded, file-relative runtime closure.
        if (/\.(?:[cm]?js|py|sh|json)$/.test(name)) {
          const localRefs = bytes.toString('utf8').matchAll(/["'](\.{1,2}\/[^"'\s]+\.(?:[cm]?js|py|sh|json))["']/g);
          for (const ref of localRefs) {
            const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(name), ref[1]));
            if (!safePath(dependency)) throw Error('local Claude runtime reference escapes artifact');
            // Claude manifest resources resolve from plugin root, already validated above.
            if (name !== '.claude-plugin/plugin.json') add(dependency);
          }
        }
      }
      for (const next of selected) if (!seen.has(next) && !pending.includes(next)) pending.push(next);
    }
    // Cached default/declared resource directories must not contain undeclared active additions.
    let inventoried = 0;
    const reverse = (file, relative) => {
      if (++inventoried > 5000) throw Error('cached Claude resource inventory is unbounded');
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) {
        if (!within(root, fs.realpathSync(file))) throw Error('cached Claude resource directory escapes artifact');
        for (const child of fs.readdirSync(file)) reverse(path.join(file,child), `${relative}/${child}`);
      } else if (!selected.has(relative)) throw Error(`extra cached active Claude resource: ${relative}`);
    };
    for (const directory of activeDirectories) {
      const file=path.join(root,...directory.split('/'));
      if (fs.existsSync(file)) reverse(file,directory);
    }
    const defaultFiles = ['.mcp.json', '.lsp.json', 'CLAUDE.md', 'settings.json'];
    for (const name of defaultFiles) if (fs.existsSync(path.join(root,name))) reverse(path.join(root,name),name);
    proof.reverseInventory = { ok: true, inventoried, directories: [...activeDirectories].sort(), defaultFiles };
    proof.outsideClaudeProof = target.entries.filter(entry => entry.type !== 'tree' && !seen.has(entry.path)).map(entry => entry.path);
    proof.ok = proof.compared.length > 0 && proof.mismatches.length === 0;
    proof.actualClaudeSourceMatched = proof.ok;
    // Cache contents outside this bounded Claude inventory were not reverse-enumerated.
    proof.entireRepositoryMatched = false;
  } catch (error) { proof.error = error.message; }
  return proof;
}
