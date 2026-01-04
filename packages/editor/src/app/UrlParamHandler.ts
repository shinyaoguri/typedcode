/**
 * UrlParamHandler - URLパラメータ処理
 * リセット、フレッシュウィンドウなどのURLパラメータを処理
 */

/**
 * URLパラメータを処理
 * この関数はインポート前に同期的に実行される必要があるため、
 * main.tsの先頭で直接呼び出される
 */
export function handleUrlParams(): void {
  const urlParams = new URLSearchParams(window.location.search);

  // Handle full reset request
  if (urlParams.get('reset')) {
    console.log('[TypedCode] Reset parameter detected, clearing all data...');
    // Clear all storage synchronously before any other code runs
    try { localStorage.clear(); } catch { /* ignore */ }
    try { sessionStorage.clear(); } catch { /* ignore */ }
    try {
      const cookies = document.cookie.split(';');
      for (const cookie of cookies) {
        const eqPos = cookie.indexOf('=');
        const name = eqPos > -1 ? cookie.substring(0, eqPos).trim() : cookie.trim();
        if (name) {
          document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
        }
      }
    } catch { /* ignore */ }
    try { indexedDB.deleteDatabase('typedcode-screenshots'); } catch { /* ignore */ }
    // Remove the reset parameter from URL
    const cleanUrl = window.location.origin + window.location.pathname;
    window.history.replaceState({}, '', cleanUrl);
    console.log('[TypedCode] All data cleared, URL cleaned');
  }

  // Check if this is a fresh window request (opened via "New Window" menu)
  // If so, clear sessionStorage to start with a clean state
  if (urlParams.get('fresh') === '1') {
    sessionStorage.removeItem('typedcode-tabs');
    // Remove the ?fresh=1 from URL without reloading
    const cleanUrl = window.location.origin + window.location.pathname;
    window.history.replaceState({}, '', cleanUrl);
  }
}
