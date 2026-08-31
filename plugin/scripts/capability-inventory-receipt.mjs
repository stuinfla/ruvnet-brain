#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CAPABILITY_INVENTORY_SCHEMA_VERSION = 1;
const SHA256 = /^[a-f0-9]{64}$/;
const RUVNET_TERM = /\b(?:ruvnet|ruflo|ruvector|agentdb|rulake|ruview|agentic(?:-flow|-qe|ow)?|rvf|qudag|safla)\b/i;
const CLAIM_PATTERN = /([A-Za-z0-9@._:/+-]+(?:\s+[A-Za-z0-9@._:/+-]+){0,7})\s+((?:is|are)\s+not|isn't|aren't|is|are)\s+(?:currently\s+)?(installed|registered|present)\b/gi;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const digest = (value) => sha256(JSON.stringify(value));
const unique = (values) => [...new Set(values.filter(Boolean))];
const normalizeTokens = (value) => unique(String(value || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

function defaultRoots({ home, host }) {
  const codexHome = process.env.CODEX_HOME || path.join(home, '.codex');
  const hostRoots = host === 'codex'
    ? [path.join(codexHome, 'plugins', 'cache', 'ruflo'), path.join(codexHome, 'plugins', 'cache', 'ruvnet-brain'), path.join(codexHome, 'skills')]
    : [path.join(home, '.claude', 'plugins', 'cache', 'ruflo'), path.join(home, '.claude', 'plugins', 'cache', 'ruvnet-brain'), path.join(home, '.claude', 'skills')];
  return unique([...hostRoots, path.join(home, '.agents', 'skills'), process.env.CLAUDE_PLUGIN_ROOT]);
}

function parseSkillName(bytes) {
  const frontMatter = /^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/.exec(bytes)?.[1] || '';
  const raw = /^name:\s*(.+?)\s*$/m.exec(frontMatter)?.[1] || '';
  return raw.replace(/^['"]|['"]$/g, '').trim();
}

function skillRef(relative, name) {
  const parts = relative.split(/[\\/]/).filter(Boolean);
  const skillIndex = parts.lastIndexOf('skills');
  if (skillIndex <= 0) return name;
  const before = parts[skillIndex - 1];
  const plugin = /^v?\d+(?:\.\d+){1,3}(?:[-+].*)?$/.test(before)
    ? parts[skillIndex - 2]
    : before;
  return plugin && plugin !== name ? `${plugin}:${name}` : name;
}

function walkSkillFiles(root, errors, { maxEntries = 20_000 } = {}) {
  const files = [];
  const pending = [root];
  const visited = new Set();
  let entries = 0;
  while (pending.length) {
    const current = pending.pop();
    let real;
    try { real = fs.realpathSync(current); } catch (error) {
      errors.push(`${current}: ${error.code || error.message}`);
      continue;
    }
    if (visited.has(real)) continue;
    visited.add(real);
    let children;
    try { children = fs.readdirSync(real, { withFileTypes: true }); } catch (error) {
      errors.push(`${current}: ${error.code || error.message}`);
      continue;
    }
    for (const child of children) {
      entries += 1;
      if (entries > maxEntries) {
        errors.push(`${root}: inventory exceeded ${maxEntries} filesystem entries`);
        return files;
      }
      const file = path.join(real, child.name);
      if (child.isDirectory() || child.isSymbolicLink()) pending.push(file);
      else if (child.isFile() && child.name === 'SKILL.md') files.push(file);
    }
  }
  return files;
}

export function buildCapabilityInventoryReceipt({
  host = process.env.RUVNET_HOOK_HOST || 'claude',
  home = process.env.HOME || process.env.USERPROFILE || os.homedir(),
  roots = process.env.RUVNET_CAPABILITY_ROOTS
    ? process.env.RUVNET_CAPABILITY_ROOTS.split(path.delimiter).filter(Boolean)
    : defaultRoots({ home, host }),
  now = new Date().toISOString(),
} = {}) {
  if (!['claude', 'codex'].includes(host)) throw new Error(`unsupported capability inventory host: ${host}`);
  const errors = [];
  const observedRoots = [];
  const entries = [];
  for (const unresolved of unique(roots.map((root) => path.resolve(root)))) {
    let stat;
    try { stat = fs.statSync(unresolved); } catch (error) {
      if (error?.code === 'ENOENT') { observedRoots.push({ path: unresolved, present: false }); continue; }
      errors.push(`${unresolved}: ${error.code || error.message}`);
      observedRoots.push({ path: unresolved, present: true, readable: false });
      continue;
    }
    if (!stat.isDirectory()) {
      errors.push(`${unresolved}: capability root is not a directory`);
      observedRoots.push({ path: unresolved, present: true, readable: false });
      continue;
    }
    observedRoots.push({ path: unresolved, present: true, readable: true });
    for (const file of walkSkillFiles(unresolved, errors)) {
      let bytes;
      try { bytes = fs.readFileSync(file); } catch (error) {
        errors.push(`${file}: ${error.code || error.message}`);
        continue;
      }
      const name = parseSkillName(bytes.toString('utf8'));
      if (!name) {
        errors.push(`${file}: SKILL.md has no parseable name`);
        continue;
      }
      const relative = path.relative(unresolved, file).split(path.sep).join('/');
      entries.push({
        type: 'skill',
        name,
        ref: skillRef(relative, name),
        sourcePath: file,
        sha256: sha256(bytes),
      });
    }
  }
  entries.sort((a, b) => a.ref.localeCompare(b.ref) || a.sourcePath.localeCompare(b.sourcePath));
  const deduplicated = entries.filter((entry, index) => index === 0
    || entry.ref !== entries[index - 1].ref
    || entry.sha256 !== entries[index - 1].sha256);
  const unsigned = {
    schemaVersion: CAPABILITY_INVENTORY_SCHEMA_VERSION,
    kind: 'ruvnet-brain-capability-inventory',
    host,
    observedAt: now,
    completeness: errors.length ? 'unknown' : 'complete',
    roots: observedRoots,
    entries: deduplicated,
    errors,
  };
  return { ...unsigned, inventoryDigest: digest(unsigned) };
}

export function validateCapabilityInventoryReceipt(receipt) {
  const { inventoryDigest, ...unsigned } = receipt || {};
  if (receipt?.schemaVersion !== CAPABILITY_INVENTORY_SCHEMA_VERSION
    || receipt?.kind !== 'ruvnet-brain-capability-inventory'
    || !['claude', 'codex'].includes(receipt?.host)
    || !['complete', 'unknown'].includes(receipt?.completeness)
    || !Array.isArray(receipt?.roots)
    || !Array.isArray(receipt?.entries)
    || !Array.isArray(receipt?.errors)
    || !SHA256.test(String(inventoryDigest || ''))
    || digest(unsigned) !== inventoryDigest) {
    throw new Error('capability inventory receipt digest or schema is invalid');
  }
  if (receipt.entries.some((entry) => entry?.type !== 'skill' || !entry.name || !entry.ref
    || !path.isAbsolute(entry.sourcePath || '') || !SHA256.test(String(entry.sha256 || '')))) {
    throw new Error('capability inventory receipt contains an invalid entry');
  }
  return receipt;
}

function extractInstallationClaims(message) {
  const claims = [];
  const prose = String(message || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/"[^"\n]*"|'[^'\n]*'/g, ' ')
    .replace(/^\s*>.*$/gm, ' ');
  for (const match of prose.matchAll(CLAIM_PATTERN)) {
    const prefix = prose.slice(Math.max(0, match.index - 16), match.index);
    if (/\b(?:if|unless|whether)\s*$/i.test(prefix)) continue;
    const words = match[1].trim().split(/\s+/);
    const firstRuv = words.findIndex((word) => RUVNET_TERM.test(word));
    if (firstRuv < 0) continue;
    if (words.slice(0, firstRuv).some((word) => /^(?:if|unless|whether)$/i.test(word))) continue;
    const subject = words.slice(firstRuv).join(' ');
    claims.push({
      text: match[0],
      subject,
      tokens: normalizeTokens(subject),
      polarity: /\bnot\b|n't/i.test(match[2]) ? 'absent' : 'present',
      predicate: match[3].toLowerCase(),
    });
  }
  return claims;
}

function matchEntry(claim, entries) {
  let best = null;
  for (const entry of entries) {
    const tokens = normalizeTokens(`${entry.ref} ${entry.name}`);
    const matched = claim.tokens.length === 1
      ? tokens.includes(claim.tokens[0])
      : tokens.every((token) => claim.tokens.includes(token));
    if (!matched) continue;
    if (!best || tokens.length > best.tokens.length) best = { entry, tokens };
  }
  return best?.entry || null;
}

export function auditCapabilityClaims(message, receipt) {
  validateCapabilityInventoryReceipt(receipt);
  const claims = extractInstallationClaims(message);
  const contradictions = [];
  const unresolved = [];
  for (const claim of claims) {
    const matched = matchEntry(claim, receipt.entries);
    if (claim.polarity === 'absent' && matched) {
      contradictions.push({ ...claim, matchedRef: matched.ref, sourcePath: matched.sourcePath,
        reason: 'absence claim contradicts installed source bytes' });
    } else if (claim.polarity === 'present' && !matched && receipt.completeness === 'complete') {
      contradictions.push({ ...claim, matchedRef: null,
        reason: 'presence claim has no matching entry in the complete inventory' });
    } else if (!matched && receipt.completeness !== 'complete') {
      unresolved.push({ ...claim, reason: 'capability inventory is incomplete' });
    }
  }
  return {
    schemaVersion: 1,
    kind: 'ruvnet-brain-capability-claim-audit',
    inventoryDigest: receipt.inventoryDigest,
    host: receipt.host,
    claims,
    contradictions,
    unresolved,
    verdict: contradictions.length ? 'FAIL' : unresolved.length ? 'UNKNOWN' : 'PASS',
  };
}
