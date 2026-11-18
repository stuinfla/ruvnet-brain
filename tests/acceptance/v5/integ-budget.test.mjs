// Line budgets (architecture section 6, ROADMAP A1 step 0.4): every package's .mjs lines are within the
// budget in packages/BUDGETS.json, and every package folder has a budget. A budget above the
// architecture's number must carry a reason. Breaks: breaks-integration.mjs (integ-budget-*).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';

const lines = (dir, skip = []) => {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += skip.includes(e.name) ? 0 : lines(p);
    else if (e.name.endsWith('.mjs')) n += fs.readFileSync(p, 'utf8').split('\n').length - 1;
  }
  return n;
};

test('every package is within its line budget', { timeout: 60_000 }, (t) => {
  const ctx = setup(t, 'integ-budget');
  const root = path.join(ctx.tree().root, 'packages');
  const { packages } = JSON.parse(fs.readFileSync(path.join(root, 'BUDGETS.json'), 'utf8'));
  const folders = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  for (const f of folders) assert.ok(packages[f], `packages/${f} has a budget`);
  const over = [];
  for (const [name, b] of Object.entries(packages)) {
    const n = lines(path.join(root, name), b.exclude ?? []);
    t.diagnostic(`${name}: ${n} of ${b.budget}`);
    if (n > b.budget) over.push(`${name} ${n} > ${b.budget}`);
  }
  assert.deepEqual(over, [], `over budget: ${over.join('; ')}`);
});
