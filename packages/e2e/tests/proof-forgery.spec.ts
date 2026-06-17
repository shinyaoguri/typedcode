import { test, expect } from '@playwright/test';
import { EditorApp, extractProofJson } from './helpers/app.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * 敵対的 (負のオラクル群): 本物の export 済み proof に対する代表的な偽造を verify-cli が
 * すべて拒否する (exit 1) ことを確認する。1 種でも素通りすると「壊れた検証器」になる。
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
  return ((p.proof as { events?: Ev[] })?.events ?? []);
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
  const clean = runVerifyCli(await extractProofJson(zipPath), ["--mode", "fast"]);
  expect(clean.passed, 'unmodified proof should pass\n' + clean.stdout).toBe(true);

  // ① root 偽造: 初期ハッシュ nonce を 1 文字書き換える → root がどちらの式にも一致しない。
  const nonceForged = await extractProofJson(zipPath, (p) => {
    const t = tp(p);
    if (typeof t.initialHashNonce !== 'string') throw new Error('no initialHashNonce');
    t.initialHashNonce = flip(t.initialHashNonce);
  });
  expect(runVerifyCli(nonceForged, ["--mode", "fast"]).exitCode, 'forged nonce must be rejected').toBe(1);

  // ② fingerprint 偽造: deviceId と紐づく fingerprint.hash を書き換える。
  const fpForged = await extractProofJson(zipPath, (p) => {
    const fp = p.fingerprint as { hash?: string } | undefined;
    if (!fp || typeof fp.hash !== 'string') throw new Error('no fingerprint.hash');
    fp.hash = flip(fp.hash);
  });
  expect(runVerifyCli(fpForged, ["--mode", "fast"]).exitCode, 'forged fingerprint must be rejected').toBe(1);

  // ③ リプレイ (イベント複製): 中ほどのイベントを複製挿入 → sequence/チェーンが破綻。
  const replayed = await extractProofJson(zipPath, (p) => {
    const ev = events(p);
    const mid = Math.floor(ev.length / 2);
    if (ev.length < 4) throw new Error('too few events');
    ev.splice(mid, 0, JSON.parse(JSON.stringify(ev[mid])));
  });
  expect(runVerifyCli(replayed, ["--mode", "fast"]).exitCode, 'duplicated/replayed event must be rejected').toBe(1);

  // ④ 切り貼り (イベント順序入替): 隣接する 2 イベントを入れ替える → previousHash チェーンが切れる。
  const reordered = await extractProofJson(zipPath, (p) => {
    const ev = events(p);
    const i = Math.floor(ev.length / 2);
    if (i + 1 >= ev.length) throw new Error('too few events');
    const tmp = ev[i]!;
    ev[i] = ev[i + 1]!;
    ev[i + 1] = tmp;
  });
  expect(runVerifyCli(reordered, ["--mode", "fast"]).exitCode, 'reordered/spliced events must be rejected').toBe(1);

  // ⑤ 末尾イベント削除 (切り詰め): finalEventChainHash と最終ハッシュが食い違う。
  const truncated = await extractProofJson(zipPath, (p) => {
    const ev = events(p);
    if (ev.length < 2) throw new Error('too few events');
    ev.pop();
  });
  expect(runVerifyCli(truncated, ["--mode", "fast"]).exitCode, 'truncated chain must be rejected').toBe(1);
});

/** 16 進文字列の先頭 1 文字を別の値へ反転する。 */
function flip(hex: string): string {
  const c = hex[0] === '0' ? '1' : '0';
  return c + hex.slice(1);
}
