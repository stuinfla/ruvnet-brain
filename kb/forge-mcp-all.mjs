#!/usr/bin/env node
// forge-mcp-all.mjs — ONE MCP tool over the WHOLE RuvNet brain (every repo in the bundle).
//
// Where forge-mcp.mjs serves a single KB, this serves the entire bundle as one brain. It exposes:
//   search_ruvnet({ query: string, k?: number = 6 })
// which retrieves candidates from EVERY repo present in the bundle dir (reusing searchKb, which
// auto-selects each repo's sharp `big` variant when present), pools them, re-scores the whole pool
// with one cross-encoder pass so cross-repo hits are comparable, and returns the globally best
// whole DOCUMENTS — each labeled with the repo + path it is grounded in.
//
//   KB_DIR   directory holding the bundle's <repo>.rvf + <repo>.passages.jsonl files (default: cwd)
//   KB_REPOS optional comma-list to restrict which repos are searched (default: all discovered)
//
// Self-contained: needs only @ruvector/rvf, @xenova/transformers, and the bundled per-repo files.
// DO NOT use @ruvector/rvf-mcp-server (a non-functional stub). This server joins passages and
// returns real source text from across the ecosystem.

import fs from 'node:fs';
import path from 'node:path';
import { searchAll, discoverRepos, deployedFamilyReposFromQuery } from './forge-ask-all.mjs';
import { warmKnowledgeStores, warmQueryEmbedder } from './forge-ask.mjs';
import { warmReranker } from './forge-rerank.mjs';
import { guardPassages } from './forge-guard-injection.mjs';
import { answerFromCards, renderCardHit } from './card-lane.mjs';
import { implementationNotice } from './implementation-evidence.mjs';
import { describeSearchOutcome } from './search-outcome.mjs';
import { groundedToolResult } from './grounded-response.mjs';

// ── THE GONG (brain-alarm.mjs): a total retrieval failure must NEVER read as "(no results)". ──
// Loaded dynamically + guarded (same pattern as telemetry) so an older bundle without the module
// still serves queries — but when present, all-repos-failing rings health.json + a phone push.
let alarm = null;
import(new URL('./brain-alarm.mjs', import.meta.url).href)
  .then((m) => { alarm = m; })
  .catch(() => { /* module absent (pre-2026-07-12 bundle) — loud in-band error below still fires */ });

// ── TOKEN METER (ADR-0011 token_cost_efficiency): one JSON line per search_ruvnet call recording
// the REAL size (chars) of the response text handed back to the model — appended to the SAME
// user-level ledger the plugin hooks write (~/.cache/ruvnet-brain/token-ledger.jsonl; read it with
// scripts/token-report.mjs). RUVNET_BRAIN_METER=0 disables. Fully guarded: metering must NEVER
// break, delay, or surface into a query — any failure here is swallowed silently.
//
// This wrote to `process.cwd()/.ruvnet-brain/` — and an MCP server inherits its cwd from the Claude
// Code session, so it scattered hidden directories through users' project trees exactly like the
// two shell hooks did (issue #36, mamd69). The reporter found the hooks; this third writer had the
// same bug and was not in their report. Fixing only what was reported would have left the symptom
// alive and made the fix look wrong. The cwd is kept as a FIELD, so per-project analysis survives
// without writing anything into a project.
function meterLog(entry) {
  try {
    if (process.env.RUVNET_BRAIN_METER === '0') return;
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const dir = process.env.XDG_CACHE_HOME
      ? path.join(process.env.XDG_CACHE_HOME, 'ruvnet-brain')
      : path.join(home, '.cache', 'ruvnet-brain');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'token-ledger.jsonl'), JSON.stringify({ ...entry, cwd: process.cwd() }) + '\n');
  } catch { /* never let metering break a query */ }
}

// ── CLEAR THE INSTALL-TIME "grounding: unproven" VERDICT (ADR-058 §D8) ──────────────────────────
// bin/install.mjs writes ~/.cache/ruvnet-brain/install-state.json = { grounding: "unproven" } when
// its own one-shot smoke query couldn't prove grounding at install time (offline, first-run model
// download, etc.) — deliberately NON-FATAL there. "The first real search_ruvnet clears or confirms
// it": once a REAL query from here returns REAL cited passages, there is no more excuse for the
// persisted verdict to still say unproven, so this clears it the same instant.
//
// Same duplication rule as brainOffState() above and for the identical reason: this file ships
// standalone INSIDE the knowledge bundle (a different runtime root than scripts/selfcheck.mjs,
// which owns the canonical read/write pair for --doctor and the installer) — an import reaching out
// to scripts/ would be MODULE_NOT_FOUND on every real install. Path resolution mirrors meterLog()
// immediately above, not scripts/selfcheck.mjs's os.homedir()-based version, because this file has
// no `os` import of its own (see the same convention in brainOffState()).
function markGroundingProven() {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const dir = process.env.XDG_CACHE_HOME
      ? path.join(process.env.XDG_CACHE_HOME, 'ruvnet-brain')
      : path.join(home, '.cache', 'ruvnet-brain');
    const p = path.join(dir, 'install-state.json');
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* nothing recorded yet, or unreadable */ }
    if (prev.grounding === 'proven') return; // already clear — no write, no churn
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ ...prev, grounding: 'proven', clearedBy: 'search_ruvnet', at: new Date().toISOString() }, null, 2));
    fs.renameSync(tmp, p);
  } catch { /* never let this break or delay a real query response */ }
}

// ── THE OFF SWITCH (ADR-054 §2/§3) — read per call, never cached. ───────────────────────────────
// A bare existsSync on ~/.config/ruvnet-brain/brain-off. It is duplicated from scripts/brain-state.mjs
// rather than imported for a hard structural reason: this file ships INSIDE the knowledge bundle,
// and bundle-import-graph.test.mjs proves every static import of a bundled entrypoint resolves
// inside kb/ — an import reaching out to scripts/ would be MODULE_NOT_FOUND on every real install
// (that exact failure has already shipped twice, issue #32). The duplication is held by test, not by
// comment: tests/unit/brain-off.test.mjs drives THIS server against the REAL sentinel path.
//
// Read at CALL time, not at module load. This server is a long-lived warm child; caching the answer
// at boot would mean a mid-session flip did nothing until the next restart, which is exactly the
// failure ADR-054 §4 (per-operation snapshot) rules out.
function brainOffState() {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const dir = process.env.RUVNET_BRAIN_STATE_DIR || path.join(home, '.config', 'ruvnet-brain');
    const file = path.join(dir, 'brain-off');
    // statSync, not existsSync — existsSync returns false (rather than throwing) on EACCES, so an
    // unreadable state dir silently read as "on" and answered as if grounded. Only ENOENT/ENOTDIR
    // mean the user did not switch it off. Same rule as scripts/brain-state.mjs and the hook shim.
    try { fs.statSync(file); }
    catch (e) { if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null; return { off: true, since: null }; }
    let since = null;
    try { since = JSON.parse(fs.readFileSync(file, 'utf8')).since ?? null; } catch { /* contents are metadata */ }
    return { off: true, since };
  } catch { return null; }
}

/**
 * THE SOFT ANSWER. Not an error, not an outage, not an empty result — a deliberate state.
 *
 * Three properties, each load-bearing and each pinned by test:
 *
 *  1. IT TELLS THE MODEL TO TELL THE USER. The model must not silently answer RuvNet questions from
 *     memory while believing it is grounded, and it must not conclude the brain is broken.
 *  2. IT NEVER HANDS THE MODEL THE LEVER. No command, no file path, no setting name, no console
 *     route. An agent-initiated flip is a consent violation (ADR-054 §3); the corresponding wall is
 *     protect-brain-state.sh, and this text is the half of the pair that avoids the temptation
 *     instead of merely refusing it. The user is told what is true; the model is not told how to
 *     undo their choice.
 *  3. IT CARRIES MACHINE-READABLE `disabled: true`. Telemetry, the GONG and the grounding stamp all
 *     have to distinguish "switched off" from "succeeded" and from "broken" — three states, not
 *     two. The plain phrase below is ALSO the marker grounding-stamp.sh matches on (quote-free, so
 *     it survives being JSON-encoded into a PostToolUse payload).
 */
function disabledResult(id, k, state) {
  const body =
    'The RuvNet Brain is disabled — this user switched it off in their own settings'
    + `${state.since ? ` on ${String(state.since).slice(0, 10)}` : ''}. No search was run and no source was retrieved.\n\n`
    + '➡ INSTRUCTION TO THE MODEL: TELL THE USER, plainly and early, that the RuvNet Brain is '
    + 'switched off, so anything you say about rUv\'s ecosystem comes from your own memory and is '
    + 'not grounded in his source. Do NOT present an ungrounded answer as a grounded one, do NOT '
    + 'report this as an outage or a failure, and do NOT try to change the setting or offer to — it '
    + 'is the user\'s to change, not yours.';
  meterLog({ ts: new Date().toISOString(), source: 'mcp', tool: 'search_ruvnet', k, bytes: body.length, disabled: true });
  // isError:false — a state the user chose is not a failure. `disabled` is the field every counter
  // must branch on so a switched-off machine is never scored as either success or outage.
  return ok(id, { content: [{ type: 'text', text: body }], isError: false, disabled: true, _meta: { disabled: true } });
}

const KB_DIR = process.env.KB_DIR || process.cwd();
const REPOS = (process.env.KB_REPOS || '').split(',').map((s) => s.trim()).filter(Boolean);
let discovered = [];
try { discovered = discoverRepos(KB_DIR); } catch { /* dir checked at call time */ }
const repoList = (REPOS.length ? REPOS : discovered);
// Keep MCP readiness below host startup budgets. The self store covers the product's first-use
// questions; larger ecosystem stores initialize on demand under getKb's single-flight cache.
const CORE_WARM_REPOS = ['ruvnet-brain'].filter((name) => repoList.includes(name));

// ── OPT-IN USAGE PINGS (counts only — the full privacy contract lives in telemetry-ping.mjs). ──
// Sends NOTHING unless the user explicitly said yes at install time (consent file), and never
// anything but { event, version, count } — no query text, no repo names, no paths, ever. Batched
// to at most one send per machine per day. Loaded dynamically + fully guarded so a missing module
// (older bundle) or any telemetry failure can never break, block, or delay a query.
// ── THE FOURTH WALL (ADR-055 §3, issue #46) — evidence at retrieval. ────────────────────────────
// The substance writer turns THIS answer's documents into machine-usable facts (packages, install
// commands, the origins the source itself carries, exported symbols, posture in the source's own
// words) and appends one JSON line to the evidence ledger the write-path gate reads. Loaded exactly
// like brain-alarm and telemetry above — dynamic + guarded — for two reasons: an already-installed
// bundle predates this module and must keep answering without it, and evidence capture must never
// break, delay or surface into a query (ADR-055: capped file, swallowed failures).
// build-bundle.mjs understands this `import(new URL(...))` form and ships the module (see its
// localImportsOf; the plain-literal pattern alone would have missed it, as it once missed the GONG).
// NAMED `evidenceWriter`, NOT `evidence`, AND THAT NAME IS LOAD-BEARING. It was `evidence` until
// 2026-07-27, when `searchAll`'s return value — which also has a member called `evidence`, an
// unrelated plain {grade, topScore, caveat} object — was destructured into the SAME BLOCK at line
// ~256 and shadowed it. From that moment `evidence.recordAnswer(...)` at the call site below read
// the plain object, threw TypeError, and was swallowed by the `catch { /* never */ }` that exists
// so evidence capture can never break a query. Net effect: THE SUBSTANCE WRITER WAS DEAD ON EVERY
// PATH and the ledger silently stopped growing, while every test and every gate stayed green —
// the exact shape of the failure ADR-055 was written to end. Two names, two things.
// A malfunction degrades to silence PLUS A HEALTH RECORD — never to silence alone (DDD-0013
// invariant 4). The shadowing bug above threw a TypeError on EVERY answer for a full day and was
// invisible because the catch that guarantees "evidence capture never breaks a query" also
// discarded the reason. Both properties are wanted; only one of them was implemented. This writes
// the diagnosis next to the ledger it failed to write to, capped, best-effort, never surfaced into
// a response — a query must not fail because the failure log failed.
function noteEvidenceFailure(lane, err) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), lane, err: String(err?.message || err).slice(0, 200) });
    const p = path.join(KB_DIR, 'evidence-failures.jsonl');
    if (fs.existsSync(p) && fs.statSync(p).size > 256 * 1024) return;   // capped, like the ledger
    fs.appendFileSync(p, line + '\n');
  } catch { /* the failure log failing must never break a query */ }
}

// KEPT AS A PROMISE, NOT ONLY AS A MUTABLE — the second half of the same bug. The mutable is set
// on a later tick, and the card lane answers in ~0.1ms, so the fast lane RACED the lazy import and
// found `null`: measured live 2026-07-27, a card-lane hit minted nothing even after the shadowing
// was fixed, and nothing was thrown to notice, because `if (writer)` is a silent skip. The heavy
// path never exposed this — 19.6s is an eternity next to a module load, so the race only appeared
// once the lane got fast. Awaiting an already-resolved promise costs a microtask; the fast lane
// measured 0.0242ms p50 and can afford one.
let evidenceWriter = null;
const evidenceReady = import(new URL('./forge-evidence.mjs', import.meta.url).href)
  .then((m) => { evidenceWriter = m; return m; })
  .catch(() => null); /* module absent (pre-2026-07-27 bundle) — the brain answers exactly as before */

let telemetry = null;
let telemetryVersion = 'unknown';
import(new URL('./telemetry-ping.mjs', import.meta.url).href)
  .then((m) => {
    telemetry = m;
    try {
      telemetryVersion = m.bundleVersion(KB_DIR);
      m.recordEvent('session', { version: telemetryVersion });
    } catch { /* telemetry must never surface */ }
  })
  .catch(() => { /* module absent — telemetry silently off */ });

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'ruvnet-brain', version: '1.0.0' };
const TOOLS = [
  {
    name: 'search_ruvnet',
    description:
      'THE authoritative, source-grounded knowledge base for the entire RuvNet ecosystem '
      + `(repos: ${repoList.join(', ') || 'auto-discovered'}). Each result is a whole, self-`
      + 'contained DOCUMENT from rUv\'s REAL source — actual code, ADRs (with shipped-vs-proposed '
      + 'status), DDDs, manifests, source bodies and doc-comments — labeled with the repo + file '
      + 'path it came from. ALWAYS call this before answering ANY question about RuvNet, RuVector, '
      + 'ruflo, AgentDB, RuLake, RuView, RVF, or what any of these repos can do — and before '
      + 'writing code that uses them. Do NOT answer about RuvNet from memory and do NOT assume a '
      + 'capability is missing: if a feature exists, this returns the file that implements it. '
      + 'Cite the returned repo/path. If results show an ADR is "Proposed", say so (design intent, '
      + 'not shipped).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language question or keywords about any part of RuvNet.' },
        k: { type: 'integer', description: 'Number of documents to return (default 6).', default: 6 },
      },
      required: ['query'],
    },
  },
];

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function ok(id, result) { send({ jsonrpc: '2.0', id, result }); }
function err(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notifications
  switch (method) {
    case 'initialize':
      return ok(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: TOOLS });
    case 'brain/warmup':
      await Promise.all([warmQueryEmbedder(), warmReranker()]);
      await warmKnowledgeStores(KB_DIR, CORE_WARM_REPOS);
      return ok(id, { ready: true });
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments || {};
      if (name !== 'search_ruvnet') return err(id, -32602, `unknown tool: ${name}`);
      try {
        const query = String(args.query || '').trim();
        const k = Math.max(1, parseInt(args.k ?? 6, 10) || 6);
        if (!query) return err(id, -32602, 'query is required');
        // BEFORE any retrieval work (ADR-054 §3): no model load, no store read, no telemetry event,
        // no grounded-once stamp. A switched-off brain must be indistinguishable from one that never
        // ran — including in what it costs and in what it counts.
        const offState = brainOffState();
        if (offState) return disabledResult(id, k, offState);
        // ── FAST LANE — FIRST RESPONDER (card-lane.mjs) ─────────────────────────────────────────
        // Tried on EVERY query, BEFORE the heavy cross-repo search below. Zero ML: keyword overlap
        // over kb/capability-cards.md. Measured 2026-07-27: the heavy path (searchAll) costs
        // ~19.6s warm / ~73s cold, almost entirely transformer load/init — while the single most
        // common question this brain answers ("does rUv already ship X? which tool do I reach
        // for?") is fully answered by the capability cards alone. A confident hit here answers in
        // low-single-digit milliseconds and NEVER touches either ONNX model (searchAll below is
        // simply never called). A miss falls straight through to the unchanged heavy path — see
        // card-lane.mjs's header for the honesty contract (silence-or-fallthrough, never a
        // fabricated hit; naming a repo is not by itself sufficient confidence).
        // Heavy-path model revisions are materialized locally by forge-rerank before remote access.
        const namedFamilyRepos = deployedFamilyReposFromQuery(query, KB_DIR, repoList);
        const cardHit = namedFamilyRepos.length
          ? { hit: false, reason: 'named deployed RVF family requires multi-store search' }
          : answerFromCards(query, KB_DIR, { allowGuideAnswers: true });
        if (cardHit.hit) {
          const cardBody = renderCardHit(cardHit);
          // MINT THE RECEIPT ON THIS LANE TOO (ADR-055 §3.1). When the fast lane became the FIRST
          // RESPONDER it started answering most queries — including the capability/package-existence
          // class the founding esm.sh incident came from — and it returned here, well above the only
          // recordAnswer() call in the file. So the write-path gate saw no evidence for precisely the
          // questions it most needs evidence about. "The Brain did its job. I ignored it" was a
          // provable claim again, and the fast lane made it the DEFAULT.
          //
          // A card IS a real cited source with a real path, so it earns a real receipt — not a
          // weaker one. Same success-path scope and same never-break-a-query discipline as the heavy
          // lane: a hit only, wrapped, failures recorded rather than vanished.
          let cardReceipt = null;
          try {
            const w = await evidenceReady;   // resolved-promise await, not a hopeful mutable read
            if (w) {
              cardReceipt = w.recordAnswer({
                query,
                repos: [cardHit.repo],
                results: [{ repo: cardHit.repo, path: cardHit.path, text: cardBody, score: cardHit.coverage }],
              });
            }
          } catch (e) { noteEvidenceFailure('card-lane', e); }
          markGroundingProven();   // a cited card answer is a real grounded answer (ADR-058 §D8)
          meterLog({ ts: new Date().toISOString(), source: 'mcp', tool: 'search_ruvnet', k, bytes: cardBody.length, cardLane: true });
          return ok(id, groundedToolResult({
            body: cardBody,
            grounding: cardReceipt?.sources?.length ? cardReceipt : null,
            extra: {
              cardLane: { repo: cardHit.repo, path: cardHit.path, bodyOverlap: cardHit.bodyOverlap, coverage: cardHit.coverage, namedRepo: cardHit.namedRepo },
            },
          }));
        }
        const {
          results: rawResults,
          repos,
          perRepo,
          corpusAge,
          evidence,
          adrCollision,
          implementation,
          routing,
        } = await searchAll({
          dir: KB_DIR,
          query,
          k,
          repos: REPOS.length ? REPOS : undefined,
          allowFullCorpus: false,
        });
        // ── GONG LAYER 1 (real-time): distinguish "searched fine, found nothing" from "retrieval
        // itself is broken". Every repo erroring is an OUTAGE — report it as one, in-band AND
        // out-of-band, never as an innocent empty result (the 2026-07-12 dark-brain lesson).
        const failedRepos = Object.entries(perRepo || {}).filter(([, v]) => typeof v === 'string' && v.startsWith('ERR:'));
        if (repos.length > 0 && failedRepos.length === repos.length) {
          const firstErr = failedRepos[0][1];
          if (alarm) alarm.reportBrainDown({ error: firstErr, source: 'mcp:search_ruvnet' }).catch(() => {});
          const body =
            `🚨🚨🚨 RUVNET BRAIN IS DOWN — ALL ${repos.length} repos failed to search. 🚨🚨🚨\n\n`
            + `This is NOT an empty result. Retrieval itself is broken; no RuvNet grounding is possible right now.\n`
            + `First error: ${firstErr}\n\n`
            + `Most likely fix:  cd ~/.cache/ruvnet-brain/kb && npm i\n`
            + `Then verify:      npx github:stuinfla/ruvnet-brain --doctor\n\n`
            + `➡ INSTRUCTION TO THE MODEL: tell the user PLAINLY and PROMINENTLY, before anything else, `
            + `that the RuvNet Brain is broken and needs the fix above. Do NOT answer RuvNet questions `
            + `from memory, and do NOT proceed as if this were a normal empty search.`;
          meterLog({ ts: new Date().toISOString(), source: 'mcp', tool: 'search_ruvnet', k, bytes: body.length });
          return ok(id, { content: [{ type: 'text', text: body }], isError: true });
        }
        if (alarm && failedRepos.length === 0) alarm.reportBrainUp({ source: 'mcp:search_ruvnet' }).catch(() => {});
        // SECURITY FLOOR: scan each retrieved passage for prompt-injection right before it leaves
        // the MCP boundary (the highest-value, lowest-risk choke point). A flagged passage is WRAPPED
        // as inert reference data so an autonomous Claude won't execute an instruction injected into
        // an untrusted ingested repo. Exit-safe: guardPassages never throws into the search path.
        const results = guardPassages(rawResults);
        const text = results.map((r, i) =>
          `#${i + 1}  repo=${r.repo}  (relevance ${r.ceScore == null ? 'n/a' : r.ceScore.toFixed(3)}; vec ${r.bestDistance == null ? 'n/a' : r.bestDistance.toFixed(4)})\n`
          + `path : ${r.repo}/${r.path}\n`
          + `title: ${r.title}\n`
          + `evidence class: ${r.evidenceClass || 'unknown'}${r.lifecycleStatus ? `; lifecycle status: ${r.lifecycleStatus}` : ''}\n`
          + `----- full document (${(r.fullText || '').length} chars, ${r.chunksJoined} chunk(s)${r.truncated ? ', truncated' : ''}) -----\n`
          + `${r.fullText || r.text || ''}\n`
        ).join('\n========================================================\n\n');
        // Partial failure is DEGRADED, not fine: name the dead repos in-band so a hit that "should
        // be there" missing is explainable, and the model can tell the user coverage was reduced.
        const degraded = failedRepos.length
          ? `⚠ DEGRADED SEARCH: ${failedRepos.length}/${repos.length} repos failed (${failedRepos.map(([n]) => n).join(', ')}) — first error: ${failedRepos[0][1].slice(0, 200)}\nResults below cover only the healthy repos. Mention this degradation to the user.\n\n`
          : '';
        // Staleness caveat (issue #31, Jan Lafko): the brain is a periodic SNAPSHOT — say so on every
        // response, with the queried stores' real ages, so a model never quotes a version/dist-tag as
        // if the corpus were live. Derived from store-file mtimes (searchAll.corpusAge), never guessed.
        const age = corpusAge;
        const staleness = age
          ? `Corpus snapshot ages: newest store ${age.newestDays}d old, oldest ${age.oldestDays}d (${age.oldestRepo}). Version/"latest" facts may trail live npm/GitHub — for currency claims, verify against the live registry before asserting.\n\n`
          : '';
        // EVIDENCE GRADE — the single most important line when coverage is thin. A user reported
        // that "every shallow sweep concluded, wrongly, that we'd have to build it ourselves": a
        // weak result set was formatted identically to a strong one, so the reading model supplied
        // the missing conclusion itself — and it supplied the expensive wrong one. Absence of
        // retrieval is not absence of code, and the tool now says so IN BAND rather than leaving it
        // to be inferred. Placed BEFORE the results so it caveats everything below.
        const evidenceNote = evidence?.caveat
          ? `⚠ EVIDENCE: ${evidence.grade.toUpperCase()} (top relevance ${evidence.topScore}). ${evidence.caveat}\n`
            + (evidence.droppedIrrelevant > 0
              ? `${evidence.droppedIrrelevant} further result(s) were judged irrelevant by the reranker and WITHHELD rather than padded in.\n`
              : '')
            + `➡ INSTRUCTION TO THE MODEL: do not tell the user this capability does not exist. Say coverage is thin, and try a narrower or artifact-named query first.\n\n`
          : '';
        // Same discipline for cross-repo ADR-number collisions (issue #33 Part B).
        const adrNote = adrCollision ? `⚠ ${adrCollision.note}\n\n` : '';
        // ISSUE #132 — "Searched 0 RuvNet repos ()" IS NOT WHAT HAPPENED, AND IT READS AS THE ONE
        // THING THIS TOOL MUST NEVER IMPLY: that the user's brain is empty.
        //
        // When the capability-card router declines (ambiguous cards, nothing over threshold), no
        // search is run at all — `repos` is empty because NOTHING WAS CONSULTED, not because nothing
        // matched. Rendered through the normal banner that became "Searched 0 RuvNet repos ()"
        // followed by "nothing in the corpus matched this query", which a reader correctly parses as
        // an empty installation. The reporter concluded exactly that and told their user twice, on a
        // machine holding 1.5 GB across 30+ working repos.
        //
        // Absence of routing is not absence of corpus — the same distinction the evidence grade and
        // the GONG already make for thin coverage and for outages. So the declined case gets its own
        // sentence, and it states the corpus size, which makes the wrong reading impossible rather
        // than merely less likely. The wording lives in kb/search-outcome.mjs because this file
        // starts a server on import, so nothing here can be asserted by a test that reads it.
        const { declined, header, emptyBody } = describeSearchOutcome({
          repos, routing, staleness, installedRepoCount: repoList.length,
        });
        const truthNote = implementationNotice(implementation);
        const body = text
          ? degraded + header + adrNote + truthNote + evidenceNote + text
          : degraded + header + adrNote
            + truthNote
            // `emptyBody` is chosen by the same call that chose the header, so the two halves of the
            // message can never disagree about which event they are describing.
            + emptyBody;
        meterLog({ ts: new Date().toISOString(), source: 'mcp', tool: 'search_ruvnet', k, bytes: body.length });
        // Local grounded-once stamp (never leaves the machine) + opt-in count ping. Guarded:
        // telemetry can never break or delay the response being returned right below.
        try {
          if (telemetry) {
            telemetry.stampGroundedOnce();
            telemetry.recordEvent('search', { version: telemetryVersion });
          }
        } catch { /* never */ }
        // ── SUBSTANCE (ADR-055 §3.1). THE SUCCESS PATH, AND ONLY THE SUCCESS PATH. ───────────────
        // Every non-answer returned BEFORE this point and minted nothing: the switched-off soft
        // answer (line ~190), the GONG outage, the thrown error in the catch below, and the empty
        // result — which reaches here but carries `results.length === 0`, so buildReceipt produces
        // no sources and appendEvidence writes no line. That is the same discipline
        // grounding-stamp.sh had to learn (ADR-054 §3), stated once and replayed by
        // tests/unit/fourth-wall.test.mjs T4 for all five shapes.
        let receipt = null;
        // The catch stays total — evidence capture must never break a query — but it no longer
        // swallows the diagnosis. A malfunction degrades to silence PLUS A HEALTH RECORD
        // (DDD-0013 invariant 4); silence alone is how this went unnoticed for a day.
        try {
          const w = await evidenceReady;
          if (w) receipt = w.recordAnswer({ query, repos, results });
        } catch (e) { noteEvidenceFailure('heavy', e); }
        // ADR-058 §D8: a REAL cited answer (results.length > 0, not the "no results" branch above)
        // clears the install-time "grounding: unproven" verdict. Same success-path scope as the
        // receipt line just above — an empty result must never be mistaken for proof.
        if (results.length > 0) markGroundingProven();
        return ok(id, groundedToolResult({
          body,
          grounding: receipt?.sources?.length ? receipt : null,
          implementation,
          extra: routing ? { routing } : {},
        }));
      } catch (e) {
        const body = `search_ruvnet error: ${e.message}`;
        // k re-derived: the try-block's `k` is out of scope here, and an error response is still
        // injected context — it counts.
        meterLog({ ts: new Date().toISOString(), source: 'mcp', tool: 'search_ruvnet', k: Math.max(1, parseInt(args.k ?? 6, 10) || 6), bytes: body.length });
        return ok(id, { content: [{ type: 'text', text: body }], isError: true });
      }
    }
    default:
      return err(id, -32601, `method not found: ${method}`);
  }
}

let buf = '';
let inFlight = 0;
let ended = false;
function maybeExit() { if (ended && inFlight === 0) process.exit(0); }
// Orphan guard: if the parent (the plugin proxy / Claude Code) is force-quit, our stdin may never
// EOF, leaving this model-laden server (~0.5 GB) resident forever — observed as multi-hour orphans.
// Re-parenting to PID 1 (launchd/init) means the parent is gone, so exit. Unref'd so it never keeps
// the event loop alive on its own (normal stdin-'end' exit still applies).
const orphanGuard = setInterval(() => { if (process.ppid === 1) process.exit(0); }, 30000);
orphanGuard.unref();

// IDLE EXIT (issue #122). The orphan guard above only fires on reparent-to-init, so a parent that
// is ALIVE BUT IDLE left this server resident indefinitely. The reporter measured four concurrent
// instances at 3.7 / 3.3 / 3.0 / 15.7 GB — ~25 GB held by sessions that had gone quiet, each having
// burned ~5 CPU-minutes warming an embedder, a cross-encoder and the knowledge stores.
//
// This is safe to do BECAUSE THIS PROCESS IS NOT THE MCP SERVER. plugin/mcp/server.mjs is what the
// host speaks to; it stays alive, answers initialize/tools/list itself, and owns ensureChild(),
// which respawns this worker on the next call (server.mjs:260 already relies on exactly that after
// a timeout kill). So exiting when idle costs one warm-up on the next query and returns gigabytes
// in the meantime — the host never sees a dropped server.
//
// Never exits mid-request: `inFlight` must be zero, and any traffic resets the clock.
const IDLE_EXIT_MS = Number(process.env.RUVNET_BRAIN_IDLE_EXIT_MS ?? 15 * 60_000);
let lastActivity = Date.now();
export const noteActivity = () => { lastActivity = Date.now(); };
if (IDLE_EXIT_MS > 0) {
  const idleGuard = setInterval(() => {
    if (inFlight > 0) { lastActivity = Date.now(); return; }
    if (Date.now() - lastActivity < IDLE_EXIT_MS) return;
    // stderr, not stdout: stdout is the JSON-RPC channel and a stray line would corrupt a reply.
    const forHuman = IDLE_EXIT_MS >= 60_000 ? `${Math.round(IDLE_EXIT_MS / 60_000)}m` : `${Math.round(IDLE_EXIT_MS / 1000)}s`;
    process.stderr.write(`[ruvnet-brain] worker idle ${forHuman} — exiting to release memory; it respawns on the next query.\n`);
    process.exit(0);
  // Poll at half the budget (capped at 30s) so a short budget is actually observable — a guard
  // that only ticks every 30s cannot be tested with a 3s budget, and an untestable guard is one
  // nobody can prove still works.
  }, Math.max(250, Math.min(30_000, Math.floor(IDLE_EXIT_MS / 2))));
  idleGuard.unref();
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    inFlight++;
    noteActivity();   // any traffic resets the idle-exit clock (#122)
    Promise.resolve(handle(m))
      .catch((e) => { if (m && m.id != null) err(m.id, -32603, e.message); })
      .finally(() => { inFlight--; maybeExit(); });
  }
});
process.stdin.on('end', () => { ended = true; maybeExit(); });
process.stderr.write(`forge-mcp-all: serving RuvNet brain (${repoList.join(', ') || 'auto'}) from ${path.resolve(KB_DIR)}\n`);
