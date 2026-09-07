import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(process.env.RUVNET_RELEASE_CONTRACT_ROOT || path.resolve(import.meta.dirname, '../..'));
const workflowDir = path.join(ROOT, '.github/workflows');
const read = (file) => fs.readFileSync(path.join(workflowDir, file), 'utf8');

describe('release review authority', () => {
  it('does not accept a caller-supplied review bundle in any workflow', () => {
    const offenders = fs.readdirSync(workflowDir)
      .filter((file) => file.endsWith('.yml'))
      .filter((file) => /signed_review_bundle_b64|REVIEW_BUNDLE:\s*\$\{\{\s*inputs\./.test(read(file)));
    expect(offenders).toEqual([]);
  });

  it('has no separately dispatched or cross-run-polled review authority', () => {
    const reviewPath = path.join(workflowDir, 'product-integrity-review.yml');
    if (!fs.existsSync(reviewPath)) return;
    const source = fs.readFileSync(reviewPath, 'utf8');
    expect(source).not.toMatch(/\n\s{2}workflow_dispatch:/);
    expect(source).not.toMatch(/\n\s{2}workflow_run:/);
    expect(source).not.toMatch(/\bgh run (?:list|view|watch)\b|^\s+run-id:/m);
  });
});
