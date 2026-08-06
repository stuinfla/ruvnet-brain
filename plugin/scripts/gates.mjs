// gates.mjs — what stands between the model and your machine, and what it has caught.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY (2026-07-17). Stuart, looking at the console's wiring card: "I have no idea what message it's
// supposed to tell me… it seems to be facts without purpose." The card counted launch sites. Nobody
// wants a census. The question worth answering is the one the harness exists for: WHAT STOPS CLAUDE
// FROM BEING WRONG, AND HAS IT EVER ACTUALLY STOPPED IT?
//
// Two things had to be true before that card could be honest, and neither was:
//
//   1. The console never read the gates. wiringSurvey() walks ~/Code project settings only, so the
//      12 machine-wide hooks in ~/.claude/settings.json and the 9 in the plugin's own hooks.json —
//      including the design wall that blocks commits — were invisible to the page bragging about them.
//
//   2. The gates never recorded a block. Only successes were logged, so "the harness caught Claude"
//      had no receipt. gate-receipt.sh now writes one at the moment of refusal.
//
// THE HONEST DISTINCTION this module exists to draw: a hook wired with `|| true` CANNOT block —
// it injects context and the tool call proceeds regardless. Only a gate that can exit non-zero
// stops anything. Counting all hooks as "protection" would be the same inflation as counting
// cloned upstream repos as your own wiring. Advisory and blocking are different claims.
//
// Reads only. Never asserts a count it cannot source from a file on this machine.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const BLOCKS = path.join(HOME, '.cache/ruvnet-brain/gate-blocks.jsonl');

function readJSON(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

// Two independent things must BOTH be true for a hook to stop anything, and conflating them is how
// a census gets sold as protection:
//   1. The EVENT must be one that runs before the thing it would stop. PreToolUse gates a tool call;
//      UserPromptSubmit gates a prompt. SessionStart has nothing to refuse yet, and PostToolUse /
//      PreCompact / SessionEnd arrive after the fact — those inject or record, they never block.
//   2. The COMMAND must not end in `|| true`, which swallows the exit code the gate would refuse with.
const BLOCKING_EVENTS = new Set(['PreToolUse', 'UserPromptSubmit']);
const swallowsExit = (cmd) => /\|\|\s*true\s*$/.test(String(cmd || '').trim());
const canBlock = (event, cmd) => BLOCKING_EVENTS.has(event) && !swallowsExit(cmd);

const NAME = (cmd) => {
  const m = String(cmd || '').match(/([\w-]+)\.(sh|mjs|js)/);
  return m ? m[1] : String(cmd || '').split(/\s+/).filter((t) => !t.startsWith('-')).pop()?.slice(0, 28) || 'hook';
};

function collect(hooksObj, source) {
  const out = [];
  for (const [event, groups] of Object.entries(hooksObj || {})) {
    const list = Array.isArray(groups) ? groups : [groups];
    for (const g of list) {
      const hooks = Array.isArray(g?.hooks) ? g.hooks : (g?.command ? [g] : []);
      for (const h of hooks) {
        if (!h?.command) continue;
        out.push({ event, matcher: g?.matcher ?? '*', name: NAME(h.command), blocking: canBlock(event, h.command), source });
      }
    }
  }
  return out;
}

// Every catch the gates have recorded. This file only exists once a gate has actually refused
// something — an empty ledger is an honest "nothing caught yet", never a failure.
export function gateBlocks() {
  try {
    return fs.readFileSync(BLOCKS, 'utf8').trim().split('\n')
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

export function gatesSurvey({ repo } = {}) {
  const machine = collect(readJSON(path.join(HOME, '.claude/settings.json'))?.hooks, 'machine');
  const pluginCfg = repo ? readJSON(path.join(repo, 'plugin/hooks/hooks.json')) : null;
  const plugin = collect(pluginCfg?.hooks || pluginCfg, 'plugin');

  const all = [...machine, ...plugin];
  const blocking = all.filter((g) => g.blocking);

  // THE LEDGER IS MACHINE-WIDE; THIS SURVEY IS ABOUT ONE PROJECT. Every catch ever recorded on the
  // machine used to be counted here, so standing in an empty folder produced "203 refusals have been
  // recorded" — this repo's history, attributed to a project that has never run a gate. Each record
  // carries the `cwd` it was caught in, so when a project is named, only its own catches count.
  //
  // KNOWN LIMIT, stated rather than hidden: `cwd` is a basename, so two projects sharing a folder
  // name share a count. That is a real ambiguity and it is narrow; attributing the whole machine's
  // history to whichever directory you happen to be standing in was neither.
  const here = repo ? path.basename(path.resolve(repo)) : null;
  const allBlocks = gateBlocks();
  const blocks = here ? allBlocks.filter((b) => b.cwd === here) : allBlocks;

  // Same gate, same event, wired both machine-wide AND by the plugin — it runs twice on every
  // matching call. Harmless to correctness (these gates are idempotent) but it is real duplicated
  // work, and counting it as two protections would inflate the only number on the card that matters.
  const seen = new Map();
  const duplicated = [];
  for (const g of all) {
    const k = `${g.event}:${g.name}`;
    if (seen.has(k) && seen.get(k) !== g.source) { if (!duplicated.includes(g.name)) duplicated.push(g.name); }
    seen.set(k, g.source);
  }
  const uniqueBlocking = new Set(blocking.map((g) => `${g.event}:${g.name}`)).size;

  // Group the catches by gate so the card can say WHAT was caught, not just how many times.
  const byGate = {};
  for (const b of blocks) (byGate[b.gate] ||= []).push(b);

  const weekAgo = Date.now() - 7 * 864e5;
  const recent = blocks.filter((b) => Date.parse(b.at || 0) >= weekAgo);

  // THREE NUMBERS, ONE UNIT. This block used to mix two: `blocking` was DEDUPLICATED
  // (distinct event:name) while `advisory` was `all.length - blocking.length`, computed from the
  // RAW array. So `blocking + advisory` fell short of `armed` by exactly the number of duplicated
  // blocking wirings, and the console printed "N gates armed — B can stop a call. The other A add
  // context" where B + A ≠ N. On a machine with 4 duplicate blocking gates the sentence silently
  // lost four of them — in the one sentence whose entire job is to account for all of them.
  //
  // It summed correctly on any machine with no duplicates, which is why it survived: the defect was
  // invisible exactly where it was most often looked at. Found by Fable 5, 2026-07-24, by adding up
  // the numbers on the owner's own console.
  //
  // Fixed by reporting all three in WIRED-ENTRY units, so armed = blocking + advisory holds by
  // construction. The distinct-gate count is still exported — it is genuinely the more meaningful
  // number for "how many different things can refuse" — but under its own name, where it cannot be
  // mistaken for a term in that sum.
  const blockingWired = blocking.length;
  return {
    summary: {
      armed: all.length,
      blocking: blockingWired,           // wired entries that can refuse — same unit as `armed`
      advisory: all.length - blockingWired,
      blockingDistinct: uniqueBlocking,  // distinct gates that can refuse; ≤ blocking when wired twice
      duplicated,                        // wired twice; runs twice
      caughtTotal: blocks.length,
      caughtThisWeek: recent.length,
      everRecorded: blocks.length > 0,
    },
    gates: all.sort((a, b) => Number(b.blocking) - Number(a.blocking)),
    // Newest first — the most recent catch is the one worth reading.
    catches: blocks.slice(-12).reverse(),
    byGate: Object.fromEntries(Object.entries(byGate).map(([k, v]) => [k, v.length])),
  };
}
