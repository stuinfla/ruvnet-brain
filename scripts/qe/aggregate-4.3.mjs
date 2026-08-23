#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const dir = path.resolve(ROOT, process.env.QE_RECEIPT_DIR || '.qe/receipts');
const required = ['preflight', 'check', 'integration', 'release', 'resources', 'windows-unit'];
const failures = [];
const receipts = required.map((lane) => {
  const file = path.join(dir, `${lane}.json`);
  if (!fs.existsSync(file)) { failures.push(`${lane}: receipt missing`); return null; }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    failures.push(`${lane}: invalid receipt (${error.message})`); return null;
  }
});
const shas = new Set(receipts.filter(Boolean).map((receipt) => receipt.sha));
if (shas.size !== 1) failures.push(`receipts are not bound to one SHA: ${[...shas].join(', ') || '<none>'}`);
const runIds = new Set(receipts.filter(Boolean).map((receipt) => receipt.runId));
if (runIds.size !== 1) failures.push(`receipts are not bound to one run: ${[...runIds].join(', ') || '<none>'}`);
for (const [index, receipt] of receipts.entries()) {
  const lane = required[index];
  if (!receipt) continue;
  if (receipt.schema !== 'ruvnet-brain.agentic-qe.receipt' || receipt.contract !== 'agentic-qe-4.3') {
    failures.push(`${lane}: wrong receipt contract`);
  }
  if (receipt.lane !== lane || receipt.status !== 'PASS') failures.push(`${lane}: status ${receipt.status || '<missing>'}`);
  for (const step of receipt.steps || []) {
    if (step.status !== 'PASS') failures.push(`${lane} step ${step.index}: ${step.status}`);
    if (step.tests && (step.tests.total === 0 || step.tests.skipped > 0)) {
      failures.push(`${lane} step ${step.index}: skipped or empty test result`);
    }
  }
}
const result = {
  schema: 'ruvnet-brain.agentic-qe.aggregate', contract: 'agentic-qe-4.3',
  sha: shas.size === 1 ? [...shas][0] : null, required,
  status: failures.length ? 'FAIL' : 'PASS', failures, receipts,
};
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'aggregate.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ status: result.status, sha: result.sha, failures }));
process.exitCode = failures.length ? 1 : 0;
