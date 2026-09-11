#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const TOP = Object.freeze({
  anthropic: { cli: 'claude', model: 'claude-fable-5-1', marker: 'TRISMART_CLAUDE_OK' },
  openai: { cli: 'codex', model: 'gpt-6-astra', marker: 'TRISMART_CODEX_OK' },
  xai: { cli: 'grok', model: 'grok-4.6', marker: 'TRISMART_GROK_OK' },
});
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write('Usage: node verify-access.mjs [--mode=auto|dual|tri] [--probe]\nChecks native OAuth sessions with provider API-key variables removed.\n');
  process.exit(0);
}
const requestedMode = (process.argv.find((arg) => arg.startsWith('--mode=')) || '--mode=auto').slice(7);
if (!['auto', 'dual', 'tri'].includes(requestedMode)) { process.stderr.write('mode must be auto, dual, or tri\n'); process.exitCode = 2; process.exit(); }
const API_ENV_VARS = [
  'ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','ANTHROPIC_FOUNDRY_API_KEY',
  'OPENAI_API_KEY','OPENAI_BASE_URL','CODEX_API_KEY','XAI_API_KEY','GROK_API_KEY','XAI_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY','CLAUDE_CODE_API_KEY_HELPER_TTL_MS','ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_FOUNDRY_BASE_URL','ANTHROPIC_FOUNDRY_API_KEY','GROK_BASE_URL','OPENAI_API_BASE',
  'AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','AWS_PROFILE','AWS_DEFAULT_PROFILE',
  'GOOGLE_APPLICATION_CREDENTIALS','GOOGLE_CLOUD_PROJECT',
];
const env = { ...process.env }; for (const key of API_ENV_VARS) delete env[key];
function run(cli, args, timeout = 30_000) {
  const r = spawnSync(cli, args, { env, encoding:'utf8', timeout, stdio:['ignore','pipe','pipe'], windowsHide:true });
  const stdout = String(r.stdout || '').trim(); const stderr = String(r.stderr || '').trim();
  const output = `${stdout}\n${stderr}`.trim();
  if (r.error || r.status !== 0) return { ok:false, output, stdout, stderr, status:r.status ?? null, signal:r.signal ?? null, error:r.error?.code || null };
  return { ok:true, output, stdout, stderr, status:r.status, signal:r.signal ?? null };
}
function parseClaudeAuth(row) { try { const p=JSON.parse(row.output); return p.loggedIn===true && p.authMethod==='claude.ai' && p.apiProvider==='firstParty' && typeof p.subscriptionType==='string' && p.subscriptionType.length>0; } catch { return false; } }
function parseCodexAuth(row) { return /^\s*logged\s+in\s+using\s+chatgpt\s*$/im.test(row.output) && !/api\s*key|not\s+logged\s+in|unauthori[sz]ed|expired|reauth/i.test(row.output); }
function grokReportedModel(output) { return output.match(/^\s*default\s+model:\s*([^\s]+)/im)?.[1] || output.match(/^\s*[*-]\s*([^\s]+)\s*\(default\)/im)?.[1] || null; }
function parseGrokAuth(row) { return /^\s*(?:you are )?logged\s+in\s+with\s+grok\.com[.!]?\s*$/im.test(row.output) && !/api\s*key|expired|reauth|unauthori[sz]ed/i.test(row.output) && Boolean(grokReportedModel(row.output)); }
function authSummary(provider,row,valid) {
  let tier = provider === 'openai' ? (/chatgpt/i.test(row.output) ? 'ChatGPT subscription (tier not exposed by CLI)' : null) : null;
  if (provider === 'anthropic') { try { tier = JSON.parse(row.output).subscriptionType || null; } catch { tier = null; } }
  let reportedModel = null;
  if (provider === 'xai') { reportedModel = grokReportedModel(row.output); tier = /grok\.com/i.test(row.output) ? 'xAI subscription (available models listed by CLI)' : null; }
  return { cli:TOP[provider].cli, model:provider==='xai' && reportedModel ? reportedModel : TOP[provider].model, preferredModel:TOP[provider].model, reportedModel, ok:row.ok&&valid, tier, authMode:provider==='anthropic'?'claude.ai OAuth':provider==='openai'?'ChatGPT OAuth':'grok.com OAuth', status:row.status, failure:row.ok&&valid?null:(row.error||(row.output?'authentication or subscription validation failed':'empty CLI response')) };
}
function containsExactMarker(value, marker) {
  if (typeof value === 'string') return value.trim() === marker;
  if (Array.isArray(value)) return value.some((item) => containsExactMarker(item, marker));
  if (value && typeof value === 'object') return Object.values(value).some((item) => containsExactMarker(item, marker));
  return false;
}
function hasUnsafeProbeShape(value, expectedModel) {
  if (Array.isArray(value)) return value.some((item) => hasUnsafeProbeShape(item, expectedModel));
  if (!value || typeof value !== 'object') return false;
  if (value.type === 'error' || value.is_error === true || value.role === 'user') return true;
  if (Object.keys(value).some((key) => /(?:^|[_-])(access[_-]?token|auth[_-]?token|api[_-]?key|secret|authorization|bearer)(?:$|[_-])/i.test(key))) return true;
  return Object.values(value).some((item) => hasUnsafeProbeShape(item, expectedModel));
}
function hasConflictingModel(value, expectedModel) {
  if (!expectedModel) return false;
  const values = [];
  const collect = (item) => {
    if (Array.isArray(item)) return item.forEach(collect);
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      if (/model/i.test(key) && typeof child === 'string') values.push(child);
      collect(child);
    }
  };
  collect(value);
  return values.length > 0 && !values.some((item) => item.includes(expectedModel));
}
function responseHasExactMarker(output, marker, expectedModel) {
  const parsed = [];
  for (const candidate of [output, ...output.split(/\n+/).filter(Boolean)]) {
    try { parsed.push(JSON.parse(candidate)); } catch { /* plain-text fallback below */ }
  }
  const marked = parsed.filter((value) => containsExactMarker(value, marker));
  if (marked.some((value) => hasUnsafeProbeShape(value, expectedModel) || hasConflictingModel(value, expectedModel))) return false;
  return marked.length > 0 || output.split(/\r?\n/).some((line) => line.trim() === marker);
}
function safeProbe(provider,row,model) { const expected=TOP[provider].marker; const valid=row.ok&&responseHasExactMarker(row.stdout || '', expected, model); return { cli:TOP[provider].cli, model, ok:valid, marker:expected, responseMatched:valid, status:row.status, failure:valid?null:(row.error||(row.output?'model response did not contain the exact marker or had an unsafe response shape':'empty CLI response')) }; }
const rawAuth={ anthropic:run('claude',['auth','status','--json']), openai:run('codex',['login','status']), xai:run('grok',['models']) };
const auth={ anthropic:authSummary('anthropic',rawAuth.anthropic,parseClaudeAuth(rawAuth.anthropic)), openai:authSummary('openai',rawAuth.openai,parseCodexAuth(rawAuth.openai)), xai:authSummary('xai',rawAuth.xai,parseGrokAuth(rawAuth.xai)) };
const triReady = auth.anthropic.ok && auth.openai.ok && auth.xai.ok;
const available = Object.keys(TOP).filter((key) => auth[key].ok);
const dualReady = available.length >= 2;
const mode = requestedMode === 'tri' ? (triReady ? 'tri' : 'degraded') : requestedMode === 'dual' ? (dualReady ? 'dual' : 'degraded') : triReady ? 'tri' : dualReady ? 'dual' : 'degraded';
const selected = mode === 'tri' ? ['anthropic','openai','xai'] : mode === 'dual' ? available.slice(0, 2) : [];
const models=Object.fromEntries(Object.entries(TOP).map(([key,v])=>[key,{cli:v.cli,model:key==='xai' ? (auth.xai.reportedModel || v.model) : v.model,preferredModel:v.model}]));
const result={ apiKeyEnvironmentUnset:API_ENV_VARS.every((key)=>!(key in env)), requestedMode, mode, selectedProviders:selected, models, auth, unavailable:Object.keys(TOP).filter((key)=>!auth[key].ok) };
if (process.argv.includes('--probe') && selected.length) {
  const raw={};
  if (selected.includes('anthropic')) raw.anthropic=run('claude',['-p','--output-format','json','--no-session-persistence','--permission-mode','plan','--model',TOP.anthropic.model,`Return exactly ${TOP.anthropic.marker}.`],120000);
  if (selected.includes('openai')) raw.openai=run('codex',['exec','--ephemeral','--sandbox','read-only','--color','never','--json','-m',TOP.openai.model,`Return exactly ${TOP.openai.marker}.`],120000);
  if (selected.includes('xai')) raw.xai=run('grok',['--model',models.xai.model,'--single',`Return exactly ${TOP.xai.marker}.`,'--output-format','json','--permission-mode','plan','--no-subagents'],120000);
  const probes={};
  for (const key of selected) {
    const preferred = models[key].model; let probe = safeProbe(key, raw[key], preferred);
    const entitlementFailure = !probe.ok && /model|entitl|unavailable|not found|access|permission/i.test(`${raw[key].stdout}\n${raw[key].stderr}`);
    if (!probe.ok && entitlementFailure) {
      const fallbackArgs = key === 'anthropic' ? ['-p','--output-format','json','--no-session-persistence','--permission-mode','plan',`Return exactly ${TOP[key].marker}.`] : key === 'openai' ? ['exec','--ephemeral','--sandbox','read-only','--color','never','--json',`Return exactly ${TOP[key].marker}.`] : ['--single',`Return exactly ${TOP[key].marker}.`,'--output-format','json','--permission-mode','plan','--no-subagents'];
      const fallback = run(TOP[key].cli, fallbackArgs, 120000); probe = safeProbe(key, fallback, null); if (probe.ok) { probe.model='provider-default'; result.models[key].model='provider-default'; }
    }
    probes[key]=probe;
  }
  result.probes=probes;
} else if (process.argv.includes('--probe')) result.probes={ skipped:true, reason:'no supported mode met authentication prerequisites; no allowance was consumed' };
const probesPassed=!result.probes||(result.probes.skipped!==true&&selected.every((key)=>result.probes[key]?.ok));
result.ok=result.apiKeyEnvironmentUnset&&mode!=='degraded'&&probesPassed;
result.billingPath = result.ok ? 'native provider subscription/OAuth CLI path; API-key variables unset; provider-internal billing ledger is not observable by this verifier' : 'not verified';
process.stdout.write(`${JSON.stringify(result,null,2)}\n`); process.exitCode=result.ok?0:1;
