#!/usr/bin/env node
// Fixture stand-in for `claude -p` (ADR-107 simulation). The stage is read from the --json-schema it was given
// (plan / verify / redteam / note; no schema = build, which applies a patch in its cwd). Behaviour is scripted by the
// JSON file FAKE_CLAUDE_SCRIPT:
//   { plan, verify, redteam, redteamBatch, buildPatch, byIssue: { "<n>": { plan, verify, redteam, buildPatch, flipVariable } },
//     notes: { "<login>": note }, noteSeq: [note|null, ...] (consumed one per note call, overrides notes), models, flipVariable }
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf('-p') + 1] || '';
const script = JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_SCRIPT, 'utf8'));
const schema = argv.includes('--json-schema') ? argv[argv.indexOf('--json-schema') + 1] : '';
const stage = !schema ? 'build' : schema.includes('"classification"') ? 'plan' : schema.includes('"present"') ? 'redteam'
  : schema.includes('"perIssue"') ? 'note' : 'verify';
const model = argv[argv.indexOf('--model') + 1];
const issueNo = (prompt.match(/GitHub issue #(\d+)/) || prompt.match(/one fix for issue (\d+)/) || [])[1];
const batch = /whole nightly batch/.test(prompt);
const login = (prompt.match(/GitHub user @([A-Za-z0-9-]+)/) || [])[1];
const per = (issueNo && script.byIssue?.[issueNo]) || {};
if (process.env.FAKE_CLAUDE_LOG) {
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ stage, issue: issueNo ? Number(issueNo) : null, batch, login, cwd: process.cwd(),
    argv: argv.filter((a, i) => argv[i - 1] !== '-p' && a !== '-p'), env: process.env, prompt: stage === 'note' ? prompt : undefined })}\n`);
}
const served = (script.models || {})[stage] || `${model}-sim`;
const reply = { type: 'result', subtype: 'success', is_error: false, result: '', modelUsage: { [served]: { costUSD: 1 } } };
const flip = () => { const f = process.env.FAKE_GH_STATE; const st = JSON.parse(fs.readFileSync(f, 'utf8')); st.variable = 'off'; fs.writeFileSync(f, JSON.stringify(st)); };

if (stage === 'build') {
  const patch = per.buildPatch ?? script.buildPatch;
  const applied = patch && spawnSync('git', ['apply', '--reverse', '--check', patch], { cwd: process.cwd() }).status === 0;
  if (patch && !applied) { // a repair round with the same scripted patch changes nothing further
    const r = spawnSync('git', ['apply', patch], { cwd: process.cwd(), encoding: 'utf8' });
    if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(3); }
  }
  if (per.flipVariable ?? script.flipVariable) flip();
} else if (stage === 'note') {
  let note;
  if (Array.isArray(script.noteSeq)) {
    const counter = `${process.env.FAKE_CLAUDE_SCRIPT}.notes`;
    const i = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
    fs.writeFileSync(counter, String(i + 1));
    note = script.noteSeq[Math.min(i, script.noteSeq.length - 1)];
  } else note = script.notes?.[login];
  if (!note) { reply.is_error = true; reply.subtype = 'error_during_execution'; }
  reply.structured_output = note;
} else if (stage === 'redteam') {
  reply.structured_output = (batch ? script.redteamBatch : per.redteam) ?? script.redteam;
} else {
  reply.structured_output = per[stage] ?? script[stage];
}
process.stdout.write(JSON.stringify(reply));
