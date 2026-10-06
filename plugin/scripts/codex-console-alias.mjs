import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const ALIAS_MARKER = '<!-- managed-by: ruvnet-brain; short-console-alias-v1 -->';
export const ALIAS_NOTICE = 'RuvNet Brain is loaded. Configure it with $rvbc.';
const aliasPath = (home) => path.join(home, '.agents', 'skills', 'rvbc', 'SKILL.md');
const aliasBody = `---\nname: rvbc\ndescription: Open the RuvNet Brain configuration console when the user invokes $rvbc or says Configure RuvNet Brain.\n---\n\n${ALIAS_MARKER}\nOpen the installed RuvNet Brain Console. Resolve \`\${RUVNET_BRAIN_KB:-$HOME/.cache/ruvnet-brain/kb}/.console-runtime/scripts/onboarding-console.mjs\`; do not guess a developer checkout. Run \`node <resolved-script> --serve --open\` in the background. Preserve the user's configuration. Report startup failures honestly. Verify the rendered console and client accessibility before claiming it opened or presenting its URL.\n`;

export function ownedCodexConsoleAlias(home = os.homedir()) {
  try {
    const file = aliasPath(home);
    if (fs.lstatSync(path.dirname(file)).isSymbolicLink() || !fs.lstatSync(file).isFile()
      || fs.lstatSync(file).isSymbolicLink()) return false;
    const text = fs.readFileSync(file, 'utf8');
    return text.includes(ALIAS_MARKER) && /^name: rvbc$/m.test(text);
  } catch { return false; }
}

export function installCodexConsoleAlias({ home = os.homedir(), codexHome = path.join(home, '.codex'), enabled = true } = {}) {
  if (!enabled) return { action: 'disabled' };
  const file = aliasPath(home);
  try {
    const config = fs.existsSync(path.join(codexHome, 'config.toml')) ? fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8') : '';
    for (const section of config.split(/(?=^\[)/m)) {
      if (!/^\[\[skills\.config\]\]/.test(section) || !/^\s*enabled\s*=\s*false\s*(?:#.*)?$/m.test(section)) continue;
      const disabled = section.match(/^\s*path\s*=\s*(['"])(.*?)\1\s*(?:#.*)?$/m)?.[2];
      if (disabled && [file, path.dirname(file)].includes(path.resolve(disabled))) return { action: 'disabled' };
    }
    if (fs.existsSync(path.dirname(file)) && !ownedCodexConsoleAlias(home)) return { action: 'user-owned' };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (existing === aliasBody) return { action: 'unchanged', path: file };
    fs.writeFileSync(file, aliasBody);
    return { action: existing === null ? 'installed' : 'updated', path: file };
  } catch (error) { return { action: 'unavailable', reason: error.message }; }
}

// Fresh native metadata only: no inference or plugin mutation requested.
export function probeCodexConsoleAlias({ home = os.homedir(), codexHome = path.join(home, '.codex'),
  cwd = process.cwd(), binary = 'codex', timeoutMs = 150, spawnChild = spawn } = {}) {
  if (!ownedCodexConsoleAlias(home)) return Promise.resolve(false);
  return new Promise((resolve) => {
    let child; let timer; let buffer = ''; let settled = false;
    const finish = (ready) => { if (settled) return; settled = true; clearTimeout(timer); try { child?.kill(); } catch {} resolve(ready); };
    try { child = spawnChild(binary, ['app-server'], { cwd, env: { ...process.env, HOME: home, CODEX_HOME: codexHome }, stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { finish(false); return; }
    timer = setTimeout(() => finish(false), timeoutMs);
    child.on('error', () => finish(false)); child.on('exit', () => finish(false));
    child.stdin.on('error', () => finish(false));
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      if (buffer.length > 8 * 1024 * 1024) { finish(false); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        let message; try { message = JSON.parse(buffer.slice(0, newline)); } catch {}
        buffer = buffer.slice(newline + 1);
        if (message?.id === 1 && !message.error) {
          child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
          child.stdin.write(`${JSON.stringify({ id: 2, method: 'skills/list', params: { cwds: [cwd], forceReload: true } })}\n`);
        } else if (message?.id === 2) {
          const groups = message.result?.data;
          const ready = !message.error && Array.isArray(groups) && groups.length === 1 && groups[0].cwd === cwd
            && Array.isArray(groups[0].skills) && !(groups[0].errors?.length)
            && groups[0].skills.some((row) => row.name === 'rvbc' && row.path === aliasPath(home) && row.enabled === true);
          finish(Boolean(ready && ownedCodexConsoleAlias(home)));
        }
      }
    });
    child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'rnb_short_console_alias', version: '1' } } })}\n`);
  });
}

export function readSessionSource(input = process.stdin) {
  if (input.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    let raw = ''; let settled = false;
    const finish = () => {
      if (settled) return; settled = true; clearTimeout(timer); input.pause();
      input.removeListener('data', onData); input.removeListener('end', finish); input.removeListener('error', finish);
      try { resolve(JSON.parse(raw).source ?? null); } catch { resolve(null); }
    };
    const onData = (chunk) => { raw += String(chunk); if (raw.length > 32768) { raw = ''; finish(); } };
    const timer = setTimeout(finish, 100);
    input.on('data', onData); input.once('end', finish); input.once('error', finish); input.resume();
  });
}
