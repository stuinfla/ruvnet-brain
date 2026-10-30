// Fixture stand-in for scripts/approved-runtime.mjs: resolves any tag unless FAKE_RUNTIME_FAIL is set.
import fs from 'node:fs';
const out = process.argv[process.argv.indexOf('--out') + 1];
if (process.env.FAKE_RUNTIME_FAIL) process.exit(1);
if (out) fs.writeFileSync(out, '{"resolved":true}');
