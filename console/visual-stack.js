/* RuvNet Brain Console — 15-Concept Plain-English Animated Visual Encyclopedia ("How it works")
 * Clean category filter pills + pure CSS-animated SVGs (zero JS animation loops)
 * + Without it / With RuvNet comparisons + real ElevenLabs George voice with Pause/Resume/Stop. */
(() => {
  const CATEGORIES = [
    { id: 'all', label: 'All 15 concepts' },
    { id: 'memory', label: 'Memory & Search' },
    { id: 'agents', label: 'Agents & Swarms' },
    { id: 'learning', label: 'Self-Learning & Routing' },
    { id: 'edge', label: 'Security, Edge & Sensing' },
  ];

  const CONCEPTS = [
    {
      id: 'ruvector', cat: 'memory',
      kicker: '1 · INSTANT LOCAL SEARCH',
      title: 'RuVector — sub-millisecond vector search in one local file',
      status: 'Active · 213 libraries', tone: 'green',
      plain: 'Replaces cloud vector databases and Docker with a single fast .rvf file on your Mac. Its highway-style map (HNSW) jumps straight to the exact meaning you need in under 1 millisecond.',
      beforeAfter: {
        before: 'Pay monthly for Pinecone/cloud DB, run Docker containers, and wait on network round-trips.',
        after: 'One portable binary file on disk, under 1 ms search, zero monthly bill, works offline.',
      },
      actionLabel: 'See 213 libraries →', actionTab: 'tools',
      georgeText: 'RuVector replaces cloud vector databases and Docker with a single fast binary file on your computer. It builds an express-highway map of your knowledge so searches finish in under a millisecond, completely offline and at zero monthly cost.',
      svg: `<svg class="vs-svg" viewBox="0 0 420 144" role="img" aria-label="RuVector HNSW diagram">
        <rect x="10" y="44" width="86" height="54" rx="10" class="vs-box"/>
        <text x="53" y="68" text-anchor="middle" class="vs-t-main">Question</text>
        <text x="53" y="83" text-anchor="middle" class="vs-t-sub">plain English</text>
        <path d="M96 71 L148 71" class="vs-flow" stroke="#f0a830"/>
        <rect x="150" y="16" width="126" height="110" rx="14" class="vs-box vs-box-cyan"/>
        <text x="213" y="34" text-anchor="middle" class="vs-t-kicker">RUVECTOR (.rvf)</text>
        <line x1="178" y1="62" x2="213" y2="52" class="vs-edge"/><line x1="213" y1="52" x2="246" y2="68" class="vs-edge"/>
        <line x1="178" y1="62" x2="202" y2="92" class="vs-edge"/><line x1="202" y1="92" x2="246" y2="68" class="vs-edge"/>
        <circle cx="178" cy="62" r="5" class="vs-node vs-n-amber"/><circle cx="213" cy="52" r="6" class="vs-node vs-n-cyan vs-pulse"/>
        <circle cx="246" cy="68" r="5" class="vs-node vs-n-green"/><circle cx="202" cy="92" r="5" class="vs-node vs-n-amber"/>
        <text x="213" y="112" text-anchor="middle" class="vs-t-sub">&lt; 1 ms HNSW map</text>
        <path d="M276 71 L322 71" class="vs-flow" stroke="#5fd38a"/>
        <rect x="324" y="44" width="86" height="54" rx="10" class="vs-box vs-box-green"/>
        <text x="367" y="68" text-anchor="middle" class="vs-t-main">Exact Cite</text>
        <text x="367" y="83" text-anchor="middle" class="vs-t-sub">zero drift</text>
      </svg>`,
    },
    {
      id: 'agenticow', cat: 'memory',
      kicker: '2 · GIT BRANCHES FOR AI MEMORY',
      title: 'AgenticOW — fork 1,000,000 vectors in 162 bytes',
      status: '0.5 ms instant forks', tone: 'cyan',
      plain: 'Want to test a risky change to an agent’s memory without risking production? AgenticOW uses copy-on-write branching to fork a million-item vector store in 162 bytes and half a millisecond — keep it if it wins, throw it away if it fails.',
      beforeAfter: {
        before: 'Copying huge vector databases takes gigabytes and minutes, so nobody experiments safely.',
        after: 'Instant 162-byte memory branches — safe parallel experiments for every user or agent.',
      },
      actionLabel: 'Build with ruPro →', actionTab: 'actualize',
      georgeText: 'AgenticOW gives AI memory the same superpower Git gave source code. Instead of copying gigabytes of vectors to test a risky idea, it forks a million-vector store in just 162 bytes and half a millisecond. If the experiment works, you keep it; if not, you discard it cleanly.',
      svg: `<svg class="vs-svg" viewBox="0 0 420 144" role="img" aria-label="AgenticOW copy-on-write branching diagram">
        <rect x="14" y="46" width="110" height="52" rx="10" class="vs-box vs-box-amber"/>
        <text x="69" y="69" text-anchor="middle" class="vs-t-main">Base Memory</text>
        <text x="69" y="85" text-anchor="middle" class="vs-t-sub">1,000,000 vectors</text>
        <path d="M124 64 C162 40, 186 34, 224 34" class="vs-flow" stroke="#5fd38a"/>
        <path d="M124 80 C162 104, 186 110, 224 110" class="vs-flow" stroke="#5ad6ff"/>
        <rect x="226" y="14" width="176" height="42" rx="10" class="vs-box vs-box-green"/>
        <text x="314" y="34" text-anchor="middle" class="vs-t-main">Branch A · 162 bytes</text>
        <text x="314" y="48" text-anchor="middle" class="vs-t-sub">0.5 ms · keep if better</text>
        <rect x="226" y="88" width="176" height="42" rx="10" class="vs-box vs-box-cyan"/>
        <text x="314" y="108" text-anchor="middle" class="vs-t-main">Branch B · 162 bytes</text>
        <text x="314" y="122" text-anchor="middle" class="vs-t-sub">discard safely if wrong</text>
      </svg>`,
    },
    {
      id: 'agentdb', cat: 'memory',
      kicker: '3 · CURING AI AMNESIA',
      title: 'AgentDB — shared memory across Claude, Codex & Antigravity',
      status: 'Active · 74 projects learning', tone: 'green',
      plain: 'Normally every AI session wakes up with amnesia. AgentDB stores your decisions, architecture, and lessons in one local project database and distills raw notes into reusable patterns any AI host can read immediately.',
      beforeAfter: {
        before: 'Re-explain your project every time you switch models or start a new chat.',
        after: 'Switch between Claude Code, Codex, and Antigravity without losing a single decision.',
      },
      actionLabel: 'Inspect AgentDB →', actionTab: 'memory',
      georgeText: 'AgentDB cures AI amnesia. Instead of re-explaining your project every time you open a new chat or switch between Claude, Codex, and Antigravity, AgentDB keeps one shared local memory per project and distills raw sessions into reusable patterns. Seventy-four projects on your Mac are actively learning this way right now.',
      svg: `<svg class="vs-svg" viewBox="0 0 420 144" role="img" aria-label="AgentDB cross-host memory diagram">
        <rect x="10" y="12" width="92" height="30" rx="8" class="vs-box"/><text x="56" y="31" text-anchor="middle" class="vs-t-main">Claude Code</text>
        <rect x="10" y="57" width="92" height="30" rx="8" class="vs-box"/><text x="56" y="76" text-anchor="middle" class="vs-t-main">OpenAI Codex</text>
        <rect x="10" y="102" width="92" height="30" rx="8" class="vs-box"/><text x="56" y="121" text-anchor="middle" class="vs-t-main">Antigravity</text>
        <path d="M102 27 L166 62" class="vs-flow" stroke="#f0a830"/><path d="M102 72 L166 72" class="vs-flow" stroke="#5ad6ff"/><path d="M102 117 L166 82" class="vs-flow" stroke="#5fd38a"/>
        <circle cx="212" cy="72" r="42" class="vs-ring"/><circle cx="212" cy="72" r="32" class="vs-box vs-box-amber"/>
        <text x="212" y="69" text-anchor="middle" class="vs-t-main">AgentDB</text><text x="212" y="84" text-anchor="middle" class="vs-t-sub">distills</text>
        <path d="M256 72 L314 72" class="vs-flow" stroke="#5fd38a"/>
        <rect x="316" y="42" width="94" height="60" rx="12" class="vs-box vs-box-green"/>
        <text x="363" y="68" text-anchor="middle" class="vs-t-main">Zero Amnesia</text><text x="363" y="84" text-anchor="middle" class="vs-t-sub">shared patterns</text>
      </svg>`,
    },
    {
      id: 'rulake', cat: 'memory',
      kicker: '4 · VERIFIED INSTANT CACHE',
      title: 'RuLake — sub-millisecond vector cache with cryptographic proof',
      status: 'Instant repeat lookups', tone: 'cyan',
      plain: 'When your agents ask similar vector questions hundreds of times an hour, RuLake serves cached answers in microseconds — each paired with a cryptographic witness proving the cached result hasn’t gone stale or drifted.',
      beforeAfter: {
        before: 'Recompute the same expensive vector lookups over and over, or risk stale unverified caches.',
        after: 'Instant read-through vector cache backed by tamper-evident witnesses.',
      },
      actionLabel: 'Build with ruPro →', actionTab: 'actualize',
      georgeText: 'RuLake is a high-speed read-through cache for vector searches. Whenever agents hit the same knowledge repeatedly, RuLake returns the answer in microseconds along with a cryptographic witness proving the answer is still fresh and unaltered.',
      svg: `<svg class="vs-svg" viewBox="0 0 420 144" role="img" aria-label="RuLake verified cache diagram">
        <rect x="14" y="46" width="92" height="50" rx="10" class="vs-box"/>
        <text x="60" y="68" text-anchor="middle" class="vs-t-main">Repeat Ask</text><text x="60" y="83" text-anchor="middle" class="vs-t-sub">1000s / hr</text>
        <path d="M106 71 L156 71" class="vs-flow" stroke="#5ad6ff"/>
        <rect x="158" y="34" width="114" height="74" rx="12" class="vs-box vs-box-cyan"/>
        <text x="215" y="64" text-anchor="middle" class="vs-t-main">RuLake Cache</text><text x="215" y="82" text-anchor="middle" class="vs-t-sub">+ witness hash</text>
        <path d="M272 71 L322 71" class="vs-flow" stroke="#5fd38a"/>
        <rect x="324" y="46" width="84" height="50" rx="10" class="vs-box vs-box-green"/>
        <text x="366" y="68" text-anchor="middle" class="vs-t-main">&lt; 0.2 ms</text><text x="366" y="83" text-anchor="middle" class="vs-t-sub">verified hit</text>
      </svg>`,
    },
    {
      id: 'ruflo-swarms', cat: 'agents',
      kicker: '5 · MULTI-AGENT ORCHESTRATION',
      title: 'Ruflo & Swarms — coordinate specialized agents without drift',
      status: 'Hierarchical · anti-drift', tone: 'amber',
      plain: 'One solo agent trying to architect, code, test, and security-review a big app gets tangled. Ruflo runs a Queen-led hierarchical swarm where specialized Researcher, Architect, Coder, Tester, and Reviewer agents work in parallel under one shared ledger.',
      beforeAfter: {
        before: 'One overloaded chat loses track of requirements and breaks unrelated files.',
        after: 'Specialized parallel agents with clear roles, Raft consensus, and zero silent drift.',
      },
      actionLabel: 'Build with ruPro →', actionTab: 'actualize',
      georgeText: 'Ruflo is the conductor of the orchestra. Instead of asking one single agent to design, code, test, and audit a huge app all at once, Ruflo coordinates a hierarchical swarm of specialists — researcher, architect, coder, tester, and reviewer — working in parallel under one anti-drift ledger.',
      svg: `<svg class="vs-svg" viewBox="0 0 420 144" role="img" aria-label="Ruflo hierarchical swarm diagram">
        <rect x="148" y="10" width="124" height="36" rx="10" class="vs-box vs-box-amber"/>
        <text x="210" y="32" text-anchor="middle" class="vs-t-main">Queen Coordinator</text>
        <path d="M180 46 L72 90" class="vs-flow" stroke="#f0a830"/><path d="M210 46 L210 90" class="vs-flow" stroke="#5ad6ff"/><path d="M240 46 L348 90" class="vs-flow" stroke="#5fd38a"/>
        <rect x="16" y="92" width="112" height="40" rx="9" class="vs-box vs-box-cyan"/><text x="72" y="116" text-anchor="middle" class="vs-t-main">Architect</text>
        <rect x="154" y="92" width="112" height="40" rx="9" class="vs-box"/><text x="210" y="116" text-anchor="middle" class="vs-t-main">Coder</text>
        <rect x="292" y="92" width="112" height="40" rx="9" class="vs-box vs-box-green"/><text x="348" y="116" text-anchor="middle" class="vs-t-main">Tester &amp; QA</text>
      </svg>`,
    },
    {
      id: 'agentic-qe', cat: 'agents',
      kicker: '6 · AUTONOMOUS QUALITY SHIELD',
      title: 'Agentic QE — your app tests, secures & protects itself',
      status: 'Ready to wire via ruPro', tone: 'amber',
      plain: 'Before code ships, Agentic QE dispatches parallel quality agents to find untested paths, scan security boundaries, and predict defect hotspots — blocking broken code before users ever see it.',
      beforeAfter: {
        before: 'Discover broken flows only after deploying to production.',
        after: 'Automated coverage, security, and defect gates catch bugs before code leaves your laptop.',
      },
      actionLabel: 'Wire into project →', actionTab: 'actualize',
      georgeText: 'Agentic QE puts a team of specialist quality agents in front of every release. On every change, it fans out in parallel to find coverage gaps, scan security boundaries, and predict likely defects — catching regressions before anything ships.',
      svg: `<svg class="vs-svg" viewBox="0 0 420 144" role="img" aria-label="Agentic QE parallel quality gate diagram">
        <rect x="12" y="48" width="80" height="48" rx="10" class="vs-box"/><text x="52" y="76" text-anchor="middle" class="vs-t-main">Code Edit</text>
        <path d="M92 62 L154 30" class="vs-flow" stroke="#5ad6ff"/><path d="M92 72 L154 72" class="vs-flow" stroke="#f0a830"/><path d="M92 82 L154 114" class="vs-flow" stroke="#5fd38a"/>
        <rect x="156" y="14" width="104" height="32" rx="8" class="vs-box vs-box-cyan"/><text x="208" y="34" text-anchor="middle" class="vs-t-main">Test Gaps</text>
        <rect x="156" y="56" width="104" height="32" rx="8" class="vs-box vs-box-amber"/><text x="208" y="76" text-anchor="middle" class="vs-t-main">Security</text>
        <rect x="156" y="98" width="104" height="32" rx="8" class="vs-box vs-box-green"/><text x="208" y="118" text-anchor="middle" class="vs-t-main">Defect AI</text>
        <path d="M260 30 L322 66" class="vs-flow" stroke="#5ad6ff"/><path d="M260 72 L322 72" class="vs-flow" stroke="#f0a830"/><path d="M260 114 L322 78" class="vs-flow" stroke="#5fd38a"/>
        <rect x="324" y="44" width="84" height="56" rx="12" class="vs-box vs-box-green"/><text x="366" y="70" text-anchor="middle" class="vs-t-main">Gate ✓</text><text x="366" y="85" text-anchor="middle" class="vs-t-sub">safe ship</text>
      </svg>`,
    },
    {
      id: 'sparc', cat: 'agents',
      kicker: '7 · STRUCTURED AI ENGINEERING',
      title: 'SPARC — five disciplined steps from idea to verified code',
      status: 'Spec → Architecture → Code', tone: 'cyan',
      plain: 'Stops AI from jumping straight into messy code. SPARC walks every non-trivial build through Specification, Pseudocode, Architecture, Refinement (TDD), and Completion — so the finished app actually matches what you meant.',
      beforeAfter: {
        before: 'AI starts coding immediately on wrong assumptions and leaves half-wired spaghetti.',
        after: 'Clear spec and architecture locked first, then surgical test-driven implementation.',
      },
      actionLabel: 'Build with ruPro →', actionTab: 'actualize',
      georgeText: 'SPARC is the five-step engineering discipline that keeps coding agents from winging it. Specification, Pseudocode, Architecture, Refinement with tests, and Completion — so your agent thinks before it codes and proves the result works.',
      svg: `<svg class="vs-svg" viewBox="0 0 420 144" role="img" aria-label="SPARC 5-phase pipeline diagram">
        <rect x="10" y="48" width="68" height="48" rx="9" class="vs-box vs-box-amber"/><text x="44" y="76" text-anchor="middle" class="vs-t-main">Spec</text>
        <path d="M78 72 L92 72" class="vs-flow" stroke="#f0a830"/>
        <rect x="93" y="48" width="68" height="48" rx="9" class="vs-box"/><text x="127" y="76" text-anchor="middle" class="vs-t-main">Pseudo</text>
        <path d="M161 72 L175 72" class="vs-flow" stroke="#5ad6ff"/>
        <rect x="176" y="48" width="68" height="48" rx="9" class="vs-box vs-box-cyan"/><text x="210" y="76" text-anchor="middle" class="vs-t-main">Arch</text>
        <path d="M244 72 L258 72" class="vs-flow" stroke="#5ad6ff"/>
        <rect x="259" y="48" width="68" height="48" rx="9" class="vs-box"/><text x="293" y="76" text-anchor="middle" class="vs-t-main">Refine</text>
        <path d="M327 72 L341 72" class="vs-flow" stroke="#5fd38a"/>
        <rect x="342" y="48" width="68" height="48" rx="9" class="vs-box vs-box-green"/><text x="376" y="76" text-anchor="middle" class="vs-t-main">Done ✓</text>
      </svg>`,
    },
    {
      id: 'x-ruv-io', cat: 'agents',
      kicker: '8 · DECENTRALIZED AGENT FEDERATION',
      title: 'x.ruv.io — open Nostr network where agents share verified claims',
      status: 'Live in Brain · v0.9.2', tone: 'green',
      plain: 'rUv’s live agent-federation hub (ruflo-x-gateway) gives agents cryptographic Nostr identity (NIP-98/42), 12 MCP collaboration tools, and public channels over wss://relay.ruv.io so agents can publish and verify work across machines.',
      beforeAfter: {
        before: 'Every agent is trapped in an isolated silo with no verifiable identity.',
        after: 'Cryptographically signed agent identity and open federation channels across machines.',
      },
      actionLabel: 'Browse x.ruv.io topics →', actionTab: 'tools',
      georgeText: 'x-dot-ruv-dot-io is rUv’s live agent federation gateway. It gives agents cryptographic Nostr identity, twelve MCP collaboration tools, and public relay channels so independent agents can publish, discover, and verify claims across machines.',
      svg: `<svg class="vs-svg" viewBox="0 0 420 144" role="img" aria-label="x.ruv.io Nostr federation diagram">
        <rect x="14" y="22" width="96" height="38" rx="9" class="vs-box"/><text x="62" y="45" text-anchor="middle" class="vs-t-main">Your Agent</text>
        <rect x="14" y="84" width="96" height="38" rx="9" class="vs-box"/><text x="62" y="107" text-anchor="middle" class="vs-t-main">Peer Agent</text>
        <path d="M110 41 L162 66" class="vs-flow" stroke="#f0a830"/><path d="M110 103 L162 78" class="vs-flow" stroke="#5ad6ff"/>
        <rect x="164" y="34" width="114" height="76" rx="12" class="vs-box vs-box-cyan"/>
        <text x="221" y="64" text-anchor="middle" class="vs-t-main">x.ruv.io Relay</text><text x="221" y="82" text-anchor="middle" class="vs-t-sub">NIP-98/42 · 12 MCP</text>
        <path d="M278 72 L322 72" class="vs-flow" stroke="#5fd38a"/>
        <rect x="324" y="44" width="84" height="56" rx="10" class="vs-box vs-box-green"/>
        <text x="366" y="70" text-anchor="middle" class="vs-t-main">Signed</text><text x="366" y="85" text-anchor="middle" class="vs-t-sub">claims</text>
      </svg>`,
    },
    {
      id: 'rsi', cat: 'learning',
      kicker: '9 · RECURSIVE SELF-IMPROVEMENT',
      title: 'RSI — how your Brain & apps get measurably smarter over time',
      status: 'Active · 2,432 guides', tone: 'cyan',
      plain: 'Real self-improvement without hype: (1) Observe real usage, (2) Grade outcomes with hard proof, (3) Promote verified winners into your local RuVector index, and (4) Keep an automatic rollback snapshot so nothing can regress.',
      beforeAfter: {
        before: 'Static software that repeats the exact same mistake on day 100 as day 1.',
        after: 'Every verified win compounds into faster, sharper answers — with one-click rollback.',
      },
      actionLabel: 'See live RSI →', actionTab: 'actualize',
      georgeText: 'Real Recursive Self-Improvement is a disciplined four-step loop: observe real questions, grade answers with hard proof, promote only verified winners into your local RuVector index, and keep a snapshot rollback so nothing can ever degrade the system.',
      svg: `<svg class="vs-svg" viewBox="0 0 420 144" role="img" aria-label="RSI 4-step self-improvement loop">
        <rect x="14" y="16" width="166" height="42" rx="10" class="vs-box vs-box-cyan"/><text x="97" y="41" text-anchor="middle" class="vs-t-main">1. Observe Real Use</text>
        <path d="M180 37 L236 37" class="vs-flow" stroke="#5ad6ff"/>
        <rect x="238" y="16" width="168" height="42" rx="10" class="vs-box vs-box-amber"/><text x="322" y="41" text-anchor="middle" class="vs-t-main">2. Grade With Proof</text>
        <path d="M322 58 L322 84" class="vs-flow" stroke="#f0a830"/>
        <rect x="238" y="86" width="168" height="42" rx="10" class="vs-box vs-box-green"/><text x="322" y="111" text-anchor="middle" class="vs-t-main">3. Promote Winners</text>
        <path d="M238 107 L182 107" class="vs-flow" stroke="#5fd38a"/>
        <rect x="14" y="86" width="166" height="42" rx="10" class="vs-box"/><text x="97" y="111" text-anchor="middle" class="vs-t-main">4. Safe Rollback</text>
        <path d="M97 86 L97 60" class="vs-flow vs-flow-slow" stroke="#5ad6ff"/>
      </svg>`,
    },
    {
      id: 'metaharness', cat: 'learning',
      kicker: '10 · AUTOMATIC MODEL TRAFFIC CONTROL',
      title: 'MetaHarness — right AI model for each task, automatically',
      status: 'Active · 3,914 routes / 7d', tone: 'cyan',
      plain: 'Scores every task in real time: sends simple scans to fast, low-cost models and reserves frontier reasoning models for hard architecture — logging every route so you can see exactly what ran.',
      beforeAfter: {
        before: 'Burn frontier model quota on trivial file checks or constantly switch models by hand.',
        after: 'Automatic fast-vs-frontier routing tracked live by 24h, 7d, 30d, and all-time.',
      },
      actionLabel: 'See live routing →', actionTab: 'metaharness',
      georgeText: 'MetaHarness is your automatic AI traffic controller. Routine tasks go to fast lightweight models while complex architecture escalates to frontier models, and you can inspect all three thousand nine hundred and fourteen routes from this week live in the MetaHarness tab.',
      svg: `<svg class="vs-svg" viewBox="0 0 420 144" role="img" aria-label="MetaHarness routing diagram">
        <rect x="12" y="48" width="82" height="48" rx="10" class="vs-box"/><text x="53" y="76" text-anchor="middle" class="vs-t-main">Your Task</text>
        <path d="M94 72 L146 72" class="vs-flow" stroke="#f0a830"/>
        <polygon points="190,30 234,72 190,114 146,72" class="vs-box vs-box-amber"/><text x="190" y="76" text-anchor="middle" class="vs-t-main">Router</text>
        <path d="M234 62 C265 40, 282 34, 306 34" class="vs-flow" stroke="#5fd38a"/><path d="M234 82 C265 104, 282 110, 306 110" class="vs-flow" stroke="#5ad6ff"/>
        <rect x="308" y="14" width="100" height="42" rx="10" class="vs-box vs-box-green"/><text x="358" y="39" text-anchor="middle" class="vs-t-main">Fast Tier</text>
        <rect x="308" y="88" width="100" height="42" rx="10" class="vs-box vs-box-cyan"/><text x="358" y="113" text-anchor="middle" class="vs-t-main">Frontier</text>
      </svg>`,
    },
    {
      id: 'sona-ewc', cat: 'learning',
      kicker: '11 · LEARNING WITHOUT FORGETTING',
      title: 'SONA & EWC++ — adapt in 0.05 ms without erasing old skills',
      status: 'Neural consolidation', tone: 'cyan',
      plain: 'When normal AI systems learn something new, they often forget what they already knew ("catastrophic forgetting"). SONA + Elastic Weight Consolidation (EWC++) protects proven knowledge while adapting to new patterns in under 0.05 ms.',
      beforeAfter: {
        before: 'Fine-tuning or updating rules breaks older workflows you already relied on.',
        after: 'Non-zero-sum learning: new patterns strengthen the system without erasing validated lessons.',
      },
      actionLabel: 'Inspect AgentDB →', actionTab: 'memory',
      georgeText: 'SONA and EWC-plus-plus solve one of the hardest problems in AI: learning new tricks without forgetting old ones. Elastic Weight Consolidation locks down proven knowledge while letting the system adapt to new patterns in fractions of a millisecond.',
      svg: `<svg class="vs-svg" viewBox="0 0 420 144" role="img" aria-label="SONA and EWC++ non-forgetting diagram">
        <rect x="14" y="20" width="114" height="42" rx="9" class="vs-box vs-box-green"/><text x="71" y="45" text-anchor="middle" class="vs-t-main">Proven Skills 🔒</text>
        <rect x="14" y="82" width="114" height="42" rx="9" class="vs-box vs-box-cyan"/><text x="71" y="107" text-anchor="middle" class="vs-t-main">New Pattern +</text>
        <path d="M128 41 L182 66" class="vs-flow" stroke="#5fd38a"/><path d="M128 103 L182 78" class="vs-flow" stroke="#5ad6ff"/>
        <rect x="184" y="38" width="102" height="68" rx="12" class="vs-box vs-box-amber"/><text x="235" y="68" text-anchor="middle" class="vs-t-main">SONA</text><text x="235" y="84" text-anchor="middle" class="vs-t-sub">EWC++ guard</text>
        <path d="M286 72 L322 72" class="vs-flow" stroke="#5fd38a"/>
        <rect x="324" y="42" width="84" height="60" rx="10" class="vs-box vs-box-green"/><text x="366" y="68" text-anchor="middle" class="vs-t-main">Smarter</text><text x="366" y="84" text-anchor="middle" class="vs-t-sub">0 forgotten</text>
      </svg>`,
    },
    {
      id: 'ruview', cat: 'edge',
      kicker: '12 · CAMERA-FREE WIFI SENSING',
      title: 'RuView — see presence & movement using ordinary WiFi signals',
      status: 'In Brain · RF + AI sensing', tone: 'amber',
      plain: 'RuView analyzes tiny ripples in everyday WiFi radio waves (Channel State Information) to detect human presence, posture, and movement through walls — with zero cameras, zero video recordings, and total privacy.',
      beforeAfter: {
        before: 'Need invasive cameras or expensive lidar hardware to sense occupancy or falls.',
        after: 'Privacy-preserving spatial intelligence from ordinary WiFi signals on edge hardware.',
      },
      actionLabel: 'Browse in Brain →', actionTab: 'tools',
      georgeText: 'RuView is one of rUv’s most futuristic breakthroughs. Instead of cameras, it reads microscopic ripples in everyday WiFi radio waves — called Channel State Information — to understand presence and motion in a room with complete privacy and zero video recording.',
      svg: `<svg class="vs-svg" viewBox="0 0 420 144" role="img" aria-label="RuView WiFi CSI sensing diagram">
        <rect x="14" y="46" width="86" height="52" rx="10" class="vs-box vs-box-cyan"/><text x="57" y="70" text-anchor="middle" class="vs-t-main">WiFi Router</text><text x="57" y="85" text-anchor="middle" class="vs-t-sub">RF waves</text>
        <path d="M100 72 Q132 36, 164 72 T228 72" class="vs-flow" stroke="#5ad6ff"/>
        <rect x="230" y="36" width="86" height="72" rx="12" class="vs-box vs-box-amber"/><text x="273" y="68" text-anchor="middle" class="vs-t-main">RuView</text><text x="273" y="84" text-anchor="middle" class="vs-t-sub">CSI signal AI</text>
        <path d="M316 72 L340 72" class="vs-flow" stroke="#5fd38a"/>
        <rect x="342" y="42" width="68" height="60" rx="10" class="vs-box vs-box-green"/><text x="376" y="68" text-anchor="middle" class="vs-t-main">Spatial</text><text x="376" y="84" text-anchor="middle" class="vs-t-sub">0 cameras</text>
      </svg>`,
    },
    {
      id: 'aimds', cat: 'edge',
      kicker: '13 · AI SECURITY & PROMPT DEFENSE',
      title: 'AIMDS — stop prompt injection & secret leaks at every boundary',
      status: 'Layer 3 of ruPro stack', tone: 'amber',
      plain: 'Wraps your AI app’s inputs and outputs with real-time threat screening (@claude-flow/aidefence) — catching malicious prompt injections, jailbreaks, and accidental PII or API-key leaks before they do damage.',
      beforeAfter: {
        before: 'One cleverly crafted user message or webpage can hijack your agent or leak secrets.',
        after: 'Every inbound prompt and outbound tool result is screened automatically in milliseconds.',
      },
      actionLabel: 'Wire with ruPro →', actionTab: 'actualize',
      georgeText: 'AIMDS is the bodyguard for your AI applications. It screens every inbound prompt and outbound tool result in milliseconds to block prompt-injection attacks and stop passwords, keys, or personal data from ever leaking out.',
      svg: `<svg class="vs-svg" viewBox="0 0 420 144" role="img" aria-label="AIMDS prompt defense diagram">
        <rect x="14" y="46" width="90" height="52" rx="10" class="vs-box"/><text x="59" y="70" text-anchor="middle" class="vs-t-main">User Input</text><text x="59" y="85" text-anchor="middle" class="vs-t-sub">untrusted</text>
        <path d="M104 72 L156 72" class="vs-flow" stroke="#f0a830"/>
        <rect x="158" y="30" width="112" height="84" rx="14" class="vs-box vs-box-amber"/><text x="214" y="66" text-anchor="middle" class="vs-t-main">AIMDS Shield</text><text x="214" y="84" text-anchor="middle" class="vs-t-sub">blocks injections</text>
        <path d="M270 72 L322 72" class="vs-flow" stroke="#5fd38a"/>
        <rect x="324" y="46" width="84" height="52" rx="10" class="vs-box vs-box-green"/><text x="366" y="70" text-anchor="middle" class="vs-t-main">Safe App</text><text x="366" y="85" text-anchor="middle" class="vs-t-sub">0 leaks</text>
      </svg>`,
    },
    {
      id: 'qudag', cat: 'edge',
      kicker: '14 · POST-QUANTUM AGENT NETWORKING',
      title: 'QuDAG — future-proof quantum-safe messaging between nodes',
      status: 'Post-quantum cryptography', tone: 'cyan',
      plain: 'Uses post-quantum cryptography and DAG consensus so messages between agents, devices, and services remain secure even against future quantum computers capable of breaking today’s RSA encryption.',
      beforeAfter: {
        before: 'Standard encryption vulnerable to "harvest now, decrypt later" quantum attacks.',
        after: 'Quantum-resistant cryptographic channels baked in years before mainstream adoption.',
      },
      actionLabel: 'Browse in Brain →', actionTab: 'tools',
      georgeText: 'QuDAG builds post-quantum cryptography straight into agent-to-agent messaging and consensus. Even if future quantum computers break today’s RSA encryption, QuDAG channels are designed to stay secure years ahead of the mainstream.',
      svg: `<svg class="vs-svg" viewBox="0 0 420 144" role="img" aria-label="QuDAG post-quantum mesh diagram">
        <rect x="14" y="46" width="86" height="52" rx="10" class="vs-box vs-box-cyan"/><text x="57" y="76" text-anchor="middle" class="vs-t-main">Node A</text>
        <path d="M100 72 L156 72" class="vs-flow" stroke="#5ad6ff"/>
        <rect x="158" y="34" width="108" height="76" rx="12" class="vs-box vs-box-amber"/><text x="212" y="66" text-anchor="middle" class="vs-t-main">QuDAG</text><text x="212" y="84" text-anchor="middle" class="vs-t-sub">post-quantum</text>
        <path d="M266 72 L322 72" class="vs-flow" stroke="#5fd38a"/>
        <rect x="324" y="46" width="84" height="52" rx="10" class="vs-box vs-box-green"/><text x="366" y="76" text-anchor="middle" class="vs-t-main">Node B 🔒</text>
      </svg>`,
    },
    {
      id: 'ruv-fann', cat: 'edge',
      kicker: '15 · TINY EDGE NEURAL NETWORKS',
      title: 'ruv-FANN — fast Rust & WebAssembly neural nets (zero Python)',
      status: 'Runs on laptops & sensors', tone: 'green',
      plain: 'Need a fast, trainable neural network inside a browser, desktop app, or tiny 256 MB sensor without dragging in gigabytes of Python and PyTorch? ruv-FANN compiles straight to native Rust and WebAssembly.',
      beforeAfter: {
        before: 'Ship a 4 GB Python/PyTorch stack just to run a small local classifier.',
        after: 'Tiny kilobyte-scale Rust/WASM neural networks running natively anywhere.',
      },
      actionLabel: 'Browse in Brain →', actionTab: 'tools',
      georgeText: 'ruv-FANN lets you train and run real neural networks in pure Rust and WebAssembly — no Python, no PyTorch, and no gigabyte containers. It runs right inside a browser tab or a tiny 256-megabyte edge sensor.',
      svg: `<svg class="vs-svg" viewBox="0 0 420 144" role="img" aria-label="ruv-FANN Rust WASM neural net diagram">
        <rect x="14" y="46" width="96" height="52" rx="10" class="vs-box"/><text x="62" y="70" text-anchor="middle" class="vs-t-main">Sensor / App</text><text x="62" y="85" text-anchor="middle" class="vs-t-sub">zero Python</text>
        <path d="M110 72 L162 72" class="vs-flow" stroke="#f0a830"/>
        <rect x="164" y="34" width="104" height="76" rx="12" class="vs-box vs-box-amber"/><text x="216" y="66" text-anchor="middle" class="vs-t-main">ruv-FANN</text><text x="216" y="84" text-anchor="middle" class="vs-t-sub">Rust · WASM</text>
        <path d="M268 72 L322 72" class="vs-flow" stroke="#5fd38a"/>
        <rect x="324" y="46" width="84" height="52" rx="10" class="vs-box vs-box-green"/><text x="366" y="70" text-anchor="middle" class="vs-t-main">Instant AI</text><text x="366" y="85" text-anchor="middle" class="vs-t-sub">on-device</text>
      </svg>`,
    },
  ];

  function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'class') n.className = v;
      else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      n.append(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return n;
  }

  function mountVisualStack() {
    const main = document.getElementById('main');
    if (!main || document.getElementById('card-visual-stack')) return;

    // On-demand 3D WebGPU Stage (mounted hidden until user clicks "3D WebGPU" on any of the 15 cards)
    const stage3dIframe = el('iframe', {
      id: 'vs-3d-iframe',
      title: 'RuvNet 3D WebGPU Interactive Tech Explainer',
      style: 'display:block;width:100%;height:700px;border:0;background:#02050d;',
      allow: 'fullscreen',
    });
    const stage3dFullLink = el('a', {
      href: '/tech-explorer.html',
      target: '_blank',
      rel: 'noopener noreferrer',
      style: 'display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:9px;background:rgba(34,230,255,0.18);border:1px solid rgba(34,230,255,0.5);color:#e6fcff;font-size:12px;font-weight:700;text-decoration:none;',
    }, 'Open Full-Screen 3D ↗');
    const stage3dWrap = el('div', {
      id: 'vs-3d-drawer',
      hidden: true,
      style: 'margin:0 0 18px;border-radius:16px;overflow:hidden;border:1px solid rgba(34,230,255,0.4);background:#02050d;box-shadow:0 18px 50px rgba(0,0,0,0.45);',
    },
      el('div', {
        style: 'display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px;background:rgba(7,13,28,0.95);border-bottom:1px solid rgba(130,180,255,0.18);flex-wrap:wrap;',
      },
        el('span', { style: 'font-family:var(--mono,monospace);font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#22e6ff;' }, 'ON-DEMAND 3D WEBGPU ARCHITECTURE EXPLAINER'),
        el('div', { style: 'display:flex;gap:8px;align-items:center;' },
          stage3dFullLink,
          el('button', {
            type: 'button',
            class: 'btn btn-ghost btn-sm',
            style: 'color:#e6fcff;border-color:rgba(255,255,255,0.22);',
            onclick: () => { stage3dWrap.hidden = true; stage3dIframe.removeAttribute('src'); },
          }, '× Close 3D'))),
      stage3dIframe);

    function open3DFor(conceptId) {
      const url = `/tech-explorer.html?tech=${encodeURIComponent(conceptId)}`;
      stage3dFullLink.setAttribute('href', url);
      stage3dIframe.setAttribute('src', url);
      stage3dWrap.hidden = false;
      stage3dWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    let activeCat = 'all';
    const cardNodes = CONCEPTS.map((c) => {
      const fig = el('div', { class: 'vs-stage' });
      fig.innerHTML = c.svg;
      const ba = c.beforeAfter ? el('div', { class: 'vs-ba' },
        el('div', { class: 'vs-ba-row vs-ba-old' }, el('b', {}, 'Without it: '), c.beforeAfter.before),
        el('div', { class: 'vs-ba-row vs-ba-new' }, el('b', {}, 'With RuvNet: '), c.beforeAfter.after)) : null;

      const speakBtn = el('button', {
        type: 'button',
        class: 'btn btn-ghost btn-sm',
        onclick: () => {
          if (speakBtn.dataset.playing === '1') window.RNBDeck?.togglePause?.();
          else window.RNBDeck?.speak?.(c.georgeText, `vs:${c.id}`);
        },
      }, '🔊 Hear George explain');
      const stopBtn = el('button', {
        type: 'button',
        class: 'btn btn-ghost btn-sm',
        hidden: true,
        onclick: () => window.RNBDeck?.stop?.(),
      }, '■ Stop');
      window.RNBDeck?.onSpeakState?.((st) => {
        const mine = st.speaking && st.key === `vs:${c.id}`;
        speakBtn.dataset.playing = mine ? '1' : '0';
        speakBtn.textContent = mine ? (st.paused ? '▶ Resume' : '⏸ Pause') : '🔊 Hear George explain';
        stopBtn.hidden = !mine;
      });

      const node = el('article', { class: 'vs-card', id: `vs-${c.id}`, 'data-cat': c.cat },
        el('div', { class: 'vs-card-top' },
          el('span', { class: 'vs-kicker' }, c.kicker),
          el('span', { class: `chip tone-${c.tone}` }, c.status)),
        el('h3', { class: 'vs-title' }, c.title),
        fig,
        el('p', { class: 'vs-plain' }, c.plain),
        ba,
        el('div', { class: 'vs-actions' },
          el('button', {
            type: 'button',
            class: 'btn btn-apply btn-sm',
            onclick: () => open3DFor(c.id),
          }, '✦ View in 3D WebGPU'),
          el('button', {
            type: 'button',
            class: 'btn btn-ghost btn-sm',
            onclick: () => window.RNBDeck?.goTab?.(c.actionTab),
          }, c.actionLabel),
          speakBtn,
          stopBtn));
      return node;
    });

    const filterBtns = CATEGORIES.map((cat) =>
      el('button', {
        type: 'button',
        class: `deck-tab${cat.id === 'all' ? ' is-active' : ''}`,
        'data-vscat': cat.id,
        onclick: () => {
          activeCat = cat.id;
          filterBtns.forEach((b) => b.classList.toggle('is-active', b.dataset.vscat === activeCat));
          cardNodes.forEach((card) => {
            card.hidden = activeCat !== 'all' && card.dataset.cat !== activeCat;
          });
        },
      }, cat.label));

    const section = el('section', {
      class: 'card rail-mirror vs-section',
      id: 'card-visual-stack',
      'aria-labelledby': 'vs-heading',
    },
      el('div', { class: 'vs-head' },
        el('div', {},
          el('span', { class: 'stage st-mirror' }, 'Plain-English Visual Guide · 15 Core RuvNet Concepts'),
          el('h2', { id: 'vs-heading' }, 'How the RuvNet magic actually works'),
          el('p', { class: 'vs-sub' }, 'New to RuvNet? Explore all 15 foundational breakthroughs — from RuVector, AgenticOW, and AgentDB to Swarms, RSI, RuView WiFi sensing, AIMDS security, and QuDAG post-quantum networking. Filter by area or click Hear George explain on any card.')),
        el('div', { class: 'deck-tabs', style: 'border-top:none;padding-top:0;margin-bottom:14px;' }, filterBtns)),
      stage3dWrap,
      el('div', { class: 'vs-grid' }, cardNodes));

    const deck = document.getElementById('cmd-deck');
    if (deck && deck.nextSibling) main.insertBefore(section, deck.nextSibling);
    else main.prepend(section);
    window.RNBDeck?.refreshTab?.();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountVisualStack, { once: true });
  } else {
    setTimeout(mountVisualStack, 60);
  }
})();
