import { test, expect } from '@playwright/test';
import { EditorApp, extractProofJson } from './helpers/app.js';
import { runVerifyCliWithResult } from './helpers/verifyCli.js';

/**
 * 敵対的 (負のオラクル群): 本物の export 済み proof に対する代表的な偽造を verify-cli が
 * すべて拒否する (exit 1) うえで、**期待する検査で**落ちること (`--result-json` の `failedCheck`) を確認する。
 * 1 種でも素通りすると「壊れた検証器」になるし、別の検査で落ちているなら (たとえば入力が読めずに exit 1 に
 * なっているだけなら) 偽造を捕まえたことにならない (#588)。
 * export は重い (PoSW) ので 1 回だけ行い、同じ proof に複数の偽造を適用する。
 *
 * 検証は `--mode fast` (PoSW 再計算をスキップ・改ざん耐性のみ) を使う。ここで試す偽造は
 * すべて root / ハッシュチェーン / メタデータの破綻であり PoSW とは無関係なので fast で
 * 検出でき、遅い CI ランナーで full 再計算を 6 回回す必要がない (タイムアウト回避)。
 */
type Proof = Record<string, unknown>;
interface Tp {
  initialHashNonce?: string;
  initialEventChainHash?: string;
  [k: string]: unknown;
}
interface Ev {
  hash?: string;
  previousHash?: string;
  data?: unknown;
  [k: string]: unknown;
}

function events(p: Proof): Ev[] {
  return (p.proof as { events?: Ev[] })?.events ?? [];
}
function tp(p: Proof): Tp {
  return (p.typingProofData as Tp) ?? {};
}

test('export した proof への各種偽造を verify-cli がすべて拒否する', async ({ page }) => {
  const app = new EditorApp(page);
  await app.openCasualFresh();
  await app.typeCode('int total = 0;\ntotal = total + 1;\n');
  await app.waitForSynced();
  const zipPath = await app.exportCurrentTab();

  // positive control: 無改ざんは pass。
  const clean = runVerifyCliWithResult(await extractProofJson(zipPath), ['--mode', 'fast']);
  expect(clean.passed, 'unmodified proof should pass\n' + clean.stdout).toBe(true);
  expect(clean.results.map((r) => [r.valid, r.failedCheck])).toEqual([[true, null]]);

  // 各偽造が落ちる層 (`failedCheck`) は、verify-cli が「最初に落ちた層」として返す値。優先順位は
  // verify-cli の `resultJson.ts` (version → root → metadata → chain → finalHash → …)。

  // ① root 偽造: 初期ハッシュ nonce を 1 文字書き換える → root がどちらの式にも一致しない (root 層)。
  const nonceForged = await extractProofJson(zipPath, (p) => {
    const t = tp(p);
    if (typeof t.initialHashNonce !== 'string') throw new Error('no initialHashNonce');
    t.initialHashNonce = flip(t.initialHashNonce);
  });
  expectRejectedBy(nonceForged, 'root', 'forged nonce must be rejected');

  // ② fingerprint 偽造: deviceId と紐づく fingerprint.hash を書き換える (root 層: deviceId ≠ fingerprint.hash)。
  const fpForged = await extractProofJson(zipPath, (p) => {
    const fp = p.fingerprint as { hash?: string } | undefined;
    if (!fp || typeof fp.hash !== 'string') throw new Error('no fingerprint.hash');
    fp.hash = flip(fp.hash);
  });
  expectRejectedBy(fpForged, 'root', 'forged fingerprint must be rejected');

  // ③ リプレイ (イベント複製): 中ほどのイベントを複製挿入。イベント数が proof に焼かれた totalEvents と食い違うので
  //    metadata 層が先に落とす (チェーンも sequence で破綻するが、metadata の方が先に評価される)。
  const replayed = await extractProofJson(zipPath, (p) => {
    const ev = events(p);
    const mid = Math.floor(ev.length / 2);
    if (ev.length < 4) throw new Error('too few events');
    ev.splice(mid, 0, JSON.parse(JSON.stringify(ev[mid])));
  });
  expectRejectedBy(replayed, 'metadata', 'duplicated/replayed event must be rejected');

  // ④ 切り貼り (イベント順序入替): 隣接する 2 イベントを入れ替える。イベント数は変わらないので chain 層 (sequence) で落ちる。
  const reordered = await extractProofJson(zipPath, (p) => {
    const ev = events(p);
    const i = Math.floor(ev.length / 2);
    if (i + 1 >= ev.length) throw new Error('too few events');
    const tmp = ev[i]!;
    ev[i] = ev[i + 1]!;
    ev[i + 1] = tmp;
  });
  expectRejectedBy(reordered, 'chain', 'reordered/spliced events must be rejected');

  // ⑤ 末尾イベント削除 (切り詰め): totalEvents が食い違うので metadata 層が先に落とす
  //    (finalEventChainHash と最終ハッシュの不一致 = finalHash 層もあるが、評価順で後)。
  const truncated = await extractProofJson(zipPath, (p) => {
    const ev = events(p);
    if (ev.length < 2) throw new Error('too few events');
    ev.pop();
  });
  expectRejectedBy(truncated, 'metadata', 'truncated chain must be rejected');
});

/**
 * 偽造した proof を fast で検証し、exit 1 かつ期待する検査 (`failedCheck`) で落ちたことを確かめる。
 * 優先順位 (最初に落ちた層) は verify-cli の `resultJson.ts` が正本。
 */
function expectRejectedBy(file: string, failedCheck: string, message: string): void {
  const res = runVerifyCliWithResult(file, ['--mode', 'fast']);
  expect(res.exitCode, `${message}\n${res.stdout}`).toBe(1);
  expect(
    res.results.map((r) => [r.valid, r.failedCheck]),
    `${message}: must fail the ${failedCheck} check\n${res.stdout}`
  ).toEqual([[false, failedCheck]]);
}

/** 16 進文字列の先頭 1 文字を別の値へ反転する。 */
function flip(hex: string): string {
  const c = hex[0] === '0' ? '1' : '0';
  return c + hex.slice(1);
}
