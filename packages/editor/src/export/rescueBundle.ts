/**
 * 救出ファイル (`typedcode-rescue/2`) の組み立て (#544 / #300 / #413。ADR-0042)。
 *
 * 保存先 (IndexedDB / sessionStorage) や Turnstile・PoSW・ネットワークが壊れていても、学習者のコードを
 * 手元に残すための出力。**証明ではない**: `*_proof.json` を作らず、manifest に `notAProof: true` を書く。
 * 中身は、タブごとのソース (`src/`)、メモリ上のチェーンのイベント (`logs/`。検証していない記録)、
 * 復元時に証明と食い違って保全した元のコード (`unproven/<n>/`。#413)、`rescue-manifest.json`。
 *
 * schema の履歴: `/1` = #544 (src・logs)、`/2` = #413 (タブに `unprovenContents` を足し、`unproven/` を出す)。
 *
 * 入力のタブは `RescueTabSource` で受け、読み出しを関数にしてある。ライブのタブでも、IndexedDB から
 * 読んだアーカイブ (#317) でも同じ形で渡せる。タブ単位で try/catch するので、1 タブの読み出しが
 * throw しても他のタブは出る。内容が読めたタブは、イベントの読み出しだけが失敗しても `src/` を出す。
 */

import { createExportNamer } from '@typedcode/shared';
import type { PersistOutcome } from '../ui/tabs/syncStatus.js';

/** manifest の schema。形を変えたら番号を上げる */
export const RESCUE_SCHEMA = 'typedcode-rescue/2';

/** ZIP / JSON の中の manifest のパス */
export const RESCUE_MANIFEST_PATH = 'rescue-manifest.json';

/** manifest に書く注意書き (ファイルを受け取った人向け。翻訳しない) */
export const RESCUE_NOTICE =
  'This is a TypedCode rescue file, NOT a typing proof. It contains source code and unverified event logs ' +
  'saved without authentication or verification, and cannot be checked by the verifier. ' +
  'これは TypedCode の救出ファイルで、タイピング証明ではありません。認証・検証を経ずに保存したコードと' +
  '未検証の記録で、検証器では確かめられません。';

/** 復元時に証明と食い違って保全した元のコード 1 つ分 (#413) */
export interface RescueUnprovenContent {
  /** 切り詰める前の元のコード */
  content: string;
  /** 証明に載っている内容 (チェーンの replay) の文字数 */
  chainContentLength: number;
}

/** 救出するタブ 1 つ分の入力 */
export interface RescueTabSource {
  id: string;
  /** タブの名前 (拡張子なしでもよい。出力名は通常の export と同じ規則で付ける) */
  filename: string;
  /** Monaco の言語 id */
  language: string;
  /** エディタの内容を読む (throw してよい) */
  readContent(): string;
  /** メモリ上のチェーンのイベントを読む (throw してよい) */
  readEvents(): readonly unknown[];
  /** IndexedDB への保存を確かめたイベント数。分からなければ `null` */
  persistedEventCount: number | null;
  /** PoSW 待ち (チェーンに載っていない) のイベント数。読めなければ `null` */
  pendingEventCount: number | null;
  /** 復元時に保全した元のコードを古い順に読む (throw してよい。無ければ省略してよい。#413) */
  readUnprovenContents?(): readonly RescueUnprovenContent[];
}

/** manifest の、保全した元のコード 1 つ分 (#413) */
export interface RescueManifestUnprovenContent {
  /** ZIP 内のパス (`unproven/<n>/<名前>`。`src/` とは別の場所) */
  path: string;
  /** 元のコードの文字数 */
  originalLength: number;
  /** 証明に載っている内容の文字数 */
  chainContentLength: number;
}

/** manifest のタブ 1 つ分 */
export interface RescueManifestTab {
  id: string;
  filename: string;
  language: string;
  /** ZIP 内のソースのパス (`src/<名前>`)。内容が読めなければ `null` */
  source: string | null;
  /** ZIP 内のイベントのパス (`logs/<名前>.events.json`)。読めなければ `null` */
  eventsLog: string | null;
  /** 復元時に保全した元のコード (古い順。無ければ空配列、読めなければ `null`。#413) */
  unprovenContents: RescueManifestUnprovenContent[] | null;
  /** チェーンに載っているイベント数。読めなければ `null` */
  chainEventCount: number | null;
  persistedEventCount: number | null;
  pendingEventCount: number | null;
  /** そのタブの読み出しが throw したときの理由 (`content: ...` / `events: ...`) */
  error: string | null;
}

/** 直近の保存の結果 (manifest 用に、エラーを文字列にしたもの) */
export interface RescueLastSave {
  idbOk: boolean;
  sessionStorageOk: boolean;
  error: string | null;
}

export interface RescueManifest {
  schema: typeof RESCUE_SCHEMA;
  notAProof: true;
  notice: string;
  /** 救出した時刻 (ISO 8601) */
  createdAt: string;
  /** エディタのモード (casual / class / assignment / exam) */
  mode: string;
  /** 直近の保存の結果。まだ一度も保存していなければ `null` */
  lastSave: RescueLastSave | null;
  tabs: RescueManifestTab[];
}

/** 出力するファイル 1 つ (manifest を除く) */
export interface RescueFile {
  path: string;
  content: string;
}

export interface RescueBundle {
  manifest: RescueManifest;
  /** `src/`・`logs/`・`unproven/` のファイル。manifest は含まない (`rescueBundleEntries` で足す) */
  files: RescueFile[];
}

export interface BuildRescueBundleInput {
  sources: readonly RescueTabSource[];
  mode: string;
  createdAt: Date;
  lastSave: PersistOutcome | null;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/** 救出ファイルの中身を組み立てる (純関数。保存・待機・ネットワークを一切しない) */
export function buildRescueBundle({ sources, mode, createdAt, lastSave }: BuildRescueBundleInput): RescueBundle {
  // 名前は通常の export と同じ規則 (同名・拡張子違いのタブの番号付けまで含めて)。救出したソースを
  // 後から通常の export と突き合わせるときに、同じタブが同じ名前になる
  const nameOf = createExportNamer();
  const files: RescueFile[] = [];
  const tabs: RescueManifestTab[] = [];

  for (const source of sources) {
    const name = nameOf({ filename: source.filename, language: source.language }).source;
    const tab: RescueManifestTab = {
      id: source.id,
      filename: source.filename,
      language: source.language,
      source: null,
      eventsLog: null,
      unprovenContents: null,
      chainEventCount: null,
      persistedEventCount: source.persistedEventCount,
      pendingEventCount: source.pendingEventCount,
      error: null,
    };
    const errors: string[] = [];

    try {
      const path = `src/${name}`;
      files.push({ path, content: source.readContent() });
      tab.source = path;
    } catch (e) {
      errors.push(`content: ${describeError(e)}`);
    }

    try {
      const events = source.readEvents();
      const path = `logs/${name}.events.json`;
      files.push({ path, content: JSON.stringify(events, null, 2) });
      tab.eventsLog = path;
      tab.chainEventCount = events.length;
    } catch (e) {
      errors.push(`events: ${describeError(e)}`);
    }

    // 復元時に証明と食い違って保全した元のコード (#413)。`src/` (エディタの内容 = 証明と同じ版) とは
    // 別の場所に、保全した順の番号を付けて出す (同じタブで 2 回以上食い違うことがある)
    try {
      const unproven = source.readUnprovenContents?.() ?? [];
      const listed: RescueManifestUnprovenContent[] = [];
      unproven.forEach((record, i) => {
        const path = `unproven/${i + 1}/${name}`;
        files.push({ path, content: record.content });
        listed.push({ path, originalLength: record.content.length, chainContentLength: record.chainContentLength });
      });
      tab.unprovenContents = listed;
    } catch (e) {
      errors.push(`unproven: ${describeError(e)}`);
    }

    if (errors.length > 0) tab.error = errors.join('; ');
    tabs.push(tab);
  }

  return {
    manifest: {
      schema: RESCUE_SCHEMA,
      notAProof: true,
      notice: RESCUE_NOTICE,
      createdAt: createdAt.toISOString(),
      mode,
      lastSave: lastSave
        ? {
            idbOk: lastSave.idbOk,
            sessionStorageOk: lastSave.sessionStorageOk,
            error: lastSave.error === undefined ? null : describeError(lastSave.error),
          }
        : null,
      tabs,
    },
    files,
  };
}

/** ZIP に入れるファイルの一覧 (`src/`・`logs/`・`unproven/` と manifest) */
export function rescueBundleEntries(bundle: RescueBundle): RescueFile[] {
  return [...bundle.files, { path: RESCUE_MANIFEST_PATH, content: JSON.stringify(bundle.manifest, null, 2) }];
}
