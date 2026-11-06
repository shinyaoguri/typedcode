/**
 * Python の実行のタイムアウトに使う、一時停止できる期限 (#649)。入力を待つ間は数えない。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PausableDeadline } from '../pausableDeadline.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PausableDeadline', () => {
  it('expires once the counted time reaches the limit', () => {
    const onExpire = vi.fn();
    const deadline = new PausableDeadline(1_000, onExpire);
    deadline.resume();
    vi.advanceTimersByTime(999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('does not count time while paused', () => {
    const onExpire = vi.fn();
    const deadline = new PausableDeadline(1_000, onExpire);
    deadline.resume();
    vi.advanceTimersByTime(400);
    deadline.pause();
    vi.advanceTimersByTime(60_000);
    expect(onExpire).not.toHaveBeenCalled();
    deadline.resume();
    vi.advanceTimersByTime(599);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('does not count before the first resume', () => {
    const onExpire = vi.fn();
    const deadline = new PausableDeadline(1_000, onExpire);
    vi.advanceTimersByTime(5_000);
    deadline.resume();
    vi.advanceTimersByTime(999);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('never expires after cancel', () => {
    const onExpire = vi.fn();
    const deadline = new PausableDeadline(1_000, onExpire);
    deadline.resume();
    deadline.cancel();
    deadline.resume();
    vi.advanceTimersByTime(10_000);
    expect(onExpire).not.toHaveBeenCalled();
  });
});
