// SYNTHETIC judge for the answer gate's tests: no model. 9 when the answer names one of the
// reference files, 4 otherwise. It records that it was NOT given a brain home (the judge is blind).
import fs from 'node:fs';
import path from 'node:path';

const prompt = fs.readFileSync(0, 'utf8');
const refs = (prompt.split('REFERENCE FILES:\n')[1] ?? '').split('\nMUST NOT CLAIM:')[0].split('\n').filter(Boolean);
const answer = prompt.split('ANSWER:\n')[1] ?? '';
if (process.env.WP8_STUB_STATE) fs.appendFileSync(path.join(process.env.WP8_STUB_STATE, 'judge.log'), `${process.env.RUVNET_BRAIN5_HOME ?? 'no-home'}\n`);
process.stdout.write(`The answer was read.\nSCORE: ${refs.some((r) => answer.includes(r)) ? 9 : 4}\n`);
