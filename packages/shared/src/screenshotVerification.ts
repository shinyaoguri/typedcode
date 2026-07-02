/**
 * スクリーンショット検証の単一実装 (#146/#147)。
 *
 * 真正な記録は改ざん不能なチェーンに焼かれた `screenshotCapture.imageHash` だけであり、
 * `screenshots/manifest.json` と画像ファイルは未署名 = セットで差し替え可能。判定ポリシー:
 *
 * - verified: 画像バイト列の SHA-256 が manifest entry の `imageHash` と一致
 * - tampered: ハッシュ不一致、**または** `imageHash` がチェーン集合に無い
 *             (集合が空/未提供 = 旧 proof や screenshotCapture の無い proof は対象外)
 * - missing:  manifest entry の画像が ZIP/フォルダに無い、または読めない
 * - chainOnly: チェーンには記録があるのに manifest 側に対応 entry が無い imageHash 数
 *              (スクショの剥ぎ取り疑い。manifest ごと消しても検出できる唯一の軸)
 *
 * verify (web) と verify-cli の両方がここへ委譲する。片方だけ再実装すると
 * 「Web では改ざん FAILED / CLI では PROVEN + exit 0」型の乖離事故になる (#147)。
 */

import type { StoredEvent } from './types.js';
import { arrayBufferToHex } from './utils/hashUtils.js';

/** manifest entry のうち検証に必要な最小形。 */
export interface ScreenshotManifestEntryLike {
  filename: string;
  imageHash: string;
}

/** 1 画像の検証結果。 */
export interface ScreenshotImageCheck {
  /** 画像バイト列の SHA-256 が manifest の imageHash と一致したか。 */
  verified: boolean;
  /** 改ざん疑い (ハッシュ不一致 or チェーン非裏付け)。 */
  tampered: boolean;
}

/** manifest + 画像群 + チェーン集合から導く全体サマリ。 */
export interface ScreenshotVerificationSummary {
  /** manifest entry 数。 */
  total: number;
  verified: number;
  missing: number;
  tampered: number;
  /** チェーンに記録があるのに manifest に対応 entry が無い imageHash 数。 */
  chainOnly: number;
}

/** 画像バイト列の SHA-256 (hex)。Node ≥24 / ブラウザ両対応 (WebCrypto)。 */
export async function sha256HexOfBytes(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return arrayBufferToHex(buffer);
}

/**
 * proof (複数可) の `screenshotCapture` イベントから imageHash を収集する。
 * チェーンは検証済み・改ざん不能なので、これがスクショの真正なハッシュ集合になる。
 */
export function collectChainImageHashes(
  eventsList: ReadonlyArray<readonly StoredEvent[]>
): Set<string> {
  const hashes = new Set<string>();
  for (const events of eventsList) {
    for (const e of events) {
      if (e?.type === 'screenshotCapture') {
        const h = (e.data as { imageHash?: string } | null | undefined)?.imageHash;
        if (typeof h === 'string' && h.length > 0) hashes.add(h);
      }
    }
  }
  return hashes;
}

/**
 * entry の imageHash が検証済みチェーンに記録されているか。集合が未提供 or 空 (旧 proof /
 * screenshotCapture イベントを持たない proof 等) なら対象外とみなし true (false-positive 回避)。
 */
export function isChainBackedImageHash(
  imageHash: string,
  chainImageHashes?: ReadonlySet<string>
): boolean {
  if (!chainImageHashes || chainImageHashes.size === 0) return true;
  return chainImageHashes.has(imageHash);
}

/**
 * 1 画像の検証。verify (web) の ScreenshotService と verify-cli が共に使う判定の実体。
 */
export async function checkScreenshotImage(
  bytes: ArrayBuffer | Uint8Array,
  expectedImageHash: string,
  chainImageHashes?: ReadonlySet<string>
): Promise<ScreenshotImageCheck> {
  let verified = false;
  try {
    verified = (await sha256HexOfBytes(bytes)) === expectedImageHash;
  } catch {
    verified = false;
  }
  const tampered = !verified || !isChainBackedImageHash(expectedImageHash, chainImageHashes);
  return { verified, tampered };
}

/**
 * manifest 全 entry + 画像取得コールバックからサマリを導く (verify-cli の入口)。
 * `getImageBytes` が null を返した entry は missing。manifest 自体が無い場合は
 * `entries: []` で呼ぶと chainOnly (剥ぎ取り疑い) だけが残る。
 */
export async function summarizeScreenshotArtifacts(params: {
  entries: readonly ScreenshotManifestEntryLike[];
  getImageBytes: (filename: string) => Promise<ArrayBuffer | Uint8Array | null>;
  chainImageHashes?: ReadonlySet<string>;
}): Promise<ScreenshotVerificationSummary> {
  const { entries, getImageBytes, chainImageHashes } = params;
  let verified = 0;
  let missing = 0;
  let tampered = 0;

  for (const entry of entries) {
    let bytes: ArrayBuffer | Uint8Array | null = null;
    try {
      bytes = await getImageBytes(entry.filename);
    } catch {
      bytes = null;
    }
    if (bytes === null) {
      missing++;
      continue;
    }
    const check = await checkScreenshotImage(bytes, entry.imageHash, chainImageHashes);
    if (check.tampered) tampered++;
    else if (check.verified) verified++;
  }

  const manifestHashes = new Set(entries.map((e) => e.imageHash));
  let chainOnly = 0;
  for (const h of chainImageHashes ?? []) {
    if (!manifestHashes.has(h)) chainOnly++;
  }

  return { total: entries.length, verified, missing, tampered, chainOnly };
}
