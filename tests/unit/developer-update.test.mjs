import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { compare, selectTag, discover, identity, upgradePackage, pluginScopes, scopeKey, runDeveloperUpdate, atomic } from '../../plugin/scripts/developer-update.mjs';
import { acquireDeveloperLock, sharedLockStatus } from '../../plugin/scripts/developer-update-lock.mjs';
import { automaticInvocation } from '../../plugin/scripts/automatic-update.mjs';
import { installNightlyRunner, developerRunHealth } from '../../plugin/scripts/nightly-scheduler.mjs';
import { developerCoordinatorOwner } from '../../plugin/scripts/developer-update-owner.mjs';
import { normalizeNpmDistTags } from '../../plugin/scripts/developer-update-policy.mjs';
import { cleanupNpxDuplicates } from '../../plugin/scripts/developer-update-cleanup.mjs';
import { cargoInventory, uvInventory, maintenance } from '../../plugin/scripts/developer-update-maintenance.mjs';
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-suite-test-')));
function fixture(name = 'example-cli', version = '1.0.0') {
  const prefix = tmp(), location = path.join(prefix, 'lib/node_modules', name);
  fs.mkdirSync(location, { recursive: true }); fs.mkdirSync(path.join(prefix, 'bin'));
  fs.writeFileSync(path.join(location, 'package.json'), JSON.stringify({ name, version, bin: { example: 'cli.js' } }));
  fs.writeFileSync(path.join(location, 'cli.js'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.symlinkSync(path.join(location, 'cli.js'), path.join(prefix, 'bin/example'));
  return identity(location, prefix);
}
test('release selection never downgrades and uses newer Kit next/Ruflo alpha', () => {
  assert.equal(selectTag('x', '2.0.0', { latest: '1.0.0' }).upgrade, false);
  assert.equal(selectTag('ruflo', '1.0.0', { latest: '1.1.0', alpha: '1.2.0-alpha.1' }, 'alpha').tag, 'alpha');
  assert.equal(selectTag('@pacphi/agentic-kit', '1.0.0', { latest: '1.1.0', next: '1.2.0' }).tag, 'next');
  assert.equal(compare('1.0.0', '1.0.0-beta.2'), 1);
  assert.equal(compare('1.0.0-alpha.9', '1.0.0-alpha.10'), -1);
  assert.throws(() => selectTag('x', 'x', { latest: '1.0.0' }), /uncomparable/);
});
test('new/disconnected global roots rejected', () => {
  assert.throws(() => discover(tmp(), tmp()), /new prefix/);
});
test('absent original package cannot cause fresh installation', () => {
  const before = fixture();fs.rmSync(before.location, { recursive: true });
  let calls = 0;
  assert.throws(() => upgradePackage(before, { latest: '2.0.0' }, [], { run: () => calls++ }));
  assert.equal(calls, 0);
});
test('absent launcher cannot be silently recreated', () => {
  const before = fixture();fs.unlinkSync(before.launchers[0].launcher);
  assert.throws(() => upgradePackage(before, { latest: '2.0.0' }, [], { run: () => assert.fail() }), /absent launcher/);
});
test('shadowed wrapper does not steal another package launcher', () => {
  const before = fixture();fs.unlinkSync(before.launchers[0].launcher);fs.symlinkSync('/bin/sh', before.launchers[0].launcher);
  const result = upgradePackage(before, { latest: '2.0.0' }, [], { run: () => assert.fail() });
  assert.equal(result.state, 'shadowed-preserved');
});
test('no downgrade installer invocation', () => {
  assert.equal(upgradePackage(fixture(), { latest: '0.9.0' }, [], { run: () => assert.fail() }).state, 'ahead-preserved');
});
test('apply uses tag only, original prefix and reviewed lifecycle policy', () => {
  const before = fixture(); let args;
  const result = upgradePackage(before, { latest: '2.0.0' }, ['sharp'], { run: (_, a) => {
    args = a;const file = path.join(before.location, 'package.json');const m=JSON.parse(fs.readFileSync(file));m.version='2.0.0';fs.writeFileSync(file,JSON.stringify(m));
  } });
  assert.deepEqual(args, ['install','-g','--prefix',before.prefix,'--allow-scripts=sharp','example-cli@latest']);
  assert.equal(result.state, 'updated');
});
test('installer exit success without matching manifest cannot claim success', () => {
  assert.throws(() => upgradePackage(fixture(), { latest: '2.0.0' }, [], { run: () => {} }), /not verified/);
});
test('dry-run makes no installer calls', () => {
  assert.equal(upgradePackage(fixture(), { latest: '2.0.0' }, [], { dryRun: true, run: () => assert.fail() }).state, 'update-available');
});
test('plugin scopes preserve same ID installed at multiple scopes', () => {
  const root=tmp(),file=path.join(root,'plugins.json');
  atomic(file,{plugins:{'a@m':[{scope:'user',version:'1',installPath:root},{scope:'project',projectPath:root,version:'1',installPath:root}]}});
  const rows=pluginScopes(file);assert.equal(rows.length,2);assert.notEqual(scopeKey(rows[0]),scopeKey(rows[1]));
  atomic(file,{plugins:{'a@m':[{scope:'project'}]}});assert.throws(()=>pluginScopes(file),/missing plugin project/);
});
test('shared PID/token lock excludes other owners and inherited child cannot release', () => {
  const brainHome=tmp(),lock=acquireDeveloperLock({brainHome});
  assert.equal(sharedLockStatus({brainHome}).owner.pid,process.pid);
  assert.throws(()=>acquireDeveloperLock({brainHome,token:'wrong'}),/lock running/);
  const child=acquireDeveloperLock({brainHome,token:lock.token});child.release();
  assert.equal(sharedLockStatus({brainHome}).state,'running');lock.release();assert.equal(sharedLockStatus({brainHome}).state,'idle');
});
test('failure writes failed receipt without a false PASS or retained lock', async () => {
  const home=tmp(),prefix=path.join(home,'npm'),root=path.join(prefix,'lib/node_modules'),kit=path.join(root,'@pacphi/agentic-kit');
  fs.mkdirSync(kit,{recursive:true});fs.writeFileSync(path.join(kit,'package.json'),JSON.stringify({name:'@pacphi/agentic-kit',version:'1.0.0'}));
  fs.mkdirSync(path.join(home,'bin'));fs.writeFileSync(path.join(home,'bin/npm'),'fake',{mode:0o755});
  const run=(_command,args)=> {if(args[0]==='prefix')return prefix;if(args[0]==='root')return root;throw Error('mock registry failure');};
  await assert.rejects(runDeveloperUpdate({mode:'apply',home,env:{PATH:path.join(home,'bin')},runner:run}),/mock registry failure/);
  const receipt=JSON.parse(fs.readFileSync(path.join(home,'.cache/ruvnet-brain/nightly-suite-update.json')));
  assert.equal(receipt.ok,false);assert.equal(receipt.state,'failed');assert.equal(sharedLockStatus({brainHome:path.join(home,'.cache/ruvnet-brain')}).state,'idle');
});
test('uv inventory excludes wheel/path/pinned requirement', () => {
  const root=tmp();
  for(const [name,requirement] of [['a','{ name = "a" }'],['b','{ name = "b", path = "/source.whl" }'],['c','{ name = "c", specifier = "==1" }']]) {
    fs.mkdirSync(path.join(root,name));fs.writeFileSync(path.join(root,name,'uv-receipt.toml'),`[tool]\nrequirements = [${requirement}]\n`);
  }
  assert.deepEqual(uvInventory(root).map(t=>[t.name,t.registry]),[['a',true],['b',false],['c',false]]);
});
test('Cargo retains registry vs local source ownership', () => {
  const root=tmp();atomic(path.join(root,'.crates2.json'),{installs:{'x 1.0.0 (registry+https://github.com/rust-lang/crates.io-index)':{bins:['x']},'y 2.0.0 (path+file:///local)':{bins:['y']}}});
  assert.equal(cargoInventory(root)[1].source,'path+file:///local');
});
test('maintenance defaults execute nothing; unsupported flags fail closed', async () => {
  assert.deepEqual((await maintenance({},()=>assert.fail(),false)).stages,[]);
  await assert.rejects(maintenance({surprise:true},()=>assert.fail(),false),/unknown maintenance/);
});

test('latest default and alpha fallback are source ordered', () => {
  assert.equal(selectTag('ruflo','1.0.0',{latest:'1.1.0',alpha:'1.2.0-alpha.1'}).tag,'latest');
  assert.equal(selectTag('@ruvector/rvf','1.0.0',{latest:'1.1.0'},'alpha').tag,'latest');
});
test('known npx duplicates require closed process ownership; project dependencies remain', () => {
  const home=tmp(),root=path.join(home,'.npm/_npx'),globalRoot=path.join(home,'global');
  fs.mkdirSync(path.join(globalRoot,'ruflo'),{recursive:true});fs.writeFileSync(path.join(globalRoot,'ruflo/package.json'),'{}');
  for(const name of ['0123456789abcdef','1111111111111111','unknown']) {const dir=path.join(root,name);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({dependencies:{ruflo:'latest'}}));}
  const result=cleanupNpxDuplicates({home,globalRoot,enabled:true,active:d=>d.endsWith('1111111111111111')});
  assert.equal(result.removed.length,1);assert.equal(result.retained.length,1);assert.equal(fs.existsSync(path.join(root,'unknown')),true);
});
test('canonical apply needs no Kit, binds actual npm prefix and shares child token', async () => {
  const before=fixture('ruflo'),home=tmp(),bin=path.join(home,'bin');fs.mkdirSync(bin);fs.writeFileSync(path.join(bin,'npm'),'fake',{mode:0o755});
  const calls=[];
  const runner=(command,args,options)=>{
    calls.push({command,args,token:options.env.RUVNET_DEVELOPER_UPDATE_TOKEN,prefix:options.env.npm_config_prefix});
    if(args[0]==='prefix')return before.prefix;
    if(args[0]==='root')return path.join(before.prefix,'lib/node_modules');
    if(args[0]==='view')return JSON.stringify({latest:'1.1.0',alpha:'1.2.0-alpha.1'});
    if(args[0]==='install'){const file=path.join(before.location,'package.json'),m=JSON.parse(fs.readFileSync(file));m.version='1.1.0';fs.writeFileSync(file,JSON.stringify(m));return '';}
    if(args[0]==='--version')return 'ruflo 1.1.0';
    throw Error(`unexpected call ${args}`);
  };
  const receipt=await runDeveloperUpdate({mode:'apply',home,env:{PATH:bin},runner});
  assert.equal(receipt.state,'completed');assert.equal(receipt.ok,true);
  assert.equal(receipt.npmIdentity.prefix,before.prefix);assert.equal(receipt.steps[0].target.tag,'latest');
  const install=calls.find(c=>c.args[0]==='install');assert.equal(install.args[3],before.prefix);
  assert.ok(calls.every(c=>c.token===receipt.ownerToken));assert.equal(fs.existsSync(path.join(home,'.cache/ruvnet-brain/developer-update.lock')),false);
});
test('stale and malformed ownership cannot be stolen', () => {
  const brainHome=tmp(),dir=path.join(brainHome,'developer-update.lock');fs.mkdirSync(dir);atomic(path.join(dir,'owner.json'),{pid:99999999,token:'12345678901234567890'});
  assert.throws(()=>acquireDeveloperLock({brainHome,alive:()=>false}),/lock stale/);
  fs.writeFileSync(path.join(dir,'owner.json'),'broken');assert.throws(()=>acquireDeveloperLock({brainHome}),/lock unknown/);
});
test('explicit local modification policy preserves installed Kit without claiming upgraded', () => {
  const before=fixture('@pacphi/agentic-kit');
  const receipt=upgradePackage(before,{latest:'2.0.0',next:'2.1.0-alpha.1'},[],{preservePackages:['@pacphi/agentic-kit'],run:()=>assert.fail()});
  assert.equal(receipt.reason,'preservedLocalModification');assert.equal(receipt.state,'local-modification-preserved');assert.equal(receipt.after.version,'1.0.0');
});

test('registered coordinator bridges automatic hooks to the same bytes; corrupted source never falls back to npx', () => {
  const home=tmp(),brainHome=path.join(home,'.cache/ruvnet-brain');
  const source=new URL('../../bin/nightly-refresh.mjs',import.meta.url).pathname;
  const record=installNightlyRunner({brainHome,source,nodePath:process.execPath});
  const owner=developerCoordinatorOwner({home,brainHome});assert.equal(owner.ready,true);
  const invocation=automaticInvocation(['--update','--no-nightly-prompt'],{home,source:'latest'});
  assert.deepEqual(invocation.args,[record.updateModules['developer-update.mjs'].path,'--apply']);
  fs.appendFileSync(owner.entry,'\n//changed');
  assert.throws(()=>automaticInvocation(['--update'],{home,source:'latest'}),/not ready/);
});
test('canonical nightly health is source/identity bound; manual checks do not prove nightly runs', () => {
  const home=tmp(),brainHome=path.join(home,'.cache/ruvnet-brain'),source=new URL('../../bin/nightly-refresh.mjs',import.meta.url).pathname;
  const record=installNightlyRunner({brainHome,source,nodePath:process.execPath});
  const sourceSnapshot=Object.fromEntries(Object.entries(record.updateModules).map(([name,value])=>[name,value.sha256]));
  const receipt={sourceSnapshot,schemaVersion:1,kind:'nightly-suite-update',mode:'apply',state:'completed',ok:true,sourceSha256:record.updateModules['developer-update.mjs'].sha256,schedulerIdentity:record.identity,finishedAt:new Date().toISOString()};
  atomic(path.join(brainHome,'nightly-suite-update.json'),receipt);assert.equal(developerRunHealth({brainHome,registration:record}).state,'ok');
  receipt.mode='check';atomic(path.join(brainHome,'nightly-suite-update.json'),receipt);assert.equal(developerRunHealth({brainHome,registration:record}).state,'never-ran');
  receipt.sourceSha256='forged';atomic(path.join(brainHome,'nightly-suite-update.json'),receipt);assert.equal(developerRunHealth({brainHome,registration:record}).state,'failed');
});
test('Windows global layout binds declared npm cmd shim to its existing owner', () => {
  const prefix=tmp(),location=path.join(prefix,'node_modules/example');fs.mkdirSync(location,{recursive:true});
  fs.writeFileSync(path.join(location,'package.json'),JSON.stringify({name:'example',version:'1.0.0',bin:{example:'cli.js'}}));
  fs.writeFileSync(path.join(location,'cli.js'),'');fs.writeFileSync(path.join(prefix,'example.cmd'),'node "%dp0%\\node_modules\\example\\cli.js" %*');
  assert.equal(identity(location,prefix,{platform:'win32'}).launchers[0].owned,true);
  fs.writeFileSync(path.join(prefix,'example.cmd'),'node "%dp0%\\node_modules\\foreign\\cli.js" %*');
  assert.equal(identity(location,prefix,{platform:'win32'}).launchers[0].owned,false);
});

test('npm 11 object and npm 12 singleton dist-tag records choose identical release', () => {
  const object={latest:'1.1.0',alpha:'1.2.0-alpha.1'};
  assert.deepEqual(normalizeNpmDistTags([object]),object);
  assert.deepEqual(selectTag('ruflo','1.0.0',[object],'alpha'),selectTag('ruflo','1.0.0',object,'alpha'));
});
test('ambiguous or malformed npm registry records cannot pick a release', () => {
  for(const value of [[],[{latest:'1.0.0'},{latest:'2.0.0'}],[[{latest:'1.0.0'}]],[null],['1.0.0'],{latest:1},{}]) {
    assert.throws(()=>normalizeNpmDistTags(value),/npm dist-tags/);
  }
});

test('ready canonical owner bypasses corrupt legacy source settings; unowned legacy still validates', () => {
  const home=tmp(),brainHome=path.join(home,'.cache/ruvnet-brain');
  const source=new URL('../../bin/nightly-refresh.mjs',import.meta.url).pathname;
  const record=installNightlyRunner({brainHome,source,nodePath:process.execPath});
  const settings=path.join(home,'.config/ruvnet-brain/settings.json');fs.mkdirSync(path.dirname(settings),{recursive:true});fs.writeFileSync(settings,'corrupt legacy json');
  const invocation=automaticInvocation(['--update'],{home});assert.equal(invocation.source,'developer-suite');assert.equal(invocation.args[0],record.updateModules['developer-update.mjs'].path);
  const legacy=tmp(),legacySettings=path.join(legacy,'.config/ruvnet-brain/settings.json');fs.mkdirSync(path.dirname(legacySettings),{recursive:true});fs.writeFileSync(legacySettings,'corrupt legacy json');
  assert.throws(()=>automaticInvocation(['--update'],{home:legacy}),/owner update settings/);
});
