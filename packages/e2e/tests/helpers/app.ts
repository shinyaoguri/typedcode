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
    await this.openModeFresh('casual');
  }

  /**
   * 任意のモードをクリーンなセッションで開く (モード共通の入口)。
   *
   * - `/<mode>?reset` で全モードの保存データを消してから起動する (`openCasualFresh` と同じ)
   * - 利用規約モーダル (class / assignment / exam で未同意なら出る。casual は出さない = ADR-0015) は
   *   `acceptTerms` で同意済みにして飛ばす。既定は casual 以外で true (casual の既存 spec の
   *   記録内容を変えないため、casual では何も足さない)
   * - 起動時の画面共有の選択ダイアログ (class と exam で出る) は `screenShare` で選ぶ。省略時は触らない
   * - class / exam 固有の操作 (問題の読み込み・試験ゲート) はここに入れない。エディタが
   *   その手前で止まるモードでは `waitReady: false` にして、呼び出し側で続きを駆動する
   */
  async openModeFresh(mode: EditorMode, opts: OpenModeOptions = {}): Promise<void> {
    const { acceptTerms = mode !== 'casual', screenShare, waitReady = true } = opts;
    if (acceptTerms) await installTermsAccepted(this.page);
    await this.page.goto(`/${mode}?reset`);
    if (screenShare) {
      const choice = this.page.locator(`.screen-share-choice-dialog [data-choice="${screenShare}"]`);
      await choice.waitFor({ state: 'visible', timeout: 30_000 });
      await choice.click();
    }
    if (waitReady) await this.waitReady();
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
    // 上限までに安定しなければ throw する (#229)。以前は黙って return していたため、
    // チェーンが確定していないまま reload / export へ進み、原因の離れた所で落ちていた。
    const deadline = Date.now() + SYNC_STABLE_TIMEOUT_MS;
    const seen: number[] = [];
    let prev = -1;
    while (Date.now() < deadline) {
      const c = await this.eventCount();
      if (c === prev) return;
      seen.push(c);
      prev = c;
      await this.page.waitForTimeout(300);
    }
    throw new Error(
      `event-count did not settle within ${SYNC_STABLE_TIMEOUT_MS}ms (PoSW queue still draining?). ` +
        `observed: ${seen.slice(-10).join(' → ')}`
    );
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
   *
   * 導線は 2 つある: 左のダウンロードメニュー (`#download-menu-btn` → 項目) と、問題パネルの
   * 「ログをダウンロード」(`#download-log-btn`。全タブ ZIP。exam はこちらに一本化される)。
   */
  private async exportAndSave(route: ExportRoute): Promise<string> {
    const downloadPromise = this.page.waitForEvent('download', { timeout: 90_000 });
    if (route === 'logButton') {
      await this.page.locator('#download-log-btn').click();
    } else {
      await this.page.locator('#download-menu-btn').click();
      await this.page.locator(route === 'currentTab' ? '#export-current-tab-btn' : '#export-zip-btn').click();
    }
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
    return this.exportAndSave('currentTab');
  }

  /** 全タブをエクスポート (`ALL_TC<ts>.zip`)。保存パスを返す。 */
  exportAllTabs(): Promise<string> {
    return this.exportAndSave('allTabs');
  }

  /**
   * 問題パネルの「ログをダウンロード」(`#download-log-btn`) で全タブ ZIP を出す。保存パスを返す。
   * class / assignment / exam の提出導線 (exam は左のメニューが隠れてこちらだけになる)。
   */
  exportViaLogButton(): Promise<string> {
    return this.exportAndSave('logButton');
  }
}

/** エディタのモード (URL の 1 段目)。 */
export type EditorMode = 'casual' | 'class' | 'assignment' | 'exam';

/** export の導線。`currentTab` / `allTabs` はダウンロードメニュー、`logButton` は問題パネルのボタン。 */
export type ExportRoute = 'currentTab' | 'allTabs' | 'logButton';

export interface OpenModeOptions {
  /** 利用規約を同意済みにしてモーダルを飛ばす。既定: casual 以外で true。 */
  acceptTerms?: boolean;
  /** 起動時の画面共有の選択ダイアログ (class / exam) で選ぶ側。省略時はダイアログに触らない。 */
  screenShare?: 'share' | 'optOut';
  /** エディタと #0 の記録まで待つ。既定 true (問題読込・試験ゲートの手前で止まるモードは false)。 */
  waitReady?: boolean;
}

/** `waitForSynced` が event-count の安定を待つ上限。 */
const SYNC_STABLE_TIMEOUT_MS = 30_000;

/**
 * 利用規約の同意フラグを、ページのスクリプトより先に localStorage へ入れる。
 * 形式は editor の `TermsHandler.markTermsAccepted` と同じ (`version` が一致しないと未同意扱い)。
 *
 * `?reset` は main.ts の先頭で `localStorage.clear()` するので、init script で入れただけでは
 * 規約チェック (起動フローの後段) の前に消える。`Storage.prototype.clear` を包み、localStorage が
 * 消されたら同意フラグだけ戻す (それ以外の消去はそのまま効く)。
 */
async function installTermsAccepted(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const KEY = 'typedcode-terms-accepted';
    const now = Date.now();
    const value = JSON.stringify({ version: '1.0', timestamp: now, agreedAt: new Date(now).toISOString() });
    const put = () => {
      try {
        window.localStorage.setItem(KEY, value);
      } catch {
        /* 保存不可環境では諦める (モーダルが出るので呼び出し側の待ちで気付ける) */
      }
    };
    const originalClear = Storage.prototype.clear;
    Storage.prototype.clear = function clear(this: Storage) {
      originalClear.call(this);
      if (this === window.localStorage) put();
    };
    put();
  });
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

/** ZIP 内の指定エントリをテキストとして読む (tab-switches.json など)。無ければ throw。 */
export async function readZipEntryText(zipPath: string, entryName: string): Promise<string> {
  const buf = await readFileBuffer(zipPath);
  const zip = await JSZip.loadAsync(buf);
  const entry = zip.files[entryName];
  if (!entry) throw new Error(`no ${entryName} in ${zipPath} (entries: ${Object.keys(zip.files).join(', ')})`);
  return entry.async('string');
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

/**
 * export ZIP を読み、書き換えた ZIP を一時ファイルに書き出してパスを返す (verify Web に ZIP の
 * まま渡す改ざん / 破損シナリオ用。`extractProofJson` の ZIP 版)。
 *
 * - `mutateProof`: ZIP 内の全 `*_proof.json` を JSON として書き換える (hash は再計算しない)
 * - `renameProof`: proof のエントリ名のベースを置き換える (`<base>_proof.json`)。同じ export から
 *   作った ZIP を 2 つ同時に verify Web へ入れると、表示名 (`data-filename`) が同じになって
 *   どちらの行か区別できないため
 * - `extraEntries`: 追加するエントリ (名前 → 中身の文字列。壊れた proof の注入など)
 */
export async function writeZipVariant(
  zipPath: string,
  opts: {
    mutateProof?: (proof: Record<string, unknown>) => void;
    renameProof?: string;
    extraEntries?: Record<string, string>;
    /** 出力ファイル名 (拡張子込み)。既定は `variant.zip`。verify Web のフォルダ名になる。 */
    outName?: string;
  }
): Promise<string> {
  const src = await JSZip.loadAsync(await readFileBuffer(zipPath));
  const out = new JSZip();
  for (const [name, entry] of Object.entries(src.files)) {
    if (entry.dir) continue;
    if (name.endsWith('_proof.json')) {
      let raw = await entry.async('string');
      if (opts.mutateProof) {
        const proof = JSON.parse(raw) as Record<string, unknown>;
        opts.mutateProof(proof);
        raw = JSON.stringify(proof);
      }
      const dest = opts.renameProof ? name.replace(/[^/]*_proof\.json$/, `${opts.renameProof}_proof.json`) : name;
      out.file(dest, raw);
    } else {
      out.file(name, await entry.async('uint8array'));
    }
  }
  for (const [name, content] of Object.entries(opts.extraEntries ?? {})) out.file(name, content);
  const dir = mkdtempSync(join(tmpdir(), 'tc-e2e-zip-'));
  const dest = join(dir, opts.outName ?? 'variant.zip');
  await writeFile(dest, await out.generateAsync({ type: 'nodebuffer' }));
  return dest;
}

/**
 * proof を改ざんする (tamper-detection.spec と同じ手口): 中ほどの content-change イベントの
 * data にゼロ幅文字を足す。hash を再計算しないのでハッシュチェーンが切れ、検証は失敗するべき。
 */
export function tamperFirstContentChange(proof: Record<string, unknown>): void {
  const tp = (proof.proof ?? proof) as { events?: Array<Record<string, unknown>> };
  const target = (tp.events ?? []).find(
    (e) => e.type === 'contentChange' && typeof e.data === 'string' && (e.data as string).length > 0
  );
  if (!target) throw new Error('no content-change event with data to tamper');
  target.data = `\u200b${target.data as string}`;
}

/** proof イベント 1 件 (ホワイトボックス assert 用の緩い型)。 */
export interface ProofEvent {
  type: string;
  inputType?: string | null;
  data?: unknown;
  [k: string]: unknown;
}

/**
 * 署名済み checkpoint envelope (`/api/checkpoint/sign` の戻り) の緩い型。
 * 全フィールドを optional にしてあるのは、E2E が assert したいのが「envelope が実在して
 * 中身が空でない」ことだけだから (payload の厳密な検証は verify-cli と shared が担う)。
 */
export interface ProofSignedCheckpoint {
  payload?: { serverTimestamp?: string; [k: string]: unknown };
  signature?: string;
  keyId?: string;
  [k: string]: unknown;
}

/** proof の checkpoint 1 件 (署名 envelope の有無を見るための緩い型)。 */
export interface ProofCheckpoint {
  eventIndex?: number;
  signature?: ProofSignedCheckpoint;
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
