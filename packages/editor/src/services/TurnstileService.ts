/**
 * Cloudflare Turnstile integration module
 * Handles token acquisition and verification via Cloudflare Workers backend
 */

import { t } from '../i18n/index.js';
import type { SessionStartToken } from '@typedcode/shared';
import { WORKERS_FETCH_TIMEOUT_MS } from '../config/timeouts.js';

declare global {
  interface Window {
    turnstile: {
      render: (container: string | HTMLElement, options: TurnstileOptions) => string;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
      getResponse: (widgetId: string) => string | undefined;
      execute: (container: string | HTMLElement, options: TurnstileOptions) => void;
    };
  }
}

interface TurnstileOptions {
  sitekey: string;
  callback?: (token: string) => void;
  'error-callback'?: (error: Error) => void;
  'expired-callback'?: () => void;
  theme?: 'light' | 'dark' | 'auto';
  size?: 'normal' | 'compact' | 'flexible';
  action?: string;
  execution?: 'render' | 'execute';
  appearance?: 'always' | 'execute' | 'interaction-only';
}

// Environment variables (set via Vite)
const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string;
const API_URL = import.meta.env.VITE_API_URL as string;

// Turnstile script loading state
let scriptLoaded = false;
let scriptLoading = false;
let loadPromise: Promise<void> | null = null;

/**
 * Check if Turnstile is configured
 */
export function isTurnstileConfigured(): boolean {
  return Boolean(TURNSTILE_SITE_KEY && API_URL);
}

/** Timeout for script loading (10 seconds) */
const SCRIPT_LOAD_TIMEOUT_MS = 10000;

/**
 * Load Turnstile script dynamically with timeout
 */
export function loadTurnstileScript(): Promise<void> {
  if (scriptLoaded) {
    return Promise.resolve();
  }

  if (scriptLoading && loadPromise) {
    return loadPromise;
  }

  if (!TURNSTILE_SITE_KEY) {
    console.warn('[Turnstile] Site key not configured, skipping Turnstile');
    return Promise.resolve();
  }

  scriptLoading = true;

  loadPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    script.async = true;
    script.defer = true;

    // Timeout for script loading
    const timeoutId = setTimeout(() => {
      scriptLoading = false;
      loadPromise = null;
      script.remove();
      console.error('[Turnstile] Script load timed out');
      reject(new Error('Turnstile script load timed out'));
    }, SCRIPT_LOAD_TIMEOUT_MS);

    script.onload = () => {
      clearTimeout(timeoutId);
      scriptLoaded = true;
      scriptLoading = false;
      console.log('[Turnstile] Script loaded successfully');
      resolve();
    };

    script.onerror = () => {
      clearTimeout(timeoutId);
      scriptLoading = false;
      loadPromise = null;
      console.error('[Turnstile] Failed to load script');
      reject(new Error('Failed to load Turnstile script'));
    };

    document.head.appendChild(script);
  });

  return loadPromise;
}

/** Timeout for Turnstile verification (60 seconds for user interaction) */
const TURNSTILE_TIMEOUT_MS = 60000;

/** Result from getTurnstileToken including failure reason */
interface TokenResult {
  token: string | null;
  failureReason?: VerificationFailureReason;
  /** True if the failure is likely due to network issues (should retry) */
  isNetworkError?: boolean;
}

/** Options for getTurnstileToken */
interface GetTurnstileTokenOptions {
  /** Custom widget container element */
  widgetContainer?: HTMLElement;
  /** Custom parent container to show/hide (optional) */
  parentContainer?: HTMLElement;
  /**
   * 中断の合図 (#375)。abort されたら描画済みの widget を remove してコンテナを空にし、
   * token が無ければ `timeout` で即座に戻る (表示中のチャレンジの打ち切り)。コンテナは次のタブ作成と
   * 共有するので、裏で走り続けた前回の実行が後から空にしないよう、abort の時点で片付ける。
   */
  signal?: AbortSignal;
}

/**
 * Get Turnstile token for the specified action (single attempt)
 * Renders challenge widget inside the verification modal's container
 * Extends timeout when interactive challenge is displayed
 * Returns quickly on network errors to allow retry logic at higher level
 */
export async function getTurnstileToken(action: string, options?: GetTurnstileTokenOptions): Promise<TokenResult> {
  if (!TURNSTILE_SITE_KEY) {
    console.warn('[Turnstile] Site key not configured');
    return { token: null, failureReason: 'token_acquisition_failed', isNetworkError: false };
  }

  // Check if Turnstile script is loaded
  if (!window.turnstile) {
    console.error('[Turnstile] Script not loaded');
    return { token: null, failureReason: 'token_acquisition_failed', isNetworkError: true };
  }

  const signal = options?.signal;
  if (signal?.aborted) {
    return { token: null, failureReason: 'timeout', isNetworkError: false };
  }

  return new Promise<TokenResult>((outerResolve) => {
    // Check for custom container from options first
    const customWidgetContainer = options?.widgetContainer;
    const customParentContainer = options?.parentContainer;

    // Get the modal's widget container (fallback to default verification modal)
    const modalWidgetContainer = customWidgetContainer ?? document.getElementById('turnstile-widget-container');
    const challengeContainer = customParentContainer ?? document.getElementById('verification-challenge-container');

    // Use modal container if available, otherwise create a fallback
    let widgetContainer: HTMLElement;
    let fallbackContainer: HTMLElement | null = null;

    if (modalWidgetContainer) {
      // Clear any existing widget in the container before rendering a new one
      modalWidgetContainer.innerHTML = '';
      widgetContainer = modalWidgetContainer;
    } else {
      // Fallback: create container (for cases where modal isn't shown)
      console.warn('[Turnstile] Modal container not found, using fallback');
      fallbackContainer = document.createElement('div');
      fallbackContainer.id = 'turnstile-fallback-container';
      fallbackContainer.style.position = 'fixed';
      fallbackContainer.style.top = '50%';
      fallbackContainer.style.left = '50%';
      fallbackContainer.style.transform = 'translate(-50%, -50%)';
      fallbackContainer.style.zIndex = '20002';
      fallbackContainer.style.background = 'var(--bg-secondary, #1e1e1e)';
      fallbackContainer.style.padding = '24px';
      fallbackContainer.style.borderRadius = '8px';
      fallbackContainer.style.boxShadow = '0 4px 20px rgba(0, 0, 0, 0.5)';
      document.body.appendChild(fallbackContainer);

      const title = document.createElement('div');
      title.textContent = t('verification.title');
      title.style.textAlign = 'center';
      title.style.marginBottom = '16px';
      title.style.fontSize = '14px';
      title.style.color = 'var(--text-primary, #ffffff)';
      fallbackContainer.appendChild(title);

      widgetContainer = document.createElement('div');
      fallbackContainer.appendChild(widgetContainer);
    }

    let resolved = false;
    let widgetId: string | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    /** 成功のチェックマークを見せる待ちのタイマー (中断されたら待たずに返す) */
    let successDelayId: ReturnType<typeof setTimeout> | null = null;
    /** 取得済みの token (成功表示の待ち中に中断されても、token は捨てずに返す) */
    let acquiredToken: string | null = null;

    // 中断 (#375): 待ちを打ち切り、widget とコンテナを今すぐ片付けて返す。片付けを後回しにすると、
    // 次のタブ作成が同じコンテナに描いた widget を、この実行の後始末が消してしまう。
    // token を得た後 (成功表示の待ち中) に中断されたら token を返す (呼び出し側は session/start へ進む)。
    // resolve 済みの経路はリスナーを外しているので、ここに来るのは未決着か成功表示の待ち中だけ。
    const onAbort = () => {
      resolved = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (successDelayId) clearTimeout(successDelayId);
      cleanup();
      if (acquiredToken) {
        resolve({ token: acquiredToken, isNetworkError: false });
      } else {
        console.warn('[Turnstile] Challenge aborted');
        resolve({ token: null, failureReason: 'timeout', isNetworkError: false });
      }
    };

    const resolve = (result: TokenResult) => {
      signal?.removeEventListener('abort', onAbort);
      outerResolve(result);
    };

    const cleanup = () => {
      if (widgetId) {
        try {
          window.turnstile.remove(widgetId);
        } catch {
          // Ignore cleanup errors
        }
      }
      // Clear the modal container content
      if (modalWidgetContainer) {
        modalWidgetContainer.innerHTML = '';
      }
      // Hide challenge container in modal
      if (challengeContainer) {
        challengeContainer.classList.add('hidden');
      }
      // Remove fallback container if used
      if (fallbackContainer) {
        fallbackContainer.remove();
      }
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    // Set timeout for verification
    timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        console.warn(`[Turnstile] Challenge timed out after ${TURNSTILE_TIMEOUT_MS}ms`);
        resolve({ token: null, failureReason: 'timeout', isNetworkError: true });
      }
    }, TURNSTILE_TIMEOUT_MS);

    // Show challenge container immediately since we're using appearance: 'always'
    if (challengeContainer) {
      challengeContainer.classList.remove('hidden');
    }

    try {
      // Detect current theme from document attribute
      const currentTheme = document.documentElement.getAttribute('data-theme');
      const turnstileTheme = currentTheme === 'light' ? 'light' : 'dark';

      widgetId = window.turnstile.render(widgetContainer, {
        sitekey: TURNSTILE_SITE_KEY,
        size: 'flexible',
        action,
        theme: turnstileTheme,
        appearance: 'always', // Always show the official Cloudflare widget
        callback: (token) => {
          if (!resolved) {
            resolved = true;
            if (timeoutId) clearTimeout(timeoutId);
            console.log('[Turnstile] Token acquired for action:', action);
            acquiredToken = token;
            // Wait a moment so user can see the success checkmark
            successDelayId = setTimeout(() => {
              cleanup();
              resolve({ token, isNetworkError: false });
            }, 1500);
          }
        },
        'error-callback': () => {
          if (!resolved) {
            resolved = true;
            if (timeoutId) clearTimeout(timeoutId);
            cleanup();
            console.error('[Turnstile] Challenge error (likely network issue)');
            resolve({ token: null, failureReason: 'network_error', isNetworkError: true });
          }
        },
      });
    } catch (error) {
      resolved = true;
      if (timeoutId) clearTimeout(timeoutId);
      cleanup();
      console.error('[Turnstile] Failed to render widget:', error);
      resolve({ token: null, failureReason: 'token_acquisition_failed', isNetworkError: true });
    }
  });
}

/**
 * Turnstile の検証結果の記録 (`/api/verify-captcha` が成功時に返す。署名しない = #415)。
 * 新しい Worker は `signature: 'unsigned'` を返す。旧 Worker は HMAC 値を返していたが、検証する
 * 場所が無いので editor は記録時に `'unsigned'` にそろえる (`ProofExporter` / `TabVerificationUI`)。
 */
export interface HumanAttestation {
  verified: boolean;
  score: number; // Turnstile has no score, always 1.0 on success
  action: string;
  timestamp: string;
  hostname: string;
  signature: string;
}

/**
 * Failure reason for verification
 */
export type VerificationFailureReason = 'challenge_failed' | 'timeout' | 'network_error' | 'token_acquisition_failed';

/**
 * Verification result from the backend
 */
export interface VerificationResult {
  success: boolean;
  score?: number;
  action?: string;
  error?: string;
  attestation?: HumanAttestation;
  failureReason?: VerificationFailureReason;
  /**
   * セッション開始トークン (ADR-0017)。`options.sessionStart` を渡したとき、Turnstile 成功で
   * サーバが発行する ECDSA 署名トークン。クライアントは serverNonce を root に焼く。
   */
  sessionToken?: SessionStartToken | null;
}

/** Retry configuration for network errors */
const RETRY_CONFIG = {
  maxRetries: 3,
  initialDelayMs: 1000, // 1秒 → 2秒 → 4秒
};

/** Verification phase */
export type VerificationPhase = 'prepare' | 'challenge' | 'verify';

/** Callback for phase updates */
export type PhaseCallback = (phase: VerificationPhase, status: 'active' | 'done' | 'error') => void;

/** Callback for retry status updates */
export type RetryStatusCallback = (status: {
  attempt: number;
  maxRetries: number;
  nextDelayMs: number;
  isRetrying: boolean;
}) => void;

/** Global phase callback */
let phaseCallback: PhaseCallback | null = null;

/** Global retry status callback */
let retryStatusCallback: RetryStatusCallback | null = null;

/**
 * Set callback for phase updates
 */
export function setPhaseCallback(callback: PhaseCallback | null): void {
  phaseCallback = callback;
}

/**
 * Set callback for retry status updates
 */
export function setRetryStatusCallback(callback: RetryStatusCallback | null): void {
  retryStatusCallback = callback;
}

/**
 * Check if an error is a network error (should retry) vs bot detection (should not retry)
 */
function isNetworkError(response: Response | null, error: Error | null): boolean {
  // Network failure (no response)
  if (!response && error) {
    return true;
  }

  // Connection errors, timeouts
  if (response === null) {
    return true;
  }

  // Bot detection by Cloudflare (403, 429) - don't retry
  if (response.status === 403 || response.status === 429) {
    return false;
  }

  // Server errors (5xx) - retry
  if (response.status >= 500) {
    return true;
  }

  // Other client errors (4xx except 403/429) - don't retry
  if (response.status >= 400) {
    return false;
  }

  return false;
}

/**
 * Sleep for specified milliseconds.
 * signal が abort されたら待ちを打ち切って即座に戻る (#375。戻った後の abort の判定は呼び出し側)。
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** `untilAborted` が中断で戻ったことを表す印 */
const ABORTED = Symbol('aborted');

/**
 * promise の決着か signal の abort の早い方で戻る (#375)。abort しても promise 自体は止めない
 * (スクリプト読込は共有の loadPromise なので、次の呼び出しがそのまま使う)。
 */
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | typeof ABORTED> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

/**
 * Verify Turnstile token via Cloudflare Workers backend
 * Implements exponential backoff retry for network errors
 */
export async function verifyTurnstileToken(token: string): Promise<VerificationResult> {
  return verifyTokenWithRetry(token, retryStatusCallback);
}

/**
 * `verifyTurnstileToken` の本体。リトライ状況の通知先は呼び出し側が捕まえたものを使う
 * (`performTurnstileVerification` が開始時に捕まえた値。#375)。
 */
async function verifyTokenWithRetry(
  token: string,
  onRetryStatus: RetryStatusCallback | null
): Promise<VerificationResult> {
  if (!API_URL) {
    console.warn('[Turnstile] API URL not configured');
    return { success: false, error: 'API not configured', failureReason: 'network_error' };
  }

  let lastError: Error | null = null;
  let lastResponse: Response | null = null;

  for (let attempt = 1; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    try {
      const response = await fetch(`${API_URL}/api/verify-captcha`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token }),
        // 無応答でも固まらないよう上限を付ける。AbortError/TimeoutError は catch でリトライ対象になる (#324)
        signal: AbortSignal.timeout(WORKERS_FETCH_TIMEOUT_MS),
      });

      lastResponse = response;

      if (response.ok) {
        const result = (await response.json()) as VerificationResult;
        console.log('[Turnstile] Verification result:', result);
        // Notify success (no more retrying)
        onRetryStatus?.({
          attempt,
          maxRetries: RETRY_CONFIG.maxRetries,
          nextDelayMs: 0,
          isRetrying: false,
        });
        return result;
      }

      // Check if we should retry
      if (!isNetworkError(response, null)) {
        // Bot detection or other non-retryable error
        const errorText = await response.text();
        console.error('[Turnstile] Verification failed (non-retryable):', response.status, errorText);
        onRetryStatus?.({
          attempt,
          maxRetries: RETRY_CONFIG.maxRetries,
          nextDelayMs: 0,
          isRetrying: false,
        });
        return {
          success: false,
          error: `HTTP ${response.status}`,
          failureReason: response.status === 403 || response.status === 429 ? 'challenge_failed' : 'network_error',
        };
      }

      // Network error - will retry if attempts remain
      console.warn(`[Turnstile] Attempt ${attempt}/${RETRY_CONFIG.maxRetries} failed with status ${response.status}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      lastResponse = null;
      console.warn(`[Turnstile] Attempt ${attempt}/${RETRY_CONFIG.maxRetries} failed:`, lastError.message);
    }

    // Retry with exponential backoff if attempts remain
    if (attempt < RETRY_CONFIG.maxRetries) {
      const delayMs = RETRY_CONFIG.initialDelayMs * 2 ** (attempt - 1);
      console.log(`[Turnstile] Retrying in ${delayMs}ms...`);

      // Notify about retry
      onRetryStatus?.({
        attempt,
        maxRetries: RETRY_CONFIG.maxRetries,
        nextDelayMs: delayMs,
        isRetrying: true,
      });

      await sleep(delayMs);
    }
  }

  // All retries exhausted
  console.error('[Turnstile] All retry attempts exhausted');
  onRetryStatus?.({
    attempt: RETRY_CONFIG.maxRetries,
    maxRetries: RETRY_CONFIG.maxRetries,
    nextDelayMs: 0,
    isRetrying: false,
  });

  return {
    success: false,
    error: lastError?.message ?? `HTTP ${lastResponse?.status ?? 'unknown'}`,
    failureReason: 'network_error',
  };
}

/** Options for performTurnstileVerification */
export interface TurnstileVerificationOptions {
  /** Custom widget container element */
  widgetContainer?: HTMLElement;
  /** Custom parent container to show/hide (optional) */
  parentContainer?: HTMLElement;
  /**
   * 指定すると Phase 3 (verify) で `/api/verify-captcha` の代わりに `/api/session/start` を呼び、
   * serverNonce 入りの ECDSA 署名トークンを取得する (ADR-0017)。Turnstile ゲートと root アンカーと
   * 人間ゲートを 1 リクエストで兼ねる。casual/class の作成フローで使う。
   */
  sessionStart?: { sessionId: string; fingerprintHash: string };
  /**
   * 中断の合図 (#375)。token を得るまで (Phase 1 のスクリプト読込・Phase 2 のチャレンジとリトライの待ち)
   * に abort されたら、表示中の widget を片付けて `{ success: false, failureReason: 'timeout',
   * error: 'aborted' }` を即座に返す。token を得た後 (Phase 3 の session/start / verify-captcha) の
   * abort では fetch を止めず (fetch 自体の上限 `WORKERS_FETCH_TIMEOUT_MS` だけ)、その結果を返す。
   * タブ作成の予算切れの後に届いた token を署名専用に回すため。
   */
  signal?: AbortSignal;
}

/**
 * Turnstile トークンを `/api/session/start` に送り、ECDSA 署名トークンを取得する (ADR-0017)。
 * single attempt: 失敗時は呼び出し側が degraded fallback (root 未アンカー) する (ADR-0017 (b))。
 */
async function requestSessionStart(
  turnstileToken: string,
  input: { sessionId: string; fingerprintHash: string }
): Promise<VerificationResult> {
  if (!API_URL) {
    return { success: false, error: 'API not configured', failureReason: 'network_error' };
  }
  try {
    const response = await fetch(`${API_URL}/api/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        turnstileToken,
        sessionId: input.sessionId,
        fingerprintHash: input.fingerprintHash,
      }),
      // 無応答でもタブ作成が固まらないよう上限を付ける。タイムアウトは catch で network_error になり、
      // 呼び出し側の degraded fallback (root 未アンカー) に合流する (#324)
      signal: AbortSignal.timeout(WORKERS_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status}`,
        failureReason: response.status === 403 || response.status === 429 ? 'challenge_failed' : 'network_error',
      };
    }
    const data = (await response.json()) as { success?: boolean; token?: SessionStartToken };
    if (!data?.success || !data.token) {
      return { success: false, error: 'session/start did not return a token', failureReason: 'network_error' };
    }
    return {
      success: true,
      score: 1.0,
      action: data.token.payload.action ?? undefined,
      sessionToken: data.token,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      failureReason: 'network_error',
    };
  }
}

/**
 * Perform full Turnstile verification flow with retry logic
 * Retries on network errors for both challenge and verification phases
 * @param action The action name for Turnstile (e.g., 'create_tab', 'export_proof')
 * @param options Optional configuration for custom containers
 * @returns Verification result
 */
export async function performTurnstileVerification(
  action: string,
  options?: TurnstileVerificationOptions
): Promise<VerificationResult> {
  // 通知先は開始時に捕まえる (#375)。予算切れで呼び出し側が手放した後も裏で走り続ける実行が、
  // 次のタブ作成が登録した UI のコールバックへ書き込まないようにする。
  const onPhase = phaseCallback;
  const onRetryStatus = retryStatusCallback;
  const signal = options?.signal;

  // If Turnstile is not configured, allow the action (development mode)
  if (!isTurnstileConfigured()) {
    console.log('[Turnstile] Not configured, allowing action');
    // Mark all phases as done immediately
    onPhase?.('prepare', 'done');
    onPhase?.('challenge', 'done');
    onPhase?.('verify', 'done');
    return { success: true, score: 1.0, action };
  }

  // token を得る前に中断されたときの結果 (#375)。呼び出し側は既に UI を閉じているので、フェーズは通知しない。
  const aborted = (): VerificationResult => {
    console.warn('[Turnstile] Verification aborted before a token was acquired');
    return { success: false, error: 'aborted', failureReason: 'timeout' };
  };

  // Phase 1: Prepare - Load Turnstile script (with retry)
  onPhase?.('prepare', 'active');
  let scriptLoaded = false;
  for (let attempt = 1; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    if (signal?.aborted) return aborted();
    try {
      if ((await untilAborted(loadTurnstileScript(), signal)) === ABORTED) return aborted();
      scriptLoaded = true;
      break;
    } catch {
      console.warn(`[Turnstile] Script load attempt ${attempt}/${RETRY_CONFIG.maxRetries} failed`);
      if (attempt < RETRY_CONFIG.maxRetries) {
        const delayMs = RETRY_CONFIG.initialDelayMs * 2 ** (attempt - 1);
        onRetryStatus?.({
          attempt,
          maxRetries: RETRY_CONFIG.maxRetries,
          nextDelayMs: delayMs,
          isRetrying: true,
        });
        await sleep(delayMs, signal);
      }
    }
  }

  if (signal?.aborted && !scriptLoaded) return aborted();
  if (!scriptLoaded) {
    onPhase?.('prepare', 'error');
    onRetryStatus?.({
      attempt: RETRY_CONFIG.maxRetries,
      maxRetries: RETRY_CONFIG.maxRetries,
      nextDelayMs: 0,
      isRetrying: false,
    });
    return {
      success: false,
      error: 'Failed to load Turnstile script',
      failureReason: 'network_error',
    };
  }
  onPhase?.('prepare', 'done');
  // Clear retry status after successful prepare
  onRetryStatus?.({
    attempt: 1,
    maxRetries: RETRY_CONFIG.maxRetries,
    nextDelayMs: 0,
    isRetrying: false,
  });

  // Phase 2: Challenge - Get token from Turnstile widget (with retry)
  onPhase?.('challenge', 'active');
  let tokenResult: TokenResult | null = null;
  for (let attempt = 1; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    if (signal?.aborted) return aborted();
    tokenResult = await getTurnstileToken(action, options);

    // Success - got a token (中断されていても、得た token は Phase 3 に進める)
    if (tokenResult.token) {
      break;
    }

    if (signal?.aborted) return aborted();

    // Non-retryable error (e.g., bot detection)
    if (!tokenResult.isNetworkError) {
      console.error('[Turnstile] Challenge failed (non-retryable):', tokenResult.failureReason);
      break;
    }

    // Network error - retry if attempts remain
    console.warn(`[Turnstile] Challenge attempt ${attempt}/${RETRY_CONFIG.maxRetries} failed (network error)`);
    if (attempt < RETRY_CONFIG.maxRetries) {
      const delayMs = RETRY_CONFIG.initialDelayMs * 2 ** (attempt - 1);
      onRetryStatus?.({
        attempt,
        maxRetries: RETRY_CONFIG.maxRetries,
        nextDelayMs: delayMs,
        isRetrying: true,
      });
      await sleep(delayMs, signal);
    }
  }

  if (signal?.aborted && !tokenResult?.token) return aborted();
  if (!tokenResult?.token) {
    onPhase?.('challenge', 'error');
    onRetryStatus?.({
      attempt: RETRY_CONFIG.maxRetries,
      maxRetries: RETRY_CONFIG.maxRetries,
      nextDelayMs: 0,
      isRetrying: false,
    });
    return {
      success: false,
      error: 'Failed to acquire Turnstile token',
      failureReason: tokenResult?.failureReason ?? 'network_error',
    };
  }
  onPhase?.('challenge', 'done');
  // Clear retry status after successful challenge
  onRetryStatus?.({
    attempt: 1,
    maxRetries: RETRY_CONFIG.maxRetries,
    nextDelayMs: 0,
    isRetrying: false,
  });

  // Phase 3: Verify - Verify token via backend (already has retry logic inside)
  // ADR-0017: sessionStart 指定時は session/start を呼び ECDSA トークンを取得する (root アンカー)。
  // #375: ここからは中断しても止めない (signal を渡さない)。予算切れの後に届いた token は、
  // 呼び出し側が root に焼かず署名専用 token に回す。
  onPhase?.('verify', 'active');
  const result = options?.sessionStart
    ? await requestSessionStart(tokenResult.token, options.sessionStart)
    : await verifyTokenWithRetry(tokenResult.token, onRetryStatus);
  onPhase?.('verify', result.success ? 'done' : 'error');

  return result;
}
