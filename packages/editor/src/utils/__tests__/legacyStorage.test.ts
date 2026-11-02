import { describe, it, expect, vi } from 'vitest';
import { removeLegacyDeviceId, LEGACY_DEVICE_ID_KEY } from '../legacyStorage.js';

describe('removeLegacyDeviceId', () => {
  it('removes the legacy device ID left on existing devices', () => {
    const store = new Map([
      [LEGACY_DEVICE_ID_KEY, 'old-id'],
      ['typedcode-theme', 'dark'],
    ]);
    removeLegacyDeviceId({ removeItem: (k) => void store.delete(k) });

    expect(store.has(LEGACY_DEVICE_ID_KEY)).toBe(false);
    expect(store.get('typedcode-theme')).toBe('dark');
  });

  it('removes only the legacy device ID key', () => {
    const removeItem = vi.fn();
    removeLegacyDeviceId({ removeItem });

    expect(removeItem).toHaveBeenCalledTimes(1);
    expect(removeItem).toHaveBeenCalledWith('typedcode-device-id');
  });

  it('does not throw when removeItem throws, so startup continues', () => {
    const storage = {
      removeItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    };

    expect(() => removeLegacyDeviceId(storage)).not.toThrow();
  });
});
