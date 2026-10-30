// scripts/issue-autofix-report.mjs — S13 / S13b of the autofix job (ADR-107): tell the people who filed issues.
// ONE note per person per night, covering all of their issues, written fresh from their own words in the full thread
// and checked by issue-autofix-notes.mjs (specific, not boilerplate, not like any earlier note to anyone, apologetic
// after a 7-day wait, truthful about what was and was not verified). A note that never passes is not posted: the
// factual report goes out without it and the owner is paged to write one. The text rules of every comment live in
// issue-autofix-comment.mjs; this module decides WHETHER to post, reading the live thread so a wiped state file can
// never cause a second comment, and closes an issue only after a `fixed` comment naming an install-verified version.
import fs from 'node:fs';
import path from 'node:path';
import { alreadyPosted, renderComment, postOutcome } from './issue-autofix-comment.mjs';
import { groupByPerson, reporterWords, waitedDays, generatePersonNote, noteText } from './issue-autofix-notes.mjs';
import { verifyTerminal } from './issue-autofix-release.mjs';
import { patchIssue, readNs, patchNs, clearAwaiting } from './issue-autofix-state.mjs';

const VIEW_FIELDS = 'number,title,author,body,labels,comments,updatedAt,state,createdAt';
const NOTES_KEPT = 400;
const NEEDS_OWNER_LABEL = { findings: ['autofix:needs-owner'], 'not-fixed': ['autofix:needs-owner'], reply: ['autofix:needs-owner'] };

export function viewIssue(rt, n) {
  const r = rt.exec(rt.ghBin, ['issue', 'view', String(n), '--repo', rt.repo, '--json', VIEW_FIELDS]);
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

const words = (t) => String(t).split(/\s+/).filter(Boolean);
export const priorNotes = (rt) => (readNs(rt.paths.state)._notesLog || []);
const openings = (notes) => notes.map((n) => `${words(n.text).slice(0, 8).join(' ')} … ${words(n.text).slice(-8).join(' ')}`);

async function writeNote(rt, login, group, now) {
  const items = group.items.map((it) => ({ number: it.issue.number, title: it.issue.title, theirWords: reporterWords(it.issue, login),
    waitedDays: waitedDays(it.issue, now), kind: it.kind, facts: it.facts }));
  const prior = [...priorNotes(rt), ...rt.tonightNotes];
  fs.mkdirSync(rt.tmpRoot, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(rt.tmpRoot, 'autofix-note-'));
  return generatePersonNote({ login, items: group.items, priorNotes: prior, now, generate: async ({ feedback }) => {
    const r = await rt.agent('note', 'S5b', tmp, { login, items, priorOpenings: openings(prior), feedback });
    return r.result;
  } });
}

/**
 * items: [{ issue (full view), kind: fixed|shipping|findings|not-fixed|reply, facts, version?, sha?, testPath?,
 *   platformCaveat?, fallback: {whatWasWrong, whatChanged?, whatItNeeds?} }]. `checkpoint` is re-run before every post.
 * Returns per-issue results. Never throws for a GitHub failure: the state keeps what still needs saying.
 */
export async function notifyPeople(rt, items, { checkpoint }) {
  const results = [];
  const now = rt.now();
  for (const group of groupByPerson(items)) {
    const login = group.login;
    let gen;
    try { gen = await writeNote(rt, login, group, now); } catch (e) { gen = { ok: false, note: null, rejections: [[`error:${e.code || e.message}`]] }; }
    if (!gen.ok) rt.page(`AUTOFIX NEEDS OWNER: write a personal thank-you to @${login}`, `No note passed the guards in ${gen.attempts ?? 0} attempts (${JSON.stringify(gen.rejections).slice(0, 400)}). Issues ${group.items.map((i) => i.issue.number).join(', ')} got the factual report only.`);
    let thanksOn = null;
    for (const it of group.items) {
      const n = it.issue.number;
      await checkpoint(n);
      const view = viewIssue(rt, n);
      if (!view) { results.push({ number: n, kind: it.kind, commented: false, error: 'cannot read the issue thread' }); continue; }
      const close = it.kind === 'fixed' && String(view.state || 'OPEN').toUpperCase() === 'OPEN';
      if (alreadyPosted(view.comments || [], { outcome: it.kind, version: it.version, issueUpdatedAt: view.updatedAt })) {
        let closed = false;
        if (close) closed = rt.exec(rt.ghBin, ['issue', 'close', String(n), '--repo', rt.repo, '--reason', 'completed']).status === 0;
        results.push({ number: n, kind: it.kind, commented: false, deduped: true, closed });
        continue;
      }
      const entry = { ...it.fallback, ...((gen.note?.perIssue || []).find((p) => p.number === n) || {}) };
      const thanks = gen.ok && thanksOn === null ? gen.note.thanks : null;
      const body = renderComment({ kind: it.kind, issueNumber: n, login: view.author?.login || login, thanks, thanksOn, entry,
        facts: it.facts, version: it.version, sha: it.sha, commitUrl: it.sha ? `https://github.com/${rt.repo}/commit/${it.sha}` : undefined,
        testPath: it.testPath, platformCaveat: it.platformCaveat || [], at: new Date(rt.now()).toISOString() });
      const r = postOutcome({ repo: rt.repo, exec: rt.exec, ghBin: rt.ghBin }, { issueNumber: n, body, close, addLabels: NEEDS_OWNER_LABEL[it.kind] || [] });
      if (r.commented && thanks) {
        thanksOn = n;
        const rec = { login: login.toLowerCase(), text: noteText(gen.note), at: new Date(rt.now()).toISOString(), issues: group.items.map((x) => x.issue.number) };
        rt.tonightNotes.push(rec);
        patchNs(rt.paths.state, { _notesLog: [...priorNotes(rt), rec].slice(-NOTES_KEPT) });
      }
      if (r.commented) {
        patchIssue(rt.paths.state, n, { outcomes: [...(readNs(rt.paths.state)[n]?.outcomes || []), { kind: it.kind, version: it.version ?? null, postedAt: new Date(rt.now()).toISOString() }],
          ...(it.kind === 'findings' ? { findingsPostedAt: new Date(rt.now()).toISOString() } : {}) });
      }
      results.push({ number: n, kind: it.kind, commented: r.commented, closed: r.closed, thanksIncluded: !!(r.commented && thanks), error: r.error, body });
    }
  }
  return results;
}

/**
 * S13b: issues whose release was published but not yet install-verified. Runs EVEN WHILE HALTED (it only reads and
 * comments): when the terminal check now passes, say `fixed` and close; after 72 h unresolved, page.
 */
export async function recheckAwaiting(rt, ctx, { checkpoint }) {
  const done = [];
  const due = [];
  for (const [key, rec] of Object.entries(readNs(rt.paths.state))) {
    const a = rec?.awaitingVerification;
    if (!/^\d+$/.test(key) || !a) continue;
    const n = Number(key);
    const t = await verifyTerminal(ctx, { version: a.version, sha: a.sha });
    if (!t.installVerified) {
      if (rt.now() - Date.parse(a.publishedAt) > 72 * 3_600_000) rt.page(`AUTOFIX NEEDS OWNER #${n}: v${a.version} still unverified after 72 h`, 'The release was published but its install verification never passed.', 'high');
      done.push({ number: n, outcome: 'still-awaiting' });
      continue;
    }
    const view = viewIssue(rt, n);
    if (!view) { done.push({ number: n, outcome: 'unreadable' }); continue; }
    due.push({ issue: view, kind: 'fixed', facts: { verified: [...(a.facts?.verified || []), 'install-verified on Linux, macOS and Windows'], notVerified: a.facts?.notVerified || [] },
      version: a.version, sha: a.fixSha || a.sha, testPath: a.testPath, platformCaveat: a.platformCaveat || [], fallback: a.fallback || { whatWasWrong: 'see the linked commit', whatChanged: 'see the linked commit' } });
  }
  if (!due.length) return done;
  for (const r of await notifyPeople(rt, due, { checkpoint })) {
    if (r.commented || r.deduped) {
      clearAwaiting(rt.paths.state, r.number);
      patchIssue(rt.paths.state, r.number, { lastOutcome: 'shipped' });
      rt.page(`AUTOFIX SHIPPED #${r.number}`, 'Install-verified; the reporter was told and the issue closed.', 'low');
    }
    done.push({ number: r.number, outcome: r.commented || r.deduped ? 'fixed' : 'comment-failed', error: r.error });
  }
  return done;
}
