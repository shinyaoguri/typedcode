/**
 * scripts/require-visual-evidence.mjs (見た目の証跡ゲート / ADR-0036) の判定ロジックの検証。
 *
 * ルートに vitest の設定が無いので node:test で書く。実行: `node --test 'scripts/*.test.mjs'`
 * (CI は deploy.yml の check job)。CLI 部分は入出力の配線だけなので、最後に子プロセスで
 * exit code を見る。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { evaluate, hasImage, isVisualFile } from './require-visual-evidence.mjs';

const SCRIPT = fileURLToPath(new URL('./require-visual-evidence.mjs', import.meta.url));

const CSS = 'packages/verify/src/styles/components/_result-panel.css';
const IMAGE_BODY =
  '## 見た目の証跡\n\n| before | after |\n|---|---|\n| ![before](https://i.gyazo.com/a.png) | ![after](https://i.gyazo.com/b.png) |\n';

function feat(overrides = {}) {
  return { title: 'feat(verify): foo', labels: [], body: '', author: 'someone', ...overrides };
}

describe('isVisualFile', () => {
  it('counts the page entry HTML, CSS under src, editor ui components / dialogs, verify ui parts and charts', () => {
    for (const file of [
      'packages/editor/index.html',
      'packages/editor/author.html',
      'packages/verify/index.html',
      'packages/editor/src/styles/components/_tabs.css',
      CSS,
      'packages/editor/src/ui/components/ProofStatusDisplay.ts',
      'packages/editor/src/ui/dialogs/SomeDialog.ts',
      'packages/verify/src/ui/ResultPanel.ts',
      'packages/verify/src/charts/TimelineChart.ts',
    ]) {
      assert.equal(isVisualFile(file), true, file);
    }
  });

  it('does not count the verify ui wiring files AppController.ts and fileInput.ts', () => {
    for (const file of ['packages/verify/src/ui/AppController.ts', 'packages/verify/src/ui/fileInput.ts']) {
      assert.equal(isVisualFile(file), false, file);
    }
  });

  it('counts only files directly under verify/src/ui, not those in its subdirectories', () => {
    for (const file of ['packages/verify/src/ui/controllers/TabController.ts', 'packages/verify/src/ui/sub/x.ts']) {
      assert.equal(isVisualFile(file), false, file);
    }
  });

  it('does not count tests, translations, editor ui/tabs or other packages', () => {
    for (const file of [
      'packages/verify/src/ui/__tests__/ResultPanel.test.ts',
      'packages/verify/src/ui/ResultPanel.test.ts',
      'packages/editor/src/ui/components/__tests__/fixtures/x.html',
      'packages/e2e/tests/shots.spec.ts',
      'packages/verify/src/i18n/translations/ja.ts',
      'packages/editor/src/i18n/types.ts',
      'packages/editor/src/ui/tabs/TabManager.ts',
      'packages/editor/src/services/TurnstileService.ts',
      'packages/shared/src/styles.css',
      'packages/workers/index.html',
    ]) {
      assert.equal(isVisualFile(file), false, file);
    }
  });
});

describe('hasImage', () => {
  it('detects a Markdown image', () => {
    assert.equal(hasImage('before ![shot](https://i.gyazo.com/a.png) after'), true);
  });

  it('detects an <img> tag with a src attribute in any quoting', () => {
    for (const body of [
      '<img width="400" alt="after" src="https://github.com/user-attachments/assets/x">',
      "<IMG src='https://i.gyazo.com/a.png'>",
      '<img src=https://i.gyazo.com/a.png />',
    ]) {
      assert.equal(hasImage(body), true, body);
    }
  });

  it('does not count an <img> without src or a Markdown image without a URL', () => {
    assert.equal(hasImage('<img alt="todo">\n![todo]()'), false);
  });

  it('does not count a plain link that is not an image', () => {
    assert.equal(hasImage('[screenshot](https://i.gyazo.com/a.png)'), false);
  });

  it('ignores images inside HTML comments, including multi-line and unterminated ones', () => {
    assert.equal(hasImage('<!--\n![before](https://i.gyazo.com/a.png)\n-->\n'), false);
    assert.equal(hasImage('text\r\n<!-- <img src="https://i.gyazo.com/a.png">'), false);
  });

  it('ignores images inside fenced code blocks of either fence character', () => {
    assert.equal(hasImage('```markdown\n![before](https://i.gyazo.com/a.png)\n```\n'), false);
    assert.equal(hasImage('~~~\n<img src="https://i.gyazo.com/a.png">\n~~~\n'), false);
  });

  it('keeps a fenced block open until a closing fence of the same character and at least the same length', () => {
    assert.equal(hasImage('```\n~~~\n![x](https://i.gyazo.com/a.png)\n```\n'), false);
    assert.equal(hasImage('````\n```\n![x](https://i.gyazo.com/a.png)\n````\n'), false);
  });

  it('counts an image that follows a closed fenced code block', () => {
    assert.equal(hasImage('```\ncode\n```\n![after](https://i.gyazo.com/b.png)\n'), true);
  });

  it('ignores images inside inline code spans', () => {
    assert.equal(hasImage('書き方は `![alt](https://i.gyazo.com/a.png)` か ``<img src="u">``'), false);
  });
});

describe('evaluate', () => {
  it('passes a visual change whose PR body has an image', () => {
    assert.equal(evaluate({ ...feat({ body: IMAGE_BODY }), files: [CSS] }).verdict, 'has-image');
  });

  it('passes a visual change whose PR body has an <img src> tag', () => {
    const body = '<img alt="after" src="https://github.com/user-attachments/assets/x">';
    assert.equal(evaluate({ ...feat({ body }), files: [CSS] }).verdict, 'has-image');
  });

  it('fails a visual change whose PR body has no image and reports the matched files', () => {
    const outcome = evaluate({
      ...feat({ body: '## Summary\n\nfoo' }),
      files: [CSS, 'packages/verify/src/services/x.ts'],
    });
    assert.equal(outcome.ok, false);
    assert.deepEqual(outcome.visualFiles, [CSS]);
  });

  it('fails when the only image is inside an HTML comment', () => {
    const body = '## 見た目の証跡\n\n<!-- ![before](https://i.gyazo.com/a.png) -->\n';
    assert.equal(evaluate({ ...feat({ body }), files: [CSS] }).ok, false);
  });

  it('fails when the only image is inside a fenced code block', () => {
    const body = '```\n![before](https://i.gyazo.com/a.png)\n```\n';
    assert.equal(evaluate({ ...feat({ body }), files: [CSS] }).ok, false);
  });

  it('fails when the only image is inside inline code', () => {
    const body = '例: `<img src="https://i.gyazo.com/a.png">`';
    assert.equal(evaluate({ ...feat({ body }), files: [CSS] }).ok, false);
  });

  it('passes a visual change without an image when the no-visual-change label is set', () => {
    assert.equal(evaluate({ ...feat({ labels: ['no-visual-change'] }), files: [CSS] }).verdict, 'waived');
  });

  it('passes a PR that changes only non-visual paths (tests, translations, ui/tabs, verify ui/controllers)', () => {
    const files = [
      'packages/verify/src/ui/__tests__/ResultPanel.test.ts',
      'packages/verify/src/i18n/translations/en.ts',
      'packages/editor/src/ui/tabs/TabManager.ts',
      'packages/verify/src/ui/controllers/FileController.ts',
    ];
    assert.equal(evaluate({ ...feat(), files }).verdict, 'no-visual-files');
  });

  it('exempts docs / ci / chore typed titles even when visual files change', () => {
    for (const title of ['docs: foo', 'ci(repo): foo', 'chore!: foo']) {
      assert.equal(evaluate({ ...feat({ title }), files: [CSS] }).verdict, 'exempt', title);
    }
  });

  it('exempts dependency bumps and dependabot PRs', () => {
    assert.equal(evaluate({ ...feat({ title: 'fix(deps): bump foo' }), files: [CSS] }).verdict, 'exempt');
    assert.equal(evaluate({ ...feat({ author: 'dependabot[bot]' }), files: [CSS] }).verdict, 'exempt');
  });
});

describe('CLI', () => {
  function run(files, env) {
    return spawnSync(process.execPath, [SCRIPT], {
      input: `${files.join('\n')}\n`,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ...env },
    });
  }

  it('exits 1 with an ::error:: annotation when the PR body has no image', () => {
    const child = run([CSS], { PR_TITLE: 'feat: foo', PR_BODY: '', PR_LABELS: '[]' });
    assert.equal(child.status, 1);
    assert.match(child.stdout, /^::error /m);
  });

  it('exits 0 when the PR body has an image', () => {
    assert.equal(run([CSS], { PR_TITLE: 'feat: foo', PR_BODY: IMAGE_BODY }).status, 0);
  });

  it('exits 2 when PR_LABELS is not a JSON array', () => {
    assert.equal(run([CSS], { PR_TITLE: 'feat: foo', PR_LABELS: 'no-visual-change' }).status, 2);
  });
});
