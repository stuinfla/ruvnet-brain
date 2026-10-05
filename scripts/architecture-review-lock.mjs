#!/usr/bin/env node
// A release adapter over doc-currency, not a second review engine.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, evaluateDoc, blockingFindings } from './doc-currency.mjs';

export const GOVERNING_ADR = 'docs/adr/0103-routing-architecture-review-lock.md';

export function evaluateArchitectureReview(root = REPO_ROOT) {
  try {
    const doc = evaluateDoc(root, GOVERNING_ADR);
    const findings = blockingFindings([doc], { strict: true });
    const block = (code, message) => findings.push({ file: GOVERNING_ADR, level: 'block', code, message });
    if (doc.id !== 'ADR-103' || doc.status !== 'Accepted') {
      block('architecture-decision-not-accepted', 'The finite governing ADR-103 must be Accepted.');
    }
    if (!doc.governsDeclared.length || doc.governsDeclared.some((entry) => /[*?\[\]{}]/.test(entry))
      || !doc.governed?.length || doc.governed.some((entry) => !entry.resolved)) {
      block('architecture-scope-incomplete', 'The governing set must name existing tracked files explicitly, without directories or globs.');
    }
    if (doc.review?.current !== true) {
      block('architecture-review-not-current', 'Update the architecture/test mapping and record a source-bound review of the final governed bytes before qualification.');
    }
    return { schemaVersion: 1, pass: findings.length === 0, file: GOVERNING_ADR,
      review: doc.review ?? null, findings };
  } catch (error) {
    return { schemaVersion: 1, pass: false, file: GOVERNING_ADR, review: null,
      findings: [{ file: GOVERNING_ADR, level: 'block', code: 'architecture-review-unreadable', message: error.message }] };
  }
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length && (argv.length !== 2 || argv[0] !== '--root')) {
    console.error('Usage: node scripts/architecture-review-lock.mjs [--root PATH]');
    return 2;
  }
  const result = evaluateArchitectureReview(argv.length ? path.resolve(argv[1]) : REPO_ROOT);
  console.log(JSON.stringify(result, null, 2));
  return result.pass ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
