/**
 * 起動処理の失敗画面 (#325)。
 *
 * 起動のどこで止まっても、スピナーのまま残さずに `#boot-failure-overlay` を出す。
 * `entry.ts` (main の chunk の取得失敗・top-level の例外) と `main.ts` (`initializeApp` の reject)
 * の両方から呼ぶので、landing の経路に重い依存を持ち込まないよう DOM 以外を import しない (#302)。
 */

export interface BootFailureOptions {
  /** 別タブが古い版の IndexedDB 接続を握っていて開けなかった (`SessionStorageBlockedError`)。案内を足す。 */
  storageBlocked?: boolean;
}

/**
 * 起動の途中で投げられた例外を画面に出す (#325)。スピナーを消し、再読み込みを案内する静的オーバーレイを開く。
 * データを消す操作は置かない (保存済みのデータは残っている)。`data-app-state` は `initializing` のまま
 * (起動を途中で止める他の画面と同じ扱い。何で止まったかは `data-dialog="boot-failure"` で見る)。
 */
export function showBootFailure(error: unknown, opts: BootFailureOptions = {}): void {
  console.error('[TypedCode] Initialization failed:', error);
  document.getElementById('init-overlay')?.classList.add('hidden');

  const overlay = document.getElementById('boot-failure-overlay');
  if (!overlay) return;

  const blockedHint = document.getElementById('boot-failure-blocked-hint');
  if (blockedHint) blockedHint.hidden = !opts.storageBlocked;

  const detail = document.getElementById('boot-failure-detail-text');
  if (detail) {
    detail.textContent = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }

  document.getElementById('boot-failure-reload-btn')?.addEventListener('click', () => window.location.reload(), {
    once: true,
  });
  overlay.classList.remove('hidden');
}
