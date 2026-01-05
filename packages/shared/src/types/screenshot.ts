/**
 * スクリーンショット関連の型定義
 */

// ============================================================================
// スクリーンショットキャプチャ
// ============================================================================

/** スクリーンショットキャプチャのトリガータイプ */
export type ScreenshotCaptureType =
  | 'periodic'       // 定期ポーリング（1分ごと）
  | 'focusLost'      // フォーカス喪失後5秒
  | 'manual';        // 将来の拡張用

/** ディスプレイ情報 */
export interface DisplayInfo {
  width: number;
  height: number;
  devicePixelRatio: number;
  displaySurface?: string;  // 'monitor', 'window', 'browser'
}

/** スクリーンショットイベントデータ（ハッシュチェーン記録用） */
export interface ScreenshotCaptureData {
  imageHash: string;           // 画像のSHA-256ハッシュ
  captureType: ScreenshotCaptureType;
  timestamp: number;           // キャプチャ時刻（performance.now()）
  displayInfo: DisplayInfo;
  storageKey: string;          // IndexedDB内のキー
  fileSizeBytes: number;       // 圧縮後のファイルサイズ
}

/** IndexedDBに保存するスクリーンショットレコード */
export interface StoredScreenshot {
  id: string;                  // UUID
  imageHash: string;           // SHA-256ハッシュ
  imageBlob: Blob;             // JPEG画像データ
  captureType: ScreenshotCaptureType;
  timestamp: number;           // キャプチャ時刻
  createdAt: number;           // Date.now()
  displayInfo: DisplayInfo;
  eventSequence: number;       // 対応するハッシュチェーンイベントのsequence
}

/** Screen Capture許可状態 */
export type ScreenCapturePermissionState =
  | 'granted'      // 許可済み
  | 'denied'       // 拒否
  | 'prompt'       // 未決定（プロンプト表示待ち）
  | 'unavailable'; // APIが利用不可

/** 画面共有開始イベントデータ */
export interface ScreenShareStartData {
  displaySurface: string;  // 'monitor', 'window', 'browser'
  displayInfo: DisplayInfo;
  timestamp: number;  // performance.now()
}

/** 画面共有停止イベントデータ */
export interface ScreenShareStopData {
  reason: 'user_stopped' | 'stream_ended' | 'error';
  timestamp: number;  // performance.now()
  duration: number;  // 共有開始からの経過時間（ミリ秒）
}
