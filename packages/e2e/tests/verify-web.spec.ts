import { basename } from 'node:path';
import { test, expect } from '@playwright/test';
import { EditorApp, listProofEntries, tamperFirstContentChange, writeZipVariant } from './helpers/app.js';
import { runVerifyCliWithVerdicts, type CliResultWithVerdicts } from './helpers/verifyCli.js';
import { VerifyWebApp, type VerifyVerdict } from './helpers/verifyWeb.js';

/**
 * verify Web を通す往復 E2E (#346 PR 3): editor で打鍵 → export した ZIP を検証 Web に入れ、
 * 判定を **data-* の状態契約** (verify/AGENTS.md) で読む。翻訳テキスト・色クラスは見ない。
 *
 * オラクルは verify-cli (不変条件 1): 同じ ZIP に対する CLI の判定と Web の判定が一致すること
 * (Web↔CLI パリティ) を軸にし、改ざんで両方が拒否する負のオラクルと対にする (不変条件 2)。
 * 検証はすべて fast (`?mode=fast` / `--mode fast`)。PoSW full は happy-path の 1 本だけ (不変条件 4)。
 */

const CODE = 'int main(void) {\n  return 0;\n}\n';

/** editor を開いて CODE を打鍵し、現在のタブを export した ZIP のパスを返す。 */
async function typeAndExport(app: EditorApp): Promise<string> {
  await app.openCasualFresh();
  await app.typeCode(CODE);
  return app.exportCurrentTab();
}

/**
 * Web の判定 (proof ごと) が CLI の判定と一致することを確かめる。
 *
 * 比べられるもの:
 * - 合否: Web の `data-status === 'error'` ⇔ CLI の proof ごとの `valid === false` (どちらも
 *   `isOverallValid` と同じ合成)。総合判定 `data-level === 'failed'` も同じ軸
 * - 三層保証: `data-integrity` / `data-temporal` / `data-pure-typing` ⇔ `--analysis-bundle` の assurance
 * - exit code: 全 proof が valid のときだけ 0
 *
 * 比べられないもの: success と warning の区別、verified と partial の区別。どちらも Web だけの
 * TrustCalculator (issue リスト) の導出で、CLI には対応する機械可読な出力が無い。
 */
function expectWebCliParity(web: VerifyVerdict[], cli: CliResultWithVerdicts): void {
  const cliOutput = cli.stdout + cli.stderr;
  expect(web.map((w) => w.filename).sort(), 'Web と CLI が同じ proof の集合を検証している').toEqual(
    cli.verdicts.map((c) => basename(c.filename)).sort()
  );
  expect(cli.exitCode, cliOutput).toBe(cli.verdicts.every((c) => c.valid) ? 0 : 1);

  for (const c of cli.verdicts) {
    const w = web.find((x) => x.filename === basename(c.filename))!;
    const ctx = `${w.filename}: web=${JSON.stringify(w)} cli=${JSON.stringify(c)}`;
    expect(w.status === 'error', `status error ⇔ CLI invalid (${ctx})`).toBe(!c.valid);
    expect(w.tabStatus, `tab と sidebar の status が一致 (${ctx})`).toBe(w.status);
    if (w.integrity === null) {
      // 判定を表示していないのは「検証自体が失敗したファイル」だけ。
      expect(w.status, `判定なしは error のときだけ (${ctx})`).toBe('error');
      expect(c.valid, ctx).toBe(false);
      continue;
    }
    expect(w.integrity, `integrity (${ctx})`).toBe(c.assurance.integrity);
    expect(w.temporal, `temporal (${ctx})`).toBe(c.assurance.temporal);
    expect(w.pureTyping, `pure typing (${ctx})`).toBe(String(c.assurance.provenance.pureTyping));
    expect(w.level === 'failed', `総合判定 failed ⇔ CLI invalid (${ctx})`).toBe(!c.valid);
  }
}

/** ZIP 内の proof のベース名 (= verify Web の `data-filename`)。 */
async function proofNames(zipPath: string): Promise<string[]> {
  return (await listProofEntries(zipPath)).map((n) => basename(n));
}

test('verify Web の判定が同じ ZIP に対する verify-cli の判定と一致する (無改ざん)', async ({ page }) => {
  const zipPath = await typeAndExport(new EditorApp(page));
  const names = await proofNames(zipPath);
  expect(names.length).toBeGreaterThan(0);

  const cli = runVerifyCliWithVerdicts(zipPath, ['--mode', 'fast']);
  expect(cli.passed, cli.stdout + cli.stderr).toBe(true);

  const web = new VerifyWebApp(page);
  await web.open('fast');
  await web.load([zipPath]);
  const verdicts = await web.readVerdicts(names);

  expectWebCliParity(verdicts, cli);
  // CLI と一致するだけでなく、値そのものも期待どおり (両方が同じ向きに壊れても緑にしない)。
  for (const v of verdicts) {
    expect(v.status, JSON.stringify(v)).not.toBe('error');
    expect(v.integrity, 'fast は PoSW を再計算しないので partial (#214)').toBe('partial');
    expect(v.pureTyping, '打鍵だけのセッション').toBe('true');
    expect(v.level).not.toBe('failed');
  }
});

test('改ざんした ZIP を verify Web が error として出し、verify-cli と同じく拒否する', async ({ page }) => {
  const zipPath = await typeAndExport(new EditorApp(page));
  const tamperedZip = await writeZipVariant(zipPath, {
    mutateProof: tamperFirstContentChange,
    outName: 'tampered.zip',
  });
  const names = await proofNames(tamperedZip);

  const cli = runVerifyCliWithVerdicts(tamperedZip, ['--mode', 'fast']);
  expect(cli.exitCode, 'tampered proof must be rejected\n' + cli.stdout).toBe(1);

  const web = new VerifyWebApp(page);
  await web.open('fast');
  await web.load([tamperedZip]);
  const verdicts = await web.readVerdicts(names);

  expectWebCliParity(verdicts, cli);
  for (const v of verdicts) {
    expect(v.status, JSON.stringify(v)).toBe('error');
    expect(v.tabStatus).toBe('error');
    // 判定を出すなら failed、出さないなら属性なし (null)。proven / partial は改ざんの見逃し。
    expect([null, 'failed'], JSON.stringify(v)).toContain(v.integrity);
    expect([null, 'failed'], JSON.stringify(v)).toContain(v.level);
  }
});

test('正常と改ざんの ZIP を一度に入れても、ファイルごとの判定が混ざらない (#215)', async ({ page }) => {
  const zipPath = await typeAndExport(new EditorApp(page));
  // 同じ export から作るので proof のエントリ名を変え、表示名 (data-filename) を区別できるようにする。
  const cleanZip = await writeZipVariant(zipPath, { renameProof: 'clean', outName: 'clean.zip' });
  const tamperedZip = await writeZipVariant(zipPath, {
    mutateProof: tamperFirstContentChange,
    renameProof: 'tampered',
    outName: 'tampered.zip',
  });

  const web = new VerifyWebApp(page);
  await web.open('fast');
  const states = await web.load([cleanZip, tamperedZip]);
  const status = (f: string) => states.find((s) => s.filename === f)?.status;
  expect(status('clean_proof.json'), JSON.stringify(states)).not.toBe('error');
  expect(status('tampered_proof.json'), JSON.stringify(states)).toBe('error');

  // 正常 → 改ざん → 正常 → 改ざん と選び直す。直前のファイルの判定が残る (#215) と、
  // 改ざん側で partial が、正常側で failed が読めてしまう。
  const [clean1, tampered1, clean2, tampered2] = await web.readVerdicts([
    'clean_proof.json',
    'tampered_proof.json',
    'clean_proof.json',
    'tampered_proof.json',
  ]);
  for (const clean of [clean1!, clean2!]) {
    expect(clean.integrity, JSON.stringify(clean)).toBe('partial');
    expect(clean.level, JSON.stringify(clean)).not.toBe('failed');
    expect(clean.tabStatus).toBe(clean.status);
  }
  for (const tampered of [tampered1!, tampered2!]) {
    expect([null, 'failed'], JSON.stringify(tampered)).toContain(tampered.integrity);
    expect([null, 'failed'], JSON.stringify(tampered)).toContain(tampered.level);
    expect(tampered.tabStatus).toBe('error');
  }

  // それぞれの ZIP について CLI とも一致する。
  expectWebCliParity([clean1!], runVerifyCliWithVerdicts(cleanZip, ['--mode', 'fast']));
  expectWebCliParity([tampered1!], runVerifyCliWithVerdicts(tamperedZip, ['--mode', 'fast']));
});

// #281: アクティブなタブを閉じたあと、TabBar / サイドバー / 結果パネルの active が食い違い、
// 閉じたはずのタブの判定が残る (別の提出物の判定を読む事故)。
test('アクティブなタブを閉じても、タブ・サイドバー・結果パネルの active が一致する (#281)', async ({ page }) => {
  const zipPath = await typeAndExport(new EditorApp(page));
  const zips = [
    await writeZipVariant(zipPath, { renameProof: 'a', outName: 'a.zip' }),
    await writeZipVariant(zipPath, { renameProof: 'b', outName: 'b.zip' }),
    await writeZipVariant(zipPath, { renameProof: 'c', outName: 'c.zip' }),
  ];
  const web = new VerifyWebApp(page);
  await web.open('fast');
  await web.load(zips);

  // a → b → c の順に開く (最後に開いた c がアクティブ)。
  for (const f of ['a_proof.json', 'b_proof.json', 'c_proof.json']) await web.selectFile(f);
  await expect.poll(() => web.activeTabFilename()).toBe('c_proof.json');
  await expect.poll(() => web.displayedFilename()).toBe('c_proof.json');

  await web.closeTab('c_proof.json');

  // 閉じた c ではなく、残ったタブのどれかに 3 か所そろって移っている。
  await expect
    .poll(async () => ({
      tab: await web.activeTabFilename(),
      sidebar: await web.activeFileItemFilename(),
      displayed: await web.displayedFilename(),
    }))
    .toMatchObject({ tab: expect.stringMatching(/^[ab]_proof\.json$/) });
  const after = {
    tab: await web.activeTabFilename(),
    sidebar: await web.activeFileItemFilename(),
    displayed: await web.displayedFilename(),
  };
  expect(after.sidebar, JSON.stringify(after)).toBe(after.tab);
  expect(after.displayed, JSON.stringify(after)).toBe(after.tab);
  expect(after.tab, JSON.stringify(after)).not.toBe('c_proof.json');
});

// #292: ZIP 内の壊れた `*_proof.json` は、CLI では失敗として数え (exit 1)、verify Web では error として並べる。
// (かつては CLI が黙ってスキップして exit 0、Web がプレーンテキスト・status success で並べていた。)
test('#292: 壊れた *_proof.json を含む ZIP でも結果が出て、壊れたファイルが error として見える', async ({ page }) => {
  const zipPath = await typeAndExport(new EditorApp(page));
  const names = await proofNames(zipPath);
  const brokenZip = await writeZipVariant(zipPath, {
    extraEntries: { 'broken_proof.json': '{"proof":' },
    outName: 'broken.zip',
  });

  const web = new VerifyWebApp(page);
  await web.open('fast');
  const states = await web.load([brokenZip]);

  // 正常な proof の結果は出る (壊れたファイルに巻き込まれて全体が止まらない)。
  const verdicts = await web.readVerdicts(names);
  for (const v of verdicts) expect(v.integrity, JSON.stringify(v)).toBe('partial');
  // 壊れた proof は error として見える (proof でない JSON として success で並ばない)。
  expect(states.find((s) => s.filename === 'broken_proof.json')?.status, JSON.stringify(states)).toBe('error');

  // CLI も壊れた proof を失敗として数える。
  const cli = runVerifyCliWithVerdicts(brokenZip, ['--mode', 'fast']);
  expect(cli.exitCode, cli.stdout + cli.stderr).toBe(1);
});

// #395: 結果を表示した後、1280x800 でチャートのタブ (タイムライン等) が結果カードに覆われて押せなかった。
// `.result-left-panel` は縦 flex で、`overflow: hidden` の `.chart-section` が高さ不足のとき 2px まで
// 縮み、タブの位置に `#result-cards` が重なっていた。force なしのクリックが通ることを見る。
test.describe('結果パネルのチャートタブ (1280x800)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('結果表示後にタイムライン・マウス軌跡のタブを force なしで押して切り替えられる (#395)', async ({ page }) => {
    const zipPath = await typeAndExport(new EditorApp(page));
    const [proof] = await proofNames(zipPath);

    const web = new VerifyWebApp(page);
    await web.open('fast');
    await web.load([zipPath]);
    await web.readVerdict(proof!);

    expect(await web.activeChartTab(), '初期は統合チャート').toBe('integrated');
    expect(await web.activeChartPanel()).toBe('integrated');

    await web.clickChartTab('timeline');
    await expect.poll(() => web.activeChartTab()).toBe('timeline');
    expect(await web.activeChartPanel(), 'タブに対応するパネルが表示される').toBe('timeline');

    await web.clickChartTab('mouse');
    await expect.poll(() => web.activeChartTab()).toBe('mouse');
    expect(await web.activeChartPanel()).toBe('mouse');
  });
});
