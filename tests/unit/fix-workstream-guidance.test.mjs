import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BRAIN = fs.readFileSync(path.join(ROOT, 'plugin/skills/ruvnet-brain/SKILL.md'), 'utf8');
const RELEASE = fs.readFileSync(path.join(ROOT, 'plugin/skills/release-proof/SKILL.md'), 'utf8');
const RELEASE_GATE = fs.readFileSync(
  path.join(ROOT, 'plugin/skills/release-proof/scripts/release-proof.mjs'),
  'utf8',
);
const ADR = fs.readFileSync(path.join(ROOT, 'docs/adr/0050-issue-pipeline-cannot-silence-itself.md'), 'utf8');

describe('non-trivial fix delivery rail', () => {
  it('requires one isolated worktree per writing lane and preserves dirty recovery evidence', () => {
    expect(BRAIN).toMatch(/every non-trivial fix[\s\S]*one dedicated git worktree/i);
    expect(BRAIN).toMatch(/never let two writers share a worktree/i);
    expect(BRAIN).toMatch(/preserve any dirty or failed worktree as recovery evidence/i);
  });

  it('requires focused failure-path proof before a single clean integration owner commits', () => {
    expect(BRAIN).toMatch(/focused tests and failure-path mutant/i);
    expect(BRAIN).toMatch(/one clean integration owner/i);
    expect(BRAIN).toMatch(/one reviewable commit per fix/i);
    expect(BRAIN).toMatch(/dirty shared checkout is never a release candidate/i);
  });

  it('connects promotion language to immutable candidate and publication seals', () => {
    expect(BRAIN).toMatch(/release-proof[\s\S]*immutable packed artifact/i);
    expect(BRAIN).toMatch(/only the protected release workflow may publish/i);
    expect(BRAIN).toMatch(/only the post-publication seal permits `shipped` or `verified`/i);
    expect(RELEASE).toMatch(/two-seal transaction/i);
    expect(RELEASE).toMatch(/clean immutable lineage/i);
    expect(RELEASE_GATE).toMatch(/release candidates must come from a clean worktree/i);
  });

  it('keeps the accepted living plan aligned with the enforced Brain behavior', () => {
    expect(ADR).toMatch(/status:\s*Accepted/i);
    expect(ADR).toMatch(/updated:\s*2026-08-01/i);
    expect(ADR).toMatch(/plugin\/skills\/ruvnet-brain\/SKILL\.md/);
    expect(ADR).toMatch(/tests\/unit\/fix-workstream-guidance\.test\.mjs/);
  });
});
