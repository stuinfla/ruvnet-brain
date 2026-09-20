import { createHash } from 'node:crypto';

// Broad concepts identify related documentation; they never override primary routing.
// A match establishes relatedness only, not satisfaction of all query constraints.
const FAMILIES = [
  {
    id: 'local-vector-storage',
    owners: ['ruvector'],
    discoveryTerms: 'vectors embeddings vector database query indexing local storage browser IndexedDB offline zero server zero backend persist privacy',
    matches(query) {
      const q = String(query || '');
      const vectorData = /\b(?:vectors?|embeddings?)\b/i.test(q);
      const storageIntent = /\b(?:stor\w*|persist\w*|save|write|keep|database)\b/i.test(q);
      const localDeployment = /\b(?:local(?:ly)?|browser|offline|on[- ]device|(?:on|this) (?:the )?device|private(?:ly)?|without (?:running |operating )?(?:a )?(?:server|backend)|no server|zero server)\b/i.test(q);
      return vectorData && storageIntent && localDeployment;
    },
  },
  {
    id: 'cross-project-agent-learning',
    owners: ['ruflo'],
    discoveryTerms: 'agent learned patterns experience transfer share across different projects repositories IPFS',
    matches(query) {
      const q = String(query || '');
      const learnedKnowledge = /\b(?:learn\w*|patterns?|experience|knowledge)\b/i.test(q);
      const projectBoundary = /\b(?:projects?|repository|repositories|repos|codebases?)\b/i.test(q)
        && /\b(?:across|between|another|different|separate|cross[- ]project)\b/i.test(q);
      const transferIntent = /\b(?:carry|transfer|share|sharing|move|reuse|reus\w*|across|between|another|different)\b/i.test(q);
      return learnedKnowledge && projectBoundary && transferIntent;
    },
  },
];

export const REVIEWED_CAPABILITY_EVIDENCE = Object.freeze({
  'local-vector-storage': Object.freeze({
    repo: 'ruvector',
    path: 'crates/ruvector-router-wasm/README.md',
    passageSha256: '44404f0c1ae135b021ece8e5e30c271fb1900ea0c4f583f1f891ee3196386662',
    excerptKind: 'reviewed-browser-vector-storage',
    claimGroups: Object.freeze(['browser-vector-search', 'zero-server-dependencies', 'indexeddb-vector-persistence', 'privacy-first-device-local']),
  }),
  'cross-project-agent-learning': Object.freeze({
    repo: 'ruflo',
    path: 'plugins/ruflo-intelligence/agents/intelligence-specialist.md',
    passageSha256: '3af770c2c5bceb4b612eac6757656d6e2be74b914bdf75f1d6f422af54dcdd36',
    excerptKind: 'reviewed-cross-project-ipfs-transfer',
    claimGroups: Object.freeze(['cross-project-learned-pattern-transfer', 'explicit-ipfs-store-load', 'pinata-credential-required']),
  }),
});

export function buildReviewedCapabilityExcerpt(passageText, evidence) {
  const text = String(passageText || '');
  const digest = createHash('sha256').update(text).digest('hex');
  if (!evidence || digest !== evidence.passageSha256) return null;

  if (evidence.excerptKind === 'reviewed-browser-vector-storage') {
    const paragraphs = text.split(/\n\s*\n/).map((part) => part.trim());
    const overview = paragraphs.find((part) => part.includes('Run sub-millisecond vector search entirely in the browser with **zero server dependencies**.'));
    const persistence = '- **IndexedDB Integration**: Persist vector data locally';
    const privacy = '- 🔒 **Privacy First**: User data never leaves the device';
    const browserHeading = paragraphs.findIndex((part) => part === '### Browser-Specific Optimizations');
    const browserSection = browserHeading >= 0 ? paragraphs.slice(browserHeading, browserHeading + 2).join('\n\n') : '';
    if (!overview || !overview.includes('entirely in the browser')
      || !browserSection.includes(persistence) || !text.includes(privacy)) return null;
    const browserLines = browserSection.split('\n').filter((line) =>
      line === '### Browser-Specific Optimizations' || line === persistence);
    return `${overview}\n\n${privacy}\n\n${browserLines.join('\n')}`;
  }

  if (evidence.excerptKind === 'reviewed-cross-project-ipfs-transfer') {
    const start = text.indexOf('## Cross-project pattern transfer');
    if (start < 0) return null;
    const nextHeading = text.indexOf('\n## Related Plugins', start);
    const section = text.slice(start, nextHeading < 0 ? undefined : nextHeading).trim();
    if (!section.includes("Publish current project's patterns to IPFS")
      || !section.includes("Pull a peer's patterns from IPFS by CID")
      || !section.includes('Requires `PINATA_API_JWT` configured.')) return null;
    return section;
  }
  return null;
}

/** Route to narrowly-scoped source owners from capability vocabulary, never to an answer. */
export function routeCapabilityFamily(query, availableRepos, { limit = 3 } = {}) {
  const available = new Set(Array.isArray(availableRepos) ? availableRepos : []);
  const matches = FAMILIES.map((family) => {
    const owners = family.owners.filter((owner) => available.has(owner));
    return { family, matched: family.matches(query), owners };
  }).filter(({ matched, owners }) => matched && owners.length);

  // A query that expresses multiple unrelated capabilities must not inherit an arbitrary
  // family's owner or source vocabulary.
  if (matches.length !== 1) return null;
  const [{ family, owners }] = matches;
  return {
    repos: [...new Set(owners)].slice(0, Math.max(1, limit)),
    confidence: 'capability-family',
    family: family.id,
    discoveryTerms: family.discoveryTerms,
    reason: `bounded source discovery matched ${family.id}`,
  };
}
