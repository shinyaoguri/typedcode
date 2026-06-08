/**
 * AuthorPage - 教員向け試験問題オーサリング UI (#80, ADR-0006/0012)。
 *
 * `/author` で開く editor ライクなページ。教員が CLI / git を触らずに:
 *   ① 出題者署名鍵を用意 (既存 JWK 貼付 / その場で新規生成)
 *   ② 問題を **タブ = スターターファイル**で複数編集 (タブ名=ファイル名、ダブルクリックで改名)。
 *      各問は「問題文 (Monaco/Markdown) | スターターコード (Monaco)」の左右分割で書く。
 *   ③ 監督コードを自動生成 (or 手動)
 *   ④「生成」→ 署名済み N問バンドル `.tcexam` を DL + 監督コードを明示
 * を行えるようにする。暗号は authoring seam 経由で shared に委譲し、鍵・問題はこのページの
 * 外 (ストレージ/ネットワーク) に一切出さない。
 *
 * Monaco は proof/tracking 非依存に**単体で**使う (proof 密結合の EditorController は使わない)。
 * C実行 (動作確認) は Stage 2 で CodeExecutionController + CTerminal を同様に単体再利用する。
 */

import * as monaco from 'monaco-editor';
import { escapeHtml, type ExamBundleProblem } from '@typedcode/shared';
import { t } from '../i18n/index.js';
import {
  createExamBundlePackage,
  formatProctorTokenForDisplay,
  generateProctorToken,
  importAuthoritySigner,
  type CreatedExamPackage,
} from './examPackageAuthoring.js';
import { generateAuthorityKey } from './authorityKey.js';
import { buildProctorMemo } from './proctorMemo.js';

/**
 * オープンな締切 (ADR-0012 改良: スケジュールは Moodle 管理)。manifest 仕様上 deadline は
 * 必須なので、実質「窓を設けない」意味の遠い未来を入れる。releaseTime(=生成時刻) < deadline を満たす。
 */
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

  constructor(root: HTMLElement) {
    this.root = root;
  }

  private get monacoTheme(): string {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'vs' : 'vs-dark';
  }

  mount(): void {
    this.root.innerHTML = this.render();
    this.statementEditor = monaco.editor.create(this.el('author-statement-editor'), {
      language: 'markdown',
      theme: this.monacoTheme,
      minimap: { enabled: false },
      automaticLayout: true,
      wordWrap: 'on',
      lineNumbers: 'off',
      fontSize: 13,
    });
    this.starterEditor = monaco.editor.create(this.el('author-starter-editor'), {
      language: 'c',
      theme: this.monacoTheme,
      minimap: { enabled: false },
      automaticLayout: true,
      fontSize: 13,
    });
    this.wire();
    this.input('author-token').value = generateProctorToken();
    this.addProblem();
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
    // 鍵設定パネルのトグル。
    this.el('author-key-toggle').addEventListener('click', () => {
      const panel = this.el('author-key-panel');
      panel.hidden = !panel.hidden;
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

    // 問題タブ.
    this.el('author-add-tab').addEventListener('click', () => this.addProblem());

    // 監督コード再生成.
    this.el('author-regen-token-btn').addEventListener('click', () => {
      this.input('author-token').value = generateProctorToken();
    });

    // 生成.
    this.el('author-build-btn').addEventListener('click', () => void this.handleBuild());
  }

  // --- 問題タブ管理 -----------------------------------------------------------

  /** 新しい問題 (タブ = スターターファイル) を追加してアクティブにする。 */
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
  }

  /** 指定問題をアクティブにし、両エディタに該当モデルを付け替える。 */
  private switchProblem(id: string): void {
    // 直前の problemId 入力を保存。
    this.commitActiveProblemId();
    const problem = this.problems.find((p) => p.id === id);
    if (!problem) return;
    this.activeId = id;
    this.statementEditor.setModel(problem.statementModel);
    this.starterEditor.setModel(problem.starterModel);
    this.input('author-active-problemid').value = problem.problemId;
    this.renderTabs();
  }

  /** problemId 入力欄の値をアクティブ問題へ反映する。 */
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
      const next = this.problems[Math.max(0, idx - 1)]!;
      this.activeId = null; // commit をスキップ (削除済み)
      this.switchProblem(next.id);
    } else {
      this.renderTabs();
    }
  }

  /** タブのファイル名を改名し、拡張子から言語を更新する。 */
  private renameProblem(id: string, newName: string): void {
    const problem = this.problems.find((p) => p.id === id);
    const filename = newName.trim();
    if (!problem || !filename) {
      this.renderTabs();
      return;
    }
    problem.filename = filename;
    monaco.editor.setModelLanguage(problem.starterModel, extensionToLanguage(filename));
    this.renderTabs();
  }

  private renderTabs(): void {
    const strip = this.el('author-tabstrip');
    strip.querySelectorAll('.author-tab').forEach((e) => e.remove());
    const addBtn = this.el('author-add-tab');
    for (const problem of this.problems) {
      const tab = document.createElement('div');
      tab.className = 'author-tab' + (problem.id === this.activeId ? ' active' : '');
      tab.innerHTML = `
        <span class="author-tab-label" title="${escapeHtml(t('author.problem.renameHint'))}">${escapeHtml(problem.filename)}</span>
        <button class="author-tab-close" type="button" title="${escapeHtml(t('author.problem.removeProblem'))}" ${this.problems.length <= 1 ? 'disabled' : ''}>&times;</button>
      `;
      tab.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('.author-tab-close')) return;
        this.switchProblem(problem.id);
      });
      const label = tab.querySelector<HTMLElement>('.author-tab-label')!;
      label.addEventListener('dblclick', () => this.startRename(problem, label));
      tab.querySelector<HTMLButtonElement>('.author-tab-close')!.addEventListener('click', () =>
        this.removeProblem(problem.id)
      );
      strip.insertBefore(tab, addBtn);
    }
  }

  /** タブのファイル名をインライン入力で改名する。 */
  private startRename(problem: AuthorProblem, label: HTMLElement): void {
    const input = document.createElement('input');
    input.className = 'author-tab-rename';
    input.value = problem.filename;
    label.replaceWith(input);
    input.focus();
    input.select();
    const commit = (): void => this.renameProblem(problem.id, input.value);
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') {
        input.value = problem.filename;
        input.blur();
      }
    });
  }

  /** 編集中の全問題を ExamBundleProblem[] に収集する。 */
  private collectProblems(): ExamBundleProblem[] {
    this.commitActiveProblemId();
    return this.problems.map((p) => {
      const problem: ExamBundleProblem = {
        problemId: p.problemId,
        statement: p.statementModel.getValue(),
      };
      const content = p.starterModel.getValue();
      if (content.length > 0) {
        problem.starter = {
          filename: p.filename,
          language: extensionToLanguage(p.filename),
          content,
        };
      }
      return problem;
    });
  }

  // --- 鍵生成 / ビルド ---------------------------------------------------------

  /** その場で出題者鍵を生成し、私的 JWK の DL・公開 entry の copy・署名フォーム自動入力を行う。 */
  private async handleGenerateKey(): Promise<void> {
    const out = this.el('author-genkey-output');
    try {
      const key = await generateAuthorityKey();
      this.input('author-keyid').value = key.keyId;
      this.textarea('author-jwk').value = JSON.stringify(key.privateJwk);
      const entryJson = JSON.stringify(key.registryEntry, null, 2);
      out.hidden = false;
      out.innerHTML = `
        <div class="author-note author-note-warn">
          <i class="fas fa-triangle-exclamation"></i>
          <span>${escapeHtml(t('author.key.privateWarning'))}</span>
        </div>
        <div class="author-field">
          <label>${escapeHtml(t('author.key.registryEntryLabel'))}</label>
          <pre class="author-pre">${escapeHtml(entryJson)}</pre>
          <div class="author-btn-row">
            <button class="author-btn" id="author-copy-entry-btn"><i class="fas fa-copy"></i> ${escapeHtml(t('author.copy'))}</button>
            <button class="author-btn author-btn-primary" id="author-dl-privkey-btn"><i class="fas fa-download"></i> ${escapeHtml(t('author.key.downloadPrivate'))}</button>
          </div>
          <p class="author-hint">${escapeHtml(t('author.key.registryHint'))}</p>
        </div>
      `;
      this.el('author-copy-entry-btn').addEventListener('click', () => void navigator.clipboard?.writeText(entryJson));
      this.el('author-dl-privkey-btn').addEventListener('click', () =>
        downloadBlob(`${key.keyId}.private.jwk.json`, JSON.stringify(key.privateJwk, null, 2), 'application/json')
      );
    } catch {
      out.hidden = false;
      out.innerHTML = `<p class="author-error">${escapeHtml(t('author.key.generateFailed'))}</p>`;
    }
  }

  /** フォーム+問題を読み、署名済み N問バンドル .tcexam を生成して DL + 結果表示する。 */
  private async handleBuild(): Promise<void> {
    this.el('author-build-error').hidden = true;
    this.el('author-result').hidden = true;

    const keyId = this.input('author-keyid').value.trim();
    const jwkRaw = this.textarea('author-jwk').value.trim();
    if (!keyId || !jwkRaw) {
      this.el('author-key-panel').hidden = false;
      this.showBuildError(t('author.build.errorNoKey'));
      return;
    }

    const languages = this.input('author-languages').value.split(',').map((s) => s.trim()).filter(Boolean);
    const examId = this.input('author-exam-id').value.trim();
    const releaseTime = new Date().toISOString();

    const buildBtn = this.el('author-build-btn') as HTMLButtonElement;
    const originalLabel = buildBtn.innerHTML;
    buildBtn.disabled = true;
    buildBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${escapeHtml(t('author.build.working'))}`;
    try {
      const signer = await importAuthoritySigner(jwkRaw, keyId, {
        embedPublicKey: this.input('author-embed-pubkey').checked,
      });
      const result = await createExamBundlePackage(
        {
          examId,
          problems: this.collectProblems(),
          languages,
          releaseTime,
          deadline: OPEN_DEADLINE,
          proctorToken: this.input('author-token').value,
        },
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
    const resultEl = this.el('author-result');
    const displayToken = formatProctorTokenForDisplay(result.proctorToken);
    resultEl.hidden = false;
    resultEl.innerHTML = `
      <h3><i class="fas fa-circle-check"></i> ${escapeHtml(t('author.result.title'))}</h3>
      <p class="author-result-file">
        <i class="fas fa-file-shield"></i> ${escapeHtml(filename)}
        <button class="author-btn" id="author-redownload-btn"><i class="fas fa-download"></i> ${escapeHtml(t('author.result.redownload'))}</button>
      </p>
      <div class="author-token-box">
        <div class="author-token-label">${escapeHtml(t('author.result.proctorCodeLabel'))}</div>
        <div class="author-token-value">${escapeHtml(displayToken)}</div>
        <div class="author-btn-row author-token-actions">
          <button class="author-btn author-btn-primary" id="author-copy-token-btn"><i class="fas fa-copy"></i> ${escapeHtml(t('author.copy'))}</button>
          <button class="author-btn" id="author-dl-memo-btn"><i class="fas fa-file-lines"></i> ${escapeHtml(t('author.result.downloadMemo'))}</button>
        </div>
      </div>
      <div class="author-note author-note-warn">
        <i class="fas fa-triangle-exclamation"></i>
        <span>${escapeHtml(t('author.result.proctorWarning'))}</span>
      </div>
      <dl class="author-meta">
        <dt>${escapeHtml(t('author.result.keyId'))}</dt><dd><code>${escapeHtml(result.manifest.keyId)}</code></dd>
        <dt>${escapeHtml(t('author.result.packageHash'))}</dt><dd><code class="author-hash">${escapeHtml(result.packageHash)}</code></dd>
      </dl>
    `;
    this.el('author-copy-token-btn').addEventListener('click', () => void navigator.clipboard?.writeText(result.proctorToken));
    this.el('author-dl-memo-btn').addEventListener('click', () =>
      downloadBlob(`${result.manifest.examId || 'exam'}-proctor-code.txt`, buildProctorMemo(result, filename, new Date()), 'text/plain')
    );
    this.el('author-redownload-btn').addEventListener('click', () =>
      downloadBlob(filename, JSON.stringify(result.manifest, null, 2) + '\n', 'application/json')
    );
    resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  private render(): string {
    return `
      <div class="author-app">
        <header class="author-toolbar">
          <div class="author-toolbar-brand"><i class="fas fa-feather-pointed"></i> ${escapeHtml(t('author.title'))}</div>
          <input type="text" id="author-exam-id" class="author-input author-toolbar-input" placeholder="${escapeHtml(t('author.problem.examId'))}" autocomplete="off" spellcheck="false">
          <input type="text" id="author-languages" class="author-input author-toolbar-input author-toolbar-narrow" value="c" placeholder="${escapeHtml(t('author.problem.languages'))}" autocomplete="off" spellcheck="false">
          <input type="text" id="author-token" class="author-input author-mono author-toolbar-narrow" autocomplete="off" autocapitalize="characters" spellcheck="false" title="${escapeHtml(t('author.token.label'))}">
          <button class="author-btn" id="author-regen-token-btn" title="${escapeHtml(t('author.token.regenerate'))}"><i class="fas fa-rotate"></i></button>
          <button class="author-btn" id="author-key-toggle"><i class="fas fa-key"></i> ${escapeHtml(t('author.key.settings'))}</button>
          <span class="author-toolbar-spacer"></span>
          <button class="author-btn author-btn-primary" id="author-build-btn"><i class="fas fa-box-archive"></i> ${escapeHtml(t('author.build.button'))}</button>
        </header>

        <section class="author-key-panel" id="author-key-panel" hidden>
          <div class="author-tabs">
            <button class="author-tab-btn active" id="author-key-tab-existing">${escapeHtml(t('author.key.tabExisting'))}</button>
            <button class="author-tab-btn" id="author-key-tab-generate">${escapeHtml(t('author.key.tabGenerate'))}</button>
          </div>
          <div id="author-key-pane-existing">
            <div class="author-grid">
              <div class="author-field">
                <label for="author-keyid">${escapeHtml(t('author.key.keyIdLabel'))}</label>
                <input type="text" id="author-keyid" class="author-input" placeholder="exam-202606-ab12cd" autocomplete="off" spellcheck="false">
              </div>
              <div class="author-field">
                <label>${escapeHtml(t('author.key.jwkLabel'))}</label>
                <textarea id="author-jwk" class="author-textarea author-mono" rows="2" placeholder='{"kty":"EC","crv":"P-256","d":"...","x":"...","y":"..."}' spellcheck="false"></textarea>
              </div>
            </div>
            <p class="author-hint">${escapeHtml(t('author.key.jwkHint'))}</p>
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
        </section>

        <div class="author-tabstrip" id="author-tabstrip">
          <button class="author-add-tab" id="author-add-tab" title="${escapeHtml(t('author.problem.addProblem'))}"><i class="fas fa-plus"></i></button>
        </div>

        <div class="author-editor-split">
          <div class="author-pane">
            <div class="author-pane-header">
              <span>${escapeHtml(t('author.problem.body'))}</span>
              <span class="author-pane-sub">problemId: <input type="text" id="author-active-problemid" class="author-input author-inline-input" autocomplete="off" spellcheck="false"></span>
            </div>
            <div class="author-monaco" id="author-statement-editor"></div>
          </div>
          <div class="author-pane">
            <div class="author-pane-header"><span>${escapeHtml(t('author.problem.starterPane'))}</span></div>
            <div class="author-monaco" id="author-starter-editor"></div>
          </div>
        </div>

        <p class="author-error" id="author-build-error" hidden></p>
        <div class="author-result" id="author-result" hidden></div>
      </div>
    `;
  }
}
