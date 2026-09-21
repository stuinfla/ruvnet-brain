// Only broad discovery requests may use the reviewed-source lead before primary retrieval.
// Capability assertions, troubleshooting, instructions, and implementation questions stay on the
// ordinary retrieval/evidence path even when their vocabulary happens to match a reviewed family.
export function isSourceDiscoveryIntent(query) {
  const text = String(query || '').trim();
  if (!text) return false;
  const lower = text.toLowerCase();
  if (/\b(?:prevent|stop|avoid|block|disallow|disable|forbid|troubleshoot|diagnos(?:e|is|ing)|failure|broken)\b/i.test(text)) return false;
  if (/\b(?:implement(?:ed|ation|ing)?|built|shipped|deployed|automatic(?:ally)?|api|command|function|method|class|struct|symbol|version|installed|current|latest|available|supports?|provides?|exposes?)\b/i.test(text)) return false;
  if (/(?:transfer|share|carry|move|reuse|learning|patterns?).{0,100}\b(?:credentials?|configuration|network|internet|offline|automatic(?:ally)?)\b/i.test(lower)) return false;
  return /^(?:find|discover|identify|locate)\b/i.test(text)
    || /^what\s+(?:are\b|options?\b|tools?\b|approaches?\b)/i.test(text)
    || /^what\s+can\s+(?:i|we)\s+use\b/i.test(text)
    || /^what\s+should\s+(?:i|we)\s+use\b/i.test(text)
    || /^which\s+(?:tools?|options?|approaches?)\b/i.test(text)
    || /^how\s+should\s+(?:i|we)\s+(?:store|persist|save|keep|choose|select|find|use)\b/i.test(text)
    || /^how\s+can\s+(?:i|we)\s+(?:store|persist|save|keep|choose|select|find|use)\b/i.test(text)
    || /^how\s+can\s+(?:agents?|teams?|separate\s+projects?|different\s+repos?)\b[\s\S]{0,120}\b(?:carry|transfer|share|move|reuse)\b/i.test(text);
}
