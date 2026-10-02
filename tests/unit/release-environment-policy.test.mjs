// release-environment-policy.test.mjs — 4.3.39 review #1: single-source C3 checked only that admins
// cannot bypass and that a branch policy exists. A required reviewer re-added in GitHub's environment
// settings (it happened once before, unnoticed — ADR-0058) kept C3 green while every release waited for a
// click that never comes. The verdict now fails on it; the workflow YAML cannot show it at all.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRODUCTION_ENVIRONMENT, productionEnvironmentVerdict } from '../../scripts/release-environment-policy.mjs';

// The shape GET /repos/{o}/{r}/environments returns (as read live on 2026-09-30: admins cannot bypass,
// branch policy only).
const live = () => ({ name: PRODUCTION_ENVIRONMENT, can_admins_bypass: false,
  protection_rules: [{ id: 1, type: 'branch_policy' }] });

describe('Production environment verdict (single-source C3)', () => {
  it('passes the designed environment: branch policy, no admin bypass, no reviewer', () => {
    expect(productionEnvironmentVerdict(live())).toMatchObject({ ok: true, problems: [] });
  });

  it('fails the moment a required reviewer comes back, and names who', () => {
    const env = live();
    env.protection_rules.push({ id: 2, type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { login: 'stuinfla' } }] });
    const verdict = productionEnvironmentVerdict(env);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toEqual(['a required reviewer is back on the environment (stuinfla) — no human approves a release']);
  });

  it('still fails on admin bypass, a missing branch policy, or a missing environment', () => {
    expect(productionEnvironmentVerdict({ ...live(), can_admins_bypass: true }).ok).toBe(false);
    expect(productionEnvironmentVerdict({ ...live(), protection_rules: [] }).ok).toBe(false);
    expect(productionEnvironmentVerdict(null).ok).toBe(false);
  });

  it('C3 actually uses this verdict (a check that cannot fail protects nothing)', () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, '../../scripts/single-source-check.mjs'), 'utf8');
    const c3 = source.slice(source.indexOf("id: 'C3'"), source.indexOf("// D — one corpus"));
    expect(c3).toContain('productionEnvironmentVerdict(environment)');
  });
});
