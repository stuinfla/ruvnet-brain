// The prompt hook program: prints the health line and nothing else. It reads a few small files in
// the brain home, starts no program, writes nothing, and never reads the current project.
// The shim's hook entry runs it: `import '../../health/hook.mjs';`
import { currentLine } from './line.mjs';

process.stdout.write(currentLine().line + '\n');
