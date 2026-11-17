// The screen (architecture 2.4 step 4), patterns from the recipe:
// - secrets are replaced in the text before anything else sees it (labels, index, probes), keeping
//   every line break so cited line numbers stay true; the manifest records rule and line, never the value;
// - hostile text (known prompt-injection forms) is flagged per unit; the unit is stored and searchable
//   with flag = 'hostile', and the engine decides how to label or quote it when serving.

/** Returns { text, hits: [{ line, rule }] } with every secret match replaced. */
export function redactSecrets(text, rules, redaction) {
  const hits = [];
  let out = text;
  for (const { rule, re } of rules) {
    re.lastIndex = 0;
    out = out.replace(re, (match, ...rest) => {
      const offset = rest.find((x) => typeof x === 'number');
      hits.push({ line: out.slice(0, offset).split('\n').length, rule });
      return redaction + '\n'.repeat(match.split('\n').length - 1);
    });
  }
  hits.sort((a, b) => a.line - b.line || (a.rule < b.rule ? -1 : 1));
  return { text: out, hits };
}

/** The first hostile rule a text matches, or null. */
export function hostileRule(text, rules) {
  for (const { rule, re } of rules) if (re.test(text)) return rule;
  return null;
}
