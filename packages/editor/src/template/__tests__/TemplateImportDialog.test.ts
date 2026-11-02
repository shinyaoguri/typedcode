// @vitest-environment happy-dom
/**
 * テンプレート取込のダイアログの状態契約 (data-dialog) のテスト (#434)。
 * E2E はこの名前で確認ダイアログと進捗の開閉を読む (翻訳テキストや inline style に依存しない)。
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { ParsedTemplate } from '@typedcode/shared';
import { TemplateImportDialog } from '../TemplateImportDialog.js';

const template: ParsedTemplate = {
  version: '1.0',
  metadata: { name: 'sample' },
  files: [{ filename: 'main.c', language: 'c', content: 'int main(void) { return 0; }\n' }],
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('TemplateImportDialog state contract', () => {
  it('opens the confirmation as data-dialog="template-import" and removes it once confirmed', async () => {
    const result = new TemplateImportDialog().showConfirmation(template, true);
    expect(document.querySelectorAll('[data-dialog="template-import"]')).toHaveLength(1);
    document.querySelector<HTMLElement>('#template-confirm-btn')!.click();
    await expect(result).resolves.toBe(true);
    expect(document.querySelector('[data-dialog="template-import"]')).toBeNull();
  });

  it('opens the progress overlay as data-dialog="template-progress" and removes it on close', () => {
    const progress = new TemplateImportDialog().showProgress();
    expect(document.querySelectorAll('[data-dialog="template-progress"]')).toHaveLength(1);
    progress.close();
    expect(document.querySelector('[data-dialog="template-progress"]')).toBeNull();
  });
});
