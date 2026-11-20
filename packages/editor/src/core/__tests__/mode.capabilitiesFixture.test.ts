import { describe, expect, it } from 'vitest';
import { ALL_EDITOR_MODES, capabilitiesFor } from '../mode.js';
import { MODE_CAPABILITIES_FIXTURE } from './fixtures/modeCapabilities.js';

// #645: 方針 (policy) を足す前の入口ごとの能力を固定する。ここが赤くなったら、入口の能力が変わった
// (= 方針の無い旧 .tcclass の開き方と /author のプリセットの意味も変わった) ということ。
describe('mode capabilities fixture', () => {
  it.each(ALL_EDITOR_MODES)('keeps the %s entry capabilities equal to the pinned fixture', (mode) => {
    expect(capabilitiesFor(mode)).toEqual(MODE_CAPABILITIES_FIXTURE[mode]);
  });
});
