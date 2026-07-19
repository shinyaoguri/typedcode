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
   * IndexedDB 同期と PoSW キューの掃けを待つ。リロード前に呼ぶことで、未 flush の
   * イベントが取り残されてチェーンが途切れるのを防ぐ (打鍵直後の即リロード対策)。
   * timeout は workers: 2 の並列実行で PoSW Worker が CPU を分け合う分の余裕を含む
   * (同期は expect のポーリングで完了し次第すぐ抜けるので、健全時のコストは増えない)。
   */
  async waitForSynced(): Promise<void> {
    await expect(this.page.locator('#sync-status-item')).toHaveClass(/synced/, { timeout: 90_000 });
    // event-count が 2 回連続で同じ = PoSW キューが掃けてチェーン確定。
    let prev = -1;
    for (let i = 0; i < 30; i++) {
      const c = await this.eventCount();
      if (c === prev) return;
      prev = c;
      await this.page.waitForTimeout(300);
    }
  }

  /**
   * ページをリロードして前回セッションを復元する。リロード時は通常 sessionStorage 経由で
   * 自動復元されるが、復元モーダル (#session-recovery-overlay) が出た場合は「再開する」を押す。
   * リロード前に同期完了を待ち、未 flush イベントの取り残しを防ぐ。
   */
  async reloadAndResume(): Promise<void> {
    await this.waitForSynced();
    await this.page.reload();
    const resume = this.page.locator('#session-resume-btn');
    try {
      await resume.waitFor({ state: 'visible', timeout: 5_000 });
      await resume.click();
    } catch {
      /* 自動復元 (モーダル無し) */
    }
    await this.page.locator('.monaco-editor .view-lines').first().waitFor({ state: 'visible' });
    await expect.poll(() => this.eventCount(), { timeout: 30_000 }).toBeGreaterThan(0);
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
    return text.replace(/[\u00a0\u200b]/g, ' ');
  }

  /** OS 依存のコピペ修飾キー (mac=Meta, それ以外=Control)。 */
  private get modifier(): 'Meta' | 'Control' {
    return process.platform === 'darwin' ? 'Meta' : 'Control';
  }

  /**
   * 外部由来テキストをクリップボードに置き、エディタに実ペースト (Cmd/Ctrl+V) する。
   * Monaco/InputDetector は DOM の paste イベントで検出するので insertFromPaste として記録される。
   */
  async pasteExternalText(text: string): Promise<void> {
    await this.page.evaluate((t) => navigator.clipboard.writeText(t), text);
    await this.focusEditor();
    await this.page.keyboard.press(`${this.modifier}+V`);
  }

  /** 全選択 → コピー → 末尾へ移動 → ペースト (内部ペースト = insertFromInternalPaste 経路)。 */
  async selectAllCopyPaste(): Promise<void> {
    await this.focusEditor();
    await this.page.keyboard.press(`${this.modifier}+A`);
    await this.page.keyboard.press(`${this.modifier}+C`);
    await this.page.keyboard.press(`${this.modifier}+ArrowDown`);
    await this.page.keyboard.press('End');
    await this.page.keyboard.press('Enter');
    await this.page.keyboard.press(`${this.modifier}+V`);
  }

  /**
   * 合成キーストローク (ADR-0018) を注入する。`page.evaluate` で `dispatchEvent` する
   * KeyboardEvent は `isTrusted=false` になるので、KeystrokeTracker が `data.isTrusted=false`
   * を載せて記録する。実際の文字入力は起きない (合成イベントは値を変えない)。
   */
  async injectSyntheticKeystroke(key: string): Promise<void> {
    await this.focusEditor();
    await this.page.evaluate((k) => {
      const target = document.querySelector('.monaco-editor textarea') ?? document.activeElement ?? document.body;
      for (const type of ['keydown', 'keyup'] as const) {
        target.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true }));
      }
    }, key);
  }

  /**
   * タブ切替によるフォーカス喪失→復帰を再現する。headless では別タブを前面化しても
   * window blur が発火しないため、ブラウザがタブ切替時に出すのと同じ `blur`/`focus`
   * イベントを window に発火させて VisibilityTracker の記録経路を検証する。
   */
  async simulateFocusLossAndReturn(): Promise<void> {
    await this.page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await this.page.waitForTimeout(200);
    await this.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await this.page.waitForTimeout(200);
  }

  /**
   * casual の「画面共有を有効にする」バナーを押して画面共有を開始する。
   * fake-media フラグ (playwright.config) により getDisplayMedia は monitor の
   * fake ストリームを返すので、ピッカー無しで本物のキャプチャ経路が回る。
   */
  async enableScreenShare(): Promise<void> {
    const btn = this.page.locator('#screen-share-opt-out-banner .banner-btn');
    await btn.waitFor({ state: 'visible', timeout: 10_000 });
    await btn.click();
  }

  /**
   * Copilot/Cursor や snippet 展開のように「1 つの編集でコード全体を一気に投入する」挙動を
   * 再現する。dev 限定テストフック (__tcTestInsertBlock) 経由で Monaco の executeEdits を
   * 1 回だけ適用するので、複数行が単一の contentChange (insertParagraph) として記録される。
   * 通常のキー入力では Monaco が 1 文字ずつに分解してしまい再現できない。
   */
  async injectCodeBlock(code: string): Promise<void> {
    await this.focusEditor();
    await this.page.evaluate((text) => {
      const fn = (window as unknown as { __tcTestInsertBlock?: (t: string) => void }).__tcTestInsertBlock;
      if (!fn) throw new Error('__tcTestInsertBlock not available (dev hook missing)');
      fn(text);
    }, code);
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

/** ZIP 内の全エントリ名一覧 (screenshots/ の有無確認などに使う)。 */
export async function listZipEntries(zipPath: string): Promise<string[]> {
  const buf = await readFileBuffer(zipPath);
  const zip = await JSZip.loadAsync(buf);
  return Object.keys(zip.files);
}

/**
 * ZIP から最初の proof.json を取り出し、`mutate` で書き換えた JSON を一時ファイルに
 * 書き出してパスを返す。改ざん検出 (負のオラクル) シナリオ用。`mutate` を省くと
 * 無改ざんの proof.json をそのまま書き出す (positive control 用)。
 */
export async function extractProofJson(
  zipPath: string,
  mutate?: (proof: Record<string, unknown>) => void
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

/** proof イベント 1 件 (ホワイトボックス assert 用の緩い型)。 */
export interface ProofEvent {
  type: string;
  inputType?: string | null;
  data?: unknown;
  [k: string]: unknown;
}

/** ZIP 内の最初の proof.json 全体を読み出す (rootAnchored / sessionStartToken 等のトップレベル assert 用)。 */
export async function readProofJson(zipPath: string): Promise<Record<string, unknown>> {
  const buf = await readFileBuffer(zipPath);
  const zip = await JSZip.loadAsync(buf);
  const entryName = Object.keys(zip.files).find((n) => n.endsWith('_proof.json'));
  if (!entryName) throw new Error(`no *_proof.json in ${zipPath}`);
  return JSON.parse(await zip.files[entryName]!.async('string')) as Record<string, unknown>;
}

/** ZIP 内の最初の proof.json から events 配列を読み出す (イベント種別/isTrusted の検証用)。 */
export async function readProofEvents(zipPath: string): Promise<ProofEvent[]> {
  const buf = await readFileBuffer(zipPath);
  const zip = await JSZip.loadAsync(buf);
  const entryName = Object.keys(zip.files).find((n) => n.endsWith('_proof.json'));
  if (!entryName) throw new Error(`no *_proof.json in ${zipPath}`);
  const proof = JSON.parse(await zip.files[entryName]!.async('string')) as {
    proof?: { events?: ProofEvent[] };
  };
  return proof.proof?.events ?? [];
}

async function readFileBuffer(path: string): Promise<Buffer> {
  const { readFile } = await import('node:fs/promises');
  return readFile(path);
}
