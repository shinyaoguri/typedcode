/**
 * TermsHandler - 利用規約ハンドラ
 * 利用規約の確認と同意処理を担当
 */

import { showStaticDialog } from '../ui/components/dialogA11y.js';

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
 * 利用規約への同意フラグを localStorage に記録する (ADR-0015)。
 * ランディングでカードを選んだ時の暗黙同意でも使う (モーダルの handleAgree と同じ形)。
 */
export function markTermsAccepted(): void {
  const timestamp = Date.now();
  try {
    localStorage.setItem(
      TERMS_ACCEPTED_KEY,
      JSON.stringify({
        version: TERMS_VERSION,
        timestamp,
        agreedAt: new Date(timestamp).toISOString(),
      })
    );
  } catch {
    /* 保存不可環境では諦める (同意フラグなしでも続行できる) */
  }
}

/**
 * 利用規約モーダルを表示
 *
 * a11y (#305): `index.html` の静的 overlay を `showStaticDialog` で開く (名前付きの modal dialog、
 * Tab の閉じ込め、最初のアコーディオンへの初期フォーカス)。同意が必須なので Escape では閉じない。
 * 練習の規約通知から開いた場合、起点のボタンは disabled で通知ごと消えるので、閉じた後は body に落ちる。
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
    const dialog = showStaticDialog(termsModal, { closeOnEscape: false });

    const handleCheckboxChange = (): void => {
      termsAgreeBtn.disabled = !termsAgreeCheckbox.checked;
    };

    const handleAgree = (): void => {
      const timestamp = Date.now();
      localStorage.setItem(
        TERMS_ACCEPTED_KEY,
        JSON.stringify({
          version: TERMS_VERSION,
          timestamp,
          agreedAt: new Date(timestamp).toISOString(),
        })
      );
      termsAgreeCheckbox.removeEventListener('change', handleCheckboxChange);
      termsAgreeBtn.removeEventListener('click', handleAgree);
      dialog.close();
      console.log('[TypedCode] Terms accepted at', new Date(timestamp).toISOString());
      resolve();
    };

    termsAgreeCheckbox.addEventListener('change', handleCheckboxChange);
    termsAgreeBtn.addEventListener('click', handleAgree);
  });
}
