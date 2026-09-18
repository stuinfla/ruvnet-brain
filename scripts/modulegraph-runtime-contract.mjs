// Reviewed runtime-loading contract for the bundle module graph.
// The hashes bind these exceptions to the canonical source bytes; a same-basename
// replacement or an edited installed copy is therefore rejected before scanning.
export const REQUIRED_RUNTIME_FILES = Object.freeze([
  Object.freeze({
    source: 'plugin/scripts/coverage-integrity.mjs',
    destination: 'coverage-integrity.mjs',
    sha256: '776c35d29337acfb4fde4a7d2b0be1e7e4e3b920ec0f1789b2385f3708dfda63',
  }),
]);

export const RUNTIME_LOADING_CONTRACT = Object.freeze({
  'resolve-deps.mjs': Object.freeze({
    sha256: 'ccb5cd04015b2ba9ef20c07e79a7ca35145b33c1821a4693832ece050ca3ba70',
    sites: Object.freeze([
      Object.freeze({ shape: 'pathToFileURL(identifier).href', identifier: 'resolved', boundary: 'external-package' }),
      Object.freeze({ shape: 'identifier', identifier: 'url', boundary: 'external-package' }),
      Object.freeze({ shape: 'require-alias', identifier: 'base', boundary: 'external-package' }),
    ]),
  }),
  'forge-update.mjs': Object.freeze({
    sha256: '4920fbdbf010011832823ecabad99784f5003f4139e2e5bdc319eb24b397923c',
    requiredFiles: REQUIRED_RUNTIME_FILES,
    sites: Object.freeze([
      Object.freeze({ shape: 'pathToFileURL(identifier).href', identifier: 'policyPath', boundary: 'trusted-validator' }),
      Object.freeze({ shape: 'pathToFileURL(identifier).href', identifier: 'validatorPath', boundary: 'trusted-validator' }),
    ]),
  }),
  'forge-guard-injection.mjs': Object.freeze({
    sha256: '08629d95b739d2935f214c4361c267c84b11df3db0f543ec2c2e3fb64490dd81',
    sites: Object.freeze([
      Object.freeze({ shape: 'identifier', identifier: 'name', boundary: 'external-package' }),
    ]),
  }),
  'fork-source.mjs': Object.freeze({
    sha256: '16e8672564a9cde59b81a963930cf994efee3fc6430a25dc4750c7914b736f94',
    requiredFiles: REQUIRED_RUNTIME_FILES,
    sites: Object.freeze([
      Object.freeze({ shape: 'pathToFileURL(conditional).href', boundary: 'trusted-validator' }),
    ]),
  }),
});
