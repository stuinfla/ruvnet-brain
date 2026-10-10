import { it as test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { compare, selectTag, discover, identity, upgradePackage, pluginScopes, scopeKey, runDeveloperUpdate, locateExecutable, resolvePluginTarget, pluginUpdateDecision, synchronizePlugins, marketplaceRemoteCommit, atomic } from '../../plugin/scripts/developer-update.mjs';
import { acquireDeveloperLock, sharedLockStatus } from '../../plugin/scripts/developer-update-lock.mjs';
import { automaticInvocation, automaticPath } from '../../plugin/scripts/automatic-update.mjs';
import { installNightlyRunner, developerRunHealth } from '../../plugin/scripts/nightly-scheduler.mjs';
import { developerCoordinatorOwner } from '../../plugin/scripts/developer-update-owner.mjs';
import { normalizeNpmDistTags } from '../../plugin/scripts/developer-update-policy.mjs';
import { cleanupNpxDuplicates } from '../../plugin/scripts/developer-update-cleanup.mjs';
import { cargoInventory, uvInventory, maintenance, verifyMaintenanceStage, nativeOwnerPreserved } from '../../plugin/scripts/developer-update-maintenance.mjs';
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

test('real knowledge worker chooses ready canonical owner before corrupt legacy settings', () => {
  const home=tmp(),brainHome=path.join(home,'.cache/ruvnet-brain'),kb=path.join(brainHome,'kb');
  const source=new URL('../../bin/nightly-refresh.mjs',import.meta.url).pathname;
  installNightlyRunner({brainHome,source,nodePath:process.execPath});
  const settings=path.join(home,'.config/ruvnet-brain/settings.json');fs.mkdirSync(path.dirname(settings),{recursive:true});fs.writeFileSync(settings,'corrupt legacy json');
  fs.mkdirSync(kb,{recursive:true});fs.writeFileSync(path.join(kb,'forge-update.mjs'),`import fs from 'node:fs';const file=process.argv[process.argv.indexOf('--result-file')+1];fs.writeFileSync(file,JSON.stringify({kind:'ruvnet-brain-check-result',recordedAt:new Date().toISOString(),currencyVerdict:'CURRENT'}));`);
  const attempt=path.join(brainHome,'attempt.json'),lock=path.join(brainHome,'knowledge.lock'),check=path.join(brainHome,'check.json'),result=path.join(brainHome,'result.json');
  atomic(attempt,{outcome:'launched'});fs.writeFileSync(lock,'fixture');
  const worker=new URL('../../plugin/scripts/host-update.mjs',import.meta.url).pathname;
  const child=spawnSync(process.execPath,[worker,'--knowledge',attempt,lock,'--if-newer',kb,check,result],{env:{...process.env,HOME:home,USERPROFILE:home,RUVNET_BRAIN_HOME:brainHome},encoding:'utf8',timeout:10_000});
  assert.equal(child.status,0,child.stderr);assert.equal(JSON.parse(fs.readFileSync(check)).outcome,'current');assert.equal(JSON.parse(fs.readFileSync(attempt)).outcome,'launched');assert.equal(fs.existsSync(lock),false);
});

test('minimal scheduler PATH discovers native owner roots and prefers existing global npm', async () => {
  const home=tmp(),prefix=path.join(home,'.npm-global'),root=path.join(prefix,'lib/node_modules'),bin=path.join(prefix,'bin'),cargoRoot=path.join(home,'.cargo');
  for(const dir of [root,bin,path.join(cargoRoot,'bin'),path.join(home,'.bun/bin'),path.join(home,'stable/bin')]) fs.mkdirSync(dir,{recursive:true});
  for(const file of [path.join(bin,'npm'),path.join(home,'stable/bin/npm'),path.join(cargoRoot,'bin/cargo'),path.join(cargoRoot,'bin/cargo-audit')]) fs.writeFileSync(file,'fixture',{mode:0o755});
  atomic(path.join(cargoRoot,'.crates2.json'),{installs:{'cargo-audit 1.0.0 (registry+https://github.com/rust-lang/crates.io-index)':{bins:['cargo-audit'],version_req:null}}});
  const minimal={PATH:'/usr/bin:/bin'};assert.equal(locateExecutable('cargo',{env:minimal}),null);
  const PATH=automaticPath({home,nodePath:path.join(home,'stable/bin/node'),env:minimal});
  assert.equal(locateExecutable('npm',{env:{PATH}}),path.join(bin,'npm'));assert.equal(locateExecutable('cargo',{env:{PATH}}),path.join(cargoRoot,'bin/cargo'));assert.ok(PATH.includes(path.join(home,'.bun/bin')));
  const calls=[];const runner=(command,args)=>{calls.push({command,args});if(args[0]==='prefix')return prefix;if(args[0]==='root')return root;throw Error(`unexpected owner call: ${command} ${args}`)};
  const request=vi.spyOn(globalThis,'fetch').mockResolvedValue({ok:true,json:async()=>({crate:{max_stable_version:'1.0.0'}})});
  try {
    const receipt=await runDeveloperUpdate({mode:'check',home,config:{cargo:true},env:{PATH},runner});
    const stage=receipt.maintenance.stages.find(s=>s.owner==='cargo-registry-tools');assert.ok(stage);assert.equal(stage.before[0].name,'cargo-audit');assert.equal(stage.after[0].version,'1.0.0');assert.equal(stage.state,'completed');assert.equal(request.mock.calls.length,1);
    assert.ok(!receipt.maintenance.exclusions.some(note=>note.startsWith('cargo has no existing')));assert.ok(!calls.some(c=>c.args[0]==='install'));
  } finally { request.mockRestore(); }
});

function pluginFixture({source='./',version=null,catalogFile=false,rootCatalog=false}={}) {
  const home=tmp(),market=path.join(home,'market'),catalog=catalogFile?path.join(home,'catalog.json'):path.join(market,rootCatalog?'marketplace.json':'.claude-plugin/marketplace.json');
  const entry={name:'sample',source,...(version?{version}:{})};atomic(catalog,{plugins:[entry]});
  atomic(path.join(home,'.claude/plugins/known_marketplaces.json'),{market:{installLocation:catalogFile?catalog:market}});
  return {home,market,catalog,plugin:{id:'sample@market',scope:'user',projectPath:null,version:version||'unknown',gitCommitSha:null}};
}
test('root-source plugins bind root manifest or refreshed catalogue commit without clones', () => {
  const f=pluginFixture();atomic(path.join(f.market,'.claude-plugin/plugin.json'),{version:'1.0.0'});
  const sha='a'.repeat(40),target=resolvePluginTarget(f.plugin,{home:f.home,run:()=>sha});
  assert.equal(target.version,'1.0.0');assert.equal(target.commit,null);assert.equal(target.catalogCommit,sha);assert.equal(target.authority,'version');assert.equal(pluginUpdateDecision({...f.plugin,version:'1.0.0',gitCommitSha:sha},target).state,'CURRENT');
});
test('hash-version plugins use exact refreshed git identity; opaque targets stay unsupported', () => {
  const f=pluginFixture(),sha='b'.repeat(40);
  const target=resolvePluginTarget(f.plugin,{home:f.home,run:()=>sha});assert.equal(target.version,null);assert.equal(pluginUpdateDecision({...f.plugin,gitCommitSha:sha},target).state,'CURRENT');
  assert.equal(resolvePluginTarget(f.plugin,{home:f.home,run:()=>{throw Error('no git')}}).supported,false);
});
test('pinned remote plugin sources compare the catalogue SHA with installed SHA', () => {
  const sha='c'.repeat(40),f=pluginFixture({source:{source:'url',url:'https://github.com/example/plugin.git',sha}});
  const target=resolvePluginTarget(f.plugin,{home:f.home,run:()=>assert.fail()});assert.equal(target.commit,sha);assert.equal(pluginUpdateDecision({...f.plugin,gitCommitSha:sha},target).state,'CURRENT');assert.equal(pluginUpdateDecision(f.plugin,target).state,'UPDATE_AVAILABLE');
});
test('JSON-file and root marketplace catalogues are read at their exact installed owner path', () => {
  for(const settings of [{catalogFile:true},{rootCatalog:true}]) {const f=pluginFixture({...settings,version:'1.0.0',source:{source:'github',repo:'example/plugin'}});assert.equal(resolvePluginTarget(f.plugin,{home:f.home,run:()=>assert.fail()}).version,'1.0.0');}
});
test('escape and opaque/unpinned refs cannot authorize plugin update', () => {
  const escape=pluginFixture({source:'./../../outside',version:'2.0.0'});assert.equal(resolvePluginTarget(escape.plugin,{home:escape.home}).supported,false);
  const opaque=pluginFixture({source:{source:'url',url:'https://github.com/example/plugin.git'}});assert.equal(resolvePluginTarget(opaque.plugin,{home:opaque.home}).supported,false);
  assert.equal(pluginUpdateDecision({version:'2.0.0'},{supported:true,version:'1.0.0',commit:'d'.repeat(40)}).state,'AHEAD');
});
test('stock plugin update preserves original scope/cwd and verifies exact pinned commit', () => {
  const sha='e'.repeat(40),f=pluginFixture({source:{source:'url',url:'https://github.com/example/plugin.git',sha}}),project=path.join(f.home,'project'),artifact=path.join(f.home,'artifact');fs.mkdirSync(project);fs.mkdirSync(artifact);
  const installed=path.join(f.home,'.claude/plugins/installed_plugins.json');atomic(installed,{plugins:{'sample@market':[{scope:'local',projectPath:project,installPath:artifact,version:'unknown',gitCommitSha:'f'.repeat(40)}]}});
  atomic(path.join(project,'.claude/settings.local.json'),{enabledPlugins:{'sample@market':false}});
  const calls=[],runner=(command,args,options)=>{calls.push({command,args,options});if(args[1]==='update')atomic(installed,{plugins:{'sample@market':[{scope:'local',projectPath:project,installPath:artifact,version:sha.slice(0,12),gitCommitSha:sha}]}});return '{}';};
  const notes=[],receipt=synchronizePlugins(runner,false,notes,{home:f.home,prefix:path.join(f.home,'prefix'),scope:'all',locate:name=>name==='claude'?'/fixture/claude':null});
  const update=calls.find(c=>c.args[1]==='update');assert.deepEqual(update.args,['plugin','update','sample@market','--scope','local','--json']);assert.equal(update.options.cwd,project);assert.equal(receipt.steps[0].state,'UPDATED');assert.equal(receipt.after[0].gitCommitSha,sha);assert.equal(JSON.parse(fs.readFileSync(path.join(project,'.claude/settings.local.json'))).enabledPlugins['sample@market'],false);
});
test('plugin updater cannot accept success without exact target identity', () => {
  const sha='1'.repeat(40),f=pluginFixture({source:{source:'github',repo:'example/plugin',sha}}),artifact=path.join(f.home,'artifact');fs.mkdirSync(artifact);
  atomic(path.join(f.home,'.claude/plugins/installed_plugins.json'),{plugins:{'sample@market':[{scope:'user',installPath:artifact,version:'unknown',gitCommitSha:'2'.repeat(40)}]}});
  assert.throws(()=>synchronizePlugins(()=>'{"ok":true}',false,[],{home:f.home,scope:'all',locate:()=>'/fixture/claude'}),/target not verified/);
});

test('native Rust channels precede Cargo installs and uv self-update precedes uv tool upgrades', async () => {
  const home=tmp(),cargoRoot=path.join(home,'.cargo'),uv=path.join(home,'.local/bin/uv'),rustup=path.join(cargoRoot,'bin/rustup'),cargo=path.join(cargoRoot,'bin/cargo');
  for(const file of [uv,rustup,cargo,path.join(cargoRoot,'bin/cargo-audit')]) {fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'fixture',{mode:0o755});}
  const toolRoot=path.join(home,'.local/share/uv/tools/sample');fs.mkdirSync(toolRoot,{recursive:true});fs.writeFileSync(path.join(toolRoot,'uv-receipt.toml'),'[tool]\nrequirements = [{ name = "sample" }]\n');
  const crates=path.join(cargoRoot,'.crates2.json');atomic(crates,{installs:{'cargo-audit 1.0.0 (registry+https://github.com/rust-lang/crates.io-index)':{bins:['cargo-audit'],version_req:null}}});
  const calls=[],runner=(command,args)=>{calls.push({command,args});let stdout='';if(args[0]==='--version')stdout=command===uv?'uv 0.13.0':'rustup 1.29.1';if(args[0]==='toolchain')stdout='stable-aarch64-apple-darwin (default)\n1.89.0-aarch64-apple-darwin\nnightly-aarch64-apple-darwin';if(command===cargo&&args[0]==='install')atomic(crates,{installs:{'cargo-audit 2.0.0 (registry+https://github.com/rust-lang/crates.io-index)':{bins:['cargo-audit'],version_req:null}}});return {exitCode:0,stdout};};
  const request=vi.spyOn(globalThis,'fetch').mockResolvedValue({ok:true,json:async()=>({crate:{max_stable_version:'2.0.0'}})});
  try {
    const receipt=await maintenance({native:true,uv:true,cargo:true},runner,false,{home,locate:name=>({uv,cargo})[name]||null});
    const position=(command,args)=>calls.findIndex(c=>c.command===command&&args.every((value,i)=>c.args[i]===value));
    assert.ok(position(rustup,['update','stable-aarch64-apple-darwin'])<position(cargo,['install','cargo-audit']));
    assert.ok(position(uv,['self','update'])<position(uv,['tool','upgrade','sample']));
    assert.ok(!calls.some(c=>c.command===rustup&&c.args[0]==='update'&&c.args[1].startsWith('1.89.0')));
    assert.equal(receipt.stages.find(s=>s.owner==='cargo-registry-tools').after[0].version,'2.0.0');
  } finally { request.mockRestore(); }
});

test('derived provider verdict rejects failed exits and absent postconditions', () => {
  assert.equal(verifyMaintenanceStage([{exitCode:7}],{ownerPreserved:true}).ok,false);
  assert.equal(verifyMaintenanceStage([{exitCode:0}],{ownerPreserved:false}).ok,false);
  assert.equal(verifyMaintenanceStage([{exitCode:0}],{ownerPreserved:true}).ok,true);
});
test('native provider failed exit cannot write a completed coordinator receipt', async () => {
  const home=tmp(),prefix=path.join(home,'.npm-global'),root=path.join(prefix,'lib/node_modules'),uv=path.join(home,'.local/bin/uv');
  for(const dir of [root,path.join(prefix,'bin'),path.dirname(uv)])fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(prefix,'bin/npm'),'fixture',{mode:0o755});fs.writeFileSync(uv,'fixture',{mode:0o755});
  const runner=(command,args)=>{if(args[0]==='prefix')return prefix;if(args[0]==='root')return root;return {exitCode:args[0]==='self'?7:0,stdout:args[0]==='--version'?'uv 1.0.0':'',stderr:'fixture provider failure'};};
  await assert.rejects(runDeveloperUpdate({mode:'apply',home,config:{native:true},env:{PATH:path.join(prefix,'bin')},runner}),/exit 7/);
  const receipt=JSON.parse(fs.readFileSync(path.join(home,'.cache/ruvnet-brain/nightly-suite-update.json')));assert.equal(receipt.ok,false);assert.equal(receipt.state,'failed');
  const stage=receipt.maintenance.stages[0];assert.equal(stage.state,'failed');assert.equal(stage.commands.at(-1).exitCode,7);
});
test('zero native command exits cannot hide a measured version downgrade', async () => {
  const home=tmp(),uv=path.join(home,'.local/bin/uv');fs.mkdirSync(path.dirname(uv),{recursive:true});fs.writeFileSync(uv,'fixture',{mode:0o755});
  let versions=0,observed;const runner=(_command,args)=>({exitCode:0,stdout:args[0]==='--version'?(versions++?'uv 1.0.0':'uv 2.0.0'):''});
  await assert.rejects(maintenance({native:true},runner,false,{home,progress:value=>observed=value}),/postconditions failed/);
  assert.equal(observed.stages[0].state,'failed');assert.equal(observed.stages[0].verification.postconditions.versionVerified,false);
});
test('known uv and Cargo inventories require their existing manager; absent inventory causes no installs', async () => {
  const home=tmp(),tool=path.join(home,'.local/share/uv/tools/sample');fs.mkdirSync(tool,{recursive:true});fs.writeFileSync(path.join(tool,'uv-receipt.toml'),'[tool]\nrequirements = [{ name = "sample" }]');
  await assert.rejects(maintenance({uv:true},()=>assert.fail(),true,{home}),/no existing uv manager/);
  atomic(path.join(home,'.cargo/.crates2.json'),{installs:{'sample 1.0.0 (registry+https://github.com/rust-lang/crates.io-index)':{bins:['sample']}}});
  await assert.rejects(maintenance({cargo:true},()=>assert.fail(),true,{home}),/no existing Cargo manager/);
  assert.equal((await maintenance({uv:true,cargo:true},()=>assert.fail(),true,{home:tmp()})).stages.length,0);
});
test('zero Homebrew exits still require the measured installed owner set', async () => {
  const home=tmp(),brew=path.join(home,'brew');fs.writeFileSync(brew,'fixture',{mode:0o755});let info=0,observed;
  const runner=(_command,args)=>({exitCode:0,stdout:args[0]==='info'?JSON.stringify({formulae:info++?[]:[{full_name:'owned'}]}):''});
  await assert.rejects(maintenance({homebrew:true},runner,false,{home,locate:name=>name==='brew'?brew:null,progress:value=>observed=value}),/postconditions failed/);
  assert.equal(observed.stages[0].state,'failed');assert.equal(observed.stages[0].verification.postconditions.formulaOwnersPreserved,false);
});
test('unknown command exit evidence never counts as provider completion', async () => {
  const home=tmp(),uv=path.join(home,'.local/bin/uv');fs.mkdirSync(path.dirname(uv),{recursive:true});fs.writeFileSync(uv,'fixture',{mode:0o755});
  await assert.rejects(maintenance({native:true},()=> 'uv 1.0.0',false,{home}),/exit evidence absent/);
});
test('nightly success requires all actual digests, nonfuture freshness and applied terminal evidence', () => {
  const home=tmp(),brainHome=path.join(home,'.cache/ruvnet-brain'),source=new URL('../../bin/nightly-refresh.mjs',import.meta.url).pathname;
  const record=installNightlyRunner({brainHome,source,nodePath:process.execPath}),sourceSnapshot=Object.fromEntries(Object.entries(record.updateModules).map(([name,item])=>[name,item.sha256]));
  const now=Date.now(),base={schemaVersion:1,kind:'nightly-suite-update',sourceSha256:record.updateModules['developer-update.mjs'].sha256,sourceSnapshot,mode:'apply',schedulerIdentity:record.identity,state:'completed',ok:true,finishedAt:new Date(now).toISOString()};
  const check=value=>{atomic(path.join(brainHome,'nightly-suite-update.json'),value);return developerRunHealth({brainHome,registration:record,now})};
  assert.equal(check(base).verification.ok,true);
  assert.equal(check({...base,sourceSnapshot:{}}).state,'failed');
  assert.equal(check({...base,finishedAt:new Date(now+3_600_000).toISOString()}).state,'failed');
  assert.equal(check({...base,ok:false}).state,'failed');
  assert.equal(check({...base,mode:'check'}).state,'never-ran');
  assert.equal(check({...base,schedulerIdentity:'other-owner'}).state,'never-ran');
});
test('unsupported plugin steps appear in coordinator coverage independently of note capitalization', async () => {
  const home=tmp(),prefix=path.join(home,'.npm-global'),root=path.join(prefix,'lib/node_modules'),bin=path.join(prefix,'bin'),artifact=path.join(home,'artifact');
  for(const dir of [root,bin,artifact])fs.mkdirSync(dir,{recursive:true});for(const name of ['npm','claude'])fs.writeFileSync(path.join(bin,name),'fixture',{mode:0o755});
  atomic(path.join(home,'.claude/plugins/installed_plugins.json'),{plugins:{'opaque@unknown-market':[{scope:'user',installPath:artifact,version:'unknown'}]}});
  const runner=(_command,args)=>{if(args[0]==='prefix')return prefix;if(args[0]==='root')return root;throw Error('unexpected mutation')};
  const receipt=await runDeveloperUpdate({mode:'check',home,config:{scope:'all'},env:{PATH:bin},runner});
  assert.equal(receipt.plugins.steps[0].state,'UNSUPPORTED');assert.ok(receipt.coverage.unverified.some(note=>note.includes('opaque@unknown-market')));
});

test('Codex symlink cannot leave its established standalone namespace at the same version', async () => {
  const home=tmp(),file=path.join(home,'.local/bin/codex'),old=path.join(home,'.codex/packages/standalone/vOld/bin/codex'),outside=path.join(tmp(),'codex');
  for(const target of [file,old,outside])fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(old,'fixture',{mode:0o755});fs.writeFileSync(outside,'fixture',{mode:0o755});fs.symlinkSync(old,file);
  let observed;const runner=(command,args)=>{if(command===file&&args[0]==='update'){fs.unlinkSync(file);fs.symlinkSync(outside,file);}return {exitCode:0,stdout:'codex 1.0.0'};};
  await assert.rejects(maintenance({native:true},runner,false,{home,progress:value=>observed=value}),/postconditions failed/);
  const stage=observed.stages.find(s=>s.owner===file);assert.equal(stage.state,'failed');assert.equal(stage.verification.postconditions.ownerPreserved,false);
});
test('native version changes are allowed only inside the proven standalone owner namespace', () => {
  const home=tmp(),file=path.join(home,'.local/bin/codex'),root=path.join(home,'.codex/packages/standalone');
  assert.equal(nativeOwnerPreserved(file,path.join(root,'vOld/bin/codex'),path.join(root,'vNew/bin/codex'),home),true);
  assert.equal(nativeOwnerPreserved(file,path.join(home,'unknown/codex'),path.join(root,'vNew/bin/codex'),home),false);
  const uv=path.join(home,'.local/bin/uv');assert.equal(nativeOwnerPreserved(uv,uv,path.join(home,'elsewhere/uv'),home),false);
});
test('archive-only known GitHub marketplace resolves a strict advertised identity without clones', () => {
  const f=pluginFixture(),sha='b'.repeat(40);atomic(path.join(f.home,'.claude/plugins/known_marketplaces.json'),{market:{installLocation:f.market,source:{source:'github',repo:'example/plugin'}}});
  const calls=[],target=resolvePluginTarget(f.plugin,{home:f.home,run:(_cmd,args)=>{calls.push(args);if(args[0]==='-C')throw Error('archive has no git');return sha+'\tHEAD';}});
  assert.equal(target.supported,true);assert.equal(target.commit,sha);assert.equal(target.authority,'commit');assert.equal(target.proof,'known-marketplace-remote-commit');assert.equal(target.catalogSha256.length,64);
  assert.deepEqual(calls[1],['ls-remote','--exit-code','https://github.com/example/plugin.git','HEAD']);
});
test('remote marketplace owner/ref and returned identities reject ambiguity or guessed fallback', () => {
  const sha='c'.repeat(40);
  for(const owner of [{source:'url',repo:'example/plugin'},{source:'github',repo:'../foreign'},{source:'github',repo:'example/plugin',ref:'--upload-pack=evil'},{source:'github',repo:'example/plugin',ref:'a..b'},{source:'github',repo:'example/plugin',ref:'refs/tags/v1'}])assert.throws(()=>marketplaceRemoteCommit(owner,()=>assert.fail()),/unsupported/);
  const owner={source:'github',repo:'example/plugin',ref:'main'};
  assert.equal(marketplaceRemoteCommit(owner,()=>sha+'\trefs/heads/main').commit,sha);
  for(const output of ['',sha+'\tHEAD',sha+'\trefs/heads/main\n'+sha+'\trefs/heads/other','malformed\trefs/heads/main'])assert.throws(()=>marketplaceRemoteCommit(owner,()=>output),/ambiguous|unverified/);
});
test('equal published semantic versions never force stock updates for unrelated unpinned repo commits', () => {
  const f=pluginFixture({version:'1.1.0'}),newHead='d'.repeat(40),oldHead='e'.repeat(40),artifact=path.join(f.home,'artifact');fs.mkdirSync(artifact);
  atomic(path.join(f.home,'.claude/plugins/installed_plugins.json'),{plugins:{'sample@market':[{scope:'user',installPath:artifact,version:'1.1.0',gitCommitSha:oldHead}]}});
  const calls=[],run=(_command,args)=>{calls.push(args);return args[0]==='-C'?newHead:'{}';};
  const result=synchronizePlugins(run,false,[],{home:f.home,scope:'all',locate:name=>name==='claude'?'/fixture/claude':null});
  assert.equal(result.steps[0].state,'CURRENT');assert.equal(result.steps[0].proof,'published-plugin-version');assert.equal(result.steps[0].sourceCommitMatched,false);assert.ok(!calls.some(args=>args[0]==='plugin'&&args[1]==='update'));
  assert.equal(pluginUpdateDecision({version:'1.1.0',gitCommitSha:oldHead},{supported:true,authority:'commit',version:'1.1.0',commit:newHead}).state,'UPDATE_AVAILABLE');
});
test('Homebrew execution completion exposes currency only when manager markers are actually present', async () => {
  const home=tmp(),brew=path.join(home,'brew');fs.writeFileSync(brew,'fixture',{mode:0o755});
  const run=(_cmd,args)=>({exitCode:0,stdout:args[0]==='info'?JSON.stringify({formulae:[{full_name:'owned'}]}):''});
  const result=await maintenance({homebrew:true},run,true,{home,locate:()=>brew});const stage=result.stages[0];
  assert.equal(stage.verification.ok,true);assert.equal(stage.currencyChecked,false);assert.equal(stage.currency,'unverified');assert.ok(result.exclusions.some(note=>note.includes('currency markers unavailable')));
});
