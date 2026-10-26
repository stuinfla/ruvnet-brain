// The release preflight's cheap checks must fail on a development PR (non-paging) before they can fail on the
// release/* push (paging). canonical-qa's qualify-development job runs the same commands as the preflight step.
import fs from 'node:fs';
import { expect, it } from 'vitest';
const read = (name) => fs.readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
const commandsOf = (workflow, stepName) => {
  const lines = workflow.split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  expect(at, stepName).toBeGreaterThan(-1);
  const run = lines.findIndex((l, i) => i > at && /^\s+run: \|$/.test(l));
  const indent = lines[run + 1].match(/^\s*/)[0].length;
  const body = [];
  for (let i = run + 1; i < lines.length && (lines[i].match(/^\s*/)[0].length >= indent && lines[i].trim()); i++) body.push(lines[i].trim());
  return body.filter((l) => !l.startsWith('set ') && !l.startsWith('#'));
};
it('qualify-development runs every cheap release-preflight check before the source suite', () => {
  const preflight = commandsOf(read('release-candidate-preflight'), 'Validate changed release and grounding paths before the matrix');
  const canonical = read('canonical-qa');
  const job = canonical.slice(canonical.indexOf('  qualify-development:'), canonical.indexOf('\n  canonical-qa:'));
  const early = commandsOf(job, 'Release preflight checks, early');
  expect(preflight).toEqual(['node --check scripts/release.mjs', 'npm run version:check', 'npm run release:authority',
    'node scripts/architecture-review-lock.mjs']);
  expect(early).toEqual(preflight);
  expect(job.indexOf('Release preflight checks, early')).toBeLessThan(job.indexOf('release-qualification.mjs --suite source'));
  expect(job.indexOf('npm ci --no-audit --no-fund')).toBeLessThan(job.indexOf('Release preflight checks, early'));
});
