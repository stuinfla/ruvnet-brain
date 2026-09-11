// advocacy-catalog.mjs — the CLOSED taxonomy of ordinary-request intents, each bound to exactly ONE
// RuvNet building block that serves it. Data only: no IO, no regex execution, no policy.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS AND WHY IT IS NOT A SECOND goal-match.mjs.
//
// goal-match.mjs already classifies prompts, and duplicating it would be the "hand-rolled substitute"
// failure this repo has a CI gate against. It is not duplicated here because the two answer different
// questions over disjoint inputs, and the measured evidence for that is in goal-match.mjs itself:
//
//   1. ITS TAXONOMY IS ABOUT THE ASSISTANT, NOT ABOUT THE WORK. Every GOALS entry is reverse-derived
//      from a dormant capability's `whatItBuysYou` — "you are re-teaching me the same rule", "work is
//      not surviving between sessions". Those are complaints about the harness. "Search these docs by
//      meaning" is a complaint about nothing; it is a BUILD REQUEST, and goal-match has no goal for it.
//   2. ITS GLOBAL_VETO REJECTS EXACTLY THIS TRAFFIC. goal-match.mjs:110-113 vetoes any prompt
//      containing `production`, `customers`, `deploy`, `api key`, `sdk` — on purpose, because those
//      mark app work rather than harness work. Two of the six scenarios this route exists to serve
//      ("opening this chatbot to customers next week", "our LLM bill doubled") are vetoed on their
//      first noun. Widening that veto would break goal-match's own contract.
//   3. ITS `serves` NAMES MACHINE-STATE KEYS, NOT BUILDING BLOCKS. `cheap-model-routing`,
//      `write-gates`, `session-capture` are rows in capability-registry.auditAll() — things that are
//      installed and switched off. agentic-qe, @claude-flow/aidefence and ruvector are not rows there
//      and are frequently not installed at all, so anticipate.sh's SILENCE RULE 1 ("only state 'off'
//      ever speaks; 'absent' is silent — nothing to switch on") makes them unreachable BY DESIGN.
//
// So: anticipate.sh answers "what have you already got that is switched off?" and this catalogue
// answers "what does rUv already ship that would materially help THIS request?". Same channel, same
// runtime, same ledger, same dial — different question, different corpus. Nothing is re-implemented:
// suppression is advocacy-outcomes.mjs, delivery is unprompted-runtime.mjs, and the prose each
// capability is described by is the hand-written card in kb/capability-cards.md.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE GROUNDING RULE, MECHANICAL. Every `card` below MUST exist as a `## <card>` heading in
// kb/capability-cards.md, and tests/unit/advocacy-catalog.test.mjs fails if one does not. That is why
// this file can name a capability at all: the claim is not "I remember this package", it is "this
// repo's own grounded card describes it". `nextAction` and `undo` strings were verified LIVE on
// 2026-09-11 against the installed tools, and each carries the command that proved it:
//
//   aqe --help / aqe coverage --help / aqe quality --help   → coverage --gaps --risk, quality --gate,
//                                                             quality-gate, test schedule (flaky
//                                                             tracking is on unless --no-flaky)
//   ruflo hooks --help / ruflo hooks model-route --help     → "Route task to optimal Claude model
//                                                             (haiku/sonnet/opus) based on complexity"
//   node -e "import('@claude-flow/aidefence')"               → v3.0.3, exports createAIDefence,
//                                                             isSafe, checkThreats
//   ls ~/.npm-global/lib/node_modules/@ruvector/             → rvf, rvf-node, rvf-mcp-server present
//   agentic-flow --help                                      → v2.1.2, `proxy`, multi-provider
//
// NOT verified and therefore NOT claimed anywhere below: "QE-Court" (no such `aqe` subcommand; the
// nearest verified things are `aqe arena` tournaments and the `aqe-court-referee` binary, which this
// file does not describe because its interface was not checked).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One entry per building block. Fields, and why each is required:
 *   id           the ledger's finding identity suffix and the word the user says back ("use <id>")
 *   card         the `## <heading>` in kb/capability-cards.md this claim is grounded in (TESTED)
 *   benefit      ONE clause naming a concrete outcome for the requesting task — never a feature list
 *   nextAction   a SAFE, read-only or additive first step, verified live (see the header)
 *   undo         the inverse. `human-only` where no single command reverses it — never a fabricated one
 *   probe        { pkgs, bins } used for a cheap, in-process availability read. Absence ⇒ 'unknown',
 *                never 'absent': we can see one npm root and a cwd, not nvm/pnpm/volta/yarn/bun.
 */
export const CAPABILITIES = Object.freeze({
  ruvector: Object.freeze({
    id: 'ruvector',
    card: 'ruvector',
    benefit: 'it indexes those docs as embeddings in one portable .rvf file and answers by meaning with HNSW nearest-neighbour search, locally, with no hosted vector database',
    nextAction: 'npm i @ruvector/rvf, then RvfDatabase.create(...) over a sample of the docs',
    undo: 'delete the .rvf file — nothing else is touched',
    probe: Object.freeze({ pkgs: ['@ruvector/rvf', '@ruvector/rvf-node', 'ruvector'], bins: ['ruvector'] }),
  }),
  agentdb: Object.freeze({
    id: 'agentdb',
    card: 'agentdb',
    benefit: 'it gives the agent durable structured memory that survives process restarts, with graph relationships and explainable recall instead of a re-read of the whole transcript',
    nextAction: 'agentdb --help to see the store/recall surface before wiring anything',
    undo: 'delete the store file — it is a single local database',
    probe: Object.freeze({ pkgs: ['agentdb', '@claude-flow/memory'], bins: ['agentdb'] }),
  }),
  ruflo: Object.freeze({
    id: 'ruflo',
    card: 'ruflo',
    benefit: 'it runs those reviewers as one coordinated swarm in parallel with shared memory, so their findings land in a single tracked place instead of four disconnected transcripts',
    nextAction: 'ruflo swarm init --topology hierarchical, then ruflo agent spawn per reviewer',
    undo: 'ruflo swarm shutdown',
    probe: Object.freeze({ pkgs: ['ruflo'], bins: ['ruflo'] }),
  }),
  aidefence: Object.freeze({
    id: 'aidefence',
    card: 'aidefence',
    benefit: 'AIMDS screens inbound prompts and outbound model output for jailbreaks, injection and PII before either reaches a customer, which is the layer a customer-facing chatbot is missing',
    nextAction: 'npm i @claude-flow/aidefence, then createAIDefence({ enableLearning: true }) on the inbound path',
    undo: 'remove the middleware call — it is additive and holds no state you depend on',
    probe: Object.freeze({ pkgs: ['@claude-flow/aidefence'], bins: [] }),
  }),
  'agentic-qe': Object.freeze({
    id: 'agentic-qe',
    card: 'agentic-qe',
    benefit: 'it reports risk-weighted coverage gaps and tracks flaky tests, and its quality gate returns a real pass/fail verdict instead of a coverage percentage nobody trusts',
    nextAction: 'aqe coverage --gaps --risk (read-only), then aqe quality --gate',
    undo: 'nothing to undo — both commands are read-only reports',
    probe: Object.freeze({ pkgs: ['agentic-qe'], bins: ['aqe'] }),
  }),
  'agentic-flow': Object.freeze({
    id: 'agentic-flow',
    card: 'agentic-flow',
    benefit: 'it routes each request to the cheapest model that can still do it, per task rather than per project, so the simple majority stops being billed at top-tier rates',
    nextAction: 'ruflo hooks model-route -t "<a real task>" to see the haiku/sonnet/opus split before changing anything',
    undo: 'stop calling the router — routing is advisory and changes no stored state',
    probe: Object.freeze({ pkgs: ['agentic-flow'], bins: ['agentic-flow'] }),
  }),
  rulake: Object.freeze({
    id: 'rulake',
    card: 'rulake',
    benefit: 'it caches vector reads in front of the store so repeated lookups return in sub-millisecond time and the hit ratio tunes itself as the query mix settles',
    nextAction: 'query the rulake MCP tool rulake_query once against the existing index and compare latency',
    undo: 'stop routing reads through the cache — the underlying store is unchanged',
    probe: Object.freeze({ pkgs: ['rulake', 'rulake-mcp'], bins: ['rulake'] }),
  }),
});

/**
 * INTENTS — a closed list. Each entry binds a described need to ONE capability.
 *
 * WHY CLOSED, AND WHY THIS SHORT. Six of these seven exist because a real host, in a measured test on
 * 2026-09-10, was handed that exact request and either took 15 minutes to answer or never named the
 * capability at all. The seventh (vector-cache) is the one adjacent case whose card and MCP tool were
 * both verifiable in the same pass. An intent nobody has been measured missing is a guess about a user,
 * and a guess that speaks is the nag ADR-028 exists to prevent — so the list grows on evidence only.
 *
 * `cues` are LEXICAL and IN-PROCESS on purpose (no embedder, no child process, no network, no
 * search_ruvnet at prompt time): an embedder's cold init alone is ~3 s against a 3 s hook timeout, so
 * a semantic matcher here would not be a better matcher, it would be a dead one. Grounding is not
 * skipped, it is MOVED: the model is instructed by SKILL.md to confirm with search_ruvnet before it
 * builds, and this file's claims are pinned to kb/capability-cards.md by a test.
 *
 * TWO CUES, NOT ONE — the same rule goal-match.mjs sets out and for the same reason: "One cue is a
 * coincidence. Two is a statement." A single keyword hit is how a recommender becomes a nag.
 */
export const INTENTS = Object.freeze([
  Object.freeze({
    id: 'semantic-search',
    capability: 'ruvector',
    fit: 'the request is to retrieve by meaning rather than by literal match',
    cues: Object.freeze([
      /\bby meaning\b/,
      /\bsemantic(ally)?\s+(search|retriev|match|similar)/,
      /\b(instead of|rather than|not just|beyond)\s+(an?\s+)?(exact\s+)?(keywords?|string|substring|literal|grep)/,
      /\bvector\s+(search|database|db|store|index|embedding)/,
      /\bembeddings?\b/,
      /\b(nearest[- ]neighbou?r|hnsw|similarity search)\b/,
      /\b(pinecone|qdrant|weaviate|chroma|pgvector|faiss)\b/,
      /\b(rag|retrieval[- ]augmented)\b/,
      /\bfind\s+\w*\s*(similar|related)\s+(docs?|documents?|passages?|chunks?|notes?)\b/,
    ]),
  }),
  Object.freeze({
    id: 'agent-memory',
    capability: 'agentdb',
    fit: 'the request is for state that outlives a single run of the agent',
    cues: Object.freeze([
      /\bforg(et|ets|etting|ot)\b/,
      /\b(durable|persistent|long[- ]term)\s+memory\b/,
      /\b(between|across)\s+(runs?|sessions?|invocations?|restarts?|conversations?)\b/,
      /\b(remembers?|recalls?)\s+\w*\s*(across|between|later|next time)\b/,
      /\bagent\s+(state|memory)\b/,
      /\bstarts?\s+(over|from scratch)\s+(each|every)\b/,
      /\bno memory\b/,
    ]),
  }),
  Object.freeze({
    id: 'multi-agent-orchestration',
    capability: 'ruflo',
    fit: 'the request is for several agents working at once whose output has to come back together',
    cues: Object.freeze([
      /\b(multiple|several|many|a team of|a fleet of|\d+)\s+(ai\s+|llm\s+)?(agents?|reviewers?|workers?|bots?|models?)\b/,
      /\bin parallel\b/,
      /\bswarms?\b/,
      /\borchestrat(e|es|ing|ion)\b/,
      /\b(coordinate|coordinating)\s+(the\s+)?(agents?|workers?|sub-?agents?|reviewers?)\b/,
      /\bsub-?agents?\b/,
      /\b(merge|combine|aggregate|consolidate)\s+\w*\s*(findings|results|reports|reviews|output)\b/,
    ]),
  }),
  Object.freeze({
    id: 'llm-safety',
    capability: 'aidefence',
    fit: 'the request exposes a model to untrusted users and needs the input/output boundary defended',
    cues: Object.freeze([
      /\bjail[- ]?break/,
      /\bprompt injection\b/,
      /\bleak(s|ing|age|ed)?\b/,
      /\b(pii|personally identifiable)\b/,
      /\b(chat ?bot|assistant|llm|model|ai)\b[^.!?]{0,60}\b(customers?|end users?|the public|publicly)\b/,
      /\bguard ?rails?\b/,
      /\b(sanitis|sanitiz|filter|screen)\w*\s+(the\s+)?(prompts?|inputs?|outputs?|responses?)\b/,
      /\bother\s+(customers?|users?|tenants?)'?s?\s+data\b/,
      /\b(red[- ]?team|abuse|malicious)\s+(prompt|input|user)/,
    ]),
  }),
  Object.freeze({
    id: 'test-quality',
    capability: 'agentic-qe',
    fit: 'the request is to make the test suite trustworthy rather than merely larger',
    cues: Object.freeze([
      /\bflak(y|iness|ey)\b/,
      /\bun-?tested\b/,
      /\bcoverage\b/,
      /\bquality gates?\b/,
      /\btest (suite|gaps?|debt)\b/,
      /\b(generate|write|add)\s+\w*\s*tests?\b/,
      /\bwhat'?s? (not |un)tested\b/,
    ]),
  }),
  Object.freeze({
    id: 'llm-cost',
    capability: 'agentic-flow',
    fit: 'the request is to lower model spend without lowering output quality',
    cues: Object.freeze([
      /\b(llm|ai|api|token|model|inference)\s+(bill|costs?|spend(ing)?)\b/,
      /\b(cut|reduce|lower|halve|shrink)\s+(the\s+|our\s+|my\s+)?(cost|costs|spend|spending|bill)\b/,
      /\btoo expensive\b/,
      /\bcheaper model\b/,
      /\b(bill|cost|spend|spending)\s+\w*\s*(doubled|tripled|exploded|out of control)\b/,
      /\bmost\s+(requests?|calls?|prompts?|tasks?|queries)\s+are\s+(simple|trivial|easy|basic)\b/,
      /\bper[- ]token\b/,
    ]),
  }),
  Object.freeze({
    id: 'vector-cache',
    capability: 'rulake',
    fit: 'the request is that repeated retrieval over an existing index is too slow',
    cues: Object.freeze([
      /\b(same|repeated|identical|duplicate)\s+(quer(y|ies)|lookups?|searches?|retrievals?)\b/,
      /\bcach\w+[^.!?]{0,40}\b(vector|embedding|retrieval|search|lookup)\b/,
      /\b(vector|embedding|semantic)\s+(search|quer(y|ies)|lookups?)[^.!?]{0,40}\b(slow|latency|expensive|costly)\b/,
      /\bsub-?millisecond\b/,
      /\bcache hit ?(rate|ratio)\b/,
    ]),
  }),
]);

/** Two cues, never one — see the INTENTS note above. Exported so a test can pin the threshold. */
export const MIN_CUES = 2;
