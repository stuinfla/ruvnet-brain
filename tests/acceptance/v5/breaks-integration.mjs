// The breaks of the integration owner's own fixes (docs/INTEGRATION-NOTES.md): the builder's F03, F15
// and F18 and the contract's F24. Each removes one protection and names the failure its test must show.
const p = (file, find, replace) => ({ file, find, replace });
const B = 'packages/builder/';

export function addIntegrationBreaks(BREAKS) {
  Object.assign(BREAKS, {
    // F03: the todo test is real now; it gets its own break (the port's wave4-04 break, same patch)
    'wp5-split-secret-after-split': { test: 'wp5-split-secret', what: 'history items are screened per piece after the split', patches: [p(`${B}extract.mjs`, 'cfg: s.history, screen, hostile });', 'cfg: s.history, hostile });')], expect: /lines of the private key are in the history rows/ },
    // F15: every repository in the pack has a probe
    'integ-builder-no-probe-check': { test: 'integ-builder', what: 'a repository without a probe is accepted', patches: [p(`${B}build.mjs`, '    if (bare.length) throw new Error(', '    if (false) throw new Error(')], expect: /a pack with no probe for echo-kit must be refused/ },
    // F18: plain metadata, no control characters in file names, whole-input hostile screen
    'integ-builder-meta': { test: 'integ-builder', what: 'repository and commit values are not checked', patches: [p(`${B}discover.mjs`, "  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(meta.repo)) throw", '  if (false) throw'), p(`${B}discover.mjs`, '  if (!/^(sha256:)?[0-9a-f]{7,64}$/.test(meta.commit)) throw', '  if (false) throw')], expect: /holds a line break must be refused/ },
    'integ-builder-name': { test: 'integ-builder', what: 'a file name with a control character is read', patches: [p(`${B}discover.mjs`, '      if (/[\\u0000-\\u001f\\u007f]/.test(ent.name)) {', '      if (false) {')], expect: /no stored path holds a line break/ },
    'integ-builder-history-whole': { test: 'integ-builder', what: 'history items are screened for hostile text per piece only', patches: [p(`${B}history.mjs`, '    const flag = hostile(`${title}\\n${b.text}`);', '    const flag = null;')], expect: /every piece holding part of the phrase is flagged/ },
    'integ-builder-doc-whole': { test: 'integ-builder', what: 'documents are screened for hostile text per chunk only', patches: [p(`${B}extract.mjs`, ' ?? spans.find((x) => x.from <= c.end && x.to >= c.start)?.rule ?? null;', ';')], expect: /both pieces are flagged/ },
    // F24: the key id a signature names is the trusted key's
    'integ-contract-keyid': { test: 'integ-contract', what: 'the signature\'s key id is not compared', patches: [p('packages/contract/signature.mjs', '    if (signature.keyId !== keyId(publicKeyPem)) return false;\n', '')], expect: /a release with a foreign key id must not install/ },
  });
}
