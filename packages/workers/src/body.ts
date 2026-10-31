/**
 * リクエスト本文 (JSON) の上限付き読み取り (#285)。
 *
 * `request.json()` / `request.text()` は本文を**全部**バッファしてから返るため、上限の検査が
 * 読み切った後になる (巨大 body を受け取ってからメモリを払う)。ここでは読み込み中に累積バイト数
 * を数え、上限を超えた時点でストリームを cancel して打ち切る。Content-Length は信用しない
 * (欠落・詐称・chunked でも実バイトで強制する) が、宣言値が上限超なら 1 バイトも読まずに弾く。
 *
 * 全 POST ハンドラ (verify-captcha / verify-attestation / session/start / checkpoint/sign) が
 * Turnstile fetch・署名・KV に触れる**前**にここを通す。
 */

/** JSON 本文の最大サイズ (bytes)。固定スキーマの cp 1 件は ~1KB 程度。 */
export const MAX_JSON_BODY_BYTES = 8 * 1024;

/** Turnstile トークンの最大長 (文字数)。Cloudflare の公称上限は 2048 文字。 */
export const MAX_TURNSTILE_TOKEN_LENGTH = 2048;

export type ReadJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; kind: 'too_large' | 'invalid_json' | 'read_error' };

/**
 * 本文を最大 `maxBytes` まで読み、JSON として parse する。
 *
 * - 宣言された Content-Length (`/^\d+$/` のときだけ信用して比較) が上限超 → 読まずに `too_large`
 * - 読み込み中の累積が上限を超えた時点で cancel して `too_large` (ちょうど `maxBytes` は通す)
 * - 本文なし / UTF-8 として不正 / JSON として不正 → `invalid_json`
 * - ストリームの read 自体が失敗 → `read_error`
 */
export async function readJsonBodyLimited(
  request: Request,
  maxBytes: number = MAX_JSON_BODY_BYTES
): Promise<ReadJsonResult> {
  const declared = request.headers.get('Content-Length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    // 読まずに捨てる。cancel の失敗は握りつぶす (応答は返せる)。
    await request.body?.cancel().catch(() => {});
    return { ok: false, kind: 'too_large' };
  }

  const reader = request.body?.getReader();
  if (!reader) return { ok: false, kind: 'invalid_json' };

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, kind: 'too_large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, kind: 'read_error' };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, kind: 'invalid_json' };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, kind: 'invalid_json' };
  }
}
