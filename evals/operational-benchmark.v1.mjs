import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

// Independently authored operational cases. Each answerable oracle is an exact source span from
// the checked-in capability card corpus, written before replay; it is not derived from the search
// result. Negative and ambiguous cases intentionally have no fact oracle.
export const OPERATIONAL_FIXTURES = [
  { id: 'broad-risk-testing', class: 'broad', query: 'How can I find the parts of my code that are risky and still lack tests?', expectedRepos: ['agentic-qe', 'concepts'], expectedFact: 'find coverage gaps with risk-weighted analysis that prioritizes the most impactful untested code paths' },
  { id: 'broad-portable-index', class: 'broad', query: 'My embeddings are on one laptop; how can I keep a portable similarity index without running a separate service?', expectedRepos: ['ruvector', 'concepts'], expectedFact: 'portable, single-file `.rvf` binary container, not JSON' },
  { id: 'broad-next-session-learning', class: 'broad', query: 'Can the next coding session pick up decisions and state from agents that worked on this project earlier?', expectedRepos: ['ruflo', 'concepts'], expectedFact: 'Orchestration decides who does what and in what order; memory preserves decisions and state so later agents and sessions can continue' },
  { id: 'broad-cross-project-learning-status', class: 'broad', query: 'If I teach the coding assistant a lesson in one repository, will it automatically apply that lesson in a different project?', expectedRepos: ['concepts', 'ruflo'], expectedFact: 'that the brain currently carries your lessons across projects. It does not', oraclePath: 'docs/4.0-EXPLAINER-BRIEF.md' },
  { id: 'broad-no-camera-sensing', class: 'broad', query: 'Can ordinary WiFi signals detect whether someone is in a room without a camera?', expectedRepos: ['ruview', 'concepts'], expectedFact: 'turns ordinary WiFi radio signals (Channel State Information / CSI) from ESP32-S3/C6 sensors into human presence' },
  { id: 'broad-spec-to-code', class: 'broad', query: 'I need a disciplined process that turns a feature idea into shipped code with review gates.', expectedRepos: ['sparc', 'concepts'], expectedFact: 'organized into five phases — Specification, Pseudocode, Architecture, Refinement, Completion' },
  { id: 'broad-shared-hosts', class: 'broad', query: 'I need a source-grounded reference available in both Claude Code and Codex.', expectedRepos: ['ruvnet-brain', 'concepts'], expectedFact: 'Source-grounded knowledge layer for Claude Code and Codex' },
  { id: 'named-agentic-qe-risk', class: 'named', query: 'Does agentic-qe prioritize uncovered code by risk?', expectedRepos: ['agentic-qe', 'concepts'], expectedFact: 'find coverage gaps with risk-weighted analysis that prioritizes the most impactful untested code paths' },
  { id: 'named-ruview-input', class: 'named', query: 'What signal does RuView use for camera-free sensing?', expectedRepos: ['ruview', 'concepts'], expectedFact: 'ordinary WiFi radio signals (Channel State Information / CSI) from ESP32-S3/C6 sensors' },
  { id: 'named-sparc-phases', class: 'named', query: 'What are the five SPARC phases?', expectedRepos: ['sparc', 'concepts'], expectedFact: 'Specification, Pseudocode, Architecture, Refinement, Completion' },
  { id: 'named-brain-hosts', class: 'named', query: 'Does RuvNet Brain support Codex as well as Claude Code?', expectedRepos: ['ruvnet-brain', 'concepts'], expectedFact: 'Source-grounded knowledge layer for Claude Code and Codex' },
  { id: 'named-cognitum-ruos', class: 'named', query: 'What is Cognitum ruOS intended to do on an AI workstation?', expectedRepos: ['cognitum-ruos', 'concepts'], expectedFact: 'agentic Linux operating system for AI workstations' },
  { id: 'named-ruflo-ipfs-unavailable', class: 'named', query: 'How does Ruflo use IPFS to share learned patterns across projects?', expectedRepos: [], expectedFact: null, availability: 'unavailable-no-source-oracle-in-checked-in-corpus' },
  { id: 'negative-invented-sensor', class: 'negative', query: 'Does RuView guarantee clinical diagnosis of pneumonia from WiFi CSI alone?', expectedRepos: [], expectedFact: null },
  { id: 'negative-unlisted-package', class: 'negative', query: 'Which RuvNet package implements the fictional QuantumCache v9 protocol?', expectedRepos: [], expectedFact: null },
  { id: 'broad-adr-status', class: 'broad', query: 'If an engineering design has been accepted, does that alone establish that its feature is built?', expectedRepos: ['ruvnet-brain', 'concepts'], expectedFact: 'An ADR may be proposed or accepted without being implemented' },
  { id: 'ambiguity-memory-owner', class: 'ambiguity', query: 'I want my assistant to remember things and search them. What should I use?', expectedRepos: [], expectedFact: null },
  { id: 'ambiguity-model', class: 'ambiguity', query: 'Which model should I use?', expectedRepos: [], expectedFact: null },
  { id: 'ambiguity-install', class: 'ambiguity', query: 'How do I turn it on?', expectedRepos: [], expectedFact: null },
];

function normalizeSourceText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** Resolve expected support from the cited passage bytes, never from response text. */
export async function verifyFixtureSourceSupport(fixture, verification, kbDir) {
  if (!fixture.expectedFact) return { checked: false, supported: false, reason: 'no-answerable-fact-oracle' };
  const { createHash } = await import('node:crypto');
  for (const citation of verification?.citations ?? []) {
    if (typeof citation.ce !== 'number' || citation.ce < 0
      || !fixture.expectedRepos.includes(citation.repo)
      || !/^[a-z0-9._-]+$/i.test(citation.repo)) continue;
    const files = [`${citation.repo}.passages.jsonl`, `${citation.repo}.big.passages.jsonl`]
      .map((name) => path.join(kbDir, name))
      .filter((file) => fs.existsSync(file));
    for (const file of files) {
      const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
      try {
        for await (const line of rl) {
          let record;
          try { record = JSON.parse(line); } catch { continue; }
          const sameSource = record?.path === citation.docPath || record?.path?.startsWith(`${citation.docPath}#`);
          if (sameSource && typeof record.text === 'string'
            && normalizeSourceText(record.text).includes(normalizeSourceText(fixture.expectedFact))) {
            return {
              checked: true,
              supported: true,
              repo: citation.repo,
              citedPath: citation.fullPath,
              storedPath: record.path,
              passageSha256: createHash('sha256').update(record.text).digest('hex'),
              passageStore: path.basename(file),
              passageStoreSha256: await hashFile(file),
            };
          }
        }
      } finally { rl.close(); }
    }
  }
  return { checked: true, supported: false, reason: 'expected-span-absent-from-resolved-cited-passage' };
}

const storeDigests = new Map();
async function hashFile(file) {
  if (!storeDigests.has(file)) {
    storeDigests.set(file, (async () => {
      const { createHash } = await import('node:crypto');
      const hash = createHash('sha256');
      for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
      return hash.digest('hex');
    })());
  }
  return storeDigests.get(file);
}

/** Exact source-span and resolved-citation check. Regex keyword overlap is never answer evidence. */
export function gradeOperationalFixture(fixture, { output, verification, sourceSupport, processOk }) {
  const citations = verification?.citations ?? [];
  if (!processOk) return { pass: false, reason: 'retrieval-process-failed' };
  if (fixture.class === 'negative' || fixture.class === 'ambiguity') {
    const top = citations[0];
    const explicitRefusal = /EVIDENCE:\s*(?:THIN|INSUFFICIENT_EVIDENCE)|insufficient evidence|no source found|too ambiguous/i.test(String(output ?? ''));
    const abstained = !top || (typeof top.ce === 'number' && top.ce < 0);
    return {
      pass: abstained && explicitRefusal,
      grounded: !!verification?.grounded,
      abstained,
      reason: fixture.class === 'ambiguity' ? 'expected clarification or explicit uncertainty' : 'expected evidence-qualified abstention',
    };
  }
  const resolvedExpected = !!verification?.grounded && !!sourceSupport?.supported;
  const abstained = !citations[0] || (typeof citations[0].ce === 'number' && citations[0].ce < 0);
  return {
    pass: resolvedExpected && !abstained,
    grounded: !!verification?.grounded,
    routed: resolvedExpected,
    sourceFactPresent: !!sourceSupport?.supported,
    abstained,
    receipt: verification?.receipt ?? null,
    sourceSupport: sourceSupport ?? null,
  };
}

export function latencyDistribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null;
  return { n: sorted.length, p50Ms: percentile(.50), p95Ms: percentile(.95), p99Ms: percentile(.99), maxMs: sorted.at(-1) ?? null };
}
