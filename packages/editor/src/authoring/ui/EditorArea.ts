/**
 * 作問画面のタブと分割エディタ (#796)。
 *
 * - 配置 (どの群でどの文書を開いているか・群ごとの表示) は `EditorLayout` が持ち、ここは描くだけ
 * - Monaco のモデルは文書ごとに 1 つ (両方の群で同じ文書を開くと同じモデルを見る)。打鍵は `AuthorWorkspace.setText` へ
 *   流し、状態の側の変更 (読み直し・問題定義の書き戻し) はモデルへ戻す
 * - 文書の表示はファイルの種類ごとに `documentViews.ts` に登録したもの (Markdown の編集 / プレビュー、試験定義の
 *   フォーム / テキスト / 学生プレビューなど)。`edit` は Monaco、それ以外は群の表示領域に部品が描く (#797)
 * - 状態契約: 群 `[data-editor-group]` (`0` / `1`) に `data-active-path` (空文字 = 何も開いていない) と `data-view`
 *   (表示の名前。種類の既定は `documentViews.ts`)。表示が 2 つ以上ある種類だけ、群のツールに切り替えのボタン
 *   `data-action="view-<名前>"` を出す。タブ `.editor-tab` に `data-path` / `data-dirty` / `data-active` / `data-group`
 *
 * タブを閉じる (未保存なら確かめる) かどうかはページが決めるので、閉じる操作は `onRequestClose` で渡す。
 */

import * as monaco from 'monaco-editor';
import { escapeHtml } from '@typedcode/shared';
import { t } from '../../i18n/index.js';
import type { AuthorWorkspace, WorkspaceChange } from '../workspace/authorWorkspace.js';
import { workspaceBasename } from '../workspace/paths.js';
import { documentKindFor, resolveView, type ViewInstance } from './documentViews.js';
import { EditorLayout, type GroupIndex, MAX_GROUPS } from './editorLayout.js';
import { isMarkdownPath, monacoLanguageFor } from './fileKinds.js';

export interface EditorAreaHandlers {
  /** アクティブな文書・群・未保存の印が変わった */
  onStateChange(): void;
  /** タブの × (未保存なら確かめてから `close` を呼ぶのはページ) */
  onRequestClose(path: string, group: GroupIndex): void;
  /** 分割を閉じる (その群にしか無い未保存の文書を確かめるのはページ) */
  onRequestCloseGroup(group: GroupIndex): void;
}

interface GroupSlot {
  readonly element: HTMLElement;
  readonly tabs: HTMLElement;
  readonly tools: HTMLElement;
  readonly host: HTMLElement;
  /** Monaco 以外の表示を描く領域 */
  readonly view: HTMLElement;
  readonly empty: HTMLElement;
  editor: monaco.editor.IStandaloneCodeEditor | null;
  /** 表示領域に描いている表示 (どの文書のどの表示か) */
  mounted: { path: string; view: string; instance: ViewInstance } | null;
}

const TAB_ICONS: Record<string, string> = {
  markdown: 'fa-file-lines',
  yaml: 'fa-file-code',
};

export class EditorArea {
  readonly element: HTMLElement;
  readonly layout = new EditorLayout();
  private readonly slots: GroupSlot[] = [];
  private readonly models = new Map<string, monaco.editor.ITextModel>();
  private readonly modelListeners = new Map<string, monaco.IDisposable>();
  private workspace: AuthorWorkspace | null = null;
  private unsubscribe: (() => void) | null = null;
  /** 状態の側からモデルへ書き戻している間は、打鍵として流し返さない */
  private applyingFromWorkspace = false;

  constructor(
    private readonly handlers: EditorAreaHandlers,
    private readonly theme: () => string
  ) {
    const el = document.createElement('div');
    el.className = 'author-groups';
    el.id = 'author-groups';
    this.element = el;
    for (let i = 0; i < MAX_GROUPS; i++) this.slots.push(this.createSlot(i as GroupIndex));
    this.render();
  }

  get activePath(): string | null {
    return this.layout.activePath;
  }

  /** 開いたフォルダを差し替える (前のフォルダのタブとモデルは捨てる) */
  setWorkspace(workspace: AuthorWorkspace | null): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const slot of this.slots) {
      slot.editor?.setModel(null);
      this.unmountView(slot);
    }
    for (const listener of this.modelListeners.values()) listener.dispose();
    for (const model of this.models.values()) model.dispose();
    this.modelListeners.clear();
    this.models.clear();
    this.layout.reset();
    this.workspace = workspace;
    if (workspace) this.unsubscribe = workspace.onChange((change) => this.onWorkspaceChange(change));
    this.render();
  }

  /** 文書を開いて (既定はアクティブな群で) アクティブにする。開けなければ理由を返す */
  async open(path: string, group?: GroupIndex): Promise<{ ok: true; path: string } | { ok: false; cause: unknown }> {
    const workspace = this.workspace;
    if (!workspace) return { ok: false, cause: new Error('no folder is open') };
    const opened = await workspace.open(path);
    if (!opened.ok) return { ok: false, cause: opened.cause };
    if (workspace !== this.workspace) return { ok: false, cause: new Error('folder changed') };
    const actual = opened.document.path;
    this.ensureModel(actual, opened.document.text);
    this.layout.open(actual, group);
    this.render();
    return { ok: true, path: actual };
  }

  /** 群からタブを外す。どの群でも開いていなければモデルを捨て、文書を閉じる */
  close(path: string, group: GroupIndex): void {
    this.layout.close(path, group);
    this.disposeIfUnused(path);
    this.render();
  }

  split(): void {
    if (this.layout.split()) this.render();
  }

  /** 群を閉じたときに、どの群でも開かなくなる文書 (未保存の確認に使う) */
  pathsOnlyIn(group: GroupIndex): string[] {
    const other = this.layout.group(group === 0 ? 1 : 0)?.tabs ?? [];
    return (this.layout.group(group)?.tabs ?? []).filter((path) => !other.includes(path));
  }

  closeGroup(group: GroupIndex): void {
    const paths = this.layout.group(group)?.tabs ?? [];
    this.layout.closeGroup(group);
    // 閉じた群にしか無かった文書も閉じる
    for (const path of paths) this.disposeIfUnused(path);
    this.render();
  }

  /** どの群でも開いていない文書のモデルを捨て、文書を閉じる */
  private disposeIfUnused(path: string): void {
    if (this.layout.isOpen(path)) return;
    this.modelListeners.get(path)?.dispose();
    this.modelListeners.delete(path);
    const model = this.models.get(path);
    // 先に editor から外す (表示中のモデルを dispose しない)
    for (const slot of this.slots) {
      if (model && slot.editor?.getModel() === model) slot.editor.setModel(null);
    }
    model?.dispose();
    this.models.delete(path);
    this.workspace?.close(path);
  }

  /** テーマを変えたとき (Monaco は全エディタ共通) */
  applyTheme(): void {
    monaco.editor.setTheme(this.theme());
  }

  /** アクティブな群のエディタにフォーカスを戻す */
  focusActive(): void {
    this.slots[this.layout.activeGroup]?.editor?.focus();
  }

  private ensureModel(path: string, text: string): monaco.editor.ITextModel {
    const existing = this.models.get(path);
    if (existing) return existing;
    const model = monaco.editor.createModel(text, monacoLanguageFor(path));
    this.models.set(path, model);
    this.modelListeners.set(
      path,
      model.onDidChangeContent(() => {
        if (this.applyingFromWorkspace) return;
        // 文書の変更の通知 (`onWorkspaceChange`) で表示とタブを描き直す
        this.workspace?.setText(path, model.getValue());
      })
    );
    return model;
  }

  private onWorkspaceChange(change: WorkspaceChange): void {
    if (change.kind === 'document') {
      const model = this.models.get(change.path);
      const doc = this.workspace?.document(change.path);
      if (model && doc && model.getValue() !== doc.text) {
        this.applyingFromWorkspace = true;
        try {
          model.setValue(doc.text);
        } finally {
          this.applyingFromWorkspace = false;
        }
      }
    }
    // 表示は他の文書や索引も読む (学生プレビュー・フォームの一覧) ので、どの変更でも知らせる
    for (const slot of this.slots) slot.mounted?.instance.update();
    if (change.kind === 'document') {
      this.renderTabs();
      this.handlers.onStateChange();
    }
  }

  private createSlot(index: GroupIndex): GroupSlot {
    const element = document.createElement('section');
    element.className = 'author-group';
    element.dataset.editorGroup = String(index);
    element.dataset.activePath = '';
    element.dataset.view = 'edit';
    element.innerHTML = `
      <div class="editor-tabs-container">
        <div class="editor-tabs" role="tablist"></div>
        <span class="author-group-tools"></span>
      </div>
      <div class="author-group-body">
        <div class="author-monaco"></div>
        <div class="author-preview" hidden></div>
        <p class="author-group-empty">${escapeHtml(t('author.editor.empty'))}</p>
      </div>`;
    const slot: GroupSlot = {
      element,
      tabs: element.querySelector<HTMLElement>('.editor-tabs')!,
      tools: element.querySelector<HTMLElement>('.author-group-tools')!,
      host: element.querySelector<HTMLElement>('.author-monaco')!,
      view: element.querySelector<HTMLElement>('.author-preview')!,
      empty: element.querySelector<HTMLElement>('.author-group-empty')!,
      editor: null,
      mounted: null,
    };
    slot.tabs.addEventListener('click', (e) => this.onTabClick(e, index));
    slot.tabs.addEventListener('keydown', (e) => this.onTabKeydown(e, index));
    slot.tools.addEventListener('click', (e) => this.onToolClick(e, index));
    // 群のどこを触っても、その群をアクティブにする
    element.addEventListener('focusin', () => this.focusGroup(index));
    element.addEventListener('mousedown', () => this.focusGroup(index));
    this.element.appendChild(element);
    return slot;
  }

  private focusGroup(index: GroupIndex): void {
    if (this.layout.activeGroup === index || index >= this.layout.groupCount) return;
    this.layout.focus(index);
    this.renderTabs();
    this.handlers.onStateChange();
  }

  private onTabClick(e: Event, index: GroupIndex): void {
    const tab = (e.target as HTMLElement).closest<HTMLElement>('.editor-tab');
    const path = tab?.dataset.path;
    if (!path) return;
    if ((e.target as HTMLElement).closest('.tab-close-btn')) {
      this.handlers.onRequestClose(path, index);
      return;
    }
    this.layout.open(path, index);
    this.render();
  }

  private onTabKeydown(e: KeyboardEvent, index: GroupIndex): void {
    const tab = (e.target as HTMLElement).closest<HTMLElement>('.editor-tab');
    const path = tab?.dataset.path;
    if (!path || (e.target as HTMLElement).closest('.tab-close-btn')) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.layout.open(path, index);
      this.render();
      this.focusActive();
    }
  }

  private onToolClick(e: Event, index: GroupIndex): void {
    const button = (e.target as HTMLElement).closest<HTMLElement>('button');
    const action = button?.dataset.action;
    const path = this.layout.group(index)?.active;
    if (action === 'close-group') {
      this.handlers.onRequestCloseGroup(index);
      return;
    }
    if (!path || !action?.startsWith('view-')) return;
    this.setView(path, index, action.slice('view-'.length));
  }

  /** 群の表示を切り替える (その種類に無い表示なら何もしない) */
  private setView(path: string, index: GroupIndex, view: string): void {
    if (!documentKindFor(path).views.some((v) => v.name === view)) return;
    this.layout.setView(path, index, view);
    this.render();
  }

  private unmountView(slot: GroupSlot): void {
    slot.mounted?.instance.dispose();
    slot.mounted = null;
    slot.view.className = 'author-preview';
  }

  render(): void {
    this.slots.forEach((slot, i) => {
      this.renderSlot(slot, i as GroupIndex);
    });
    this.renderTabs();
    this.handlers.onStateChange();
  }

  /** タブ (未保存の印・アクティブ) だけを描き直す (打鍵のたびに呼ぶので Monaco には触れない) */
  renderTabs(): void {
    this.slots.forEach((slot, i) => {
      const index = i as GroupIndex;
      const group = this.layout.group(index);
      if (!group) {
        slot.tabs.innerHTML = '';
        return;
      }
      const isActiveGroup = this.layout.activeGroup === index;
      slot.element.classList.toggle('active', isActiveGroup && this.layout.groupCount > 1);
      slot.tabs.innerHTML = group.tabs
        .map((path) => {
          const active = path === group.active;
          const dirty = this.workspace?.document(path)?.dirty === true;
          const icon = TAB_ICONS[monacoLanguageFor(path)] ?? 'fa-file-code';
          const name = escapeHtml(workspaceBasename(path));
          return `
            <div class="editor-tab${active ? ' active' : ''}${dirty ? ' dirty' : ''}" role="tab" tabindex="${active ? '0' : '-1'}"
              aria-selected="${active}" data-path="${escapeHtml(path)}" data-dirty="${dirty}" data-active="${active}" data-group="${index}" title="${escapeHtml(path)}">
              <i class="fas ${icon} tab-icon" aria-hidden="true"></i>
              <span class="tab-filename">${name}</span>
              ${dirty ? `<span class="author-tab-dirty" title="${escapeHtml(t('author.editor.unsaved'))}" aria-label="${escapeHtml(t('author.editor.unsaved'))}">●</span>` : ''}
              <button type="button" class="tab-close-btn" title="${escapeHtml(t('author.editor.closeTab'))}" aria-label="${escapeHtml(`${t('author.editor.closeTab')}: ${workspaceBasename(path)}`)}"><i class="fas fa-times" aria-hidden="true"></i></button>
            </div>`;
        })
        .join('');
    });
  }

  private renderSlot(slot: GroupSlot, index: GroupIndex): void {
    const group = this.layout.group(index);
    slot.element.hidden = group === undefined;
    if (!group) {
      slot.editor?.setModel(null);
      this.unmountView(slot);
      slot.element.dataset.activePath = '';
      slot.element.dataset.view = 'edit';
      return;
    }
    const path = group.active;
    const model = path ? this.models.get(path) : undefined;
    const markdown = path !== null && isMarkdownPath(path);
    const kind = documentKindFor(path ?? '');
    const definition = resolveView(kind, path ? this.layout.view(path, index, kind.defaultView) : undefined);
    const view = model ? definition.name : 'edit';
    slot.element.dataset.activePath = path ?? '';
    slot.element.dataset.view = view;

    slot.tools.innerHTML = [
      model && kind.views.length > 1
        ? `<span class="author-seg" role="group">${kind.views
            .map(
              (v) =>
                `<button type="button" class="author-seg-btn${v.name === view ? ' active' : ''}" data-action="view-${v.name}" aria-pressed="${v.name === view}">${escapeHtml(v.label())}</button>`
            )
            .join('')}</span>`
        : '',
      this.layout.groupCount > 1
        ? `<button type="button" class="author-icon-btn" data-action="close-group" title="${escapeHtml(t('author.editor.closeGroup'))}" aria-label="${escapeHtml(t('author.editor.closeGroup'))}"><i class="fas fa-xmark" aria-hidden="true"></i></button>`
        : '',
    ].join('');

    const custom = model !== undefined && path !== null && definition.mount !== undefined;
    slot.empty.hidden = model !== undefined;
    slot.host.hidden = model === undefined || custom;
    slot.view.hidden = !custom;
    if (!custom || slot.mounted?.path !== path || slot.mounted.view !== view) this.unmountView(slot);
    if (custom && path !== null && !slot.mounted) {
      if (definition.className) slot.view.classList.add(definition.className);
      const instance = definition.mount!({
        path,
        host: slot.view,
        workspace: this.workspace!,
        setView: (next) => this.setView(path, index, next),
      });
      slot.mounted = { path, view, instance };
    }
    if (model && !slot.editor) {
      slot.editor = monaco.editor.create(slot.host, {
        theme: this.theme(),
        minimap: { enabled: false },
        automaticLayout: true,
        fontSize: 13,
      });
    }
    if (slot.editor && slot.editor.getModel() !== (model ?? null)) slot.editor.setModel(model ?? null);
    slot.editor?.updateOptions({ wordWrap: markdown ? 'on' : 'off' });
  }
}
