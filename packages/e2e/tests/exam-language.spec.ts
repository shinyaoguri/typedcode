import { test, expect, type Page } from '@playwright/test';
import { EditorApp } from './helpers/app.js';
import { loadExamFixture } from './helpers/examFixture.js';
import { runVerifyCli } from './helpers/verifyCli.js';

/**
 * 試験の許可言語 (#727) の負の対照。fixture の問題パッケージは `allowed.languages = ['c']` (starter も c)
 * なので HTML は許可されない。
 *
 * - 言語セレクタの html の選択肢は無効 (選べない)
 * - select の値を直接 html に書き換えて change を投げても、タブの言語は c のまま (言語変更の境界)
 * - 保存状態 (sessionStorage のタブ状態) を html に書き換えてリロードしても、HTML プレビューは描かれず
 *   (`#browser-preview[data-preview-state="not-allowed"]`)、実行も始まらない (`data-exec-run` が付かない)。
 *   打鍵したコードは復元される
 * - その状態で export した proof (proof.language = html) は、正しい問題パッケージを渡した verify-cli が
 *   許可言語の照合 (`Languages: FAIL`) で exit 1 にする。チェーン・束縛の他の要素は PASS のまま
 *
 * 正の対照は exam-roundtrip.spec.ts の `Languages: PASS` (c は許可言語)。
 */

const fixture = loadExamFixture();

/** sessionStorage の exam のタブ状態 (`typedcode-tabs-exam`) の言語を、次の読み込みの前に書き換える。 */
async function tamperRestoredLanguageOnNextLoad(page: Page, language: string): Promise<void> {
  await page.addInitScript((lang) => {
    if (sessionStorage.getItem('__tc_e2e_tamper_language') !== '1') return;
    sessionStorage.removeItem('__tc_e2e_tamper_language');
    const raw = sessionStorage.getItem('typedcode-tabs-exam');
    if (!raw) return;
    const storage = JSON.parse(raw) as { tabs: Record<string, { language: string }> };
    for (const tab of Object.values(storage.tabs)) tab.language = lang;
    sessionStorage.setItem('typedcode-tabs-exam', JSON.stringify(storage));
  }, language);
  await page.evaluate(() => sessionStorage.setItem('__tc_e2e_tamper_language', '1'));
}

test('exam: 許可されない言語 (html) は選べず、直接の変更も復元もプレビュー・実行を始めず、その proof は verify-cli が許可言語の照合で exit 1 にする', async ({
  page,
}) => {
  if (!fixture) {
    if (process.env.CI)
      throw new Error('exam fixture is missing: `npm run setup -w @typedcode/e2e` did not generate it');
    test.skip(true, 'exam fixture 未生成 (npm run setup -w @typedcode/e2e で作る)');
    return;
  }

  const app = new EditorApp(page);
  await app.openModeFresh('exam', { screenShare: 'share', waitReady: false });
  await expect.poll(() => app.appState()).toBe('gate');
  await app.unlockExam(fixture.packagePath, fixture.code);

  const selector = page.locator('#language-selector');

  await test.step('言語セレクタは許可言語 (c) だけを選ばせる', async () => {
    await expect(selector).toHaveValue('c');
    await expect(selector.locator('option[value="c"]')).toBeEnabled();
    await expect(selector.locator('option[value="html"]')).toBeDisabled();
    await expect(selector.locator('option[value="python"]')).toBeDisabled();
  });

  await test.step('select の値を直接 html にして change を投げても、タブの言語は変わらない', async () => {
    await selector.evaluate((el: HTMLSelectElement) => {
      el.value = 'html';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(page.locator('#block-notification')).toHaveAttribute('data-notice', 'language-not-allowed');
    await expect(selector).toHaveValue('c');
    const snapshot = await app.snapshot();
    expect(snapshot.tabs.map((t) => t.language)).toEqual(['c']);
  });

  const answer = 'int main(void) { return 0; }\n';
  await app.typeCode(answer);
  await app.waitForSynced();

  await test.step('保存状態を html に書き換えてリロードしても、プレビューと実行は始まらず、コードは残る', async () => {
    await tamperRestoredLanguageOnNextLoad(page, 'html');
    // exam はリロードのたびに画面共有の選択を出すので、reloadAndResume ではなくここで選ぶ。
    await page.reload();
    const share = page.locator('.screen-share-choice-dialog [data-choice="share"]');
    await share.waitFor({ state: 'visible', timeout: 30_000 });
    await share.click();
    await app.waitReady();
    await expect.poll(async () => (await app.snapshot()).tabs.map((t) => t.language)).toEqual(['html']);
    expect((await app.snapshot()).tabs[0]?.content).toContain(answer.trim());

    await page.locator('#toggle-preview-btn').click();
    await expect(page.locator('#browser-preview')).toHaveAttribute('data-preview-state', 'not-allowed');
    await expect(page.locator('#preview-iframe')).not.toHaveAttribute('srcdoc', /.*/);

    await page.locator('#run-code-btn').click();
    await expect(page.locator('#block-notification')).toHaveAttribute('data-notice', 'language-not-allowed');
    await expect(page.locator('#xterm-container')).not.toHaveAttribute('data-exec-run', /.*/);
  });

  await test.step('html を名乗る proof は、正しい問題パッケージでも許可言語の照合で exit 1', async () => {
    const zipPath = await app.exportViaLogButton();
    const result = runVerifyCli(zipPath, ['--mode', 'fast', '--exam-package', fixture.packagePath], {
      examAuthorityKeys: true,
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(1);
    // stdout のまま読む理由: 束縛の内訳と理由は人向け出力にしか無い (exam-forged-starter.spec.ts と同じ)。
    expect(result.stdout).toMatch(/Languages:\s+FAIL/);
    expect(result.stdout).toContain("Proof language is not one of the exam package's allowed languages");
    for (const label of ['Root binding:', 'Signature:', 'Package hash:', 'Content hash:', 'Identifiers:', 'Starter:']) {
      expect(result.stdout, `${label} PASS`).toMatch(new RegExp(`${label}\\s+PASS`));
    }
  });
});
