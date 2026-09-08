// Dream Cycle issue disposition gate.
//
// The nightly engine may discover hypotheses, failed probes, or already-fixed findings. None of
// those is sufficient justification for creating a public issue. This module is deliberately pure:
// the caller supplies the finding and the current open issues, and receives a disposition before
// invoking any GitHub write operation.

const HEX_SHA = /^[0-9a-f]{7,64}$/i;
const ISSUE_MARKER = 'dream-fingerprint:';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Stable identity used by the ledger, issue body, and open-issue deduplication. */
export function stableFingerprint(finding = {}) {
  const parts = ['deep', 'scan', 'path', 'signature'].map((key) => text(finding[key]));
  return parts.every(Boolean) ? parts.join('|') : '';
}

export function issueBodyMarker(fingerprint) {
  return fingerprint ? `${ISSUE_MARKER} ${fingerprint}` : '';
}

function sourceBacked(finding) {
  const sourceSha = text(finding.sourceSha || finding.sourceCommit || finding.source?.commit);
  const sourcePaths = finding.sourcePaths || finding.paths || finding.source?.paths;
  const reproduction = finding.reproduction || finding.repro;
  const evidence = Array.isArray(finding.evidence) ? finding.evidence : [];
  if (!HEX_SHA.test(sourceSha)) return false;
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0 || sourcePaths.some((p) => !text(p))) return false;
  if (!reproduction || !text(reproduction.command) || !text(reproduction.output)) return false;
  return evidence.length > 0 && evidence.every((item) => item && text(item.observed)
    && (text(item.path) || text(item.source) || text(item.sourcePath)));
}

function openIssueFor(fingerprint, openIssues) {
  if (!fingerprint || !Array.isArray(openIssues)) return null;
  const marker = issueBodyMarker(fingerprint);
  return openIssues.find((issue) => text(issue.body).includes(marker)
    || text(issue.title).includes(marker)
    || text(issue.fingerprint) === fingerprint) || null;
}

/**
 * Decide whether a finding may become a GitHub issue.
 *
 * `report` is the safe destination for hypotheses, missing evidence, resolved findings, and
 * findings that are not yet actionable. `dedupe` points at the existing open issue. Only `create`
 * is permission for the caller to invoke `gh issue create`.
 */
export function assessFinding(finding = {}, { openIssues = [] } = {}) {
  const fingerprint = stableFingerprint(finding);
  const common = { fingerprint: fingerprint || null };
  const status = text(finding.status || finding.state).toLowerCase();
  const skip = new Set((finding.skipIf || []).map((value) => text(value).toLowerCase()));

  if (!fingerprint) return { ...common, action: 'report', reason: 'missing-stable-fingerprint' };
  if (status === 'hypothesis' || status === 'unreproduced' || status === 'unknown') {
    return { ...common, action: 'report', reason: 'finding-not-reproduced' };
  }
  if (!sourceBacked(finding)) return { ...common, action: 'report', reason: 'missing-source-backed-reproduction' };
  if (skip.has('already-fixed') || skip.has('verified-local-fix') || skip.has('environment-only')
    || finding.resolved === true || finding.fixed === true) {
    return { ...common, action: 'report', reason: 'resolved-or-non-defect' };
  }
  if (status !== 'reproduced' && status !== 'reproducible' && status !== 'confirmed') {
    return { ...common, action: 'report', reason: 'finding-not-confirmed' };
  }
  if (finding.actionable !== true || finding.unresolved !== true || finding.boundedFixUnsuccessful !== true) {
    return { ...common, action: 'report', reason: 'repair-or-actionability-evidence-missing' };
  }
  const existing = openIssueFor(fingerprint, openIssues);
  if (existing) return { ...common, action: 'dedupe', reason: 'duplicate-open-issue', issue: existing };
  return { ...common, action: 'create', reason: 'reproduced-actionable-unresolved-after-bounded-repair' };
}

export function buildIssueBody(finding, decision = assessFinding(finding)) {
  if (decision.action !== 'create') throw new Error(`cannot build issue body for ${decision.action}`);
  const sourceSha = text(finding.sourceSha || finding.sourceCommit || finding.source?.commit);
  return [
    `<!-- ${issueBodyMarker(decision.fingerprint)} -->`,
    `## ${text(finding.title) || 'Dream Cycle finding'}`,
    '',
    text(finding.summary || finding.description),
    '',
    `Source: ${sourceSha}`,
    `Paths: ${(finding.sourcePaths || finding.paths || []).join(', ')}`,
    `Reproduction: \`${text(finding.reproduction?.command)}\``,
    '',
    'Observed output:',
    '```',
    text(finding.reproduction?.output),
    '```',
  ].join('\n');
}

// Adapter contract for the Dream Machine runner. Input is JSON on stdin:
// { "finding": { ... }, "openIssues": [{ "number", "title", "body" }] }
// Output is the disposition JSON. This command intentionally cannot create or mutate GitHub data.
if (process.argv[1] === new URL(import.meta.url).pathname) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    try {
      const payload = JSON.parse(input || '{}');
      const decision = assessFinding(payload.finding || payload, { openIssues: payload.openIssues || [] });
      process.stdout.write(`${JSON.stringify(decision)}\n`);
    } catch (error) {
      process.stderr.write(`dream-issue-gate: invalid JSON input: ${error.message}\n`);
      process.exitCode = 2;
    }
  });
}
