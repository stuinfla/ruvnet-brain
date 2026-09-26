import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nativeStageJsonSchema, validateNativeStageValue } from '../../scripts/dual-deliberation-contract.mjs';
import { runSubscriptionHost } from '../../scripts/dual-host-deliberation.mjs';

const critique = { schemaVersion: 1, stage: 'critique', findings: ['Evidence missing'] };
const verify = { schemaVersion: 1, stage: 'verify', artifactSha256: 'a'.repeat(64), contentDigest: 'b'.repeat(64), verdict: 'changes' };
const invalid = [
  ['empty finding', { ...critique, findings: [''] }],
  ['blank finding', { ...critique, findings: ['  '] }],
  ['array finding', { ...critique, findings: [[1]] }],
  ['numeric finding', { ...critique, findings: [1] }],
  ['empty object finding', { ...critique, findings: [{}] }],
  ['forged identity', { ...critique, artifactSha256: 'a'.repeat(64) }],
  ['forged content', { ...critique, contentDigest: 'a'.repeat(64) }],
  ['numeric correction id', { ...verify, corrections: [{ id: 1, text: 'evidence' }] }],
  ['invalid correction id', { ...verify, corrections: [{ id: 'missing evidence', text: 'evidence' }] }],
  ['unknown correction field', { ...verify, corrections: [{ id: 'c1', text: 'evidence', accepted: true }] }],
  ['blank correction', { ...verify, corrections: [{ id: 'c1', text: ' ' }] }],
  ['empty proposal', { schemaVersion: 1, stage: 'proposal', proposal: {} }],
  ['wrong optional artifact type', { schemaVersion: 1, stage: 'proposal', proposal: { planned: true }, artifact: 2 }],
  ['invalid revision resolutions', { schemaVersion: 1, stage: 'revise', artifact: {}, resolutions: [{ id: 'c1', status: 'resolved', reason: '' }] }],
  ['forged review execution', { schemaVersion: 1, stage: 'review', execution: { approved: true } }],
];

describe('native stage admission', () => {
  it.each(invalid)('rejects %s before it can enter the trace', (_label, value) => {
    expect(() => validateNativeStageValue(value.stage, value)).toThrow();
  });
  it('requests explicit constraints independently of schema generation', () => {
    for (const stage of ['proposal', 'critique', 'synthesis', 'revise', 'verify', 'reverify', 'review']) {
      const schema = nativeStageJsonSchema(stage);
      expect(schema.additionalProperties).toBe(false);
      expect(schema.properties.schemaVersion).toEqual({ const: 1 });
      expect(schema.properties.stage).toEqual({ const: stage });
      if (stage === 'review') expect(schema.properties.verdict.enum).toEqual(['PASS', 'FAIL']);
      if (['verify', 'reverify'].includes(stage)) {
        expect(schema.properties.verdict.enum).toEqual(['accept', 'changes', 'block']);
        for (const key of ['artifactSha256', 'contentDigest']) expect(schema.properties[key].pattern).toBe('^[a-f0-9]{64}$');
      }
      if (schema.properties.corrections) {
        expect(schema.properties.corrections.items.additionalProperties).toBe(false);
        expect(schema.properties.corrections.items.properties.id).toEqual({ type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' });
        expect(schema.properties.corrections.items.properties.text.pattern).toBe('\\S');
      }
    }
    expect(nativeStageJsonSchema('proposal').properties.proposal.minProperties).toBe(1);
    expect(nativeStageJsonSchema('critique').properties.findings).toEqual({ type: 'array', minItems: 1,
      items: { anyOf: [{ type: 'string', pattern: '\\S' }, { type: 'object', minProperties: 1 }] } });
  });
  it.each(['claude-code', 'codex'].flatMap(host => invalid.map(([label, value]) => [host, label, value])))
  ('rejects %s %s through a subprocess fixture', async (host, label, value) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-raw-admission-'));
    fs.writeFileSync(path.join(root, host === 'codex' ? 'codex' : 'claude'), `#!/usr/bin/env node
if(process.argv.includes('--version')){console.log('fixture-client');process.exit(0)}
let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{
const value=JSON.parse(prompt.trim().split('\\n').at(-1)).fixture;
if(${JSON.stringify(host)}==='claude-code')console.log(JSON.stringify({session_id:'fixture',is_error:false,structured_output:value}));
else for(const row of [{type:'thread.started',thread_id:'fixture'},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(value)}},{type:'turn.completed'}])console.log(JSON.stringify(row));
});`, { mode: 0o755 });
    const previous = process.env.PATH; process.env.PATH = `${root}${path.delimiter}${previous}`;
    try {
      const result = await runSubscriptionHost(host, value.stage, { fixture: value });
      expect(result.reason, label).toBe('invalid-native-response');
      expect(result.transport.result.outputComplete, label).toBe(true);
    } finally { process.env.PATH = previous; fs.rmSync(root, { recursive: true, force: true }); }
  });
});
