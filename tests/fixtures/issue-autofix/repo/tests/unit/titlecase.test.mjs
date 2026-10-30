import { expect, it } from 'vitest';
import { titleCase } from '../../scripts/titlecase.mjs';

it('capitalises each word', () => {
  expect(titleCase('hello world')).toBe('Hello World');
});
