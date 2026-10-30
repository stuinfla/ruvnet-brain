// scripts/issue-autofix-gate.mjs — the security gate of the autofix job (ADR-107): nothing a stranger's issue produced
// reaches npm unless every check below is clean. Three layers, cheapest first, any finding blocks:
//   1. INPUT  — scanIssueText: rUv's AIDefence (@claude-flow/aidefence, already a dependency) over every word a model
//               will read (title, body, every comment). Unavailable scanner = the issue is not attempted (fail closed).
//   2. ISSUE  — per fix: the editable allowlist + diff policy (policy.mjs), the static malware/secret scan of the added
//               lines (security.mjs), then a fresh Opus red-team that sees only the diff. Its claims are re-checked
//               here against the static scan: a "CLEAN" that contradicts the scanner, or any finding, blocks.
//   3. NIGHT  — runBatchGate on the release branch: manifest and lockfile may change only in "version"; the
//               `npm pack --dry-run` file list may differ from the last published release only in reviewed paths and
//               never by a binary; `npm audit` may show no NEW high/critical advisory; a second red-team over the whole
//               batch diff. Any finding blocks the whole night's release (owner, 2026-10-30).
import fs from 'node:fs';
import path from 'node:path';
import { AutofixAbort } from './issue-autofix-policy.mjs';
import { scanAddedLines, scanSecrets, judgeManifestChange, judgeLockfileChange, judgePackList, judgeAudit, securityVerdict } from './issue-autofix-security.mjs';
import { parseUnifiedDiff } from './issue-autofix-release-util.mjs';

const MIN = 60_000;
const PRESENT_TO_RULES = {
  networkEgress: ['network-egress', 'fetch-execute'], processExec: ['process-exec'], dynamicCode: ['dynamic-code'],
  credentialAccess: ['credential-access', 'env-harvest'], obfuscation: ['obfuscation', 'hidden-unicode'],
  fsOutsideRepo: ['fs-outside-repo'], installHook: ['install-hook', 'lifecycle-script'],
};

// ── 1. input ────────────────────────────────────────────────────────────────────────────────
let aidefence = null;
async function loadAidefence() {
  if (!aidefence) aidefence = await import('@claude-flow/aidefence');
  return aidefence;
}

/** { safe, threats } over everything a model will read. Throws AutofixAbort('injection-scan-failed') if it cannot scan. */
export async function scanIssueText(issue, { load = loadAidefence } = {}) {
  let mod;
  try { mod = await load(); } catch (e) { throw new AutofixAbort('S1', 'injection-scan-failed', `AIDefence unavailable: ${e.message}`); }
  if (typeof mod?.checkThreats !== 'function') throw new AutofixAbort('S1', 'injection-scan-failed', 'AIDefence has no checkThreats');
  const texts = [issue.title, issue.body, ...(issue.comments || []).map((c) => c.body)].map((t) => String(t ?? ''));
  const threats = [];
  for (const t of texts) {
    const r = mod.checkThreats(t);
    if (!r || typeof r.safe !== 'boolean') throw new AutofixAbort('S1', 'injection-scan-failed', 'AIDefence returned no verdict');
    if (!r.safe) threats.push(...(r.threats || []).map((x) => `${x.type}:${x.severity}`));
  }
  return { safe: threats.length === 0, threats };
}

// ── 2. per-issue ────────────────────────────────────────────────────────────────────────────
/** Static scan of a working-tree diff ({files, text}). */
export function staticScan(diff) {
  return securityVerdict(scanAddedLines(diff.files), scanSecrets(diff.text || ''));
}

/** Map each red-team finding onto an added line (confirmed) or not; any finding, any non-CLEAN verdict, or a present
 *  flag that the static scanner contradicts, blocks. */
export function judgeRedTeam(result, files, staticFindings = []) {
  const reasons = [];
  if (!result || typeof result !== 'object') return { ok: false, reasons: ['no-result'], findings: [] };
  if (result.verdict !== 'CLEAN') reasons.push(`verdict:${result.verdict}`);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const findings = (result.findings || []).map((f) => {
    const file = byPath.get(String(f.file || '').replace(/^[ab]\//, ''));
    const confirmed = !!file && file.added.some((l) => String(f.evidence || '').includes(l.trim().slice(0, 40)) && l.trim().length > 3);
    return { ...f, confirmed };
  });
  if (findings.length) reasons.push(`findings:${findings.length}`);
  for (const [k, rules] of Object.entries(PRESENT_TO_RULES)) {
    const saidPresent = result.present?.[k] === true;
    const scanned = staticFindings.some((s) => rules.includes(s.rule));
    if (saidPresent) reasons.push(`present:${k}`);
    else if (scanned) reasons.push(`contradicts-scan:${k}`); // the model said absent; the scanner found it
  }
  return { ok: reasons.length === 0, reasons, findings };
}

/** Run the red-team stage over `diffText` in an empty directory and judge it. Throws AutofixAbort on a block. */
export async function redTeam(rt, { stage, diffText, files, staticFindings, scope }) {
  fs.mkdirSync(rt.tmpRoot, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(rt.tmpRoot, 'autofix-redteam-'));
  const r = await rt.agent('redteam', stage, cwd, { diffText, scope });
  const v = judgeRedTeam(r.result, files, staticFindings);
  if (!v.ok) {
    throw new AutofixAbort(stage, 'redteam-flagged', `${v.reasons.join(', ')}; ${v.findings.slice(0, 5)
      .map((f) => `${f.file}:${f.line} ${f.category}${f.confirmed ? ' (confirmed)' : ''}`).join('; ')}`.slice(0, 900));
  }
  return v;
}

// ── 3. the night ────────────────────────────────────────────────────────────────────────────
const readJsonAt = async (rt, dir, rev, file) => {
  const r = await rt.exec('git', ['-C', dir, 'show', `${rev}:${file}`]);
  if (r.status !== 0) throw new AutofixAbort('S6', 'batch-security', `cannot read ${file} at ${rev}`);
  try { return JSON.parse(r.stdout); } catch { throw new AutofixAbort('S6', 'batch-security', `${file} at ${rev} is not JSON`); }
};
const packFiles = (stdout) => {
  const j = JSON.parse(stdout.slice(stdout.indexOf('[')));
  return (j[0]?.files || []).map((f) => ({ path: f.path, size: f.size }));
};

/**
 * The night's gate over the release worktree. `fixBase`..`fixHead` spans exactly the cherry-picked fixes (nothing
 * mechanical), so the static scan and red-team see only model-written code; manifest, lockfile, pack list and audit
 * look at the whole branch against origin/main and the last published release.
 */
export async function runBatchGate(rt, { rwt, fixBase, fixHead, mainVersion, baseDir }) {
  const lists = [];
  const fixDiff = await rt.exec('git', ['-C', rwt, 'diff', '--no-color', '--no-ext-diff', '--no-renames', '-U0', fixBase, fixHead]);
  const fixText = await rt.exec('git', ['-C', rwt, 'diff', '--no-color', '--no-ext-diff', '--no-renames', fixBase, fixHead]);
  if (fixDiff.status !== 0 || fixText.status !== 0) throw new AutofixAbort('S6', 'batch-security', 'cannot diff the batch');
  const files = parseUnifiedDiff(fixDiff.stdout);
  const st = staticScan({ files, text: fixText.stdout });
  lists.push(st.findings);
  lists.push(judgeManifestChange(await readJsonAt(rt, rwt, 'origin/main', 'package.json'), await readJsonAt(rt, rwt, 'HEAD', 'package.json')));
  lists.push(judgeLockfileChange(await readJsonAt(rt, rwt, 'origin/main', 'package-lock.json'), await readJsonAt(rt, rwt, 'HEAD', 'package-lock.json')));

  const changed = (await rt.exec('git', ['-C', rwt, 'diff', '--name-only', 'origin/main', 'HEAD'])).stdout.split('\n').filter(Boolean);
  const cand = await rt.exec('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: rwt, timeoutMs: 10 * MIN });
  const prev = await rt.exec('npm', ['pack', `ruvnet-brain@${mainVersion}`, '--dry-run', '--json', '--ignore-scripts'], { cwd: baseDir, timeoutMs: 10 * MIN });
  try {
    lists.push(judgePackList({ previous: packFiles(prev.stdout), candidate: packFiles(cand.stdout), changedPaths: changed }));
  } catch (e) {
    lists.push([{ path: '<npm pack>', line: null, rule: 'pack-unreadable', detail: `npm pack --dry-run unreadable (${cand.status}/${prev.status}): ${e.message}`, excerpt: '' }]);
  }

  // Only NEW high/critical advisories count: the same advisories on origin/main are not this batch's doing.
  const audit = async (dir) => { const r = await rt.exec('npm', ['audit', '--json', '--omit=dev'], { cwd: dir, timeoutMs: 10 * MIN });
    try { return JSON.parse(r.stdout); } catch { return null; } };
  const mine = judgeAudit(await audit(rwt));
  const base = new Set(judgeAudit(await audit(baseDir)).map((f) => `${f.rule}:${f.detail}`));
  lists.push(mine.filter((f) => f.rule === 'audit-unreadable' || !base.has(`${f.rule}:${f.detail}`)));

  const verdict = securityVerdict(...lists);
  if (verdict.ok && files.length) {
    try { await redTeam(rt, { stage: 'S6', diffText: fixText.stdout, files, staticFindings: st.findings, scope: 'the whole nightly batch of fixes' }); }
    catch (e) { if (e instanceof AutofixAbort) verdict.findings.push({ path: '*', line: null, rule: 'redteam-flagged', detail: e.detail, excerpt: '' }); else throw e; }
  }
  return { ok: verdict.findings.length === 0, findings: verdict.findings, changed };
}
