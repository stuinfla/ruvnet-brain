import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyArchiveSearch, loadArchiveSearch } from '../../scripts/oracle/search-runtime.mjs';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function fixture({ shippedMutate, shippedSymlink = false, dependencyVersion } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-runtime-')); dirs.push(root);
  const checkout = path.join(root, 'kb'); const shipped = path.join(root, 'shipped');
  fs.mkdirSync(checkout, { recursive: true }); fs.mkdirSync(shipped, { recursive: true });
  fs.writeFileSync(path.join(checkout, 'forge-ask-all.mjs'), "import { answer } from './nested/answer.mjs'; export function searchAll(q) { return answer(q); }\n");
  fs.mkdirSync(path.join(checkout, 'nested')); fs.writeFileSync(path.join(checkout, 'nested', 'answer.mjs'), 'export const answer = q => [{ q }];\n');
  const dependency = 'fixture-search-runtime';
  const version = dependencyVersion ?? '1.2.3';
  fs.writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { [dependency]: '^' + version } }));
  fs.writeFileSync(path.join(checkout, 'package-lock.json'), JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: { '': { dependencies: { [dependency]: '^' + version } }, [`node_modules/${dependency}`]: { version } } }));
  fs.cpSync(checkout, shipped, { recursive: true });
  if (shippedMutate) fs.writeFileSync(path.join(shipped, 'nested', 'answer.mjs'), shippedMutate);
  if (shippedSymlink) { fs.rmSync(path.join(shipped, 'nested', 'answer.mjs')); fs.symlinkSync(path.join(checkout, 'nested', 'answer.mjs'), path.join(shipped, 'nested', 'answer.mjs')); }
  fs.mkdirSync(path.join(checkout,'node_modules',dependency),{recursive:true});
  fs.writeFileSync(path.join(checkout,'node_modules',dependency,'package.json'),JSON.stringify({name:dependency,version:'1.2.3'}));
  return { root, shipped };
}

describe('verified archive retrieval closure', () => {
  it('accepts a complete byte-identical closure without reading checkout node_modules', () => {
    const f = fixture();
    fs.rmSync(path.join(f.root, 'kb', 'node_modules'), { recursive: true, force: true });
    expect(verifyArchiveSearch({ root: f.root, kbDir: f.shipped }).files.map(row => row.path)).toEqual(['forge-ask-all.mjs', 'nested/answer.mjs', 'package-lock.json', 'package.json']);
  });
  it('rejects tampering in a nested module even when the entrypoint is unchanged', () => {
    const f = fixture({ shippedMutate: 'export const answer = q => [{ forged: q }];\n' });
    expect(() => verifyArchiveSearch({ root: f.root, kbDir: f.shipped })).toThrow(/differs from checkout: nested\/answer.mjs/);
  });
  it('rejects missing and symlinked closure members', () => {
    const missing = fixture(); fs.rmSync(path.join(missing.shipped, 'nested', 'answer.mjs'));
    expect(() => verifyArchiveSearch({ root: missing.root, kbDir: missing.shipped })).toThrow(/missing or unsafe/);
    const linked = fixture({ shippedSymlink: true });
    expect(() => verifyArchiveSearch({ root: linked.root, kbDir: linked.shipped })).toThrow(/missing or unsafe/);
  });
  it('rejects unsafe lock package paths before installation', () => {
    const f = fixture();
    const lock = JSON.parse(fs.readFileSync(path.join(f.shipped, 'package-lock.json'), 'utf8'));
    lock.packages['../outside'] = { version: '1.0.0' };
    fs.writeFileSync(path.join(f.shipped, 'package-lock.json'), JSON.stringify(lock));
    expect(() => verifyArchiveSearch({ root: f.root, kbDir: f.shipped })).toThrow(/differs from checkout: package-lock.json/);
    fs.writeFileSync(path.join(f.root, 'kb', 'package-lock.json'), JSON.stringify(lock));
    expect(() => verifyArchiveSearch({ root: f.root, kbDir: f.shipped })).toThrow(/unsafe package path/);
  });
});

it('does not census transitive packages from a checkout installation',()=>{
  const f=fixture(),lockFile=path.join(f.root,'kb','package-lock.json');
  const lock=JSON.parse(fs.readFileSync(lockFile,'utf8'));
  lock.packages['node_modules/transitive']={version:'2.0.0'};
  const text=JSON.stringify(lock);fs.writeFileSync(lockFile,text);fs.writeFileSync(path.join(f.shipped,'package-lock.json'),text);
  fs.rmSync(path.join(f.root,'kb','node_modules'),{recursive:true,force:true});
  const result=verifyArchiveSearch({root:f.root,kbDir:f.shipped});
  expect(result.installedPackages).toEqual([]);
  expect(result.optionalAbsent).toEqual([]);
});


it('executes the staged archive module once and ignores executable bytes in the checkout', async()=>{
  const f=fixture(); const kb=path.join(f.root,'kb');
  const source="export function searchAll(){return {module:import.meta.url, marker:'archive'};}";
  for (const dir of [kb,f.shipped]) {
    fs.writeFileSync(path.join(dir,'forge-ask-all.mjs'),source);
    fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'runtime-fixture',version:'1.0.0',type:'module'}));
    fs.writeFileSync(path.join(dir,'package-lock.json'),JSON.stringify({name:'runtime-fixture',version:'1.0.0',lockfileVersion:3,requires:true,packages:{'':{name:'runtime-fixture',version:'1.0.0'}}}));
  }
  const first=await loadArchiveSearch({root:f.root,kbDir:f.shipped,warmup:false});
  fs.writeFileSync(path.join(kb,'forge-ask-all.mjs'),"throw new Error('mutated checkout')");
  const second=await loadArchiveSearch({root:f.root,kbDir:f.shipped,warmup:false});
  expect(second).toBe(first);
  const result = await first.searchAll();
  expect(result.marker).toBe('archive');
  expect(result.module).toContain('ruvnet-search-runtime-');
  expect(result.module).not.toContain(f.root);
  await first.close();
  expect(first.identity.installation.method).toBe('npm-ci-ignore-scripts');
  expect(first.identity.installedPackages).toEqual([]);
});

it('refuses non-integrity dependency sources before installation',async()=>{
  const f=fixture();
  await expect(loadArchiveSearch({root:f.root,kbDir:f.shipped})).rejects.toThrow(/lacks registry integrity/);
});

it('executes against a fresh runtime with the actual RVF and ONNX packages', async () => {
  const probe = '/Users/stuartkerr/Code/ruvnet-brain-consistency-20260916/verified-search-deps-probe';
  if (!fs.existsSync(path.join(probe, 'package-lock.json'))) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-runtime-real-')); dirs.push(root);
  const checkout = path.join(root, 'kb'); const shipped = path.join(root, 'shipped');
  fs.mkdirSync(checkout, { recursive: true }); fs.mkdirSync(shipped, { recursive: true });
  for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(probe, file), path.join(checkout, file));
  const entry = "import '@ruvector/rvf'; import '@xenova/transformers'; export function searchAll() { return { actualPackages: true }; }\n";
  fs.writeFileSync(path.join(checkout, 'forge-ask-all.mjs'), entry); fs.cpSync(checkout, shipped, { recursive: true });
  const loaded = await loadArchiveSearch({ root, kbDir: shipped, warmup: false });
  expect((await loaded.searchAll()).actualPackages).toBe(true);
  expect(loaded.identity.installation.method).toBe('npm-ci-ignore-scripts');
  expect(loaded.identity.installation.dependencies.map(row => row.name)).toEqual(['@ruvector/rvf', '@xenova/transformers']);
  expect(loaded.identity.installedPackages.some(row => row.path === 'node_modules/@ruvector/rvf')).toBe(true);
  await loaded.close();
});
