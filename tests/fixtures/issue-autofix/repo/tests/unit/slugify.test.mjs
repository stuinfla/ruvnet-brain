import { expect, it } from 'vitest';
import { slugify } from '../../scripts/slugify.mjs';

it('joins words with a dash', () => {
  expect(slugify('Hello World')).toBe('hello-world');
});
