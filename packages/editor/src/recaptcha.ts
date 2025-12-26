/**
 * reCAPTCHA v3 integration module
 * Handles token acquisition and verification via Cloudflare Workers backend
 */

declare global {
  interface Window {
    grecaptcha: {
      ready: (callback: () => void) => void;
      execute: (siteKey: string, options: { action: string }) => Promise<string>;
    };
  }
}

// Environment variables (set via Vite)
const RECAPTCHA_SITE_KEY = import.meta.env.VITE_RECAPTCHA_SITE_KEY as string;
const API_URL = import.meta.env.VITE_API_URL as string;

// reCAPTCHA script loading state
let scriptLoaded = false;
let scriptLoading = false;
let loadPromise: Promise<void> | null = null;

/**
 * Check if reCAPTCHA is configured
 */
export function isRecaptchaConfigured(): boolean {
  return Boolean(RECAPTCHA_SITE_KEY && API_URL);
}

/**
 * Load reCAPTCHA v3 script dynamically
 */
export function loadRecaptchaScript(): Promise<void> {
  if (scriptLoaded) {
    return Promise.resolve();
  }

  if (scriptLoading && loadPromise) {
    return loadPromise;
  }

  if (!RECAPTCHA_SITE_KEY) {
    console.warn('[reCAPTCHA] Site key not configured, skipping reCAPTCHA');
    return Promise.resolve();
  }

  scriptLoading = true;

  loadPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://www.google.com/recaptcha/api.js?render=${RECAPTCHA_SITE_KEY}`;
    script.async = true;
    script.defer = true;

    script.onload = () => {
      scriptLoaded = true;
      scriptLoading = false;
      console.log('[reCAPTCHA] Script loaded successfully');
      resolve();
    };

    script.onerror = () => {
      scriptLoading = false;
      loadPromise = null;
      console.error('[reCAPTCHA] Failed to load script');
      reject(new Error('Failed to load reCAPTCHA script'));
    };

    document.head.appendChild(script);
  });

  return loadPromise;
}

/**
 * Get reCAPTCHA token for the specified action
 */
export async function getRecaptchaToken(action: string): Promise<string | null> {
  if (!RECAPTCHA_SITE_KEY) {
    console.warn('[reCAPTCHA] Site key not configured');
    return null;
  }

  try {
    await loadRecaptchaScript();

    return new Promise((resolve, reject) => {
      window.grecaptcha.ready(async () => {
        try {
          const token = await window.grecaptcha.execute(RECAPTCHA_SITE_KEY, { action });
          console.log('[reCAPTCHA] Token acquired for action:', action);
          resolve(token);
        } catch (error) {
          console.error('[reCAPTCHA] Token execution failed:', error);
          reject(error);
        }
      });
    });
  } catch (error) {
    console.error('[reCAPTCHA] Failed to get token:', error);
    return null;
  }
}

/**
 * 署名付き人間証明書（サーバーが発行、改竄不可）
 */
export interface HumanAttestation {
  verified: boolean;
  score: number;
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
 * Verify reCAPTCHA token via Cloudflare Workers backend
 */
export async function verifyRecaptchaToken(token: string): Promise<VerificationResult> {
  if (!API_URL) {
    console.warn('[reCAPTCHA] API URL not configured');
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
      console.error('[reCAPTCHA] Verification failed:', response.status, errorText);
      return { success: false, error: `HTTP ${response.status}` };
    }

    const result = await response.json() as VerificationResult;
    console.log('[reCAPTCHA] Verification result:', result);
    return result;
  } catch (error) {
    console.error('[reCAPTCHA] Verification request failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Perform full reCAPTCHA verification flow
 * @param action The action name for reCAPTCHA (e.g., 'export_proof')
 * @returns Verification result
 */
export async function performRecaptchaVerification(action: string): Promise<VerificationResult> {
  // If reCAPTCHA is not configured, allow the action (development mode)
  if (!isRecaptchaConfigured()) {
    console.log('[reCAPTCHA] Not configured, allowing action');
    return { success: true, score: 1.0, action };
  }

  // Get token from reCAPTCHA
  const token = await getRecaptchaToken(action);
  if (!token) {
    return { success: false, error: 'Failed to acquire reCAPTCHA token' };
  }

  // Verify token via backend
  return verifyRecaptchaToken(token);
}
