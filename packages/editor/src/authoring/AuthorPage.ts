/**
 * AuthorPage - 教員向けの作問画面 (`/author`。#80 / ADR-0012、教材フォルダは #796 / ADR-0051)。
 *
 * 手元の教材フォルダ (File System Access API) を開き、エクスプローラーとタブ・分割エディタで問題の本文・初期コード・
 * ヒント・解答例・ケースのファイルを編集して保存する。フォルダ無しのメモリ上の作問はしない (ADR-0051 D6)。
 *
 * このファイルは殻: 部品 (`ui/`) と状態 (`workspace/authorWorkspace.ts`) を組み立て、書き出しのパネル・
 * 実行をつなぐ。
 *
 * - 起動: 前回のフォルダの権限が `granted` ならそのまま開く。`prompt` なら「前回のフォルダを開く」を出し、
 *   クリックのハンドラの中で権限を求める
 * - 保存: Ctrl/Cmd+S とボタンで今の文書、「すべて保存」。競合は「読み直す / 上書きする / やめる」を選ばせ、失敗は
 *   理由を出して未保存のまま残す。未保存のまま離れる・言語を切り替える・別のフォルダを開くときは確かめる
 * - 検証 (#799): エクスプローラーの問題ごとの「検証」で、下のパネル (ターミナルの隣) に解答例 × テストケースの
 *   結果表を出す (`ui/VerificationPanel.ts`・`verification/`)。executor を共有するので、ターミナルの実行とは
 *   `ExecutionLock` で排他にする。結果は画面の状態だけで、proof にも教材フォルダにも IndexedDB にも記録しない
 * - 書き出し (#797): 書き出しのパネルで試験定義を選び (開いている試験定義が既定)、その採用問題 (出題順。保存済みの内容
 *   だけ) を配布物の問題列にして、種類 (`kind`) に応じて `.tcexam` / `.tcclass` を 1 ファイル書き出す (`distribution.ts`)。
 *   examId・種類・許可言語は試験定義から取る。欠損・重複・読めない定義、未保存の文書があれば書き出さない
 * - 書き出しの状態契約: 対象の `select#author-export-target`、ボタン `#author-build-btn` の `data-kind` (`exam` / `class`。
 *   対象が読めないか無ければ属性なし)、誤りの `#author-build-error` の `data-reason` (`no-target` / `unknown-exam` /
 *   `dirty` / `invalid` / `empty` / `no-languages` / `no-key` / `failed`) と、欠損の一覧 `[data-issues]` (`ui/issueList.ts`)
 * - 状態契約: `#author-root` に `data-workspace-state` (`welcome` / `opening` / `open`)・`data-folder-name`・
 *   `data-dirty-count`。部品の契約は各部品の冒頭を参照 (packages/editor/AGENTS.md「状態契約」)
 *
 * 署名鍵 (JWK)・監督コードは書き出しのパネルの入力欄にだけ置き、教材フォルダにも IndexedDB にも localStorage にも書かない
 * (ADR-0051 D7)。Monaco は proof / tracking に依らず単体で使う (authoring は proof を記録しない)。
 */

import * as monaco from 'monaco-editor';
import { escapeHtml } from '@typedcode/shared';
import { t, getI18n } from '../i18n/index.js';
import { formatProctorTokenForDisplay, generateProctorToken, type CreatedExamPackage } from './examPackageAuthoring.js';
import { generateAuthorityKey } from './authorityKey.js';
import { createDistribution, type ExamSecrets } from './distribution.js';
import { buildProctorMemo } from './proctorMemo.js';
import { ADDABLE_ROLES, type AddableRole, AuthorWorkspace } from './workspace/authorWorkspace.js';
import {
  createMaterialFolderIn,
  isFolderPickerSupported,
  openMaterialFolderHandle,
  pickDirectoryHandle,
  pickMaterialFolder,
  resumeMaterialFolder,
  type GrantResult,
} from './workspace/folderAccess.js';
import { FolderHandleStore } from './workspace/folderHandleStore.js';
import type { MaterialFolder } from './workspace/materialFolder.js';
import { workspaceBasename } from './workspace/paths.js';
import { addPartDialog, assignPartDialog, chooseConflict, confirmDiscard, promptName } from './ui/authorDialogs.js';
import { EditorArea } from './ui/EditorArea.js';
import type { GroupIndex } from './ui/editorLayout.js';
import { ExplorerView } from './ui/ExplorerView.js';
import { runLanguageFor } from './ui/fileKinds.js';
import { renderIssueList } from './ui/issueList.js';
import { causeMessage, describeOpError, describeVerificationBlock } from './ui/messages.js';
import type { WorkspaceIssue } from './workspace/examBundle.js';
import { defaultPartName } from './ui/partNames.js';
import { VerificationPanel } from './ui/VerificationPanel.js';
import { WelcomeView } from './ui/WelcomeView.js';
import { collectVerificationTargets } from './verification/collectTargets.js';
import { createVerificationTable, ExecutionLock, runVerificationTable } from './verification/verificationTable.js';
import type { NonInteractiveRunner } from '../executors/nonInteractive/runNonInteractive.js';
// 実行系は重い (Wasmer/xterm) ので**初回実行時に動的 import** する (型のみ静的)。
import type { CodeExecutionController } from '../execution/CodeExecutionController.js';
import type { CTerminal } from '../terminal/CTerminal.js';

export type WorkspaceState = 'welcome' | 'opening' | 'open';

/** 書き出しを止めた理由 (`#author-build-error` の `data-reason`) */
type BuildErrorReason =
  | 'no-target'
  | 'unknown-exam'
  | 'dirty'
  | 'invalid'
  | 'empty'
  | 'no-languages'
  | 'no-key'
  | 'failed';

/** Blob をファイル名つきでダウンロードさせる。 */
function downloadBlob(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export class AuthorPage {
  private readonly root: HTMLElement;
  private readonly store = new FolderHandleStore();
  private workspace: AuthorWorkspace | null = null;
  private unsubscribeWorkspace: (() => void) | null = null;
  private welcome!: WelcomeView;
  private explorer!: ExplorerView;
  private area: EditorArea | null = null;
  /** 前回のフォルダの権限を求める関数 (`needs-permission` のとき)。クリックの中で呼ぶ */
  private pendingGrant: (() => Promise<GrantResult>) | null = null;
  /** 確かめた上で離れるとき (言語の切り替え) は beforeunload の確認を出さない */
  private skipUnloadConfirm = false;
  /** フォルダを開く操作の通し番号 (後から始めた操作が勝つ。起動時の再開と競合させない) */
  private openSeq = 0;
  /** 書き出しの対象に選んだ試験定義 (開いた試験定義に追従する) */
  private exportTarget: string | null = null;
  /** 直前のアクティブな文書 (試験定義を開いたら書き出しの対象にする) */
  private lastActivePath: string | null = null;
  /** 書き出しの最中 (ボタンを押せなくしておく) */
  private building = false;
  private exec: CodeExecutionController | null = null;
  private terminal: CTerminal | null = null;
  /** 教員用の検証 (#799)。ターミナルの実行とは `lock` で排他にする (executor を共有するため) */
  private verifyPanel!: VerificationPanel;
  private readonly lock = new ExecutionLock();
  /** 検証の対象の問題定義のパス */
  private verifyTarget: string | null = null;
  private verifyAbort: AbortController | null = null;
  /** 検証の実行の入口の差し替え (dev フックの偽物)。null は実物 (`runNonInteractive`) */
  private verificationRunner: NonInteractiveRunner | null = null;
  /** 今のターミナルの実行の排他を外す関数 (実行していなければ null。#820) */
  private releaseTerminal: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  private get monacoTheme(): string {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'vs' : 'vs-dark';
  }

  mount(): void {
    this.root.innerHTML = this.render();
    this.welcome = new WelcomeView({
      onOpen: () => void this.handleOpenFolder(),
      onCreate: () => void this.handleCreateFolder(),
      onResume: () => void this.handleResume(),
    });
    this.explorer = new ExplorerView({
      onOpenFile: (path) => void this.openFile(path),
      onNewProblem: () => void this.handleNewProblem(),
      onNewExam: () => void this.handleNewExam(),
      onRefresh: () => void this.workspace?.refresh(),
      onOpenOther: () => void this.handleOpenFolder(),
      onAddPart: (path) => void this.handleAddPart(path),
      onAssignPart: (path) => void this.handleAssignPart(path),
      onVerify: (path) => void this.handleVerify(path),
    });
    this.verifyPanel = new VerificationPanel({
      onStart: () => void this.startVerification(),
      onAbort: () => this.verifyAbort?.abort(),
    });
    this.area = new EditorArea(
      {
        onStateChange: () => this.onEditorStateChange(),
        onRequestClose: (path, group) => void this.handleCloseTab(path, group),
        onRequestCloseGroup: (group) => void this.handleCloseGroup(group),
      },
      () => this.monacoTheme
    );
    this.el('author-welcome-slot').replaceWith(this.welcome.element);
    this.el('author-explorer-slot').replaceWith(this.explorer.element);
    this.el('author-groups-slot').replaceWith(this.area.element);
    this.el('author-verify-slot').replaceWith(this.verifyPanel.element);
    this.verifyPanel.element.hidden = true;
    this.verifyPanel.element.setAttribute('role', 'tabpanel');
    // 停止はターミナルの実行中だけ押せる (#820)
    (this.el('author-stop-btn') as HTMLButtonElement).disabled = true;
    this.wire();
    this.input('author-token').value = generateProctorToken();
    this.welcome.setPickerSupported(isFolderPickerSupported());
    this.updateStatusbar();
    void this.start();
  }

  private input(id: string): HTMLInputElement {
    return this.root.querySelector<HTMLInputElement>(`#${id}`)!;
  }
  private textarea(id: string): HTMLTextAreaElement {
    return this.root.querySelector<HTMLTextAreaElement>(`#${id}`)!;
  }
  private el(id: string): HTMLElement {
    return this.root.querySelector<HTMLElement>(`#${id}`)!;
  }

  // ==========================================================================
  // フォルダを開く
  // ==========================================================================

  private setState(state: WorkspaceState): void {
    this.root.dataset.workspaceState = state;
    this.welcome.element.hidden = state === 'open';
    this.el('author-workspace').hidden = state !== 'open';
    this.welcome.setBusy(state === 'opening');
  }

  /** ページを開いたとき: 前回のフォルダで再開を試みる */
  private async start(): Promise<void> {
    this.setState('opening');
    const seq = this.openSeq;
    let result: Awaited<ReturnType<typeof resumeMaterialFolder>>;
    try {
      result = await resumeMaterialFolder(this.store);
    } catch {
      result = { status: 'none' };
    }
    // 再開を待つ間に別のフォルダを開き始めていたら何もしない
    if (seq !== this.openSeq) return;
    switch (result.status) {
      case 'opened':
        await this.openFolder(result.folder);
        return;
      case 'needs-permission':
        this.pendingGrant = result.grant;
        this.welcome.showResume(result.name);
        break;
      case 'unavailable':
        await this.forgetFolder();
        this.showUnavailable(result.name, result.reason);
        break;
      default:
        break;
    }
    this.setState('welcome');
  }

  private showUnavailable(name: string, reason: 'denied' | 'missing' | 'error'): void {
    const key =
      reason === 'denied'
        ? 'author.welcome.unavailableDenied'
        : reason === 'missing'
          ? 'author.welcome.unavailableMissing'
          : 'author.welcome.unavailableError';
    this.welcome.showMessage(t(key, { name }), reason);
  }

  private async forgetFolder(): Promise<void> {
    try {
      await this.store.clear();
    } catch {
      /* 覚えている場所を消せなくても、開き直せばよい */
    }
  }

  /** 別のフォルダに移る前に未保存の変更を確かめる。進めるなら true */
  private async confirmLeaveFolder(): Promise<boolean> {
    const dirty = this.workspace?.dirtyCount() ?? 0;
    if (dirty === 0) return true;
    return confirmDiscard(t('author.dialogs.unsavedBody', { n: dirty }));
  }

  private async handleOpenFolder(): Promise<void> {
    if (!(await this.confirmLeaveFolder())) return;
    const result = await pickMaterialFolder({ store: this.store });
    switch (result.status) {
      case 'opened':
        await this.openFolder(result.folder);
        return;
      case 'unsupported':
        this.welcome.setPickerSupported(false);
        return;
      case 'failed':
        this.reportOpenFailure(result.cause);
        return;
      default:
        return;
    }
  }

  private async handleCreateFolder(): Promise<void> {
    if (!(await this.confirmLeaveFolder())) return;
    const parent = await pickDirectoryHandle();
    if (parent.status === 'unsupported') {
      this.welcome.setPickerSupported(false);
      return;
    }
    if (parent.status === 'failed') {
      this.reportOpenFailure(parent.cause);
      return;
    }
    if (parent.status !== 'picked') return;
    const name = await promptName({
      dialogName: 'create-folder',
      title: t('author.welcome.createTitle'),
      label: t('author.welcome.createLabel'),
      validate: (value) => {
        const trimmed = value.trim();
        if (trimmed === '' || /[/\\]/.test(trimmed) || trimmed.startsWith('.')) {
          return t('author.welcome.createInvalid');
        }
        return null;
      },
    });
    if (name === null) return;
    const created = await createMaterialFolderIn(parent.handle, name, this.store);
    switch (created.status) {
      case 'opened':
        await this.openFolder(created.folder);
        return;
      case 'exists':
        this.welcome.showMessage(t('author.welcome.createExists', { name: created.name }), 'error');
        return;
      case 'invalid-name':
        this.welcome.showMessage(t('author.welcome.createInvalid'), 'error');
        return;
      case 'failed':
        this.reportOpenFailure(created.cause);
        return;
      default:
        return;
    }
  }

  /** 「前回のフォルダを開く」(クリックのハンドラの中で権限を求める) */
  private async handleResume(): Promise<void> {
    const grant = this.pendingGrant;
    if (!grant) return;
    const result = await grant();
    if (result.status === 'opened') {
      this.pendingGrant = null;
      this.welcome.showResume(null);
      await this.openFolder(result.folder);
      return;
    }
    this.pendingGrant = null;
    this.welcome.showResume(null);
    await this.forgetFolder();
    this.showUnavailable(result.name, result.reason);
  }

  private reportOpenFailure(cause: unknown): void {
    const message = t('author.welcome.openFailed', { message: causeMessage(cause) });
    if (this.workspace) this.showNotice(message, 'error');
    else this.welcome.showMessage(message, 'open-failed');
  }

  /** ハンドルを教材フォルダとして開き、覚える (dev フックがピッカーの代わりに OPFS のハンドルを渡す) */
  async openFolderHandle(handle: FileSystemDirectoryHandle): Promise<void> {
    const result = await openMaterialFolderHandle(handle, this.store);
    if (result.status !== 'opened') throw new Error(`open failed: ${result.status}`);
    await this.openFolder(result.folder);
  }

  /** 開いている文書の状態 (dev フックが E2E に返す) */
  documentState(path: string): { path: string; savedText: string; text: string; dirty: boolean } | null {
    const doc = this.workspace?.document(path);
    return doc ? { path: doc.path, savedText: doc.savedText, text: doc.text, dirty: doc.dirty } : null;
  }

  /** 検証の実行の入口を差し替える (dev フックが偽物を渡す。null で実物に戻す。#799) */
  setVerificationRunner(runner: NonInteractiveRunner | null): void {
    this.verificationRunner = runner;
  }

  /** 開いた (権限のある) フォルダで作業画面にする */
  private async openFolder(folder: MaterialFolder): Promise<void> {
    const seq = ++this.openSeq;
    this.setState('opening');
    const workspace = new AuthorWorkspace(folder);
    try {
      await workspace.refresh();
    } catch (cause) {
      if (seq !== this.openSeq) return;
      this.setState(this.workspace ? 'open' : 'welcome');
      this.reportOpenFailure(cause);
      return;
    }
    // 読み込む間に別のフォルダを開き始めていたら、こちらは捨てる
    if (seq !== this.openSeq) return;
    this.unsubscribeWorkspace?.();
    this.workspace = workspace;
    this.unsubscribeWorkspace = workspace.onChange((change) => {
      if (change.kind === 'index') this.renderExplorer();
      this.onEditorStateChange();
    });
    this.area?.setWorkspace(workspace);
    this.resetVerification();
    this.root.dataset.folderName = workspace.folderName;
    this.welcome.showMessage(null);
    this.showNotice(null);
    this.renderExplorer();
    this.updateStatusbar();
    this.setState('open');
  }

  // ==========================================================================
  // エクスプローラーと文書
  // ==========================================================================

  private renderExplorer(): void {
    const workspace = this.workspace;
    if (!workspace) return;
    this.explorer.render(workspace.index, workspace.folderName, this.area?.activePath ?? null);
    this.renderExportPanel();
  }

  /** 部品の状態が変わったとき (アクティブな文書・未保存の印) */
  private onEditorStateChange(): void {
    if (!this.area) return; // EditorArea の生成中
    const dirty = this.workspace?.dirtyCount() ?? 0;
    this.root.dataset.dirtyCount = String(dirty);
    const active = this.area.activePath;
    if (active !== this.lastActivePath) {
      this.lastActivePath = active;
      // 開いている試験定義が書き出しの既定の対象
      if (active && this.workspace?.exam(active)) {
        this.exportTarget = active;
        this.renderExportPanel();
      }
    }
    for (const item of this.explorer.element.querySelectorAll<HTMLElement>('.author-explorer-item')) {
      const isActive = item.dataset.explorerPath === active;
      item.classList.toggle('active', isActive);
      if (isActive) item.setAttribute('aria-current', 'true');
      else item.removeAttribute('aria-current');
    }
    const hasActive = active !== null;
    (this.el('author-save-btn') as HTMLButtonElement).disabled = !hasActive;
    (this.el('author-save-all-btn') as HTMLButtonElement).disabled = dirty === 0;
    (this.el('author-split-btn') as HTMLButtonElement).disabled = !hasActive || this.area.layout.groupCount > 1;
  }

  private async openFile(path: string): Promise<void> {
    const opened = await this.area?.open(path);
    if (opened && !opened.ok) {
      this.showNotice(t('author.notices.openFailed', { path, message: causeMessage(opened.cause) }), 'error');
    }
  }

  private async handleCloseTab(path: string, group: GroupIndex): Promise<void> {
    const area = this.area;
    if (!area) return;
    const other = area.layout.group(group === 0 ? 1 : 0)?.tabs ?? [];
    const dirty = this.workspace?.document(path)?.dirty === true;
    if (dirty && !other.includes(path)) {
      const ok = await confirmDiscard(t('author.dialogs.closeDirtyBody', { path }), t('author.dialogs.closeDiscard'));
      if (!ok) return;
    }
    area.close(path, group);
  }

  private async handleCloseGroup(group: GroupIndex): Promise<void> {
    const area = this.area;
    if (!area) return;
    const dirty = area.pathsOnlyIn(group).filter((path) => this.workspace?.document(path)?.dirty === true);
    if (dirty.length > 0) {
      const ok = await confirmDiscard(t('author.dialogs.unsavedBody', { n: dirty.length }));
      if (!ok) return;
    }
    area.closeGroup(group);
  }

  // ==========================================================================
  // 保存
  // ==========================================================================

  /** 文書を保存する。競合なら選ばせ、失敗なら理由を出して未保存のまま残す */
  private async saveDocument(path: string, overwrite = false): Promise<void> {
    const workspace = this.workspace;
    if (!workspace) return;
    const result = await workspace.save(path, { overwrite });
    if (result.status === 'saved') {
      this.showNotice(t('author.notices.saved', { path: result.path }), 'info', 'saved');
      return;
    }
    if (result.status === 'failed') {
      this.showNotice(
        t('author.notices.saveFailed', { path: result.path, message: causeMessage(result.cause) }),
        'error',
        'save-failed'
      );
      return;
    }
    const choice = await chooseConflict(result.path, result.reason);
    if (choice === 'overwrite') {
      await this.saveDocument(path, true);
    } else if (choice === 'reload') {
      const reloaded = await workspace.reload(path);
      if (!reloaded.ok) {
        this.showNotice(
          t('author.notices.reloadFailed', { path: reloaded.path, message: causeMessage(reloaded.cause) }),
          'error',
          'reload-failed'
        );
      }
    }
  }

  private async saveActive(): Promise<void> {
    const path = this.area?.activePath;
    if (path) await this.saveDocument(path);
  }

  private async saveAll(): Promise<void> {
    for (const path of this.workspace?.dirtyPaths() ?? []) await this.saveDocument(path);
  }

  // ==========================================================================
  // 問題の操作
  // ==========================================================================

  private async handleNewProblem(): Promise<void> {
    const workspace = this.workspace;
    if (!workspace) return;
    const name = await promptName({
      dialogName: 'new-problem',
      title: t('author.dialogs.newProblemTitle'),
      label: t('author.dialogs.newProblemLabel'),
    });
    if (name === null) return;
    const result = await workspace.createProblem(name);
    if (!result.ok) {
      this.showNotice(describeOpError(result.error), 'error', 'op-failed');
      return;
    }
    // 作った本文を開く
    const statement = result.path.slice(0, -'.problem.yaml'.length) + '.md';
    await this.openFile(statement);
  }

  private async handleNewExam(): Promise<void> {
    const workspace = this.workspace;
    if (!workspace) return;
    const name = await promptName({
      dialogName: 'new-exam',
      title: t('author.exam.newExamTitle'),
      label: t('author.exam.newExamLabel'),
    });
    if (name === null) return;
    const result = await workspace.createExam(name);
    if (!result.ok) {
      this.showNotice(describeOpError(result.error), 'error', 'op-failed');
      return;
    }
    this.exportTarget = result.path;
    await this.openFile(result.path);
  }

  /** 問題に足せる役割 (初期コードとケースは 1 つまで) */
  private addableRoles(problemPath: string): AddableRole[] {
    const problem = this.workspace?.problem(problemPath);
    if (problem?.status !== 'ok') return [];
    return ADDABLE_ROLES.filter((role) => {
      if (role === 'starter') return problem.definition.starter === undefined;
      if (role === 'cases') return problem.definition.cases === undefined;
      return true;
    });
  }

  private async handleAddPart(problemPath: string): Promise<void> {
    const workspace = this.workspace;
    const problem = workspace?.problem(problemPath);
    if (!workspace || problem?.status !== 'ok') return;
    const words = {
      starter: t('author.partWords.starter'),
      hint: t('author.partWords.hint'),
      solution: t('author.partWords.solution'),
    };
    const chosen = await addPartDialog({
      roles: this.addableRoles(problemPath),
      defaultName: (role) =>
        defaultPartName({ problemPath: problem.path, role, words, parts: problem.parts, files: workspace.index.files }),
    });
    if (!chosen) return;
    const result = await workspace.addPart(problem.path, chosen.role, chosen.name);
    if (!result.ok) {
      this.showNotice(describeOpError(result.error), 'error', 'op-failed');
      return;
    }
    await this.openFile(result.path);
  }

  private async handleAssignPart(problemPath: string): Promise<void> {
    const workspace = this.workspace;
    const problem = workspace?.problem(problemPath);
    if (!workspace || problem?.status !== 'ok') return;
    const files = workspace.index.files.filter((file) => file !== problem.path);
    const chosen = await assignPartDialog({ roles: this.addableRoles(problemPath), files });
    if (!chosen) return;
    const result = await workspace.assignPart(problem.path, chosen.role, chosen.path);
    if (!result.ok) this.showNotice(describeOpError(result.error), 'error', 'op-failed');
  }

  // ==========================================================================
  // 検証 (#799)
  // ==========================================================================

  /** エクスプローラーの「検証」: 下のパネルを検証にして、その問題で始める (検証中ならパネルを出すだけ) */
  private async handleVerify(problemPath: string): Promise<void> {
    this.showBottom('verify');
    if (this.lock.verificationRunning) return;
    this.verifyTarget = problemPath;
    await this.startVerification();
  }

  private problemDisplayName(problemPath: string): string {
    const problem = this.workspace?.problem(problemPath);
    if (problem?.status === 'ok') return problem.definition.title ?? problem.definition.id;
    return workspaceBasename(problemPath);
  }

  /**
   * 対象の問題の解答例をケースで走らせる。内容は開いている文書の今のテキスト (未保存を含む)。
   * ターミナルの実行中は始めず、理由を出す。結果は画面の状態だけで、proof にも教材フォルダにも記録しない
   */
  private async startVerification(): Promise<void> {
    const workspace = this.workspace;
    const problemPath = this.verifyTarget;
    if (!workspace || problemPath === null || this.lock.verificationRunning) return;
    const name = this.problemDisplayName(problemPath);
    const problem = workspace.problem(problemPath);
    if (!problem) {
      this.verifyPanel.showBlocked(
        problemPath,
        name,
        'problem-invalid',
        describeVerificationBlock({ kind: 'problem-invalid', path: problemPath })
      );
      return;
    }
    if (!this.lock.beginVerification()) {
      this.verifyPanel.showBlocked(
        problem.path,
        name,
        'terminal-busy',
        describeVerificationBlock({ kind: 'terminal-busy' })
      );
      return;
    }
    this.updateRunAvailability();
    const controller = new AbortController();
    this.verifyAbort = controller;
    try {
      const targets = await collectVerificationTargets(problem, {
        readText: (path) => workspace.readCurrentText(path),
      });
      if (this.workspace !== workspace) return;
      if (!targets.ok) {
        this.verifyPanel.showBlocked(
          problem.path,
          name,
          targets.reason.kind,
          describeVerificationBlock(targets.reason)
        );
        return;
      }
      const run = this.verificationRunner ?? (await this.realVerificationRunner());
      const table = createVerificationTable(problem.path, targets.solutions, targets.cases);
      await runVerificationTable(table, targets.solutions, targets.cases, {
        run,
        signal: controller.signal,
        onChange: (next) => {
          if (this.workspace === workspace) this.verifyPanel.showTable(name, next);
        },
      });
    } finally {
      if (this.verifyAbort === controller) this.verifyAbort = null;
      this.lock.endVerification();
      this.updateRunAvailability();
    }
  }

  /** 実物の入口 (実行系は重いので初回の検証で dynamic import する) */
  private async realVerificationRunner(): Promise<NonInteractiveRunner> {
    const { runNonInteractive } = await import('../executors/nonInteractive/runNonInteractive.js');
    return (request, options) => runNonInteractive(request, options);
  }

  /** フォルダを開き直したとき: 走っている検証を止め、パネルを空にする */
  private resetVerification(): void {
    this.verifyAbort?.abort();
    this.verifyTarget = null;
    this.verifyPanel.showEmpty();
  }

  /** 検証の実行中はターミナルの「実行」を止める */
  private updateRunAvailability(): void {
    const runBtn = this.el('author-run-btn') as HTMLButtonElement;
    runBtn.disabled = this.lock.verificationRunning || (this.exec?.running ?? false);
  }

  /** ツールバーの知らせ。`id` は状態契約の `data-notice` (E2E 用) */
  private showNotice(text: string | null, kind: 'info' | 'error' = 'info', id = ''): void {
    const notice = this.el('author-notice');
    notice.textContent = text ?? '';
    notice.hidden = text === null;
    notice.classList.toggle('author-notice-error', kind === 'error');
    notice.dataset.notice = text === null ? '' : id;
  }

  // ==========================================================================
  // 配線とクロム
  // ==========================================================================

  private wire(): void {
    // 書き出しのパネルのトグル。
    this.el('author-settings-toggle').addEventListener('click', () => {
      const p = this.el('author-settings-panel');
      p.hidden = !p.hidden;
      this.el('author-settings-toggle').setAttribute('aria-expanded', String(!p.hidden));
      if (!p.hidden) this.renderExportPanel();
    });
    this.el('author-export-target').addEventListener('change', () => {
      this.exportTarget = (this.el('author-export-target') as HTMLSelectElement).value || null;
      this.el('author-build-error').hidden = true;
      this.renderExportPanel();
    });
    this.el('author-export-create').addEventListener('click', () => void this.handleNewExam());
    this.el('author-settings-close').addEventListener('click', () => {
      this.el('author-settings-panel').hidden = true;
      this.el('author-settings-toggle').setAttribute('aria-expanded', 'false');
    });

    // 署名鍵: 既存貼付 / 新規生成 のタブ切替。
    const selectKeyTab = (which: 'existing' | 'generate'): void => {
      const existing = which === 'existing';
      this.el('author-key-tab-existing').classList.toggle('active', existing);
      this.el('author-key-tab-generate').classList.toggle('active', !existing);
      this.el('author-key-pane-existing').hidden = !existing;
      this.el('author-key-pane-generate').hidden = existing;
    };
    this.el('author-key-tab-existing').addEventListener('click', () => selectKeyTab('existing'));
    this.el('author-key-tab-generate').addEventListener('click', () => selectKeyTab('generate'));
    this.el('author-generate-key-btn').addEventListener('click', () => void this.handleGenerateKey());

    // 監督コード再生成 / 生成。
    this.el('author-regen-token-btn').addEventListener('click', () => {
      this.input('author-token').value = generateProctorToken();
      this.updateStatusbar();
    });
    this.el('author-build-btn').addEventListener('click', () => void this.handleBuild());

    // 監督コードの変更で statusbar を更新。
    this.input('author-token').addEventListener('input', () => this.updateStatusbar());

    // 保存・分割・実行・ターミナル。
    this.el('author-save-btn').addEventListener('click', () => void this.saveActive());
    this.el('author-save-all-btn').addEventListener('click', () => void this.saveAll());
    this.el('author-split-btn').addEventListener('click', () => this.area?.split());
    this.el('author-run-btn').addEventListener('click', () => void this.handleRun());
    this.el('author-stop-btn').addEventListener('click', () => this.handleStop());
    this.el('author-term-toggle').addEventListener('click', () => {
      const bottom = this.el('author-bottom');
      this.showTerminal(bottom.hidden !== false || bottom.dataset.bottomView !== 'terminal');
    });
    this.el('author-bottom-tab-terminal').addEventListener('click', () => this.showBottom('terminal'));
    this.el('author-bottom-tab-verify').addEventListener('click', () => this.showBottom('verify'));
    this.el('author-bottom-close').addEventListener('click', () => this.showBottom(null));

    // Ctrl/Cmd+S (Monaco の中でも外でも)。capture で Monaco より先に受ける
    document.addEventListener(
      'keydown',
      (e) => {
        if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
          if (this.root.dataset.workspaceState !== 'open') return;
          e.preventDefault();
          if (e.shiftKey) void this.saveAll();
          else void this.saveActive();
        }
      },
      true
    );

    // 未保存のまま離れるときは確かめる。
    window.addEventListener('beforeunload', (e) => {
      if (this.skipUnloadConfirm || (this.workspace?.dirtyCount() ?? 0) === 0) return;
      e.preventDefault();
      e.returnValue = '';
    });

    // アプリ設定: テーマ / 言語。
    this.el('author-theme-toggle').addEventListener('click', () => this.toggleTheme());
    this.el('author-lang-toggle').addEventListener('click', () => void this.toggleLocale());

    // 結果モーダルを閉じる。
    this.el('author-result-close').addEventListener('click', () => {
      this.el('author-result-overlay').hidden = true;
    });
  }

  /** ターミナル領域の表示/非表示。表示時は fit して xterm を再計算する。 */
  private showTerminal(show: boolean): void {
    this.showBottom(show ? 'terminal' : null);
  }

  /**
   * 下のパネル (`#author-bottom`) に出すもの: ターミナル / 検証 (#799) / 閉じる (null)。
   * 状態契約は `#author-bottom` の `data-bottom-view` (最後に出したもの) と `hidden`
   */
  private showBottom(view: 'terminal' | 'verify' | null): void {
    const bottom = this.el('author-bottom');
    bottom.hidden = view === null;
    if (view !== null) bottom.dataset.bottomView = view;
    const shown = view ?? (bottom.dataset.bottomView as 'terminal' | 'verify' | undefined) ?? 'terminal';
    this.el('author-terminal-wrap').hidden = shown !== 'terminal';
    this.verifyPanel.element.hidden = shown !== 'verify';
    this.el('author-bottom-tab-terminal').setAttribute('aria-selected', String(shown === 'terminal'));
    this.el('author-bottom-tab-verify').setAttribute('aria-selected', String(shown === 'verify'));
    const terminalShown = view === 'terminal';
    this.el('author-term-toggle').classList.toggle('active', terminalShown);
    this.el('author-term-toggle').setAttribute('aria-pressed', String(terminalShown));
    if (terminalShown && this.terminal) setTimeout(() => this.terminal?.fit(), 0);
  }

  /** 実行系 (Wasmer C executor + xterm) を初回のみ動的 import で用意する。 */
  private async ensureRuntime(): Promise<{ exec: CodeExecutionController; terminal: CTerminal }> {
    if (this.exec && this.terminal) return { exec: this.exec, terminal: this.terminal };
    const [{ CodeExecutionController }, { CTerminal }] = await Promise.all([
      import('../execution/CodeExecutionController.js'),
      import('../terminal/CTerminal.js'),
    ]);
    const terminal = new CTerminal(this.el('author-terminal'));
    const exec = new CodeExecutionController();
    exec.setTerminal(terminal);
    const runBtn = this.el('author-run-btn') as HTMLButtonElement;
    const stopBtn = this.el('author-stop-btn') as HTMLButtonElement;
    exec.setCallbacks({
      onRunStart: () => {
        runBtn.disabled = true;
        runBtn.innerHTML = `<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> ${escapeHtml(t('author.run.running'))}`;
        stopBtn.disabled = false;
      },
      onRunEnd: () => {
        runBtn.disabled = false;
        runBtn.innerHTML = `<i class="fas fa-play" aria-hidden="true"></i> ${escapeHtml(t('author.run.label'))}`;
        stopBtn.disabled = true;
        // 停止 (abort) は run の promise の終わりを待たずに onRunEnd を呼ぶので、ここで排他を外す (#820)
        this.releaseTerminal?.();
      },
      onNotification: (m) => terminal.writeLine(m),
      onShowClangLoading: () => terminal.writeInfo(t('author.run.compilerLoading')),
      onUpdateClangStatus: (m) => terminal.writeInfo(m),
    });
    this.exec = exec;
    this.terminal = terminal;
    return { exec, terminal };
  }

  /** アクティブなコードの文書の今のテキストを、拡張子の言語で editor と同じ実行系で動かす。 */
  private async handleRun(): Promise<void> {
    // 検証の実行中は executor を共有しているので走らせない (#799)
    if (!this.lock.beginTerminal()) {
      this.showNotice(t('author.verify.runBlocked'), 'error', 'run-blocked');
      return;
    }
    // 排他は「run が終わった (onRunEnd)」か「この呼び出しが戻った」の早い方で 1 回だけ外す。
    // 停止した run の promise が後から戻っても、次の run の排他は外さない
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.lock.endTerminal();
      if (this.releaseTerminal === release) this.releaseTerminal = null;
    };
    this.releaseTerminal = release;
    try {
      const path = this.area?.activePath ?? null;
      const doc = path ? this.workspace?.document(path) : undefined;
      this.showTerminal(true);
      const { exec, terminal } = await this.ensureRuntime();
      terminal.clear();
      terminal.fit();
      if (!path || !doc) {
        terminal.writeLine(t('author.editor.runNoFile'));
        return;
      }
      const filename = workspaceBasename(path);
      await exec.run({ language: runLanguageFor(path), filename, code: doc.text });
    } finally {
      release();
    }
  }

  /** ターミナルの実行を止める (学生側の停止と同じ `CodeExecutionController.abort`。#820) */
  private handleStop(): void {
    this.exec?.abort();
  }

  private toggleTheme(): void {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('typedcode-theme', next);
    } catch {
      /* ignore */
    }
    monaco.editor.setTheme(next === 'light' ? 'vs' : 'vs-dark');
  }

  /**
   * 言語を切り替えてページを読み直す (クロムを作り直す手間を避ける)。教材は保存済みならフォルダから再開できるので、
   * 未保存の文書があるときだけ確かめる。
   */
  private async toggleLocale(): Promise<void> {
    const dirty = this.workspace?.dirtyCount() ?? 0;
    if (dirty > 0 && !(await confirmDiscard(t('author.dialogs.unsavedBody', { n: dirty })))) return;
    const i18n = getI18n();
    i18n.setLocale(i18n.getLocale() === 'ja' ? 'en' : 'ja');
    this.skipUnloadConfirm = true;
    location.reload();
  }

  private updateStatusbar(): void {
    const target = this.currentExportTarget();
    const entry = target ? this.workspace?.exam(target) : undefined;
    const examId = entry?.status === 'ok' ? entry.definition.examId : '';
    this.el('author-sb-exam').textContent = examId || t('author.statusbar.noExamId');
    this.el('author-sb-count').textContent = String(this.workspace?.index.problems.length ?? 0);
    this.el('author-sb-folder').textContent = this.workspace?.folderName ?? '';
    this.el('author-sb-token').textContent = formatProctorTokenForDisplay(this.input('author-token').value);
  }

  // ==========================================================================
  // 鍵生成 / ビルド
  // ==========================================================================

  private async handleGenerateKey(): Promise<void> {
    const out = this.el('author-genkey-output');
    try {
      const key = await generateAuthorityKey();
      this.input('author-keyid').value = key.keyId;
      this.textarea('author-jwk').value = JSON.stringify(key.privateJwk);
      const entryJson = JSON.stringify(key.registryEntry, null, 2);
      out.hidden = false;
      out.innerHTML = `
        <div class="author-note author-note-warn"><i class="fas fa-triangle-exclamation"></i><span>${escapeHtml(t('author.key.privateWarning'))}</span></div>
        <div class="author-field">
          <label>${escapeHtml(t('author.key.registryEntryLabel'))}</label>
          <pre class="author-pre">${escapeHtml(entryJson)}</pre>
          <div class="author-btn-row">
            <button class="author-btn" id="author-copy-entry-btn"><i class="fas fa-copy"></i> ${escapeHtml(t('author.copy'))}</button>
            <button class="author-btn author-btn-primary" id="author-dl-privkey-btn"><i class="fas fa-download"></i> ${escapeHtml(t('author.key.downloadPrivate'))}</button>
          </div>
          <p class="author-hint">${escapeHtml(t('author.key.registryHint'))}</p>
        </div>`;
      this.el('author-copy-entry-btn').addEventListener('click', () => void navigator.clipboard?.writeText(entryJson));
      this.el('author-dl-privkey-btn').addEventListener('click', () =>
        downloadBlob(`${key.keyId}.private.jwk.json`, JSON.stringify(key.privateJwk, null, 2), 'application/json')
      );
    } catch {
      out.hidden = false;
      out.innerHTML = `<p class="author-error">${escapeHtml(t('author.key.generateFailed'))}</p>`;
    }
  }

  /** 書き出しの対象 (選んだもの、無ければ最初の試験定義)。試験定義が無ければ null */
  private currentExportTarget(): string | null {
    const exams = this.workspace?.index.exams ?? [];
    if (this.exportTarget && exams.includes(this.exportTarget)) return this.exportTarget;
    return exams[0] ?? null;
  }

  /** 書き出しのパネルを索引と対象に合わせる (examId・種類・許可言語は試験定義の保存済みの値を読み取り専用で出す) */
  private renderExportPanel(): void {
    const exams = this.workspace?.index.exams ?? [];
    const target = this.currentExportTarget();
    const select = this.el('author-export-target') as HTMLSelectElement;
    const options = [...select.options].map((o) => o.value);
    if (options.length !== exams.length || options.some((value, i) => value !== exams[i])) {
      select.replaceChildren(
        ...exams.map((path) => {
          const option = document.createElement('option');
          option.value = path;
          option.textContent = path;
          return option;
        })
      );
    }
    select.value = target ?? '';
    this.el('author-export-target-field').hidden = target === null;
    this.el('author-export-empty').hidden = target !== null;

    const entry = target ? this.workspace?.exam(target) : undefined;
    const summary = this.el('author-export-summary');
    const button = this.el('author-build-btn') as HTMLButtonElement;
    const ok = entry?.status === 'ok' ? entry.definition : null;
    summary.hidden = ok === null;
    this.el('author-export-invalid').hidden = !(entry && entry.status !== 'ok');
    if (ok) {
      const values: Record<string, string> = {
        'exam-id': ok.examId,
        kind: ok.kind === 'exam' ? t('author.export.kindExam') : t('author.export.kindClass'),
        languages: ok.languages.join(', '),
        problems: String(ok.problems.length),
      };
      for (const [field, value] of Object.entries(values)) {
        summary.querySelector<HTMLElement>(`[data-summary="${field}"]`)!.textContent = value;
      }
      button.dataset.kind = ok.kind;
    } else {
      delete button.dataset.kind;
    }
    const kind = ok?.kind ?? null;
    this.el('author-export-secrets').hidden = kind !== 'exam';
    this.el('author-export-class-hint').hidden = kind !== 'class';
    if (!this.building) {
      button.disabled = ok === null;
      button.innerHTML = this.buildButtonLabel(kind);
    }
    this.updateStatusbar();
  }

  private buildButtonLabel(kind: 'exam' | 'class' | null): string {
    const label = kind === 'class' ? t('author.export.buttonClass') : t('author.export.buttonExam');
    const icon = kind === 'class' ? 'fa-book-open' : 'fa-box-archive';
    return `<i class="fas ${icon}" aria-hidden="true"></i> ${escapeHtml(label)}`;
  }

  /** 書き出す: 対象の試験定義の採用問題 (保存済みの内容) を、種類に応じた配布物にしてダウンロードさせる */
  private async handleBuild(): Promise<void> {
    this.el('author-build-error').hidden = true;
    const workspace = this.workspace;
    const target = this.currentExportTarget();
    if (!workspace || !target) {
      this.showBuildError('no-target', t('author.export.errorNoTarget'));
      return;
    }
    const button = this.el('author-build-btn') as HTMLButtonElement;
    this.building = true;
    button.disabled = true;
    button.innerHTML = `<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> ${escapeHtml(t('author.export.working'))}`;
    try {
      const result = await workspace.buildExamBundle(target);
      switch (result.status) {
        case 'dirty':
          this.showBuildError('dirty', t('author.export.errorDirty', { paths: result.paths.join(', ') }));
          return;
        case 'unknown-exam':
          this.showBuildError('unknown-exam', t('author.export.errorUnknownExam', { path: result.path }));
          return;
        case 'invalid':
          this.showBuildError('invalid', t('author.issues.heading'), result.issues);
          return;
        case 'empty':
          this.showBuildError('empty', t('author.export.errorEmpty'));
          return;
        case 'no-languages':
          this.showBuildError('no-languages', t('author.export.errorNoLanguages'));
          return;
        case 'ok':
          break;
      }
      let secrets: ExamSecrets | undefined;
      if (result.exam.kind === 'exam') {
        const keyId = this.input('author-keyid').value.trim();
        const jwk = this.textarea('author-jwk').value.trim();
        if (!keyId || !jwk) {
          this.showBuildError('no-key', t('author.export.errorNoKey'));
          return;
        }
        secrets = {
          keyId,
          jwk,
          embedPublicKey: this.input('author-embed-pubkey').checked,
          proctorToken: this.input('author-token').value,
        };
      }
      const distribution = await createDistribution(result.exam, result.problems, { secrets, now: new Date() });
      downloadBlob(distribution.filename, distribution.content, 'application/json');
      if (distribution.kind === 'exam') this.showResult(distribution.created, distribution.filename);
    } catch (err) {
      this.showBuildError('failed', err instanceof Error ? err.message : t('author.export.errorGeneric'));
    } finally {
      this.building = false;
      this.renderExportPanel();
    }
  }

  /** 書き出しの誤りを書き出しのパネルに出す (パネルが閉じていれば開く)。欠損は一覧 (`[data-issues]`) にする */
  private showBuildError(reason: BuildErrorReason, msg: string, issues: readonly WorkspaceIssue[] = []): void {
    const errorEl = this.el('author-build-error');
    const text = document.createElement('p');
    text.textContent = msg;
    errorEl.replaceChildren(text);
    if (issues.length > 0) errorEl.appendChild(renderIssueList(issues));
    errorEl.dataset.reason = reason;
    errorEl.hidden = false;
    this.el('author-settings-panel').hidden = false;
    this.el('author-settings-toggle').setAttribute('aria-expanded', 'true');
  }

  private showResult(result: CreatedExamPackage, filename: string): void {
    const overlay = this.el('author-result-overlay');
    const body = this.el('author-result-body');
    const displayToken = formatProctorTokenForDisplay(result.proctorToken);
    body.innerHTML = `
      <p class="author-result-file"><i class="fas fa-file-shield"></i> ${escapeHtml(filename)}
        <button class="author-btn" id="author-redownload-btn"><i class="fas fa-download"></i> ${escapeHtml(t('author.result.redownload'))}</button></p>
      <div class="author-token-box">
        <div class="author-token-label">${escapeHtml(t('author.result.proctorCodeLabel'))}</div>
        <div class="author-token-value">${escapeHtml(displayToken)}</div>
        <div class="author-btn-row author-token-actions">
          <button class="author-btn author-btn-primary" id="author-copy-token-btn"><i class="fas fa-copy"></i> ${escapeHtml(t('author.copy'))}</button>
          <button class="author-btn" id="author-dl-memo-btn"><i class="fas fa-file-lines"></i> ${escapeHtml(t('author.result.downloadMemo'))}</button>
        </div>
      </div>
      <div class="author-note author-note-warn"><i class="fas fa-triangle-exclamation"></i><span>${escapeHtml(t('author.result.proctorWarning'))}</span></div>
      <dl class="author-meta">
        <dt>${escapeHtml(t('author.result.keyId'))}</dt><dd><code>${escapeHtml(result.manifest.keyId)}</code></dd>
        <dt>${escapeHtml(t('author.result.packageHash'))}</dt><dd><code class="author-hash">${escapeHtml(result.packageHash)}</code></dd>
      </dl>`;
    this.el('author-copy-token-btn').addEventListener(
      'click',
      () => void navigator.clipboard?.writeText(result.proctorToken)
    );
    this.el('author-dl-memo-btn').addEventListener('click', () =>
      downloadBlob(
        `${result.manifest.examId || 'exam'}-proctor-code.txt`,
        buildProctorMemo(result, filename, new Date()),
        'text/plain'
      )
    );
    this.el('author-redownload-btn').addEventListener('click', () =>
      downloadBlob(filename, JSON.stringify(result.manifest, null, 2) + '\n', 'application/json')
    );
    overlay.hidden = false;
  }

  private render(): string {
    const button = (id: string, action: string, icon: string, label: string, iconOnly = false): string => {
      const text = escapeHtml(label);
      return `<button type="button" class="author-pane-btn${iconOnly ? ' author-pane-btn-icon' : ''}" id="${id}" data-action="${action}" title="${text}"${iconOnly ? ` aria-label="${text}"` : ''}><i class="fas ${icon}" aria-hidden="true"></i>${iconOnly ? '' : ` ${text}`}</button>`;
    };
    return `
      <div class="author-shell">
        <header class="titlebar">
          <div class="titlebar-left">
            <div class="titlebar-title"><i class="fas fa-feather-pointed"></i> ${escapeHtml(t('author.title'))}</div>
            <span class="feature-badge"><i class="fas fa-feather-pointed"></i> ${escapeHtml(t('feature.author'))}</span>
          </div>
        </header>

        <div class="main-layout">
          <nav class="activitybar">
            <div class="activitybar-top">
              <button class="activitybar-item" id="author-settings-toggle" aria-controls="author-settings-panel" aria-expanded="false" title="${escapeHtml(t('author.export.heading'))}" aria-label="${escapeHtml(t('author.export.heading'))}"><i class="fas fa-box-archive"></i></button>
            </div>
            <div class="activitybar-bottom">
              <a class="activitybar-item" href="/verify/" target="_blank" rel="noopener noreferrer" title="${escapeHtml(t('settings.verifyProof'))}" aria-label="${escapeHtml(t('settings.verifyProof'))}"><i class="fas fa-circle-check"></i></a>
              <button class="activitybar-item" id="author-lang-toggle" title="${escapeHtml(t('settings.language'))}" aria-label="${escapeHtml(t('settings.language'))}"><i class="fas fa-globe"></i></button>
              <button class="activitybar-item" id="author-theme-toggle" title="${escapeHtml(t('settings.toggleTheme'))}" aria-label="${escapeHtml(t('settings.toggleTheme'))}"><i class="fas fa-moon"></i></button>
            </div>
          </nav>

          <div class="author-main">
            <div id="author-welcome-slot"></div>
            <div class="author-workspace" id="author-workspace" hidden>
              <div id="author-explorer-slot"></div>
              <div class="author-workbench">
                <div class="author-toolbar">
                  ${button('author-save-btn', 'save', 'fa-floppy-disk', t('author.editor.save'))}
                  ${button('author-save-all-btn', 'save-all', 'fa-layer-group', t('author.editor.saveAll'))}
                  ${button('author-split-btn', 'split', 'fa-table-columns', t('author.editor.split'), true)}
                  <span class="author-toolbar-sep" aria-hidden="true"></span>
                  ${button('author-run-btn', 'run', 'fa-play', t('author.run.label'))}
                  ${button('author-stop-btn', 'stop', 'fa-stop', t('author.run.stop'))}
                  ${button('author-term-toggle', 'toggle-terminal', 'fa-terminal', t('author.run.terminal'), true)}
                  <span class="author-notice" id="author-notice" role="status" hidden></span>
                </div>
                <div id="author-groups-slot"></div>
                <div class="author-bottom" id="author-bottom" hidden>
                  <div class="author-bottom-tabs" role="tablist">
                    <button type="button" role="tab" class="author-bottom-tab" id="author-bottom-tab-terminal" data-action="bottom-terminal" aria-controls="author-terminal-wrap" aria-selected="true"><i class="fas fa-terminal" aria-hidden="true"></i> ${escapeHtml(t('author.run.terminal'))}</button>
                    <button type="button" role="tab" class="author-bottom-tab" id="author-bottom-tab-verify" data-action="bottom-verify" aria-controls="author-verify-panel" aria-selected="false"><i class="fas fa-list-check" aria-hidden="true"></i> ${escapeHtml(t('author.verify.tab'))}</button>
                    <button type="button" class="author-icon-btn author-bottom-close" id="author-bottom-close" data-action="close-bottom" title="${escapeHtml(t('common.close'))}" aria-label="${escapeHtml(t('common.close'))}"><i class="fas fa-times" aria-hidden="true"></i></button>
                  </div>
                  <div class="author-terminal-wrap" id="author-terminal-wrap" role="tabpanel">
                    <div class="author-terminal" id="author-terminal"></div>
                  </div>
                  <div id="author-verify-slot"></div>
                </div>
              </div>
            </div>
          </div>

          <aside class="author-settings-panel" id="author-settings-panel" aria-labelledby="author-export-heading" hidden>
            <div class="author-settings-head">
              <span id="author-export-heading">${escapeHtml(t('author.export.heading'))}</span>
              <button class="author-icon-btn" id="author-settings-close" title="${escapeHtml(t('common.close'))}" aria-label="${escapeHtml(t('common.close'))}"><i class="fas fa-times"></i></button>
            </div>
            <div class="author-settings-body">
              <div id="author-export-empty" hidden>
                <p class="author-hint">${escapeHtml(t('author.export.noExam'))}</p>
                <button type="button" class="author-btn" id="author-export-create" data-action="new-exam"><i class="fas fa-file-circle-plus" aria-hidden="true"></i> ${escapeHtml(t('author.export.createExam'))}</button>
              </div>
              <div class="author-field" id="author-export-target-field">
                <label for="author-export-target">${escapeHtml(t('author.export.target'))}</label>
                <select id="author-export-target" class="author-input"></select>
              </div>
              <p class="author-error" id="author-export-invalid" hidden>${escapeHtml(t('author.export.invalidTarget'))}</p>
              <dl class="author-meta author-export-summary" id="author-export-summary" hidden>
                <dt>${escapeHtml(t('author.export.examId'))}</dt><dd data-summary="exam-id"></dd>
                <dt>${escapeHtml(t('author.export.kind'))}</dt><dd data-summary="kind"></dd>
                <dt>${escapeHtml(t('author.export.languages'))}</dt><dd data-summary="languages"></dd>
                <dt>${escapeHtml(t('author.export.problems'))}</dt><dd data-summary="problems"></dd>
              </dl>
              <p class="author-hint" id="author-export-class-hint" hidden>${escapeHtml(t('author.export.classHint'))}</p>

              <div id="author-export-secrets" hidden>
                <div class="author-settings-divider"></div>
                <div class="author-field">
                  <label for="author-token">${escapeHtml(t('author.token.label'))}</label>
                  <div class="author-btn-row">
                    <input type="text" id="author-token" class="author-input author-mono" autocomplete="off" autocapitalize="characters" spellcheck="false">
                    <button class="author-btn" id="author-regen-token-btn"><i class="fas fa-rotate"></i> ${escapeHtml(t('author.token.regenerate'))}</button>
                  </div>
                  <p class="author-hint">${escapeHtml(t('author.token.hint'))}</p>
                </div>

                <div class="author-settings-divider"></div>
                <div class="author-field"><label>${escapeHtml(t('author.key.heading'))}</label></div>
                <div class="author-tabs">
                  <button class="author-tab-btn active" id="author-key-tab-existing">${escapeHtml(t('author.key.tabExisting'))}</button>
                  <button class="author-tab-btn" id="author-key-tab-generate">${escapeHtml(t('author.key.tabGenerate'))}</button>
                </div>
                <div id="author-key-pane-existing">
                  <div class="author-field">
                    <label for="author-keyid">${escapeHtml(t('author.key.keyIdLabel'))}</label>
                    <input type="text" id="author-keyid" class="author-input" placeholder="exam-202606-ab12cd" autocomplete="off" spellcheck="false">
                  </div>
                  <div class="author-field">
                    <label for="author-jwk">${escapeHtml(t('author.key.jwkLabel'))}</label>
                    <textarea id="author-jwk" class="author-textarea author-mono" rows="3" placeholder='{"kty":"EC","crv":"P-256","d":"...","x":"...","y":"..."}' spellcheck="false"></textarea>
                    <p class="author-hint">${escapeHtml(t('author.key.jwkHint'))}</p>
                  </div>
                </div>
                <div id="author-key-pane-generate" hidden>
                  <p class="author-hint">${escapeHtml(t('author.key.generateIntro'))}</p>
                  <button class="author-btn author-btn-primary" id="author-generate-key-btn"><i class="fas fa-key"></i> ${escapeHtml(t('author.key.generateButton'))}</button>
                  <div id="author-genkey-output" hidden></div>
                </div>
                <label class="author-check">
                  <input type="checkbox" id="author-embed-pubkey">
                  <span>${escapeHtml(t('author.token.embedPubkey'))}</span>
                </label>
              </div>
            </div>
            <div class="author-settings-foot">
              <div class="author-error" id="author-build-error" role="alert" hidden></div>
              <button class="author-btn author-btn-primary author-btn-block" id="author-build-btn" disabled>${this.buildButtonLabel(null)}</button>
            </div>
          </aside>
        </div>

        <footer class="statusbar">
          <div class="statusbar-left">
            <div class="status-item"><i class="fas fa-folder"></i> <span id="author-sb-folder"></span></div>
            <div class="status-item"><i class="fas fa-feather-pointed"></i> <span id="author-sb-exam"></span></div>
            <div class="status-item"><i class="fas fa-layer-group"></i> <span id="author-sb-count">0</span> ${escapeHtml(t('author.statusbar.problems'))}</div>
          </div>
          <div class="statusbar-right">
            <div class="status-item"><i class="fas fa-key"></i> <span id="author-sb-token" class="author-mono"></span></div>
          </div>
        </footer>

        <div class="author-result-overlay" id="author-result-overlay" hidden>
          <div class="author-result">
            <div class="author-result-head">
              <h3><i class="fas fa-circle-check"></i> ${escapeHtml(t('author.result.title'))}</h3>
              <button class="author-icon-btn" id="author-result-close" title="${escapeHtml(t('common.close'))}"><i class="fas fa-times"></i></button>
            </div>
            <div id="author-result-body"></div>
          </div>
        </div>
      </div>
    `;
  }
}
