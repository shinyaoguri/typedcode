/**
 * 救出ボタンの出力 (#544 / #300。ADR-0042)。
 *
 * メモリ上の最新のコードと記録を、証明ではない救出ファイル `RESCUE_TC<ts>.zip` として出す。
 * ZIP が作れなければ単一の JSON (`RESCUE_TC<ts>.json` = `{ manifest, files }`)、それも作れなければ
 * 読めたソースを 1 ファイルずつダウンロードする。
 *
 * **救出は何の成功も前提にしない**: Turnstile・PoSW の排出待ち (`waitForQueueDrain`)・IndexedDB への
 * 保存 (`flushToIndexedDB`)・署名・スクリーンショットを一切呼ばない。保存先や認証が壊れているときに
 * 押されるボタンなので、そのどれかを待てば救出もいっしょに止まる。
 */

import JSZip from 'jszip';
import type { TabManager, TabState } from '../ui/tabs/TabManager.js';
import { t } from '../i18n/index.js';
import {
  buildRescueBundle,
  type RescueBundle,
  type RescueTabSource,
  rescueBundleEntries,
  type RescueFile,
} from './rescueBundle.js';
import type { PersistOutcome } from '../ui/tabs/syncStatus.js';

/** どの形で出せたか */
export type RescueResult = 'zip' | 'json' | 'files' | 'failed';

export interface RescueExporterDeps {
  /** 救出するタブ (呼ぶたびに読み直す) */
  getSources: () => RescueTabSource[];
  /** 直近の保存の結果 */
  getLastSave: () => PersistOutcome | null;
  mode: string;
  now: () => Date;
  /** ファイル一覧から ZIP を作る */
  buildZip: (entries: RescueFile[]) => Promise<Blob>;
  /** Blob をファイルとして保存させる */
  download: (blob: Blob, filename: string) => void;
  notify: (message: string) => void;
}

/** `TC<ts>` の `<ts>` (通常の export と同じ `YYMMDDHHmm`) */
export function rescueTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(date.getFullYear()).slice(2)}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/** ライブのタブを救出の入力にする。読み出しは救出の時点で行い、保存・待機は一切しない */
export function liveTabRescueSources(
  tabManager: Pick<TabManager, 'getAllTabs' | 'getPersistenceReport'>
): RescueTabSource[] {
  let persisted: ReadonlyMap<string, number | null> = new Map();
  try {
    persisted = tabManager.getPersistenceReport().persistedEventCounts;
  } catch (e) {
    console.warn('[Rescue] Could not read the persistence report:', e);
  }
  return tabManager.getAllTabs().map((tab: TabState) => {
    let pendingEventCount: number | null = null;
    try {
      pendingEventCount = tab.typingProof.getPendingEvents().length;
    } catch (e) {
      console.warn(`[Rescue] Could not read pending events of tab ${tab.id}:`, e);
    }
    return {
      id: tab.id,
      filename: tab.filename,
      language: tab.language,
      readContent: () => tab.model.getValue(),
      readEvents: () => tab.typingProof.serializeState().events,
      persistedEventCount: persisted.get(tab.id) ?? null,
      pendingEventCount,
    };
  });
}

/** JSZip で ZIP を作る (救出の既定の `buildZip`) */
export async function buildRescueZip(entries: RescueFile[]): Promise<Blob> {
  const zip = new JSZip();
  for (const entry of entries) zip.file(entry.path, entry.content);
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

/** アンカーのクリックで Blob を保存させる (救出の既定の `download`) */
export function downloadBlobAsFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 100);
}

export class RescueExporter {
  private running = false;

  constructor(private readonly deps: RescueExporterDeps) {}

  /** 全タブを救出する。reject しない (結果は戻り値と通知で返す) */
  async rescueAll(): Promise<RescueResult> {
    if (this.running) return 'failed';
    this.running = true;
    try {
      return await this.rescue();
    } finally {
      this.running = false;
    }
  }

  private async rescue(): Promise<RescueResult> {
    const { deps } = this;
    const now = deps.now();
    const base = `RESCUE_TC${rescueTimestamp(now)}`;

    let bundle: RescueBundle;
    try {
      bundle = buildRescueBundle({
        sources: deps.getSources(),
        mode: deps.mode,
        createdAt: now,
        lastSave: deps.getLastSave(),
      });
    } catch (e) {
      console.error('[Rescue] Could not read the tabs:', e);
      deps.notify(t('export.rescueFailed'));
      return 'failed';
    }

    try {
      const blob = await deps.buildZip(rescueBundleEntries(bundle));
      deps.download(blob, `${base}.zip`);
      deps.notify(t('export.rescueSuccess', { count: bundle.manifest.tabs.length }));
      return 'zip';
    } catch (e) {
      console.error('[Rescue] Could not build the rescue ZIP; falling back to a single JSON file:', e);
    }

    try {
      const json = JSON.stringify({ manifest: bundle.manifest, files: bundle.files }, null, 2);
      deps.download(new Blob([json], { type: 'application/json' }), `${base}.json`);
      deps.notify(t('export.rescueJsonFallback'));
      return 'json';
    } catch (e) {
      console.error('[Rescue] Could not save the rescue JSON; downloading each source separately:', e);
    }

    // 最後の手段: 読めたソースを 1 ファイルずつ (1 つの失敗で残りを止めない)
    let saved = 0;
    for (const file of bundle.files) {
      if (!file.path.startsWith('src/')) continue;
      try {
        deps.download(new Blob([file.content], { type: 'text/plain' }), `${base}_${file.path.slice('src/'.length)}`);
        saved++;
      } catch (e) {
        console.error(`[Rescue] Could not save ${file.path}:`, e);
      }
    }
    deps.notify(t('export.rescueFailed'));
    return saved > 0 ? 'files' : 'failed';
  }
}

/** エディタのタブから救出する RescueExporter を作る (main.ts の配線用) */
export function createRescueExporter(
  tabManager: Pick<TabManager, 'getAllTabs' | 'getPersistenceReport'>,
  options: { mode: string; notify: (message: string) => void }
): RescueExporter {
  return new RescueExporter({
    getSources: () => liveTabRescueSources(tabManager),
    getLastSave: () => tabManager.getPersistenceReport().lastSave,
    mode: options.mode,
    now: () => new Date(),
    buildZip: buildRescueZip,
    download: downloadBlobAsFile,
    notify: options.notify,
  });
}
