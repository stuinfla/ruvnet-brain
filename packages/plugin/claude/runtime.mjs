// The Node minimum, checked before anything else runs. Imported first by the hook and the server
// launcher, and run on its own by the server launcher to test a Node before starting it. A Node older
// than the contract's minimum exits 3 and prints nothing, so the launcher moves on to the next one.
import { MIN_NODE } from '../../contract/constants.mjs';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) process.exit(3);
