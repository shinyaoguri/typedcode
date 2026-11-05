/**
 * TabVerificationUI - Turnstile認証のUI制御
 */

import type {
  HumanAttestationEventData,
  VerificationState,
  VerificationDetails,
  SessionStartToken,
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
  /** セッション開始トークン (ADR-0017)。sessionStart 指定かつ成功時のみ。root アンカーに使う。 */
  sessionToken?: SessionStartToken | null;
  /**
   * 予算を過ぎてから届いたセッション開始トークン (#375)。予算切れで返したときだけ、裏で走り続ける
   * 認証が後で `sessionToken` を返せばそれに、そうでなければ null に解決する。予算内に終わったときは
   * 即座に null に解決する (token は `sessionToken` にある)。root には焼かず、署名専用に回す。
   */
  lateSessionToken: Promise<SessionStartToken | null>;
}

/** performVerificationWithUI のオプション */
export interface VerificationUIOptions {
  /**
   * 認証全体の予算 (ms。#375)。超過したら認証を中断し (token を得る前の段階だけ。表示中のチャレンジも
   * 打ち切る)、モーダルを閉じて失敗 (`failureReason: 'timeout'`) を返す。省略すると従来どおり終わるまで待つ。
   */
  budgetMs?: number;
}

/** 予算切れのときに返す認証結果 (#375)。失敗理由は既存の 'timeout' を使う (shared の型は変えない)。 */
const BUDGET_EXCEEDED_RESULT: VerificationResult = {
  success: false,
  error: 'budget_exceeded',
  failureReason: 'timeout',
};

/** ステップ状態の型 */
type StepStatus = 'pending' | 'active' | 'done' | 'error';

/**
 * Turnstile認証をUI表示と共に実行
 */
export async function performVerificationWithUI(
  action: string,
  t: (key: string, params?: Record<string, string>) => string,
  sessionStart?: { sessionId: string; fingerprintHash: string },
  options?: VerificationUIOptions
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

  // モーダルを閉じた後 (予算切れで裏の認証が走り続けるとき) は、ステップ表示などの共有 DOM に触らない (#375)。
  // 裏の実行は開始時に捕まえたこのコールバックを呼び続けるので、登録の解除だけでは止まらない。
  let uiActive = true;

  // フェーズコールバックを設定
  setPhaseCallback((phase, status) => {
    if (!uiActive) return;
    updateStepStatus(phase, status);
  });

  // リトライ状況のコールバックを設定
  setRetryStatusCallback((status) => {
    if (!uiActive) return;
    if (status.isRetrying) {
      // リトライ中の表示
      modalDialog?.classList.add('verification-warning');
      retryInfo?.classList.remove('hidden');
      if (retryAttempt) {
        retryAttempt.textContent = t('verification.retryAttempt', {
          current: String(status.attempt),
          max: String(status.maxRetries),
        });
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

  // 総タイムアウト計算（チャレンジ20秒 + リトライ待機 1+2+4=7秒 = 約27秒）。
  // 予算があれば予算にする (バーが満ちたところでモーダルが閉じる。#375)
  const budgetMs = options?.budgetMs;
  const TIMEOUT_MS = budgetMs ?? 27000;
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

  // 予算があれば中断できるようにする (#375)
  const controller = budgetMs !== undefined ? new AbortController() : null;

  // 認証実行（TurnstileService内でフェーズ・リトライ処理）。
  // ADR-0017: sessionStart 指定時は session/start を呼び ECDSA トークンを取得する。
  const verification: Promise<VerificationResult> = performTurnstileVerification(action, {
    ...(sessionStart ? { sessionStart } : {}),
    ...(controller ? { signal: controller.signal } : {}),
  }).catch((error: unknown): VerificationResult => {
    // エラー時（ネットワークエラー等）はタイムアウトとして扱う
    console.error('[TabVerificationUI] Verification error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      failureReason: 'network_error',
    };
  });

  let budgetExceeded = false;
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  let result: VerificationResult;
  try {
    if (controller && budgetMs !== undefined) {
      const budget = new Promise<VerificationResult>((resolve) => {
        budgetTimer = setTimeout(() => {
          budgetExceeded = true;
          resolve(BUDGET_EXCEEDED_RESULT);
          // token を得る前の段階 (スクリプト読込・チャレンジ) を止め、表示中の widget を片付けさせる。
          // session/start に入っていれば止まらず、その結果は lateSessionToken で受ける。
          controller.abort();
        }, budgetMs);
      });
      const raced = await Promise.race([verification, budget]);
      result = budgetExceeded ? BUDGET_EXCEEDED_RESULT : raced;
    } else {
      result = await verification;
    }
  } finally {
    clearTimeout(budgetTimer);
    uiActive = false;
    // コールバックをクリア。予算切れでもこの時点で外す (遅れて外すと、次のタブ作成が登録した
    // コールバックを消してしまう)
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

  // 認証データを生成。
  // ADR-0017: session/start 経由 (result.sessionToken あり) では /api/verify-captcha の attestation が無い。
  // #0 humanAttestation の暗号的束縛は proof 同梱の ECDSA sessionStartToken が担うため、ここでは
  // タイムライン上の可読な監査印として token の情報から #0 を構成する (signature は token 由来の印)。
  // token の無い経路 (/api/verify-captcha) の attestation は署名しない (#415) ので、signature は
  // サーバの値にかかわらず常に 'unsigned' にそろえる。
  const token = result.sessionToken;
  const attestationData: HumanAttestationEventData = token
    ? {
        verified: result.success,
        score: result.score ?? (result.success ? 1.0 : 0),
        action: token.payload.action ?? action,
        timestamp: token.payload.issuedAt,
        hostname: token.payload.hostname ?? window.location.hostname,
        signature: `session-start-token:${token.keyId}`,
        success: result.success,
        failureReason: result.failureReason,
      }
    : {
        verified: result.attestation?.verified ?? false,
        score: result.attestation?.score ?? 0,
        action: result.attestation?.action ?? action,
        timestamp: result.attestation?.timestamp ?? new Date().toISOString(),
        hostname: result.attestation?.hostname ?? window.location.hostname,
        signature: 'unsigned',
        success: result.success,
        failureReason: result.failureReason,
      };

  console.log(
    '[TabVerificationUI] Human attestation recorded:',
    result.success ? `verified${token ? ' (server-anchored)' : ''}` : `failed (${result.failureReason ?? result.error})`
  );

  if (budgetExceeded) {
    console.warn(
      `[TabVerificationUI] Verification exceeded the ${budgetMs}ms budget; continuing without a root anchor`
    );
  }

  return {
    verificationState,
    verificationDetails,
    attestationData,
    result,
    sessionToken: result.sessionToken ?? null,
    lateSessionToken: budgetExceeded
      ? verification.then((late) => (late.success && late.sessionToken ? late.sessionToken : null))
      : Promise.resolve(null),
  };
}
