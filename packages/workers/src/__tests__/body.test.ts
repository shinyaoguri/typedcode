/**
 * readJsonBodyLimited (#285): 本文を読み込み中に上限強制する。
 *
 * Request は ReadableStream (highWaterMark 0) で組み、Content-Length 無しでも実バイトで
 * 打ち切れること / 上限超過で上流を cancel して残りを読まないことを確かめる。
 */

import { describe, it, expect } from 'vitest';
import { MAX_JSON_BODY_BYTES, readJsonBodyLimited } from '../body.js';

const encoder = new TextEncoder();

/** pull 回数と cancel を観測できるストリーム本文の Request を作る */
function streamRequest(
  chunks: Uint8Array[],
  headers: Record<string, string> = {}
): { request: Request; stats: { pulls: number; cancelled: boolean } } {
  const stats = { pulls: 0, cancelled: false };
  let i = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        stats.pulls++;
        if (i < chunks.length) controller.enqueue(chunks[i++]!);
        else controller.close();
      },
      cancel() {
        stats.cancelled = true;
      },
    },
    { highWaterMark: 0 }
  );
  const request = new Request('https://workers.test/x', {
    method: 'POST',
    body: stream,
    headers,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  return { request, stats };
}

/** ちょうど `bytes` バイトの JSON 文字列 (`{"a":"xxx..."}`) */
function jsonOfBytes(bytes: number): string {
  const overhead = '{"a":""}'.length;
  return `{"a":"${'x'.repeat(bytes - overhead)}"}`;
}

function textRequest(text: string): Request {
  return new Request('https://workers.test/x', { method: 'POST', body: text });
}

describe('readJsonBodyLimited', () => {
  it('parses a small JSON body', async () => {
    const result = await readJsonBodyLimited(textRequest('{"a":1}'));
    expect(result).toEqual({ ok: true, value: { a: 1 } });
  });

  it('accepts a body of exactly the limit and rejects one byte more', async () => {
    const atLimit = await readJsonBodyLimited(textRequest(jsonOfBytes(MAX_JSON_BODY_BYTES)));
    expect(atLimit.ok).toBe(true);
    const over = await readJsonBodyLimited(textRequest(jsonOfBytes(MAX_JSON_BODY_BYTES + 1)));
    expect(over).toEqual({ ok: false, kind: 'too_large' });
  });

  it('stops reading and cancels the stream once the limit is exceeded without Content-Length', async () => {
    // 1 KiB x 64 chunk を流すが、8 KiB を超えた時点で打ち切るので全 chunk は引かれない。
    const chunks = Array.from({ length: 64 }, () => new Uint8Array(1024).fill(0x78));
    const { request, stats } = streamRequest(chunks);
    const result = await readJsonBodyLimited(request);
    expect(result).toEqual({ ok: false, kind: 'too_large' });
    expect(stats.cancelled).toBe(true);
    expect(stats.pulls).toBeLessThan(chunks.length);
  });

  it('counts bytes, not characters (multi-byte text over the limit is rejected)', async () => {
    // 全角 3 バイト x 3000 文字 = 9000 バイト > 8192 だが文字数なら 3000 で上限未満。
    const body = JSON.stringify({ a: 'あ'.repeat(3000) });
    expect(body.length).toBeLessThan(MAX_JSON_BODY_BYTES);
    const result = await readJsonBodyLimited(textRequest(body));
    expect(result).toEqual({ ok: false, kind: 'too_large' });
  });

  it('rejects a declared Content-Length over the limit without reading the body', async () => {
    const { request, stats } = streamRequest([encoder.encode('{}')], {
      'Content-Length': String(MAX_JSON_BODY_BYTES + 1),
    });
    const result = await readJsonBodyLimited(request);
    expect(result).toEqual({ ok: false, kind: 'too_large' });
    expect(stats.pulls).toBe(0);
    expect(stats.cancelled).toBe(true);
  });

  it('does not trust an understated Content-Length (real bytes are enforced)', async () => {
    const { request } = streamRequest([encoder.encode(jsonOfBytes(MAX_JSON_BODY_BYTES + 100))], {
      'Content-Length': '10',
    });
    const result = await readJsonBodyLimited(request);
    expect(result).toEqual({ ok: false, kind: 'too_large' });
  });

  it('treats a missing body as invalid_json', async () => {
    const noBody = new Request('https://workers.test/x', { method: 'POST' });
    expect(await readJsonBodyLimited(noBody)).toEqual({ ok: false, kind: 'invalid_json' });
  });

  it('treats an empty body as invalid_json', async () => {
    expect(await readJsonBodyLimited(textRequest(''))).toEqual({ ok: false, kind: 'invalid_json' });
  });

  it('treats malformed JSON as invalid_json', async () => {
    expect(await readJsonBodyLimited(textRequest('{ "broken'))).toEqual({ ok: false, kind: 'invalid_json' });
  });

  it('treats invalid UTF-8 as invalid_json instead of silently replacing bytes', async () => {
    // 0xff 単独は UTF-8 として不正。fatal: false だと U+FFFD に化けて JSON 文字列として通ってしまう。
    const bytes = new Uint8Array([0x22, 0xff, 0x22]); // "\xff" を囲む引用符
    const { request } = streamRequest([bytes]);
    expect(await readJsonBodyLimited(request)).toEqual({ ok: false, kind: 'invalid_json' });
  });

  it('reports read_error when the body stream fails', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('simulated stream failure');
      },
    });
    const request = new Request('https://workers.test/x', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    expect(await readJsonBodyLimited(request)).toEqual({ ok: false, kind: 'read_error' });
  });

  it('reassembles a JSON value split across several chunks', async () => {
    const full = encoder.encode('{"msg":"こんにちは","n":[1,2,3]}');
    const { request } = streamRequest([full.slice(0, 5), full.slice(5, 13), full.slice(13)]);
    expect(await readJsonBodyLimited(request)).toEqual({ ok: true, value: { msg: 'こんにちは', n: [1, 2, 3] } });
  });

  it('honours a custom maxBytes', async () => {
    expect(await readJsonBodyLimited(textRequest('{"a":123456}'), 5)).toEqual({ ok: false, kind: 'too_large' });
  });
});
