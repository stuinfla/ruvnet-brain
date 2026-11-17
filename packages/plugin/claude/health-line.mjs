// The one prompt hook: prints the health line and nothing else. Started by the launcher (bin/rb5,
// bin/rb5.cmd) with a Node it has checked. A Node below the minimum exits 3 in runtime.mjs first; the
// line itself comes from packages/health/hook.mjs, the same assess() that `status` and `doctor` print.
// It reads a few small files, starts nothing, writes nothing, and never touches the current project.
import './runtime.mjs';
import '../../health/hook.mjs';
