#!/usr/bin/env node
// Compatibility launcher for repository commands and tests. The executable implementation belongs
// inside the self-contained plugin payload used by Stable Spine and every supported host.
await import('../plugin/scripts/lesson-gate.mjs');
