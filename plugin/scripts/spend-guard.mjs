/**
 * spend-guard.mjs — agent work runs on the owner's DEVELOPER SEATS, never on metered API keys.
 *
 * THE INCIDENT, and it is not hypothetical. Filed by the owner as
 * github.com/proffesor-for-testing/agentic-qe/issues/557 on 2026-07-12: a QE fleet spawned ~374
 * headless agents over 11 hours, each billing api.anthropic.com pay-per-token through
 * `ANTHROPIC_API_KEY`, while the Claude Max subscription he was already paying for sat unused.
 * **$1,600.**
 *
 * THE STATE THAT MADE THIS NECESSARY, measured 2026-08-14 the moment the owner asked "is that rule
 * stored and hook created?":
 *
 *     rule stored              YES — lesson-subscription-seats-never-metered-api, user_claim, high
 *     rule fires               YES — at mutate-machine, ratified
 *     rule ENFORCED            NO  — enforcement:checklist. It MENTIONS the rule.
 *     hooks naming the keys    NONE
 *     keys live in the shell   ALL THREE SET
 *
 * A high-severity rule about irreversible spend, delivered as advisory text, guarding a failure that
 * already happened once. Advisory text is what gets skimmed — the finding this repo keeps
 * re-learning: retrieval cures ignorance, only interception cures confidence. Money leaving the
 * account is irreversible and outward-facing, which is precisely the blast-radius test for a gate.
 *
 * GROUNDED, not assumed (search_ruvnet receipts e39f5c35ceab, dd5060c96dd7):
 *   · agentic-qe/plugins/agentic-qe-fleet/agents/qe-fleet-commander.md declares
 *     `advisor: provider: openrouter, model: anthropic/claude-opus-4.7, max_uses: 3`, alongside
 *     "Spawn, scale, retire agents" and "up to 15 concurrent agent management operations". The fleet
 *     shape is real, and rUv already caps advisor calls — he thought about cost.
 *   · agentic-flow/src/agent-booster/index.ts is real shipped source in that repo's tree.
 *   So the gap is not rUv's design. It is the ENVIRONMENT these fleets inherit on this machine,
 *   which is this repo's problem to close.
 *
 * WHAT IS AND IS NOT METERED — the distinction is the whole design:
 *   · `claude` (Claude Code) → the Max SUBSCRIPTION. Not metered. Never blocked.
 *   · `codex`                → the ChatGPT account. Not metered. Never blocked.
 *   · agent FLEET runners inheriting ANTHROPIC_API_KEY / OPENAI_API_KEY → pay-per-token. The $1,600.
 *
 * DESIGN CONSTRAINTS, each paid for by a sibling hook earlier the same day:
 *   · FAIL OPEN — anything it cannot positively determine is ALLOWED, silently. A sibling turned a
 *     missing `sqlite3` into "your memory store is broken" and refused every `git push` on machines
 *     without ruflo. A fabricated refusal spends the credibility every other gate draws on.
 *   · NO CACHE — two independent audits each found a different bug in one 5-minute cache.
 *   · EXECUTABLE POSITION ONLY — quoted regions are stripped, so `grep -n "agentic-flow" docs/` and
 *     `git commit -m "ran aqe"` are not invocations. A sibling globbed raw text and read
 *     `grep -n "npm publish" docs/` as a ship.
 *   · NAME THE ALTERNATIVE — a wall that reports a problem without the fix gets routed around.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Env vars that bill per token. OPENROUTER is deliberately absent — see below. */
export const METERED_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];

/**
 * OPENROUTER IS METERED TOO AND IS STILL NOT BLOCKED. This repo's cost-optimal routing exists to
 * spend it deliberately, and the owner configured it for that. Blocking it would refuse the feature
 * it was set up for, and the blast radius is cents against the $1,600 this guard is named after.
 * A gate that fires on the thing you asked for is the gate you switch off.
 */

/**
 * Runners that spawn agent FLEETS — not "anything that calls an API". A single curl is a deliberate
 * one-shot and the owner's tooling does it constantly; 374 headless agents is a different act.
 */
export const FLEET_RUNNERS = [
  { name: 'the QE fleet', match: /(^|[|;&\s])(aqe|agentic-qe)\b/ },
  { name: 'the agent-flow orchestrator', match: /(^|[|;&\s])agentic-flow\b/ },
  { name: 'a ruflo swarm', match: /(^|[|;&\s])ruflo\b[^|;&]*\b(swarm|hive-mind|agent\s+spawn|task\s+orchestrate)\b/ },
  { name: 'flow-nexus', match: /(^|[|;&\s])flow-nexus\b/ },
];

/** Quoted text is an argument, not a command. */
const executablePart = (cmd) => String(cmd || '').replace(/"[^"]*"/g, ' ').replace(/'[^']*'/g, ' ');

/**
 * Refuses ONLY when a fleet runner is invoked AND a metered key sits in the environment it would
 * inherit. Either alone is ordinary: keys in the shell are normal, and a fleet on seats is the
 * intended way to work.
 */
export function check(command, env = process.env) {
  const runner = FLEET_RUNNERS.find((r) => r.match.test(executablePart(command)));
  if (!runner) return { verdict: 'not-applicable' };

  // The documented opt-in. The lesson's own wording permits it: "unless a human explicitly opts in
  // for that run." A gate with no legitimate exit breeds the workaround that disables it entirely.
  if (/^(1|true|yes|on)$/i.test(String(env.RUVNET_ALLOW_METERED_SPEND ?? ''))) {
    return { verdict: 'opted-in', runner: runner.name };
  }

  const exposed = METERED_KEYS.filter((k) => String(env[k] ?? '').trim());
  if (!exposed.length) return { verdict: 'ok', runner: runner.name };

  return {
    verdict: 'metered',
    runner: runner.name,
    exposed,
    reason:
      `⛔ BLOCKED — this would run ${runner.name} against METERED API keys.\n\n`
      + `  exposed in this environment: ${exposed.join(', ')}\n\n`
      + 'Agent work runs on the developer seats you already pay for — Claude Max through the\n'
      + '`claude` CLI, your ChatGPT account through `codex`. Not pay-per-token.\n\n'
      + 'This already happened once: a QE fleet spawned ~374 headless agents over 11 hours, each\n'
      + 'billing api.anthropic.com, while the Max subscription sat unused — $1,600\n'
      + '(proffesor-for-testing/agentic-qe#557, filed 2026-07-12).\n\n'
      + `  On the seats:           env ${exposed.map((k) => `-u ${k}`).join(' ')} <your command>\n`
      + '  Deliberate metered run: RUVNET_ALLOW_METERED_SPEND=1 <your command>   (say why out loud)',
  };
}

const isMain = (() => {
  try { return process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (isMain) {
  // Every unexpected path ALLOWS. This gate may never be the reason work cannot proceed for a
  // reason it cannot explain.
  try {
    const command = JSON.parse(fs.readFileSync(0, 'utf8'))?.tool_input?.command ?? '';
    const r = check(command);
    if (r.verdict !== 'metered') process.exit(0);
    process.stderr.write(`${r.reason}\n`);
    process.exit(2);
  } catch { process.exit(0); }
}
