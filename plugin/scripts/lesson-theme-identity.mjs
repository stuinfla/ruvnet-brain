// The existing promotion miner matcher, shared by ordinary lesson producers.
export const THEMES = [
  { key: 'release-discipline', label: 'Versioning and release discipline',
    match: /version|semver|bump|release|ship|deploy|publish|rollback/i },
  { key: 'proof-before-done', label: 'Prove it works before calling it done',
    match: /test|verify|prove|validat|\bqa\b|gate|green|passes/i },
  { key: 'honesty', label: 'Never fabricate, never assume, never inflate',
    match: /honest|lie|fabricat|assum|guess|placeholder|inflat|real data|made up/i },
  { key: 'docs-upkeep', label: 'Keep docs and README current with the code',
    match: /readme|document|changelog|\bdocs?\b|narrative/i },
  { key: 'people', label: 'How to communicate with people',
    match: /thank|contributor|personal|tone|nudge|deferential|communicat/i },
  { key: 'tooling-discipline', label: 'Use the real tool; never hand-roll a substitute',
    match: /hand-roll|impersonat|substitut|reinvent|use the tool|existing tool|ruvnet wins/i },
  { key: 'cost-routing', label: 'Route work to the cheapest capable model',
    match: /cheap|cost|route|routing|model selection|budget|spend/i },
];

export function lessonThemeKeys(text) {
  return typeof text === 'string' ? THEMES.filter(t => t.match.test(text)).map(t => t.key) : [];
}
