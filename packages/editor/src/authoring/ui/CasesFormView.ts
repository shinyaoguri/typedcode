/**
 * ケースファイル (`*.cases.yaml`) のフォーム (#798)。エディタ群の表示 `form` (`documentViews.ts`)。
 *
 * - 左にケースの一覧 (名前・入出力例の印・照合が `exact` の印) と 追加 / 複製 / 削除、右に選んだケースの 名前・
 *   「入出力例として配る」(`public`)・照合 (`trim` / `exact`)・「入力」「期待する出力」(等幅・折り返さない複数行)
 * - 操作は文書の編集として扱う: `applyCasesFormOp` で作った新しいテキストを `AuthorWorkspace.setText` に渡す
 *   (未保存の印・保存・競合は他の文書と同じ。コメントと未知のキーは残る)
 * - **書き換えるのは利用者が変えた欄だけ**: `input` / `change` が起きた欄の値だけを操作に載せる。再描画や選択の
 *   切り替えでは文書に書かない (テキストエリアは値の改行を LF にそろえるので、触っていない CRLF の値を書き戻すと
 *   変わってしまう)。打った値は trim せずにそのまま渡す
 * - 打っている欄 (フォーカスのある欄) は `update` で書き換えない (カーソルと途中の綴りを保つ)。名前が空・重複の間は
 *   文書を書き換えず、欄の下に誤りを出す
 * - YAML が読めないときは理由を出し、テキストの表示に切り替えるボタンを出す
 * - 状態契約: `[data-cases-form]` に `data-state` (`ok` / `invalid`) と `data-case-count`。一覧の行
 *   `[data-case-index]` に `data-case-name` (名前そのもの)・`data-selected`・`data-public`・`data-match`。操作は `data-action` = `add-case` /
 *   `duplicate-case` / `delete-case` (行の選択は行の中の `data-action="select-case"`)。欄は `[data-field="case-name" |
 *   "case-public" | "case-match" | "case-stdin" | "case-stdout"]`。末尾の改行 `[data-trailing-newlines="stdin" |
 *   "stdout"]` に `data-count`、CRLF の注記 `[data-crlf-note="stdin" | "stdout"]`。名前の誤り
 *   `[data-field-error="case-name"]` に `data-reason` (`empty-name` / `duplicate-name`)。操作の失敗
 *   `[data-field-error="op"]`
 *
 * 教材の文字列 (名前・値) は textContent / value で入れる。
 */

import { t } from '../../i18n/index.js';
import type { ViewContext, ViewInstance } from './documentViews.js';
import { type CaseDefinition, type CaseMatch, parseCasesDefinition } from '../workspace/definitions.js';
import {
  applyCasesFormOp,
  CASE_MATCH_OPTIONS,
  type CaseFieldPatch,
  type CasesFormOp,
  containsCarriageReturn,
  countTrailingNewlines,
  duplicateCaseName,
  nextCaseName,
} from '../workspace/casesForm.js';

let idSeed = 0;

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

function actionButton(action: string, icon: string, label: string): HTMLButtonElement {
  const button = el('button', 'author-btn author-cases-op');
  button.type = 'button';
  button.dataset.action = action;
  const i = el('i', `fas ${icon}`);
  i.setAttribute('aria-hidden', 'true');
  button.append(i, ` ${label}`);
  return button;
}

type TextKey = 'stdin' | 'stdout';

interface TextField {
  readonly area: HTMLTextAreaElement;
  readonly trailing: HTMLElement;
  readonly crlf: HTMLElement;
  readonly wrap: HTMLElement;
}

export function mountCasesForm(context: ViewContext): ViewInstance {
  const { host, path, workspace } = context;
  const uid = `author-cases-${++idSeed}`;
  const root = el('div', 'author-cases-form');
  root.dataset.casesForm = '';

  // 読めないときの案内
  const invalid = el('div', 'author-exam-invalid');
  invalid.setAttribute('role', 'alert');
  const invalidIssues = el('ul', 'author-exam-issues');
  const openText = el('button', 'author-btn', t('author.cases.openText'));
  openText.type = 'button';
  openText.dataset.action = 'view-edit';
  openText.addEventListener('click', () => context.setView('edit'));
  invalid.append(el('p', 'author-error', t('author.cases.invalidDefinition')), invalidIssues, openText);

  // 一覧
  const body = el('div', 'author-cases-body');
  const side = el('div', 'author-cases-side');
  const ops = el('div', 'author-cases-ops');
  const addButton = actionButton('add-case', 'fa-plus', t('author.cases.add'));
  const duplicateButton = actionButton('duplicate-case', 'fa-clone', t('author.cases.duplicate'));
  const deleteButton = actionButton('delete-case', 'fa-trash', t('author.cases.remove'));
  ops.append(addButton, duplicateButton, deleteButton);
  const opError = el('p', 'author-exam-field-error', t('author.cases.opFailed'));
  opError.dataset.fieldError = 'op';
  opError.setAttribute('role', 'alert');
  opError.hidden = true;
  const list = el('ul', 'author-exam-list author-cases-list');
  list.dataset.list = 'cases';
  list.setAttribute('aria-label', t('author.cases.list'));
  const empty = el('p', 'author-explorer-empty', t('author.cases.empty'));
  side.append(el('h3', 'author-exam-heading', t('author.cases.heading')), ops, opError, empty, list);

  // 選んだケースの欄
  const detail = el('div', 'author-cases-detail');
  detail.setAttribute('role', 'group');
  const nameInput = el('input', 'author-input');
  nameInput.type = 'text';
  nameInput.id = `${uid}-name`;
  nameInput.dataset.field = 'case-name';
  nameInput.autocomplete = 'off';
  nameInput.spellcheck = false;
  const nameError = el('p', 'author-exam-field-error');
  nameError.id = `${uid}-name-error`;
  nameError.dataset.fieldError = 'case-name';
  nameError.hidden = true;
  nameInput.setAttribute('aria-describedby', nameError.id);
  const nameField = el('div', 'author-field');
  const nameLabel = el('label', 'author-field-label', t('author.cases.name'));
  nameLabel.htmlFor = nameInput.id;
  nameField.append(nameLabel, nameInput, nameError);

  const publicInput = el('input');
  publicInput.type = 'checkbox';
  publicInput.dataset.field = 'case-public';
  publicInput.id = `${uid}-public`;
  const publicHint = el('p', 'author-hint', t('author.cases.publicHint'));
  publicHint.id = `${uid}-public-hint`;
  publicInput.setAttribute('aria-describedby', publicHint.id);
  const publicLabel = el('label', 'author-check');
  publicLabel.htmlFor = publicInput.id;
  publicLabel.append(publicInput, el('span', undefined, t('author.cases.public')));
  const publicField = el('div', 'author-field');
  publicField.append(publicLabel, publicHint);

  const matchSelect = el('select', 'author-input');
  matchSelect.dataset.field = 'case-match';
  matchSelect.id = `${uid}-match`;
  for (const match of CASE_MATCH_OPTIONS) {
    const option = el('option', undefined, t(match === 'trim' ? 'author.cases.matchTrim' : 'author.cases.matchExact'));
    option.value = match;
    matchSelect.appendChild(option);
  }
  const matchField = el('div', 'author-field');
  const matchLabel = el('label', 'author-field-label', t('author.cases.match'));
  matchLabel.htmlFor = matchSelect.id;
  matchField.append(matchLabel, matchSelect);

  const textField = (key: TextKey, label: string): TextField => {
    const area = el('textarea', 'author-textarea author-mono author-cases-text');
    area.id = `${uid}-${key}`;
    area.dataset.field = `case-${key}`;
    area.rows = 6;
    area.wrap = 'off';
    area.spellcheck = false;
    area.autocomplete = 'off';
    const trailing = el('span', 'author-cases-trailing');
    trailing.dataset.trailingNewlines = key;
    trailing.id = `${uid}-${key}-trailing`;
    const crlf = el('span', 'author-cases-crlf', t('author.cases.crlfNote'));
    crlf.dataset.crlfNote = key;
    crlf.id = `${uid}-${key}-crlf`;
    crlf.hidden = true;
    area.setAttribute('aria-describedby', `${trailing.id} ${crlf.id}`);
    const meta = el('p', 'author-hint author-cases-meta');
    meta.append(trailing, crlf);
    const wrap = el('div', 'author-field');
    const labelEl = el('label', 'author-field-label', label);
    labelEl.htmlFor = area.id;
    wrap.append(labelEl, area, meta);
    return { area, trailing, crlf, wrap };
  };
  const stdinField = textField('stdin', t('author.cases.stdin'));
  const stdoutField = textField('stdout', t('author.cases.stdout'));
  detail.append(nameField, publicField, matchField, stdinField.wrap, stdoutField.wrap);

  body.append(side, detail);
  root.append(invalid, body);
  host.replaceChildren(root);

  /** 選んだケースの位置 (ケースが無ければ -1) */
  let selected = 0;
  /** 欄に今出しているケースの位置 (選択が変わったら欄を必ず入れ直す) */
  let shown = -2;
  let listSignature = '';
  let current: CaseDefinition[] = [];

  const showNameError = (reason: 'empty-name' | 'duplicate-name' | null): void => {
    nameError.hidden = reason === null;
    if (reason === null) {
      delete nameError.dataset.reason;
      nameError.textContent = '';
      nameInput.removeAttribute('aria-invalid');
      return;
    }
    nameError.dataset.reason = reason;
    nameError.textContent = t(reason === 'empty-name' ? 'author.cases.nameEmpty' : 'author.cases.nameDuplicate');
    nameInput.setAttribute('aria-invalid', 'true');
  };

  /** 操作を当てる。名前の誤りは欄の下に、それ以外の失敗は一覧の上に出す。当てられなければ false */
  const apply = (op: CasesFormOp): boolean => {
    const doc = workspace.document(path);
    if (!doc) return false;
    const result = applyCasesFormOp(doc.text, op);
    if (!result.ok) {
      const { error } = result;
      if (error.kind === 'empty-name' || error.kind === 'duplicate-name') showNameError(error.kind);
      else opError.hidden = false;
      return false;
    }
    opError.hidden = true;
    if (op.kind === 'edit' && op.patch.name !== undefined) showNameError(null);
    selected = result.selected;
    workspace.setText(path, result.text);
    // 変化が無ければ通知が来ないので、選択の変化をここで描く
    update();
    return true;
  };

  const edit = (patch: CaseFieldPatch): void => {
    if (selected < 0) return;
    apply({ kind: 'edit', index: selected, patch });
  };

  // 利用者が変えた欄だけを載せる (値はそのまま。trim しない)
  nameInput.addEventListener('input', () => edit({ name: nameInput.value }));
  publicInput.addEventListener('change', () => edit({ public: publicInput.checked }));
  matchSelect.addEventListener('change', () => edit({ match: matchSelect.value as CaseMatch }));
  stdinField.area.addEventListener('input', () => edit({ stdin: stdinField.area.value }));
  stdoutField.area.addEventListener('input', () => edit({ stdout: stdoutField.area.value }));

  const focusName = (): void => {
    nameInput.focus();
    nameInput.select();
  };

  addButton.addEventListener('click', () => {
    const name = nextCaseName(current, (n) => t('author.cases.defaultName', { n }));
    if (apply({ kind: 'add', name })) focusName();
  });
  duplicateButton.addEventListener('click', () => {
    const original = current[selected];
    if (!original) return;
    const name = duplicateCaseName(current, original.name, (base, n) => t('author.cases.copyName', { name: base, n }));
    if (apply({ kind: 'duplicate', index: selected, name })) focusName();
  });
  deleteButton.addEventListener('click', () => {
    if (selected < 0) return;
    if (!apply({ kind: 'remove', index: selected })) return;
    // 削除の後は隣の行へ (無ければ「追加」へ) フォーカスを移す
    const row = list.querySelector<HTMLButtonElement>(`li[data-case-index="${selected}"] [data-action="select-case"]`);
    (row ?? addButton).focus();
  });
  list.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('li[data-case-index]');
    if (!row) return;
    selected = Number(row.dataset.caseIndex);
    update();
  });

  const row = (item: CaseDefinition, index: number): HTMLLIElement => {
    const li = el('li', 'author-exam-row author-cases-row');
    li.dataset.caseIndex = String(index);
    li.dataset.caseName = item.name;
    li.dataset.selected = String(index === selected);
    li.dataset.public = String(item.public);
    li.dataset.match = item.match;
    const button = el('button', 'author-cases-item');
    button.type = 'button';
    button.dataset.action = 'select-case';
    button.setAttribute('aria-pressed', String(index === selected));
    const marks: string[] = [];
    if (item.public) marks.push(t('author.cases.publicMark'));
    if (item.match === 'exact') marks.push(t('author.cases.exactMark'));
    button.setAttribute('aria-label', [item.name, ...marks].join(' / '));
    const label = el('span', 'author-exam-label', item.name);
    label.title = item.name;
    button.appendChild(label);
    if (item.public) button.appendChild(el('span', 'author-cases-badge', t('author.cases.publicMark')));
    if (item.match === 'exact') {
      button.appendChild(el('span', 'author-cases-badge author-cases-badge-exact', t('author.cases.exactMark')));
    }
    li.appendChild(button);
    return li;
  };

  const showText = (field: TextField, value: string, force: boolean): void => {
    // 打っている欄は書き換えない (カーソルと途中の内容を保つ)
    if (force || document.activeElement !== field.area) field.area.value = value;
    const count = countTrailingNewlines(value);
    field.trailing.dataset.count = String(count);
    field.trailing.textContent =
      count === 0 ? t('author.cases.trailingNone') : t('author.cases.trailingCount', { n: count });
    field.crlf.hidden = !containsCarriageReturn(value);
  };

  const update = (): void => {
    const doc = workspace.document(path);
    if (!doc) return;
    const parsed = parseCasesDefinition(doc.text);
    if (!parsed.ok) {
      root.dataset.state = 'invalid';
      delete root.dataset.caseCount;
      invalid.hidden = false;
      body.hidden = true;
      invalidIssues.replaceChildren(
        ...parsed.issues.map((issue) =>
          el('li', undefined, 'key' in issue && issue.key ? `${issue.kind}: ${issue.key}` : issue.kind)
        )
      );
      listSignature = '';
      shown = -2;
      current = [];
      return;
    }
    root.dataset.state = 'ok';
    invalid.hidden = true;
    body.hidden = false;
    current = parsed.value;
    root.dataset.caseCount = String(current.length);
    if (current.length === 0) selected = -1;
    else selected = Math.min(Math.max(selected, 0), current.length - 1);

    // 一覧 (変わらなければ描き直さない。フォーカスを保つ)
    const nextSignature = JSON.stringify([selected, current.map((c) => [c.name, c.public, c.match])]);
    if (nextSignature !== listSignature) {
      const focusedIndex = list.contains(document.activeElement)
        ? (document.activeElement?.closest<HTMLElement>('li[data-case-index]')?.dataset.caseIndex ?? null)
        : null;
      listSignature = nextSignature;
      list.replaceChildren(...current.map(row));
      if (focusedIndex !== null) {
        const index = Math.min(Number(focusedIndex), current.length - 1);
        list.querySelector<HTMLElement>(`li[data-case-index="${index}"] button`)?.focus();
      }
    }
    empty.hidden = current.length > 0;
    duplicateButton.disabled = selected < 0;
    deleteButton.disabled = selected < 0;

    // 選んだケースの欄
    const item = current[selected];
    detail.hidden = item === undefined;
    if (!item) {
      shown = -1;
      return;
    }
    const force = shown !== selected;
    shown = selected;
    detail.setAttribute('aria-label', item.name);
    if (force || document.activeElement !== nameInput) {
      nameInput.value = item.name;
      showNameError(null);
    }
    // チェックと選択は途中の状態を持たないので、いつも文書の値に合わせる
    publicInput.checked = item.public;
    matchSelect.value = item.match;
    showText(stdinField, item.stdin, force);
    showText(stdoutField, item.stdout, force);
  };

  update();
  return {
    update,
    dispose: () => host.replaceChildren(),
  };
}
