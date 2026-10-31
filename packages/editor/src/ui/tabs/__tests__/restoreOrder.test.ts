import { describe, expect, it } from 'vitest';
import { resolveRestoreOrder } from '../restoreOrder.js';

describe('resolveRestoreOrder', () => {
  it('falls back to the stored order when tabOrder is an empty array', () => {
    expect(resolveRestoreOrder([], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('falls back to the stored order when tabOrder is undefined', () => {
    expect(resolveRestoreOrder(undefined, ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('keeps the saved order when every stored tab is listed', () => {
    expect(resolveRestoreOrder(['c', 'a', 'b'], ['a', 'b', 'c'])).toEqual(['c', 'a', 'b']);
  });

  it('appends stored tabs missing from tabOrder at the end in stored order', () => {
    expect(resolveRestoreOrder(['c'], ['a', 'b', 'c', 'd'])).toEqual(['c', 'a', 'b', 'd']);
  });

  it('drops tabOrder ids that have no stored tab', () => {
    expect(resolveRestoreOrder(['ghost', 'b', 'a'], ['a', 'b'])).toEqual(['b', 'a']);
  });

  it('removes duplicates keeping the first occurrence', () => {
    expect(resolveRestoreOrder(['b', 'a', 'b'], ['a', 'b', 'a'])).toEqual(['b', 'a']);
  });

  it('returns an empty list when nothing is stored', () => {
    expect(resolveRestoreOrder(['a'], [])).toEqual([]);
  });
});
