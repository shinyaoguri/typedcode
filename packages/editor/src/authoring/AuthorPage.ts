/**
 * AuthorPage - 教員向け試験問題オーサリング UI (#80, ADR-0006)。
 *
 * `/author` で開く独立ページ (Monaco 非依存)。教員が CLI / git を触らずに:
 *   ① 出題者署名鍵を用意 (既存の私的 JWK を貼付 / その場で新規生成)
 *   ② 問題本文 + メタ + スケジュール + 許可言語を入力
 *   ③ 監督コードを自動生成 (or 手動)
 *   ④「生成」→ 署名済み `.tcexam` を DL + 監督コードを明示
 * を行えるようにする。暗号は authoring seam (examPackageAuthoring) 経由で shared に委譲し、
 * 鍵・問題はこのページの外 (ストレージ/ネットワーク) に一切出さない。
 */

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

/** datetime-local の値 (ローカル時刻) を ISO 文字列へ。空/不正なら空文字。 */
function localInputToIso(value: string): string {
  if (!value) return '';
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

/** Date を datetime-local の value 形式 (ローカル時刻 `YYYY-MM-DDTHH:mm`) へ。 */
function toLocalInputValue(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * 監督コードの控え (教員用・学生に配布しない) のテキストを組み立てる純関数。
 * コードは平文 manifest に含まれず紛失すると復号不能なので、画面表示に加えて
 * 教員が durable に保存できるようにする。`now` は注入してテスト可能にする。
 */
export function buildProctorMemo(result: CreatedExamPackage, filename: string, now: Date): string {
  const m = result.manifest;
  return [
    t('author.memo.title'),
    '='.repeat(56),
    `${t('author.memo.generatedAt')}: ${now.toISOString()}`,
    '',
    `${t('author.result.proctorCodeLabel')}: ${formatProctorTokenForDisplay(result.proctorToken)}`,
    '',
    `${t('author.memo.problemFile')}: ${filename}`,
    `examId:      ${m.examId}`,
    `problemId:   ${m.problemId}`,
    `variant:     ${m.variant ?? '(none)'}`,
    `keyId:       ${m.keyId}`,
    `packageHash: ${result.packageHash}`,
    `${t('author.result.release')} (T0): ${m.releaseTime}`,
    `${t('author.result.deadline')} (T1): ${m.deadline}`,
    '',
    `- ${t('author.memo.note1')}`,
    `- ${t('author.memo.note2')}`,
    `- ${t('author.memo.note3')}`,
    '',
  ].join('\n');
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

export class AuthorPage {
  private root: HTMLElement;
  /** 問題カードの一意 id 採番 (削除しても番号は再利用しない)。 */
  private problemSeq = 0;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  mount(): void {
    this.root.innerHTML = this.render();
    this.wire();
    // 既定スケジュール: release = 今, deadline = +3h。
    const now = new Date();
    const in3h = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    this.input('author-release').value = toLocalInputValue(now);
    this.input('author-deadline').value = toLocalInputValue(in3h);
    // 既定の監督コードを自動生成。
    this.input('author-token').value = generateProctorToken();
    // 最初の問題カードを1枚置く。
    this.addProblemCard();
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
    // --- 署名鍵: 既存貼付 / 新規生成 のタブ切替 ---
    const tabExisting = this.el('author-key-tab-existing');
    const tabGenerate = this.el('author-key-tab-generate');
    const paneExisting = this.el('author-key-pane-existing');
    const paneGenerate = this.el('author-key-pane-generate');
    const selectTab = (which: 'existing' | 'generate'): void => {
      const existing = which === 'existing';
      tabExisting.classList.toggle('active', existing);
      tabGenerate.classList.toggle('active', !existing);
      paneExisting.hidden = !existing;
      paneGenerate.hidden = existing;
    };
    tabExisting.addEventListener('click', () => selectTab('existing'));
    tabGenerate.addEventListener('click', () => selectTab('generate'));

    // --- 鍵生成 ---
    this.el('author-generate-key-btn').addEventListener('click', () => {
      void this.handleGenerateKey();
    });

    // --- 問題を追加 ---
    this.el('author-add-problem').addEventListener('click', () => this.addProblemCard());

    // --- 監督コード再生成 ---
    this.el('author-regen-token-btn').addEventListener('click', () => {
      this.input('author-token').value = generateProctorToken();
    });

    // --- パッケージ生成 ---
    this.el('author-build-btn').addEventListener('click', () => {
      void this.handleBuild();
    });
  }

  /** 1枚の問題カードを #author-problems に追加し、トグル/削除を配線する (ADR-0012)。 */
  private addProblemCard(): void {
    const seq = this.problemSeq++;
    const container = this.el('author-problems');
    const card = document.createElement('div');
    card.className = 'author-problem-card';
    card.dataset.seq = String(seq);
    card.innerHTML = `
      <div class="author-problem-head">
        <span class="author-problem-title"></span>
        <button class="author-btn author-problem-remove" type="button" title="${escapeHtml(t('author.problem.removeProblem'))}">
          <i class="fas fa-trash"></i>
        </button>
      </div>
      <div class="author-field">
        <label>${escapeHtml(t('author.problem.problemId'))}</label>
        <input type="text" class="author-input author-problem-id" placeholder="p${seq + 1}" autocomplete="off" spellcheck="false">
      </div>
      <div class="author-field">
        <label>${escapeHtml(t('author.problem.body'))}</label>
        <textarea class="author-textarea author-problem-statement" rows="6" placeholder="${escapeHtml(t('author.problem.bodyPlaceholder'))}"></textarea>
      </div>
      <label class="author-check">
        <input type="checkbox" class="author-starter-toggle">
        <span>${escapeHtml(t('author.problem.starterToggle'))}</span>
      </label>
      <div class="author-starter-fields" hidden>
        <div class="author-grid">
          <div class="author-field">
            <label>${escapeHtml(t('author.problem.starterFilename'))}</label>
            <input type="text" class="author-input author-starter-filename" placeholder="p${seq + 1}.c" autocomplete="off" spellcheck="false">
          </div>
          <div class="author-field">
            <label>${escapeHtml(t('author.problem.starterLanguage'))}</label>
            <input type="text" class="author-input author-starter-language" value="c" placeholder="c" autocomplete="off" spellcheck="false">
          </div>
        </div>
        <div class="author-field">
          <label>${escapeHtml(t('author.problem.starterContent'))}</label>
          <textarea class="author-textarea author-mono author-starter-content" rows="6" placeholder="#include <stdio.h>\n\nint main(void) {\n  // TODO\n  return 0;\n}"></textarea>
        </div>
      </div>
    `;
    container.appendChild(card);

    const toggle = card.querySelector<HTMLInputElement>('.author-starter-toggle')!;
    const starterFields = card.querySelector<HTMLElement>('.author-starter-fields')!;
    toggle.addEventListener('change', () => {
      starterFields.hidden = !toggle.checked;
    });
    card.querySelector<HTMLButtonElement>('.author-problem-remove')!.addEventListener('click', () => {
      // 最低 1 枚は残す。
      if (container.querySelectorAll('.author-problem-card').length <= 1) return;
      card.remove();
      this.renumberProblems();
    });

    this.renumberProblems();
  }

  /** カードのタイトルを「問題 N」に振り直す (追加/削除後)。 */
  private renumberProblems(): void {
    const cards = this.root.querySelectorAll<HTMLElement>('.author-problem-card');
    cards.forEach((card, i) => {
      const title = card.querySelector<HTMLElement>('.author-problem-title');
      if (title) title.textContent = t('author.problem.problemLabel', { n: i + 1 });
      // 1 枚だけのとき削除ボタンを無効化 (最低 1 問は要る)。
      const removeBtn = card.querySelector<HTMLButtonElement>('.author-problem-remove');
      if (removeBtn) removeBtn.disabled = cards.length <= 1;
    });
  }

  /** 問題カードを ExamBundleProblem[] に収集する (空 statement は弾かず seam に委ねる)。 */
  private collectProblems(): ExamBundleProblem[] {
    const cards = this.root.querySelectorAll<HTMLElement>('.author-problem-card');
    return Array.from(cards).map((card) => {
      const problemId = card.querySelector<HTMLInputElement>('.author-problem-id')!.value.trim();
      const statement = card.querySelector<HTMLTextAreaElement>('.author-problem-statement')!.value;
      const problem: ExamBundleProblem = { problemId, statement };
      const toggle = card.querySelector<HTMLInputElement>('.author-starter-toggle')!;
      if (toggle.checked) {
        problem.starter = {
          filename: card.querySelector<HTMLInputElement>('.author-starter-filename')!.value.trim(),
          language: card.querySelector<HTMLInputElement>('.author-starter-language')!.value.trim(),
          content: card.querySelector<HTMLTextAreaElement>('.author-starter-content')!.value,
        };
      }
      return problem;
    });
  }

  /** その場で出題者鍵を生成し、私的 JWK の DL・公開 entry の copy・署名フォーム自動入力を行う。 */
  private async handleGenerateKey(): Promise<void> {
    const out = this.el('author-genkey-output');
    try {
      const key = await generateAuthorityKey();
      // 署名フォームへ反映 (続けてパッケージ生成できるように)。
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
          <label>${escapeHtml(t('author.key.keyIdLabel'))}</label>
          <code class="author-code-inline">${escapeHtml(key.keyId)}</code>
        </div>
        <div class="author-field">
          <label>${escapeHtml(t('author.key.registryEntryLabel'))}</label>
          <pre class="author-pre" id="author-genkey-entry">${escapeHtml(entryJson)}</pre>
          <div class="author-btn-row">
            <button class="author-btn" id="author-copy-entry-btn">
              <i class="fas fa-copy"></i> ${escapeHtml(t('author.copy'))}
            </button>
            <button class="author-btn author-btn-primary" id="author-dl-privkey-btn">
              <i class="fas fa-download"></i> ${escapeHtml(t('author.key.downloadPrivate'))}
            </button>
          </div>
          <p class="author-hint">${escapeHtml(t('author.key.registryHint'))}</p>
        </div>
      `;
      this.el('author-copy-entry-btn').addEventListener('click', () => {
        void navigator.clipboard?.writeText(entryJson);
      });
      this.el('author-dl-privkey-btn').addEventListener('click', () => {
        downloadBlob(`${key.keyId}.private.jwk.json`, JSON.stringify(key.privateJwk, null, 2), 'application/json');
      });
    } catch {
      out.hidden = false;
      out.innerHTML = `<p class="author-error">${escapeHtml(t('author.key.generateFailed'))}</p>`;
    }
  }

  /** フォームを読み、署名済み .tcexam を生成して DL + 結果表示する。 */
  private async handleBuild(): Promise<void> {
    const errorEl = this.el('author-build-error');
    const resultEl = this.el('author-result');
    errorEl.hidden = true;
    resultEl.hidden = true;

    const keyId = this.input('author-keyid').value.trim();
    const jwkRaw = this.textarea('author-jwk').value.trim();
    if (!keyId || !jwkRaw) {
      this.showBuildError(t('author.build.errorNoKey'));
      return;
    }

    const languages = this.input('author-languages').value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const releaseTime = localInputToIso(this.input('author-release').value);
    const deadline = localInputToIso(this.input('author-deadline').value);
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
        {
          examId,
          problems: this.collectProblems(),
          languages,
          releaseTime,
          deadline,
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
        <button class="author-btn" id="author-redownload-btn">
          <i class="fas fa-download"></i> ${escapeHtml(t('author.result.redownload'))}
        </button>
      </p>
      <div class="author-token-box">
        <div class="author-token-label">${escapeHtml(t('author.result.proctorCodeLabel'))}</div>
        <div class="author-token-value" id="author-token-value">${escapeHtml(displayToken)}</div>
        <div class="author-btn-row author-token-actions">
          <button class="author-btn author-btn-primary" id="author-copy-token-btn">
            <i class="fas fa-copy"></i> ${escapeHtml(t('author.copy'))}
          </button>
          <button class="author-btn" id="author-dl-memo-btn">
            <i class="fas fa-file-lines"></i> ${escapeHtml(t('author.result.downloadMemo'))}
          </button>
        </div>
      </div>
      <div class="author-note author-note-warn">
        <i class="fas fa-triangle-exclamation"></i>
        <span>${escapeHtml(t('author.result.proctorWarning'))}</span>
      </div>
      <dl class="author-meta">
        <dt>${escapeHtml(t('author.result.keyId'))}</dt><dd><code>${escapeHtml(result.manifest.keyId)}</code></dd>
        <dt>${escapeHtml(t('author.result.packageHash'))}</dt><dd><code class="author-hash">${escapeHtml(result.packageHash)}</code></dd>
        <dt>${escapeHtml(t('author.result.release'))}</dt><dd>${escapeHtml(result.manifest.releaseTime)}</dd>
        <dt>${escapeHtml(t('author.result.deadline'))}</dt><dd>${escapeHtml(result.manifest.deadline)}</dd>
      </dl>
    `;
    this.el('author-copy-token-btn').addEventListener('click', () => {
      void navigator.clipboard?.writeText(result.proctorToken);
    });
    this.el('author-dl-memo-btn').addEventListener('click', () => {
      const memoName = `${result.manifest.problemId || 'problem'}-proctor-code.txt`;
      downloadBlob(memoName, buildProctorMemo(result, filename, new Date()), 'text/plain');
    });
    this.el('author-redownload-btn').addEventListener('click', () => {
      downloadBlob(filename, JSON.stringify(result.manifest, null, 2) + '\n', 'application/json');
    });
    resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  private render(): string {
    return `
      <div class="author-shell">
        <header class="author-header">
          <h1><i class="fas fa-feather-pointed"></i> ${escapeHtml(t('author.title'))}</h1>
          <p class="author-subtitle">${escapeHtml(t('author.subtitle'))}</p>
        </header>

        <section class="author-section">
          <h2><span class="author-step">1</span> ${escapeHtml(t('author.key.heading'))}</h2>
          <div class="author-tabs">
            <button class="author-tab active" id="author-key-tab-existing">${escapeHtml(t('author.key.tabExisting'))}</button>
            <button class="author-tab" id="author-key-tab-generate">${escapeHtml(t('author.key.tabGenerate'))}</button>
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
            <button class="author-btn author-btn-primary" id="author-generate-key-btn">
              <i class="fas fa-key"></i> ${escapeHtml(t('author.key.generateButton'))}
            </button>
            <div id="author-genkey-output" hidden></div>
          </div>
        </section>

        <section class="author-section">
          <h2><span class="author-step">2</span> ${escapeHtml(t('author.problem.heading'))}</h2>
          <div class="author-grid">
            <div class="author-field">
              <label for="author-exam-id">${escapeHtml(t('author.problem.examId'))}</label>
              <input type="text" id="author-exam-id" class="author-input" placeholder="2026-spring-cs101-final" autocomplete="off" spellcheck="false">
            </div>
            <div class="author-field">
              <label for="author-languages">${escapeHtml(t('author.problem.languages'))}</label>
              <input type="text" id="author-languages" class="author-input" value="c" placeholder="c, python" autocomplete="off" spellcheck="false">
            </div>
          </div>
          <p class="author-hint">${escapeHtml(t('author.problem.bundleHint'))}</p>
          <div id="author-problems"></div>
          <button class="author-btn" id="author-add-problem">
            <i class="fas fa-plus"></i> ${escapeHtml(t('author.problem.addProblem'))}
          </button>
        </section>

        <section class="author-section">
          <h2><span class="author-step">3</span> ${escapeHtml(t('author.schedule.heading'))}</h2>
          <div class="author-grid">
            <div class="author-field">
              <label for="author-release">${escapeHtml(t('author.schedule.release'))}</label>
              <input type="datetime-local" id="author-release" class="author-input">
            </div>
            <div class="author-field">
              <label for="author-deadline">${escapeHtml(t('author.schedule.deadline'))}</label>
              <input type="datetime-local" id="author-deadline" class="author-input">
            </div>
          </div>
          <p class="author-hint">${escapeHtml(t('author.schedule.hint'))}</p>
        </section>

        <section class="author-section">
          <h2><span class="author-step">4</span> ${escapeHtml(t('author.token.heading'))}</h2>
          <div class="author-field">
            <label for="author-token">${escapeHtml(t('author.token.label'))}</label>
            <div class="author-btn-row">
              <input type="text" id="author-token" class="author-input author-mono" autocomplete="off" autocapitalize="characters" spellcheck="false">
              <button class="author-btn" id="author-regen-token-btn">
                <i class="fas fa-rotate"></i> ${escapeHtml(t('author.token.regenerate'))}
              </button>
            </div>
            <p class="author-hint">${escapeHtml(t('author.token.hint'))}</p>
          </div>
          <label class="author-check">
            <input type="checkbox" id="author-embed-pubkey">
            <span>${escapeHtml(t('author.token.embedPubkey'))}</span>
          </label>
        </section>

        <section class="author-section">
          <button class="author-btn author-btn-primary author-btn-build" id="author-build-btn">
            <i class="fas fa-box-archive"></i> ${escapeHtml(t('author.build.button'))}
          </button>
          <p class="author-error" id="author-build-error" hidden></p>
          <div class="author-result" id="author-result" hidden></div>
        </section>
      </div>
    `;
  }
}
