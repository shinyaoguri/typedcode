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

import { escapeHtml } from '@typedcode/shared';
import { t } from '../i18n/index.js';
import {
  createExamPackage,
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

    // --- 監督コード再生成 ---
    this.el('author-regen-token-btn').addEventListener('click', () => {
      this.input('author-token').value = generateProctorToken();
    });

    // --- パッケージ生成 ---
    this.el('author-build-btn').addEventListener('click', () => {
      void this.handleBuild();
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
    const variantRaw = this.input('author-variant').value.trim();

    const buildBtn = this.el('author-build-btn') as HTMLButtonElement;
    const originalLabel = buildBtn.innerHTML;
    buildBtn.disabled = true;
    buildBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${escapeHtml(t('author.build.working'))}`;

    try {
      const signer = await importAuthoritySigner(jwkRaw, keyId, {
        embedPublicKey: this.input('author-embed-pubkey').checked,
      });
      const result = await createExamPackage(
        {
          problemText: this.textarea('author-problem').value,
          examId: this.input('author-exam-id').value.trim(),
          problemId: this.input('author-problem-id').value.trim(),
          variant: variantRaw.length > 0 ? variantRaw : null,
          languages,
          releaseTime,
          deadline,
          proctorToken: this.input('author-token').value,
        },
        signer
      );
      const filename = `${result.manifest.problemId || 'problem'}.tcexam`;
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
        <button class="author-btn author-btn-primary" id="author-copy-token-btn">
          <i class="fas fa-copy"></i> ${escapeHtml(t('author.copy'))}
        </button>
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
              <label for="author-problem-id">${escapeHtml(t('author.problem.problemId'))}</label>
              <input type="text" id="author-problem-id" class="author-input" placeholder="p1" autocomplete="off" spellcheck="false">
            </div>
            <div class="author-field">
              <label for="author-variant">${escapeHtml(t('author.problem.variant'))}</label>
              <input type="text" id="author-variant" class="author-input" placeholder="${escapeHtml(t('author.problem.variantPlaceholder'))}" autocomplete="off" spellcheck="false">
            </div>
            <div class="author-field">
              <label for="author-languages">${escapeHtml(t('author.problem.languages'))}</label>
              <input type="text" id="author-languages" class="author-input" value="c" placeholder="c, python" autocomplete="off" spellcheck="false">
            </div>
          </div>
          <div class="author-field">
            <label for="author-problem">${escapeHtml(t('author.problem.body'))}</label>
            <textarea id="author-problem" class="author-textarea" rows="10" placeholder="${escapeHtml(t('author.problem.bodyPlaceholder'))}"></textarea>
          </div>
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
