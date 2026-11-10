#!/usr/bin/env node
/** #579: Pages の隔離ヘッダ・Worker の署名 readiness・実 Origin の CORS をデプロイ直後に検査する。 */
import { pathToFileURL } from 'node:url';

export async function checkDeployment({ pagesUrl, apiUrl, origins }, fetchImpl = fetch) {
  const pages = new URL(pagesUrl);
  const api = new URL(apiUrl);
  if (!['http:', 'https:'].includes(pages.protocol) || !['http:', 'https:'].includes(api.protocol)) {
    throw new Error('Pages/API URLs must use HTTP(S)');
  }
  if (!origins?.length || origins.some((origin) => new URL(origin).origin !== origin)) {
    throw new Error('At least one exact Origin is required');
  }
  const request = async (url, init = {}) => {
    const response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`${new URL(url).pathname}: HTTP ${response.status}`);
    return response;
  };
  for (const path of ['/', '/verify/']) {
    const res = await request(new URL(path, pages));
    if (res.headers.get('Cross-Origin-Opener-Policy') !== 'same-origin') {
      throw new Error(`${path}: missing/invalid COOP`);
    }
    if (!['credentialless', 'require-corp'].includes(res.headers.get('Cross-Origin-Embedder-Policy'))) {
      throw new Error(`${path}: missing/invalid COEP`);
    }
  }
  const health = await (await request(new URL('/health', api))).json();
  if (health?.status !== 'ok' || health?.signing?.ok !== true) throw new Error('/health: signing is not ready');
  for (const origin of origins) {
    const res = await request(new URL('/api/checkpoint/sign', api), {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type',
      },
    });
    if (res.headers.get('Access-Control-Allow-Origin') !== origin) throw new Error('CORS: Origin not allowed');
    const methods = (res.headers.get('Access-Control-Allow-Methods') ?? '')
      .split(',')
      .map((s) => s.trim().toUpperCase());
    const headers = (res.headers.get('Access-Control-Allow-Headers') ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase());
    if (!methods.includes('POST') || !headers.includes('content-type'))
      throw new Error('CORS: POST/Content-Type not allowed');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await checkDeployment({
      pagesUrl: process.env.PAGES_URL,
      apiUrl: process.env.API_URL,
      origins: (process.env.CHECK_ORIGINS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    });
    console.log('Post-deploy checks passed (Pages headers, signing health, CORS)');
  } catch (error) {
    console.error(`Post-deploy checks failed: ${error.message}`);
    process.exitCode = 1;
  }
}
