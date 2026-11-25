/**
 * editor の配信ヘッダ (COOP / COEP / CSP) の正本 (#411)。
 *
 * 本番 (Cloudflare Pages) の `_headers` は、ビルド時に `vite.config.ts` のプラグインがこのモジュールから
 * 生成して dist の直下に出す。`vite preview` のヘッダも同じ値を使う (e2e の `production-build.spec.ts` が
 * 両者の一致と、CSP の下で動くことを見る)。API の origin はビルドごとに違う (`VITE_API_URL`。preview・staging・
 * 本番で別) ので、静的な `public/_headers` には書けない。
 *
 * deploy では verify の dist が editor の dist の `verify/` に同居し、Pages は直下の `_headers` しか読まないので、
 * この CSP は `/verify/*` にも掛かる (verify も同じ CSP の下で動かす。#411 のメンテナ決定)。
 *
 * CSP の許可は、アプリ自身が使う配信元だけにする (#411 のメンテナ決定。学校の外部教材は許可しない)。
 * - **`script-src` の `'unsafe-inline'` と `'unsafe-eval'` は、今の構成では外せない** (#411 の実測)。
 *   srcdoc の iframe は親の CSP を継承するので、JS / Python の runner (ADR-0041 / ADR-0056) の inline script と、
 *   HTML プレビューの学習者の script が `'unsafe-inline'` を要る。JS の runner の Worker の `AsyncFunction` と、
 *   Wasmer の worker (同じ origin の URL の worker なので、この CSP を自分の応答で受ける) の `new Function` が
 *   `'unsafe-eval'` を要る。外すのは #897 (runner と HTML プレビューを専用のページで配信する)
 * - `'wasm-unsafe-eval'`: Wasmer と Pyodide が WebAssembly をコンパイルする
 * - `blob:`: runner の Blob の Worker (script-src / worker-src) と、スクリーンショットの表示 (img-src)
 * - `data:` (img-src): Monaco の波線の SVG と xterm
 * - `style-src 'unsafe-inline'`: index.html の inline の `<style>`、Monaco・xterm・verify の style 属性
 * - Pyodide の取得元と PyPI: Python の runner (srcdoc) の Worker が継承する。runner 自身の CSP
 *   (`pythonRunnerDocument.ts`) と同じ定数から作る
 * - Cloudflare Web Analytics: Pages が配信のときに beacon を差し込む (#655)
 *
 * 許可を足す・外すときは、ここと `deliveryHeaders.test.ts` を同じ変更で直す。
 */

import { PYODIDE_CDN_URL, PYPI_ORIGINS } from '../executors/python/pythonRunnerProtocol.js';

/** Turnstile の配信元 (script と iframe)。`TurnstileService.ts` の script の URL もここから作る */
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

/** clang の webc の配信元 (Cloudflare R2)。`CExecutor.ts` の URL もここから作る */
export const CLANG_ASSETS_ORIGIN = 'https://assets.typedcode.dev';

/** Font Awesome の stylesheet と webfont の配信元 (`index.html` / `author.html` の `<link>`) */
export const FONT_AWESOME_ORIGIN = 'https://cdnjs.cloudflare.com';

/** Cloudflare Web Analytics の beacon の script と、その送信先 */
export const WEB_ANALYTICS_SCRIPT_ORIGIN = 'https://static.cloudflareinsights.com';
export const WEB_ANALYTICS_CONNECT_ORIGIN = 'https://cloudflareinsights.com';

/** CSP の directive (順序は出力の順序) */
export type CspDirectives = ReadonlyArray<readonly [directive: string, sources: readonly string[]]>;

/**
 * `VITE_API_URL` から API の origin を取る。未設定 (空) なら null (Workers を使わないビルド)。
 * URL として読めない値はビルドを止める (connect-src を黙って欠いた配信物を出さない)。
 */
export function apiOriginOf(apiUrl: string | undefined): string | null {
  const value = apiUrl?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`[delivery-headers] VITE_API_URL is not a valid URL: ${value}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`[delivery-headers] VITE_API_URL must be http(s): ${value}`);
  }
  return url.origin;
}

/** editor の CSP の directive。`apiUrl` は `VITE_API_URL` */
export function contentSecurityPolicyDirectives(apiUrl: string | undefined): CspDirectives {
  const apiOrigin = apiOriginOf(apiUrl);
  return [
    ['default-src', ["'self'"]],
    [
      'script-src',
      [
        "'self'",
        // 外すのは #897 (この理由はモジュールの doc)
        "'unsafe-inline'",
        "'unsafe-eval'",
        "'wasm-unsafe-eval'",
        'blob:',
        TURNSTILE_ORIGIN,
        PYODIDE_CDN_URL,
        WEB_ANALYTICS_SCRIPT_ORIGIN,
      ],
    ],
    ['style-src', ["'self'", "'unsafe-inline'", FONT_AWESOME_ORIGIN]],
    ['font-src', ["'self'", FONT_AWESOME_ORIGIN]],
    ['img-src', ["'self'", 'data:', 'blob:']],
    [
      'connect-src',
      [
        "'self'",
        ...(apiOrigin ? [apiOrigin] : []),
        CLANG_ASSETS_ORIGIN,
        PYODIDE_CDN_URL,
        ...PYPI_ORIGINS,
        WEB_ANALYTICS_CONNECT_ORIGIN,
      ],
    ],
    ['frame-src', [TURNSTILE_ORIGIN]],
    ['worker-src', ["'self'", 'blob:']],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['frame-ancestors', ["'self'"]],
  ];
}

/** directive を CSP のヘッダ値にする */
export function serializeCsp(directives: CspDirectives): string {
  return directives.map(([name, sources]) => [name, ...sources].join(' ')).join('; ');
}

/**
 * cross-origin isolation のヘッダ。Wasmer と Python の SharedArrayBuffer のため (ADR-0041 / ADR-0056)。
 * dev サーバ (`server.headers`) も同じものを付ける
 */
export const CROSS_ORIGIN_ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
} as const;

/** 配信のヘッダ (名前 → 値) */
export type DeliveryHeaders = {
  'Cross-Origin-Opener-Policy': string;
  'Cross-Origin-Embedder-Policy': string;
  'Content-Security-Policy': string;
};

/** 配信のヘッダ。`vite preview` の `preview.headers` と、生成する `_headers` の `/*` の両方がこれを使う */
export function deliveryHeaders(apiUrl: string | undefined): DeliveryHeaders {
  return {
    ...CROSS_ORIGIN_ISOLATION_HEADERS,
    'Content-Security-Policy': serializeCsp(contentSecurityPolicyDirectives(apiUrl)),
  };
}

/** Cloudflare Pages の `_headers` の本文 (全パス `/*` に同じヘッダ) */
export function renderHeadersFile(headers: Readonly<Record<string, string>>): string {
  const lines = Object.entries(headers).map(([name, value]) => `  ${name}: ${value}`);
  return `/*\n${lines.join('\n')}\n`;
}

/**
 * `_headers` の本文から、パスごとのヘッダを読む (`renderHeadersFile` の逆。e2e が dist の生成物を読むのに使う)。
 * 同じパスの同じ名前は後勝ちにせず、重複として投げる (Pages は重ねて送るので、2 つの CSP が両方効いてしまう)
 */
export function parseHeadersFile(text: string): Map<string, Record<string, string>> {
  const rules = new Map<string, Record<string, string>>();
  let current: Record<string, string> | null = null;
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      current = {};
      rules.set(raw.trim(), current);
      continue;
    }
    if (!current) throw new Error(`[delivery-headers] header line before any path: ${raw}`);
    const colon = raw.indexOf(':');
    if (colon < 0) throw new Error(`[delivery-headers] malformed header line: ${raw}`);
    const name = raw.slice(0, colon).trim();
    if (Object.hasOwn(current, name)) throw new Error(`[delivery-headers] duplicate header: ${name}`);
    current[name] = raw.slice(colon + 1).trim();
  }
  return rules;
}

/** CSP のヘッダ値を directive ごとの source の配列に分ける */
export function parseCsp(value: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of value.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out.set(name.toLowerCase(), sources);
  }
  return out;
}
