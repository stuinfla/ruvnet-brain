// The one prompt hook: prints the health line and nothing else. Reads a few small files, starts
// nothing, writes nothing, and never touches the current project.
import { brainHome } from '../../contract/home.mjs';
import { verdict } from '../../contract/verdict.mjs';
import { readEvidence } from '../../health/status.mjs';
import { renderLine } from '../../health/line.mjs';

let line;
try {
  line = renderLine(verdict(readEvidence(brainHome())));
} catch (e) {
  line = `[RuvNet Brain UNKNOWN · the health line could not be read (${String(e?.message ?? e).slice(0, 60)}) · fix: ruvnet-brain doctor]`;
}
process.stdout.write(line + '\n');
