/**
 * 作問画面のダイアログ (#796)。`window.prompt` / `confirm` を使わず `showModal` で作る (E2E が操作できるように)。
 *
 * どれも overlay に `data-dialog`、ボタンに `data-action` を付ける (packages/editor/AGENTS.md「状態契約」):
 * - `new-problem` / `create-folder` (名前の入力): 入力欄 `[data-field="name"]`、`ok` / `cancel`
 * - `add-part`: `select[data-field="role"]`・`[data-field="name"]`、`ok` / `cancel`
 * - `assign-part`: `select[data-field="role"]`・`select[data-field="path"]`、`ok` / `cancel`
 * - `conflict`: `reload` / `overwrite` / `cancel`
 * - `unsaved` (未保存のまま進むか): `discard` / `cancel`
 *
 * 利用者の文字列 (パス・名前) はすべて escape してから HTML に入れる。
 */

import { escapeHtml } from '@typedcode/shared';
import { t } from '../../i18n/index.js';
import { type ModalButton, showModal } from '../../ui/components/Modal.js';
import type { AddableRole } from '../workspace/authorWorkspace.js';
import type { FolderConflictReason } from '../workspace/materialFolder.js';
import { roleLabel } from './messages.js';

interface FormDialogOptions {
  dialogName: string;
  title: string;
  icon: string;
  /** 入力欄などの中身 (escape 済みの HTML) */
  body: string;
  /** OK のとき。エラーの文を返すと閉じずに表示する */
  submit: (form: HTMLElement) => string | null;
  /** 開いた直後 (既定値の設定やイベントの配線) */
  setup?: (form: HTMLElement) => void;
  okDisabled?: boolean;
}

/** OK / キャンセルのフォームを出す。OK で閉じたら true */
async function formDialog(options: FormDialogOptions): Promise<boolean> {
  let accepted = false;
  let form: HTMLElement | null = null;
  const buttons: ModalButton[] = [
    {
      text: escapeHtml(t('author.dialogs.ok')),
      type: 'primary',
      action: 'ok',
      disabled: options.okDisabled,
      onClick: () => {
        if (!form) return false;
        const error = options.submit(form);
        const errorEl = form.querySelector<HTMLElement>('.author-dialog-error');
        if (error !== null) {
          if (errorEl) {
            errorEl.textContent = error;
            errorEl.hidden = false;
          }
          return false;
        }
        accepted = true;
        return true;
      },
    },
    { text: escapeHtml(t('author.dialogs.cancel')), type: 'cancel', action: 'cancel' },
  ];
  const closed = showModal({
    title: escapeHtml(options.title),
    icon: options.icon,
    content: `<div class="author-dialog-form">${options.body}<p class="author-dialog-error" role="alert" hidden></p></div>`,
    buttons,
    dialogName: options.dialogName,
    className: 'author-dialog',
  });
  // showModal は overlay を同期で body に足す
  const overlays = document.querySelectorAll<HTMLElement>(`.modal-overlay[data-dialog="${options.dialogName}"]`);
  const overlay = overlays[overlays.length - 1];
  form = overlay?.querySelector<HTMLElement>('.author-dialog-form') ?? null;
  if (form) {
    options.setup?.(form);
    const okButton = overlay?.querySelector<HTMLButtonElement>('[data-action="ok"]');
    // 入力欄で Enter を押したら OK
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
        e.preventDefault();
        okButton?.click();
      }
    });
    const first = form.querySelector<HTMLElement>('input, select');
    first?.focus();
    if (first instanceof HTMLInputElement) first.select();
  }
  await closed;
  return accepted;
}

function field(label: string, control: string): string {
  return `<label class="author-field"><span>${escapeHtml(label)}</span>${control}</label>`;
}

function roleSelect(roles: readonly AddableRole[]): string {
  const options = roles.map((role) => `<option value="${role}">${escapeHtml(roleLabel(role))}</option>`).join('');
  return `<select class="author-input" data-field="role">${options}</select>`;
}

/** 名前を 1 つ入れさせる。キャンセルなら null */
export async function promptName(options: {
  dialogName: string;
  title: string;
  label: string;
  initial?: string;
  validate?: (value: string) => string | null;
}): Promise<string | null> {
  let value: string | null = null;
  const ok = await formDialog({
    dialogName: options.dialogName,
    title: options.title,
    icon: 'fa-pen',
    body: field(
      options.label,
      `<input type="text" class="author-input" data-field="name" autocomplete="off" spellcheck="false" value="${escapeHtml(options.initial ?? '')}">`
    ),
    submit: (form) => {
      const input = form.querySelector<HTMLInputElement>('[data-field="name"]')!;
      const error = options.validate?.(input.value) ?? null;
      if (error === null) value = input.value;
      return error;
    },
  });
  return ok ? value : null;
}

/** 要素を新しいファイルで足す: 役割とファイル名。役割を変えると既定の名前を差し替える */
export async function addPartDialog(options: {
  roles: readonly AddableRole[];
  defaultName: (role: AddableRole) => string;
}): Promise<{ role: AddableRole; name: string } | null> {
  let result: { role: AddableRole; name: string } | null = null;
  const ok = await formDialog({
    dialogName: 'add-part',
    title: t('author.dialogs.addPartTitle'),
    icon: 'fa-file-circle-plus',
    body: [
      field(t('author.dialogs.roleLabel'), roleSelect(options.roles)),
      field(
        t('author.dialogs.fileNameLabel'),
        '<input type="text" class="author-input" data-field="name" autocomplete="off" spellcheck="false">'
      ),
    ].join(''),
    setup: (form) => {
      const select = form.querySelector<HTMLSelectElement>('[data-field="role"]')!;
      const input = form.querySelector<HTMLInputElement>('[data-field="name"]')!;
      const fill = (): void => {
        input.value = options.defaultName(select.value as AddableRole);
      };
      fill();
      select.addEventListener('change', fill);
    },
    submit: (form) => {
      const role = form.querySelector<HTMLSelectElement>('[data-field="role"]')!.value as AddableRole;
      const name = form.querySelector<HTMLInputElement>('[data-field="name"]')!.value.trim();
      if (name === '') return t('author.notices.invalidName', { name });
      result = { role, name };
      return null;
    },
  });
  return ok ? result : null;
}

/** 既存のファイルを要素に割り当てる: 役割とフォルダ内のファイル */
export async function assignPartDialog(options: {
  roles: readonly AddableRole[];
  files: readonly string[];
}): Promise<{ role: AddableRole; path: string } | null> {
  let result: { role: AddableRole; path: string } | null = null;
  const fileOptions = options.files
    .map((file) => `<option value="${escapeHtml(file)}">${escapeHtml(file)}</option>`)
    .join('');
  const ok = await formDialog({
    dialogName: 'assign-part',
    title: t('author.dialogs.assignPartTitle'),
    icon: 'fa-link',
    body: [
      field(t('author.dialogs.roleLabel'), roleSelect(options.roles)),
      options.files.length > 0
        ? field(
            t('author.dialogs.fileLabel'),
            `<select class="author-input" data-field="path" size="${Math.min(10, Math.max(4, options.files.length))}">${fileOptions}</select>`
          )
        : `<p class="author-hint">${escapeHtml(t('author.dialogs.noFiles'))}</p>`,
    ].join(''),
    okDisabled: options.files.length === 0,
    setup: (form) => {
      const select = form.querySelector<HTMLSelectElement>('[data-field="path"]');
      if (select && select.selectedIndex === -1) select.selectedIndex = 0;
    },
    submit: (form) => {
      const role = form.querySelector<HTMLSelectElement>('[data-field="role"]')!.value as AddableRole;
      const path = form.querySelector<HTMLSelectElement>('[data-field="path"]')?.value ?? '';
      if (path === '') return t('author.dialogs.noFiles');
      result = { role, path };
      return null;
    },
  });
  return ok ? result : null;
}

export type ConflictChoice = 'reload' | 'overwrite' | 'cancel';

/** 保存が競合したときの選択: 読み直す / 上書きする / やめる */
export async function chooseConflict(path: string, reason: FolderConflictReason): Promise<ConflictChoice> {
  let choice: ConflictChoice = 'cancel';
  const key =
    reason === 'deleted'
      ? 'author.dialogs.conflictDeleted'
      : reason === 'exists'
        ? 'author.dialogs.conflictExists'
        : 'author.dialogs.conflictModified';
  await showModal({
    title: escapeHtml(t('author.dialogs.conflictTitle')),
    icon: 'fa-triangle-exclamation',
    variant: 'danger',
    content: `<p>${escapeHtml(t(key, { path }))}</p><p>${escapeHtml(t('author.dialogs.conflictChoice'))}</p>`,
    dialogName: 'conflict',
    className: 'author-dialog',
    buttons: [
      {
        text: escapeHtml(t('author.dialogs.reload')),
        type: 'primary',
        action: 'reload',
        onClick: () => {
          choice = 'reload';
          return true;
        },
      },
      {
        text: escapeHtml(t('author.dialogs.overwrite')),
        type: 'danger',
        action: 'overwrite',
        onClick: () => {
          choice = 'overwrite';
          return true;
        },
      },
      { text: escapeHtml(t('author.dialogs.cancel')), type: 'cancel', action: 'cancel' },
    ],
  });
  return choice;
}

/** 未保存の変更を捨てて進むか。進むなら true */
export async function confirmDiscard(body: string, confirmText = t('author.dialogs.discard')): Promise<boolean> {
  let confirmed = false;
  await showModal({
    title: escapeHtml(t('author.dialogs.unsavedTitle')),
    icon: 'fa-triangle-exclamation',
    variant: 'danger',
    content: `<p>${escapeHtml(body)}</p>`,
    dialogName: 'unsaved',
    className: 'author-dialog',
    buttons: [
      {
        text: escapeHtml(confirmText),
        type: 'danger',
        action: 'discard',
        onClick: () => {
          confirmed = true;
          return true;
        },
      },
      { text: escapeHtml(t('author.dialogs.cancel')), type: 'cancel', action: 'cancel' },
    ],
  });
  return confirmed;
}
