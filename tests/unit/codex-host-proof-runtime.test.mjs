import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { proofDigest, publishedTarFiles, verifyReleasedHostRuntime, assertHostRuntimeUnchanged } from '../../scripts/codex-host-proof-runtime.mjs';

const roots = [];
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { force: true, recursive: true }); });
function archive(entries) {
  const blocks = [];
  for (const [name, text, type = '0'] of entries) {
    const body = Buffer.from(text); const header = Buffer.alloc(512);
    header.write(name); header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124); header.fill(32, 148, 156); header.write(type, 156);
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
function fixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-runtime-proof-'))); roots.push(dir);
  const version = '4.5.7'; const brainHome = path.join(dir, 'brain'); const codeRoot = path.join(brainHome, 'versions', version);
  const pluginRoot = path.join(dir, 'plugin'); const mcpShell = path.join(dir, 'shell/mcp/server.mjs');
  const entries = [
    ['scripts/session-start-core.mjs', '// body'], ['scripts/session-start-proof.mjs', '// proof'],
    ['mcp/server.mjs', "import './sibling.mjs';"], ['mcp/sibling.mjs', '// dependency'],
    ['scripts/codex-hook-wrapper.mjs', '// wrapper'], ['scripts/hook-shim.mjs', '// shim'],
    ['scripts/development-maintenance.mjs', '// maintenance'],
    ['.codex-plugin/plugin.json', JSON.stringify({ name: 'ruvnet-brain', version })], ['hooks/codex-hooks.json', '{}'],
  ];
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  for (const [member, text] of entries) { write(path.join(codeRoot, member), text); write(path.join(pluginRoot, member), text); }
  write(path.join(brainHome, 'codex-hook.mjs'), '// wrapper');
  write(mcpShell, entries[2][1]); write(path.join(path.dirname(mcpShell), 'sibling.mjs'), '// dependency');
  write(path.join(brainHome, 'active.json'), JSON.stringify({ version, generation: 38, codeRoot: `versions/${version}` }));
  write(path.join(brainHome, 'kb/forge-mcp-all.mjs'), '// bundle worker');
  const bytes = archive(entries.map(([member, text]) => [`package/plugin/${member}`, text]));
  const packageArchive = path.join(dir, 'package.tgz'); write(packageArchive, bytes);
  const metadata = { name: 'ruvnet-brain', version, dist: { tarball: `https://registry.npmjs.org/ruvnet-brain/-/ruvnet-brain-${version}.tgz`,
    integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}` } };
  return { dir, version, brainHome, codeRoot, pluginRoot, mcpShell, packageArchive, packageSha256: proofDigest(bytes),
    workerSha256: proofDigest('// bundle worker'), timeoutMs: 1000, metadata, fetch: async () => new Response(JSON.stringify(metadata)) };
}
describe('released native execution runtime binding', () => {
  it('binds independent public package integrity, every executing source and the authenticated bundle worker', async () => {
    const f = fixture(); const proof = await verifyReleasedHostRuntime(f);
    expect(proof).toMatchObject({ generation: 38, version: '4.5.7', packageSha256: f.packageSha256, codeRoot: f.codeRoot });
    expect(proof.bindings.some((row) => row.path.endsWith(path.join('shell', 'mcp', 'sibling.mjs')))).toBe(true);
    expect(proof.bindings.some((row) => row.path === path.join(f.codeRoot, 'scripts/hook-shim.mjs'))).toBe(true);
    expect(() => assertHostRuntimeUnchanged(proof, f.brainHome)).not.toThrow();
  });
  it('binds an optional wrapper helper when present and refuses a newly appearing helper after proof', async () => {
    const f = fixture(); const file = path.join(f.brainHome, 'development-maintenance.mjs');
    const absent = await verifyReleasedHostRuntime(f); fs.writeFileSync(file, '// maintenance');
    expect(() => assertHostRuntimeUnchanged(absent, f.brainHome)).toThrow();
    const present = await verifyReleasedHostRuntime(f);
    expect(present.bindings.some((row) => row.path === file)).toBe(true);
    fs.writeFileSync(file, '// foreign'); await expect(verifyReleasedHostRuntime(f)).rejects.toThrow();
  });
  it.each(['package digest', 'public integrity', 'public version', 'public URL', 'body', 'shell dependency', 'wrapper', 'worker', 'generation', 'dev mode', 'update lock', 'diagnostic missing'])('rejects %s mismatch before native execution', async (kind) => {
    const f = fixture();
    if (kind === 'package digest') f.packageSha256 = 'a'.repeat(64);
    if (kind === 'public integrity') f.metadata.dist.integrity = 'sha512-invalid';
    if (kind === 'public version') f.metadata.version = '0.0.0';
    if (kind === 'public URL') f.metadata.dist.tarball = 'https://foreign.example/package.tgz';
    if (kind === 'body') fs.writeFileSync(path.join(f.codeRoot, 'scripts/session-start-core.mjs'), '// local edit');
    if (kind === 'shell dependency') fs.writeFileSync(path.join(path.dirname(f.mcpShell), 'sibling.mjs'), '// local edit');
    if (kind === 'wrapper') fs.writeFileSync(path.join(f.brainHome, 'codex-hook.mjs'), '// local edit');
    if (kind === 'worker') f.workerSha256 = 'a'.repeat(64);
    if (kind === 'generation') fs.writeFileSync(path.join(f.brainHome, 'active.json'), JSON.stringify({ version: '4.5.7', generation: 0, codeRoot: 'versions/4.5.7' }));
    if (kind === 'dev mode') fs.writeFileSync(path.join(f.brainHome, 'dev.json'), '{}');
    if (kind === 'update lock') fs.writeFileSync(path.join(f.brainHome, '.kb.refresh-run.lock'), '{}');
    if (kind === 'diagnostic missing') fs.unlinkSync(path.join(f.codeRoot, 'scripts/session-start-proof.mjs'));
    await expect(verifyReleasedHostRuntime(f)).rejects.toThrow();
  });
  it('does not accept a self-consistent edited package against live npm integrity', async () => {
    const f = fixture(); const edited = archive([['package/plugin/scripts/session-start-core.mjs', '// edited']]);
    fs.writeFileSync(f.packageArchive, edited); f.packageSha256 = proofDigest(edited);
    await expect(verifyReleasedHostRuntime(f)).rejects.toThrow('Published package integrity mismatch');
  });
  it('detects post-execution source and pointer changes independently', async () => {
    const f = fixture(); const proof = await verifyReleasedHostRuntime(f);
    fs.appendFileSync(path.join(f.codeRoot, 'scripts/session-start-core.mjs'), '// race');
    expect(() => assertHostRuntimeUnchanged(proof, f.brainHome)).toThrow();
    fs.writeFileSync(path.join(f.codeRoot, 'scripts/session-start-core.mjs'), '// body');
    fs.appendFileSync(path.join(f.brainHome, 'active.json'), ' ');
    expect(() => assertHostRuntimeUnchanged(proof, f.brainHome)).toThrow();
  });
  it('rejects oversized public metadata during streaming', async () => {
    const f = fixture(); f.fetch = async () => new Response('x'.repeat(2 * 1024 * 1024 + 1));
    await expect(verifyReleasedHostRuntime(f)).rejects.toThrow('Published metadata exceeds bound');
  });
  it.each([['../escape', 'x', '0'], ['package/symlink', 'other', '2']])('never extracts unsafe member %s', (name, text, type) => {
    expect(() => publishedTarFiles(archive([[name, text, type]]))).toThrow();
  });
  it('rejects duplicate archive entries and malformed checksums', () => {
    expect(() => publishedTarFiles(archive([['package/a', 'a'], ['package/a', 'b']]))).toThrow('duplicated');
    const body = Buffer.alloc(1024, 1); expect(() => publishedTarFiles(gzipSync(body))).toThrow('invalid');
  });
});
