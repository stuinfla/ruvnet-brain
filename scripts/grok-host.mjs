/**
 * Grok CLI status for the installer summary and `--doctor` (#301).
 *
 * Grok has no install step of its own: it discovers the Claude Code plugin (measured with
 * `grok inspect --json` on grok 1.0.58: plugin ruvnet-brain, 10 skills, its MCP server, and the
 * hook file plugin/hooks/grok-hooks.json selected by plugin/.grok-plugin/plugin.json). Grok
 * discards an allowing UserPromptSubmit hook's context (~/.grok/docs/user-guide/10-hooks.md), so the
 * prompt-time "search first" directive never reaches its model; a line in ~/.grok/AGENTS.md (loaded
 * as a global rule — same inspect run) is what makes Grok ground itself. That line is OPT-IN only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const GROK_MD_START = '<!-- ruvnet-brain:start -->';
export const GROK_MD_END = '<!-- ruvnet-brain:end -->';
export const GROK_AGENTS_LINE = 'For anything about the RuvNet / rUv stack (Ruflo, RuVector/RVF, AgentDB, agentic-flow, and the rest), '
  + 'call the `search_ruvnet` MCP tool first and cite the source paths it returns. Do not answer from memory. '
  + 'If it fails, say so and run `npx ruvnet-brain --doctor`.';
export const GROK_AGENTS_BLOCK = `${GROK_MD_START}\n${GROK_AGENTS_LINE}\n${GROK_MD_END}`;

export function grokPaths(home = os.homedir()) {
  const bin = path.join(home, '.grok', 'bin');
  return { bin: [path.join(bin, 'grok'), path.join(bin, 'grok.exe')], agents: path.join(home, '.grok', 'AGENTS.md') };
}

/** What is true about Grok on this machine. Never runs grok; reads files only. */
export function grokStatus({ home = os.homedir(), pluginInstalled = false, hookCount = null } = {}) {
  const p = grokPaths(home);
  const present = p.bin.some((file) => fs.existsSync(file));
  let agentsText = '';
  try { agentsText = fs.readFileSync(p.agents, 'utf8'); } catch { /* absent */ }
  return { present, pluginInstalled: Boolean(pluginInstalled), hookCount, agentsFile: p.agents,
    groundingLine: /search_ruvnet/.test(agentsText) };
}

/** One honest line: what reaches Grok, and whether the grounding line is there. null when no Grok. */
export function grokStatusLine(s) {
  if (!s.present) return null;
  if (!s.pluginInstalled) {
    return 'Grok CLI detected — the Brain reaches Grok only through the Claude Code plugin, which is not installed here (run npx ruvnet-brain).';
  }
  const hooks = Number.isInteger(s.hookCount) ? `${s.hookCount} lifecycle hooks` : 'its lifecycle hooks';
  return `Grok CLI detected — search_ruvnet, the Brain skills and ${hooks} (grok-hooks.json) load from the Claude Code plugin. `
    + 'Grok drops prompt-time context, so grounding relies on a search-first line in ~/.grok/AGENTS.md: '
    + (s.groundingLine ? 'present.' : 'absent (opt in: npx ruvnet-brain --grok-agents-md).');
}

/**
 * Add the search-first line to ~/.grok/AGENTS.md ONLY if no search_ruvnet line is there already.
 * Marker-wrapped (removed by --uninstall), backed up, written atomically. Returns
 * 'added' | 'present' | 'no-grok' | 'failed'.
 */
export function addGrokAgentsLine({ home = os.homedir(), now = new Date() } = {}) {
  const s = grokStatus({ home });
  if (!s.present) return 'no-grok';
  if (s.groundingLine) return 'present';
  const file = s.agentsFile;
  try {
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (existing) fs.copyFileSync(file, `${file}.bak-${now.toISOString().replace(/[:.]/g, '-')}`);
    const next = existing ? `${existing.replace(/\s*$/, '')}\n\n${GROK_AGENTS_BLOCK}\n` : `${GROK_AGENTS_BLOCK}\n`;
    const tmp = `${file}.ruvnet-tmp`;
    fs.writeFileSync(tmp, next);
    fs.renameSync(tmp, file);
    return 'added';
  } catch { return 'failed'; }
}
