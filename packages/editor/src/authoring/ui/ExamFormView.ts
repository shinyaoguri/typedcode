/**
 * 試験定義 (`*.exam.yaml`) のフォーム (#797)。エディタ群の表示 `form` (`documentViews.ts`)。
 *
 * - examId・種類 (試験 `.tcexam` / 授業 `.tcclass`)・許可言語 (カンマ区切り) と、採用した問題 (出題順) / 未採用の問題の一覧
 * - 操作は文書の編集として扱う: `applyExamFormOp` で作った新しいテキストを `AuthorWorkspace.setText` に渡す
 *   (未保存の印・保存・競合は他の文書と同じ。コメントと未知のキーは残る)
 * - 並べ替えは行の 上へ / 下へ ボタン (キーボード) と、行のドラッグの両方。操作の後は同じ行のボタンへフォーカスを戻す
 * - YAML が読めないときは理由を出し、テキストの表示に切り替えるボタンを出す
 * - 状態契約: `[data-exam-form]` に `data-state` (`ok` / `invalid`)。入力欄は `[data-field="exam-id" | "kind" | "languages"]`。
 *   採用した行 `[data-exam-problem="<問題定義のパス>"]` (参照が解決できなければ参照の綴り) に `data-index`・`data-state`
 *   (`ok` / `missing` / `invalid`)・欠損なら `data-missing="true"`、行の操作は `data-action` = `move-up` / `move-down` /
 *   `remove`。未採用の行 `[data-available-problem="<パス>"]` の操作は `data-action="adopt"`
 *
 * 教材の文字列 (名前・パス) は textContent で入れる。
 */

import { t } from '../../i18n/index.js';
import type { ViewContext, ViewInstance } from './documentViews.js';
import { parseExamDefinition } from '../workspace/definitions.js';
import {
  type AdoptedProblem,
  applyExamFormOp,
  type ExamFormModel,
  type ExamFormOp,
  examFormModel,
  parseLanguageList,
} from '../workspace/examForm.js';

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

function iconButton(action: string, icon: string, label: string, disabled = false): HTMLButtonElement {
  const button = el('button', 'author-icon-btn');
  button.type = 'button';
  button.dataset.action = action;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.disabled = disabled;
  const i = el('i', `fas ${icon}`);
  i.setAttribute('aria-hidden', 'true');
  button.appendChild(i);
  return button;
}

function labeled(label: string, control: HTMLElement): HTMLLabelElement {
  const wrap = el('label', 'author-field');
  wrap.append(el('span', 'author-field-label', label), control);
  return wrap;
}

export function mountExamForm(context: ViewContext): ViewInstance {
  const { host, path, workspace } = context;
  const root = el('div', 'author-exam-form');
  root.dataset.examForm = '';

  // 読めないときの案内
  const invalid = el('div', 'author-exam-invalid');
  invalid.setAttribute('role', 'alert');
  const invalidText = el('p', 'author-error', t('author.exam.invalidDefinition'));
  const invalidIssues = el('ul', 'author-exam-issues');
  const openText = el('button', 'author-btn', t('author.exam.openText'));
  openText.type = 'button';
  openText.dataset.action = 'view-edit';
  openText.addEventListener('click', () => context.setView('edit'));
  invalid.append(invalidText, invalidIssues, openText);

  // 入力欄
  const fields = el('div', 'author-exam-fields');
  const examId = el('input', 'author-input');
  examId.type = 'text';
  examId.dataset.field = 'exam-id';
  examId.autocomplete = 'off';
  examId.spellcheck = false;
  const examIdError = el('p', 'author-exam-field-error', t('author.exam.fieldInvalid'));
  examIdError.hidden = true;
  const kind = el('select', 'author-input');
  kind.dataset.field = 'kind';
  for (const [value, key] of [
    ['exam', 'author.exam.kindExam'],
    ['class', 'author.exam.kindClass'],
  ] as const) {
    const option = el('option', undefined, t(key));
    option.value = value;
    kind.appendChild(option);
  }
  const languages = el('input', 'author-input');
  languages.type = 'text';
  languages.dataset.field = 'languages';
  languages.autocomplete = 'off';
  languages.spellcheck = false;
  languages.placeholder = 'c, python';
  const idField = labeled(t('author.exam.examId'), examId);
  idField.appendChild(examIdError);
  fields.append(idField, labeled(t('author.exam.kind'), kind), labeled(t('author.exam.languages'), languages));

  // 一覧
  const adoptedHeading = el('h3', 'author-exam-heading', t('author.exam.adopted'));
  const dragHint = el('p', 'author-hint', t('author.exam.dragHint'));
  const adoptedList = el('ol', 'author-exam-list');
  adoptedList.dataset.list = 'adopted';
  // 行が無くなったときのフォーカスの戻り先
  adoptedList.tabIndex = -1;
  adoptedList.setAttribute('aria-label', t('author.exam.adopted'));
  const adoptedEmpty = el('p', 'author-explorer-empty', t('author.exam.noAdopted'));
  const availableHeading = el('h3', 'author-exam-heading', t('author.exam.available'));
  const availableList = el('ul', 'author-exam-list');
  availableList.dataset.list = 'available';
  const availableEmpty = el('p', 'author-explorer-empty', t('author.exam.noAvailable'));
  fields.append(adoptedHeading, dragHint, adoptedEmpty, adoptedList, availableHeading, availableEmpty, availableList);

  root.append(invalid, fields);
  host.replaceChildren(root);

  let signature = '';
  let dragFrom: number | null = null;

  /** 操作を当てる。当てられなければ false */
  const apply = (op: ExamFormOp): boolean => {
    const doc = workspace.document(path);
    if (!doc) return false;
    const result = applyExamFormOp(path, doc.text, op);
    if (!result.ok) return false;
    workspace.setText(path, result.text);
    return true;
  };

  /** 操作の後、同じ行 (無ければ同じ位置の行) のボタンへフォーカスを戻す */
  const refocus = (list: HTMLElement, rowSelector: string, index: number, action: string): void => {
    const rows = [...list.querySelectorAll<HTMLElement>(':scope > li')];
    const row = list.querySelector<HTMLElement>(rowSelector) ?? rows[Math.min(index, rows.length - 1)];
    const buttons = [...(row?.querySelectorAll<HTMLButtonElement>('button') ?? [])].filter((b) => !b.disabled);
    const target = buttons.find((b) => b.dataset.action === action) ?? buttons[0];
    if (target) target.focus();
    else list.parentElement?.querySelector<HTMLElement>('[data-list="adopted"]')?.focus();
  };

  examId.addEventListener('input', () => {
    const ok = apply({ kind: 'set-exam-id', examId: examId.value.trim() });
    examIdError.hidden = ok;
    examId.setAttribute('aria-invalid', String(!ok));
  });
  kind.addEventListener('change', () => {
    apply({ kind: 'set-kind', examKind: kind.value === 'class' ? 'class' : 'exam' });
  });
  languages.addEventListener('input', () => {
    apply({ kind: 'set-languages', languages: parseLanguageList(languages.value) });
  });

  adoptedList.addEventListener('click', (e) => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
    const row = button?.closest<HTMLElement>('li[data-index]');
    if (!button || !row) return;
    const index = Number(row.dataset.index);
    const action = button.dataset.action!;
    const selector = `li[data-exam-problem="${CSS.escape(row.dataset.examProblem ?? '')}"]`;
    if (action === 'move-up') apply({ kind: 'move', from: index, to: index - 1 });
    else if (action === 'move-down') apply({ kind: 'move', from: index, to: index + 1 });
    else if (action === 'remove') apply({ kind: 'remove', index });
    else return;
    refocus(adoptedList, action === 'remove' ? ':scope > li:not(*)' : selector, index, action);
  });
  availableList.addEventListener('click', (e) => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action="adopt"]');
    const row = button?.closest<HTMLElement>('li[data-available-problem]');
    if (!button || !row) return;
    const index = [...availableList.children].indexOf(row);
    if (apply({ kind: 'adopt', problemPath: row.dataset.availableProblem! })) {
      refocus(availableList, ':scope > li:not(*)', index, 'adopt');
    }
  });

  // ドラッグで並べ替え (キーボードは上へ / 下へ のボタン)
  adoptedList.addEventListener('dragstart', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('li[data-index]');
    if (!row) return;
    dragFrom = Number(row.dataset.index);
    e.dataTransfer?.setData('text/plain', row.dataset.index!);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    row.classList.add('dragging');
  });
  adoptedList.addEventListener('dragover', (e) => {
    if (dragFrom === null) return;
    const row = (e.target as HTMLElement).closest<HTMLElement>('li[data-index]');
    if (!row) return;
    e.preventDefault();
    for (const item of adoptedList.querySelectorAll('.drop-target')) item.classList.remove('drop-target');
    row.classList.add('drop-target');
  });
  adoptedList.addEventListener('drop', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('li[data-index]');
    const from = dragFrom;
    dragFrom = null;
    if (!row || from === null) return;
    e.preventDefault();
    const to = Number(row.dataset.index);
    if (to !== from) apply({ kind: 'move', from, to });
  });
  adoptedList.addEventListener('dragend', () => {
    dragFrom = null;
    for (const item of adoptedList.querySelectorAll('.dragging, .drop-target')) {
      item.classList.remove('dragging', 'drop-target');
    }
  });

  const adoptedRow = (problem: AdoptedProblem, count: number): HTMLLIElement => {
    const row = el('li', 'author-exam-row');
    const key = problem.path ?? problem.reference;
    row.dataset.examProblem = key;
    row.dataset.index = String(problem.index);
    row.dataset.state = problem.state;
    if (problem.state !== 'ok') row.dataset.missing = 'true';
    row.draggable = true;
    const name = problem.label ?? key;
    const order = el('span', 'author-exam-order', `${problem.index + 1}.`);
    const label = el('span', 'author-exam-label', name);
    label.title = key;
    row.append(order, label);
    const marks: string[] = [];
    if (problem.state === 'missing') marks.push(t('author.exam.missing'));
    if (problem.state === 'invalid') marks.push(t('author.exam.invalid'));
    if (problem.duplicate) marks.push(t('author.exam.duplicate'));
    if (marks.length > 0) {
      row.classList.add('missing');
      const mark = el('span', 'author-exam-mark');
      const icon = el('i', 'fas fa-circle-exclamation');
      icon.setAttribute('aria-hidden', 'true');
      mark.append(icon, ` ${marks.join(' / ')}`);
      row.appendChild(mark);
    }
    const actions = el('span', 'author-exam-actions');
    actions.append(
      iconButton('move-up', 'fa-arrow-up', `${t('author.exam.moveUp')}: ${name}`, problem.index === 0),
      iconButton('move-down', 'fa-arrow-down', `${t('author.exam.moveDown')}: ${name}`, problem.index === count - 1),
      iconButton('remove', 'fa-xmark', `${t('author.exam.remove')}: ${name}`)
    );
    row.appendChild(actions);
    return row;
  };

  const render = (model: ExamFormModel): void => {
    adoptedList.replaceChildren(...model.adopted.map((p) => adoptedRow(p, model.adopted.length)));
    adoptedEmpty.hidden = model.adopted.length > 0;
    dragHint.hidden = model.adopted.length < 2;
    availableList.replaceChildren(
      ...model.available.map((problem) => {
        const row = el('li', 'author-exam-row');
        row.dataset.availableProblem = problem.path;
        const label = el('span', 'author-exam-label', problem.label);
        label.title = problem.path;
        const actions = el('span', 'author-exam-actions');
        const adopt = el('button', 'author-btn', t('author.exam.adopt'));
        adopt.type = 'button';
        adopt.dataset.action = 'adopt';
        adopt.setAttribute('aria-label', `${t('author.exam.adopt')}: ${problem.label}`);
        actions.appendChild(adopt);
        row.append(label, actions);
        return row;
      })
    );
    availableEmpty.hidden = model.available.length > 0;
  };

  const update = (): void => {
    const doc = workspace.document(path);
    if (!doc) return;
    const parsed = parseExamDefinition(doc.text);
    if (!parsed.ok) {
      root.dataset.state = 'invalid';
      invalid.hidden = false;
      fields.hidden = true;
      invalidIssues.replaceChildren(
        ...parsed.issues.map((issue) =>
          el('li', undefined, 'key' in issue && issue.key ? `${issue.kind}: ${issue.key}` : issue.kind)
        )
      );
      signature = '';
      return;
    }
    root.dataset.state = 'ok';
    invalid.hidden = true;
    fields.hidden = false;
    const exam = parsed.value;
    // 打っている欄は書き換えない (カーソルと途中の綴りを保つ)
    if (document.activeElement !== examId) {
      examId.value = exam.examId;
      examIdError.hidden = true;
      examId.removeAttribute('aria-invalid');
    }
    if (document.activeElement !== kind) kind.value = exam.kind;
    if (document.activeElement !== languages) languages.value = exam.languages.join(', ');
    const model = examFormModel(path, exam, workspace.index);
    // 一覧が変わらなければ描き直さない (フォーカスを保つ)
    const next = JSON.stringify([model.adopted, model.available]);
    if (next === signature) return;
    signature = next;
    render(model);
  };

  update();
  return {
    update,
    dispose: () => host.replaceChildren(),
  };
}
