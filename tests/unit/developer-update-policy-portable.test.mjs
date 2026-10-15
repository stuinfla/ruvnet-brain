import { expect, it } from 'vitest';
import { cmpVersion, normalizeNpmDistTags, selectTag } from '../../plugin/scripts/developer-update-policy.mjs';

it('uses the selected published channel without downgrading an installed release', () => {
  expect(selectTag('ruflo', '2.0.0', { latest: '1.9.0', alpha: '2.1.0-alpha.1' })).toMatchObject({ tag: 'latest', upgrade: false, ahead: true });
  expect(selectTag('ruflo', '2.0.0', { latest: '1.9.0', alpha: '2.1.0-alpha.1' }, 'alpha')).toMatchObject({ tag: 'alpha', upgrade: true });
  expect(selectTag('ruflo', '2.0.0', { latest: '2.0.1', alpha: '1.9.0' }, 'alpha').tag).toBe('latest');
});
it('does not expand alpha policy to unrelated packages and retains Kit next ordering', () => {
  expect(selectTag('unrelated-cli', '1.0.0', { latest: '1.1.0', alpha: '2.0.0' }, 'alpha').tag).toBe('latest');
  expect(selectTag('@pacphi/agentic-kit', '1.0.0', { latest: '1.1.0', next: '1.2.0-alpha.1', alpha: '9.0.0' }, 'alpha').tag).toBe('next');
});
it('accepts npm 11 and singleton npm 12 records but rejects ambiguous input', () => {
  const tags = { latest: '1.2.0' };
  expect(normalizeNpmDistTags(tags)).toEqual(tags);
  expect(normalizeNpmDistTags([tags])).toEqual(tags);
  for (const value of [[], [tags, tags], {}, null, { latest: 12 }]) expect(() => normalizeNpmDistTags(value)).toThrow();
});
it('refuses unsupported channels and unorderable installed or target identities', () => {
  expect(() => selectTag('ruflo', '1.0.0', { latest: '2.0.0' }, 'beta')).toThrow();
  expect(() => selectTag('ruflo', 'opaque', { latest: '2.0.0' })).toThrow();
  expect(() => selectTag('ruflo', '1.0.0', { latest: 'opaque' })).toThrow();
});
it('orders numeric prerelease identifiers and stable releases semantically', () => {
  expect(cmpVersion('1.0.0-alpha.9', '1.0.0-alpha.10')).toBe(-1);
  expect(cmpVersion('1.0.0', '1.0.0-rc.1')).toBe(1);
  expect(cmpVersion('1.0.0+build.1', '1.0.0+build.2')).toBe(0);
});
