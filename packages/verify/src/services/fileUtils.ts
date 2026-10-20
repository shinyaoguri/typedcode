/**
 * fileUtils - ファイル処理ユーティリティ
 *
 * ファイル判定・言語推測などの共通ユーティリティ
 *
 * 拡張子 → 言語の表は shared の `LANGUAGE_MAP` が正本 (#278)。ここに表を書き起こさない
 * (`__tests__/fileUtilsPolicy.test.ts` が機械的に禁止する)。
 */

import { isBinaryFile as sharedIsBinaryFile } from '@typedcode/shared';

// 言語推測・ファイルタイプ判定は shared の実装をそのまま使う
export { getLanguageFromExtension, getFileType, isProofFilename } from '@typedcode/shared';

/**
 * 画像ファイルかどうかを判定
 *
 * shared には画像判定が無いので verify 固有。
 */
export function isImageFile(filename: string): boolean {
  const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'];
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
  return imageExtensions.includes(ext);
}

/**
 * バイナリファイルかどうかを判定（画像を除く）
 *
 * shared 版との差分は意図的: 画像は別経路 (ZipFileProcessor が先に処理) で扱うので
 * ここでは「バイナリではない」と答える。`.ico` は shared ではバイナリで、`isImageFile` にも
 * 入っていないため、バイナリのまま (現状どおり)。
 */
export function isBinaryFile(filename: string): boolean {
  return !isImageFile(filename) && sharedIsBinaryFile(filename);
}
