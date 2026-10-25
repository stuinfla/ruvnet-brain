import { expect, it } from 'vitest';
import { cmpVersion, needsPublishTimes, normalizeNpmDistTags, selectTag, wantedTag } from '../../plugin/scripts/developer-update-policy.mjs';

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
it('the alpha channel skips a pre-release published BEFORE latest (an abandoned line), and takes a newer one', () => {
  // Measured 2026-10-23: agentic-flow alpha = 3.0.0-alpha.2 (2026-03-25) vs latest = 2.1.4 (2026-10-09).
  const tags = { latest: '2.1.4', alpha: '3.0.0-alpha.2' };
  const published = [{ '2.1.4': '2026-10-09T12:53:40Z', '3.0.0-alpha.2': '2026-03-25T22:09:45Z' }]; // npm 12 shape
  expect(selectTag('agentic-flow', '2.1.4', tags, 'alpha', { published })).toMatchObject({ tag: 'latest', version: '2.1.4', upgrade: false });
  expect(selectTag('ruflo', '3.61.1', { latest: '3.61.1', alpha: '3.62.0-alpha.1' }, 'alpha',
    { published: { '3.61.1': '2026-10-24T00:00:00Z', '3.62.0-alpha.1': '2026-10-24T05:00:00Z' } })).toMatchObject({ tag: 'alpha', upgrade: true });
  // A caller that did not ask for times keeps version ordering, exactly as before.
  expect(selectTag('agentic-flow', '2.1.4', tags, 'alpha').tag).toBe('alpha');
  // Times REQUIRED but the lookup failed or came back unreadable/incomplete: never install the pre-release blind.
  for (const failed of [{}, [{}, {}], 'garbage', { '3.0.0-alpha.2': '2026-03-25T22:09:45Z' }]) {
    expect(selectTag('agentic-flow', '2.1.4', tags, 'alpha', { published: failed })).toMatchObject({ tag: 'latest', upgrade: false });
  }
  // One tag-choice function for the updater and the notice, Kit's `next` included.
  expect(wantedTag('@pacphi/agentic-kit', 'latest')).toBe('next');
  expect(wantedTag('agentic-flow', 'alpha')).toBe('alpha');
  expect(wantedTag('unrelated-cli', 'alpha')).toBe('latest');
  expect(selectTag('@pacphi/agentic-kit', '4.0.0-alpha.61', { latest: '3.9.0', next: '4.0.0-alpha.62' }, 'latest',
    { published: { '3.9.0': '2026-10-20T00:00:00Z', '4.0.0-alpha.62': '2026-09-01T00:00:00Z' } }).tag).toBe('latest');
  expect(needsPublishTimes(tags, 'alpha')).toBe(true);
  expect(needsPublishTimes({ latest: '1.0.0', alpha: '1.0.0' }, 'alpha')).toBe(false);
  expect(needsPublishTimes(tags, 'latest')).toBe(false);
});
