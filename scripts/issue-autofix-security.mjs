// ADR-107 static "no malware enters the app" gate for the unattended issue-autofix pipeline.
// Strangers write the issues and no human reads the diff, so every check here is deny-by-default
// and fails closed on malformed input. Pure functions only: no I/O, no imports.
// This is defense in depth: regex scanning cannot prove absence of malice; a red-team model
// review and an OS sandbox sit behind it.

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------
const SENSITIVE_WORDS = ['release', 'publish', 'install', 'update', 'upgrade', 'refresh', 'sign', 'verify', 'attest',
  'provenance', 'integrity', 'checksum', 'key', 'trust', 'token', 'secret', 'credential', 'auth', 'download', 'extract',
  'identity', 'approved-runtime', 'heartbeat', 'watchdog', 'nightly', 'notify', 'issue-', 'autofix', 'single-source',
  'doc-currency', 'census', 'corpus', 'convergence', 'version', 'wired-check', 'decision-', 'dream', 'hook',
  'entrypoint', 'telemetry', 'consent', 'footprint', 'protected-'];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const NEVER = [
  ['github', /^\.github(\/|$)/i],
  ['codeowners', /(^|\/)codeowners$/i],
  ['dotfile', /(^|\/)\./],
  ['manifest', /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/i],
  ['protected-dir', /^(keys|sbom|deploy|overlays|data|config|bin|docs\/adr|plugin\/hooks|plugin\/\.claude-plugin|\.claude-plugin)(\/|$)/i],
  ['governance', /^(contributing\.md|security\.md|license(\.[a-z]+)?)$/i],
  ['executable', /\.(sh|ps1|cmd|bat|exe|dll|so|dylib|node|wasm|bin|zip|tgz|gz|rvf)$/i],
  ['vitest-config', /(^|\/)vitest\.config[^/]*$/i],
  ['sensitive-name', new RegExp(`(^|/)[^/]*(${SENSITIVE_WORDS.map(esc).join('|')})[^/]*$`, 'i')],
];
export const NEVER_EDITABLE = NEVER.map(([, re]) => re);

export const EDITABLE_ALLOW = [
  /^scripts\/[^/]+\.(mjs|js|cjs|ts|md)$/i,
  /^plugin\/(scripts|mcp)\/.+\.(mjs|js|cjs|ts|md)$/i,
  /^plugin\/(commands|skills)\/.+\.md$/i,
  /^plugin\/test\/.+\.(mjs|js|cjs|ts|md)$/i,
  /^kb\/[^/]+\.mjs$/i,
  /^console\/.+\.(mjs|js|cjs|ts|md|html|css)$/i,
  /^tri-smart-skill\/.+\.md$/i,
  /^docs\/.+\.md$/i,
  /^readme\.md$/i,
  /^tests\/(unit|integration|regression|fixtures)\/.+\.(mjs|js|cjs|ts|md|json|txt|snap)$/i,
];

const normPath = (p) => { let s = String(p).replace(/\\/g, '/'); while (s.startsWith('./')) s = s.slice(2); return s; };

export function isEditablePath(p) {
  if (typeof p !== 'string') return { ok: false, reason: 'escape' };
  const s = normPath(p);
  // Absolute, drive-letter, traversal, empty segments, and any character outside a conservative
  // set (control chars, quotes, spaces, non-ASCII homoglyphs) are treated as an escape attempt.
  if (!s || s.startsWith('/') || /^[a-z]:/i.test(s) || s.split('/').some((seg) => seg === '' || seg === '..')
    || /[^A-Za-z0-9._\-/@+]/.test(s)) return { ok: false, reason: 'escape' };
  for (const [why, re] of NEVER) if (re.test(s)) return { ok: false, reason: `never:${why}` };
  if (EDITABLE_ALLOW.some((re) => re.test(s))) return { ok: true, reason: 'editable' };
  return { ok: false, reason: 'not-allowlisted' };
}

// ---------------------------------------------------------------------------------------------
// Added-line scanner
// ---------------------------------------------------------------------------------------------
const CODE_RE = /\.(mjs|js|cjs|ts|tsx|jsx|mts|cts)$/i;
const IMP = String.raw`(?:\brequire\s*\(\s*|\bimport\s*\(\s*|\bfrom\s*|\bimport\s+)`;
const Q = '[\'"`]';
const imp = (mods) => new RegExp(`${IMP}${Q}(?:node:)?(?:${mods})${Q}`);
const FSW = '(?:writeFile|appendFile|rm|rmdir|unlink|rename|chmod|chown|lchown|symlink|link|copyFile|cp|mkdir|mkdtemp|createWriteStream|open|truncate|utimes|lutimes)(?:Sync)?';
const ALLOWED_HOSTS = new Set(['registry.npmjs.org', 'www.npmjs.com', 'isovision.ai', 'www.isovision.ai', 'localhost', '127.0.0.1']);
const TEST_HOSTS = new Set(['example.com', 'example.org', 'www.example.com', 'www.example.org']);
const STR_RE = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
const HOME_RE = /\bhomedir\s*\(|process\.env\.(HOME|USERPROFILE|APPDATA)\b|['"`]~[/\\]|\$HOME\b/;
const FS_CALL_RE = /\b(fs|fsp|readFile|readFileSync|readdir|readdirSync|createReadStream|existsSync|stat|statSync|access|accessSync|open|openSync|glob|copyFile|copyFileSync|cp|cpSync|writeFile|writeFileSync|appendFile|appendFileSync|rm|rmSync|unlink|unlinkSync)\b/;
const INVISIBLE = /[\u202A-\u202E\u2066-\u2069\u200B-\u200F\u2028\u2029\u2060-\u2064\u206A-\u206F\u00AD\u180E\u061C\uFFF9-\uFFFB]|[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;

function entropy(s) {
  const n = new Map(); for (const c of s) n.set(c, (n.get(c) || 0) + 1);
  let h = 0; for (const k of n.values()) { const p = k / s.length; h -= p * Math.log2(p); } return h;
}
const packed = (t) => t.length >= 120 && (/^[A-Za-z0-9+/=_-]+$/.test(t) || /^(0x)?[0-9a-f]+$/i.test(t));
function longBlob(s) {
  const lits = [...s.matchAll(STR_RE)].map((m) => m[0].slice(1, -1));
  if (lits.some((c) => c.length >= 120 && (packed(c) || entropy(c) > 4.5))) return true;
  if (packed(lits.join(''))) return true; // payload split across concatenated literals
  return s.split(/\s+/).some((t) => packed(t.replace(/^[^A-Za-z0-9+/]+|[^A-Za-z0-9+/=]+$/g, '')));
}
function charCodeTrick(s) {
  const m = s.match(/fromC(?:harCode|odePoint)\s*\(([^)]*)/);
  return !!m && (m[1].split(',').length >= 4 || /\.\.\.|[\^+\-*%]/.test(m[1]) || /\b(for|while|map|reduce|forEach|apply|call)\b/.test(s));
}
function badUrl(s, ctx) {
  for (const m of s.matchAll(/([a-z][a-z0-9+.-]*):\/\/([^\s'"`<>()[\]{}\\|^]*)/gi)) {
    if (!/^https?$/i.test(m[1])) return true;
    const rest = m[2]; const cut = rest.search(/[/?#]/);
    const auth = cut < 0 ? rest : rest.slice(0, cut); const path = cut < 0 ? '' : rest.slice(cut);
    if (auth.includes('@') || /\.\.|%2e/i.test(path)) return true;
    const host = auth.replace(/:\d*$/, '').replace(/\.$/, '').toLowerCase();
    if (ALLOWED_HOSTS.has(host)) continue;
    if (host === 'github.com' && /^\/stuinfla(\/|$|[?#])/i.test(path)) continue;
    if (ctx.test && TEST_HOSTS.has(host)) continue;
    return true;
  }
  return false;
}
const stripStringsAndComments = (s) => (/^\s*(\*|\/\*)/.test(s) ? ''
  : s.replace(STR_RE, '""').replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, ''));
function hiddenUnicode(s, ctx, i) {
  if (INVISIBLE.test(s) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]|\r(?!$)/.test(s)) return true;
  if (/[\uFE00-\uFE0F]{2,}|[\x00-\x7f][\uFE00-\uFE0F]/.test(s)) return true;
  const bom = s.indexOf('\uFEFF');
  if (bom > 0 || (bom === 0 && !(i === 0 && ctx.status === 'A'))) return true;
  return ctx.code && /[^\x00-\x7f]/.test(stripStringsAndComments(bom === 0 ? s.slice(1) : s)); // homoglyph identifiers
}

// One rule entry per line (mutation tests delete entries by rule id). scope: '' all files,
// 'code' JS/TS only, 'json' .json only. raw: test the undecoded line only.
const LINE_RULES = [];
const R = (rule, test, detail, scope = '', raw = false) => LINE_RULES.push({ rule, test, detail, scope, raw });
R('network-egress', imp('net|tls|https?|http2|dgram|dns|dns/promises|undici|axios|node-fetch|got|ws|request|ssh2|ftp|socket\\.io-client'), 'imports a network module');
R('network-egress', /['"`]node:(net|tls|https?|http2|dgram|dns)(\/promises)?['"`]/, 'names a node network module');
R('network-egress', /\bfetch\s*(\(|`|\.\s*(call|apply|bind)\b)|['"`]fetch['"`]|=\s*fetch\b|\(\s*fetch\s*[,)]/, 'fetch() network call');
R('network-egress', /\b(XMLHttpRequest|WebSocket|EventSource|RTCPeerConnection|sendBeacon)\b|\bimportScripts\s*\(/, 'browser network API');
R('network-egress', badUrl, 'URL to a host outside the allow list');
R('network-egress', /(['"`]|=\s*|url\(\s*)\/\/[a-z0-9-]+(\.[a-z0-9-]+)+/i, 'protocol-relative URL');
R('process-exec', /['"`](node:)?(child_process|worker_threads|cluster)['"`]/, 'names a process-spawning module');
R('process-exec', /(?<![\w$.])(exec|execSync|execFile|execFileSync|spawn|spawnSync|fork|execa|execaSync|execaCommand)\s*\(|\.\s*(execSync|execFile|execFileSync|spawn|spawnSync|fork|execve|execa)\s*\(/, 'spawns a process');
R('process-exec', /\bnew\s+Worker\s*\(|\b(Bun\s*\.\s*spawn|Deno\s*\.\s*(run|Command))\b|['"`](execa|shelljs|cross-spawn|zx)['"`]/, 'spawns a worker or process');
R('dynamic-code', /\beval\s*[(`?]/, 'eval');
R('dynamic-code', /\beval\b/, 'reference to eval', 'code');
R('dynamic-code', /\bnew\s+(Async)?Function\b|(?<![\w$.])(Async)?Function\s*\(|\bFunction\s*\.\s*(apply|call|bind)\b|\.constructor\s*(\(|\.\s*(constructor|call|apply)\b)|\[\s*['"`]constructor['"`]\s*\]|\.\s*prototype\s*\.\s*constructor\b|\bProxy\s*\(\s*(global|globalThis|window|self|process)\b/, 'Function constructor / global proxy');
R('dynamic-code', /(?<![\w$.])with\s*\(/, 'with statement', 'code');
R('dynamic-code', /\bset(Timeout|Interval|Immediate)\s*\(\s*['"`]/, 'timer with a code string');
R('dynamic-code', /\brunIn(New|This)?Context\b|\bcompileFunction\b|\bnew\s+(vm\s*\.\s*)?(Script|SourceTextModule|SyntheticModule)\s*\(|\bWebAssembly\s*\.\s*(instantiate|compile|Module|Instance)/, 'vm / WebAssembly code execution');
R('dynamic-code', imp('vm|inspector|repl'), 'imports vm / inspector / repl');
R('dynamic-code', /['"`]node:(vm|inspector|repl)['"`]/, 'names vm / inspector / repl');
R('dynamic-code', /\b(require|import)\s*\(\s*(?!(['"])[^'"\\$]*\2\s*[,)])(?!`[^`$\\]*`\s*[,)])/, 'require/import of a non-literal specifier');
R('dynamic-code', /\brequire\s*$|[=,(:?]\s*require\s*[;,)]|\brequire\s*\.\s*(call|apply|bind)\b|\(\s*0\s*,\s*require\s*\)/, 'aliased require', 'code');
R('dynamic-code', /\b(global|globalThis|window|self|process|Reflect|module|exports|require)\s*\[/, 'computed property on a global');
R('dynamic-code', /\bReflect\s*\.\s*(get|apply|construct)\s*\(\s*(global|globalThis|window|self|process)\b/, 'Reflect access to a global');
R('obfuscation', /\bBuffer\s*\.\s*from\s*\([^)]*,\s*['"`](base64|base64url|hex|latin1|binary|ucs2|utf16le)['"`]/, 'decodes an encoded buffer');
R('obfuscation', /\batob\s*\(|\bunescape\s*\(|\bdecodeURIComponent\s*\(\s*['"`][^'"`]*(%[0-9a-f]{2}){4}/i, 'decodes an encoded string');
R('obfuscation', charCodeTrick, 'builds a string from char codes');
R('obfuscation', /(\\x[0-9a-f]{2}){6,}|(\\u(\{[0-9a-f]+\}|[0-9a-f]{4})){6,}|(\\[0-7]{3}){6,}|(%[0-9a-f]{2}){6,}/i, 'long escape sequence run', '', true);
R('obfuscation', /\\u(00[2-7][0-9a-f]|\{0*[2-7][0-9a-f]\})|\\x[2-7][0-9a-f]/i, 'escaped printable ASCII', '', true);
R('obfuscation', longBlob, 'long encoded or high-entropy literal', '', true);
R('obfuscation', /\.split\s*\(\s*(['"`])\1\s*\)\s*\.\s*reverse\s*\(|\.reverse\s*\(\s*\)\s*\.\s*join\s*\(|\[\s*(['"`][^'"`]{0,2}['"`]\s*,\s*){3,}['"`]|(['"`][^'"`]{1,3}['"`]\s*\+\s*){2,}['"`]/, 'string assembled from fragments');
R('obfuscation', /charCodeAt\s*\([^)]*\)\s*[-+^*%|&]|[-+^|&]\s*[\w$.]*\.charCodeAt\b|\.map\s*\([^)]*charCodeAt/, 'char-code arithmetic');
R('credential-access', /\.npmrc\b|\.netrc\b|\.ssh\b|\bid_(rsa|ed25519|ecdsa|dsa)\b|\.aws\b|\.config\/gh\b|\bhosts\.yml\b|\.git-credentials\b|\.gnupg\b|\bkeychains?\b|\bsecurity\s+(find|dump|export|unlock)-|\bkeytar\b|\.docker\/config|\.kube\/config|\.pypirc\b|['"`/]\.env(\.\w+)?['"`]|['"`]dotenv['"`]|\bLocal State\b|\bLogin Data\b/i, 'names a credential store');
R('credential-access', (s) => HOME_RE.test(s) && FS_CALL_RE.test(s), 'filesystem access under the home directory');
R('env-harvest', /process\.env\s*(\.\s*|\[\s*['"`])[A-Z0-9_]*(TOKEN|KEY|SECRET|PASS|NPM|GH_|GITHUB|AWS|ANTHROPIC|OPENAI|CLAUDE|CRED|AUTH|SESSION|COOKIE)/i, 'reads a secret environment variable');
R('env-harvest', /process\.env\s*\[\s*(?!['"`])|\bprocess\s*\[\s*['"`]env['"`]|\b(Deno|Bun)\s*\.\s*env\b/, 'computed environment access');
R('env-harvest', /\.\.\.\s*process\.env\b|\bin\s+process\.env\b|(Object\s*\.\s*\w+|JSON\s*\.\s*stringify|structuredClone|inspect|console\s*\.\s*\w+|Reflect\s*\.\s*ownKeys)\s*\([^)]*process\.env\s*[,)]/, 'enumerates the environment');
R('env-harvest', /=\s*process\.env\s*([;,)]|$)|\}\s*=\s*process\.env\b|\{[^}]*\benv\b[^}]*\}\s*=\s*((global|globalThis)\s*\.\s*)?process\b|(^|[^}\s])\s*=\s*((global|globalThis)\s*\.\s*)?process\s*([;,)]|$)/, 'aliases or destructures process.env');
R('env-harvest', /\b(userInfo|networkInterfaces)\s*\(|\bdocument\s*\.\s*cookie\b/, 'host or browser identity harvesting');
R('fs-outside-repo', new RegExp(`\\b${FSW}\\s*\\(\\s*(?:['"\`](?:/|~|[A-Za-z]:[\\\\/]|\\.\\.)|[^;]*(?:homedir|process\\.env\\.(?:HOME|USERPROFILE|APPDATA)|['"\`]\\.\\.['"\`]|\\.\\.[\\\\/]))`), 'filesystem write outside the repository');
R('fs-outside-repo', /\bsymlink(Sync)?\s*\(|\bprocess\s*\.\s*chdir\s*\(|['"`]file:\/\//, 'symlink / chdir / file URL');
R('fs-outside-repo', /['"`](\/(etc|usr|bin|sbin|var|private|Library|System|Applications|opt|root|proc|sys)\b|\/dev\/(?!null\b)|[A-Za-z]:\\)/, 'system path literal', 'code');
R('fs-outside-repo', HOME_RE, 'home directory reference', 'code');
R('fetch-execute', /\b(curl|wget)\b|\b(ba|z|k|da)?sh\s+-c\b|\bpowershell\b|\bpwsh\b|Invoke-(WebRequest|RestMethod|Expression)|\biex\b|\|\s*(ba|z)?sh\b|\/dev\/tcp\/|\bnc\s+-[a-z]*e|\bcertutil\b|\bbitsadmin\b|\bmshta\b|\bosascript\b/i, 'download-and-execute shell idiom');
R('hidden-unicode', hiddenUnicode, 'invisible, bidi, control or non-ASCII identifier character', '', true);
R('module-tamper', /\brequire\s*\.\s*(cache|extensions)\b|\bModule\s*\.\s*(_load|_resolveFilename|_extensions|_cache|wrap|_compile|prototype|register|_nodeModulePaths)\b|\bmodule\s*\.\s*(constructor|parent|children|paths)\b|\bcreateRequire\b|\.\s*mainModule\b|\bError\s*\.\s*prepareStackTrace\b/, 'tampers with the module system');
R('module-tamper', imp('module'), 'imports node:module');
R('module-tamper', /['"`]node:module['"`]/, 'names node:module');
R('module-tamper', /Object\s*\.\s*(defineProperty|defineProperties|assign|setPrototypeOf)\s*\(\s*(global|globalThis|window|self|process|module|exports|require|console)\b/, 'redefines a global');
R('module-tamper', /\b(global|globalThis|window)\s*\.\s*[\w$]+\s*(=(?!=)|\+=)/, 'assigns a global', 'code');
R('module-tamper', /\b(NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_\w+|npm_config_\w+)\b|--(require|import|loader|experimental-loader|inspect(-brk)?)\b/i, 'loader / preload injection');
R('native-code', /\.(node|wasm|dylib|so|dll)['"`]|\bprocess\s*\.\s*(dlopen|binding|_linkedBinding)\b|['"`](ffi-napi|node-ffi|bindings|node-gyp-build|koffi)['"`]/, 'loads native code');
R('install-hook', /["'](pre|post)?(install|uninstall)["']\s*:|["'](prepare|prepublish|prepublishOnly|prepack|postpack|dependencies)["']\s*:\s*["']/, 'npm lifecycle hook key', 'json');
R('install-hook', /\b(pre|post)(install|uninstall)\b['"`]?\s*:/, 'npm lifecycle hook key');
R('prototype-pollution', /__proto__|\[\s*['"`](prototype|constructor)['"`]\s*\]\s*(=(?!=)|\.)|\b(Object|Array|String|Function|Number|Boolean|Promise|RegExp|Date|Map|Set|Error|Buffer|JSON|Symbol|Reflect)\s*\.\s*prototype\s*(\.\s*[\w$]+|\[[^\]]*\])\s*(=(?!=)|\+=)|Object\s*\.\s*(setPrototypeOf|assign|defineProperty)\s*\(\s*(Object|Array|String|Function)\s*\.\s*prototype/, 'prototype pollution');

const safeCp = (h, m) => { const n = parseInt(h, 16); return n <= 0x10ffff ? String.fromCodePoint(n) : m; };
const decodeEscapes = (s) => s.replace(/\\u\{([0-9a-f]{1,6})\}/gi, (m, h) => safeCp(h, m))
  .replace(/\\u([0-9a-f]{4})/gi, (m, h) => safeCp(h, m)).replace(/\\x([0-9a-f]{2})/gi, (m, h) => safeCp(h, m));
// Excerpts land in issue comments and logs: escape anything non-printable (bidi, zero-width).
const excerptOf = (s) => String(s).trim().replace(/[^\x20-\x7e]/gu, (c) => `\\u{${c.codePointAt(0).toString(16)}}`).slice(0, 120);
const hit = (t, s, ctx, i) => (typeof t === 'function' ? t(s, ctx, i) : t.test(s));

export function scanAddedLines(files) {
  const out = []; const seen = new Set();
  const push = (path, line, rule, detail, text = '') => {
    const k = `${path}\0${line}\0${rule}`;
    if (!seen.has(k)) { seen.add(k); out.push({ path, line, rule, detail, excerpt: excerptOf(text) }); }
  };
  if (!Array.isArray(files)) { push('<diff>', null, 'scan-unreadable', 'files is not an array (fail closed)'); return out; }
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || (f.added != null && !Array.isArray(f.added))) {
      push(String(f?.path ?? '<unknown>'), null, 'scan-unreadable', 'malformed DiffFile (fail closed)'); continue;
    }
    if (f.symlink) push(f.path, null, 'symlink', 'symlinks can point outside the repository');
    if (f.binary) { if (f.status !== 'D') push(f.path, null, 'binary-file', 'binary content cannot be reviewed'); continue; }
    const np = normPath(f.path);
    const ctx = { path: f.path, status: f.status, code: CODE_RE.test(np), json: /\.json$/i.test(np), test: /^(tests|plugin\/test)\//i.test(np) };
    (f.added || []).forEach((line, i) => {
      if (typeof line !== 'string') { push(f.path, i + 1, 'scan-unreadable', 'added line is not a string (fail closed)'); return; }
      const dec = decodeEscapes(line);
      for (const r of LINE_RULES) {
        if ((r.scope === 'code' && !ctx.code) || (r.scope === 'json' && !ctx.json)) continue;
        if (hit(r.test, line, ctx, i) || (!r.raw && dec !== line && hit(r.test, dec, ctx, i))) push(f.path, i + 1, r.rule, r.detail, line);
      }
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Secrets and local paths
// ---------------------------------------------------------------------------------------------
const SECRET_RES = [
  ['secret', /\bgh[pousr]_[A-Za-z0-9]{36,}/, 'GitHub token'],
  ['secret', /\bgithub_pat_[A-Za-z0-9_]{22,}/, 'GitHub fine-grained token'],
  ['secret', /\bnpm_[A-Za-z0-9]{36}/, 'npm token'],
  ['secret', /\bsk-ant-[A-Za-z0-9_-]{16,}/, 'Anthropic key'],
  ['secret', /\bsk-(proj-)?[A-Za-z0-9_-]{20,}/, 'OpenAI key'],
  ['secret', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/, 'AWS access key id'],
  ['secret', /\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  ['secret', /\bAIza[0-9A-Za-z_-]{35}/, 'Google API key'],
  ['secret', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/, 'PEM private key'],
  ['secret', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, 'JWT'],
  ['local-path', /\/Users\/(?!Shared\/)[^/\s'"`]+\//, 'macOS home path'],
  ['local-path', /\/home\/[^/\s'"`]+\//, 'Linux home path'],
  ['local-path', /\b[A-Za-z]:(\\\\?|\/)Users(\\\\?|\/)[^\\/\s'"`]+/i, 'Windows home path'],
];
const MASKS = SECRET_RES.filter(([r]) => r === 'secret').map(([, re]) => new RegExp(re.source, `${re.flags}g`));

export function scanSecrets(text) {
  if (typeof text !== 'string') return [{ path: '<text>', line: null, rule: 'secret', detail: 'input is not a string (fail closed)', excerpt: '' }];
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const done = new Set();
    for (const [rule, re, detail] of SECRET_RES) {
      if (done.has(rule) || !re.test(line)) continue;
      done.add(rule);
      const masked = MASKS.reduce((s, m) => s.replace(m, (x) => `${x.slice(0, 6)}***`), line);
      out.push({ path: '<text>', line: i + 1, rule, detail, excerpt: excerptOf(masked) });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Manifest, lockfile, pack list, audit
// ---------------------------------------------------------------------------------------------
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : isObj(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
    : String(JSON.stringify(v)));
const union = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])];
const diffKeys = (a, b) => (isObj(a) && isObj(b) ? union(a, b).filter((k) => canon(a[k]) !== canon(b[k])) : ['<whole>']);
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const DEP_KEYS = new Set(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta',
  'bundledDependencies', 'bundleDependencies', 'overrides', 'resolutions', 'pnpm']);
const LIFECYCLE = new Set(['preinstall', 'install', 'postinstall', 'prepare', 'preprepare', 'postprepare', 'prepack', 'postpack',
  'prepublish', 'prepublishOnly', 'publish', 'postpublish', 'preuninstall', 'uninstall', 'postuninstall', 'dependencies']);
const mk = (path, rule, detail) => ({ path, line: null, rule, detail, excerpt: excerptOf(detail) });

export function judgeManifestChange(before, after) {
  const P = 'package.json'; const out = [];
  if (!isObj(before) || !isObj(after)) return [mk(P, 'manifest-change', 'manifest is not a parsed object (fail closed)')];
  if (before.version !== after.version && !(typeof after.version === 'string' && SEMVER.test(after.version))) {
    out.push(mk(P, 'manifest-change', 'version is not a plain semver string'));
  }
  for (const k of union(before, after)) {
    if (k === 'version' || canon(before[k]) === canon(after[k])) continue;
    if (DEP_KEYS.has(k)) out.push(mk(P, 'dependency-change', `${k} changed: ${diffKeys(before[k], after[k]).join(', ')}`));
    else if (k === 'scripts') {
      for (const s of diffKeys(before.scripts, after.scripts)) out.push(mk(P, LIFECYCLE.has(s) ? 'lifecycle-script' : 'package-scripts', `scripts.${s} added, changed or removed`));
    } else out.push(mk(P, 'manifest-change', `top-level "${k}" changed`));
  }
  return out;
}

export function judgeLockfileChange(before, after) {
  const P = 'package-lock.json';
  if (!isObj(before) || !isObj(after)) return [mk(P, 'lockfile-change', 'lockfile is not a parsed object (fail closed)')];
  const strip = (l) => {
    const c = { ...l }; delete c.version;
    if (isObj(l.packages)) {
      c.packages = { ...l.packages };
      if (isObj(l.packages[''])) { c.packages[''] = { ...l.packages[''] }; delete c.packages[''].version; }
    }
    return c;
  };
  const a = strip(before); const b = strip(after);
  if (canon(a) === canon(b)) return [];
  const both = isObj(a.packages) && isObj(b.packages);
  const top = union(a, b).filter((k) => !(both && k === 'packages') && canon(a[k]) !== canon(b[k])).map((k) => `"${k}"`);
  const pk = both ? diffKeys(a.packages, b.packages).map((p) => p || '<root>') : [];
  const more = pk.length > 5 ? ` (+${pk.length - 5} more)` : '';
  return [mk(P, 'lockfile-change', `lockfile changed beyond the version fields: ${[...top, ...pk.slice(0, 5)].join(', ')}${more}`)];
}

const VERSION_ONLY = ['package.json', 'plugin/.claude-plugin/plugin.json', '.claude-plugin/marketplace.json'];
const VERSION_SLACK_BYTES = 64; // a version bump moves a few bytes; anything bigger is not "version only"
const PACK_BINARY = /\.(node|wasm|exe|dll|so|dylib|bin|zip|tgz|gz|rvf|png|jpe?g|gif|ico|pdf|woff2?|ttf|otf|eot|webp|bmp|jar|class|pyc|o|a)$/i;
const normPack = (p) => normPath(p).replace(/^package\//, '');

export function judgePackList({ previous, candidate, changedPaths, versionOnlyPaths = VERSION_ONLY } = {}) {
  const bad = (d) => [mk('<pack>', 'pack-unreadable', d)];
  if (![previous, candidate, changedPaths, versionOnlyPaths].every(Array.isArray)) return bad('pack inputs are not arrays (fail closed)');
  const prev = new Map();
  for (const e of previous) { if (!e || typeof e.path !== 'string') return bad('malformed previous entry'); prev.set(normPack(e.path), e.size); }
  const changed = new Set(changedPaths.map(normPack)); const vonly = new Set(versionOnlyPaths.map(normPack));
  const out = [];
  for (const e of candidate) {
    if (!e || typeof e.path !== 'string' || !Number.isFinite(e.size)) { out.push(...bad('malformed candidate entry')); continue; }
    const p = normPack(e.path);
    const add = (rule, d) => out.push({ ...mk(p, rule, d), path: p });
    const inPrev = prev.has(p); const inChanged = changed.has(p);
    if (!p || p.startsWith('/') || p.split('/').includes('..')) { add('pack-unexpected-file', 'path escapes the package root'); continue; }
    if (!inPrev && !inChanged) add('pack-unexpected-file', 'file is in the tarball but neither shipped before nor in the reviewed diff');
    else if (inPrev && !inChanged && prev.get(p) !== e.size
      && !(vonly.has(p) && Math.abs(prev.get(p) - e.size) <= VERSION_SLACK_BYTES)) add('pack-unexpected-change', `size ${prev.get(p)} -> ${e.size} without a reviewed change`);
    if ((inChanged || !inPrev) && PACK_BINARY.test(p)) add('pack-binary', 'binary file added or changed');
  }
  return out;
}

export function judgeAudit(auditJson) {
  const P = '<npm-audit>';
  const v = isObj(auditJson) ? auditJson.metadata?.vulnerabilities : null;
  if (!isObj(v) || auditJson.error || !['high', 'critical'].every((k) => Number.isInteger(v[k]) && v[k] >= 0)) {
    return [mk(P, 'audit-unreadable', 'npm audit output is missing or malformed (fail closed)')];
  }
  const out = [];
  for (const [name, info] of Object.entries(isObj(auditJson.vulnerabilities) ? auditJson.vulnerabilities : {})) {
    if (info?.severity === 'high' || info?.severity === 'critical') out.push(mk(P, `audit-${info.severity}`, `${info.severity} vulnerability in ${name}`));
  }
  for (const sev of ['high', 'critical']) {
    if (v[sev] > 0 && !out.some((f) => f.rule === `audit-${sev}`)) out.push(mk(P, `audit-${sev}`, `${v[sev]} ${sev} vulnerabilities reported, none named`));
  }
  return out;
}

export function securityVerdict(...findingLists) {
  const findings = [];
  for (const l of findingLists) {
    if (Array.isArray(l)) findings.push(...l);
    else findings.push(mk('<verdict>', 'verdict-unreadable', 'a finding list was not an array (fail closed)'));
  }
  return { ok: findings.length === 0, findings };
}

export const RULES = Object.freeze([
  'network-egress', 'process-exec', 'dynamic-code', 'obfuscation', 'credential-access', 'env-harvest', 'fs-outside-repo',
  'fetch-execute', 'hidden-unicode', 'module-tamper', 'native-code', 'install-hook', 'prototype-pollution', 'binary-file',
  'symlink', 'scan-unreadable', 'secret', 'local-path', 'dependency-change', 'lifecycle-script', 'package-scripts',
  'manifest-change', 'lockfile-change', 'pack-unexpected-file', 'pack-unexpected-change', 'pack-binary', 'pack-unreadable',
  'audit-high', 'audit-critical', 'audit-unreadable', 'verdict-unreadable',
]);
