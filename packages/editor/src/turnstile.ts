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

/**
 * Load Turnstile script dynamically
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

    script.onload = () => {
      scriptLoaded = true;
      scriptLoading = false;
      console.log('[Turnstile] Script loaded successfully');
      resolve();
    };

    script.onerror = () => {
      scriptLoading = false;
      loadPromise = null;
      console.error('[Turnstile] Failed to load script');
      reject(new Error('Failed to load Turnstile script'));
    };

    document.head.appendChild(script);
  });

  return loadPromise;
}

/**
 * Get Turnstile token for the specified action using invisible mode
 */
export async function getTurnstileToken(action: string): Promise<string | null> {
  if (!TURNSTILE_SITE_KEY) {
    console.warn('[Turnstile] Site key not configured');
    return null;
  }

  try {
    await loadTurnstileScript();

    return new Promise((resolve) => {
      // Create a hidden container for the widget
      // The widget will be visually hidden but still functional
      const container = document.createElement('div');
      container.style.position = 'fixed';
      container.style.top = '-9999px';
      container.style.left = '-9999px';
      container.style.visibility = 'hidden';
      document.body.appendChild(container);

      const widgetId = window.turnstile.render(container, {
        sitekey: TURNSTILE_SITE_KEY,
        size: 'compact',
        action,
        appearance: 'execute',  // Only show when interaction needed
        callback: (token) => {
          window.turnstile.remove(widgetId);
          container.remove();
          console.log('[Turnstile] Token acquired for action:', action);
          resolve(token);
        },
        'error-callback': () => {
          window.turnstile.remove(widgetId);
          container.remove();
          console.error('[Turnstile] Challenge failed');
          resolve(null);
        },
      });
    });
  } catch (error) {
    console.error('[Turnstile] Failed to get token:', error);
    return null;
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
 * Verification result from the backend
 */
export interface VerificationResult {
  success: boolean;
  score?: number;
  action?: string;
  error?: string;
  attestation?: HumanAttestation;
}

/**
 * Verify Turnstile token via Cloudflare Workers backend
 */
export async function verifyTurnstileToken(token: string): Promise<VerificationResult> {
  if (!API_URL) {
    console.warn('[Turnstile] API URL not configured');
    return { success: false, error: 'API not configured' };
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
      return { success: false, error: `HTTP ${response.status}` };
    }

    const result = await response.json() as VerificationResult;
    console.log('[Turnstile] Verification result:', result);
    return result;
  } catch (error) {
    console.error('[Turnstile] Verification request failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
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
  const token = await getTurnstileToken(action);
  if (!token) {
    return { success: false, error: 'Failed to acquire Turnstile token' };
  }

  // Verify token via backend
  return verifyTurnstileToken(token);
}
