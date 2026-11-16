// @vitest-environment happy-dom
/**
 * 結果パネルの画像プレビューが作る Blob URL の後始末 (#729)。
 *
 * 旧実装は `<img onload="URL.revokeObjectURL(this.src)">` を innerHTML に埋め込んでいた。inline の
 * イベントハンドラの中では `URL` が `document.URL` (文字列) に解決されるので、実ブラウザでは読み込みの
 * たびに TypeError になり、URL は解放されなかった。解放は DOM のリスナーから、作った URL を直接参照して行う。
 *
 * 読み込みの完了は happy-dom では起きないので、`load` / `error` は手で dispatch する。
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ResultPanel } from '../ResultPanel.js';
import { mountVerifyIndexHtml } from './verifyDom.js';

let panel: ResultPanel;
let created: string[];
let revoke: MockInstance<typeof URL.revokeObjectURL>;

beforeEach(() => {
  mountVerifyIndexHtml();
  panel = new ResultPanel();
  created = [];
  let seq = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    const url = `blob:test/${++seq}`;
    created.push(url);
    return url;
  });
  revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function png(): Blob {
  return new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
}

function previewImage(): HTMLImageElement {
  const img = document.querySelector<HTMLImageElement>('#plaintext-code img.image-preview');
  if (!img) throw new Error('image preview is not rendered');
  return img;
}

function revokedUrls(): string[] {
  return revoke.mock.calls.map(([url]) => url);
}

describe('ResultPanel.renderImage (#729)', () => {
  it('shows the created blob URL without revoking it before the image has loaded', () => {
    panel.renderImage({ filename: 'picture.png', imageBlob: png() });

    expect(previewImage().getAttribute('src')).toBe(created[0]);
    expect(revoke).not.toHaveBeenCalled();
  });

  it('revokes the created URL once when the image finishes loading', () => {
    panel.renderImage({ filename: 'picture.png', imageBlob: png() });

    previewImage().dispatchEvent(new Event('load'));

    expect(revokedUrls()).toEqual([created[0]]);
  });

  it('revokes the created URL once when the image fails to load', () => {
    panel.renderImage({ filename: 'picture.png', imageBlob: png() });

    previewImage().dispatchEvent(new Event('error'));

    expect(revokedUrls()).toEqual([created[0]]);
  });

  it('revokes a not-yet-loaded URL when another image replaces the preview', () => {
    panel.renderImage({ filename: 'a.png', imageBlob: png() });
    const first = previewImage();

    panel.renderImage({ filename: 'b.png', imageBlob: png() });

    expect(revokedUrls()).toEqual([created[0]]);
    expect(previewImage()).not.toBe(first);
    expect(previewImage().getAttribute('src')).toBe(created[1]);
  });

  it('revokes a not-yet-loaded URL when a plaintext file replaces the preview', () => {
    panel.renderImage({ filename: 'a.png', imageBlob: png() });

    panel.renderPlaintext({ filename: 'main.c', content: 'int x;', language: 'c' });

    expect(revokedUrls()).toEqual([created[0]]);
  });

  it('revokes each URL at most once across load, error and replacing the preview', () => {
    panel.renderImage({ filename: 'a.png', imageBlob: png() });
    const first = previewImage();
    first.dispatchEvent(new Event('load'));
    first.dispatchEvent(new Event('error'));
    first.dispatchEvent(new Event('load'));

    panel.renderImage({ filename: 'b.png', imageBlob: png() });
    panel.renderPlaintext({ filename: 'main.c', content: 'int x;', language: 'c' });
    first.dispatchEvent(new Event('load'));

    expect(revokedUrls()).toEqual([created[0], created[1]]);
  });

  it('renders the preview without inline event handler attributes', () => {
    panel.renderImage({ filename: '" onerror="alert(1).png', imageBlob: png() });

    const img = previewImage();
    const handlers = img.getAttributeNames().filter((name) => name.startsWith('on'));
    expect(handlers).toEqual([]);
    expect(img.alt).toBe('" onerror="alert(1).png');
  });
});
