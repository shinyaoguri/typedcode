/**
 * TermsHandler - 利用規約ハンドラ
 * 利用規約の確認と同意処理を担当
 */

// 利用規約関連の定数
const TERMS_ACCEPTED_KEY = 'typedcode-terms-accepted';
const TERMS_VERSION = '1.0';

/**
 * 利用規約が承諾済みかチェック
 */
export function hasAcceptedTerms(): boolean {
  const accepted = localStorage.getItem(TERMS_ACCEPTED_KEY);
  if (!accepted) return false;
  try {
    const data = JSON.parse(accepted);
    return data.version === TERMS_VERSION;
  } catch {
    return false;
  }
}

/**
 * 利用規約モーダルを表示
 */
export async function showTermsModal(): Promise<void> {
  const termsModal = document.getElementById('terms-modal');
  const termsAgreeCheckbox = document.getElementById('terms-agree-checkbox') as HTMLInputElement | null;
  const termsAgreeBtn = document.getElementById('terms-agree-btn') as HTMLButtonElement | null;

  if (!termsModal || !termsAgreeCheckbox || !termsAgreeBtn) {
    console.error('[TypedCode] Terms modal elements not found');
    return;
  }

  return new Promise((resolve) => {
    termsModal.classList.remove('hidden');

    const handleCheckboxChange = (): void => {
      termsAgreeBtn.disabled = !termsAgreeCheckbox.checked;
    };

    const handleAgree = (): void => {
      const timestamp = Date.now();
      localStorage.setItem(TERMS_ACCEPTED_KEY, JSON.stringify({
        version: TERMS_VERSION,
        timestamp,
        agreedAt: new Date(timestamp).toISOString(),
      }));
      termsAgreeCheckbox.removeEventListener('change', handleCheckboxChange);
      termsAgreeBtn.removeEventListener('click', handleAgree);
      termsModal.classList.add('hidden');
      console.log('[TypedCode] Terms accepted at', new Date(timestamp).toISOString());
      resolve();
    };

    termsAgreeCheckbox.addEventListener('change', handleCheckboxChange);
    termsAgreeBtn.addEventListener('click', handleAgree);
  });
}

/**
 * 利用規約の承諾データを取得
 */
export function getTermsAcceptanceData(): {
  version: string;
  timestamp: number;
  agreedAt: string;
} | null {
  const termsData = localStorage.getItem(TERMS_ACCEPTED_KEY);
  if (!termsData) return null;

  try {
    return JSON.parse(termsData);
  } catch {
    return null;
  }
}

/**
 * 利用規約関連の定数をエクスポート
 */
export const TERMS_CONSTANTS = {
  ACCEPTED_KEY: TERMS_ACCEPTED_KEY,
  VERSION: TERMS_VERSION,
} as const;
