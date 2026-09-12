import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const NIGHTLY_LABEL = 'com.ruvnet.brain-update';
export const NIGHTLY_HOUR = 3;
export const NIGHTLY_MINUTE = 47;
export const NIGHTLY_PROOF_LABEL = /^com\.ruvnet\.brain-update\.proof-[A-Za-z0-9._-]+$/;
export const NIGHTLY_ENV_ALLOWLIST = Object.freeze([
  'PATH', 'HOME', 'USERPROFILE', 'RUVNET_BRAIN_HOME', 'RUVNET_BRAIN_KB', 'npm_config_cache', 'NO_COLOR', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP',
]);

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const xmlEscape = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
const homeOf = (env) => env.HOME || env.USERPROFILE || os.homedir();
const SAFE_PHASE = /^[A-Za-z0-9._-]+$/;

function validateIdentity(identity) {
  if (identity !== NIGHTLY_LABEL && !NIGHTLY_PROOF_LABEL.test(identity)) {
    throw new Error(`unsafe nightly scheduler identity: ${identity || '(unset)'}`);
  }
  return identity;
}

function registrationName(identity) {
  return identity === NIGHTLY_LABEL ? 'registration.json' : `registration-${identity}.json`;
}

function normalizePackageTarget(target = { spec: 'ruvnet-brain@latest', sha256: null }) {
  const spec = String(target?.spec || '');
  const digest = target?.sha256 ?? null;
  if (spec === 'ruvnet-brain@latest' && digest === null) return { spec, sha256: null };
  if (!path.isAbsolute(spec) || !spec.endsWith('.tgz') || !/^[a-f0-9]{64}$/.test(String(digest))) {
    throw new Error('nightly proof package target must be an absolute tarball with a SHA-256 digest');
  }
  const actual = sha256(fs.readFileSync(spec));
  if (actual !== digest) throw new Error('nightly proof package target digest mismatch');
  return { spec: path.resolve(spec), sha256: digest };
}

function normalizeBundleTarget(target, identity) {
  if (identity === NIGHTLY_LABEL) {
    if (target !== null && target !== undefined) throw new Error('production nightly registration cannot pin a local bundle');
    return null;
  }
  const spec = String(target?.spec || '');
  const digest = String(target?.sha256 || '');
  let stat;
  try { stat = fs.lstatSync(spec); } catch { /* handled below */ }
  if (!path.isAbsolute(spec) || !spec.endsWith('.zip') || !stat?.isFile() || stat.isSymbolicLink()
    || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error('nightly proof bundle target must be a regular absolute ZIP with a SHA-256 digest');
  }
  const actual = sha256(fs.readFileSync(spec));
  if (actual !== digest) throw new Error('nightly proof bundle target digest mismatch');
  return { spec: path.resolve(spec), sha256: digest };
}

// The scheduler is a self-contained installed read model. The producer owns the phase vocabulary
// and carries it in each receipt; this adapter validates that declared contract without redefining
// the semantic phase list inside the plugin payload.
export function validateRefreshReceiptEnvelope(receipt) {
  if (!receipt || receipt.schemaVersion !== 3 || receipt.kind !== 'ruvnet-brain-refresh-run') {
    return { ok: false, why: 'receipt schema is invalid' };
  }
  const declared = receipt.requiredPhaseOrder;
  const phases = receipt.phases;
  if (!Array.isArray(declared) || declared.length === 0 || !Array.isArray(phases)
    || declared.some((phase) => typeof phase !== 'string' || !SAFE_PHASE.test(phase))
    || new Set(declared).size !== declared.length) {
    return { ok: false, why: 'declared phase contract is invalid' };
  }
  if (JSON.stringify(phases.map(({ phase }) => phase)) !== JSON.stringify(declared)) {
    return { ok: false, why: 'phase ledger differs from its declared contract' };
  }
  const requiredFailure = phases.find((phase) => phase.required !== false && phase.status !== 'PASS');
  if (receipt.status !== 'SUCCEEDED' || !['applied', 'noop'].includes(receipt.terminalVerdict) || requiredFailure) {
    return { ok: false, why: requiredFailure
      ? `required phase ${requiredFailure.phase}=${requiredFailure.status}`
      : `terminal state is ${receipt.status}/${receipt.terminalVerdict || 'unknown'}` };
  }
  return { ok: true };
}

/**
 * An ABORTED run is not a malformed receipt. kb/refresh-run.mjs appends a phase as it completes and
 * stops at the first required failure, so every aborted run's ledger is a strict prefix of its
 * declared order — by design. `validateRefreshReceiptEnvelope` rightly rejects that shape (the
 * two-run PROOF needs a full, successful ledger), but the health READER must not report "invalid:
 * phase ledger differs from its declared contract" for a run that failed early for a stated reason
 * and then throw the reason away (measured 2026-09-12: two FAILED receipts, cause "unresolved
 * rollback state exists…", surfaced to nobody). Returns the failure sentence, or null when the
 * receipt is not a FAILED prefix-shaped run — then the envelope validator speaks.
 */
export function describeFailedRefreshRun(receipt, { reasonLimit = 200 } = {}) {
  if (receipt?.status !== 'FAILED' || !Array.isArray(receipt.requiredPhaseOrder) || !Array.isArray(receipt.phases)) return null;
  const declared = receipt.requiredPhaseOrder;
  const ledger = receipt.phases.map((entry) => entry?.phase);
  if (ledger.length > declared.length || ledger.some((phase, index) => phase !== declared[index])) return null;
  if (ledger.length === 0) return `failed before its first phase (${receipt.terminalVerdict || 'unknown'})`;
  const failing = [...receipt.phases].reverse().find((entry) => entry?.status !== 'PASS') || receipt.phases[receipt.phases.length - 1];
  const reason = String(failing.evidence?.updateResult?.reason ?? failing.evidence?.reason ?? '').split('\n')[0].trim();
  return reason ? `failed at ${failing.phase}: ${reason.slice(0, reasonLimit)}` : `failed at ${failing.phase}`;
}

function sameExecutable(left, right) {
  try { return fs.realpathSync(left) === fs.realpathSync(right); }
  catch { return path.resolve(left || '') === path.resolve(right || ''); }
}

function inspectRefreshOwner(owner) {
  if (!owner || owner.host !== os.hostname() || !Number.isSafeInteger(owner.pid)
    || owner.pid < 1 || !owner.processStart || !owner.executable) return 'unknown';
  try { process.kill(owner.pid, 0); } catch (error) { return error?.code === 'EPERM' ? 'unknown' : 'dead'; }
  try {
    if (process.platform === 'win32') {
      const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `$p=Get-Process -Id ${owner.pid} -ErrorAction Stop; `
        + `Write-Output ($p.StartTime.ToUniversalTime().ToString('o') + '|' + $p.Path)`], { encoding: 'utf8' });
      if (result.status !== 0) return 'unknown';
      const [processStart, ...rest] = String(result.stdout || '').trim().split('|');
      return processStart === owner.processStart && sameExecutable(rest.join('|'), owner.executable) ? 'live' : 'dead';
    }
    const started = spawnSync('ps', ['-p', String(owner.pid), '-o', 'lstart='], {
      encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' },
    });
    const command = spawnSync('ps', ['-p', String(owner.pid), '-o', 'comm='], { encoding: 'utf8' });
    if (started.status !== 0 || command.status !== 0) return 'unknown';
    return String(started.stdout || '').trim() === owner.processStart
      && sameExecutable(String(command.stdout || '').trim(), owner.executable) ? 'live' : 'dead';
  } catch { return 'unknown'; }
}

export function installNightlyRunner({ brainHome, source, nodePath = process.execPath,
  identity = NIGHTLY_LABEL, packageTarget, bundleTarget, env = {} } = {}) {
  validateIdentity(identity);
  if (!source || !fs.existsSync(source)) throw new Error(`nightly runner source is missing: ${source || '(unset)'}`);
  const bytes = fs.readFileSync(source);
  const digest = sha256(bytes);
  const dir = path.join(brainHome, 'scheduler');
  const runnerPath = path.join(dir, `nightly-refresh-${digest}.mjs`);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(runnerPath) && sha256(fs.readFileSync(runnerPath)) !== digest) {
    throw new Error(`nightly runner at ${runnerPath} does not match its content-addressed identity`);
  }
  if (!fs.existsSync(runnerPath)) fs.writeFileSync(runnerPath, bytes, { mode: 0o755 });
  const record = { schemaVersion: 2, kind: 'ruvnet-brain-nightly-scheduler', identity,
    nodePath: path.resolve(nodePath), runnerPath, runnerSha256: digest, argv: [],
    environment: Object.fromEntries(NIGHTLY_ENV_ALLOWLIST.filter(key => env[key] !== undefined).map(key => [key, String(env[key])])),
    packageTarget: normalizePackageTarget(packageTarget), bundleTarget: normalizeBundleTarget(bundleTarget, identity) };
  const recordPath = path.join(dir, registrationName(identity));
  const tmp = `${recordPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  fs.renameSync(tmp, recordPath);
  return { ...record, recordPath };
}

export function readNightlyRegistration({ brainHome, identity = NIGHTLY_LABEL,
  recordPath = path.join(brainHome, 'scheduler', registrationName(identity)) }) {
  try {
    validateIdentity(identity);
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    if (record.schemaVersion !== 2 || record.kind !== 'ruvnet-brain-nightly-scheduler' || record.identity !== identity
      || !path.isAbsolute(record.nodePath) || !path.isAbsolute(record.runnerPath)
      || !Array.isArray(record.argv) || record.argv.length !== 0) throw new Error('invalid registration schema');
    if (record.environment !== undefined && (!record.environment || Array.isArray(record.environment) || Object.entries(record.environment).some(([key, value]) => !NIGHTLY_ENV_ALLOWLIST.includes(key) || typeof value !== 'string'))) throw new Error('invalid registered environment');
    const actual = sha256(fs.readFileSync(record.runnerPath));
    if (actual !== record.runnerSha256) throw new Error('runner digest mismatch');
    const packageTarget = normalizePackageTarget(record.packageTarget);
    const bundleTarget = normalizeBundleTarget(record.bundleTarget, identity);
    return { ok: true, record: { ...record, packageTarget, bundleTarget, recordPath } };
  } catch (error) {
    return { ok: false, recordPath, why: error.message };
  }
}

export function verifyNightlyExecutionIdentity({ brainHome, env = process.env } = {}) {
  const recordPath = String(env.RUVNET_NIGHTLY_REGISTRATION || '');
  if (!path.isAbsolute(recordPath)) return { ok: false, why: 'nightly registration path is missing or not absolute' };
  const identity = String(env.RUVNET_NIGHTLY_IDENTITY || '');
  const registration = readNightlyRegistration({ brainHome, identity, recordPath });
  if (!registration.ok) return registration;
  const record = registration.record;
  const observed = {
    schedulerIdentity: String(env.RUVNET_NIGHTLY_IDENTITY || ''),
    registrationPath: recordPath,
    nodePath: String(env.RUVNET_NIGHTLY_NODE_PATH || ''),
    runnerPath: String(env.RUVNET_NIGHTLY_RUNNER_PATH || ''),
    runnerSha256: String(env.RUVNET_NIGHTLY_RUNNER_SHA256 || ''),
    argv: [],
  };
  if (observed.schedulerIdentity !== record.identity
    || path.resolve(observed.nodePath || '') !== record.nodePath
    || path.resolve(observed.runnerPath || '') !== record.runnerPath
    || observed.runnerSha256 !== record.runnerSha256) {
    return { ok: false, why: 'nightly execution identity differs from the verified registration', record };
  }
  return { ok: true, identity: observed, record };
}

export function resolveNightlyProofBundle({ brainHome, env = process.env } = {}) {
  if (env.RUVNET_NIGHTLY !== '1') return null;
  const execution = verifyNightlyExecutionIdentity({ brainHome, env });
  if (!execution.ok) throw new Error(execution.why);
  return execution.record.bundleTarget;
}

export function refreshRunHealth({ brainHome, identity = NIGHTLY_LABEL, now = Date.now(), maxAgeHours = 30,
  inspectOwner = inspectRefreshOwner } = {}) {
  const dir = path.join(brainHome, 'refresh-runs');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  } catch { return { state: 'never-ran', evidence: 'No nightly refresh receipt exists yet.', receipt: null }; }
  let receipt = null;
  let unreadable = null;
  for (const name of files) {
    try {
      const candidate = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (candidate.kind === 'ruvnet-brain-refresh-run' && candidate.action === 'nightly'
        && candidate.schedulerIdentity === identity) {
        const candidateStamp = Date.parse(candidate.finishedAt || candidate.startedAt || '');
        const receiptStamp = Date.parse(receipt?.finishedAt || receipt?.startedAt || '');
        if (!receipt || (Number.isFinite(candidateStamp) && (!Number.isFinite(receiptStamp) || candidateStamp > receiptStamp))) {
          receipt = candidate;
        }
      }
    } catch (error) { unreadable ||= `${name}: ${error.message}`; }
  }
  if (!receipt) return unreadable
    ? { state: 'failed', evidence: `Nightly receipt is unreadable (${unreadable}).`, receipt: null }
    : { state: 'never-ran', evidence: 'No nightly refresh receipt exists yet.', receipt: null };
  const stamp = Date.parse(receipt.finishedAt || receipt.startedAt || '');
  if (!Number.isFinite(stamp)) return { state: 'failed', evidence: 'Latest nightly receipt has no valid timestamp.', receipt };
  const ageHours = (now - stamp) / 3_600_000;
  const registration = readNightlyRegistration({ brainHome, identity });
  if (!registration.ok) return { state: 'failed', ageHours,
    evidence: `Nightly registration is invalid: ${registration.why}`, receipt };
  const expectedIdentity = { schedulerIdentity: registration.record.identity,
    registrationPath: registration.record.recordPath, nodePath: registration.record.nodePath,
    runnerPath: registration.record.runnerPath, runnerSha256: registration.record.runnerSha256, argv: [] };
  if (receipt.schedulerIdentity !== registration.record.identity
    || JSON.stringify(receipt.executableIdentity) !== JSON.stringify(expectedIdentity)) {
    return { state: 'failed', ageHours, evidence: 'Nightly receipt is not bound to the registered runner bytes.', receipt };
  }
  if (['RUNNING', 'SETTLING'].includes(receipt.status)) {
    const owner = inspectOwner(receipt.ownerToken);
    if (owner === 'live') return { state: 'running', ageHours, evidence: `Nightly refresh ${receipt.runId} has a live exact owner.`, receipt };
    return { state: owner === 'dead' ? 'failed' : 'unknown', ageHours,
      evidence: owner === 'dead'
        ? `Nightly refresh ${receipt.runId} has a dead exact owner.`
        : `Nightly refresh ${receipt.runId} owner cannot be established exactly.`, receipt };
  }
  // A FAILED run whose ledger is a prefix of its contract failed for a reason the receipt carries.
  // Say where and why; "invalid" is reserved for receipts that are genuinely out of contract.
  const failure = describeFailedRefreshRun(receipt);
  if (failure) {
    return { state: 'failed', ageHours, receipt,
      evidence: `Nightly refresh ${receipt.runId} ${failure}${/[.!?]$/.test(failure) ? '' : '.'}` };
  }
  const envelope = validateRefreshReceiptEnvelope(receipt);
  if (!envelope.ok) return { state: 'failed', ageHours,
    evidence: `Nightly refresh ${receipt.runId} is invalid: ${envelope.why}.`, receipt };
  if (ageHours > maxAgeHours) {
    return { state: 'stale', ageHours, evidence: `Last verified nightly refresh is ${ageHours.toFixed(1)}h old.`, receipt };
  }
  // envelope.ok already implies status SUCCEEDED and terminalVerdict applied|noop.
  return { state: 'ok', ageHours,
    evidence: `Last nightly refresh ${receipt.terminalVerdict} ${ageHours.toFixed(1)}h ago; envelope verified.`, receipt };
}

export function nightlyCommand(record) {
  return `${shellQuote(record.nodePath)} ${shellQuote(record.runnerPath)} --registration ${shellQuote(record.recordPath)}`;
}

export function nightlyArtifact({ platform = process.platform, env = process.env, brainHome,
  identity = NIGHTLY_LABEL } = {}) {
  validateIdentity(identity);
  const home = homeOf(env);
  if (platform === 'darwin') return { supported: true, platform, kind: 'launchd', label: identity,
    path: path.join(home, 'Library', 'LaunchAgents', `${identity}.plist`) };
  if (platform === 'linux') return { supported: true, platform, kind: 'cron', label: identity,
    path: `crontab:${identity}` };
  if (platform === 'win32') return { supported: true, platform, kind: 'task-scheduler', label: identity,
    path: `Task Scheduler:${identity}` };
  return { supported: false, platform, kind: 'unsupported', label: identity,
    path: path.join(brainHome || home, 'scheduler', registrationName(identity)) };
}

function schedulerEnvironment(record, env = {}) {
  const result = {};
  for (const key of NIGHTLY_ENV_ALLOWLIST) if (env[key] !== undefined) result[key] = String(env[key]);
  return { ...result,
    RUVNET_NIGHTLY_REGISTRATION: record.recordPath,
    RUVNET_NIGHTLY_IDENTITY: record.identity,
  };
}

export function launchdPlist(record, { kbDir, logPath, pathValue, env = {} }) {
  const home = homeOf(env);
  const schedulerPath = [...new Set([
    path.dirname(record.nodePath), path.join(home, '.npm-global', 'bin'), path.join(home, '.local', 'bin'),
    ...String(pathValue || '').split(':').filter(Boolean), '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  ])].join(':');
  const environment = schedulerEnvironment(record, { ...env, ...record.environment, PATH: schedulerPath });
  const environmentXml = Object.entries(environment).map(([key, value]) =>
    `<key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xmlEscape(record.identity)}</string>
  <key>ProgramArguments</key><array>
    <string>${xmlEscape(record.nodePath)}</string>
    <string>${xmlEscape(record.runnerPath)}</string>
  </array>
  <key>EnvironmentVariables</key><dict>${environmentXml}</dict>
  <key>WorkingDirectory</key><string>${xmlEscape(kbDir)}</string>
  <key>StandardOutPath</key><string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>${NIGHTLY_HOUR}</integer><key>Minute</key><integer>${NIGHTLY_MINUTE}</integer></dict>
  <key>RunAtLoad</key><false/>
</dict></plist>
`;
}

export function cronLine(record, logPath, { proofTick = false, proofAt } = {}) {
  if (proofTick && !NIGHTLY_PROOF_LABEL.test(record.identity)) throw new Error('proof cadence requires proof identity');
  const at = new Date(proofAt);
  if (proofTick && !Number.isFinite(at.getTime())) throw new Error('proof cadence requires explicit proofAt timestamp');
  const schedule = proofTick ? `${at.getMinutes()} ${at.getHours()} ${at.getDate()} ${at.getMonth() + 1} *` : `${NIGHTLY_MINUTE} ${NIGHTLY_HOUR} * * *`;
  return `${schedule} ${nightlyCommand(record)} >> ${shellQuote(logPath)} 2>&1 # ${record.identity}`;
}

const xmlDecode = value => value.replace(/&#(?:x([a-f0-9]+)|([0-9]+));|&(amp|lt|gt|quot|apos);/gi,
  (_match, hex, dec, named) => hex || dec ? String.fromCodePoint(parseInt(hex || dec, hex ? 16 : 10))
    : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[named.toLowerCase()]);
const onlyXmlMatch = (xml, pattern) => { const hits = [...xml.matchAll(pattern)]; return hits.length === 1 ? hits[0][1] : null; };
const windowsArguments = record => `"${record.runnerPath}" --registration "${record.recordPath}"`;
function windowsTaskXml(record) {
  const boundary = new Date(Date.now() + 60_000).toISOString();
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Author>RuvNet Brain</Author></RegistrationInfo>
  <Triggers><CalendarTrigger><StartBoundary>${boundary}</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT1H</ExecutionTimeLimit></Settings>
  <Actions Context="Author"><Exec><Command>${xmlEscape(record.nodePath)}</Command><Arguments>${xmlEscape(windowsArguments(record))}</Arguments></Exec></Actions>
</Task>`;
}
function exactWindowsCommand(xml, record) {
  const actions = onlyXmlMatch(xml, /<Actions(?:\s[^>]*)?>([\s\S]*?)<\/Actions>/g);
  if (actions === null || actions.replace(/<Exec(?:\s[^>]*)?>[\s\S]*?<\/Exec>/g, '').trim()) return false;
  const exec = onlyXmlMatch(actions, /<Exec(?:\s[^>]*)?>([\s\S]*?)<\/Exec>/g);
  if (exec === null) return false;
  const command = onlyXmlMatch(exec, /<Command>([^<]*)<\/Command>/g);
  const args = onlyXmlMatch(exec, /<Arguments>([^<]*)<\/Arguments>/g);
  return command !== null && args !== null && [record.nodePath, `"${record.nodePath}"`].includes(xmlDecode(command))
    && xmlDecode(args) === windowsArguments(record);
}
function exactLaunchdCommand(plist, record) {
  const array = onlyXmlMatch(plist, /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/g);
  const environment = onlyXmlMatch(plist, /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/g);
  if (/<key>Program<\/key>/.test(plist) || array === null || environment === null || array.replace(/<string>[^<]*<\/string>/g, '').trim()) return false;
  const argv = [...array.matchAll(/<string>([^<]*)<\/string>/g)].map(match => xmlDecode(match[1]));
  if (JSON.stringify(argv) !== JSON.stringify([record.nodePath, record.runnerPath])) return false;
  const entries = [...environment.matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)];
  if (environment.replace(/<key>[^<]*<\/key>\s*<string>[^<]*<\/string>/g, '').trim()) return false;
  const env = Object.fromEntries(entries.map(([, key, value]) => [xmlDecode(key), xmlDecode(value)]));
  if (Object.keys(env).length !== entries.length || Object.keys(env).some(key => ![...NIGHTLY_ENV_ALLOWLIST, 'RUVNET_NIGHTLY_REGISTRATION', 'RUVNET_NIGHTLY_IDENTITY'].includes(key))) return false;
  return env.RUVNET_NIGHTLY_REGISTRATION === record.recordPath && env.RUVNET_NIGHTLY_IDENTITY === record.identity
    && Object.entries(record.environment || {}).every(([key, value]) => key === 'PATH' || env[key] === value);
}

// Test mode persists simulated state only below the explicitly isolated fixture home.
function fixtureSchedulerRun(env, platform, identity) {
  const home = env.HOME || env.USERPROFILE;
  if (!home || !path.isAbsolute(home)) throw new Error('scheduler test mode requires an explicit absolute fixture home');
  const file = path.join(home, '.ruvnet-scheduler-test', `${platform}-${identity}.json`);
  return (_cmd, args, options = {}) => {
    if (args[0] === '-l') return { status: 0, stdout: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '' };
    if (args[0] === '/Query') return fs.existsSync(file)
      ? { status: 0, stdout: fs.readFileSync(file, 'utf8') }
      : { status: 1, stderr: 'The system cannot find the file specified.' };
    if (args[0] === '/Delete') { fs.rmSync(file, { force: true }); return { status: 0 }; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const command = args[args.indexOf('/TR') + 1];
    const task = command?.match(/^"([^"]+)" (.*)$/);
    fs.writeFileSync(file, args[0] === '-' ? options.input
      : `<Task><Actions><Exec><Command>${xmlEscape(task[1])}</Command><Arguments>${xmlEscape(task[2])}</Arguments></Exec></Actions></Task>`);
    return { status: 0 };
  };
}

const ownsCronRow = (row, identity) => row.trimEnd().endsWith(`# ${identity}`);

function cronRows(run) {
  const listed = run('crontab', ['-l'], { encoding: 'utf8' });
  if (listed.error) return { ok: false, why: 'no crontab command was found on this system' };
  if (listed.status !== 0 && !/^(?:[^\n]*: )?no crontab for [^\n]+$/i.test(String(listed.stderr || '').trim())) return { ok: false, why: String(listed.stderr || listed.stdout || `crontab exited ${listed.status}`).trim() };
  return { ok: true, rows: String(listed.stdout || '').split('\n').filter(Boolean) };
}

export function installScheduler(record, { platform = process.platform, env = process.env, kbDir,
  run = spawnSync, testMode = false, proofTick = false, proofAt, pathValue = process.env.PATH || '' } = {}) {
  validateIdentity(record.identity);
  if (proofTick && !NIGHTLY_PROOF_LABEL.test(record.identity)) throw new Error('proof cadence requires proof identity');
  const artifact = nightlyArtifact({ platform, env, brainHome: path.dirname(kbDir), identity: record.identity });
  if (!artifact.supported) return { ok: false, artifact, why: `unsupported platform: ${platform}` };
  if (testMode && platform !== 'darwin') run = fixtureSchedulerRun(env, platform, record.identity);
  const logPath = path.join(kbDir, 'update.log');
  if (platform === 'darwin') {
    fs.mkdirSync(path.dirname(artifact.path), { recursive: true });
    fs.writeFileSync(artifact.path, launchdPlist(record, { kbDir, logPath, pathValue, env }));
    if (!testMode) {
      const uid = process.getuid();
      run('launchctl', ['bootout', `gui/${uid}/${record.identity}`], { stdio: 'ignore' });
      const boot = run('launchctl', ['bootstrap', `gui/${uid}`, artifact.path], { encoding: 'utf8' });
      if (boot.error || boot.status !== 0) return { ok: false, artifact, why: boot.error?.message || String(boot.stderr || `exit ${boot.status}`).trim() };
    }
    return { ok: true, artifact, already: false };
  }
  if (platform === 'linux') {
    const current = cronRows(run);
    if (!current.ok) return { ...current, artifact };
    const line = cronLine(record, logPath, { proofTick, proofAt });
    const retained = current.rows.filter((row) => !ownsCronRow(row, record.identity));
    if (current.rows.includes(line)) return { ok: true, artifact, already: true };
    const write = run('crontab', ['-'], { input: `${[...retained, line].join('\n')}\n`, encoding: 'utf8' });
    if (write.error || write.status !== 0) return { ok: false, artifact, why: write.error?.message || String(write.stderr || `exit ${write.status}`).trim() };
    return { ok: true, artifact, already: false };
  }
  const taskCommand = `"${record.nodePath}" ${windowsArguments(record)}`;
  let created;
  if (testMode) {
    // The fixture adapter models the legacy /TR call; keep it isolated from the machine path.
    created = run('schtasks', ['/Create', '/SC', 'DAILY', '/TN', record.identity, '/TR', taskCommand,
      '/ST', `${String(NIGHTLY_HOUR).padStart(2, '0')}:${String(NIGHTLY_MINUTE).padStart(2, '0')}`, '/F'], { encoding: 'utf8' });
  } else {
    // schtasks /TR rejects commands longer than 261 characters. Importing equivalent XML keeps the
    // exact Node executable and argument identity while allowing long temporary/user paths.
    const xmlPath = path.join(path.dirname(record.recordPath), `${record.identity}.task.xml`);
    // schtasks requires a UTF-16LE BOM when importing XML; without it Windows
    // reports the otherwise valid document as "one root element" malformed.
    const xmlBytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(windowsTaskXml(record), 'utf16le')]);
    fs.writeFileSync(xmlPath, xmlBytes, { flag: 'wx' });
    try { created = run('schtasks', ['/Create', '/XML', xmlPath, '/TN', record.identity, '/F'], { encoding: 'utf8' }); }
    finally { fs.rmSync(xmlPath, { force: true }); }
  }
  if (created.error || created.status !== 0) return { ok: false, artifact, why: created.error?.message || String(created.stderr || `exit ${created.status}`).trim() };
  return { ok: true, artifact, already: false };
}

export function removeScheduler({ platform = process.platform, env = process.env, run = spawnSync, testMode = false,
  identity = NIGHTLY_LABEL } = {}) {
  const artifact = nightlyArtifact({ platform, env, identity });
  if (!artifact.supported) return { ok: false, artifact, why: `unsupported platform: ${platform}` };
  if (testMode && platform !== 'darwin') run = fixtureSchedulerRun(env, platform, identity);
  if (platform === 'darwin') {
    const existed = fs.existsSync(artifact.path);
    if (!testMode) {
      run('launchctl', ['bootout', `gui/${process.getuid()}/${identity}`], { encoding: 'utf8' });
      const remaining = run('launchctl', ['print', `gui/${process.getuid()}/${identity}`], { encoding: 'utf8' });
      if (remaining.error || remaining.status === 0 || !/could not find|not found|no such process/i.test(String(remaining.stderr || remaining.stdout))) {
        return { ok: false, artifact, why: 'LaunchAgent absence could not be confirmed; local files retained' };
      }
    }
    fs.rmSync(artifact.path, { force: true });
    return { ok: true, artifact, already: !existed };
  }
  if (platform === 'linux') {
    const current = cronRows(run);
    if (!current.ok) return { ...current, artifact };
    const retained = current.rows.filter((row) => !ownsCronRow(row, identity));
    if (retained.length === current.rows.length) return { ok: true, artifact, already: true };
    const write = run('crontab', ['-'], { input: retained.length ? `${retained.join('\n')}\n` : '', encoding: 'utf8' });
    if (write.error || write.status !== 0) return { ok: false, artifact, why: write.error?.message || String(write.stderr || `exit ${write.status}`).trim() };
    return { ok: true, artifact };
  }
  const removed = run('schtasks', ['/Delete', '/TN', identity, '/F'], { encoding: 'utf8' });
  const absent = removed.status === 1 && /cannot find|does not exist/i.test(String(removed.stderr || removed.stdout));
  if (removed.error || (removed.status !== 0 && !absent)) return { ok: false, artifact, why: removed.error?.message || String(removed.stderr || `exit ${removed.status}`).trim() };
  return { ok: true, artifact, already: absent };
}

export function schedulerStatus({ platform = process.platform, env = process.env, brainHome,
  kbDir = path.join(brainHome, 'kb'), run = spawnSync, testMode = false, proofTick = false, proofAt, identity = NIGHTLY_LABEL } = {}) {
  const finish = (status) => ({ ...status, runHealth: refreshRunHealth({ brainHome, identity }) });
  const artifact = nightlyArtifact({ platform, env, brainHome, identity });
  if (!artifact.supported) return finish({ state: 'unsupported', evidence: `No scheduler adapter for ${platform}.`, artifact });
  const registration = readNightlyRegistration({ brainHome, identity });
  if (!registration.ok) return finish({ state: fs.existsSync(registration.recordPath) ? 'degraded' : 'off',
    evidence: `Registration invalid: ${registration.why}`, artifact, registration });
  const record = registration.record;
  if (testMode && platform !== 'darwin') run = fixtureSchedulerRun(env, platform, identity);
  if (platform === 'darwin') {
    if (!fs.existsSync(artifact.path)) return finish({ state: 'off', evidence: `No LaunchAgent plist at ${artifact.path}`, artifact, registration });
    const plist = fs.readFileSync(artifact.path, 'utf8');
    if (!exactLaunchdCommand(plist, record)) {
      return finish({ state: 'degraded', evidence: 'LaunchAgent command does not match the registered runner', artifact, registration });
    }
    if (testMode) return finish({ state: 'on', evidence: `LaunchAgent plist and runner digest verified at ${artifact.path}`, artifact, registration });
    const listed = run('launchctl', ['print', `gui/${process.getuid()}/${identity}`], { encoding: 'utf8' });
    const loaded = !listed.error && listed.status === 0;
    if (!loaded) return finish({ state: 'degraded', evidence: 'LaunchAgent plist exists but job is not loaded', artifact, registration });
    const exit = String(listed.stdout || '').match(/last exit code\s*=\s*(-?\d+)/i);
    // `lastExitCode` lets a projector tell "loaded, verified, FIRED and failed" from the degraded
    // states that genuinely cannot fire (not loaded, command drift) — the watchdog was collapsing
    // both into MISSING (2026-09-12).
    if (exit && Number(exit[1]) !== 0) {
      return finish({ state: 'degraded', lastExitCode: Number(exit[1]),
        evidence: `LaunchAgent is loaded and runner digest verified, but last exited ${exit[1]}`, artifact, registration });
    }
    return finish({ state: 'on', lastExitCode: exit ? Number(exit[1]) : null, evidence: exit
      ? 'LaunchAgent is loaded, runner digest verified, and last exited cleanly'
      : 'LaunchAgent is loaded and runner digest verified; no completed run is recorded yet', artifact, registration });
  }
  if (platform === 'linux') {
    const current = cronRows(run);
    const expected = cronLine(record, path.join(kbDir, 'update.log'), { proofTick, proofAt });
    const on = current.ok && current.rows.includes(expected);
    return finish({ state: on ? 'on' : !current.ok || current.rows.some((row) => ownsCronRow(row, identity)) ? 'degraded' : 'off', evidence: on ? 'Managed crontab entry and runner digest verified' : current.why || 'Exact managed crontab entry is absent', artifact, registration });
  }
  const queried = run('schtasks', ['/Query', '/TN', identity, '/XML'], { encoding: 'utf8' });
  const xml = String(queried.stdout || '');
  const on = !queried.error && queried.status === 0 && exactWindowsCommand(xml, record);
  return finish({ state: on ? 'on' : !queried.error && queried.status === 1 && /cannot find|does not exist/i.test(String(queried.stderr || queried.stdout)) ? 'off' : 'degraded', evidence: on ? 'Task Scheduler entry and runner digest verified' : 'Exact Task Scheduler entry is absent', artifact, registration });
}
