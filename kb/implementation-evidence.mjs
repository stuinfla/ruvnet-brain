import path from 'node:path';
import { hasConcreteClassMethod } from './exact-member-proof.mjs';

const IMPLEMENTATION_QUERY =
  /\b(?:build(?:s|ing)?|built|ship(?:s|ped|ping)?|implement(?:ed|ation|ing|s)?|released?|deployed?|working|exists?|available|can|does|has|supports?|provides?|includes?|exposes?)\b/i;

const SOURCE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.go', '.java', '.js', '.jsx', '.mjs', '.mts',
  '.py', '.rb', '.rs', '.sh', '.sol', '.swift', '.ts', '.tsx', '.wasm',
]);

// A fully qualified member call asks about one exact API symbol. A nearby class match or an
// unrelated implementation file cannot prove that member exists.
function requestedMember(query) {
  const match = String(query || '').match(/\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/);
  return match ? { owner: match[1], member: match[2] } : null;
}

export function requiresImplementationProof(query) {
  const text = String(query || '');
  if (requestedMember(text)) return true;
  // "Agents working in parallel" describes the workload being coordinated; it is not the
  // operational-status claim "is this working?". Keep the status word load-bearing everywhere
  // else, but do not force a capability-selection question onto the built-state proof lane merely
  // because its subject is an agent at work.
  const proofText = text.replace(
    /\bagents?\s+working\s+(?:at\s+the\s+same\s+time|in\s+parallel|concurrently)\b/gi,
    'agents in parallel',
  ).replace(
    /\b(?:the\s+)?team\s+ships?\s+code\b/gi,
    'team writes code',
  ).replace(
    /\b(?:we|i)\s+can(?:not|'t)\s+ship\s+python\b/gi,
    'python-free deployment requirement',
  ).replace(
    /\bsupport\s+(?:bots?|assistants?|agents?)\b/gi,
    'customer-service assistant',
  ).replace(
    /\b(?:we|i)\s+(?:need|want)\b([^.!?;]{0,180})\bcan\b/gi,
    'desired capability$1should',
  ).replace(
    /\b(?:the\s+)?code\s+does\s+another\b/gi,
    'decision differs from source',
  );
  return IMPLEMENTATION_QUERY.test(proofText) || /^\s*(?:what\s+(?:is|are)|is\s+)/i.test(text);
}

function lifecycleStatus(text) {
  const head = String(text || '').slice(0, 2400);
  const match = head.match(/(?:^|\n)\s*(?:\*\*)?status(?:\*\*)?\s*:\s*(?:\*\*)?([a-z][a-z -]{1,30})/i);
  if (!match) return null;
  return match[1].trim().toLowerCase().replace(/\s+/g, '-');
}

export function classifyResultEvidence(result) {
  const kind = String(result?.kind || '').toLowerCase();
  const file = String(result?.path || '');
  const basename = path.basename(file.split(/[?#]/, 1)[0]).toLowerCase();
  // A citation fragment is not part of the filesystem path. Without stripping it first,
  // `capability-cards.md#dspy.ts` looks like a TypeScript source file and documentation can
  // silently satisfy the built-state proof gate.
  const ext = path.extname(file.split(/[?#]/, 1)[0]).toLowerCase();
  const text = result?.fullText || result?.text || '';
  const lifecycle = lifecycleStatus(text);

  if (kind === 'source' || kind === 'manifest' || SOURCE_EXTENSIONS.has(ext)) {
    return { evidenceClass: 'implementation', lifecycleStatus: lifecycle };
  }
  // A documentation file inside a tool whose NAME contains "adr" is still documentation.
  // Classify explicit corpus kinds before path heuristics so plugins/ruflo-adr/README.md and its
  // review skill do not become design intent merely because their parent directory names the tool.
  if (['doc', 'skill', 'tutorial'].includes(kind)
      || basename === 'readme.md'
      || basename === 'skill.md') {
    return { evidenceClass: 'documentation', lifecycleStatus: lifecycle };
  }
  if (kind === 'adr' || /(?:^|\/)(?:adr[-_/]|\d{4}[-_])/i.test(file)) {
    return { evidenceClass: 'design-intent', lifecycleStatus: lifecycle };
  }
  return { evidenceClass: 'documentation', lifecycleStatus: lifecycle };
}

export function assessImplementation(query, results) {
  const required = requiresImplementationProof(query);
  const exactMember = requestedMember(query);
  const enriched = (results || []).map((result) => ({
    ...result,
    ...classifyResultEvidence(result),
  }));
  const implementationSources = enriched
    // A source file is not proof merely because it appeared somewhere in a noisy result set.
    // Require the same weakest-known-good relevance floor used by forge-ask-all's evidence grade.
    .filter((result) => result.evidenceClass === 'implementation' && Number(result.ceScore) >= 4
      && (!exactMember || hasConcreteClassMethod(
        result.fullText || result.text,
        result.path,
        exactMember,
      )))
    .map((result) => `${result.repo}/${result.path}`);
  const retrievedImplementationSources = enriched
    .filter((result) => result.evidenceClass === 'implementation')
    .map((result) => `${result.repo}/${result.path}`);
  const unprovenReason = required && !implementationSources.length
    ? (exactMember ? 'exact-member-not-established'
      : retrievedImplementationSources.length ? 'insufficient-relevance' : 'no-implementation-source')
    : null;

  return {
    results: enriched,
    implementation: {
      required,
      verdict: required ? (implementationSources.length ? 'proven' : 'unproven') : 'not-required',
      implementationSources,
      retrievedImplementationSources,
      requestedMember: exactMember,
      unprovenReason,
    },
  };
}

export function implementationNotice(implementation) {
  if (!implementation?.required) return '';
  if (implementation.verdict === 'proven') {
    const member = implementation.requestedMember;
    if (member) {
      return `✅ IMPLEMENTATION EVIDENCE: PROVEN — a direct concrete declaration of ${member.owner}.${member.member} exists in ${implementation.implementationSources.join(', ')}. This establishes declaration presence only; accessibility, call shape, and runtime behavior were not verified.\n\n`;
    }
    return `✅ IMPLEMENTATION EVIDENCE: PROVEN by ${implementation.implementationSources.join(', ')}.\n\n`;
  }
  const reason = implementation.unprovenReason === 'insufficient-relevance'
    ? 'Implementation-bearing source or manifest was retrieved, but its relevance does not meet the proof threshold. '
    : implementation.unprovenReason === 'no-implementation-source'
      ? 'The retrieved material contains no implementation-bearing source or manifest. ADRs and documentation below may describe design intent. '
      : implementation.unprovenReason === 'exact-member-not-established'
        ? `The retrieved source does not establish the exact member ${implementation.requestedMember?.owner}.${implementation.requestedMember?.member}. Related class or repository matches do not prove it exists, and this result does not establish global nonexistence. `
      : 'The retrieved evidence does not establish the requested capability. ';
  return '⛔ BUILT/SHIPPED CLAIM: NOT PROVEN. ' + reason + 'Do not tell the '
    + 'user this capability was built, shipped, implemented, deployed, or is available.\n\n';
}
