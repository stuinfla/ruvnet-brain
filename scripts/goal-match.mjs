// Compatibility export for repository tools. The executable implementation belongs inside the
// self-contained plugin payload so Stable Spine and Codex-only installs never depend on a separate
// Claude marketplace checkout.
export * from '../plugin/scripts/goal-match.mjs';
