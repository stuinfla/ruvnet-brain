import { describe, expect, it } from 'vitest';
import {
  chooseRoles,
  deliberate,
  hardProblem,
  main,
  persistDeliberationReceipt,
  runSubscriptionHost,
} from '../../scripts/dual-host-deliberation.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { digest } from '../../scripts/coverage-integrity.mjs';
import { STAGE_SCHEMAS, nativeStageJsonSchema, bindStageContent } from '../../scripts/dual-deliberation-contract.mjs';

const eligible = {
  claude: { host: 'claude-code', eligible: true, auth: 'claude.ai-subscription' },
  codex: { host: 'codex', eligible: true, auth: 'chatgpt-subscription' },
};
const validStage = (host, name, payload = {}) => {
  const content = name === 'proposal' ? { host } : name === 'critique' ? [`review-${host}`] : { host };
  return { schemaVersion: 1, stage: name, artifactSha256: 'a'.repeat(64), contentDigest: digest(content),
    ...(name === 'proposal' ? { proposal: content, plan: `${host}-plan` } : {}),
    ...(name === 'critique' ? { findings: content } : {}),
    ...(name === 'synthesis' || name === 'revise' ? { artifact: content, adr: {}, ddd: {}, qe: {} } : {}),
    ...(name === 'verify' || name === 'reverify' ? { verdict: 'accept', corrections: [], contentDigest: payload.artifact?.contentDigest ?? digest(content) } : {}) };
};

describe('hardProblem', () => {
  it.each([
    'Create an ADR for the storage migration',
    'Model the authentication bounded context and DDD aggregates',
    'Design a holistic Agentic-QE test suite for the user experience',
    'Review the security boundary before production migration',
  ])('detects consequential work: %s', (task) => {
    expect(hardProblem(task)).toBe(true);
  });

  it('does not turn an ordinary typo into a costly duel', () => {
    expect(hardProblem('fix the typo in the footer')).toBe(false);
  });
});

describe('chooseRoles', () => {
  it('is deterministic and gives both hosts the scribe role across tasks', () => {
    expect(chooseRoles('same task')).toEqual(chooseRoles('same task'));
    const scribes = new Set(Array.from({ length: 100 }, (_, i) => chooseRoles(`task-${i}`).scribe));
    expect(scribes).toEqual(new Set(['claude-code', 'codex']));
  });
});

describe('deliberate', () => {
  it('runs proposal, cross-critique, synthesis and verification through both hosts', async () => {
    const calls = [];
    const runHost = async (host, stage, payload) => {
      calls.push({ host, stage, payload });
      return { ok: true, value: validStage(host, stage, payload) };
    };

    const out = await deliberate('Design the security architecture ADR', {
      cwd: '/tmp/project',
      probes: eligible,
      runHost,
      persist: async () => true,
    });

    expect(out.status).toBe('accepted');
    expect(out.dual).toBe(true);
    expect(out.learningPersisted).toBe(true);
    expect(calls.filter((c) => c.stage === 'proposal')).toHaveLength(2);
    expect(calls.filter((c) => c.stage === 'critique')).toHaveLength(2);
    expect(calls.filter((c) => c.stage === 'synthesis')).toHaveLength(1);
    expect(calls.filter((c) => c.stage === 'verify')).toHaveLength(1);
    expect(new Set(calls.map((c) => c.host))).toEqual(new Set(['claude-code', 'codex']));
  });

  it('carries correction IDs through a resolved revision and rejects vanished resolutions', async () => {
    let revisionArtifact;
    const runHost = async (host, stage, payload) => {
      if (stage === 'critique') return { ok: true, value: { ...validStage(host, stage, payload), corrections: [{ id: 'c1', text: 'add evidence' }] } };
      if (stage === 'synthesis') return { ok: true, value: validStage(host, stage, payload) };
      if (stage === 'verify') return { ok: true, value: { ...validStage(host, stage, payload), verdict: 'changes', corrections: [{ id: 'c1', text: 'add evidence' }] } };
      if (stage === 'revise') { revisionArtifact = { host, changed: true }; return { ok: true, value: { ...validStage(host, stage, payload), artifact: revisionArtifact, contentDigest: digest(revisionArtifact), resolutions: [{ id: 'c1', status: 'resolved', reason: 'evidence added' }] } }; }
      if (stage === 'reverify') return { ok: true, value: { ...validStage(host, stage, payload), verdict: 'accept', artifactSha256: payload.artifact.artifactSha256, contentDigest: digest(payload.artifact.artifact), resolutions: payload.resolutions } };
      return { ok: true, value: validStage(host, stage, payload) };
    };
    const out = await deliberate('correction ledger', { probes: eligible, runHost });
    expect(out.status).toBe('accepted');
    expect(out.planAccepted).toBe(true);
    expect(out.verifiedOutcome).toBe(false);
  });

  it('requires verifier-only corrections to change the artifact and retain dispositions', async () => {
    for (const variant of ['unchanged', 'missing', 'duplicate', 'valid']) {
      let original;
      const runHost = async (host, stage, payload) => {
        const value = validStage(host, stage, payload);
        if (stage === 'synthesis') original = value.artifact;
        if (stage === 'verify') return {ok:true,value:{...value,verdict:'changes',corrections:[{id:'late',text:'retain executable evidence'}]}};
        if (stage === 'revise') {
          const artifact = variant === 'unchanged' ? original : {...original, evidence:'measured'};
          return {ok:true,value:{...value,artifact,contentDigest:digest(artifact)}};
        }
        if (stage === 'reverify') {
          const row={id:'late',status:'resolved',reason:'Executable evidence is retained in the revised artifact'};
          return {ok:true,value:{...value,artifactSha256:payload.artifact.artifactSha256,
            resolutions:variant==='missing'?[]:variant==='duplicate'?[row,row]:[row]}};
        }
        return {ok:true,value};
      };
      const out = await deliberate('verifier-only ledger', {probes:eligible,runHost});
      expect(out.status === 'accepted', variant).toBe(variant === 'valid');
    }
  });

  it('accepts critique corrections resolved in the first synthesis', async () => {
    const out = await deliberate('first synthesis resolution', { probes: eligible,
      runHost: async (host, stage, payload) => {
        const value = validStage(host, stage, payload);
        if (stage === 'critique') value.corrections = [{ id: 'evidence', text: 'include test evidence' }];
        if (stage === 'verify') {
          value.resolutions = [{ id: 'evidence', status: 'resolved', reason: 'The synthesis includes the requested evidence' }];
          value.findings = ['Evidence inspected'];
        }
        return { ok: true, value };
      } });
    expect(out.status).toBe('accepted');
  });

  it.each(['verify', 'reverify'].flatMap(stage => ['contentDigest','artifactSha256'].map(field=>[stage,field])))('rejects stale acceptance at %s with changed %s', async (targetStage, field) => {
    const out = await deliberate('stale subject replay', { probes: eligible,
      runHost: async (host, stage, payload) => {
        const value = validStage(host, stage, payload);
        if (stage === 'verify' && targetStage === 'reverify') {
          value.verdict = 'changes'; value.corrections = [{ id: 'e', text: 'add evidence' }];
        }
        if (stage === 'revise') { value.artifact.evidence = 'new'; value.contentDigest = digest(value.artifact); }
        if (stage === targetStage) { value[field] = 'b'.repeat(64); value.resolutions = [{ id: 'e', status: 'resolved', reason: 'done' }]; }
        return { ok: true, value };
      } });
    expect(out.status).toBe('unresolved');
    expect(out.verifiedOutcome).toBe(false);
  });

  it('returns an honestly labeled draft when one subscription is unavailable', async () => {
    const out = await deliberate('Create an ADR for the migration', {
      probes: {
        claude: { host: 'claude-code', eligible: false, auth: 'capacity-limited' },
        codex: eligible.codex,
      },
      runHost: async (host, stage, payload) => ({ ok: true, value: validStage(host, stage, payload) }),
      persist: async () => false,
    });

    expect(out.status).toBe('degraded');
    expect(out.dual).toBe(false);
    expect(out.missing).toContain('claude-code');
    expect(out.learningPersisted).toBe(false);
    expect(out).not.toHaveProperty('verification');
  });

  it('never calls a model when neither subscription is eligible', async () => {
    let called = false;
    const out = await deliberate('Create an ADR', {
      probes: {
        claude: { host: 'claude-code', eligible: false, auth: 'unknown' },
        codex: { host: 'codex', eligible: false, auth: 'unknown' },
      },
      runHost: async () => { called = true; },
    });
    expect(called).toBe(false);
    expect(out.status).toBe('unavailable');
  });

  it('does not promote host completion into an accepted quality outcome', async () => {
    const runHost = async (host, stage, payload) => {
      if (stage === 'verify') return { ok: true, value: { ...validStage(host, stage, payload), verdict: 'changes', corrections: [{ id: 'missing-oracle', text: 'missing oracle' }] } };
      if (stage === 'revise') return { ok: true, value: validStage(host, stage, payload) };
      if (stage === 'reverify') return { ok: true, value: { ...validStage(host, stage, payload), verdict: 'block', corrections: [{ id: 'still-incomplete', text: 'still incomplete' }] } };
      return { ok: true, value: validStage(host, stage, payload) };
    };
    const out = await deliberate('Build an Agentic-QE architecture', {
      probes: eligible,
      runHost,
    });
    expect(out.status).toBe('unresolved');
    expect(out.verifiedOutcome).toBe(false);
  });
});

describe('persistDeliberationReceipt', () => {
  it('returns the exact MCP memory_store request without invoking a local Ruflo process', async () => {
    const request = await persistDeliberationReceipt({
      protocol: 'dual-host-deliberation-v1',
      taskHash: 'abc123',
      hosts: ['claude-code', 'codex'],
      roles: { scribe: 'codex', verifier: 'claude-code' },
      accepted: true,
      rawPrompt: 'must not persist',
      transcript: 'must not persist',
      email: 'must-not-leak@example.com',
    }, {
      now: () => 1_785_240_000_000,
    });

    expect(request.name).toBe('memory_store');
    expect(request.tool).toBe('memory_store');
    expect(request.arguments.key).toBe('dual-deliberation-1785240000000-abc123');
    const value = JSON.parse(request.arguments.value);
    expect(value).toEqual({
      protocol: 'dual-host-deliberation-v1',
      taskHash: 'abc123',
      hosts: ['claude-code', 'codex'],
      roles: { scribe: 'codex', verifier: 'claude-code' },
      accepted: true,
      planAccepted: true,
      verifiedOutcome: false,
      recordedAt: '2026-07-28T12:00:00.000Z',
    });
    expect(request.arguments.value).not.toContain('must not persist');
    expect(request.arguments.value).not.toContain('must-not-leak');
  });

  it('accepts persistence only when the transport callback proves storage, verification, and exact key', async () => {
    const calls = [];
    const result = await persistDeliberationReceipt({ protocol: 'p', taskHash: 'abc123', hosts: [], roles: {}, accepted: true }, {
      now: () => 1_785_240_000_000,
      memoryStore: async (request) => {
        calls.push(request);
        return { stored: true, verified: true, key: request.arguments.key };
      },
    });
    expect(result).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('memory_store');
  });

  it('rejects a transport result that does not prove the exact key', async () => {
    await expect(persistDeliberationReceipt({ protocol: 'p', taskHash: 'abc123', hosts: [], roles: {}, accepted: true }, {
      memoryStore: async () => ({ stored: true, verified: true, key: 'wrong-key' }),
    })).resolves.toBe(false);
  });
});

describe('deliberate persistence boundary', () => {
  it('returns a pending MCP request when no structured persistence callback is provided', async () => {
    const out = await deliberate('Design the security architecture ADR', {
      probes: eligible,
      now: () => 1_785_240_000_000,
      runHost: async (host, stage, payload) => {
        if (stage === 'verify') return { ok: true, value: validStage(host, stage, payload) };
        return { ok: true, value: validStage(host, stage, payload) };
      },
    });
    expect(out.status).toBe('accepted');
    expect(out.learningPersisted).toBe(false);
    expect(out.learningPersistenceRequest).toMatchObject({
      tool: 'memory_store',
      name: 'memory_store',
      arguments: { namespace: 'ruvnet-brain', key: expect.stringMatching(/^dual-deliberation-1785240000000-[0-9a-f]{12}$/) },
    });
  });

  it('passes the exact request to a structured callback and requires its proof', async () => {
    let request;
    const out = await deliberate('Design the security architecture ADR', {
      probes: eligible,
      now: () => 1_785_240_000_000,
      runHost: async (host, stage, payload) => {
        if (stage === 'verify') return { ok: true, value: validStage(host, stage, payload) };
        return { ok: true, value: validStage(host, stage, payload) };
      },
      persist: async (value) => {
        request = value;
        return { stored: true, verified: true, key: value.arguments.key };
      },
    });
    expect(out.learningPersisted).toBe(true);
    expect(request).toEqual(out.learningPersistenceRequest);
  });
});

describe('runSubscriptionHost prompt transport', () => {
  it('rejects oversized prompts before invoking even the version probe', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(),'dual-budget-'));
    const sentinel = path.join(root,'invoked');
    fs.writeFileSync(path.join(root,'codex'), `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(sentinel)},'called');`, {mode:0o755});
    const prior = process.env.PATH; process.env.PATH = `${root}${path.delimiter}${prior}`;
    try {
      expect(await runSubscriptionHost('codex','proposal',{task:'x'.repeat(1_000_001)})).toEqual({ok:false,reason:'prompt-exceeds-evidence-budget'});
      expect(fs.existsSync(sentinel)).toBe(false);
    } finally { process.env.PATH = prior; fs.rmSync(root,{recursive:true,force:true}); }
  });
  it('retains complete transport when its stage content is truncated JSON', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(),'dual-json-'));
    fs.writeFileSync(path.join(root,'codex'), `#!/usr/bin/env node
if(process.argv.includes('--version')){console.log('fixture-client');process.exit(0)}
process.stdin.resume();process.stdin.on('end',()=>{
for(const row of [{type:'thread.started',thread_id:'fixture-thread'},{type:'item.completed',item:{type:'agent_message',text:'{"proposal":'}},{type:'turn.completed'}]) console.log(JSON.stringify(row));
});`,{mode:0o755});
    const prior = process.env.PATH; process.env.PATH = `${root}${path.delimiter}${prior}`;
    try {
      const result = await runSubscriptionHost('codex','proposal',{});
      expect(result.reason).toBe('invalid-native-response');
      expect(result.transport.result.stdout).toContain('turn.completed');
    } finally { process.env.PATH = prior; fs.rmSync(root,{recursive:true,force:true}); }
  });
  it.each(['claude-code', 'codex'].flatMap(host => Object.keys(STAGE_SCHEMAS).map(stage => [host, stage])))
  ('uses one canonical schema through the real %s process for %s', async (host, stage) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-schema-'));
    const capture = path.join(root, 'capture.json');
    const verifies = ['verify', 'reverify'].includes(stage);
    const value = { schemaVersion: 1, stage,
      ...(stage === 'proposal' ? { proposal: { decision: 'fixture' } } : {}),
      ...(stage === 'critique' ? { findings: [{ path: 'unread.mjs', readComplete: false }] } : {}),
      ...(['synthesis', 'revise'].includes(stage) ? { artifact: { decision: 'fixture' } } : {}),
      ...(verifies ? { artifactSha256: 'a'.repeat(64), contentDigest: 'b'.repeat(64), verdict: 'accept', corrections: [],
        resolutions: [{ id: 'c1', status: 'resolved', reason: 'fixture evidence' }] } : {}),
      ...(stage === 'review' ? { artifactSha256: 'a'.repeat(64), verdict: 'FAIL', score: 0, findings: ['unread'],
        deductions: ['coverage missing'], untested: ['runtime'], reviewedAt: '2026-09-18T00:00:00Z', retrievalOracleReview: {} } : {}),
    };
    fs.writeFileSync(path.join(root, host === 'codex' ? 'codex' : 'claude'), `#!/usr/bin/env node
if(process.argv.includes('--version')){console.log('fixture-client');process.exit(0)}
let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{
require('fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify({prompt,args:process.argv.slice(2)}));
const value=${JSON.stringify(value)};
if(${JSON.stringify(host)}==='claude-code')console.log(JSON.stringify({session_id:'fixture-session',is_error:false,subtype:'success',terminal_reason:'completed',modelUsage:{'claude-fable-5-1':{}},result:${JSON.stringify('```json\n{}\n```')},structured_output:value}));
else for(const row of [{type:'thread.started',thread_id:'fixture-thread'},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(value)}},{type:'turn.completed'}])console.log(JSON.stringify(row));
});`, { mode: 0o755 });
    const previous = process.env.PATH; process.env.PATH = `${root}${path.delimiter}${previous}`;
    try {
      const result = await runSubscriptionHost(host, stage, { task: 'schema parity' });
      expect(result.ok, result.error).toBe(true);
      const { prompt, args } = JSON.parse(fs.readFileSync(capture, 'utf8'));
      const schema = JSON.parse(prompt.split('\n').find(line => line.startsWith('Response contract: ')).slice(19));
      expect(schema).toEqual(nativeStageJsonSchema(stage));
      const omitted = verifies ? [] : stage === 'review' ? ['contentDigest', 'execution'] : ['artifactSha256', 'contentDigest'];
      expect(schema.required).toEqual(STAGE_SCHEMAS[stage].required.filter(name => !omitted.includes(name)));
      expect(Object.keys(schema.properties)).toEqual([...STAGE_SCHEMAS[stage].required, ...STAGE_SCHEMAS[stage].optional].filter(name => !omitted.includes(name)));
      if (host === 'claude-code') {
        expect(args.filter(arg => arg === '--json-schema')).toHaveLength(1);
        expect(JSON.parse(args[args.indexOf('--json-schema') + 1])).toEqual(schema);
        for (const [flag, expected] of Object.entries({ '--permission-mode': 'manual', '--permission-prompts': 'none',
          '--tools': 'Read,Grep,Glob', '--model': 'claude-fable-5-1', '--effort': 'high', '--output-format': 'json' })) {
          expect(args[args.indexOf(flag) + 1]).toBe(expected);
        }
        expect(args).toContain('--no-session-persistence');
        for (const flag of ['--safe-mode', '--restricted', '--strict-mcp-config']) expect(args).toContain(flag);
        expect(JSON.parse(args[args.indexOf('--mcp-config') + 1])).toEqual({ mcpServers: {} });
        expect(args.some(arg => /bypass|skip-permissions/.test(arg))).toBe(false);
      } else {
        expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
        expect(args).toContain('--ephemeral'); expect(args).toContain('--json');
        expect(args).toContain('--ignore-user-config');
        expect(args).toContain('project_doc_max_bytes=0');
        expect(args).toContain(`projects.${JSON.stringify(fs.realpathSync(process.cwd()))}.trust_level="untrusted"`);
        for (const feature of ['apps', 'plugins', 'hooks', 'memories']) expect(args[args.indexOf(feature) - 1]).toBe('--disable');
      }
      expect(result.value).toMatchObject(bindStageContent(stage, value));
      if (stage === 'review') expect(result.value.execution).toMatchObject({ nativeHost: host, invocationDigest: result.extra.canonicalDigest });
      if (stage === 'critique') expect(result.value.findings[0].readComplete).toBe(false);
      if (verifies) expect(schema.properties.resolutions.items.required).toEqual(['id', 'status', 'reason']);
    } finally { process.env.PATH = previous; fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('rejects unknown stages before probing and preserves fenced-only rejection', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-reject-'));
    const sentinel = path.join(root, 'invoked');
    fs.writeFileSync(path.join(root, 'claude'), `#!/usr/bin/env node
require('fs').writeFileSync(${JSON.stringify(sentinel)},'called');
if(process.argv.includes('--version')){console.log('fixture-client');process.exit(0)}
process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({session_id:'fixture',is_error:false,result:${JSON.stringify('```json\n{}\n```')}})));
`, { mode: 0o755 });
    const previous = process.env.PATH; process.env.PATH = `${root}${path.delimiter}${previous}`;
    try {
      await expect(runSubscriptionHost('claude-code', 'unknown', {})).rejects.toThrow('unknown stage');
      expect(fs.existsSync(sentinel)).toBe(false);
      const result = await runSubscriptionHost('claude-code', 'critique', {});
      expect(result.reason).toBe('invalid-native-response');
      expect(result.transport.result.outputComplete).toBe(true);
      expect(result.transport.result.stdout).toContain('```json');
    } finally { process.env.PATH = previous; fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('kills the native host process group at its deadline', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-host-timeout-'));
    const pidFile = path.join(root, 'child.pid');
    const bin = path.join(root, 'codex');
    fs.writeFileSync(bin, `#!/bin/sh
if [ "$1" = "--version" ]; then echo fixture-client; exit 0; fi
exec "${process.execPath}" "${path.join(root, 'fixture.mjs')}"
`);
    fs.writeFileSync(path.join(root, 'fixture.mjs'), `
import {spawn} from 'node:child_process'; import fs from 'node:fs';
const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000);
`);
    fs.chmodSync(bin,0o755);
    const prior = process.env.PATH; process.env.PATH = `${root}${path.delimiter}${prior}`;
    try {
      const result = await runSubscriptionHost('codex','proposal',{task:'deadline'}, { timeoutMs:1000 });
      expect(result.ok).toBe(false); expect(result.error).toMatch(/timed out/);
      const pid=Number(fs.readFileSync(pidFile,'utf8'));
      // Reaping of a killed grandchild can lag its parent's close event briefly.
      for(let i=0;i<50;i++){try{process.kill(pid,0);}catch{break;} await new Promise(resolve=>setTimeout(resolve,20));}
      expect(()=>process.kill(pid,0)).toThrow();
    } finally {process.env.PATH=prior;fs.rmSync(root,{recursive:true,force:true});}
  });

  it('sends prompts over stdin, including prompts larger than 256 KiB, while retaining host flags', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-host-stdin-'));
    const bin = path.join(root, 'codex');
    fs.writeFileSync(bin, `#!/usr/bin/env node
if(process.argv.includes('--version')){console.log('fixture-client');process.exit(0)}
let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{
 console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-thread'}));
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({schemaVersion:1,stage:'proposal',proposal:{length:data.length,argv:process.argv.slice(2)}})}}));
 console.log(JSON.stringify({type:'turn.completed'}));
});`);
    fs.chmodSync(bin, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${root}${path.delimiter}${previousPath}`;
    try {
      const result = await runSubscriptionHost('codex', 'proposal', { task: 'x'.repeat(300 * 1024) }, { reasoningEffort: 'high' });
      expect(result.ok).toBe(true);
      expect(result.value.proposal.length).toBeGreaterThan(256 * 1024);
      expect(result.value.proposal.argv).toContain('--json');
      expect(result.value.proposal.argv).toContain('gpt-6-astra');
      expect(result.value.proposal.argv).toContain('model_reasoning_effort="high"');
      expect(result.value.proposal.argv).not.toContain('x'.repeat(300 * 1024));
    } finally {
      process.env.PATH = previousPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('native completion on every Dual stage', () => {
  it.each(['proposal', 'critique', 'synthesis', 'revise', 'verify', 'reverify', 'review'])('rejects incomplete %s transport before admission', async stage => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-terminal-'));
    fs.writeFileSync(path.join(root, 'codex'), `#!/usr/bin/env node
if(process.argv.includes('--version')){console.log('fixture-client');process.exit(0)}
process.stdin.resume();process.stdin.on('end',()=>{
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-thread'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{}'}}));
});`, { mode:0o755 });
    const previous = process.env.PATH; process.env.PATH = `${root}${path.delimiter}${previous}`;
    try {
      const result = await runSubscriptionHost('codex', stage, {});
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/turn.completed/);
      expect(result.transport.result.stdout).toContain('thread.started');
    } finally { process.env.PATH = previous; fs.rmSync(root, { recursive:true, force:true }); }
  });
});

describe('command entrypoint', () => {
  it('prints the deliberation result and returns a nonzero code unless both hosts accept', async () => {
    let output = '';
    const code = await main(['Create an ADR'], {
      deliberateFn: async () => ({ status: 'degraded', dual: false }),
      stdout: { write: (value) => { output += value; } },
      stderr: { write: () => {} },
    });
    expect(code).toBe(2);
    expect(JSON.parse(output)).toEqual({ status: 'degraded', dual: false });
  });

  it('refuses an empty task without invoking either host', async () => {
    let invoked = false;
    let error = '';
    const code = await main([], {
      deliberateFn: async () => { invoked = true; },
      stdout: { write: () => {} },
      stderr: { write: (value) => { error += value; } },
    });
    expect(code).toBe(64);
    expect(invoked).toBe(false);
    expect(error).toContain('Usage:');
  });
});
