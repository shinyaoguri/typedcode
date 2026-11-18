/**
 * 試験定義の学生プレビュー (#797)。エディタ群の表示 `preview` (`documentViews.ts`)。
 *
 * - 採用した問題を出題順に、問題文 (`renderMarkdown`)・初期コード (ファイル名つき)・入出力例 (`public: true` のケース) で見せる。
 *   解答例・ヒント・非公開ケースは変換 (`buildExamBundleProblems`) が落とすので出ない
 * - 開いている文書の**未保存の内容**を重ねて変換する (`AuthorWorkspace.previewExam`)。書き出しは保存済みだけが対象
 * - 欠損・重複・読めない定義があれば、問題を出さずに一覧 (`issueList.ts`) を出す
 * - 打鍵のたびの変換を間引く (`PREVIEW_DEBOUNCE_MS`)。後から始めた変換が勝つ
 * - 状態契約: `[data-exam-preview]` に `data-preview-state` (`loading` / `ok` / `empty` / `issues`)。問題は
 *   `[data-preview-problem="<problemId>"]` と `data-index` (0 始まり)。初期コードは `[data-role="starter"]` と
 *   `data-filename`。入出力例は `[data-example-index]` と `[data-role="name" | "stdin" | "stdout" | "no-input"]`
 *
 * 例・初期コードの中身は textContent で入れる (教材の文字列を HTML にしない)。問題文は sanitize 済みの Markdown。
 */

import type { ExamBundleProblem } from '@typedcode/shared';
import { t } from '../../i18n/index.js';
import { renderMarkdown } from '../../utils/markdown.js';
import type { ViewContext, ViewInstance } from './documentViews.js';
import { renderIssueList } from './issueList.js';

export const PREVIEW_DEBOUNCE_MS = 150;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 表示用: 末尾の改行 1 つを除く (受験者の問題パネルと同じ) */
function displayText(text: string): string {
  return text.replace(/\r?\n$/, '');
}

function renderProblem(problem: ExamBundleProblem, index: number): HTMLElement {
  const section = el('section', 'author-preview-problem');
  section.dataset.previewProblem = problem.problemId;
  section.dataset.index = String(index);
  section.appendChild(
    el('h2', 'author-preview-title', `${t('author.preview.problem', { n: index + 1 })}: ${problem.problemId}`)
  );
  const statement = el('div', 'markdown-rendered');
  statement.innerHTML = renderMarkdown(problem.statement);
  section.appendChild(statement);

  if (problem.starter) {
    const figure = el('figure', 'author-preview-starter');
    figure.dataset.role = 'starter';
    figure.dataset.filename = problem.starter.filename;
    const caption = el('figcaption', 'problem-example-label');
    caption.append(el('span', undefined, t('author.preview.starter')), el('code', undefined, problem.starter.filename));
    const pre = el('pre', 'problem-example-io', problem.starter.content);
    figure.append(caption, pre);
    section.appendChild(figure);
  }

  const examples = problem.examples ?? [];
  if (examples.length > 0) {
    const block = el('section', 'problem-examples');
    block.dataset.exampleCount = String(examples.length);
    block.appendChild(el('h3', 'problem-examples-heading', t('author.preview.examples')));
    examples.forEach((example, i) => {
      const item = el('div', 'problem-example');
      item.dataset.exampleIndex = String(i);
      const name = el('div', 'problem-example-name', example.name);
      name.dataset.role = 'name';
      item.append(name, el('div', 'problem-example-label', t('problemExamples.input')));
      if (example.stdin.length > 0) {
        const stdin = el('pre', 'problem-example-io', displayText(example.stdin));
        stdin.dataset.role = 'stdin';
        item.appendChild(stdin);
      } else {
        const none = el('p', 'problem-example-noinput', t('problemExamples.noInput'));
        none.dataset.role = 'no-input';
        item.appendChild(none);
      }
      const stdout = el('pre', 'problem-example-io', displayText(example.stdout));
      stdout.dataset.role = 'stdout';
      item.append(el('div', 'problem-example-label', t('problemExamples.output')), stdout);
      block.appendChild(item);
    });
    section.appendChild(block);
  }
  return section;
}

export function mountExamPreview(context: ViewContext): ViewInstance {
  const { host, path, workspace } = context;
  const root = el('div', 'author-exam-preview');
  root.dataset.examPreview = '';
  root.dataset.previewState = 'loading';
  const note = el('p', 'author-hint', t('author.preview.note'));
  const body = el('div', 'author-exam-preview-body');
  body.appendChild(el('p', 'author-hint', t('author.preview.loading')));
  root.append(note, body);
  host.replaceChildren(root);

  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const build = async (): Promise<void> => {
    const mine = ++seq;
    const result = await workspace.previewExam(path);
    if (disposed || mine !== seq) return;
    if (!result.ok) {
      root.dataset.previewState = 'issues';
      const wrap = el('div', 'author-error');
      wrap.setAttribute('role', 'alert');
      wrap.append(el('p', undefined, t('author.preview.issuesHeading')), renderIssueList(result.issues));
      body.replaceChildren(wrap);
      return;
    }
    if (result.problems.length === 0) {
      root.dataset.previewState = 'empty';
      body.replaceChildren(el('p', 'author-explorer-empty', t('author.preview.empty')));
      return;
    }
    root.dataset.previewState = 'ok';
    body.replaceChildren(...result.problems.map(renderProblem));
  };

  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void build();
    }, PREVIEW_DEBOUNCE_MS);
  };

  // 開いたときは外部で足された・消されたファイルも拾うよう索引を読み直す (読み直しの通知で描き直す)
  void workspace.refresh().catch(() => undefined);
  void build();

  return {
    update: schedule,
    dispose: () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      host.replaceChildren();
    },
  };
}
