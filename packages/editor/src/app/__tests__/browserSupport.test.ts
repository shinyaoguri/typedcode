/**
 * 未対応ブラウザの判定 (#596)。editor は E2E で確かめている Chromium 系だけで記録させ、
 * Safari (WebKit) と Firefox (Gecko) は起動の Phase 0.5 で止める。判定は UA 文字列だけを見る
 * (偽装への耐性ではなく、利用者を対象ブラウザへ案内するための判定)。
 */

import { describe, expect, it } from 'vitest';
import { detectUnsupportedBrowser } from '../browserSupport.js';

const UA = {
  chromeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  headlessChrome:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  opera:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 OPR/116.0.0.0',
  // Brave は Chrome と同じ UA を名乗る
  brave:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  vivaldi:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Vivaldi/7.0.3495.18',
  samsungInternet:
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  safariIPhone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  // iOS の Chrome / Edge / Firefox は WebKit で動く (Chrome/ や Firefox/ を名乗らない)
  chromeIOS:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1',
  edgeIOS:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/131.0.2903.68 Mobile/15E148 Safari/605.1.15',
  firefoxIOS:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/133.0 Mobile/15E148 Safari/605.1.15',
  firefoxWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  firefoxMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
  firefoxAndroid: 'Mozilla/5.0 (Android 14; Mobile; rv:133.0) Gecko/133.0 Firefox/133.0',
} as const;

describe('detectUnsupportedBrowser', () => {
  it.each([
    ['Chrome (Windows)', UA.chromeWindows],
    ['Chrome (macOS)', UA.chromeMac],
    ['Chrome (Android)', UA.chromeAndroid],
    ['Headless Chrome', UA.headlessChrome],
    ['Edge', UA.edge],
    ['Opera', UA.opera],
    ['Brave', UA.brave],
    ['Vivaldi', UA.vivaldi],
    ['Samsung Internet', UA.samsungInternet],
  ])('lets a Chromium-based browser (%s) start recording', (_name, ua) => {
    expect(detectUnsupportedBrowser(ua)).toBeNull();
  });

  it.each([
    ['Safari (macOS)', UA.safariMac],
    ['Safari (iPhone)', UA.safariIPhone],
    ['Chrome on iOS', UA.chromeIOS],
    ['Edge on iOS', UA.edgeIOS],
    ['Firefox on iOS', UA.firefoxIOS],
  ])('blocks a WebKit browser (%s) as webkit', (_name, ua) => {
    expect(detectUnsupportedBrowser(ua)).toBe('webkit');
  });

  it.each([
    ['Firefox (Windows)', UA.firefoxWindows],
    ['Firefox (macOS)', UA.firefoxMac],
    ['Firefox (Linux)', UA.firefoxLinux],
    ['Firefox (Android)', UA.firefoxAndroid],
  ])('blocks a Gecko browser (%s) as firefox', (_name, ua) => {
    expect(detectUnsupportedBrowser(ua)).toBe('firefox');
  });

  it('blocks a user agent that names no Chromium engine, since recording has not been tested there', () => {
    expect(detectUnsupportedBrowser('')).toBe('other');
    expect(detectUnsupportedBrowser('curl/8.7.1')).toBe('other');
  });
});
