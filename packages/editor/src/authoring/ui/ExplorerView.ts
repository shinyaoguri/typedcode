/**
 * 作問画面のエクスプローラー (#796)。教材フォルダの索引を「問題」「試験」の節に並べる。
 *
 * - 問題: 問題定義を `title` (無ければ `id`) で出し、その下に本文・初期コード・ヒント・解答例・ケースを並べる。
 *   参照先の無いものは欠損の印 (`data-missing="true"`)。読めない定義は誤りの印 (`data-role="invalid"`) つきで出し、
 *   テキストとして開ける
 * - 試験: `*.exam.yaml` (開くとフォーム。#797)。節の見出しの「新しい試験」(`data-action="new-exam"`) で作る
 * - 状態契約: 項目は `data-explorer-path` (根からの相対パス) と `data-role` (`problem` / `statement` / `starter` /
 *   `hint` / `solution` / `cases` / `exam` / `invalid`)。問題ごとの操作は `data-action` (`add-part` / `assign-part`) と
 *   `data-problem-path`。上の操作は `data-action` (`new-problem` / `refresh` / `open-other`)
 *
 * 項目はどれも button なので Tab と Enter / Space で操作できる。
 */

import { escapeHtml } from '@typedcode/shared';
import { t } from '../../i18n/index.js';
import type { IndexedProblem, ProblemPart, WorkspaceIndex } from '../workspace/authorWorkspace.js';
import { workspaceBasename } from '../workspace/paths.js';
import { roleLabel } from './messages.js';

export interface ExplorerHandlers {
  onOpenFile(path: string): void;
  onNewProblem(): void;
  onNewExam(): void;
  onRefresh(): void;
  onOpenOther(): void;
  onAddPart(problemPath: string): void;
  onAssignPart(problemPath: string): void;
}

const ROLE_ICONS: Record<string, string> = {
  problem: 'fa-clipboard-list',
  statement: 'fa-file-lines',
  starter: 'fa-file-code',
  hint: 'fa-lightbulb',
  solution: 'fa-circle-check',
  cases: 'fa-list-check',
  exam: 'fa-file-signature',
  invalid: 'fa-triangle-exclamation',
};

function iconButton(action: string, label: string, icon: string, extra = ''): string {
  const text = escapeHtml(label);
  return `<button type="button" class="author-icon-btn" data-action="${action}" title="${text}" aria-label="${text}"${extra}><i class="fas ${icon}" aria-hidden="true"></i></button>`;
}

export class ExplorerView {
  readonly element: HTMLElement;
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;

  constructor(private readonly handlers: ExplorerHandlers) {
    const el = document.createElement('aside');
    el.className = 'author-explorer';
    el.id = 'author-explorer';
    el.setAttribute('aria-label', t('author.explorer.heading'));
    el.innerHTML = `
      <div class="author-explorer-head">
        <span class="author-explorer-title" id="author-explorer-folder"></span>
        <span class="author-explorer-tools">
          ${iconButton('new-problem', t('author.explorer.newProblem'), 'fa-file-circle-plus')}
          ${iconButton('refresh', t('author.explorer.refresh'), 'fa-rotate')}
          ${iconButton('open-other', t('author.explorer.openOther'), 'fa-folder-open')}
        </span>
      </div>
      <div class="author-explorer-body"></div>`;
    this.element = el;
    this.title = el.querySelector<HTMLElement>('#author-explorer-folder')!;
    this.body = el.querySelector<HTMLElement>('.author-explorer-body')!;
    el.querySelector('[data-action="new-problem"]')!.addEventListener('click', () => handlers.onNewProblem());
    el.querySelector('[data-action="refresh"]')!.addEventListener('click', () => handlers.onRefresh());
    el.querySelector('[data-action="open-other"]')!.addEventListener('click', () => handlers.onOpenOther());
    // 項目と問題ごとの操作は描き直しのたびに作り直すので、委譲で受ける
    this.body.addEventListener('click', (e) => this.onBodyClick(e));
  }

  private onBodyClick(e: Event): void {
    const target = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!target || !this.body.contains(target)) return;
    const problemPath = target.dataset.problemPath;
    if (target.dataset.action === 'new-exam') {
      this.handlers.onNewExam();
      return;
    }
    if (target.dataset.action === 'add-part' && problemPath) {
      this.handlers.onAddPart(problemPath);
      return;
    }
    if (target.dataset.action === 'assign-part' && problemPath) {
      this.handlers.onAssignPart(problemPath);
      return;
    }
    const path = target.dataset.explorerPath;
    if (path && target.getAttribute('aria-disabled') !== 'true') this.handlers.onOpenFile(path);
  }

  render(index: WorkspaceIndex, folderName: string, activePath: string | null): void {
    this.title.textContent = folderName;
    this.title.title = folderName;
    const problems = index.problems.map((problem) => this.problemItem(problem, activePath)).join('');
    const exams = index.exams
      .map((path) => `<li>${this.item(path, 'exam', workspaceBasename(path), path, activePath)}</li>`)
      .join('');
    this.body.innerHTML = `
      <section class="author-explorer-section" aria-labelledby="author-explorer-problems">
        <h2 class="author-explorer-section-head" id="author-explorer-problems">${escapeHtml(t('author.explorer.problems'))}</h2>
        ${problems ? `<ul class="author-explorer-list">${problems}</ul>` : `<p class="author-explorer-empty">${escapeHtml(t('author.explorer.noProblems'))}</p>`}
      </section>
      <section class="author-explorer-section" aria-labelledby="author-explorer-exams">
        <div class="author-explorer-section-row">
          <h2 class="author-explorer-section-head" id="author-explorer-exams">${escapeHtml(t('author.explorer.exams'))}</h2>
          <span class="author-explorer-actions">${iconButton('new-exam', t('author.explorer.newExam'), 'fa-file-circle-plus')}</span>
        </div>
        ${exams ? `<ul class="author-explorer-list">${exams}</ul>` : `<p class="author-explorer-empty">${escapeHtml(t('author.explorer.noExams'))}</p>`}
      </section>`;
  }

  private problemItem(problem: IndexedProblem, activePath: string | null): string {
    if (problem.status !== 'ok') {
      const label = `${workspaceBasename(problem.path)} — ${t('author.explorer.invalid')}`;
      return `<li class="author-explorer-problem">${this.item(problem.path, 'invalid', label, problem.path, activePath)}</li>`;
    }
    const { definition } = problem;
    const name = definition.title ?? definition.id;
    const actions = [
      iconButton(
        'add-part',
        `${t('author.explorer.addPart')}: ${name}`,
        'fa-plus',
        ` data-problem-path="${escapeHtml(problem.path)}"`
      ),
      iconButton(
        'assign-part',
        `${t('author.explorer.assignPart')}: ${name}`,
        'fa-link',
        ` data-problem-path="${escapeHtml(problem.path)}"`
      ),
    ].join('');
    const parts = problem.parts.map((part) => `<li>${this.partItem(part, activePath)}</li>`).join('');
    return `
      <li class="author-explorer-problem">
        <div class="author-explorer-row">
          ${this.item(problem.path, 'problem', name, `${t('author.explorer.definition')}: ${problem.path}`, activePath)}
          <span class="author-explorer-actions">${actions}</span>
        </div>
        <ul class="author-explorer-parts">${parts}</ul>
      </li>`;
  }

  private partItem(part: ProblemPart, activePath: string | null): string {
    const path = part.path ?? part.reference;
    const label = `${roleLabel(part.role)}: ${workspaceBasename(path)}`;
    const title = part.exists ? path : `${path} — ${t('author.explorer.missing')}`;
    return this.item(path, part.role, label, title, activePath, !part.exists);
  }

  private item(
    path: string,
    role: string,
    label: string,
    title: string,
    activePath: string | null,
    missing = false
  ): string {
    const active = path === activePath;
    const attrs = [
      `type="button"`,
      `class="author-explorer-item${active ? ' active' : ''}${missing ? ' missing' : ''}"`,
      `data-explorer-path="${escapeHtml(path)}"`,
      `data-role="${role}"`,
      `title="${escapeHtml(title)}"`,
      missing ? 'data-missing="true" aria-disabled="true"' : '',
      active ? 'aria-current="true"' : '',
    ].join(' ');
    const icon = ROLE_ICONS[role] ?? 'fa-file';
    const mark = missing
      ? ` <i class="fas fa-circle-exclamation author-explorer-missing" aria-hidden="true"></i><span class="visually-hidden">${escapeHtml(t('author.explorer.missing'))}</span>`
      : '';
    return `<button ${attrs}><i class="fas ${icon}" aria-hidden="true"></i><span class="author-explorer-label">${escapeHtml(label)}</span>${mark}</button>`;
  }
}
