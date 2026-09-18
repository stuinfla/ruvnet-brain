/** Execute the verified shipped retrieval closure in a controlled installation and worker. */
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createSearchProcess } from './search-process.mjs';
import { subscriptionOnlyEnv } from '../subscription-hosts.mjs';
import { retrievalRuntimeFiles } from '../build-bundle.mjs';
import { sha256File, digest } from '../coverage-integrity.mjs';
import { assertSupportedNode } from '../../kb/node-version.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function verifyArchiveSearch({ kbDir, root = ROOT }) {
  const checkout = path.join(root, 'kb');
  const shipped = path.resolve(kbDir);
  const { files, requiredFiles } = retrievalRuntimeFiles(checkout);
  if (!files.includes('forge-ask-all.mjs')) throw new Error('checkout search entry point is missing');
  const requiredByDestination = new Map(requiredFiles.map(row => [row.destination, row]));
  const evidence = [];
  for (const relative of files) {
    const required = requiredByDestination.get(relative);
    const source = required ? path.join(root, required.source) : path.join(checkout, relative);
    const target = path.join(shipped, relative);
    if (!fs.existsSync(target) || !fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink()) {
      throw new Error(`archive search dependency missing or unsafe: ${relative}`);
    }
    const sha256 = sha256File(source);
    if (required && sha256 !== required.sha256) throw new Error(`required runtime file differs from its reviewed identity: ${relative}`);
    if (sha256File(target) !== sha256) throw new Error(`archive search dependency differs from checkout: ${relative}`);
    evidence.push({path: relative, sha256});
  }
  // Installed dependency identity is measured only after fresh controlled npm ci.
  const lock = JSON.parse(fs.readFileSync(path.join(checkout, 'package-lock.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(checkout, 'package.json'), 'utf8'));
  for (const relative of Object.keys(lock.packages || {})) {
    if (relative && (!relative.startsWith('node_modules/') || relative.split('/').includes('..'))) throw new Error('archive dependency lock contains an unsafe package path');
  }
  const dependencies = Object.keys(pkg.dependencies || {}).sort().map(name => {
    const version = lock.packages?.[`node_modules/${name}`]?.version;
    if (!version) throw new Error(`archive lock has no direct dependency version for ${name}`);
    return { name, version };
  });
  return { files: evidence, dependencies, installedPackages: [], optionalAbsent: [], sha256: digest({ files: evidence, dependencies }) };
}

const runtimes = new Map();
const runtimeDirectories = new Set();
process.once('exit', () => { for (const dir of runtimeDirectories) fs.rmSync(dir, {recursive:true,force:true}); });

async function createArchiveRuntime(options) {
  assertSupportedNode();
  const identity = verifyArchiveSearch(options);
  const lock = JSON.parse(fs.readFileSync(path.join(options.kbDir,'package-lock.json'),'utf8'));
  for (const [relative, row] of Object.entries(lock.packages || {})) {
    if (!relative) continue;
    if (row.link || !/^https:\/\/registry\.npmjs\.org\//.test(row.resolved || '')
      || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(row.integrity || '')) throw new Error(`archive dependency lacks registry integrity: ${relative}`);
  }
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(),'ruvnet-search-runtime-'));
  let worker = null;
  try {
    for (const row of identity.files) {
      if (path.isAbsolute(row.path) || row.path.split(/[\\/]/).includes('..')) throw new Error('unsafe runtime closure path');
      const target = path.join(runtime,row.path); fs.mkdirSync(path.dirname(target),{recursive:true});
      fs.copyFileSync(path.join(options.kbDir,row.path),target);
      if (sha256File(target)!==row.sha256) throw new Error('archive changed during runtime staging');
    }
    // npm verifies tarball integrity. Start with an empty tree and disable lifecycle scripts.
    const env = subscriptionOnlyEnv(); delete env.NODE_OPTIONS; delete env.NODE_PATH;
    execFileSync('npm',['ci','--ignore-scripts','--no-audit','--no-fund'],{cwd:runtime,env,encoding:'utf8',timeout:180000,stdio:'pipe'});
    const require = createRequire(path.join(runtime,'package.json'));
    const dependencies=[];
    const installedPackages=[]; const optionalAbsent=[];
    for (const [relative, row] of Object.entries(lock.packages || {})) {
      if (!relative || !relative.startsWith('node_modules/')) continue;
      const packageJson = path.join(runtime, relative, 'package.json');
      if (!fs.existsSync(packageJson)) { if (row.optional) { optionalAbsent.push(relative); continue; } throw new Error(`required installed search dependency is missing: ${relative}`); }
      const manifest = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
      if (manifest.version !== row.version) throw new Error(`installed search dependency ${relative} differs from lock`);
      installedPackages.push({ path: relative, version: manifest.version, manifestSha256: sha256File(packageJson) });
    }
    for (const row of identity.dependencies) {
      const entry = require.resolve(row.name);
      if (!fs.realpathSync(entry).startsWith(fs.realpathSync(path.join(runtime,'node_modules'))+path.sep)) throw new Error('search dependency resolved outside controlled installation');
      dependencies.push({name:row.name,version:row.version,entry:path.relative(fs.realpathSync(runtime),fs.realpathSync(entry)),entrySha256:sha256File(entry)});
    }
    worker = createSearchProcess({ entryFile: path.join(runtime,'forge-ask-all.mjs'), warmup: options.warmup !== false, readyTimeoutMs: options.warmup === false ? undefined : 180000 });
    await worker.ready();
    const execution={...identity,installedPackages,optionalAbsent,installation:{method:'npm-ci-ignore-scripts',lockSha256:sha256File(path.join(runtime,'package-lock.json')),dependencies}};
    const runtimeSha256=digest(execution);
    runtimeDirectories.add(runtime);
    // Code executes from the fresh runtime, while immutable RVF/passages assets remain in the
    // verified archive directory.  Binding the directory here prevents a caller from redirecting
    // retrieval to checkout or another unverified asset tree.
    const searchAll = (request = {}) => worker.searchAll({ ...request, dir: options.kbDir });
    return {searchAll,close:async()=>{await worker.close();runtimes.delete(path.resolve(options.kbDir));runtimeDirectories.delete(runtime);fs.rmSync(runtime,{recursive:true,force:true});},entryPoint:`controlled archive retrieval runtime@${runtimeSha256}`,identity:{...execution,runtimeSha256}};
  } catch(error) {await worker?.close();fs.rmSync(runtime,{recursive:true,force:true});throw error;}
}

export async function loadArchiveSearch(options) {
  const key=path.resolve(options.kbDir);
  if (!runtimes.has(key)) {
    const promise=createArchiveRuntime(options).catch(error=>{runtimes.delete(key);throw error;});
    runtimes.set(key,promise);
  }
  return runtimes.get(key);
}
