import { qualificationPlan } from '../../scripts/release-qualification.mjs';

// Recognize only literal producer commands in YAML run steps. This is a bounded
// declaration adapter, not a shell interpreter or evidence that a run passed.
export function qualificationInvocationFiles(jobBody) {
  const lines = String(jobBody).split('\n');
  const commands = [];
  let inSteps = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^ {4}steps:\s*$/.test(lines[i])) { inSteps = true; continue; }
    if (lines[i].trim() && lines[i].match(/^\s*/)[0].length <= 4) inSteps = false;
    if (!inSteps) continue;
    // Repository steps use six spaces plus '- ', or an eight-space property.
    // Skip other scalar bodies, which may contain fixtures resembling run keys.
    const run = lines[i].match(/^ {6}(?:- |  )run:\s*(.*)$/);
    const scalar = lines[i].match(/^(\s*)(?:- )?\S[^\r\n]*:\s*[|>](?:[1-9][-+]?|[-+][1-9]?)?\s*(?:#.*)?$/);
    if (!run) {
      if (scalar) while (i + 1 < lines.length && (!lines[i + 1].trim()
        || lines[i + 1].match(/^\s*/)[0].length > scalar[1].length)) i++;
      continue;
    }
    let command = run[1];
    if (/^[|>][-+]?\s*$/.test(command)) {
      const folded = command.startsWith('>');
      const body = [];
      while (i + 1 < lines.length && (!lines[i + 1].trim()
        || lines[i + 1].match(/^\s*/)[0].length > 8)) body.push(lines[++i]);
      if (folded) continue;
      command = body.join('\n');
    }
    // Heredocs and multiline shell strings can contain source/fixture text that
    // looks executable. Only unquoted literal run steps are supported here.
    if (command.includes('<<') || /['"`]/.test(command)) continue;
    command = command.replace(/\\\r?\n\s*/g, ' ').trim();
    // A preceding exit, shell condition, function, or another command can make
    // a later producer unreachable. Support exactly one logical command.
    if (/[\r\n]/.test(command)) continue;
    commands.push(command);
  }
  const files = new Set();
  for (const command of commands) {
    const match = command.trim().match(/^node\s+(?:\.\/)?scripts\/release-qualification\.mjs\s+([A-Za-z0-9_./:\s-]+)$/);
    if (!match) continue;
    const args = match[1].trim().split(/\s+/);
    const options = new Map();
    let valid = args.length % 2 === 0;
    for (let i = 0; i < args.length; i += 2) {
      if (!['--suite', '--platform', '--report'].includes(args[i]) || options.has(args[i])
        || !args[i + 1] || args[i + 1].startsWith('--')) valid = false;
      options.set(args[i], args[i + 1]);
    }
    if (!valid || !options.has('--suite') || !options.has('--report')
      || (options.has('--platform') && !['linux', 'macos', 'windows'].includes(options.get('--platform')))) continue;
    try {
      for (const file of qualificationPlan(options.get('--suite')).files) files.add(file);
    } catch { /* Unknown suites and invalid inventories provide no invocation evidence. */ }
  }
  return files;
}
