/**
 * automated-run.mjs — is this Stop hook running inside an automated, machine-read run?
 *
 * Automated runs keep their exact output (4.7.1, check 2f). Measured: `claude -p` returned a
 * "Correction to my previous reply ... Verified:" paragraph and `codex exec` returned "UNVERIFIED: ..."
 * because the continuation gate asked for a correction, which corrupted callers that parse the answer.
 *
 * The approach is copied from the owner's own Stop gate, ~/.claude/hooks/owner-review-gate.mjs:
 *   line 19   — `CLAUDE_CODE_ENTRYPOINT` starting with `sdk-` (scripted `claude -p` / Agent SDK runs);
 *   lines 20-24 — `/bin/ps -o args= -p <ppid>` and the regex `(^|\/)codex(\s+\S+)*\s+exec(\s|$)`;
 *                 an unknown parent keeps gating.
 * One difference, and why: that gate is registered directly, so Codex is its parent. This gate runs at
 * the end of a chain (node -e wrapper -> codex-hook.mjs -> codex-hook-adapter.mjs -> hook-shim.mjs ->
 * this), so the Codex check walks a bounded number of ancestors, and only when the hook host is Codex.
 * Interactive Claude (`cli`, desktop, VS Code entrypoints) and interactive Codex stay gated.
 */
import { execFileSync } from 'node:child_process';

const CODEX_EXEC = /(^|\/)codex(\s+\S+)*\s+exec(\s|$)/;
// Grok's headless entry points (`grok --help`): -p/--single, --prompt-file, --prompt-json and the `agent` subcommand.
// Measured 2026-10-13 under `grok -p`: the hook's parent is `grok -p ...` and its env carries GROK_HOOK_EVENT and GROK_SESSION_ID.
const GROK_HEADLESS = /(^|\/)grok(\s+\S+)*\s+(-p|--single|--prompt-file|--prompt-json|agent)(\s|$)/;
const MAX_ANCESTORS = 12;

function psRow(pid) {
  const out = execFileSync('/bin/ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 });
  const m = /^\s*(\d+)\s+(.*)$/s.exec(out.trim());
  return m ? { ppid: Number(m[1]), args: m[2].trim() } : null;
}

/** True when the hook belongs to an automated run. `ps` is injectable for tests. */
export function isAutomatedRun({ env = process.env, ppid = process.ppid, ps = psRow } = {}) {
  if (/^sdk-/.test(env.CLAUDE_CODE_ENTRYPOINT || '')) return true;
  const grok = env.RUVNET_HOOK_HOST === 'grok' || Boolean(env.GROK_HOOK_EVENT || env.GROK_SESSION_ID);
  const pattern = env.RUVNET_HOOK_HOST === 'codex' ? CODEX_EXEC : grok ? GROK_HEADLESS : null;
  if (!pattern) return false;
  try {
    let pid = ppid;
    for (let i = 0; i < MAX_ANCESTORS && pid > 1; i++) {
      const row = ps(pid);
      if (!row) return false;
      if (pattern.test(row.args)) return true;
      pid = row.ppid;
    }
  } catch { /* unknown parent: keep gating */ }
  return false;
}
