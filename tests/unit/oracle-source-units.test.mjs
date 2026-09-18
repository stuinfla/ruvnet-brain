import {afterEach,expect,it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {buildInventory,gitBlobSha} from '../../scripts/oracle/source-units.mjs';
import {createSourceAdapters} from '../../scripts/oracle/source-adapters.mjs';
const roots=[];
afterEach(()=>roots.splice(0).forEach(dir=>fs.rmSync(dir,{recursive:true,force:true})));
function fixture(files){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'oracle-v2-'));roots.push(dir);
  const git=(...args)=>execFileSync('git',['-C',dir,'-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{encoding:'utf8'}).trim();
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  for(const [name,body]of Object.entries(files)){fs.mkdirSync(path.dirname(path.join(dir,name)),{recursive:true});fs.writeFileSync(path.join(dir,name),body);}
  git('add','-f','.');git('commit','-qm','fixture');return {dir,repo:'fixture',commit:git('rev-parse','HEAD'),git};
}
function reviewed(inventory){return {schemaVersion:1,kind:'oracle-source-dispositions',repo:inventory.repo,
  commitSha:inventory.commitSha,treeSha:inventory.treeSha,entries:inventory.units.map(u=>({unitId:u.unitId,path:u.path,
    objectSha:u.blobSha,bytesSha256:u.bytesSha256,disposition:'eligible',reason:'Fixture explicitly asserts this source proposition or declaration.',reviewer:'test-fixture'}))};}
it('uses pinned Git objects, accounts for tests/config/generated source and requires semantic disposition before U',async()=>{
  const f=fixture({'README.md':'# Tool\nRestores user state.\n\nUsage\n-----\nRun the tool.\n','tests/a.ts':'export function a(){return 1;}\n',
    '.github/workflows/ci.yml':'name: fixture\njobs:\n  check:\n    runs-on: ubuntu-latest\n',
    'dist/generated.js':'// @generated\nmodule.exports = 1;\n','LICENSE':'MIT','package-lock.json':'{}'});
  const pending=await buildInventory(f);
  expect(pending.inventoryComplete).toBe(false);expect(pending.U).toBeNull();expect(pending.selected).toEqual([]);
  expect(pending.entries).toHaveLength(6);
  expect(pending.units.map(u=>u.path)).toEqual(expect.arrayContaining(['README.md','tests/a.ts','.github/workflows/ci.yml','dist/generated.js']));
  const dispositions=reviewed(pending);
  const complete=await buildInventory({...f,dispositions});
  expect(complete.inventoryComplete).toBe(true);expect(complete.U).toBe(pending.enumeratedU);
  expect(complete.selected.every(u=>typeof u.unitId==='string')).toBe(true);
  fs.writeFileSync(path.join(f.dir,'tests/a.ts'),'broken pending work');fs.writeFileSync(path.join(f.dir,'untracked.md'),'extra');
  expect(await buildInventory({...f,dispositions})).toEqual(complete);
});
it('uses syntax for Rust/Python and retains short/private declarations instead of regex or token floors',async()=>{
  const f=fixture({'lib.rs':'pub(crate) fn a() -> i32 { 1 }\nconst TEXT: &str = "pub fn fake() {}";\n',
    'main.py':'def _short():\n    return 1\ntext = "def fake():"\n','api.ts':'function internal(){return 1;}\nexport type T = string;\n'});
  const inv=await buildInventory(f);
  expect(inv.failures).toEqual([]);expect(inv.units.some(u=>u.name==='a')).toBe(true);
  expect(inv.units.some(u=>u.name==='_short')).toBe(true);expect(inv.units.some(u=>u.name==='internal')).toBe(true);
  expect(inv.units.some(u=>u.name==='fake')).toBe(false);
  for(const unit of inv.units){const bytes=fs.readFileSync(path.join(f.dir,unit.path));expect(unit.blobSha).toBe(gitBlobSha(bytes));expect(unit.endByte).toBeLessThanOrEqual(bytes.length);}
});
it('recursively owns Python classes, Rust impls, and TypeScript namespaces without parent/member overlap',async()=>{
  const python='@dataclass\nclass Store:\n    KIND = "memory"\n    def put(self, value):\n        return value\n    def get(self):\n        return self.KIND\n';
  const rust='pub struct Store {\n    pub value: String,\n}\npub trait Persist {\n    fn save(&self) -> bool { true }\n}\nimpl Store {\n    pub fn put(&mut self, value: String) { self.value = value; }\n    pub fn get(&self) -> &str { &self.value }\n}\n';
  const typescript='export namespace Store {\n  export const put = (value: string) => value;\n  export function get() { return ""; }\n}\nexport const api = {\n  save(value: string) { return value; },\n  reset: () => true,\n};\n';
  const blobs=new Map([['py',Buffer.from(python)],['rs',Buffer.from(rust)],['ts',Buffer.from(typescript)]]);
  const adapters=await createSourceAdapters({manifest:{entries:[{path:'store.py',objectSha:'py'},{path:'store.rs',objectSha:'rs'},{path:'store.ts',objectSha:'ts'}]},blobs});
  for(const [name,text] of [['python',python],['rust',rust],['typescript',typescript]]){
    const adapter=adapters.find(a=>a.matches({path:`store.${name==='typescript'?'ts':name==='python'?'py':'rs'}`},text));
    const result=adapter.enumerate({text});
    expect(result.errors).toEqual([]);
    const names=result.units.map(unit=>unit.name).filter(Boolean);
    if(name==='python') { expect(names).toEqual(expect.arrayContaining(['Store','put','get'])); expect(result.units.some(unit=>text.slice(unit.startByte,unit.endByte).includes('KIND ='))).toBe(true); }
    if(name==='rust') expect(names).toEqual(expect.arrayContaining(['Store','Persist','save','put','get']));
    if(name==='typescript') expect(names).toEqual(expect.arrayContaining(['Store','put','get','api','save','reset']));
    expect(result.units.some(unit=>text.slice(unit.startByte,unit.endByte).includes(name==='rust'?'self.value':'return'))).toBe(true);
    expect(result.units.length).toBeGreaterThan(4);
    const spans=result.units.sort((a,b)=>a.startByte-b.startByte);
    for(let i=1;i<spans.length;i++) expect(spans[i].startByte).toBeGreaterThanOrEqual(spans[i-1].endByte);
  }
});
it('preserves UTF-8 byte spans including non-ASCII and NUL-bearing JavaScript source',async()=>{
  const f=fixture({'a.mjs':'export const label = "é😀\0";\nexport function b(){ return label; }\n'});
  const inv=await buildInventory(f);
  expect(inv.snapshot.entries[0].entryKind).toBe('file');expect(inv.failures).toEqual([]);
  const bytes=fs.readFileSync(path.join(f.dir,'a.mjs'));
  for(const u of inv.units)expect(bytes.subarray(u.startByte,u.endByte).toString('utf8')).toMatch(/export/);
});
it('recursively extracts dotted TypeScript namespaces without losing their declarations',async()=>{
  const f=fixture({'nested.ts':'export namespace A.B { export function f() { return "é😀"; } }\n'});
  const inv=await buildInventory(f);
  expect(inv.failures).toEqual([]);
  expect(inv.units.map(unit=>unit.name)).toEqual(['A','B','f']);
  const bytes=fs.readFileSync(path.join(f.dir,'nested.ts'));
  expect(bytes.subarray(inv.units[2].startByte,inv.units[2].endByte).toString('utf8')).toBe('export function f() { return "é😀"; }');
  for(let i=1;i<inv.units.length;i++) expect(inv.units[i].startByte).toBeGreaterThanOrEqual(inv.units[i-1].endByte);
});
it('does not freeze or sample unresolved syntax, unsupported modalities, or stale/extra dispositions',async()=>{
  const f=fixture({'bad.py':'def broken(\n','unknown.svelte':'<script>let x=1;</script>','ok.md':'This tool restores state.\n'});
  const inv=await buildInventory(f);expect(inv.U).toBeNull();expect(inv.failures[0].path).toBe('bad.py');
  expect(inv.unsupported.map(x=>x.path)).toContain('unknown.svelte');expect(inv.selected).toEqual([]);
  const d=reviewed(inv);d.entries[0].bytesSha256='0'.repeat(64);
  await expect(buildInventory({...f,dispositions:d})).rejects.toThrow(/drift/);
});
it('CLI is deterministic, writes incomplete accounting and exits nonzero rather than claiming completion',async()=>{
  const f=fixture({'readme.md':'A complete statement explains the product.\n'});
  const args=[new URL('../../scripts/oracle/source-units.mjs',import.meta.url).pathname,'--dir',f.dir,'--repo',f.repo,'--commit',f.commit];
  const a=spawnSync(process.execPath,args,{encoding:'utf8'}),b=spawnSync(process.execPath,args,{encoding:'utf8'});
  expect(a.status,a.stderr).toBe(2);expect(b.stdout).toBe(a.stdout);
  expect(JSON.parse(a.stdout).pendingSemanticReview.length).toBeGreaterThan(0);
});
it('retains directive-only files and code or substantive content under boilerplate headings for review',async()=>{
  const f=fixture({'client.js':'"use client";','code.md':'```js\nconst enabled = true;\n```\n',
    'guide.md':'# License\nA deployment requires two independent replicas.\n'});
  const inv=await buildInventory(f);
  expect(new Set(inv.units.map(u=>u.path))).toEqual(new Set(['client.js','code.md','guide.md']));
  expect(inv.pendingSemanticReview.length).toBe(inv.units.length);expect(inv.U).toBeNull();
});
it('reconstructs the selected source set and rejects forged completeness, subsets and stale labels',async()=>{
  const {verifyInventory,sha256Hex}=await import('../../scripts/oracle/source-units.mjs');
  const {produceQuestions}=await import('../../scripts/oracle/produce-questions.mjs');
  const {validateLabels}=await import('../../scripts/oracle/validate-labels.mjs');
  const f=fixture({'guide.md':'# Retry\nThe service retries failed requests three times before it records failure.\n\n# Queue\nThe queue retains pending work across interrupted sessions.\n'});
  const pending=await buildInventory(f), inv=await buildInventory({...f,dispositions:reviewed(pending)});
  expect(await verifyInventory(inv,f.dir)).toEqual(inv);
  const noCall=async()=>{throw new Error('host must not execute');};
  for(const changed of [{...inv,schemaVersion:undefined},{...inv,selected:inv.selected.slice(1)},
    {...inv,units:[]},{...inv,inventoryComplete:false}]){
    await expect(produceQuestions({inventory:changed,snapshotDir:f.dir,spawnImpl:noCall})).rejects.toThrow(/inventory|accounting|disposition/);
  }
  const labels={repo:inv.repo,commit:inv.commit,rulesVersion:inv.rulesVersion,
    inventoryDigest:sha256Hex(Buffer.from(JSON.stringify(inv))),labels:inv.selected.map(u=>({...u,producerError:'fixture unproduced'}))};
  const rejected=await validateLabels({labels,inventory:inv,snapshotDir:f.dir,embed:noCall});
  expect(rejected.oracleComplete).toBe(false);expect(rejected.aggregate.total).toBe(inv.selected.length);
  for(const changed of [{...labels,commit:'f'.repeat(40)},{...labels,labels:labels.labels.slice(1)},
    {...labels,labels:labels.labels.map(()=>labels.labels[0])}]){
    await expect(validateLabels({labels:changed,inventory:inv,snapshotDir:f.dir,embed:noCall})).rejects.toThrow(/labels|label/);
  }
});
it('uses disjoint heading and class-member ownership so source is not counted twice',async()=>{
  const f=fixture({'guide.md':'# Parent\nParent statement.\n## Child\nChild statement.\n',
    'class.js':'export class Record extends Base { field = 1; method(){ return this.field; } }'});
  const inv=await buildInventory(f);
  for(const file of ['guide.md','class.js']){
    const spans=inv.units.filter(u=>u.path===file).sort((a,b)=>a.startByte-b.startByte);
    expect(spans.length).toBeGreaterThan(1);
    for(let i=1;i<spans.length;i++)expect(spans[i].startByte).toBeGreaterThanOrEqual(spans[i-1].endByte);
  }
});

it('retains punctuation-only structured values and decorated TS as semantic candidates',async()=>{
  const f=fixture({'patterns.json':'["*"]','routes.yaml':'- "*"\n','decorated.ts':'@sealed\nclass A {}','bom.json':'\uFEFF{"enabled":true}'});
  const inv=await buildInventory(f);
  expect(inv.failures).toEqual([]);
  expect(new Set(inv.units.map(u=>u.path))).toEqual(new Set(['patterns.json','routes.yaml','decorated.ts','bom.json']));
  expect(inv.U).toBeNull();
  expect(inv.pendingSemanticReview).toHaveLength(inv.units.length);
});

it('parses explicit JSONC and XML dialects while preserving genuine syntax failures',async()=>{
  const f=fixture({'tsconfig.json':'{ // compiler configuration\n"compilerOptions": {"strict":true,},}\n',
    'icon.svg':'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><path d="M 0 0"/></svg>',
    'broken.json':'{"a": }'});
  const inv=await buildInventory(f);
  expect(inv.units.map(u=>u.path)).toEqual(expect.arrayContaining(['tsconfig.json','icon.svg']));
  expect(inv.failures.map(e=>e.path)).toEqual(['broken.json']);
});
it('requires exact entry dispositions to account for reviewed non-source modalities',async()=>{
  const f=fixture({'asset.unknown':'opaque textual fixture format','guide.md':'This fixture restores state.'});
  const inv=await buildInventory(f), d=reviewed(inv),entry=inv.snapshot.entries.find(e=>e.path==='asset.unknown');
  d.entries.push({kind:'entry',path:entry.path,objectSha:entry.objectSha,bytesSha256:entry.contentSha256,
    disposition:'non-source',reason:'Test-only textual asset explicitly reviewed as non-source.',reviewer:'test-fixture'});
  const complete=await buildInventory({...f,dispositions:d});
  expect(complete.inventoryComplete).toBe(true);
  const {verifyInventory}=await import('../../scripts/oracle/source-units.mjs');
  expect(await verifyInventory(complete,f.dir)).toEqual(complete);
  d.entries.at(-1).bytesSha256='f'.repeat(64);
  await expect(buildInventory({...f,dispositions:d})).rejects.toThrow(/drift/);
});

it('requires a trusted content-bound production signature before granting oracle completeness',async()=>{
  const crypto=await import('node:crypto');
  const {attestProduction}=await import('../../scripts/oracle/production-evidence.mjs');
  const {validateLabels}=await import('../../scripts/oracle/validate-labels.mjs');
  const {sha256Hex}=await import('../../scripts/oracle/source-units.mjs');
  const {qualifyOracleSource}=await import('../../scripts/oracle/qualify-source.mjs');
  const span='Each failed request is retried three times before the service records a terminal failure.';
  const f=fixture({'guide.md':'# Retry policy\nThis section defines the client retry behavior and failure reporting.\n'+span+'\nThe caller can inspect the final receipt after the operation completes.\n'});
  const pending=await buildInventory(f),inv=await buildInventory({...f,dispositions:reviewed(pending)});
  const keys=crypto.generateKeyPairSync('ed25519');
  const privateKey=keys.privateKey.export({type:'pkcs8',format:'pem'}),publicKey=keys.publicKey.export({type:'spki',format:'pem'});
  const row={...inv.selected[0],direct:'How many failed requests may the service attempt before abandoning this operation?',
    paraphrase:'What retry ceiling governs errors during a service request?',span,spanStartLine:3,spanEndLine:3,
    judge:{host:'codex',model:'fixture-model',...Object.fromEntries(['direct','paraphrase','equivalent'].map(side=>[side,{answers:'yes',reason:'Signed test fixture judgment.'}]))}};
  const labels={kind:'oracle-labels',schemaVersion:1,repo:inv.repo,commit:inv.commit,rulesVersion:inv.rulesVersion,
    inventoryDigest:sha256Hex(Buffer.from(JSON.stringify(inv))),diagnosticLegacy:false,productionComplete:true,suspended:null,
    roles:{generator:'claude',judge:'codex'},authentication:{claude:{eligible:true},codex:{eligible:true}},
    producer:{generator:{host:'claude',requestedModel:'fixture-claude'},judge:{host:'codex',requestedModel:'fixture-model'}},
    calls:[{callId:'generator-call',stage:'generator',host:'claude',requestedModel:'fixture-claude',observedModels:['fixture-claude'],status:0,timedOut:false,ok:true,error:null,hostErrors:[],requestDigest:'a'.repeat(64),transportDigest:'b'.repeat(64)},
      {callId:'judge-call',stage:'judge',host:'codex',requestedModel:'fixture-model',observedModels:['fixture-model'],status:0,timedOut:false,ok:true,error:null,hostErrors:[],requestDigest:'a'.repeat(64),transportDigest:'b'.repeat(64)}],labels:[{...row,producerCallId:'generator-call',judge:{...row.judge,callId:'judge-call'}}]};
  const embed=async texts=>texts.map(text=>text===row.direct||text===row.paraphrase?[1,0]:[0,1]);
  const check=()=>validateLabels({labels,inventory:inv,snapshotDir:f.dir,embed,trustedProductionKey:publicKey});
  expect((await check()).oracleComplete).toBe(false);
  labels.attestation=attestProduction(labels,privateKey);
  expect((await check()).oracleComplete).toBe(true);
  const partition={partition:'fixture',store:inv.repo,sourceCommit:inv.commit,rulesVersion:inv.rulesVersion,inventorySha256:labels.inventoryDigest,
    U:inv.U,selectedUnits:1,unproduced:[]};
  const normalized={partitions:new Map([['fixture',partition]]),labels:['direct','paraphrase'].map(form=>({partition:'fixture',unit:row.unitId,form,
    question:row[form],span,sourcePath:row.path,blobSha:row.blobSha,unitSha256:row.bytesSha256}))};
  const qualify=()=>qualifyOracleSource({schemaVersion:2},normalized,{evidence:{fixture:{inventory:inv,labels,snapshotDir:f.dir}},trustedProductionKey:publicKey,embed});
  expect((await qualify()).c3Eligible).toBe(true);
  normalized.labels[0].question='A forged replacement question';
  await expect(qualify()).rejects.toThrow(/differs/);
  row.judge.direct.reason='edited after signing';
  expect((await check()).oracleComplete).toBe(false);
});
