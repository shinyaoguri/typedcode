/**
 * TabVerificationUI - Turnstile認証のUI制御
 */

import type {
  HumanAttestationEventData,
  VerificationState,
  VerificationDetails,
} from '@typedcode/shared';
import {
  performTurnstileVerification,
  setPhaseCallback,
  setRetryStatusCallback,
  type VerificationResult,
  type VerificationPhase,
} from '../../services/TurnstileService.js';

/** 認証UI結果 */
export interface VerificationUIResult {
  verificationState: VerificationState;
  verificationDetails: VerificationDetails;
  attestationData: HumanAttestationEventData;
  result: VerificationResult;
}

/** ステップ状態の型 */
type StepStatus = 'pending' | 'active' | 'done' | 'error';

/**
 * Turnstile認証をUI表示と共に実行
 */
export async function performVerificationWithUI(
  action: string,
  t: (key: string, params?: Record<string, string>) => string
): Promise<VerificationUIResult> {
  // ローディングモーダル要素を取得
  const loadingModal = document.getElementById('verification-loading-modal');
  const modalDialog = document.getElementById('verification-dialog');
  const progressBar = document.getElementById('verification-timeout-progress');
  const retryInfo = document.getElementById('verification-retry-info');
  const retryAttempt = document.getElementById('verification-retry-attempt');
  const retryCountdown = document.getElementById('verification-retry-countdown');

  // ステップ要素を取得
  const stepPrepare = document.getElementById('step-prepare');
  const stepChallenge = document.getElementById('step-challenge');
  const stepVerify = document.getElementById('step-verify');

  // ステップ状態を更新するヘルパー関数
  const updateStepStatus = (phase: VerificationPhase, status: StepStatus) => {
    const stepMap: Record<VerificationPhase, HTMLElement | null> = {
      prepare: stepPrepare,
      challenge: stepChallenge,
      verify: stepVerify,
    };
    const step = stepMap[phase];
    if (step) {
      step.dataset.status = status;
    }
  };

  // 初期状態にリセット
  loadingModal?.classList.remove('hidden');
  modalDialog?.classList.remove('verification-warning');
  retryInfo?.classList.add('hidden');
  updateStepStatus('prepare', 'pending');
  updateStepStatus('challenge', 'pending');
  updateStepStatus('verify', 'pending');

  // リトライカウントダウン用のインターバル
  let countdownInterval: number | null = null;

  // フェーズコールバックを設定
  setPhaseCallback((phase, status) => {
    updateStepStatus(phase, status);
  });

  // リトライ状況のコールバックを設定
  setRetryStatusCallback((status) => {
    if (status.isRetrying) {
      // リトライ中の表示
      modalDialog?.classList.add('verification-warning');
      retryInfo?.classList.remove('hidden');
      if (retryAttempt) {
        retryAttempt.textContent = t('verification.retryAttempt', { current: String(status.attempt), max: String(status.maxRetries) });
      }

      // カウントダウン表示
      if (retryCountdown) {
        let remainingMs = status.nextDelayMs;
        const updateCountdown = () => {
          const seconds = Math.ceil(remainingMs / 1000);
          retryCountdown.textContent = t('verification.retryCountdown', { seconds: String(seconds) });
        };
        updateCountdown();

        // 既存のインターバルをクリア
        if (countdownInterval !== null) {
          clearInterval(countdownInterval);
        }

        countdownInterval = window.setInterval(() => {
          remainingMs -= 100;
          if (remainingMs <= 0) {
            if (countdownInterval !== null) {
              clearInterval(countdownInterval);
              countdownInterval = null;
            }
            if (retryCountdown) retryCountdown.textContent = t('common.retrying');
          } else {
            updateCountdown();
          }
        }, 100);
      }
    } else {
      // リトライ終了（成功または全リトライ失敗）
      if (countdownInterval !== null) {
        clearInterval(countdownInterval);
        countdownInterval = null;
      }
      retryInfo?.classList.add('hidden');
      modalDialog?.classList.remove('verification-warning');
    }
  });

  // 総タイムアウト計算（チャレンジ20秒 + リトライ待機 1+2+4=7秒 = 約27秒）
  const TIMEOUT_MS = 27000;
  const startTime = Date.now();
  let animationFrame: number | null = null;

  const updateProgress = () => {
    const elapsed = Date.now() - startTime;
    const progress = Math.min((elapsed / TIMEOUT_MS) * 100, 100);
    if (progressBar) {
      progressBar.style.width = `${progress}%`;
    }
    if (elapsed < TIMEOUT_MS) {
      animationFrame = requestAnimationFrame(updateProgress);
    }
  };
  animationFrame = requestAnimationFrame(updateProgress);

  let result: VerificationResult;
  try {
    // 認証実行（TurnstileService内でフェーズ・リトライ処理）
    result = await performTurnstileVerification(action);
  } catch (error) {
    // エラー時（ネットワークエラー等）はタイムアウトとして扱う
    console.error('[TabVerificationUI] Verification error:', error);
    result = {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      failureReason: 'network_error',
    };
  } finally {
    // コールバックをクリア
    setPhaseCallback(null);
    setRetryStatusCallback(null);

    // カウントダウンインターバルをクリア
    if (countdownInterval !== null) {
      clearInterval(countdownInterval);
    }

    // アニメーション停止
    if (animationFrame !== null) {
      cancelAnimationFrame(animationFrame);
    }
    // プログレスバーをリセット
    if (progressBar) {
      progressBar.style.width = '0%';
    }
    // ローディングモーダルを非表示
    loadingModal?.classList.add('hidden');
    // モーダルの状態をリセット
    modalDialog?.classList.remove('verification-warning');
    retryInfo?.classList.add('hidden');
  }

  // 認証状態を設定
  const verificationState: VerificationState = result.success ? 'verified' : 'failed';
  const verificationDetails: VerificationDetails = {
    timestamp: new Date().toISOString(),
    failureReason: result.failureReason,
  };

  // 認証データを生成
  const attestationData: HumanAttestationEventData = {
    verified: result.attestation?.verified ?? false,
    score: result.attestation?.score ?? 0,
    action: result.attestation?.action ?? action,
    timestamp: result.attestation?.timestamp ?? new Date().toISOString(),
    hostname: result.attestation?.hostname ?? window.location.hostname,
    signature: result.attestation?.signature ?? 'unsigned',
    success: result.success,
    failureReason: result.failureReason,
  };

  console.log('[TabVerificationUI] Human attestation recorded:',
    result.success ? 'verified' : `failed (${result.failureReason ?? result.error})`);

  return {
    verificationState,
    verificationDetails,
    attestationData,
    result,
  };
}
