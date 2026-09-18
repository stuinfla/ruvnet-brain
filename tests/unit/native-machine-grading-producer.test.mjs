import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
import { digest } from '../../scripts/coverage-integrity.mjs';
import { transactionIdFor } from '../../scripts/release-transaction.mjs';
import { produceFromNativeHost, produceNativeMachineGrade } from '../../scripts/native-machine-grading-producer.mjs';
import { verifyIndependentReviewReceipt } from '../../scripts/independent-review-receipt.mjs';
import { nativeReviewEvidenceDigest } from '../../scripts/native-review-evidence.mjs';

const tempDirs = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const keys = crypto.generateKeyPairSync('ed25519');
const release = { repository: 'stuinfla/ruvnet-brain', package: 'ruvnet-brain', version: '4.3.21', tag: 'v4.3.21',
  candidateSha: 'a'.repeat(40), payloadId: 'b'.repeat(64), evidenceDigest: 'c'.repeat(64),
  packageIntegrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`, packageSha256: 'd'.repeat(64),
  packageAssetName: 'ruvnet-brain-4.3.21.tgz', bundleSha256: 'e'.repeat(64), bundleSignatureSha256: 'f'.repeat(64),
  bundleDigestSha256: '1'.repeat(64) };
release.transactionId = transactionIdFor(release);
const records = [{ store: 'new', oracleRecordSha256: '9'.repeat(64), relevant: true, verdict: 'PASS', evidence: ['oracle#new'], untested: [] }];
const oracle = { schemaVersion: 1, kind: 'ruvnet-brain-retrieval-oracle-semantic-review', oracleReceiptSha256: '2'.repeat(64),
  queryStoreSetSha256: digest(['new']), recordCount: 1, recordSetSha256: digest(records.map(({ store, oracleRecordSha256 }) => ({ store, oracleRecordSha256 }))), records, verdict: 'PASS', untested: [] };
const input = { subjectProducerIdentity: 'ruvnet-brain-release-builder', sourceSha: release.candidateSha, sourceTree: '3'.repeat(40),
  artifactSha256: release.packageSha256, payloadId: release.payloadId, payloadSha256: '4'.repeat(64), releaseIdentity: release,
  productContractSha256: '5'.repeat(64), rubricSha256: '6'.repeat(64), retrievalOracleReview: oracle, independent: true, verdict: 'PASS', score: 100,
  findings: [{ code: 'F-1', severity: 'info', summary: 'bound', evidence: ['source'] }], deductions: [], untested: [], reviewedAt: '2026-09-16T00:00:00.000Z',
  id: 'claude-fable-5-1', model: 'claude-fable-5-1', provider: 'firstParty', execution: { nativeHost: 'claude-code', subscriptionAuthenticated: true, invocationDigest: '7'.repeat(64), requestedModel: 'claude-fable-5-1', modelIdentityClass: 'requested-only' } };

describe('native machine grading producer', () => {
  const evidence = (host = 'claude-code') => ({ schemaVersion: 1, kind: 'ruvnet-brain-native-review-evidence', nativeHost: host, clientVersion: host === 'codex' ? 'codex-cli 0.154.0' : 'claude-code 2.1.220', requestedModel: host === 'codex' ? 'gpt-6-astra' : 'claude-fable-5-1', modelIdentityClass: 'requested-only', threadId: host === 'codex' ? 'thread-fixture' : null, sessionId: host === 'claude-code' ? 'session-fixture' : null, completionStatus: 'completed', status: 0, signal: null, startedAt: '2026-09-16T00:00:00.000Z', completedAt: '2026-09-16T00:00:01.000Z', prompt: 'review', stdout: '{"type":"turn.completed"}', stderr: '' });
  it('signs actual native structured output with authenticated provenance', async () => {
    const receipt = await produceFromNativeHost({ input, reviewer: 'claude-fable-5-1', signingKey: keys.privateKey,
      runHost: async (host, stage, payload) => ({ ok: true, value: { schemaVersion: 1, stage, artifactSha256: payload.artifactSha256, contentDigest: digest(input.findings),
        verdict: 'PASS', score: 100, findings: input.findings, deductions: [], untested: [], reviewedAt: input.reviewedAt,
        retrievalOracleReview: oracle, execution: { nativeHost: host, subscriptionAuthenticated: true, invocationDigest: nativeReviewEvidenceDigest(evidence(host)), requestedModel: host === 'codex' ? 'gpt-6-astra' : 'claude-fable-5-1', modelIdentityClass: 'requested-only', threadId: host === 'codex' ? 'thread-fixture' : null, sessionId: host === 'claude-code' ? 'session-fixture' : null } }, extra: { evidence: evidence(host), canonicalDigest: nativeReviewEvidenceDigest(evidence(host)) } }) });
    expect(receipt.execution).toMatchObject({ nativeHost: 'claude-code', subscriptionAuthenticated: true });
    expect(receipt.signature).toBeTypeOf('string');
    expect(() => verifyIndependentReviewReceipt(receipt, keys.publicKey)).not.toThrow();
  });
  it('rejects unauthenticated, unstructured, and artifact mismatched host output', async () => {
    expect(() => produceNativeMachineGrade({ input: { ...input, execution: { ...input.execution, subscriptionAuthenticated: false } }, reviewer: input.id, signingKey: keys.privateKey })).toThrow(/provenance/);
    await expect(produceFromNativeHost({ input, reviewer: input.id, signingKey: keys.privateKey,
      runHost: async () => ({ ok: true, value: 'prose' }) })).rejects.toThrow(/structured/);
    await expect(produceFromNativeHost({ input, reviewer: input.id, signingKey: keys.privateKey,
      runHost: async () => ({ ok: true, value: { schemaVersion: 1, stage: 'review', artifactSha256: '0'.repeat(64), contentDigest: digest(input.findings), verdict: 'PASS', score: 100, findings: input.findings, deductions: [], untested: [], reviewedAt: input.reviewedAt, retrievalOracleReview: oracle, execution: { nativeHost: 'claude-code', subscriptionAuthenticated: true, invocationDigest: '8'.repeat(64) } }, extra:{evidence:evidence(), canonicalDigest:nativeReviewEvidenceDigest(evidence())} }) })).rejects.toThrow(/bound/);
  });

  it('runs the CLI through hermetic auth and host subprocesses', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-grading-cli-'));
    tempDirs.push(dir);
    const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
    const fake = path.join(bin, 'claude');
    fs.writeFileSync(fake, `#!/usr/bin/env node
const fs=require('fs'), crypto=require('crypto'); const args=process.argv.slice(2); const stable=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
if(args.includes('--version')) { console.log('claude-code 2.1.220'); process.exit(0); }
if(args[0]==='auth'){ process.stdout.write(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'max'})); process.exit(0); }
let text=''; process.stdin.on('data',c=>text+=c); process.stdin.on('end',()=>{ const p=JSON.parse(text.trim().split('\\n').at(-1)); const findings=[{code:'F-CLI',severity:'info',summary:'native',evidence:['fixture']}]; const h=crypto.createHash('sha256').update(stable(findings)).digest('hex'); process.stdout.write(JSON.stringify({result:{schemaVersion:1,stage:'review',artifactSha256:p.artifactSha256,contentDigest:h,verdict:'PASS',score:100,findings,deductions:[],untested:[],reviewedAt:'2026-09-16T00:00:00.000Z',retrievalOracleReview:p.oracle},session_id:'session-fixture',is_error:false})); });`);
    fs.chmodSync(fake, 0o755);
    const inputFile = path.join(dir, 'input.json'); const outFile = path.join(dir, 'receipt.json');
    const artifactBytes = Buffer.from('hermetic release artifact'); fs.writeFileSync(path.join(dir, 'candidate.bin'), artifactBytes);
    const artifactSha = crypto.createHash('sha256').update(artifactBytes).digest('hex');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'input.json\nastra.json\nreceipt*\nbin/\n');
    spawnSync('git', ['-C', dir, 'init', '-q']); spawnSync('git', ['-C', dir, 'config', 'user.email', 'fixture@example.test']); spawnSync('git', ['-C', dir, 'config', 'user.name', 'fixture']); spawnSync('git', ['-C', dir, 'add', 'candidate.bin', '.gitignore']); spawnSync('git', ['-C', dir, 'commit', '-qm', 'candidate']);
    const sourceSha = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const sourceTree = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).stdout.trim();
    const cliInput = { ...input, artifactPath: path.join(dir, 'candidate.bin'), sourceSha, sourceTree, artifactSha256: artifactSha,
      releaseIdentity: { ...input.releaseIdentity, candidateSha: sourceSha, packageSha256: artifactSha } };
    cliInput.releaseIdentity.transactionId = transactionIdFor(cliInput.releaseIdentity);
    fs.writeFileSync(inputFile, JSON.stringify(cliInput));
    const producer = path.resolve('scripts/native-machine-grading-producer.mjs');
    const result = spawnSync(process.execPath, [producer, '--input', inputFile, '--out', outFile, '--reviewer', 'claude-fable-5-1', '--cwd', dir], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUVNET_FABLE_REVIEW_SIGNING_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), HOME: dir },
    });
    expect(result.status, result.stderr).toBe(0); const receipt = JSON.parse(fs.readFileSync(outFile, 'utf8')); expect(receipt.execution.nativeHost).toBe('claude-code');
    const sidecar = `${outFile}.native-evidence.json`; expect(JSON.parse(fs.readFileSync(sidecar, 'utf8')).sessionId).toBe('session-fixture'); expect(fs.statSync(sidecar).mode & 0o777).toBe(0o600);
    expect(() => verifyIndependentReviewReceipt(receipt, keys.publicKey)).not.toThrow();
    const duplicate = spawnSync(process.execPath, [producer, '--input', inputFile, '--out', outFile, '--reviewer', 'claude-fable-5-1', '--cwd', dir], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUVNET_FABLE_REVIEW_SIGNING_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), HOME: dir } });
    expect(duplicate.status).toBe(1); expect(duplicate.stderr).toMatch(/already exists/);
    const forged = { ...cliInput, sourceSha: 'a'.repeat(40), releaseIdentity: { ...cliInput.releaseIdentity, candidateSha: 'a'.repeat(40) } };
    forged.releaseIdentity.transactionId = transactionIdFor(forged.releaseIdentity);
    fs.writeFileSync(inputFile, JSON.stringify(forged));
    const wrongSource = spawnSync(process.execPath, [producer, '--input', inputFile, '--out', `${outFile}.wrong-source`, '--reviewer', 'claude-fable-5-1', '--cwd', dir], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUVNET_FABLE_REVIEW_SIGNING_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), HOME: dir },
    });
    expect(wrongSource.status).toBe(1); expect(wrongSource.stderr).toMatch(/source commit differs/);
    fs.writeFileSync(inputFile, JSON.stringify(cliInput));
    fs.writeFileSync(fake, fs.readFileSync(fake, 'utf8').replace('loggedIn:true', 'loggedIn:false'));
    fs.chmodSync(fake, 0o755);
    const rejected = spawnSync(process.execPath, [producer, '--input', inputFile, '--out', `${outFile}.bad`, '--reviewer', 'claude-fable-5-1', '--cwd', dir], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUVNET_FABLE_REVIEW_SIGNING_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), HOME: dir },
    });
    expect(rejected.status).toBe(1); expect(rejected.stderr).toMatch(/authentication/);
    const codex = path.join(bin, 'codex');
    fs.writeFileSync(codex, `#!/usr/bin/env node
const crypto=require('crypto'),args=process.argv.slice(2); if(args[0]==='--version'){console.log('codex-cli 0.154.0');process.exit(0)} if(args[0]==='login'){console.log('Logged in using ChatGPT');process.exit(0)} let t='';process.stdin.on('data',c=>t+=c);process.stdin.on('end',()=>{const p=JSON.parse(t.trim().split('\\n').at(-1));const findings=[{code:'F-CLI',severity:'info',summary:'native',evidence:['fixture']}];const h=crypto.createHash('sha256').update(JSON.stringify(findings,(k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(x=>[x,v[x]])):v)).digest('hex');const v={schemaVersion:1,stage:'review',artifactSha256:p.artifactSha256,contentDigest:h,verdict:'PASS',score:100,findings,deductions:[],untested:[],reviewedAt:'2026-09-16T00:00:00.000Z',retrievalOracleReview:p.oracle};console.log(JSON.stringify({type:'thread.started',thread_id:'thread-native-fixture'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(v)}}));console.log(JSON.stringify({type:'turn.completed',turn:{id:'turn-native-fixture',status:'completed'}}));});`); fs.chmodSync(codex, 0o755);
    const astraInput = { ...cliInput, id: 'gpt-6-astra', model: 'gpt-6-astra', provider: 'openai', execution: { subscriptionAuthenticated: true, invocationDigest: '1'.repeat(64), threadId: 'model-forged', requestedModel: 'gpt-6-astra', modelIdentityClass: 'requested-only' } };
    const astraFile = path.join(dir, 'astra.json'); fs.writeFileSync(astraFile, JSON.stringify(astraInput));
    const astra = spawnSync(process.execPath, [producer, '--input', astraFile, '--out', `${outFile}.astra`, '--reviewer', 'gpt-6-astra', '--cwd', dir], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUVNET_ASTRA_REVIEW_SIGNING_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), HOME: dir } });
    expect(astra.status, astra.stderr).toBe(0); const astraReceipt = JSON.parse(fs.readFileSync(`${outFile}.astra`, 'utf8')); expect(astraReceipt.execution.threadId).toBe('thread-native-fixture'); expect(astraReceipt.execution.modelIdentityClass).toBe('requested-only');
    fs.writeFileSync(codex, fs.readFileSync(codex, 'utf8').replace("console.log(JSON.stringify({type:'thread.started',thread_id:'thread-native-fixture'}));", ''));
    const noThread = spawnSync(process.execPath, [producer, '--input', astraFile, '--out', `${outFile}.no-thread`, '--reviewer', 'gpt-6-astra', '--cwd', dir], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUVNET_ASTRA_REVIEW_SIGNING_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), HOME: dir } });
    expect(noThread.status).toBe(1); expect(noThread.stderr).toMatch(/structured/);
  });
});
