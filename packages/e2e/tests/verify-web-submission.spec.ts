import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import JSZip from 'jszip';
import { EditorApp, tamperFirstContentChange, writeZipVariant } from './helpers/app.js';
import { runVerifyCliWithVerdicts } from './helpers/verifyCli.js';
import { VerifyWebApp, expectWebCliParity, proofNames, typeAndExport } from './helpers/verifyWeb.js';

/**
 * verify Web を通す往復 E2E (#346 PR 3 / 分割は #533): editor で打鍵 → export した ZIP を検証 Web に入れ、
 * 判定を **data-* の状態契約** (verify/AGENTS.md) で読む。翻訳テキスト・色クラスは見ない。
 *
 * このファイルは提出物の中身が揃わない系統 (複数 ZIP の混在・壊れた proof・同梱ソースの差し替え)。ファイルごとの判定が混ざらないこと、
 * 壊れた / 差し替えられた提出物を CLI と同じく失敗として出すこと (不変条件 2, 6)。
 * 検証はすべて fast (`?mode=fast` / `--mode fast`)。PoSW full は happy-path の 1 本だけ (不変条件 4)。
 * 同じ系統の兄弟: verify-web-parity / verify-web-submission / verify-web-ui (1 ファイルが CI で Slow Test の閾値 5 分を超えたため分割。共通の手順は helpers/verifyWeb.ts)。
 */

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
  // 何も読んでいない間は集約を出さない (属性なし)。
  expect(await web.proofSummary()).toBeNull();
  const states = await web.load([cleanZip, tamperedZip]);
  const status = (f: string) => states.find((s) => s.filename === f)?.status;
  expect(status('clean_proof.json'), JSON.stringify(states)).not.toBe('error');
  expect(status('tampered_proof.json'), JSON.stringify(states)).toBe('error');

  // ステータスバーの集約 (#282): 警告は passed に数えるので、正常 (fast = warning) + 改ざん (error) は 1/2 で失敗 1。
  await expect.poll(() => web.proofSummary()).toEqual({ total: 2, passed: 1, failed: 1 });
  // 正常な proof を開いた状態から、失敗のクリックで失敗した proof のタブに移る。
  await web.selectFile('clean_proof.json');
  await expect.poll(() => web.activeTabFilename()).toBe('clean_proof.json');
  await web.clickProofSummary();
  await expect.poll(() => web.activeTabFilename()).toBe('tampered_proof.json');

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

// #293: ZIP に同梱されたソースが proof.content と違うとき、CLI は exit 1、verify Web は proof とソースを error にする。
// (かつて CLI は同梱ソースを読まず PASSED / exit 0、Web は warning だった。) 整合性 (integrity) は落とさない:
// proof 自体は改ざんされていないので、判定は提出物の不整合 (`source` component) として別の理由で出る。
test('#293: 同梱ソースを差し替えた ZIP は Web で error、CLI で exit 1 になり、整合性は落ちない', async ({ page }) => {
  const zipPath = await typeAndExport(new EditorApp(page));
  const proofName = (await proofNames(zipPath))[0]!;
  const sourceName = Object.keys((await JSZip.loadAsync(await readFile(zipPath))).files).find((n) => n.endsWith('.c'))!;
  const forged = await writeZipVariant(zipPath, {
    // 同じ名前の extraEntries は元のソースを置き換える (proof は触らない)
    extraEntries: { [sourceName]: 'THIS IS NOT THE VERIFIED CONTENT' },
    outName: 'forged-source.zip',
  });

  const cli = runVerifyCliWithVerdicts(forged, ['--mode', 'fast']);
  expect(cli.exitCode, cli.stdout + cli.stderr).toBe(1);
  // 提出物の不一致は整合性の失敗ではなく、検証 gate での失敗 ('other')。
  expect(cli.verdicts[0]?.failedCheck).toBe('other');
  // stdout のまま残す理由: どの同梱ソースが期待名と不一致かは人向け出力の `Source:` 行にしか無い。
  expect(cli.stdout).toMatch(new RegExp(`^Source:\\s+${sourceName.replace('.', '\\.')}\\s+MISMATCH`, 'm'));
  expect(cli.verdicts[0]?.assurance.integrity, 'CLI も整合性は落とさない').not.toBe('failed');

  const web = new VerifyWebApp(page);
  await web.open('fast');
  const states = await web.load([forged]);
  expect(states.find((s) => s.filename === proofName)?.status, JSON.stringify(states)).toBe('error');
  expect(states.find((s) => s.filename === sourceName)?.status, JSON.stringify(states)).toBe('error');

  const verdict = (await web.readVerdicts([proofName]))[0]!;
  expect(verdict.integrity, '整合性のバッジは落とさない').toBe('partial');
  expect(verdict.level).toBe('failed');
  expect(await web.trustIssues()).toContainEqual({ component: 'source', severity: 'error' });
});
