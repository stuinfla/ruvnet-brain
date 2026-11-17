// SYNTHETIC answering command for the answer gate's tests: no model, canned answers chosen by a word
// in the prompt, and a per-question run counter kept in $WP8_STUB_STATE so an answer can differ
// between runs. It also records that it was given the installed brain home.
import fs from 'node:fs';
import path from 'node:path';

const prompt = fs.readFileSync(0, 'utf8');
const state = process.env.WP8_STUB_STATE;
const key = ['brindlewort', 'gloamwick', 'tidewrack', 'thistledown', 'marrowlight', 'zephyrlattice'].find((w) => prompt.includes(w)) ?? 'none';
const file = path.join(state, `${key}.count`);
const run = (fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0) + 1;
fs.writeFileSync(file, String(run));
fs.appendFileSync(path.join(state, 'homes.log'), `${process.env.RUVNET_BRAIN5_HOME ?? ''} ${process.argv.slice(2).join(' ')}\n`);
const answers = {
  brindlewort: () => 'Use cosine_brindlewort in alpha-vectors/src/distance.rs.',
  gloamwick: (r) => (r === 1 ? 'The gloamwick journal, described in beta-memory/docs/DESIGN.md.' : 'See beta-memory/README.md.'),
  tidewrack: (r) => (r < 3 ? 'TidewrackEpisodeStore.recallByLantern in beta-memory/src/episode_store.ts.' : 'It filters episodes by a word.'),
  thistledown: () => 'ThistledownQueen.assign in gamma-swarm/src/queen_coordinator.py, with the backoff in gamma-swarm/src/scheduler.py.',
  marrowlight: () => 'descend_marrowlight in alpha-vectors/src/hnsw_index.rs.',
  zephyrlattice: () => 'The zephyrlattice mincut is built into alpha-vectors.\nSee delta-graph/src/mincut_walker.rs.',
  none: () => 'I do not know.',
};
process.stdout.write(answers[key](run));
