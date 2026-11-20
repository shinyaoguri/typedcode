/**
 * 作問画面の下のパネルの「検証」(#799 / ADR-0051 Decision 6)。解答例 × テストケースの結果表と、選んだセルの詳細
 * (期待と実際の差分・stderr・終了コード) を出す。状態は `verification/verificationTable.ts` が持ち、ここは描くだけ。
 *
 * - 状態契約: `#author-verify-panel` に `data-verify-state` (`idle` / `running` / `done` / `aborted` / `blocked`)、
 *   問題を選んだ後は `data-problem-path`、`blocked` のときだけ `data-verify-reason` (理由の種類)。開始 / 中止は
 *   `data-action="verify-start"` / `"verify-abort"`。セルは `button[data-verify-cell]` で `data-solution-index`・
 *   `data-case-index`・`data-verdict` (`pending` / `running` / `match` / `mismatch` / `runtime-error` / `timeout` /
 *   `unsupported`)、選んだセルは `aria-pressed="true"`。詳細は `#author-verify-detail` (選んだセルの
 *   `data-solution-index` / `data-case-index`)、差分の行は `[data-diff-line]` に `data-diff` (`same` / `different`)、
 *   stderr は `[data-detail="stderr"]`、終了コードは `[data-detail="exit-code"]`
 * - 教材や実行結果の文字列は textContent で入れる (HTML にしない)。差分は等幅で、行末の空白を「·」(タブは「→」)、
 *   行なし・末尾の改行なしを専用の表示で出す
 * - セルの状態は語と印で出す (色だけに頼らない)。セルは button なので Tab と Enter / Space で選べる
 */

import { escapeHtml } from '@typedcode/shared';
import { t } from '../../i18n/index.js';
import { diffOutputLines, type OutputLine } from '../verification/outputDiff.js';
import type { CellStatus, TableCell, VerificationTable } from '../verification/verificationTable.js';

export interface VerificationPanelHandlers {
  onStart(): void;
  onAbort(): void;
}

export type VerificationPanelState = 'idle' | 'running' | 'done' | 'aborted' | 'blocked';

const STATUS_ICONS: Record<CellStatus, string> = {
  pending: 'fa-minus',
  running: 'fa-spinner fa-spin',
  match: 'fa-check',
  mismatch: 'fa-xmark',
  'runtime-error': 'fa-bug',
  timeout: 'fa-hourglass-end',
  unsupported: 'fa-ban',
};

export function verdictLabel(status: CellStatus): string {
  switch (status) {
    case 'runtime-error':
      return t('author.verify.verdicts.runtimeError');
    default:
      return t(`author.verify.verdicts.${status}`);
  }
}

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

/** 行の文字列を、行末の空白が見える形で描く */
function renderLineText(cell: HTMLElement, line: OutputLine | null, isLast: boolean): void {
  if (line === null) {
    cell.append(el('span', 'author-verify-noline', t('author.verify.detail.noLine')));
    return;
  }
  const match = /[ \t]+$/.exec(line.text);
  const body = match ? line.text.slice(0, match.index) : line.text;
  cell.append(document.createTextNode(body));
  if (match) {
    const ws = el('span', 'author-verify-ws', match[0].replace(/ /g, '·').replace(/\t/g, '→'));
    ws.setAttribute('aria-hidden', 'true');
    cell.append(ws);
  }
  if (isLast && !line.newline) cell.append(el('span', 'author-verify-noeol', t('author.verify.detail.noNewline')));
}

export class VerificationPanel {
  readonly element: HTMLElement;
  private readonly title: HTMLElement;
  private readonly startBtn: HTMLButtonElement;
  private readonly abortBtn: HTMLButtonElement;
  private readonly message: HTMLElement;
  private readonly tableWrap: HTMLElement;
  private readonly detail: HTMLElement;
  private table: VerificationTable | null = null;
  private selected: { solutionIndex: number; caseIndex: number } | null = null;

  constructor(handlers: VerificationPanelHandlers) {
    const root = el('section', 'author-verify-panel');
    root.id = 'author-verify-panel';
    root.setAttribute('aria-labelledby', 'author-verify-title');
    root.innerHTML = `
      <div class="author-verify-head">
        <h2 class="author-verify-title" id="author-verify-title"></h2>
        <button type="button" class="author-pane-btn" data-action="verify-start"><i class="fas fa-play" aria-hidden="true"></i> ${escapeHtml(t('author.verify.start'))}</button>
        <button type="button" class="author-pane-btn" data-action="verify-abort"><i class="fas fa-stop" aria-hidden="true"></i> ${escapeHtml(t('author.verify.abort'))}</button>
        <span class="author-verify-message" id="author-verify-message" role="status"></span>
      </div>
      <div class="author-verify-body">
        <div class="author-verify-table-wrap"></div>
        <div class="author-verify-detail" id="author-verify-detail"></div>
      </div>`;
    this.element = root;
    this.title = root.querySelector<HTMLElement>('#author-verify-title')!;
    this.startBtn = root.querySelector<HTMLButtonElement>('[data-action="verify-start"]')!;
    this.abortBtn = root.querySelector<HTMLButtonElement>('[data-action="verify-abort"]')!;
    this.message = root.querySelector<HTMLElement>('#author-verify-message')!;
    this.tableWrap = root.querySelector<HTMLElement>('.author-verify-table-wrap')!;
    this.detail = root.querySelector<HTMLElement>('#author-verify-detail')!;
    this.startBtn.addEventListener('click', () => handlers.onStart());
    this.abortBtn.addEventListener('click', () => handlers.onAbort());
    this.tableWrap.addEventListener('click', (e) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-verify-cell]');
      if (!cell) return;
      this.select(Number(cell.dataset.solutionIndex), Number(cell.dataset.caseIndex));
    });
    this.showEmpty();
  }

  get state(): VerificationPanelState {
    return (this.element.dataset.verifyState as VerificationPanelState | undefined) ?? 'idle';
  }

  private setHeader(state: VerificationPanelState, problemPath: string | null, problemName: string | null): void {
    this.element.dataset.verifyState = state;
    if (problemPath === null) delete this.element.dataset.problemPath;
    else this.element.dataset.problemPath = problemPath;
    if (state !== 'blocked') delete this.element.dataset.verifyReason;
    this.title.textContent =
      problemName === null ? t('author.verify.tab') : t('author.verify.heading', { name: problemName });
    this.title.title = problemPath ?? '';
    this.startBtn.disabled = problemPath === null || state === 'running';
    this.abortBtn.disabled = state !== 'running';
  }

  /** 問題を選ぶ前 */
  showEmpty(): void {
    this.table = null;
    this.selected = null;
    this.setHeader('idle', null, null);
    this.message.textContent = t('author.verify.empty');
    this.message.classList.remove('author-notice-error');
    this.tableWrap.replaceChildren();
    this.detail.replaceChildren();
    this.detail.hidden = true;
  }

  /** 実行できない (理由を出し、表は消す) */
  showBlocked(problemPath: string, problemName: string, reason: string, message: string): void {
    this.table = null;
    this.selected = null;
    this.setHeader('blocked', problemPath, problemName);
    this.element.dataset.verifyReason = reason;
    this.message.textContent = message;
    this.message.classList.add('author-notice-error');
    this.tableWrap.replaceChildren();
    this.detail.replaceChildren();
    this.detail.hidden = true;
  }

  /** 表を描く (実行中は変わるたびに呼ばれる) */
  showTable(problemName: string, table: VerificationTable): void {
    if (this.table && this.table.problemPath !== table.problemPath) this.selected = null;
    this.table = table;
    this.setHeader(table.state, table.problemPath, problemName);
    this.message.classList.remove('author-notice-error');
    this.message.textContent =
      table.state === 'running'
        ? t('author.verify.runningHint')
        : table.state === 'done'
          ? t('author.verify.stateDone')
          : table.state === 'aborted'
            ? t('author.verify.stateAborted')
            : '';
    this.renderTable(table);
    this.renderDetail();
  }

  private renderTable(table: VerificationTable): void {
    // 描き直してもキーボードの位置を失わないよう、フォーカスのあったセルを覚えておく
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusedKey =
      focused && this.tableWrap.contains(focused) && focused.dataset.verifyCell !== undefined
        ? `${focused.dataset.solutionIndex}:${focused.dataset.caseIndex}`
        : null;

    const grid = el('table', 'author-verify-table');
    const head = el('thead');
    const headRow = el('tr');
    const corner = el('th', 'author-verify-corner', t('author.verify.solutionHeader'));
    corner.scope = 'col';
    headRow.append(corner);
    for (const testCase of table.cases) {
      const th = el('th', undefined, testCase.name);
      th.scope = 'col';
      headRow.append(th);
    }
    head.append(headRow);
    const body = el('tbody');
    table.solutions.forEach((solution, solutionIndex) => {
      const row = el('tr');
      const th = el('th', undefined, solution.filename);
      th.scope = 'row';
      th.title = solution.name;
      row.append(th);
      for (const cell of table.cells[solutionIndex] ?? []) row.append(this.cellElement(table, cell));
      body.append(row);
    });
    grid.append(head, body);
    this.tableWrap.replaceChildren(grid);
    if (focusedKey) {
      const [s, c] = focusedKey.split(':');
      this.tableWrap
        .querySelector<HTMLElement>(`[data-verify-cell][data-solution-index="${s}"][data-case-index="${c}"]`)
        ?.focus();
    }
  }

  private cellElement(table: VerificationTable, cell: TableCell): HTMLElement {
    const td = el('td');
    const button = el('button', `author-verify-cell author-verify-${cell.status}`);
    button.type = 'button';
    button.dataset.verifyCell = '';
    button.dataset.solutionIndex = String(cell.solutionIndex);
    button.dataset.caseIndex = String(cell.caseIndex);
    button.dataset.verdict = cell.status;
    const isSelected =
      this.selected?.solutionIndex === cell.solutionIndex && this.selected.caseIndex === cell.caseIndex;
    button.setAttribute('aria-pressed', String(isSelected));
    const label = verdictLabel(cell.status);
    button.title = t('author.verify.detail.cellTitle', {
      solution: table.solutions[cell.solutionIndex]?.filename ?? '',
      case: table.cases[cell.caseIndex]?.name ?? '',
      verdict: label,
    });
    const icon = el('i', `fas ${STATUS_ICONS[cell.status]}`);
    icon.setAttribute('aria-hidden', 'true');
    button.append(icon, el('span', undefined, label));
    td.append(button);
    return td;
  }

  private select(solutionIndex: number, caseIndex: number): void {
    if (!this.table) return;
    this.selected = { solutionIndex, caseIndex };
    for (const button of this.tableWrap.querySelectorAll<HTMLElement>('[data-verify-cell]')) {
      const on =
        Number(button.dataset.solutionIndex) === solutionIndex && Number(button.dataset.caseIndex) === caseIndex;
      button.setAttribute('aria-pressed', String(on));
    }
    this.renderDetail();
  }

  private renderDetail(): void {
    const table = this.table;
    const detail = this.detail;
    detail.replaceChildren();
    detail.hidden = false;
    const selected = this.selected;
    const cell = selected ? table?.cells[selected.solutionIndex]?.[selected.caseIndex] : undefined;
    if (!table || !selected || !cell) {
      delete detail.dataset.solutionIndex;
      delete detail.dataset.caseIndex;
      detail.append(el('p', 'author-verify-hint', t('author.verify.detail.selectHint')));
      return;
    }
    detail.dataset.solutionIndex = String(selected.solutionIndex);
    detail.dataset.caseIndex = String(selected.caseIndex);
    const testCase = table.cases[selected.caseIndex]!;
    const heading = el(
      'h3',
      'author-verify-detail-title',
      t('author.verify.detail.cellTitle', {
        solution: table.solutions[selected.solutionIndex]?.filename ?? '',
        case: testCase.name,
        verdict: verdictLabel(cell.status),
      })
    );
    detail.append(heading);
    const result = cell.result;
    if (!result) {
      detail.append(el('p', 'author-verify-hint', t('author.verify.detail.notRun')));
      return;
    }
    detail.append(
      el(
        'p',
        'author-verify-hint',
        testCase.match === 'exact' ? t('author.verify.detail.modeExact') : t('author.verify.detail.modeTrim')
      )
    );

    // 判定が出たセル (未対応を除く) は期待と実際を並べる。実行時エラー・時間切れでも、出た分の stdout を見せる
    if (cell.status !== 'unsupported') {
      const lines = diffOutputLines(result.expectedStdout, result.actualStdout, testCase.match);
      const diff = el('table', 'author-verify-diff');
      const head = el('tr');
      for (const text of ['#', t('author.verify.detail.expected'), t('author.verify.detail.actual')]) {
        const th = el('th', undefined, text);
        th.scope = 'col';
        head.append(th);
      }
      const thead = el('thead');
      thead.append(head);
      const tbody = el('tbody');
      const expectedCount = lines.filter((line) => line.expected !== null).length;
      const actualCount = lines.filter((line) => line.actual !== null).length;
      for (const line of lines) {
        const row = el('tr', line.same ? 'author-verify-same' : 'author-verify-different');
        row.dataset.diffLine = String(line.index);
        row.dataset.diff = line.same ? 'same' : 'different';
        const num = el('td', 'author-verify-lineno', `${line.same ? ' ' : '≠'} ${line.index + 1}`);
        const expected = el('td', 'author-verify-text');
        expected.dataset.diffSide = 'expected';
        renderLineText(expected, line.expected, line.index === expectedCount - 1);
        const actual = el('td', 'author-verify-text');
        actual.dataset.diffSide = 'actual';
        renderLineText(actual, line.actual, line.index === actualCount - 1);
        row.append(num, expected, actual);
        tbody.append(row);
      }
      diff.append(thead, tbody);
      detail.append(diff);
    }

    const exit = el(
      'p',
      'author-verify-exit',
      result.exitCode === null
        ? t('author.verify.detail.exitNone')
        : t('author.verify.detail.exitCode', { code: String(result.exitCode) })
    );
    exit.dataset.detail = 'exit-code';
    detail.append(exit);
    if (result.stderr !== '') {
      detail.append(el('h4', 'author-verify-subhead', t('author.verify.detail.stderr')));
      const stderr = el('pre', 'author-verify-stderr', result.stderr);
      stderr.dataset.detail = 'stderr';
      detail.append(stderr);
    }
  }
}
