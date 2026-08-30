// tests/unit/card-lane.test.mjs — kb/card-lane.mjs: the FAST LANE first responder over
// kb/capability-cards.md (see kb/card-lane.mjs header for the full "measured 19.6s warm / 73s
// cold heavy path" backstory).
//
// RED FIRST — recorded, verbatim, before kb/card-lane.mjs existed:
//
//   $ npx vitest run tests/unit/card-lane.test.mjs
//   Error: Cannot find module '/…/kb/card-lane.mjs' imported from
//     '/…/tests/unit/card-lane.test.mjs'
//    Test Files  1 failed (1)
//
// House rule: "a test that cannot fail on broken code is not a test." The suite below is built to
// prove TWO invariants, each with its own counter-example so neither is vacuous:
//   1. A confidently-covered question gets a real, cited, non-empty answer (positive).
//   2. A question the cards do NOT cover returns hit:false — NEVER a fabricated card (negative,
//      including an ADVERSARIAL near-miss: a question that NAMES a covered repo but asks about a
//      specific feature the card never mentions, which a naive "repo named → confident" rule would
//      wrongly answer).
//
// The representative question set is REAL, first-party material already used to gate by-description
// routing (plugin/test/capability-questions{,.heldout}.json) — not invented for this test.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  parseCards,
  loadCards,
  answerFromCards,
  renderCardHit,
  routeReposFromCards,
} from '../../kb/card-lane.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KB = path.join(REPO, 'kb');
const PRIVATE_STORES = JSON.parse(fs.readFileSync(path.join(KB, 'PRIVATE-STORES.json'), 'utf8')).privateStores;

const QUESTION_SETS = [
  JSON.parse(fs.readFileSync(path.join(REPO, 'plugin/test/capability-questions.json'), 'utf8')),
  JSON.parse(fs.readFileSync(path.join(REPO, 'plugin/test/capability-questions.heldout.json'), 'utf8')),
].flat();

describe('parseCards — the same "## <repo>" shape scripts/build-concepts.mjs reads', () => {
  it('parses the real kb/capability-cards.md into repo/body cards, at least 30 of them', () => {
    const md = fs.readFileSync(path.join(KB, 'capability-cards.md'), 'utf8');
    const cards = parseCards(md);
    expect(cards.length).toBeGreaterThanOrEqual(30);
    const byRepo = Object.fromEntries(cards.map((c) => [c.repo, c.body]));
    expect(byRepo.ruflo).toMatch(/orchestrat/i);
    expect(byRepo.ruvector).toMatch(/HNSW/);
    expect(byRepo.agentdb).toMatch(/graph/i);
  });

  it('never carries a card for a privately-fenced repo — the source file is already curated', () => {
    const md = fs.readFileSync(path.join(KB, 'capability-cards.md'), 'utf8');
    const cards = parseCards(md);
    const leaked = cards.filter((c) => PRIVATE_STORES.includes(c.repo.toLowerCase()));
    expect(leaked.map((c) => c.repo)).toEqual([]);
  });

  it('ignores a malformed section (no repo name) rather than throwing', () => {
    expect(() => parseCards('## \nno repo name here\n## real\nbody text here')).not.toThrow();
    const cards = parseCards('## \nno repo name here\n## real\nbody text here');
    expect(cards).toEqual([{ repo: 'real', body: 'body text here' }]);
  });
});

describe('loadCards — reads capability-cards.md from a bundle dir, honestly absent when missing', () => {
  let tmp;
  it('returns null (never a fabricated empty-but-present card list) when the file is absent', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'card-lane-empty-'));
    expect(loadCards(tmp)).toBeNull();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('parses a real fixture file and memoizes by mtime (cache invalidates on real edit)', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'card-lane-fixture-'));
    const file = path.join(tmp, 'capability-cards.md');
    fs.writeFileSync(file, '## widget\nA thing that widgets. Reach for widget whenever you need widgeting.\n');
    const first = loadCards(tmp);
    expect(first).toHaveLength(1);
    expect(first[0].repo).toBe('widget');

    // same mtime (no write) -> cache hit, same array reference
    expect(loadCards(tmp)).toBe(first);

    // real edit -> cache must invalidate, not serve stale content.
    // The mtime is bumped EXPLICITLY: writing twice in one tick leaves mtimeMs identical on
    // filesystems that quantise it (this went red on CI 2026-07-28 for exactly that reason), so
    // without this the test measures the clock instead of the invalidation it claims to test.
    fs.writeFileSync(file, '## widget\nUpdated body.\n\n## gadget\nA second card.\n');
    const bumped = new Date(Date.now() + 2000);
    fs.utimesSync(file, bumped, bumped);
    const second = loadCards(tmp);
    expect(second).not.toBe(first);
    expect(second.map((c) => c.repo)).toEqual(['widget', 'gadget']);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('answerFromCards — capability claims require implementation evidence', () => {
  const results = QUESTION_SETS.map((q) => ({ q, hit: answerFromCards(q.query, KB) }));

  it('measures and reports the REAL hit fraction on this representative set (no estimate)', () => {
    const hitCount = results.filter((r) => r.hit.hit).length;
    // eslint-disable-next-line no-console
    console.log(`[card-lane] representative set: ${hitCount}/${results.length} answered by the fast lane`);
    for (const r of results) {
      // eslint-disable-next-line no-console
      console.log(`  ${r.hit.hit ? 'HIT ' : 'MISS'} repo=${r.hit.repo || '-'}  "${r.q.query}"`);
    }
    // Curated prose routes work; it does not prove shipped state. Capability questions must take
    // the implementation-bearing source lane even when this costs latency.
    expect(hitCount).toBe(0);
  });

  it('every hit on this set names one of the repos the question itself expects', () => {
    for (const r of results) {
      if (!r.hit.hit) continue;
      expect(r.q.expectRepo, `unexpected hit for "${r.q.query}"`).toContain(r.hit.repo);
    }
  });

  it('a plain "what is <repo> and what does it do" question requires source proof', () => {
    const hit = answerFromCards('What is dspy.ts and what does it do?', KB);
    expect(hit.hit).toBe(false);
    expect(hit.reason).toMatch(/implementation evidence/i);
  });

  it('allows bounded guide answers only when the caller explicitly enables the guide lane', () => {
    const cases = [
      ['Is this a chatbot, a database, or something else?', 'ruvnet-brain'],
      ['How do I open the settings screen?', 'ruvnet-brain'],
      ['What command checks whether my install is healthy?', 'ruvnet-brain'],
      ['What is HNSW doing inside RVF?', 'ruvector'],
      ['What is a witness chain in an RVF file?', 'ruvector'],
      ['What does AgentDB remember that RVF does not?', 'agentdb'],
      ['How do I find code that has weak test coverage?', 'agentic-qe'],
      ['What happens from my question to a cited answer?', 'ruvnet-brain'],
      ['What is the difference between orchestration and memory here?', 'ruflo'],
      ['The native SQLite bridge has the wrong Node ABI. Is fallback good enough?', 'ruflo'],
      ['Does this work in Codex too, or only Claude Code?', 'ruvnet-brain'],
      ['Can I turn the Brain off temporarily?', 'ruvnet-brain'],
      ['Does a green test run prove the npm package works after install?', 'ruvnet-brain'],
      ['Is every capability described in an ADR already available?', 'ruvnet-brain'],
      ['What exact evidence would make you call RuvNet Brain ready to ship?', 'ruvnet-brain'],
    ];
    for (const [query, repo] of cases) {
      expect(answerFromCards(query, KB, { allowGuideAnswers: true }), query).toMatchObject({
        hit: true,
        repo,
      });
    }
  });

  it('never lets the guide lane satisfy current, shipped, exact-source, or release-proof claims', () => {
    const queries = [
      'Is the cross-encoder cascade currently shipped on by default?',
      'Can you prove the release-proof protocol is implemented, not merely proposed?',
      'What exact code path reranks candidates after RVF retrieval?',
      'Is the latest npm package ready to ship?',
      'How should RuvNet Brain enforce an exact-artifact deployment process with GitHub checks and independent graders?',
    ];
    for (const query of queries) {
      const hit = answerFromCards(query, KB, { allowGuideAnswers: true });
      expect(hit.hit, query).toBe(false);
      expect(hit.reason, query).toMatch(/implementation|source/i);
    }
  });

  it('an unnamed, purely DESCRIBED need still resolves to the right repo (no repo named at all)', () => {
    const hit = answerFromCards('what should I reach for to cache repeated vector queries in front of a vector store so lookups come back faster', KB);
    expect(hit.hit).toBe(true);
    expect(hit.repo).toBe('rulake');
  });

  it('ignores generic question scaffolding when selecting structured relationship memory', () => {
    const query = 'I want to keep structured agent state and ask questions about how facts relate to each other.';
    for (const options of [undefined, { allowGuideAnswers: true }]) {
      const hit = answerFromCards(query, KB, options);
      expect(hit).toMatchObject({
        hit: true,
        repo: 'agentdb',
        namedRepo: false,
      });
      expect(hit.text).toMatch(/structured agent state[\s\S]*graph\/relationship/i);
    }
  });

  it('recognizes a session-starts-cold complaint as durable project memory', () => {
    const hit = answerFromCards(
      'Stop my assistant from starting every session cold — carry decisions across sessions.',
      KB,
    );
    expect(hit).toMatchObject({
      hit: true,
      repo: 'ruflo',
    });
    expect(hit.text).toMatch(/project memory survives across sessions[\s\S]*record a decision/i);
  });

  it('recognizes a forgetful support bot as durable explainable memory', () => {
    const hit = answerFromCards(
      'Our support bot forgets everything between sessions and customers repeat themselves; we need memory that survives restarts and can justify its recalls.',
      KB,
    );
    expect(hit).toMatchObject({
      hit: true,
      repo: 'agentdb',
    });
    expect(hit.text).toMatch(/persistent memory that survives across sessions[\s\S]*feature attributions/i);
  });

  it('recognizes generated tests prioritized for risky changed code as agentic quality engineering', () => {
    const hit = answerFromCards(
      'CI takes three hours. We want tests generated and prioritized only for the riskiest changed code.',
      KB,
    );
    expect(hit).toMatchObject({
      hit: true,
      repo: 'agentic-qe',
    });
    expect(hit.text).toMatch(/generate comprehensive tests automatically[\s\S]*risk-weighted analysis/i);
  });

  it('recognizes agents clobbering context as multi-agent coordination with shared state', () => {
    const hit = answerFromCards(
      "Five agents work the same repo and clobber each other's context; we need coordinated roles with shared state.",
      KB,
    );
    expect(hit).toMatchObject({
      hit: true,
      repo: 'ruflo',
    });
    expect(hit.text).toMatch(/coordinate swarms of agents[\s\S]*share state and memory/i);
  });

  it('recognizes a poisoned ingest as isolated branch memory with instant rollback', () => {
    const hit = answerFromCards(
      'Our agent ingests untrusted web content; if an ingest poisons memory we need instant rollback without replaying the whole day.',
      KB,
    );
    expect(hit).toMatchObject({
      hit: true,
      repo: 'agenticow',
    });
    expect(hit.text).toMatch(/sandbox risky ingests/i);
    expect(hit.text).toMatch(/instantly roll back agent memory/i);
  });

  it('recognizes repeated cached vector reads as a witness-verifiable read cache', () => {
    const hit = answerFromCards(
      'The same vector queries hit our store thousands of times an hour; we want cached reads we can cryptographically verify.',
      KB,
    );
    expect(hit).toMatchObject({
      hit: true,
      repo: 'rulake',
    });
    expect(hit.text).toMatch(/vector cache[\s\S]*read cache/i);
    expect(hit.text).toMatch(/witness-anchored[\s\S]*provenance-verifiable retrieval/i);
  });

  it('recognizes a quantum-safe device mesh as post-quantum secure messaging', () => {
    const hit = answerFromCards(
      "Compliance says our device mesh must stay secure even if quantum computers break RSA. What's the comms layer?",
      KB,
    );
    expect(hit).toMatchObject({
      hit: true,
      repo: 'qudag',
    });
    expect(hit.text).toMatch(/quantum-resistant[\s\S]*ML-KEM[\s\S]*ML-DSA/i);
    expect(hit.text).toMatch(/secure messaging between agents/i);
  });

  it('recognizes a workflow complaint as a phased requirements-to-completion method', () => {
    const hit = answerFromCards(
      'The team ships code with no specs and QA finds the gaps too late; we want a phased method with hard gates from requirements to completion.',
      KB,
    );
    expect(hit).toMatchObject({
      hit: true,
      repo: 'sparc',
    });
    expect(hit.text).toMatch(/Specification[\s\S]*Completion/i);
    expect(hit.text).toMatch(/review\/quality gates/i);
  });

  it('recognizes a constrained sensor classifier as low-memory Rust ML without Python', () => {
    const hit = answerFromCards(
      "A sensor box with 256MB RAM needs a small trainable classifier, and we can't ship Python.",
      KB,
    );
    expect(hit).toMatchObject({
      hit: true,
      repo: 'ruv-fann',
    });
    expect(hit.text).toMatch(/small trainable embedded classifier/i);
    expect(hit.text).toMatch(/written in Rust/i);
    expect(hit.text).toMatch(/without shipping Python/i);
  });

  it('recognizes bare-metal tenant partitions as hardware-grade microhypervisor isolation', () => {
    const hit = answerFromCards(
      'Bare-metal box, multiple tenants, strict isolation — we want hypervisor partitions, not containers.',
      KB,
    );
    expect(hit).toMatchObject({
      hit: true,
      repo: 'rvm',
    });
    expect(hit.text).toMatch(/microhypervisor/i);
    expect(hit.text).toMatch(/multi-tenant[\s\S]*hardware-grade isolation/i);
  });
});

describe('answerFromCards — NEGATIVE: silence-or-fallthrough, NEVER a fabricated hit', () => {
  it('an empty query is refused, not guessed', () => {
    expect(answerFromCards('', KB).hit).toBe(false);
    expect(answerFromCards('   ', KB).hit).toBe(false);
  });

  it('a domain-irrelevant question (nothing to do with RuvNet) is not fabricated into a hit', () => {
    const hit = answerFromCards('How do I center a div vertically with CSS flexbox?', KB);
    expect(hit.hit).toBe(false);
  });

  it('a question about a repo that does not exist in this ecosystem at all is not fabricated', () => {
    const hit = answerFromCards('Does RuvNet ship a repo called zephyr-quantum-blockchain for supply chain logistics?', KB);
    expect(hit.hit).toBe(false);
  });

  // A subtler case than the fictional-repo one above: "cognitum-seed" (private, no card of its
  // own) shares the generic word "cognitum" with the PUBLIC "cognitum-cogs" card, whose own prose
  // legitimately discusses Cognitum Seed hardware (cognitum-cogs is the public crate ecosystem FOR
  // it). Measured while writing this suite: an earlier scorer treated the shared word fragment as
  // "the query named cognitum-cogs", which is the wrong kind of match — identity must require the
  // query to contain the repo's WHOLE name, never a shared prefix fragment (see wholeTokens() in
  // card-lane.mjs). This is NOT asserting hit:false here — cognitum-cogs' card is real, public, and
  // genuinely on-topic for "what capabilities does Cognitum Seed ship" (it answers via the public
  // half of the story) — it asserts the SPECIFIC failure mode is gone: a hit here must never be
  // reported as naming a repo the query never actually named.
  it('a generic shared word-fragment (not the whole repo name) does not count as "named"', () => {
    const hit = answerFromCards('What capabilities does the cognitum-seed appliance ship?', KB);
    if (hit.hit) expect(hit.namedRepo).toBe(false);
  });

  // THE ADVERSARIAL CASE. This is the one a naive "the query names a covered repo -> confident"
  // rule gets wrong: AgentDB IS a covered repo, but its card never mentions reinforcement learning,
  // Thompson-Sampling, or bandits. Naming the repo must NOT be sufficient on its own — the card's
  // OWN content must actually speak to what was asked, or this must fall through honestly.
  it('naming a covered repo is NOT enough on its own — the card must speak to the SPECIFIC ask', () => {
    const hit = answerFromCards('Does AgentDB include reinforcement-learning algorithms and a Thompson-Sampling bandit?', KB);
    expect(hit.hit).toBe(false);
  });

  it('even a card-covered capability assertion falls through until the card carries source proof', () => {
    const hit = answerFromCards('Can AgentDB run graph queries over agent memory?', KB);
    expect(hit.hit).toBe(false);
    expect(hit.reason).toMatch(/implementation evidence/i);
  });

  it('scoped package and source-registration questions fall through to implementation evidence', () => {
    for (const query of [
      'What does the @ruvector/rvf TypeScript SDK expose?',
      'How are MCP tools defined and registered in ruflo v3 — where is the code?',
    ]) {
      const hit = answerFromCards(query, KB);
      expect(hit.hit, query).toBe(false);
      expect(hit.reason, query).toMatch(/source|implementation/i);
    }
  });

  it('never lets a named source path terminate in the generic repository card', () => {
    const hit = answerFromCards(
      'ruvnet-brain scripts/nightly-wrapper.sh run_once ingest-new-repos self-update primary checkout worktree',
      KB,
      { allowGuideAnswers: true },
    );
    expect(hit.hit).toBe(false);
    expect(hit.reason).toMatch(/exact path|file query|source retrieval/i);
  });

  it('no card in this bundle ever cites a privately-fenced repo, even under adversarial phrasing', () => {
    for (const term of PRIVATE_STORES) {
      const hit = answerFromCards(`what does ${term} do and how do I use it`, KB);
      if (hit.hit) expect(hit.repo.toLowerCase()).not.toBe(term.toLowerCase());
    }
  });
});

describe('renderCardHit — the answer must be usable and cited on its own', () => {
  it('carries the fast-lane marker, the citation path, the repo, and the full card body', () => {
    const hit = answerFromCards('Which ruflo tool should I use for agent swarm orchestration?', KB);
    expect(hit.hit).toBe(true);
    const text = renderCardHit(hit);
    expect(text).toMatch(/FAST LANE/);
    expect(text).toContain('capability-cards.md');
    expect(text).toContain('ruflo');
    expect(text).toBe(text); // sanity: renders without throwing
    expect(text.length).toBeGreaterThan(hit.text.length); // more than just the bare card body
  });
});

describe('routeReposFromCards — routing never masquerades as a card answer', () => {
  it('routes the Brain product name to its own RVF store', () => {
    const route = routeReposFromCards(
      'How does RuvNet Brain open its Console in Claude Code and Codex?',
      KB,
      ['ruvnet-brain', 'ruflo', 'concepts'],
    );
    expect(route.repos[0]).toBe('ruvnet-brain');
    expect(route.confidence).toBe('named');
    expect(route.repos).toEqual(['ruvnet-brain']);
  });

  it('does not mistake both host integrations for a multi-repo comparison', () => {
    const route = routeReposFromCards(
      'How does RuvNet Brain update both Claude Code and Codex installations?',
      KB,
      ['ruvnet-brain', 'concepts', 'open-claude-code'],
    );
    expect(route.primaryProductScope).toBe(true);
    expect(route.repos).toEqual(['ruvnet-brain']);
  });

  it('keeps RuvNet Brain as the primary product scope when its subsystems are mentioned', () => {
    const route = routeReposFromCards(
      'How should RuvNet Brain enforce releases with Agentic QE, Ruflo, and AgentDB receipts?',
      KB,
      ['ruvnet-brain', 'agentic-qe', 'ruflo', 'agentdb', 'concepts'],
    );
    expect(route.confidence).toBe('named');
    expect(route.primaryProductScope).toBe(true);
    expect(route.namedRepos).toEqual(['ruvnet-brain']);
    expect(route.repos).toEqual(['ruvnet-brain']);
  });

  it('routes the retrieval pipeline to Brain even when the question names RVF', () => {
    const route = routeReposFromCards(
      'Which code path reranks candidates after RVF retrieval?',
      KB,
      ['ruvnet-brain', 'ruvector', 'concepts'],
    );
    expect(route.primaryProductScope).toBe(true);
    expect(route.repos).toEqual(['ruvnet-brain']);
  });

  it('preserves explicitly comparative multi-repo questions', () => {
    const route = routeReposFromCards(
      'Compare RuvNet Brain and Agentic QE release validation',
      KB,
      ['ruvnet-brain', 'agentic-qe', 'concepts'],
    );
    expect(route.namedRepos).toEqual(expect.arrayContaining(['ruvnet-brain', 'agentic-qe']));
    expect(route.repos).toEqual(expect.arrayContaining(['ruvnet-brain', 'agentic-qe']));
    expect(route.primaryProductScope).toBe(false);
  });

  const available = ['agentdb', 'agentic-flow', 'concepts', 'ruflo', 'rulake', 'ruvector'];

  it('does not promote a format alias into a second repo beside an explicit product', () => {
    const cases = [
      [
        "What are AgentDB's core concepts — the .rvf cognitive container, Reflexion episodic memory, causal graph, skill library, ReasoningBank, and the self-learning bandit?",
        'agentdb',
      ],
      [
        "What are RuView's core concepts — CSI (Channel State Information), ESP32 sensors, WiFi-DensePose pose estimation, and RVF cognitive containers?",
        'ruview',
      ],
    ];
    for (const [query, repo] of cases) {
      expect(routeReposFromCards(query, KB, [...available, 'ruview'])).toMatchObject({
        confidence: 'named',
        namedRepos: [repo],
        repos: [repo],
      });
    }
  });

  it('keeps aliases first-class when named alone or in an explicit comparison', () => {
    expect(routeReposFromCards('What is RVF?', KB, available).repos).toEqual(['ruvector']);
    expect(routeReposFromCards('RVF versus AgentDB', KB, available).repos)
      .toEqual(expect.arrayContaining(['ruvector', 'agentdb']));
  });

  it('routes an exact scoped package through the shipped ownership registry', () => {
    const route = routeReposFromCards(
      'What does the @claude-flow/neural package implement — which algorithms?',
      KB,
      available,
    );
    expect(route).toMatchObject({
      confidence: 'named',
      namedRepos: ['ruflo'],
      repos: ['ruflo'],
    });
  });

  it('does not let generic Brain hints override a canonically named repository', () => {
    const route = routeReposFromCards(
      "What are RuVector's npm package and core crate names, and roughly how large is the Rust workspace?",
      KB,
      available,
    );
    expect(route.repos).toEqual(['ruvector']);
  });

  it('lets decisive capability context beat a weak format alias', () => {
    const route = routeReposFromCards(
      'What does ADR-003 propose about using RVF cognitive containers for CSI data, and what problem does it target?',
      KB,
      [...available, 'ruview'],
    );
    expect(route).toMatchObject({
      confidence: 'described',
      repos: ['ruview'],
    });
  });

  it('routes an exact scoped-package ask to its owning repo first', () => {
    const route = routeReposFromCards(
      'What does the @ruvector/rvf TypeScript SDK expose, and how is its backend resolved at runtime?',
      KB,
      available,
    );
    expect(route.confidence).toBe('named');
    expect(route.repos).toEqual(['ruvector']);
  });

  it('resolves a capability-card product name to its installed store alias', () => {
    const cardRepo = ['agent', '-harness-generator'].join('');
    const storeRepo = ['meta', 'harness'].join('');
    const route = routeReposFromCards(
      `What does Darwin mode in ${cardRepo} actually mutate?`,
      KB,
      [...available, storeRepo],
    );

    expect(route).toMatchObject({
      confidence: 'named',
      repos: expect.arrayContaining([storeRepo]),
      namedRepos: [storeRepo],
      cardRepos: { [storeRepo]: cardRepo },
    });
    expect(route.repos[0]).toBe(storeRepo);
  });

  it('routes strong described evidence but preserves full-fanout for ambiguity', () => {
    const route = routeReposFromCards(
      'I need cached vector reads with a cryptographic witness and freshness modes',
      KB,
      available,
    );
    expect(route.confidence).toBe('described');
    expect(route.repos[0]).toBe('rulake');
    expect(route.repos).toEqual(['rulake']);
    expect(routeReposFromCards('How do I center a div?', KB, available).repos).toEqual([]);
  });

  it('does not add the aggregate concepts store to an explicitly named repository', () => {
    const route = routeReposFromCards(
      'How does Ruflo initialize and coordinate a hierarchical agent swarm?',
      KB,
      available,
    );
    expect(route.confidence).toBe('named');
    expect(route.repos).toEqual(['ruflo']);
  });

  it('normalizes an unambiguous discard paraphrase before by-description routing', () => {
    const query = "I want to try a risky change to an agent's memory and throw it away if it goes wrong.";
    const route = routeReposFromCards(query, KB, [...available, 'agenticow']);
    expect(route).toMatchObject({
      confidence: 'described',
      repos: expect.arrayContaining(['agenticow']),
    });
    expect(route.repos[0]).toBe('agenticow');
    expect(answerFromCards(query, KB)).toMatchObject({
      hit: true,
      repo: 'agenticow',
    });
  });

  it('routes a colloquial cost-quality tradeoff but does not answer it from a one-sided card', () => {
    const query = 'How do I spend less money on model calls without getting dumber answers?';
    const expected = ['agentic', 'flow'].join('-');
    const route = routeReposFromCards(query, KB, [...available, 'cve-bench']);
    expect(route).toMatchObject({
      confidence: 'described',
      repos: expect.arrayContaining([expected]),
    });
    expect(route.repos[0]).toBe(expected);
    expect(answerFromCards(query, KB)).toMatchObject({
      hit: false,
      reason: expect.stringMatching(/source detail/i),
    });
  });

  it('normalizes colloquial risk and uncovered-code language to the QE capability card', () => {
    const qeRepo = ['agentic', 'qe'].join('-');
    const query = "Rank my untested code by how risky it is, not just what's uncovered.";
    const route = routeReposFromCards(query, KB, [...available, qeRepo, 'cve-bench']);
    expect(route).toMatchObject({
      confidence: 'described',
      repos: expect.arrayContaining([qeRepo]),
    });
    expect(route.repos[0]).toBe(qeRepo);
    expect(answerFromCards(query, KB)).toMatchObject({
      hit: true,
      repo: qeRepo,
    });
  });

  it('normalizes a plain-language specification-to-completion request before routing', () => {
    const query = 'Is there a step-by-step method that takes me from a written spec to finished code?';
    const route = routeReposFromCards(query, KB, [...available, 'sparc']);
    expect(route).toMatchObject({
      confidence: 'described',
      repos: expect.arrayContaining(['sparc']),
    });
    expect(route.repos[0]).toBe('sparc');
  });
});
