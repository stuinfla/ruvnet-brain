import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitFrontmatter, CANONICAL, ALIASES } from '../../scripts/sync-commands.mjs';

/**
 * ISSUE #135 — every spelling of one command must behave identically.
 *
 * `/rnbc` (the name, since 2026-10-01: RuvNet Brain → RNB → RNB Console), `/rnb`, `/rvbc`, `/rvcb`,
 * `/brain-console` and `/ruvnet-brain:configure` each declare that every spelling is equally valid
 * and the user must never be corrected. Their bodies had drifted into independent hand-written specs
 * (4116 / 976 / 985 / 1680 bytes on 4.0.36), and four rules lived only in the canonical one.
 *
 * This asserts the PROPERTY (one body, every name), not a copy of the rules. A test that listed the
 * rules would be another copy of the thing that drifted.
 *
 * 2026-10-01 QA: the owner opened the console as `/rnbc` — a spelling no file implemented, while the
 * shipped text promised "every spelling lands here". So this file also checks the inverse direction:
 * every console spelling a user-facing surface TEACHES must be a real command file.
 */
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const DIR = path.join(ROOT, 'plugin', 'commands');
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

// Surfaces a person reads to learn how to open the console.
const TEACHING_SURFACES = [
  'README.md', 'explainer/index.html', 'console/index.html', 'console/tips.html', 'console/app.js',
  'plugin/scripts/session-start-core.mjs', 'bin/install.mjs', 'kb/capability-cards.md',
  ...fs.readdirSync(DIR).filter((f) => f.endsWith('.md')).map((f) => `plugin/commands/${f}`),
  ...fs.readdirSync(path.join(ROOT, 'plugin', 'skills')).map((d) => `plugin/skills/${d}/SKILL.md`),
].filter((f) => fs.existsSync(path.join(ROOT, f)));

// A console spelling: /rnbc, /rnb, /rvbc, /rvcb, /brain-console, /configure — or any namespaced
// /ruvnet-brain:<name>. Matched as a slash token so prose ("RuvNet Brain Console") is not counted.
const SPELLING = /(?<![\w/.~-])\/((?:ruvnet-brain:)?(?:r[nv][bc]{1,2}|brain-console|configure))\b/g;

function taughtSpellings(text) {
  return [...new Set([...text.matchAll(SPELLING)].map((m) => m[1].replace(/^ruvnet-brain:/, '')))];
}

describe('issue #135 — every spelling of the console command behaves the same', () => {
  it('rnbc is the producer and every alias body is byte-identical to it', () => {
    expect(CANONICAL).toBe('rnbc.md');
    const canonical = splitFrontmatter(read(CANONICAL)).body;
    expect(canonical.length, 'sanity: the canonical body must be substantial').toBeGreaterThan(1000);
    for (const alias of ALIASES) {
      expect(fs.existsSync(path.join(DIR, alias)), `${alias} is a declared alias with no file`).toBe(true);
      expect(splitFrontmatter(read(alias)).body, `${alias} has drifted from ${CANONICAL}`).toBe(canonical);
    }
  });

  it('every spelling the canonical body promises is a real command file, and vice versa', () => {
    const promised = taughtSpellings(splitFrontmatter(read(CANONICAL)).body).sort();
    const files = [CANONICAL, ...ALIASES].map((f) => f.replace(/\.md$/, '')).sort();
    expect(promised).toEqual(files);
  });

  it('every console spelling a user-facing surface teaches is a real command (the /rnbc miss)', () => {
    const missing = [];
    for (const f of TEACHING_SURFACES) {
      for (const name of taughtSpellings(fs.readFileSync(path.join(ROOT, f), 'utf8'))) {
        if (!fs.existsSync(path.join(DIR, `${name}.md`))) missing.push(`${f} teaches /${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('the primary name /rnbc is what the front-door surfaces teach', () => {
    for (const f of ['README.md', 'explainer/index.html', 'plugin/scripts/session-start-core.mjs']) {
      expect(taughtSpellings(fs.readFileSync(path.join(ROOT, f), 'utf8')), f).toContain('rnbc');
    }
  });

  it('each alias keeps its OWN description — that is what the picker shows, not duplicated knowledge', () => {
    const descriptions = [CANONICAL, ...ALIASES].map((f) => {
      const fm = splitFrontmatter(read(f)).frontmatter || '';
      return /^description:\s*(.*)$/m.exec(fm)?.[1] || '';
    });
    for (const d of descriptions) expect(d.length, 'every command needs a description').toBeGreaterThan(20);
    expect(new Set(descriptions).size, 'identical picker entries would be a regression of their own')
      .toBe(descriptions.length);
  });

  it('TEETH: the spelling scan finds an undocumented spelling and the parity check fires on drift', () => {
    expect(taughtSpellings('type `/rnbx` or /ruvnet-brain:rvbc or ~/x/rnbc.md')).toEqual(['rvbc']);
    expect(taughtSpellings('open it with /rnbc — or /rnb')).toEqual(['rnbc', 'rnb']);
    expect(fs.existsSync(path.join(DIR, 'rnbq.md'))).toBe(false);
    const canonical = splitFrontmatter(read(CANONICAL)).body;
    const mutated = `${canonical}\n\nAn extra instruction only one spelling would receive.\n`;
    expect(splitFrontmatter(`---\ndescription: x\n---\n${mutated}`).body).not.toBe(canonical);
  });

  it('splitFrontmatter returns the frontmatter and body verbatim', () => {
    const { frontmatter, body } = splitFrontmatter('---\ndescription: d\nupdated: 2026-01-01\n---\nBODY\n');
    expect(frontmatter).toBe('description: d\nupdated: 2026-01-01');
    expect(body).toBe('BODY\n');
    expect(splitFrontmatter('just a body').body).toBe('just a body');
  });
});
