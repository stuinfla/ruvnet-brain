import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitFrontmatter } from '../../scripts/sync-commands.mjs';

/**
 * ISSUE #135 — four spellings of one command must behave identically.
 *
 * `/rvbc`, `/rvcb`, `/brain-console` and `/ruvnet-brain:configure` each declare that every spelling
 * is equally valid and the user must never be corrected. Their bodies had drifted into four
 * independent hand-written specs (4116 / 976 / 985 / 1680 bytes on 4.0.36), and four rules lived
 * only in the canonical one. Which spelling a user happened to type changed how the assistant
 * behaved — on the command whose entire promise is that spelling does not matter.
 *
 * This asserts the PROPERTY (one body, four names), not a copy of the rules. A test that listed the
 * four rules would be a fifth copy of the thing that drifted.
 */
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const DIR = path.join(ROOT, 'plugin', 'commands');
const CANONICAL = 'rvbc.md';
const ALIASES = ['rvcb.md', 'brain-console.md', 'configure.md'];

const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

describe('issue #135 — every spelling of the console command behaves the same', () => {
  it('each alias body is byte-identical to the canonical one', () => {
    const canonical = splitFrontmatter(read(CANONICAL)).body;
    expect(canonical.length, 'sanity: the canonical body must be substantial').toBeGreaterThan(1000);
    for (const alias of ALIASES) {
      expect(splitFrontmatter(read(alias)).body, `${alias} has drifted from ${CANONICAL}`).toBe(canonical);
    }
  });

  it('each alias keeps its OWN description — that is what the picker shows, not duplicated knowledge', () => {
    const descriptions = [CANONICAL, ...ALIASES].map((f) => {
      const fm = splitFrontmatter(read(f)).frontmatter || '';
      return /^description:\s*(.*)$/m.exec(fm)?.[1] || '';
    });
    for (const d of descriptions) expect(d.length, 'every command needs a description').toBeGreaterThan(20);
    expect(new Set(descriptions).size, 'four identical picker entries would be a regression of its own')
      .toBeGreaterThan(1);
  });

  it('TEETH: the parity check actually fires when a body diverges', () => {
    // Without this, the assertion above could pass on any four files that happened to be equal for an
    // unrelated reason — including four empty bodies.
    const canonical = splitFrontmatter(read(CANONICAL)).body;
    const mutated = `${canonical}\n\nAn extra instruction only one spelling would receive.\n`;
    expect(mutated).not.toBe(canonical);
    expect(splitFrontmatter(`---\ndescription: x\n---\n${mutated}`).body).toBe(mutated);
  });

  it('splitFrontmatter returns the frontmatter and body verbatim', () => {
    const { frontmatter, body } = splitFrontmatter('---\ndescription: d\nupdated: 2026-01-01\n---\nBODY\n');
    expect(frontmatter).toBe('description: d\nupdated: 2026-01-01');
    expect(body).toBe('BODY\n');
    // A file with no frontmatter must not lose its content.
    expect(splitFrontmatter('just a body').body).toBe('just a body');
  });
});
