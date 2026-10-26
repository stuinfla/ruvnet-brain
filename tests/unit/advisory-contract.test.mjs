// #489 — ADVISORY_CONTRACT. Optional Brain advice (capability and package recommendations, the
// stack-update notice, the memory and flywheel offers) was question-shaped ("want me to update it?",
// "Say 'use X' to proceed, or ignore this"), which Codex promoted into a question dialog that
// suspended an already-authorized task. Every emitted optional template must be a statement, and the
// model-visible context must carry the contract saying no dialog is warranted.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ADVISORY_CONTRACT, QUESTION_SHAPED } from '../../plugin/scripts/advisory-contract.mjs';
import { CAPABILITIES } from '../../plugin/scripts/advocacy-catalog.mjs';
import { buildPackageCandidate } from '../../plugin/scripts/package-recommender.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPTS = path.join(ROOT, 'plugin', 'scripts');
const GROUND = path.join(SCRIPTS, 'ground-ruvnet.sh');
const GROUND_SRC = fs.readFileSync(GROUND, 'utf8');
const hasBash = process.platform !== 'win32' && spawnSync('bash', ['-c', 'exit 0']).status === 0;

let tmp;
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'advisory-contract-')); });
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const questionFree = (text, label) => expect(text, `${label} must not be question-shaped`).not.toMatch(QUESTION_SHAPED);

describe('#489 ADVISORY_CONTRACT — optional advice is a statement, never a question', () => {
  it('the contract itself is question-free and says no dialog and no authority', () => {
    questionFree(ADVISORY_CONTRACT, 'ADVISORY_CONTRACT');
    expect(ADVISORY_CONTRACT).toMatch(/continue the current task/);
    expect(ADVISORY_CONTRACT).toMatch(/question or approval dialog/);
    expect(ADVISORY_CONTRACT).toMatch(/no authority to install or update/);
  });

  it('every capability-advocacy candidate the catalogue can produce is question-free', async () => {
    process.env.RUVNET_ADVOCACY_ROUTE_STATE = path.join(tmp, 'route-state.json');
    const { buildCandidate } = await import('../../plugin/scripts/advocacy-route.mjs');
    const ids = Object.keys(CAPABILITIES);
    expect(ids.length).toBeGreaterThan(0);
    for (const capability of ids) {
      for (const availability of ['installed', 'unknown']) {
        const c = buildCandidate({ prompt: 'p', match: { capability, intent: { id: 'i', fit: 'fits' } }, availability });
        questionFree(c.copy, `advocacy ${capability}/${availability}`);
        expect(c.copy).toContain(`'use ${capability}'`);   // the acceptance word the ledger detects survives
      }
    }
  });

  it('the package-recommendation candidate is question-free', () => {
    const c = buildPackageCandidate({ prompt: 'p', pick: { card: { id: '@scope/typesafe', description: 'typed contracts', source: 'x/y.ts' }, matched: [], score: 1 } });
    questionFree(c.copy, 'package candidate');
    expect(c.copy).toContain("'use typesafe'");
  });

  it('ground-ruvnet.sh optional offer blocks (memory, flywheel) are question-free and carry the contract verbatim', () => {
    for (const id of ['1-2-memory-offer', '2-3-flywheel']) {
      const m = GROUND_SRC.match(new RegExp(`out_to ${id} <<'EOF'\\n([\\s\\S]*?)\\nEOF`));
      expect(m, `${id} heredoc`).toBeTruthy();
      questionFree(m[1], id);
      expect(m[1]).toContain(ADVISORY_CONTRACT);
    }
  });

  it.skipIf(!hasBash)('the emitted stack-update notice is question-free and carries the contract', () => {
    const home = path.join(tmp, 'stack-home');
    fs.mkdirSync(path.join(home, '.cache/ruvnet-brain'), { recursive: true });
    fs.writeFileSync(path.join(home, '.cache/ruvnet-brain/.stack-latest'), 'ruflo 3.28.0\n');
    fs.writeFileSync(path.join(home, '.cache/ruvnet-brain/.stack-versions-checked'), String(Math.floor(Date.now() / 1000)));
    const pkg = path.join(home, '.npm-global/lib/node_modules/ruflo');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'ruflo', version: '3.25.6' }));
    const out = execFileSync('bash', [GROUND], { env: { ...process.env, HOME: home, CLAUDE_USER_PROMPT: 'hello' },
      input: JSON.stringify({ prompt: 'hello' }), encoding: 'utf8', timeout: 15000 });
    const start = out.indexOf('[RuvNet Brain — stack updates available');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = out.indexOf(ADVISORY_CONTRACT, start);
    expect(end, 'the stack notice must carry the contract').toBeGreaterThan(start);
    questionFree(out.slice(start, end + ADVISORY_CONTRACT.length), 'stack-update notice');
  });

  it('the skill and playbook recommendation templates are statements', () => {
    for (const rel of ['plugin/skills/ruvnet-brain/SKILL.md', 'plugin/skills/ruvnet-brain/PLAYBOOK.md']) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const tpl = src.match(/\*"`<capability>` fits here[\s\S]*?"\*/);
      expect(tpl, `${rel} recommendation template`).toBeTruthy();
      questionFree(tpl[0], rel);
      expect(src).not.toMatch(/or ignore this/);
    }
  });

  describe.skipIf(!hasBash)('the runtime delivery boundary (unprompted-runtime.mjs)', () => {
    const fire = (candidate, level) => {
      const dir = fs.mkdtempSync(path.join(tmp, 'rt-'));
      const emit = path.join(dir, 'emit.sh');
      fs.writeFileSync(emit, '#!/bin/bash\nprintf \'%s\\n\' "$CANDIDATE_LINE"\n');
      fs.chmodSync(emit, 0o755);
      const settings = path.join(dir, 'settings.json');
      fs.writeFileSync(settings, JSON.stringify({ version: 1, updated: '2026-07-25T00:00:00Z',
        settings: { learningScope: 'project', advocacy: level, autoApply: false, newProjectDefaults: false } }));
      const r = spawnSync('node', [path.join(SCRIPTS, 'unprompted-runtime.mjs'), 'UserPromptSubmit'], {
        input: JSON.stringify({ prompt: 'a prompt long enough to look like a real goal statement', session_id: 's1' }),
        encoding: 'utf8', timeout: 45000,
        env: { ...process.env, RUVNET_UNPROMPTED_TIMEOUT_MS: '25000',
          RUVNET_UNPROMPTED_PRODUCERS: JSON.stringify([{ argv: ['/bin/bash', emit], feedStdin: true }]),
          RUVNET_SETTINGS_FILE: settings, RUVNET_ADVOCACY_OUTCOMES: path.join(dir, 'outcomes.jsonl'),
          CANDIDATE_LINE: JSON.stringify(candidate) },
      });
      return JSON.parse(r.stdout || '{}')?.hookSpecificOutput?.additionalContext || '';
    };

    it('an advocacy offer is delivered WITH the contract, exactly once', () => {
      const ctx = fire({ channel: 'advocacy', effect: 'advisory', hookEventName: 'UserPromptSubmit',
        copy: 'FIXTURE_ADVOCACY a capability fits here', findingId: 'fix-adv', severity: 'high', observationHash: 'hA' }, 3);
      expect(ctx).toContain('FIXTURE_ADVOCACY');
      expect(ctx.split(ADVISORY_CONTRACT).length - 1).toBe(1);
    });

    it('a non-offer advisory (promotion) is not stamped with the contract', () => {
      const ctx = fire({ channel: 'promotion', effect: 'advisory', hookEventName: 'UserPromptSubmit',
        copy: 'FIXTURE_PROMOTION promote this lesson' }, 5);
      expect(ctx).toContain('FIXTURE_PROMOTION');
      expect(ctx).not.toContain(ADVISORY_CONTRACT);
    });
  });
});
