import { mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import type { Download, Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * 実物の TypedCode エディタを Playwright から駆動するページオブジェクト。
 * セレクタは安定した既存 DOM id (#download-menu-btn 等) を使う。
 */
export class EditorApp {
  constructor(public readonly page: Page) {}

  /**
   * クリーンな casual セッションで開く。`?reset` は全モードの localStorage /
   * sessionStorage / IndexedDB を消すので、前回セッション復元モーダルを確実に回避し
   * 各テストを独立させる (main.ts の `?reset` ハンドラ)。
   */
  async openCasualFresh(): Promise<void> {
    await this.page.goto('/casual?reset');
    await this.waitReady();
  }

  /** エディタとイベント記録 (#0 humanAttestation) が立ち上がるまで待つ。 */
  async waitReady(): Promise<void> {
    await this.page.locator('.monaco-editor .view-lines').first().waitFor({ state: 'visible' });
    // #0 humanAttestation が記録されると event-count が 1 以上になる。
    await expect.poll(() => this.eventCount(), { timeout: 30_000 }).toBeGreaterThan(0);
  }

  /** 記録済みイベント総数 (UI 表示)。 */
  async eventCount(): Promise<number> {
    const txt = (await this.page.locator('#event-count').textContent()) ?? '0';
    return Number.parseInt(txt.replace(/[^0-9]/g, ''), 10) || 0;
  }

  /** アクティブな Monaco エディタにフォーカスする。 */
  async focusEditor(): Promise<void> {
    await this.page.locator('.monaco-editor .view-lines').first().click();
  }

  /**
   * エディタに実キーストロークで入力する。Playwright の keyboard は CDP 経由で
   * isTrusted=true の本物のイベントを発火するので、信頼打鍵として記録される。
   */
  async typeCode(text: string): Promise<void> {
    await this.focusEditor();
    await this.page.keyboard.type(text, { delay: 12 });
  }

  /**
   * 表示中エディタのソーステキスト (DOM の `.view-lines` から取得)。
   * monaco は ES モジュールで window に露出しないので DOM 経由で読む。
   */
  async editorValue(): Promise<string> {
    const text = await this.page.locator('.monaco-editor .view-lines').first().innerText();
    // Monaco は空白を non-breaking space でレンダリングするので通常スペースに正規化する。
    return text.replace(/[\u00a0\u200b]/g, " ");
  }

  /** 新規タブを追加する。 */
  async addTab(): Promise<void> {
    const before = await this.page.locator('#editor-tabs .editor-tab, #editor-tabs [role="tab"]').count();
    await this.page.locator('#add-tab-btn').click();
    await expect
      .poll(() => this.page.locator('#editor-tabs .editor-tab, #editor-tabs [role="tab"]').count())
      .toBeGreaterThan(before);
  }

  /**
   * エクスポートをトリガしてダウンロード ZIP を一時ファイルに保存し、そのパスを返す。
   * casual の pre-export Turnstile はテストキーで自動 pass する。
   */
  private async exportAndSave(itemId: '#export-current-tab-btn' | '#export-zip-btn'): Promise<string> {
    await this.page.locator('#download-menu-btn').click();
    const downloadPromise = this.page.waitForEvent('download', { timeout: 90_000 });
    await this.page.locator(itemId).click();
    // casual/class/assignment は提出前セルフレビュー (ADR-0022) が割り込むので続行する。
    // exam には無いので未出現でも握り潰す。
    await this.proceedSelfReviewIfPresent();
    const download: Download = await downloadPromise;
    const dir = mkdtempSync(join(tmpdir(), 'tc-e2e-dl-'));
    const dest = join(dir, download.suggestedFilename());
    await download.saveAs(dest);
    return dest;
  }

  /** セルフレビューダイアログが出ていれば「続行」する (出ていなければ何もしない)。 */
  private async proceedSelfReviewIfPresent(): Promise<void> {
    const proceed = this.page.locator('.self-review-btn-proceed');
    try {
      await proceed.waitFor({ state: 'visible', timeout: 15_000 });
      await proceed.click();
    } catch {
      /* セルフレビュー無しのモード、または既に閉じている */
    }
  }

  /** 現在のタブだけをエクスポート (`<name>_TC<ts>.zip`)。保存パスを返す。 */
  exportCurrentTab(): Promise<string> {
    return this.exportAndSave('#export-current-tab-btn');
  }

  /** 全タブをエクスポート (`ALL_TC<ts>.zip`)。保存パスを返す。 */
  exportAllTabs(): Promise<string> {
    return this.exportAndSave('#export-zip-btn');
  }
}

/** ZIP 内の `*_proof.json` エントリ名一覧。 */
export async function listProofEntries(zipPath: string): Promise<string[]> {
  const buf = await readFileBuffer(zipPath);
  const zip = await JSZip.loadAsync(buf);
  return Object.keys(zip.files).filter((n) => n.endsWith('_proof.json'));
}

/**
 * ZIP から最初の proof.json を取り出し、`mutate` で書き換えた JSON を一時ファイルに
 * 書き出してパスを返す。改ざん検出 (負のオラクル) シナリオ用。`mutate` を省くと
 * 無改ざんの proof.json をそのまま書き出す (positive control 用)。
 */
export async function extractProofJson(
  zipPath: string,
  mutate?: (proof: Record<string, unknown>) => void,
): Promise<string> {
  const buf = await readFileBuffer(zipPath);
  const zip = await JSZip.loadAsync(buf);
  const entryName = Object.keys(zip.files).find((n) => n.endsWith('_proof.json'));
  if (!entryName) throw new Error(`no *_proof.json in ${zipPath}`);
  const raw = await zip.files[entryName]!.async('string');
  const proof = JSON.parse(raw) as Record<string, unknown>;
  if (mutate) mutate(proof);
  const dir = mkdtempSync(join(tmpdir(), 'tc-e2e-proof-'));
  const dest = join(dir, mutate ? 'tampered_proof.json' : 'clean_proof.json');
  await writeFile(dest, JSON.stringify(proof));
  return dest;
}

async function readFileBuffer(path: string): Promise<Buffer> {
  const { readFile } = await import('node:fs/promises');
  return readFile(path);
}
