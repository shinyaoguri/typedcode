/**
 * AuthorPage - 教員向け試験問題オーサリング UI (#80, ADR-0006/0012)。
 *
 * `/author` で開く editor ライクなページ。editor と同じクロム構造
 * (titlebar / activitybar / workbench / statusbar) を採り、出題の見た目を作成アプリに揃える。
 * 教員は CLI / git を触らずに:
 *   ① パッケージ設定 (examId / 許可言語 / 監督コード / 出題者署名鍵) を設定パネルで入力
 *   ② 問題を **タブ = スターターファイル**で複数編集 (タブ名=ファイル名、ダブルクリックで改名)。
 *      各問は「問題文 (Monaco/Markdown) | スターターコード (Monaco)」の左右分割で書く。
 *   ③「生成」→ 署名済み N問バンドル `.tcexam` を DL + 監督コードを明示
 * を行えるようにする。暗号は authoring seam 経由で shared に委譲し、鍵・問題はこのページの
 * 外 (ストレージ/ネットワーク) に一切出さない。
 *
 * Monaco は proof/tracking 非依存に**単体で**使う (proof 密結合の EditorController は使わない)。
 */

import * as monaco from 'monaco-editor';
import { escapeHtml, type ExamBundleProblem } from '@typedcode/shared';
import { t, getI18n } from '../i18n/index.js';
import {
  createExamBundlePackage,
  formatProctorTokenForDisplay,
  generateProctorToken,
  importAuthoritySigner,
  type CreatedExamPackage,
} from './examPackageAuthoring.js';
import { generateAuthorityKey } from './authorityKey.js';
import { buildProctorMemo } from './proctorMemo.js';
import { renderMarkdown } from '../utils/markdown.js';
// 実行系は重い (Wasmer/xterm) ので**初回実行時に動的 import** する (型のみ静的)。
import type { CodeExecutionController } from '../execution/CodeExecutionController.js';
import type { CTerminal } from '../terminal/CTerminal.js';

/** オープンな締切 (ADR-0013: スケジュールは Moodle 管理)。manifest 仕様上 deadline は必須。 */
const OPEN_DEADLINE = '2999-12-31T23:59:59.999Z';

/** ファイル拡張子 → Monaco/実行の言語 ID。 */
function extensionToLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
    py: 'python', js: 'javascript', ts: 'typescript',
  };
  return map[ext] ?? 'plaintext';
}

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

/** 1問の編集状態。問題文/スターターは Monaco モデルで保持する (タブ切替でエディタに付替)。 */
interface AuthorProblem {
  id: string;
  problemId: string;
  filename: string;
  statementModel: monaco.editor.ITextModel;
  starterModel: monaco.editor.ITextModel;
}

export class AuthorPage {
  private root: HTMLElement;
  private problems: AuthorProblem[] = [];
  private activeId: string | null = null;
  private seq = 0;
  private statementEditor!: monaco.editor.IStandaloneCodeEditor;
  private starterEditor!: monaco.editor.IStandaloneCodeEditor;
  private exec: CodeExecutionController | null = null;
  private terminal: CTerminal | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  private get monacoTheme(): string {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'vs' : 'vs-dark';
  }

  mount(): void {
    this.root.innerHTML = this.render();
    this.statementEditor = monaco.editor.create(this.el('author-statement-editor'), {
      language: 'markdown', theme: this.monacoTheme, minimap: { enabled: false },
      automaticLayout: true, wordWrap: 'on', lineNumbers: 'off', fontSize: 13,
    });
    this.starterEditor = monaco.editor.create(this.el('author-starter-editor'), {
      language: 'c', theme: this.monacoTheme, minimap: { enabled: false },
      automaticLayout: true, fontSize: 13,
    });
    this.wire();
    this.input('author-token').value = generateProctorToken();
    this.addProblem();
    this.updateStatusbar();
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

  private wire(): void {
    // パッケージ設定パネルのトグル。
    this.el('author-settings-toggle').addEventListener('click', () => {
      const p = this.el('author-settings-panel');
      p.hidden = !p.hidden;
    });
    this.el('author-settings-close').addEventListener('click', () => {
      this.el('author-settings-panel').hidden = true;
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

    // 問題タブ追加 / 監督コード再生成 / 生成。
    this.el('author-add-tab').addEventListener('click', () => this.addProblem());
    this.el('author-regen-token-btn').addEventListener('click', () => {
      this.input('author-token').value = generateProctorToken();
      this.updateStatusbar();
    });
    this.el('author-build-btn').addEventListener('click', () => void this.handleBuild());

    // examId / token 変更で statusbar を更新。
    this.input('author-exam-id').addEventListener('input', () => this.updateStatusbar());
    this.input('author-token').addEventListener('input', () => this.updateStatusbar());

    // 問題文の 編集 / プレビュー 切替。
    this.el('author-stmt-edit').addEventListener('click', () => this.setStatementPreview(false));
    this.el('author-stmt-preview').addEventListener('click', () => this.setStatementPreview(true));

    // スターターコードの 実行 / ターミナル。
    this.el('author-run-btn').addEventListener('click', () => void this.handleRun());
    this.el('author-term-toggle').addEventListener('click', () => {
      const w = this.el('author-terminal-wrap');
      this.showTerminal(w.hidden !== false);
    });

    // アプリ設定: テーマ / 言語。
    this.el('author-theme-toggle').addEventListener('click', () => this.toggleTheme());
    this.el('author-lang-toggle').addEventListener('click', () => this.toggleLocale());

    // 結果モーダルを閉じる。
    this.el('author-result-close').addEventListener('click', () => {
      this.el('author-result-overlay').hidden = true;
    });
  }

  /** 問題文ペインを 編集(Monaco) / プレビュー(レンダリング) で切り替える。 */
  private setStatementPreview(preview: boolean): void {
    this.el('author-stmt-edit').classList.toggle('active', !preview);
    this.el('author-stmt-preview').classList.toggle('active', preview);
    const editor = this.el('author-statement-editor');
    const previewEl = this.el('author-statement-preview');
    if (preview) {
      previewEl.innerHTML = renderMarkdown(this.statementEditor.getModel()?.getValue() ?? '');
      editor.hidden = true;
      previewEl.hidden = false;
    } else {
      previewEl.hidden = true;
      editor.hidden = false;
      this.statementEditor.layout();
    }
  }

  /** ターミナル領域の表示/非表示。表示時は fit して xterm を再計算する。 */
  private showTerminal(show: boolean): void {
    this.el('author-terminal-wrap').hidden = !show;
    this.el('author-term-toggle').classList.toggle('active', show);
    if (show && this.terminal) setTimeout(() => this.terminal?.fit(), 0);
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
    exec.setCallbacks({
      onRunStart: () => { runBtn.disabled = true; runBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${escapeHtml(t('author.run.running'))}`; },
      onRunEnd: () => { runBtn.disabled = false; runBtn.innerHTML = `<i class="fas fa-play"></i> ${escapeHtml(t('author.run.label'))}`; },
      onNotification: (m) => terminal.writeLine(m),
      onShowClangLoading: () => terminal.writeInfo(t('author.run.compilerLoading')),
      onUpdateClangStatus: (m) => terminal.writeInfo(m),
    });
    this.exec = exec;
    this.terminal = terminal;
    return { exec, terminal };
  }

  /** アクティブ問題のスターターコードを editor と同じ実行系で動かす (Cコンパイラ等)。 */
  private async handleRun(): Promise<void> {
    const active = this.problems.find((p) => p.id === this.activeId);
    if (!active) return;
    this.showTerminal(true);
    const { exec, terminal } = await this.ensureRuntime();
    terminal.clear();
    terminal.fit();
    await exec.run({
      language: extensionToLanguage(active.filename),
      filename: active.filename,
      code: active.starterModel.getValue(),
    });
  }

  private toggleTheme(): void {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('typedcode-theme', next); } catch { /* ignore */ }
    monaco.editor.setTheme(next === 'light' ? 'vs' : 'vs-dark');
  }

  private toggleLocale(): void {
    const i18n = getI18n();
    i18n.setLocale(i18n.getLocale() === 'ja' ? 'en' : 'ja');
    // Monaco モデルを保ったまま再描画するため、ページをリロードせず chrome を作り直す手間を避け、
    // 簡潔さのためロケールのみ localStorage に保存してリロード (編集中の内容は確認ダイアログで保護)。
    if (confirm(t('author.reloadForLocale'))) location.reload();
  }

  // --- 問題タブ管理 -----------------------------------------------------------

  private addProblem(): void {
    const n = this.seq++;
    const filename = `p${n + 1}.c`;
    const problem: AuthorProblem = {
      id: `prob-${n}`,
      problemId: `p${n + 1}`,
      filename,
      statementModel: monaco.editor.createModel('', 'markdown'),
      starterModel: monaco.editor.createModel('', extensionToLanguage(filename)),
    };
    this.problems.push(problem);
    this.switchProblem(problem.id);
    this.renderTabs();
    this.updateStatusbar();
  }

  private switchProblem(id: string): void {
    this.commitActiveProblemId();
    const problem = this.problems.find((p) => p.id === id);
    if (!problem) return;
    this.activeId = id;
    this.statementEditor.setModel(problem.statementModel);
    this.starterEditor.setModel(problem.starterModel);
    this.input('author-active-problemid').value = problem.problemId;
    this.setStatementPreview(false); // タブ切替時は編集に戻す (プレビューの取り違え防止)
    this.renderTabs();
    this.updateStatusbar();
  }

  private commitActiveProblemId(): void {
    if (!this.activeId) return;
    const active = this.problems.find((p) => p.id === this.activeId);
    const field = this.root.querySelector<HTMLInputElement>('#author-active-problemid');
    if (active && field) active.problemId = field.value.trim();
  }

  private removeProblem(id: string): void {
    if (this.problems.length <= 1) return;
    const idx = this.problems.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const [removed] = this.problems.splice(idx, 1);
    removed?.statementModel.dispose();
    removed?.starterModel.dispose();
    if (this.activeId === id) {
      this.activeId = null;
      this.switchProblem(this.problems[Math.max(0, idx - 1)]!.id);
    } else {
      this.renderTabs();
    }
    this.updateStatusbar();
  }

  private renameProblem(id: string, newName: string): void {
    const problem = this.problems.find((p) => p.id === id);
    const filename = newName.trim();
    if (!problem || !filename) { this.renderTabs(); return; }
    problem.filename = filename;
    monaco.editor.setModelLanguage(problem.starterModel, extensionToLanguage(filename));
    this.renderTabs();
  }

  private renderTabs(): void {
    const strip = this.el('author-tabs');
    strip.innerHTML = '';
    for (const problem of this.problems) {
      const tab = document.createElement('div');
      tab.className = 'editor-tab' + (problem.id === this.activeId ? ' active' : '');
      tab.dataset.id = problem.id;
      tab.innerHTML = `
        <i class="fas fa-file-code tab-icon"></i>
        <span class="tab-filename" title="${escapeHtml(t('author.problem.renameHint'))}">${escapeHtml(problem.filename)}</span>
        <button class="tab-close-btn" type="button" title="${escapeHtml(t('author.problem.removeProblem'))}" ${this.problems.length <= 1 ? 'disabled' : ''}><i class="fas fa-times"></i></button>
      `;
      tab.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.tab-close-btn')) return;
        this.switchProblem(problem.id);
      });
      tab.querySelector<HTMLElement>('.tab-filename')!.addEventListener('dblclick', (e) =>
        this.startRename(problem, e.currentTarget as HTMLElement)
      );
      tab.querySelector<HTMLButtonElement>('.tab-close-btn')!.addEventListener('click', () =>
        this.removeProblem(problem.id)
      );
      strip.appendChild(tab);
    }
  }

  private startRename(problem: AuthorProblem, label: HTMLElement): void {
    const input = document.createElement('input');
    input.className = 'tab-filename-input';
    input.value = problem.filename;
    label.replaceWith(input);
    input.focus();
    input.select();
    const commit = (): void => this.renameProblem(problem.id, input.value);
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { input.value = problem.filename; input.blur(); }
    });
  }

  private collectProblems(): ExamBundleProblem[] {
    this.commitActiveProblemId();
    return this.problems.map((p) => {
      const problem: ExamBundleProblem = { problemId: p.problemId, statement: p.statementModel.getValue() };
      const content = p.starterModel.getValue();
      if (content.length > 0) {
        problem.starter = { filename: p.filename, language: extensionToLanguage(p.filename), content };
      }
      return problem;
    });
  }

  private updateStatusbar(): void {
    const examId = this.input('author-exam-id').value.trim();
    this.el('author-sb-exam').textContent = examId || t('author.statusbar.noExamId');
    this.el('author-sb-count').textContent = String(this.problems.length);
    this.el('author-sb-token').textContent = formatProctorTokenForDisplay(this.input('author-token').value);
  }

  // --- 鍵生成 / ビルド ---------------------------------------------------------

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

  private async handleBuild(): Promise<void> {
    this.el('author-build-error').hidden = true;

    const keyId = this.input('author-keyid').value.trim();
    const jwkRaw = this.textarea('author-jwk').value.trim();
    if (!keyId || !jwkRaw) {
      this.el('author-settings-panel').hidden = false;
      this.showBuildError(t('author.build.errorNoKey'));
      return;
    }
    const languages = this.input('author-languages').value.split(',').map((s) => s.trim()).filter(Boolean);
    const examId = this.input('author-exam-id').value.trim();

    const buildBtn = this.el('author-build-btn') as HTMLButtonElement;
    const originalLabel = buildBtn.innerHTML;
    buildBtn.disabled = true;
    buildBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${escapeHtml(t('author.build.working'))}`;
    try {
      const signer = await importAuthoritySigner(jwkRaw, keyId, {
        embedPublicKey: this.input('author-embed-pubkey').checked,
      });
      const result = await createExamBundlePackage(
        { examId, problems: this.collectProblems(), languages, releaseTime: new Date().toISOString(), deadline: OPEN_DEADLINE, proctorToken: this.input('author-token').value },
        signer
      );
      const filename = `${examId || 'exam'}.tcexam`;
      downloadBlob(filename, JSON.stringify(result.manifest, null, 2) + '\n', 'application/json');
      this.showResult(result, filename);
    } catch (err) {
      this.showBuildError(err instanceof Error ? err.message : t('author.build.errorGeneric'));
    } finally {
      buildBtn.disabled = false;
      buildBtn.innerHTML = originalLabel;
    }
  }

  private showBuildError(msg: string): void {
    const errorEl = this.el('author-build-error');
    errorEl.textContent = msg;
    errorEl.hidden = false;
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
    this.el('author-copy-token-btn').addEventListener('click', () => void navigator.clipboard?.writeText(result.proctorToken));
    this.el('author-dl-memo-btn').addEventListener('click', () =>
      downloadBlob(`${result.manifest.examId || 'exam'}-proctor-code.txt`, buildProctorMemo(result, filename, new Date()), 'text/plain')
    );
    this.el('author-redownload-btn').addEventListener('click', () =>
      downloadBlob(filename, JSON.stringify(result.manifest, null, 2) + '\n', 'application/json')
    );
    overlay.hidden = false;
  }

  private render(): string {
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
              <button class="activitybar-item" id="author-settings-toggle" title="${escapeHtml(t('author.settings.heading'))}"><i class="fas fa-sliders"></i></button>
            </div>
            <div class="activitybar-bottom">
              <a class="activitybar-item" href="/verify/" target="_blank" rel="noopener noreferrer" title="${escapeHtml(t('settings.verifyProof'))}"><i class="fas fa-circle-check"></i></a>
              <button class="activitybar-item" id="author-lang-toggle" title="${escapeHtml(t('settings.language'))}"><i class="fas fa-globe"></i></button>
              <button class="activitybar-item" id="author-theme-toggle" title="${escapeHtml(t('settings.toggleTheme'))}"><i class="fas fa-moon"></i></button>
            </div>
          </nav>

          <div class="author-workbench">
            <div class="editor-tabs-container">
              <div class="editor-tabs" id="author-tabs"></div>
              <button class="add-tab-btn" id="author-add-tab" title="${escapeHtml(t('author.problem.addProblem'))}"><i class="fas fa-plus"></i></button>
            </div>
            <div class="author-editor-split">
              <div class="author-pane">
                <div class="author-pane-header">
                  <span class="author-seg">
                    <button class="author-seg-btn active" id="author-stmt-edit">${escapeHtml(t('author.preview.edit'))}</button>
                    <button class="author-seg-btn" id="author-stmt-preview">${escapeHtml(t('author.preview.preview'))}</button>
                  </span>
                  <span class="author-pane-sub">problemId: <input type="text" id="author-active-problemid" class="author-inline-input" autocomplete="off" spellcheck="false"></span>
                </div>
                <div class="author-pane-body">
                  <div class="author-monaco" id="author-statement-editor"></div>
                  <div class="markdown-rendered author-preview" id="author-statement-preview" hidden></div>
                </div>
              </div>
              <div class="author-pane">
                <div class="author-pane-header">
                  <span>${escapeHtml(t('author.problem.starterPane'))}</span>
                  <span class="author-pane-tools">
                    <button class="author-pane-btn" id="author-run-btn"><i class="fas fa-play"></i> ${escapeHtml(t('author.run.label'))}</button>
                    <button class="author-pane-btn" id="author-term-toggle" title="${escapeHtml(t('author.run.terminal'))}"><i class="fas fa-terminal"></i></button>
                  </span>
                </div>
                <div class="author-pane-body author-starter-body">
                  <div class="author-monaco" id="author-starter-editor"></div>
                  <div class="author-terminal-wrap" id="author-terminal-wrap" hidden>
                    <div class="author-terminal" id="author-terminal"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <aside class="author-settings-panel" id="author-settings-panel">
            <div class="author-settings-head">
              <span>${escapeHtml(t('author.settings.heading'))}</span>
              <button class="author-icon-btn" id="author-settings-close" title="${escapeHtml(t('common.close'))}"><i class="fas fa-times"></i></button>
            </div>
            <div class="author-settings-body">
              <div class="author-field">
                <label for="author-exam-id">${escapeHtml(t('author.problem.examId'))}</label>
                <input type="text" id="author-exam-id" class="author-input" placeholder="2026-spring-cs101-final" autocomplete="off" spellcheck="false">
              </div>
              <div class="author-field">
                <label for="author-languages">${escapeHtml(t('author.problem.languages'))}</label>
                <input type="text" id="author-languages" class="author-input" value="c" placeholder="c, python" autocomplete="off" spellcheck="false">
              </div>
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
            <div class="author-settings-foot">
              <p class="author-error" id="author-build-error" hidden></p>
              <button class="author-btn author-btn-primary author-btn-block" id="author-build-btn"><i class="fas fa-box-archive"></i> ${escapeHtml(t('author.build.button'))}</button>
            </div>
          </aside>
        </div>

        <footer class="statusbar">
          <div class="statusbar-left">
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
