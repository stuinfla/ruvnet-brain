import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  auditCapabilityClaims,
  buildCapabilityInventoryReceipt,
  validateCapabilityInventoryReceipt,
} from '../../plugin/scripts/capability-inventory-receipt.mjs';

const roots = [];
const makeRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-inventory-'));
  roots.push(root);
  return root;
};
const writeSkill = (root, relative, name) => {
  const file = path.join(root, relative, 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: test fixture\n---\n\n# ${name}\n`);
  return file;
};

afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

describe('CapabilityInventoryReceipt', () => {
  it('seals the complete installed skill inventory with exact source bytes', () => {
    const root = makeRoot();
    writeSkill(root, 'ruflo/ruflo-adr/0.4.1/skills/adr-verify', 'adr-verify');
    writeSkill(root, 'ruflo/ruflo-core/0.2.6/skills/ruflo-status', 'ruflo-status');

    const receipt = buildCapabilityInventoryReceipt({ host: 'codex', roots: [root], now: '2026-08-22T12:00:00.000Z' });

    expect(receipt.completeness).toBe('complete');
    expect(receipt.entries.map(({ ref }) => ref)).toEqual([
      'ruflo-adr:adr-verify',
      'ruflo-core:ruflo-status',
    ]);
    expect(receipt.entries.every(({ sha256 }) => /^[a-f0-9]{64}$/.test(sha256))).toBe(true);
    expect(validateCapabilityInventoryReceipt(receipt)).toBe(receipt);
  });

  it('marks the receipt unknown when one discovered skill cannot identify itself', () => {
    const root = makeRoot();
    const file = path.join(root, 'ruflo/ruflo-adr/0.4.1/skills/adr-verify/SKILL.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# missing front matter name\n');

    const receipt = buildCapabilityInventoryReceipt({ host: 'claude', roots: [root] });

    expect(receipt.completeness).toBe('unknown');
    expect(receipt.errors).toEqual([expect.stringContaining('SKILL.md has no parseable name')]);
  });

  it('rejects any receipt whose inventory bytes are changed after sealing', () => {
    const root = makeRoot();
    writeSkill(root, 'ruflo/ruflo-adr/0.4.1/skills/adr-verify', 'adr-verify');
    const receipt = buildCapabilityInventoryReceipt({ host: 'codex', roots: [root] });
    const changed = structuredClone(receipt);
    changed.entries[0].ref = 'ruflo-adr:adr-create';
    expect(() => validateCapabilityInventoryReceipt(changed)).toThrow(/digest/);
  });
});

describe('RuvNet installation-claim audit', () => {
  const inventory = () => {
    const root = makeRoot();
    writeSkill(root, 'ruflo/ruflo-adr/0.4.1/skills/adr-verify', 'adr-verify');
    return buildCapabilityInventoryReceipt({ host: 'codex', roots: [root] });
  };

  it('does not turn cached skill bytes into installed or registered truth', () => {
    for (const statement of ['Ruflo ADR Verify is installed.', 'Ruflo ADR Verify is not installed.', "Ruflo ADR Verify isn't installed.", 'Ruflo ADR Verify is registered.', 'Ruflo ADR Create is installed.', 'Ruflo ADR Create is not installed.']) {
      const result = auditCapabilityClaims(statement, inventory());
      expect(result.verdict).toBe('UNKNOWN');
      expect(result.contradictions).toEqual([]);
      expect(result.unresolved).toHaveLength(1);
    }
  });
  it('admits only the enumerated skill-source predicate, not complete host absence', () => {
    const receipt = inventory();
    expect(receipt.scope).toBe('enumerated-skill-source-files');
    expect(receipt.predicates).toMatchObject({ skillSourceFiles: 'complete', cliInstallation: 'unknown', mcpRegistration: 'unknown', reachability: 'unknown' });
    expect(auditCapabilityClaims('Ruflo ADR Verify skill source is present.', receipt).verdict).toBe('PASS');
    expect(auditCapabilityClaims('Ruflo ADR Verify skill source is not present.', receipt).verdict).toBe('FAIL');
    expect(auditCapabilityClaims('Ruflo ADR Create skill source is not present.', receipt).verdict).toBe('UNKNOWN');
  });

  it('rejects a rehashed skill inventory that tries to promote cache bytes into reachability', () => {
    const receipt = inventory();
    receipt.predicates.reachability = 'complete';
    const { inventoryDigest, ...unsigned } = receipt;
    receipt.inventoryDigest = crypto.createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
    expect(() => validateCapabilityInventoryReceipt(receipt)).toThrow(/predicates exceed/);
  });

  it('does not reinterpret quoted history, code, or a hypothetical as the assistant claim', () => {
    const receipt = inventory();
    for (const message of [
      'The earlier claim "Ruflo ADR Verify is not installed" was false.',
      'The prior output said `Ruflo ADR Verify is not installed`.',
      'If Ruflo ADR Verify is not installed, verify the live inventory first.',
    ]) expect(auditCapabilityClaims(message, receipt)).toMatchObject({ verdict: 'PASS', claims: [] });
  });
});
