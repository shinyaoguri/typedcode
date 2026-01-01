/**
 * Cloudflare Turnstile integration module
 * Handles token acquisition and verification via Cloudflare Workers backend
 */

import { t } from '../i18n/index.js';

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

  return new Promise((resolve) => {
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
        appearance: 'always',  // Always show the official Cloudflare widget
        callback: (token) => {
          if (!resolved) {
            resolved = true;
            if (timeoutId) clearTimeout(timeoutId);
            console.log('[Turnstile] Token acquired for action:', action);
            // Wait a moment so user can see the success checkmark
            setTimeout(() => {
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
 * Signed human attestation certificate (issued by server, tamper-proof)
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
export type VerificationFailureReason =
  | 'challenge_failed'
  | 'timeout'
  | 'network_error'
  | 'token_acquisition_failed';

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
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Verify Turnstile token via Cloudflare Workers backend
 * Implements exponential backoff retry for network errors
 */
export async function verifyTurnstileToken(token: string): Promise<VerificationResult> {
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
      });

      lastResponse = response;

      if (response.ok) {
        const result = await response.json() as VerificationResult;
        console.log('[Turnstile] Verification result:', result);
        // Notify success (no more retrying)
        retryStatusCallback?.({
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
        retryStatusCallback?.({
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
      const delayMs = RETRY_CONFIG.initialDelayMs * Math.pow(2, attempt - 1);
      console.log(`[Turnstile] Retrying in ${delayMs}ms...`);

      // Notify about retry
      retryStatusCallback?.({
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
  retryStatusCallback?.({
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
}

/**
 * Perform full Turnstile verification flow with retry logic
 * Retries on network errors for both challenge and verification phases
 * @param action The action name for Turnstile (e.g., 'create_tab', 'export_proof')
 * @param options Optional configuration for custom containers
 * @returns Verification result
 */
export async function performTurnstileVerification(action: string, options?: TurnstileVerificationOptions): Promise<VerificationResult> {
  // If Turnstile is not configured, allow the action (development mode)
  if (!isTurnstileConfigured()) {
    console.log('[Turnstile] Not configured, allowing action');
    // Mark all phases as done immediately
    phaseCallback?.('prepare', 'done');
    phaseCallback?.('challenge', 'done');
    phaseCallback?.('verify', 'done');
    return { success: true, score: 1.0, action };
  }

  // Phase 1: Prepare - Load Turnstile script (with retry)
  phaseCallback?.('prepare', 'active');
  let scriptLoaded = false;
  for (let attempt = 1; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    try {
      await loadTurnstileScript();
      scriptLoaded = true;
      break;
    } catch (error) {
      console.warn(`[Turnstile] Script load attempt ${attempt}/${RETRY_CONFIG.maxRetries} failed`);
      if (attempt < RETRY_CONFIG.maxRetries) {
        const delayMs = RETRY_CONFIG.initialDelayMs * Math.pow(2, attempt - 1);
        retryStatusCallback?.({
          attempt,
          maxRetries: RETRY_CONFIG.maxRetries,
          nextDelayMs: delayMs,
          isRetrying: true,
        });
        await sleep(delayMs);
      }
    }
  }

  if (!scriptLoaded) {
    phaseCallback?.('prepare', 'error');
    retryStatusCallback?.({
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
  phaseCallback?.('prepare', 'done');
  // Clear retry status after successful prepare
  retryStatusCallback?.({
    attempt: 1,
    maxRetries: RETRY_CONFIG.maxRetries,
    nextDelayMs: 0,
    isRetrying: false,
  });

  // Phase 2: Challenge - Get token from Turnstile widget (with retry)
  phaseCallback?.('challenge', 'active');
  let tokenResult: TokenResult | null = null;
  for (let attempt = 1; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    tokenResult = await getTurnstileToken(action, options);

    // Success - got a token
    if (tokenResult.token) {
      break;
    }

    // Non-retryable error (e.g., bot detection)
    if (!tokenResult.isNetworkError) {
      console.error('[Turnstile] Challenge failed (non-retryable):', tokenResult.failureReason);
      break;
    }

    // Network error - retry if attempts remain
    console.warn(`[Turnstile] Challenge attempt ${attempt}/${RETRY_CONFIG.maxRetries} failed (network error)`);
    if (attempt < RETRY_CONFIG.maxRetries) {
      const delayMs = RETRY_CONFIG.initialDelayMs * Math.pow(2, attempt - 1);
      retryStatusCallback?.({
        attempt,
        maxRetries: RETRY_CONFIG.maxRetries,
        nextDelayMs: delayMs,
        isRetrying: true,
      });
      await sleep(delayMs);
    }
  }

  if (!tokenResult?.token) {
    phaseCallback?.('challenge', 'error');
    retryStatusCallback?.({
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
  phaseCallback?.('challenge', 'done');
  // Clear retry status after successful challenge
  retryStatusCallback?.({
    attempt: 1,
    maxRetries: RETRY_CONFIG.maxRetries,
    nextDelayMs: 0,
    isRetrying: false,
  });

  // Phase 3: Verify - Verify token via backend (already has retry logic inside)
  phaseCallback?.('verify', 'active');
  const result = await verifyTurnstileToken(tokenResult.token);
  phaseCallback?.('verify', result.success ? 'done' : 'error');

  return result;
}
