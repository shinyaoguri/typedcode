import { createHash } from 'node:crypto';
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
 * 検出でき、遅い CI ランナーで full 再計算を偽造の数だけ回す必要がない (タイムアウト回避)。
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

  // ③ と ⑤ は metadata 層が先に落とすので、後ろの chain / finalHash 層が実 proof で効いているかは見えない。
  // そこで偽造者がイベント列から導ける自己申告値 (件数メタデータと typingProofHash) をすべて合わせ直し、
  // metadata 層を通した版を足す (#674)。合わせ直しが不完全なら metadata で落ちてこの assert が赤くなるので、
  // 「metadata を通った」こと自体もここで確かめている。

  // ⑥ metadata を合わせたリプレイ: ③ と同じ複製に件数と typingProofHash を合わせる → chain 層 (sequence) で落ちる。
  const replayedRealigned = await extractProofJson(zipPath, (p) => {
    const ev = events(p);
    const mid = Math.floor(ev.length / 2);
    if (ev.length < 4) throw new Error('too few events');
    ev.splice(mid, 0, JSON.parse(JSON.stringify(ev[mid])));
    realignEventMetadata(p);
  });
  expectRejectedBy(replayedRealigned, 'chain', 'replayed event must be rejected even with realigned metadata');

  // ⑦ metadata を合わせた切り詰め: ⑤ と同じ削除に件数と typingProofHash を合わせ、消したイベントを指す
  //    checkpoint も取り除く。残ったチェーンはそれ自体整合しているので chain 層は通り、焼かれた最終ハッシュ
  //    (proof.finalHash / finalEventChainHash) が残った末尾と食い違って finalHash 層で落ちる。
  //    - checkpoint を取り除くのは、export は末尾のイベントに署名付き checkpoint を打つので、残すと
  //      「消えたイベントを指す checkpoint」が errorAt 付きで落ち、`failedCheck` が chain と読まれて
  //      finalHash 層だけが捕まえたことにならないため (verify-cli の resultJson.ts の既知の限界)
  //    - 最終ハッシュまでは書き換えない。それは「切り詰め」ではなく「短い正規 proof の名乗り」(最終ハッシュも
  //      作り直す偽造) で、metadata の合わせ直しという #674 の範囲を超える。正規 proof の先頭部分は
  //      それ自体が正しく記録された打鍵列なので、そこまで作り直されたものを既定の検証 (受理ポリシーを足さない)
  //      で拒否する層は無い (末尾の署名付き checkpoint を剥がされても、残った checkpoint だけで anchored のまま。
  //      署名されない末尾は警告として出る)
  const truncatedRealigned = await extractProofJson(zipPath, (p) => {
    const ev = events(p);
    if (ev.length < 2) throw new Error('too few events');
    ev.pop();
    const cps = p.checkpoints as Array<{ eventIndex?: number }> | undefined;
    if (!cps?.some((cp) => cp.eventIndex === ev.length)) throw new Error('no checkpoint on the removed event');
    p.checkpoints = cps.filter((cp) => (cp.eventIndex ?? Infinity) < ev.length);
    realignEventMetadata(p);
  });
  expectRejectedBy(truncatedRealigned, 'finalHash', 'truncated chain must be rejected even with realigned metadata');
});

/**
 * 偽造者の立場で、イベント列から導ける自己申告値をすべて合わせ直す (#674)。
 *
 * - `typingProofData.metadata` の件数 (`verifyProofMetadata` が再計算して照合する 6 項目) をイベント列から数え直す。
 *   数え方は shared の `recomputeProofMetadata` の定義に合わせる (偽造者は公開されたコードを読める)
 * - `typingProofHash` を再計算する。入力は `JSON.stringify(typingProofData)` の SHA-256 で、鍵を使わないので
 *   誰でも作り直せる (shared の `verifyTypingProofHash`)
 * - `proof.totalEvents` も合わせる (検証には使われないが、自己申告値として食い違いを残さない)
 *
 * 合わせないもの: `bulkInsertEvents` (打鍵 1 つの複製・削除では増減しない) と `totalTypingTime`
 * (検査は「申告 ≥ 再計算」で、中ほどの複製も末尾の削除も再計算値を増やさない)。
 */
function realignEventMetadata(p: Proof): void {
  const ev = events(p);
  const inputType = (e: Ev): string => (typeof e.inputType === 'string' ? e.inputType : '');
  const metadata = tp(p).metadata as Record<string, unknown> | undefined;
  if (!metadata) throw new Error('no typingProofData.metadata');
  metadata.totalEvents = ev.length;
  metadata.pasteEvents = ev.filter((e) => inputType(e) === 'insertFromPaste').length;
  metadata.internalPasteEvents = ev.filter((e) => inputType(e) === 'insertFromInternalPaste').length;
  metadata.dropEvents = ev.filter((e) => inputType(e) === 'insertFromDrop').length;
  metadata.insertEvents = ev.filter((e) => e.type === 'contentChange' && e.data).length;
  metadata.deleteEvents = ev.filter((e) => inputType(e).startsWith('delete')).length;
  (p.proof as { totalEvents?: number }).totalEvents = ev.length;
  p.typingProofHash = createHash('sha256').update(JSON.stringify(p.typingProofData)).digest('hex');
}

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
