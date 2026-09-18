/**
 * scripts/oracle/producer-hosts.mjs — the two subscription-billed HOSTS the Step 14 oracle producer
 * drives, and the ROLE ADAPTERS that let either host generate while the other judges.
 *
 * WHY ROLES ARE NOW SWAPPABLE (2026-09-14). The Fable weekly quota is exhausted, and a plain `claude -p`
 * generation pass is the expensive direction. An Astra-only Dual deliberation (verifier
 * ACCEPT_WITH_CORRECTIONS) approved PATH B — `codex` (gpt-6-astra) GENERATES and `claude` JUDGES —
 * because ADR-086's C3 definition requires source-grounded generation plus INDEPENDENT validation, not
 * Claude as the generator specifically. The same Dual rejected same-vendor production (both roles on
 * one host) for acceptance, so hostAdapters() refuses it unless a caller explicitly opts in for a
 * diagnostic run. The spike's measured quality does not transfer to B; B must qualify on its own pilot.
 *
 * Fence (owner mandate): children get scripts/subscription-hosts.mjs#subscriptionOnlyEnv, which strips
 * every API_BILLING_ENV name. `--bare` is never used — its help text makes auth "strictly
 * ANTHROPIC_API_KEY", the opposite of the fence. Claude context is minimised with --system-prompt,
 * --tools "", --strict-mcp-config, --disable-slash-commands and --setting-sources "" instead: measured
 * 2026-09-14, a one-word `claude -p` loaded 303,673 cache-creation tokens without those flags and 2,334
 * with them.
 */
import { spawnNativeHost } from '../native-host-process.mjs';

// Pinned on 2026-09-13 against the native hosts (same ids scripts/dual-host-deliberation.mjs pins).
export const PRODUCER_MODELS = Object.freeze({ claude: 'claude-fable-5-1', codex: 'gpt-6-astra' });
export const PRODUCER_HOSTS = Object.freeze(['claude', 'codex']);
export const DEFAULT_ROLES = Object.freeze({ generator: 'claude', judge: 'codex' });
export const CLAUDE_TIMEOUT_MS = 900_000;
export const CODEX_TIMEOUT_MS = 600_000;

const labelItem = {
  type: 'object', additionalProperties: false,
  properties: {
    unitId: { type: 'string' }, direct: { type: 'string' }, paraphrase: { type: 'string' }, span: { type: 'string' },
    spanStartLine: { type: 'integer' }, spanEndLine: { type: 'integer' }, skip: { type: 'boolean' }, reason: { type: 'string' },
  },
  required: ['unitId', 'direct', 'paraphrase', 'span', 'spanStartLine', 'spanEndLine', 'skip', 'reason'],
};
export const LABEL_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, properties: { labels: { type: 'array', items: labelItem } }, required: ['labels'],
});
export const VERDICT_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { id: { type: 'string' }, answers: { type: 'string', enum: ['yes', 'no'] }, reason: { type: 'string' } },
        required: ['id', 'answers', 'reason'],
      },
    },
  },
  required: ['verdicts'],
});

export const CLAUDE_SYSTEM_PROMPT = 'You write retrieval-benchmark labels for source text. You see only the units in the message, '
  + 'you have no tools, and you must not use anything outside them. Return only the structured output.';
export const JUDGE_SYSTEM_PROMPT = 'You are an independent verifier of retrieval-benchmark labels. You see only the items in the '
  + 'message, you have no tools, and you use no outside knowledge. Return only the structured output.';

/** The GENERATION prompt. Host-neutral: the exact same text goes to whichever host generates. */
export function claudePrompt(batch) {
  const head = [
    'Write labels for each UNIT below. Return exactly one object per unit, in order:',
    '- unitId: copy exactly.',
    '- direct: one specific question (8-30 words) answerable ONLY from this unit\'s text. Do not reuse more than 4 consecutive words of the answer text inside the question.',
    '- paraphrase: reword the direct question so it keeps the same meaning and the same answer but uses different words and a different sentence structure.',
    '- span: the EXACT contiguous substring of the unit text that answers the question. Copy it character-for-character: same spelling, casing, punctuation, whitespace and line breaks. 1-4 sentences of prose or 1-12 lines of code. Never the heading line alone; never the whole unit.',
    '- spanStartLine, spanEndLine: 1-based line numbers of that span INSIDE the unit text (line 1 is the first line after the ===UNIT marker).',
    '- skip: true only if the unit has no askable factual content; then set direct/paraphrase/span to "" and the line numbers to 0 and explain in reason. Otherwise reason is "".',
    'Do not invent facts. The text between ===UNIT and ===END is verbatim source.',
    '',
  ];
  const body = batch.map(({ unit, text, truncated }) => [
    `===UNIT unitId=${unit.unitId} path=${unit.path} kind=${unit.kind} lines=${text.split('\n').length}${truncated ? ' truncated=true' : ''}`,
    text,
    '===END',
  ].join('\n'));
  return head.concat(body).join('\n');
}
export const generatorPrompt = claudePrompt;

/**
 * The JUDGE prompt. Host-neutral. SUPPORT items carry {id, question, span}; EQUIVALENCE items carry
 * {id, questionA, questionB} and ask whether the paraphrase preserves the direct question's meaning —
 * the pair-equivalence judgment Dual required, because "support for two questions does not establish
 * that they mean the same thing". The judge never sees the unit, its path or its repository.
 */
export function codexPrompt(items) {
  const support = items.filter((item) => typeof item.span === 'string');
  const equivalence = items.filter((item) => typeof item.questionA === 'string');
  const head = [
    'You are an independent verifier. For each item you receive a QUESTION and a SPAN of text.',
    'Decide whether the SPAN ALONE contains information sufficient to answer the QUESTION correctly and specifically.',
    'Use no outside knowledge. Do not read files or run commands. Return one verdict per item with the same id.',
    '',
  ];
  const body = support.map(({ id, question, span }) => `--- id=${id}\nQUESTION: ${question}\nSPAN:\n${span}\n`);
  const lines = head.concat(body);
  if (equivalence.length) {
    lines.push(
      'EQUIVALENCE ITEMS: each gives QUESTION A and QUESTION B. Answer "yes" only if they ask for the same information and would have exactly the same correct answer; "no" if the meaning, scope or expected answer differs.',
      '',
      ...equivalence.map(({ id, questionA, questionB }) => `--- id=${id}\nQUESTION A: ${questionA}\nQUESTION B: ${questionB}\n`),
    );
  }
  return lines.join('\n');
}
export const judgePrompt = codexPrompt;

export function claudeArgs({ model = PRODUCER_MODELS.claude, effort = 'medium', schema = LABEL_SCHEMA, systemPrompt = CLAUDE_SYSTEM_PROMPT } = {}) {
  return [
    '-p', '--output-format', 'json', '--model', model, '--effort', effort, '--tools', '', '--no-session-persistence',
    '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '',
    '--system-prompt', systemPrompt, '--json-schema', JSON.stringify(schema),
  ];
}

export function codexArgs({ model = PRODUCER_MODELS.codex, effort = 'medium', schemaFile } = {}) {
  return [
    'exec', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check', '--color', 'never', '--json',
    '-m', model, '-c', `model_reasoning_effort="${effort}"`, '--output-schema', schemaFile,
  ];
}

function claudeStructured(stdout, key) {
  let envelope;
  try { envelope = JSON.parse(stdout); } catch { return { error: 'claude stdout is not a JSON envelope' }; }
  if (envelope.is_error) return { error: `claude reported is_error (${envelope.subtype})`, envelope };
  let structured = envelope.structured_output;
  if (structured === undefined && typeof envelope.result === 'string') {
    try { structured = JSON.parse(envelope.result); } catch { return { error: 'claude result is not JSON', envelope }; }
  }
  if (!structured || !Array.isArray(structured[key])) return { error: `claude output lacks ${key}[]`, envelope };
  return { structured, envelope };
}

export function parseClaudeEnvelope(stdout) { return claudeStructured(stdout, 'labels'); }
export function parseClaudeVerdicts(stdout) { return claudeStructured(stdout, 'verdicts'); }

/** Codex emits JSONL; hooks on this machine inject unrelated agent_messages first, so only the LAST one counts. */
function codexStructured(stdout, key) {
  const messages = [];
  const errors = [];
  for (const line of String(stdout).split('\n')) {
    let value;
    try { value = JSON.parse(line); } catch { continue; }
    if (value.type !== 'item.completed') continue;
    if (value.item?.type === 'agent_message') messages.push(value.item.text);
    if (value.item?.type === 'error') errors.push(value.item.message);
  }
  const last = messages.at(-1);
  if (last === undefined) return { error: 'codex emitted no agent_message', errors };
  try {
    const structured = JSON.parse(last);
    if (!Array.isArray(structured[key])) return { error: `codex output lacks ${key}[]`, errors };
    return { structured, errors };
  } catch {
    return { error: 'codex final message is not JSON', errors };
  }
}

export function parseCodexJsonl(stdout) { return codexStructured(stdout, 'verdicts'); }
export function parseCodexLabels(stdout) { return codexStructured(stdout, 'labels'); }

/**
 * A host refusing for capacity is an ordinary outcome, not a crash. The Step 14 spike's own session was
 * killed by a usage limit mid-run. On refusal the producer SUSPENDS — no further calls to any host —
 * and every remaining unit is recorded as unproduced, so the denominator never silently shrinks.
 */
export function isQuotaRefusal(text) {
  return /usage limit|rate[ -]?limit|quota|capacity|too many requests|\b429\b|limit reached|try again later/i.test(String(text || ''));
}

/**
 * Resolve {generator, judge} into concrete invocations. `schemaFiles` are paths the caller has already
 * written (codex takes an --output-schema FILE; claude takes the schema inline).
 */
export function hostAdapters({
  roles = DEFAULT_ROLES, models = PRODUCER_MODELS, effort = 'medium', schemaFiles, workDir, codexCwd,
  allowSameVendor = false,
} = {}) {
  const { generator, judge } = roles;
  if (!PRODUCER_HOSTS.includes(generator) || !PRODUCER_HOSTS.includes(judge)) {
    throw new Error(`unknown producer role host (generator=${generator}, judge=${judge})`);
  }
  if (generator === judge && !allowSameVendor) {
    throw new Error(`generator and judge are both ${generator}: same-vendor production is not independent validation and cannot qualify labels for C3`);
  }
  const make = (host, stage) => {
    const isGen = stage === 'generator';
    if (host === 'claude') {
      return {
        host, stage, binary: 'claude', model: models.claude, cwd: workDir, timeoutMs: CLAUDE_TIMEOUT_MS,
        args: claudeArgs({
          model: models.claude, effort,
          schema: isGen ? LABEL_SCHEMA : VERDICT_SCHEMA,
          systemPrompt: isGen ? CLAUDE_SYSTEM_PROMPT : JUDGE_SYSTEM_PROMPT,
        }),
        prompt: isGen ? generatorPrompt : judgePrompt,
        parse: isGen ? parseClaudeEnvelope : parseClaudeVerdicts,
      };
    }
    return {
      host, stage, binary: 'codex', model: models.codex, cwd: codexCwd, timeoutMs: CODEX_TIMEOUT_MS,
      args: codexArgs({ model: models.codex, effort, schemaFile: isGen ? schemaFiles.labels : schemaFiles.verdicts }),
      prompt: isGen ? generatorPrompt : judgePrompt,
      parse: isGen ? parseCodexLabels : parseCodexJsonl,
    };
  };
  return { generator: make(generator, 'generator'), judge: make(judge, 'judge') };
}

export function spawnHost(binary, args, { cwd, env, timeoutMs }, input) {
  return spawnNativeHost(binary, args, { cwd, env, timeout: timeoutMs, stdio: ['pipe','pipe','pipe'] }, input);
}
