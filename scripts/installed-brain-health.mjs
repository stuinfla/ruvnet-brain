// ADR-089: describe installed identities without confusing a validator pin with search-engine proof.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readInstalledRuntime, isCorpusReleaseTag } from '../kb/corpus-release-identity.mjs';
import { cmpVersion } from './stack-sync.mjs';

const SEARCH_FILES = ['forge-mcp-all.mjs', 'forge-ask-all.mjs', 'forge-rerank.mjs', 'card-lane.mjs'];
const version = value => typeof value === 'string' && /^v?\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value)
  ? value.replace(/^v/, '') : null;

export function inspectInstalledBrain(kbDir, packageVersion) {
  const result = { healthy: false, packageVersion, searchVersion: null, corpusTag: null,
    validatorVersion: null, searchFiles: {}, issues: [] };
  let source;
  try { source = JSON.parse(fs.readFileSync(path.join(kbDir, 'SOURCE.json'), 'utf8')); }
  catch { result.issues.push('SOURCE.json is missing or unreadable'); }
  result.searchVersion = version(source?.brainVersion) || version(source?.releaseTag);
  result.corpusTag = isCorpusReleaseTag(source?.corpusReleaseTag) ? source.corpusReleaseTag : null;
  if (!result.searchVersion) result.issues.push('the search engine version is unverified');
  if (version(source?.brainVersion) && version(source?.releaseTag)
    && version(source.brainVersion) !== version(source.releaseTag)) {
    result.issues.push('SOURCE.json runtime version and release tag disagree');
  }
  const pin = readInstalledRuntime(kbDir);
  result.validatorVersion = pin.brainVersion;
  if (!pin.ok) result.issues.push(pin.reason);
  if (pin.ok && result.searchVersion && version(pin.brainVersion) !== result.searchVersion) {
    result.issues.push(`validator runtime ${pin.brainVersion} and search engine ${result.searchVersion} differ`);
  }
  const expected = version(packageVersion);
  if (expected && result.searchVersion && cmpVersion(result.searchVersion, expected) < 0) {
    result.issues.push(`search engine ${result.searchVersion} is behind package ${packageVersion}`);
  }
  for (const file of SEARCH_FILES) {
    try {
      const bytes = fs.readFileSync(path.join(kbDir, file));
      result.searchFiles[file] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      if (!bytes.length) result.issues.push(`search executable ${file} is empty`);
    } catch { result.issues.push(`search executable ${file} is missing`); }
  }
  // The installed archive manifest lets doctor detect code drift even if SOURCE's version stayed
  // unchanged. This is a consistency check, not independent authentication of a local manifest.
  try {
    const archive = JSON.parse(fs.readFileSync(path.join(kbDir, 'ARCHIVE-MANIFEST.json'), 'utf8'));
    if (archive.kind !== 'ruvnet-brain-archive-manifest' || !Array.isArray(archive.files)) {
      throw new Error('invalid archive manifest shape');
    }
    if (version(archive.version) !== result.searchVersion) {
      result.issues.push('archive manifest and search engine versions differ');
    }
    for (const file of SEARCH_FILES) {
      const rows = archive.files.filter(row => row?.path === file);
      const actual = result.searchFiles[file];
      if (rows.length !== 1 || !/^[a-f0-9]{64}$/.test(rows[0]?.sha256 || '')
        || !Number.isSafeInteger(rows[0]?.bytes) || rows[0].bytes <= 0) {
        result.issues.push(`archive manifest has no unique valid identity for ${file}`);
      } else if (actual && (actual.sha256 !== rows[0].sha256 || actual.bytes !== rows[0].bytes)) {
        result.issues.push(`search executable ${file} differs from the installed archive manifest`);
      }
    }
  } catch (error) {
    result.issues.push(`installed archive manifest is missing or unreadable: ${error.message}`);
  }
  // These hashes and the local manifest are NOT independent release approval receipts.
  result.healthy = result.issues.length === 0;
  return result;
}

export function classifySmokeEvidence(verification, answer) {
  if (!verification?.grounded) return { usable: false, reason: verification?.reason || 'citation-not-verified' };
  const weak = /EVIDENCE:\s*(?:INSUFFICIENT_EVIDENCE|THIN)\b/i.test(answer);
  if (weak) return { usable: false, reason: 'retrieval-evidence-insufficient' };
  if (/BUILT\/SHIPPED CLAIM:\s*NOT PROVEN/i.test(answer)) {
    return { usable: false, reason: 'required-implementation-unproven' };
  }
  return { usable: true, reason: null };
}
