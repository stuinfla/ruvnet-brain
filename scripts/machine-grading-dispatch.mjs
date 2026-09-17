#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const arg=(a,n)=>{const i=a.indexOf(n);return i<0?null:a[i+1]};
export function main(argv=process.argv.slice(2), env=process.env) {
  try {
    const sha=arg(argv,'--candidate-sha'), ref=arg(argv,'--ref'), fable=arg(argv,'--fable'), astra=arg(argv,'--astra'), identity=arg(argv,'--identity');
    if (!/^[a-f0-9]{40}$/.test(sha||'') || !/^[A-Za-z0-9._/-]+$/.test(ref||'') || !fable || !astra || !identity) throw new Error('usage: --candidate-sha <sha> --ref <branch-or-tag-at-sha> --fable <receipt> --astra <receipt> --identity <json>');
    const read=(file)=>Buffer.from(fs.readFileSync(path.resolve(file))).toString('base64');
    const values={candidate_sha:sha,fable_receipt_b64:read(fable),astra_receipt_b64:read(astra),release_identity_b64:read(identity)};
    const total=Object.values(values).reduce((n,v)=>n+Buffer.byteLength(v),0); if (total>60000) throw new Error('dispatch payload exceeds GitHub workflow input budget');
    execFileSync('gh',['workflow','run','machine-grading-intake.yml','--repo',env.GITHUB_REPOSITORY||'stuinfla/ruvnet-brain','--ref',ref,'-f',`candidate_sha=${sha}`,'-f',`fable_receipt_b64=${values.fable_receipt_b64}`,'-f',`astra_receipt_b64=${values.astra_receipt_b64}`,'-f',`release_identity_b64=${values.release_identity_b64}`],{stdio:'inherit'});
    return 0;
  } catch(error){ process.stderr.write(`machine-grading-dispatch: ${error.message}\n`); return 1; }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=main();
