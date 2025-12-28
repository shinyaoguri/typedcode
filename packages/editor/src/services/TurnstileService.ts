/**
 * Cloudflare Turnstile integration module
 * Handles token acquisition and verification via Cloudflare Workers backend
 */

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

/** Timeout for Turnstile challenge (20 seconds total) */
const TURNSTILE_TIMEOUT_MS = 20000;

/** Result from getTurnstileToken including failure reason */
interface TokenResult {
  token: string | null;
  failureReason?: VerificationFailureReason;
}

/**
 * Get Turnstile token for the specified action
 * Shows challenge UI centered on screen when interaction is needed
 */
export async function getTurnstileToken(action: string): Promise<TokenResult> {
  if (!TURNSTILE_SITE_KEY) {
    console.warn('[Turnstile] Site key not configured');
    return { token: null, failureReason: 'token_acquisition_failed' };
  }

  try {
    await loadTurnstileScript();

    return new Promise((resolve) => {
      // Create container centered on screen for challenge visibility
      const container = document.createElement('div');
      container.id = 'turnstile-container';
      container.style.position = 'fixed';
      container.style.top = '50%';
      container.style.left = '50%';
      container.style.transform = 'translate(-50%, -50%)';
      container.style.zIndex = '10001';
      container.style.background = 'var(--bg-secondary, #1e1e1e)';
      container.style.padding = '24px';
      container.style.borderRadius = '8px';
      container.style.boxShadow = '0 4px 20px rgba(0, 0, 0, 0.5)';
      // Initially hidden until challenge is needed
      container.style.opacity = '0';
      container.style.pointerEvents = 'none';
      container.style.transition = 'opacity 0.2s ease';
      document.body.appendChild(container);

      // Add title element
      const title = document.createElement('div');
      title.textContent = '人間認証';
      title.style.textAlign = 'center';
      title.style.marginBottom = '16px';
      title.style.fontSize = '14px';
      title.style.color = 'var(--text-primary, #ffffff)';
      container.appendChild(title);

      // Widget container
      const widgetContainer = document.createElement('div');
      container.appendChild(widgetContainer);

      let resolved = false;

      // Timeout handler
      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          window.turnstile.remove(widgetId);
          container.remove();
          console.warn('[Turnstile] Challenge timed out after', TURNSTILE_TIMEOUT_MS, 'ms');
          resolve({ token: null, failureReason: 'timeout' });
        }
      }, TURNSTILE_TIMEOUT_MS);

      const widgetId = window.turnstile.render(widgetContainer, {
        sitekey: TURNSTILE_SITE_KEY,
        size: 'normal',
        action,
        theme: 'dark',
        appearance: 'interaction-only',  // Show only when interaction needed
        callback: (token) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutId);
            window.turnstile.remove(widgetId);
            container.remove();
            console.log('[Turnstile] Token acquired for action:', action);
            resolve({ token });
          }
        },
        'error-callback': () => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutId);
            window.turnstile.remove(widgetId);
            container.remove();
            console.error('[Turnstile] Challenge failed');
            resolve({ token: null, failureReason: 'challenge_failed' });
          }
        },
      });

      // Show container when widget needs interaction
      // Use MutationObserver to detect when iframe appears
      const observer = new MutationObserver(() => {
        const iframe = widgetContainer.querySelector('iframe');
        if (iframe) {
          // Widget is rendering, show the container
          container.style.opacity = '1';
          container.style.pointerEvents = 'auto';
          observer.disconnect();
        }
      });
      observer.observe(widgetContainer, { childList: true, subtree: true });

      // Auto-hide after short delay if no iframe appears (auto-pass case)
      setTimeout(() => {
        observer.disconnect();
      }, 2000);
    });
  } catch (error) {
    console.error('[Turnstile] Failed to get token:', error);
    return { token: null, failureReason: 'token_acquisition_failed' };
  }
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

/**
 * Verify Turnstile token via Cloudflare Workers backend
 */
export async function verifyTurnstileToken(token: string): Promise<VerificationResult> {
  if (!API_URL) {
    console.warn('[Turnstile] API URL not configured');
    return { success: false, error: 'API not configured', failureReason: 'network_error' };
  }

  try {
    const response = await fetch(`${API_URL}/api/verify-captcha`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Turnstile] Verification failed:', response.status, errorText);
      return { success: false, error: `HTTP ${response.status}`, failureReason: 'network_error' };
    }

    const result = await response.json() as VerificationResult;
    console.log('[Turnstile] Verification result:', result);
    return result;
  } catch (error) {
    console.error('[Turnstile] Verification request failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      failureReason: 'network_error',
    };
  }
}

/**
 * Perform full Turnstile verification flow
 * @param action The action name for Turnstile (e.g., 'create_tab', 'export_proof')
 * @returns Verification result
 */
export async function performTurnstileVerification(action: string): Promise<VerificationResult> {
  // If Turnstile is not configured, allow the action (development mode)
  if (!isTurnstileConfigured()) {
    console.log('[Turnstile] Not configured, allowing action');
    return { success: true, score: 1.0, action };
  }

  // Get token from Turnstile
  const tokenResult = await getTurnstileToken(action);
  if (!tokenResult.token) {
    return {
      success: false,
      error: 'Failed to acquire Turnstile token',
      failureReason: tokenResult.failureReason,
    };
  }

  // Verify token via backend
  return verifyTurnstileToken(tokenResult.token);
}
