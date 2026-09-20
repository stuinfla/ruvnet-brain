// Correlation is not authorization: protected-release still enforces its own release authority.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function selectCorpusDispatch(runs, { sha, dispatchId, notBefore }) {
  if (!/^[a-f0-9]{40}$/.test(sha || '') || !/^corpus-\d+-\d+$/.test(dispatchId || '')
    || !Number.isFinite(Date.parse(notBefore))) throw new Error('invalid corpus dispatch identity');
  const matches = runs.filter(run => run.event === 'workflow_dispatch' && run.head_sha === sha
    && run.head_branch === 'main' && run.display_title === `protected-release corpus ${dispatchId}`
    && Date.parse(run.created_at) >= Date.parse(notBefore));
  if (matches.length > 1) throw new Error('multiple runs claim the corpus dispatch identity');
  return matches[0] || null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const response = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const run = selectCorpusDispatch(response.workflow_runs || [], {
    sha: process.env.CANDIDATE_SHA, dispatchId: process.env.CORPUS_DISPATCH_ID,
    notBefore: process.env.DISPATCHED_AT,
  });
  if (run) console.log(JSON.stringify(run));
}
