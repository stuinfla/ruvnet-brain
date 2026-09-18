import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { localImportsOf, makeCopier, projectStoreViews, resolveModuleGraph, validateRequiredRuntimeFiles } from '../../scripts/build-bundle.mjs';

const write = (root, name, source) => {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
};
const tempRoots = [];
afterEach(() => { for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const temp = (prefix) => { const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tempRoots.push(root); return root; };

describe('bundle module graph', () => {
  it('closes the real repository graph and binds the installed validator owner', () => {
    const root = path.resolve(import.meta.dirname, '../..');
    const modules = resolveModuleGraph(path.join(root, 'kb'));
    expect(modules).toContain('forge-ask-all.mjs');
    expect(modules).toContain('forge-update.mjs');
    expect(validateRequiredRuntimeFiles(root).map(row => row.destination)).toContain('coverage-integrity.mjs');
  });



  it('ignores comment markers inside strings while collecting imports', () => {
    const root = temp('bundle-graph-');
    write(root, 'entry.mjs', "const marker = '// fake import(\\\"./missing.mjs\\\")'; import './child.mjs';");
    write(root, 'child.mjs', 'export const child = true;');
    expect(localImportsOf(path.join(root, 'entry.mjs'))).toEqual(['./child.mjs']);
  });

  it('includes literal template dynamic imports', () => {
    const root = temp('bundle-graph-');
    write(root, 'entry.mjs', 'await import(`./child.mjs`);');
    write(root, 'child.mjs', 'export const child = true;');
    expect(resolveModuleGraph(root, ['entry.mjs'])).toEqual(['child.mjs', 'entry.mjs']);
  });

  it('resolves bound local and external dynamic specifiers', () => {
    const root = temp('bundle-graph-');
    write(root, 'entry.mjs', 'const local = "./child.mjs"; const external = "pkg"; await import(local); await import(external);');
    write(root, 'child.mjs', 'export const child = true;');
    expect(localImportsOf(path.join(root, 'entry.mjs'))).toEqual(['./child.mjs']);
    write(root, 'transitive.mjs', 'const alias = target; const target = "./child.mjs"; await import(alias);');
    expect(localImportsOf(path.join(root, 'transitive.mjs'))).toEqual(['./child.mjs']);
    write(root, 'mutable-alias.mjs', 'let target = "./child.mjs"; const alias = target; target = "pkg"; await import(alias);');
    expect(() => localImportsOf(path.join(root, 'mutable-alias.mjs'))).toThrow(/unresolved or ambiguous/);
    write(root, 'require-alias.mjs', 'const localRequire = createRequire(import.meta.url); localRequire("./child.mjs");');
    expect(localImportsOf(path.join(root, 'require-alias.mjs'))).toEqual(['./child.mjs']);
    write(root, 'shadowed-require.mjs', 'const localRequire = createRequire(import.meta.url); function load(localRequire) { return localRequire("./child.mjs"); }');
    expect(() => localImportsOf(path.join(root, 'shadowed-require.mjs'))).toThrow(/unresolved or ambiguous/);
    write(root, 'require-aliases.mjs', "import { createRequire as cr } from 'node:module'; const load = cr(import.meta.url); const r = load; r('./child.mjs');");
    expect(localImportsOf(path.join(root, 'require-aliases.mjs'))).toEqual(['./child.mjs']);
    write(root, 'namespace-require.mjs', "import * as mod from 'node:module'; const load = mod.createRequire(import.meta.url); load('./child.mjs');");
    expect(localImportsOf(path.join(root, 'namespace-require.mjs'))).toEqual(['./child.mjs']);
    write(root, 'bare-module-require.mjs', "import * as mod from 'module'; const cr = mod.createRequire; const req = cr; const load = req(import.meta.url); load('./child.mjs');");
    expect(localImportsOf(path.join(root, 'bare-module-require.mjs'))).toEqual(['./child.mjs']);
    write(root, 'destructured-module-require.mjs', "import * as mod from 'module'; const { createRequire: factory } = mod; const cr = factory; const req = cr(import.meta.url); req('./child.mjs');");
    expect(localImportsOf(path.join(root, 'destructured-module-require.mjs'))).toEqual(['./child.mjs']);
    write(root, 'unsupported-require-factory.mjs', "const mod = { createRequire: () => {} }; const req = mod.createRequire(import.meta.url); req('./child.mjs');");
    expect(() => localImportsOf(path.join(root, 'unsupported-require-factory.mjs'))).toThrow(/unresolved or ambiguous/);
  });

  it('rejects unresolved first-party dynamic imports', () => {
    const root = temp('bundle-graph-');
    write(root, 'entry.mjs', 'const name = "child"; await import(`./${name}.mjs`);');
    expect(() => localImportsOf(path.join(root, 'entry.mjs'))).toThrow(/unresolved or ambiguous dynamic module specifier/);
  });

  it('does not reject unresolved external dynamic imports', () => {
    const root = temp('bundle-graph-');
    write(root, 'entry.mjs', 'const packageName = "external-package"; await import(packageName);');
    expect(localImportsOf(path.join(root, 'entry.mjs'))).toEqual([]);
  });

  it('rejects shadowed and reassigned specifier bindings', () => {
    const root = temp('bundle-graph-');
    write(root, 'entry.mjs', '{ const target = "./child.mjs"; } const target = "pkg"; import(target);');
    expect(() => localImportsOf(path.join(root, 'entry.mjs'))).toThrow(/unresolved or ambiguous/);
    write(root, 'entry2.mjs', 'const target = "./child.mjs"; target = "pkg"; import(target);');
    expect(() => localImportsOf(path.join(root, 'entry2.mjs'))).toThrow(/unresolved or ambiguous/);
    write(root, 'entry3.mjs', 'const target = "./child.mjs"; function load(target) { return import(target); } load("pkg");');
    expect(() => localImportsOf(path.join(root, 'entry3.mjs'))).toThrow(/unresolved or ambiguous/);
    write(root, 'entry4.mjs', 'const target = "./child.mjs"; function load({ target }) { return import(target); } load({ target: "pkg" });');
    expect(() => localImportsOf(path.join(root, 'entry4.mjs'))).toThrow(/unresolved or ambiguous/);
    write(root, 'entry5.mjs', 'const target = "./child.mjs"; function load(...target) { return import(target); } load("pkg");');
    expect(() => localImportsOf(path.join(root, 'entry5.mjs'))).toThrow(/unresolved or ambiguous/);
    write(root, 'entry6.mjs', 'const target = "./child.mjs"; try {} catch ({ target }) { import(target); }');
    expect(() => localImportsOf(path.join(root, 'entry6.mjs'))).toThrow(/unresolved or ambiguous/);
    write(root, 'entry7.mjs', 'const target = "./child.mjs"; ({ target } = { target: "pkg" }); import(target);');
    expect(() => localImportsOf(path.join(root, 'entry7.mjs'))).toThrow(/unresolved or ambiguous/);
    write(root, 'entry8.mjs', 'const target = "./child.mjs"; const obj = { load(target) { return import(target); } }; obj.load("pkg");');
    expect(() => localImportsOf(path.join(root, 'entry8.mjs'))).toThrow(/unresolved or ambiguous/);
  });

  it('allows only the named repository owners opaque path loading', () => {
    const root = temp('bundle-graph-');
    const canonicalKb = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../kb');
    for (const name of ['resolve-deps.mjs', 'forge-guard-injection.mjs']) {
      fs.copyFileSync(path.join(canonicalKb, name), path.join(root, name));
    }
    expect(localImportsOf(path.join(root, 'resolve-deps.mjs'))).toEqual(['./node-version.mjs']);
    expect(localImportsOf(path.join(root, 'forge-guard-injection.mjs'))).toEqual([]);
    write(root, 'resolve-deps-forged.mjs', "const url = process.env.XENOVA_PATH; await import(url);");
    fs.renameSync(path.join(root, 'resolve-deps-forged.mjs'), path.join(root, 'resolve-deps.mjs'));
    expect(() => localImportsOf(path.join(root, 'resolve-deps.mjs'))).toThrow(/unresolved or ambiguous/);
    write(root, 'forge-update.mjs', 'const policyPath = getPolicyPath(); await import(pathToFileURL(policyPath).href);');
    expect(() => localImportsOf(path.join(root, 'forge-update.mjs'))).toThrow(/unresolved or ambiguous/);
    write(root, 'fork-source.mjs', 'await import(pathToFileURL(condition ? local : installed).href);');
    expect(() => localImportsOf(path.join(root, 'fork-source.mjs'))).toThrow(/unresolved or ambiguous/);
  });

  it('ignores block comment import markers and recognizes module URL imports', () => {
    const root = temp('bundle-graph-');
    write(root, 'entry.mjs', 'const marker = "/* import(\\\"./fake.mjs\\\") */"; await import(new URL("./child.mjs", import.meta.url).href);');
    write(root, 'child.mjs', 'export const child = true;');
    expect(localImportsOf(path.join(root, 'entry.mjs'))).toEqual(['./child.mjs']);
  });

  it('preserves nested module paths and rejects destination collisions', async () => {
    const root = temp('bundle-copy-');
    const out = path.join(root, 'out');
    write(root, 'one/child.mjs', 'export const source = "one";');
    write(root, 'two/child.mjs', 'export const source = "two";');
    write(root, 'alt/one/child.mjs', 'export const source = "alt";');
    const copier = makeCopier();
    copier.cp('one/child.mjs', out, { required: true, from: root });
    copier.cp('two/child.mjs', out, { required: true, from: root });
    expect(fs.readFileSync(path.join(out, 'one/child.mjs'), 'utf8')).toContain('one');
    expect(fs.readFileSync(path.join(out, 'two/child.mjs'), 'utf8')).toContain('two');
    const one = await import(`${pathToFileURL(path.join(out, 'one/child.mjs')).href}?test=${Date.now()}`);
    const two = await import(`${pathToFileURL(path.join(out, 'two/child.mjs')).href}?test=${Date.now()}`);
    expect(one.source).toBe('one');
    expect(two.source).toBe('two');
    const dirOut = path.join(root, 'dir-out');
    copier.cpDir(path.join(root, 'one'), dirOut);
    expect(() => copier.cpDir(path.join(root, 'two'), dirOut)).toThrow(/destination collision/);
    expect(() => copier.cp('one/child.mjs', out, { required: true, from: path.join(root, 'alt') })).toThrow(/destination collision/);
    expect(() => copier.cp('../two/child.mjs', out, { required: false, from: path.join(root, 'one') })).toThrow(/escapes bundle root/);
    fs.symlinkSync(path.join(root, 'one/child.mjs'), path.join(root, 'link.mjs'));
    expect(() => copier.cp('link.mjs', out, { required: true, from: root })).toThrow(/symbolic link/);
  });

  it('rejects missing or changed shipped validator bytes', () => {
    const root = temp('bundle-runtime-');
    expect(() => validateRequiredRuntimeFiles(root)).toThrow(/validator is missing/);
    write(root, 'plugin/scripts/coverage-integrity.mjs', 'forged validator');
    expect(() => validateRequiredRuntimeFiles(root)).toThrow(/differs from the reviewed canonical source/);
  });

  it('preserves fork generation provenance in every projected view', () => {
    const forkDelta = { version: 'fork-delta/2', forkRepository: 'example/fork', upstream: 'example/upstream',
      forkHeadSha: 'a'.repeat(40), upstreamHeadSha: 'b'.repeat(40), mergeBaseSha: 'c'.repeat(40), aheadBy: 1, behindBy: 0,
      inventorySha256: 'd'.repeat(64), passagesSha256: 'e'.repeat(64) };
    const generation = { sha256: 'f'.repeat(64), bytes: 1, model: 'm', dimensions: 384,
      sourceCommit: 'a'.repeat(40), builtUtc: '2026-09-17T00:00:00.000Z', sourceMode: 'fork-delta', forkDelta };
    const views = projectStoreViews({ selectedResults: [{ name: 'fork', kind: 'repository', tier: '1', stars: 1,
      chunks: 1, baseModel: 'm', baseDims: 384, hasSymbols: false, hasPrimer: false, gradeRealUse: null, generation }],
      identity: { version: '1.0.0' }, updaterConfig: {} });
    expect(views.ledger.stores.fork).toMatchObject({ sourceMode: 'fork-delta', forkDelta });
    expect(views.source.stores.fork).toMatchObject({ sourceMode: 'fork-delta', forkDelta });
    expect(views.manifestEntries[0]).toMatchObject({ sourceMode: 'fork-delta', forkDelta });
  });
});
