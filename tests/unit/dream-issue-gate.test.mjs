import { describe, expect, it } from 'vitest';
import { assessFinding, buildIssueBody, stableFingerprint } from '../../scripts/dream-issue-gate.mjs';

const base = {
  deep: 'memory-durability', scan: 'round-trip-proof', path: 'scripts/memory.mjs', signature: 'lost-write',
  status: 'reproduced', actionable: true, unresolved: true, boundedFixUnsuccessful: true,
  sourceSha: 'a'.repeat(40), sourcePaths: ['scripts/memory.mjs'],
  reproduction: { command: 'node scripts/repro.mjs', output: 'exit 1: row absent' },
  evidence: [{ observed: 'exact row was absent', path: 'scripts/memory.mjs' }],
};

describe('Dream Cycle issue evidence gate', () => {
  it('permits only a reproduced, source-backed, unresolved finding after a failed bounded repair', () => {
    const result = assessFinding({ ...base, title: 'real defect' });
    expect(result.action).toBe('create');
    expect(result.reason).toContain('bounded-repair');
    expect(buildIssueBody(base, result)).toContain('dream-fingerprint: memory-durability|round-trip-proof|scripts/memory.mjs|lost-write');
  });

  it('routes hypotheses and findings without source reproduction to a report', () => {
    expect(assessFinding({ ...base, status: 'hypothesis' }).action).toBe('report');
    expect(assessFinding({ ...base, reproduction: undefined }).reason).toBe('missing-source-backed-reproduction');
    expect(assessFinding({ ...base, evidence: [] }).action).toBe('report');
  });

  it('deduplicates an existing open issue by the stable fingerprint', () => {
    const fingerprint = stableFingerprint(base);
    const result = assessFinding(base, { openIssues: [{ number: 235, body: `<!-- dream-fingerprint: ${fingerprint} -->` }] });
    expect(result.action).toBe('dedupe');
    expect(result.issue.number).toBe(235);
  });

  it('never permits a fixed or environment-only result to create an issue', () => {
    expect(assessFinding({ ...base, resolved: true }).action).toBe('report');
    expect(assessFinding({ ...base, skipIf: ['environment-only'] }).action).toBe('report');
  });

  it('rejects evidence with no source identity or reproduction output', () => {
    expect(assessFinding({ ...base, sourceSha: 'HEAD' }).reason).toBe('missing-source-backed-reproduction');
    expect(assessFinding({ ...base, reproduction: { command: 'node repro.mjs', output: '' } }).action).toBe('report');
  });
});
