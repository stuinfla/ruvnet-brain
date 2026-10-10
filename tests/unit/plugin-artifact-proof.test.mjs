import { afterEach, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitBlobHash, pinnedClaudeTarget, verifyClaudeArtifact } from '../../plugin/scripts/plugin-artifact-proof.mjs';
const roots = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-artifact-'))); roots.push(root);
  const manifest = { name: 'sample', version: '1.0.0', skills: './skills/', mcpServers: './.mcp.json' };
  const files = { '.claude-plugin/plugin.json': JSON.stringify(manifest), 'skills/sample/SKILL.md': 'use this skill',
    '.mcp.json': JSON.stringify({ server: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/runner.mjs'] } }),
    'scripts/runner.mjs': 'console.log("server");', 'README.md': 'active instructions', '.cursor-plugin/plugin.json': 'other host metadata' };
  const entries = Object.entries(files).map(([name, value]) => {
    const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value);
    return { path: name, type: 'blob', mode: '100644', sha: gitBlobHash(Buffer.from(value)) };
  });
  return { root, files, target: { repo: 'example/plugin', commit: 'a'.repeat(40), manifest, manifestBlob: entries[0].sha, entries } };
}
test('Git blob hashing matches Git object format, including its length prefix', () => {
  expect(gitBlobHash(Buffer.from('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
});
test('pinned Claude closure matches every declared/default/transitive file without claiming another host', () => {
  const f = fixture(); fs.writeFileSync(path.join(f.root, '.cursor-plugin/plugin.json'), 'different other host');
  const proof = verifyClaudeArtifact(f.target, f.root);
  expect(proof.ok).toBe(true); expect(proof.actualClaudeSourceMatched).toBe(true); expect(proof.entireRepositoryMatched).toBe(false);
  expect(proof.compared.map(row => row.path)).toContain('scripts/runner.mjs');
  expect(proof.outsideClaudeProof).toEqual(['.cursor-plugin/plugin.json']);
});
test.each(['skills/sample/SKILL.md', '.mcp.json', 'scripts/runner.mjs'])('changed active file %s cannot pass immutable source proof', name => {
  const f = fixture(); fs.writeFileSync(path.join(f.root, name), 'changed active bytes');
  const proof = verifyClaudeArtifact(f.target, f.root); expect(proof.ok).toBe(false); expect(proof.mismatches).toContain(name);
});
test('missing declared resource, malformed path and symlink escape reject the proof', () => {
  const f = fixture(); f.target.manifest.skills = './missing'; expect(verifyClaudeArtifact(f.target, f.root).ok).toBe(false);
  f.target.manifest.skills = '../../outside'; expect(verifyClaudeArtifact(f.target, f.root).ok).toBe(false);
  f.target.manifest.skills = './skills'; const file = path.join(f.root, 'skills/sample/SKILL.md'); fs.unlinkSync(file); fs.symlinkSync('/tmp/outside-artifact', file);
  f.target.entries.find(row => row.path === 'skills/sample/SKILL.md').mode = '120000';
  const proof = verifyClaudeArtifact(f.target, f.root); expect(proof.ok).toBe(false); expect(proof.error).toMatch(/escapes artifact/);
});
test('literal local runtime dependencies are compared and escapes cannot pass', () => {
  const f=fixture();
  for(const [name,bytes] of Object.entries({'scripts/runner.mjs': "import './dependency.mjs';", 'scripts/dependency.mjs':'export const value=1;'})) {
    fs.writeFileSync(path.join(f.root,name),bytes);
    const prior=f.target.entries.find(entry=>entry.path===name);
    if(prior) prior.sha=gitBlobHash(Buffer.from(bytes)); else f.target.entries.push({path:name,type:'blob',mode:'100644',sha:gitBlobHash(Buffer.from(bytes))});
  }
  expect(verifyClaudeArtifact(f.target,f.root).compared.map(row=>row.path)).toContain('scripts/dependency.mjs');
  fs.writeFileSync(path.join(f.root,'scripts/dependency.mjs'),'changed');
  expect(verifyClaudeArtifact(f.target,f.root).ok).toBe(false);
  const escape="import '../../outside.mjs';";fs.writeFileSync(path.join(f.root,'scripts/runner.mjs'),escape);
  f.target.entries.find(row=>row.path==='scripts/runner.mjs').sha=gitBlobHash(Buffer.from(escape));
  expect(verifyClaudeArtifact(f.target,f.root).error).toMatch(/escapes artifact/);
});
test.each(['commands/extra.md','skills/extra/SKILL.md','hooks/extra.json','.claude-plugin/extra.json'])('extra cached active resource %s rejects source currency', name => {
  const f=fixture(), file=path.join(f.root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'untracked active source');
  const proof=verifyClaudeArtifact(f.target,f.root);expect(proof.ok).toBe(false);expect(proof.error).toMatch(/extra cached active Claude resource/);
});
test.each(['.mcp.json','.lsp.json','CLAUDE.md','settings.json'])('extra cached Claude default file %s rejects absent pinned source', name => {
  const f=fixture();f.target.entries=f.target.entries.filter(entry=>entry.path!==name);delete f.target.manifest.mcpServers;
  fs.writeFileSync(path.join(f.root,name),'extra default runtime source');
  const proof=verifyClaudeArtifact(f.target,f.root);expect(proof.ok).toBe(false);expect(proof.error).toMatch(/extra cached active Claude resource/);
});
test('immutable owner/tree/manifest are bounded, hash-bound and fetched once per repository pin', async () => {
  const f = fixture(),cache = new Map(),calls = [];
  const request = async url => { calls.push(url); return url.includes('/git/trees/')
    ? new Response(JSON.stringify({ tree: f.target.entries, truncated: false })) : new Response(f.files['.claude-plugin/plugin.json']); };
  const source = { source: 'url', url: 'https://github.com/example/plugin.git' };
  const target = await pinnedClaudeTarget(source, f.target.commit, { request, cache });
  expect(verifyClaudeArtifact(target, f.root).ok).toBe(true);
  await pinnedClaudeTarget(source, f.target.commit, { request, cache }); expect(calls).toHaveLength(2);
  await expect(pinnedClaudeTarget({ source: 'url', url: 'https://foreign.example/plugin.git' }, f.target.commit, { request })).rejects.toThrow(/owner/);
  await expect(pinnedClaudeTarget(source, f.target.commit, { request: async () => new Response(JSON.stringify({ tree: f.target.entries, truncated: true })) })).rejects.toThrow(/incomplete/);
});
test('pinned manifest bytes must match the immutable tree; version equality is insufficient', async () => {
  const f = fixture();
  await expect(pinnedClaudeTarget({ source: 'github', repo: 'example/plugin' }, f.target.commit, { request: async url => url.includes('/git/trees/')
    ? new Response(JSON.stringify({ tree: f.target.entries, truncated: false })) : new Response(JSON.stringify({ ...f.target.manifest, extra: 'different same version' })) })).rejects.toThrow(/Git blob/);
});
test('exact active bytes can establish pinned Claude currency while stale provider metadata remains untouched', async () => {
  const { synchronizePlugins } = await import('../../plugin/scripts/developer-update.mjs');
  const f=fixture(),home=path.join(f.root,'home'),artifact=path.join(f.root,'artifact');fs.mkdirSync(home);fs.mkdirSync(artifact);
  for(const [name,bytes]of Object.entries(f.files)){const file=path.join(artifact,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);}
  const registry=path.join(home,'.claude/plugins/installed_plugins.json');fs.mkdirSync(path.dirname(registry),{recursive:true});
  const old='b'.repeat(40),record={plugins:{'sample@market':[{scope:'user',version:'1.0.0',gitCommitSha:old,installPath:artifact}]}};fs.writeFileSync(registry,JSON.stringify(record));
  const market=path.join(home,'market');fs.mkdirSync(path.join(market,'.claude-plugin'),{recursive:true});fs.writeFileSync(path.join(market,'.claude-plugin/marketplace.json'),JSON.stringify({plugins:[{name:'sample',source:{source:'github',repo:'example/plugin',sha:f.target.commit}}]}));
  fs.writeFileSync(path.join(home,'.claude/plugins/known_marketplaces.json'),JSON.stringify({market:{installLocation:market}}));
  const before=fs.readFileSync(registry),calls=[];
  const result=await synchronizePlugins((_cmd,args)=>{calls.push(args);return '{}';},false,[],{home,scope:'all',locate:name=>name==='claude'?'/fixture/claude':null,artifactProvider:async()=>f.target});
  expect(result.steps[0].state).toBe('CURRENT');expect(result.steps[0].actualClaudeSourceMatched).toBe(true);expect(result.steps[0].sourceCommitMatched).toBe(false);
  expect(result.steps[0].providerMetadataDiscrepancy.recordedCommit).toBe(old);expect(fs.readFileSync(registry)).toEqual(before);
  expect(calls.some(args=>args[0]==='plugin'&&args[1]==='update')).toBe(false);
});
