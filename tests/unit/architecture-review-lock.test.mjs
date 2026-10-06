import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluateDoc } from '../../scripts/doc-currency.mjs';
import { evaluateArchitectureReview, GOVERNING_ADR } from '../../scripts/architecture-review-lock.mjs';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const script = fileURLToPath(new URL('../../scripts/architecture-review-lock.mjs', import.meta.url));
function fixture({ reviewed = true, row = true, status = 'Accepted', governs = 'scripts/thing.mjs' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-review-lock-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, 'docs/adr'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'hooks'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { env: {
    ...process.env, GIT_AUTHOR_DATE: '2026-10-05T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-05T12:00:00Z',
  } });
  git('init', '-q'); git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Review fixture'); git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', path.join(root, 'hooks'));
  fs.writeFileSync(path.join(root, 'scripts/thing.mjs'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(root, 'scripts/caller.mjs'), "import './thing.mjs';\n");
  const file = path.join(root, GOVERNING_ADR);
  fs.writeFileSync(file, `---\nid: ADR-103\nstatus: ${status}\ndate: 2026-10-05\nupdated: 2026-10-05\nimpl: built\ngoverns: [${governs}]\n---\n# Decision\nA bounded architecture/test mapping.\n\n## Currency log\n\n| Date | What | Why |\n|---|---|---|\n`);
  git('add', '.'); git('commit', '-qm', 'fixture');
  if (reviewed) {
    const digest = evaluateDoc(root, GOVERNING_ADR).digest.computed;
    let text = fs.readFileSync(file, 'utf8').replace('impl: built', `reviewed_digest: ${digest}\nimpl: built`);
    if (row) text += `| 2026-10-05 | Reviewed ${digest} | scripts/thing.mjs examined within this fixture. |\n`;
    fs.writeFileSync(file, text);
  }
  return root;
}
const cli = (root) => spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
describe('architecture review preflight refusal', () => {
  it('admits an Accepted finite current review through the real CLI', () => {
    const result = cli(fixture());
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ pass: true, review: { current: true } });
  });
  it.each(['source', 'mapping'])('refuses tampered %s bytes before qualification', (kind) => {
    const root = fixture();
    fs.appendFileSync(path.join(root, kind === 'source' ? 'scripts/thing.mjs' : GOVERNING_ADR),
      kind === 'source' ? '\n// Changed governed contract\n' : '\n## Changed architecture/test mapping\nChanged governed contract.\n');
    const result = cli(root);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).findings.some((f) => f.code === 'architecture-review-not-current')).toBe(true);
  });
  it.each([{ reviewed: false }, { row: false }, { status: 'Proposed' }, { governs: 'scripts/missing.mjs' },
    { governs: 'scripts/*.mjs' }, { governs: '' }])('refuses missing, incomplete or unaccepted review %j', (options) => {
    expect(cli(fixture(options)).status).toBe(1);
  });
  it('retains ordinary doc-currency blockers even with a current review', () => {
    const root = fixture();
    const file = path.join(root, GOVERNING_ADR);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('impl: built', 'impl: verified'));
    expect(evaluateArchitectureReview(root).findings.some((f) => f.code === 'impl-overclaimed')).toBe(true);
  });
  it('refuses an unreadable governing ADR', () => {
    const root = fixture(); fs.unlinkSync(path.join(root, GOVERNING_ADR));
    expect(cli(root).status).toBe(1);
  });
});
