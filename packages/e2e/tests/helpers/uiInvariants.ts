import type { Page } from '@playwright/test';

/**
 * 画面の機械検査 (#728): i18n のキー名の漏れと、レイアウトのはみ出し。どちらも翻訳文言や見た目の画素には
 * 依存せず、DOM の文字列の形と要素の矩形だけを読む。dev サーバ (`/src/...` を配る) の画面専用。
 */

// ---------------------------------------------------------------------------
// i18n: キー名そのものが画面に出る漏れ
// ---------------------------------------------------------------------------

/**
 * 利用者の内容 (コード・ターミナル・問題文・proof の中身) を表示する領域。ここに出る `foo.bar` は翻訳の
 * キーではないので読まない。
 */
const NON_UI_TEXT = [
  '.monaco-editor',
  '.monaco-aria-container',
  '.xterm',
  'pre',
  'code',
  'textarea',
  'input',
  '[contenteditable="true"]',
  '#problem-body',
  '#problem-examples',
  '#code-preview',
].join(',');

/**
 * 表示中の文字列 (見えているテキストと aria-label / title / placeholder / alt) から、翻訳キーの形をした
 * トークンを返す。翻訳が欠けたとき I18nService.t はキーをそのまま返すので、漏れは画面にキーとして出る。
 *
 * キーかどうかは、そのページの翻訳 (dev サーバの `/src/i18n/translations/{ja,en}.ts`) で決める:
 * - 実在するキーと完全に一致する (例: `statusBar.events`)、または
 * - 先頭が最上位の名前空間で、2 段目もその名前空間に実在する (例: 欠けた `export.dialog.newKey`)
 * ファイル名 (`main.c`・`export.zip`) や URL は 2 段目が名前空間に無いので拾わない。2 段目から欠けた
 * キー (`export.newKey`) はこの形では拾えないので、`watchI18nWarnings` が t() の警告で拾う。
 */
export function findTranslationKeyLeaks(page: Page): Promise<string[]> {
  return page.evaluate(async (nonUiSelector) => {
    const trees = await Promise.all(
      ['/src/i18n/translations/ja.ts', '/src/i18n/translations/en.ts'].map(async (path) => {
        const mod = (await import(/* @vite-ignore */ path)) as Record<string, unknown>;
        return Object.values(mod)[0] as Record<string, unknown>;
      })
    );
    const keys = new Set<string>();
    const children = new Map<string, Set<string>>();
    const walk = (node: unknown, prefix: string) => {
      if (node === null || typeof node !== 'object') {
        keys.add(prefix);
        return;
      }
      for (const [k, v] of Object.entries(node)) walk(v, prefix ? `${prefix}.${k}` : k);
    };
    for (const tree of trees) {
      walk(tree, '');
      for (const [ns, sub] of Object.entries(tree)) {
        if (sub && typeof sub === 'object') {
          const set = children.get(ns) ?? new Set<string>();
          for (const k of Object.keys(sub)) set.add(k);
          children.set(ns, set);
        }
      }
    }
    const looksLikeKey = (token: string) => {
      if (keys.has(token)) return true;
      const [ns, second] = token.split('.');
      return !!second && (children.get(ns!)?.has(second) ?? false);
    };

    const shown = (el: Element) =>
      !el.closest(nonUiSelector) && el.checkVisibility({ visibilityProperty: true, opacityProperty: false });
    const texts: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const parent = n.parentElement;
      if (parent && n.textContent?.trim() && shown(parent)) texts.push(n.textContent);
    }
    for (const el of document.body.querySelectorAll('[aria-label],[title],[placeholder],[alt]')) {
      if (!shown(el)) continue;
      for (const attr of ['aria-label', 'title', 'placeholder', 'alt']) {
        const v = el.getAttribute(attr);
        if (v) texts.push(v);
      }
    }
    const leaks = new Set<string>();
    for (const text of texts) {
      for (const token of text.match(/[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+/g) ?? []) {
        if (looksLikeKey(token)) leaks.add(token);
      }
    }
    return [...leaks].sort();
  }, NON_UI_TEXT);
}

/**
 * 翻訳が引けなかったときの I18nService.t の警告 (`[i18n] Missing translation: <key>` /
 * `[i18n] Translation is not a string: <key>`) を集める。ページを開く前に呼ぶ。
 */
export function watchI18nWarnings(page: Page): () => string[] {
  const seen: string[] = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (/^\[i18n\] (Missing translation|Translation is not a string)/.test(text)) seen.push(text);
  });
  return () => [...seen];
}

// ---------------------------------------------------------------------------
// レイアウト: 意図しない横スクロールと、ダイアログの画面外へのはみ出し
// ---------------------------------------------------------------------------

export interface LayoutReport {
  /** 文書全体が横にスクロールできる (`documentElement.scrollWidth > clientWidth`)。 */
  pageScrollsX: boolean;
  /**
   * 画面の左右からはみ出した要素のうち、はみ出しを受け止める箱 (overflow-x が visible でなく、自分は画面に
   * 収まっている祖先) を持たないもの。body / html の overflow: hidden で切られて見えなくなっている部分。
   * コード欄・タブ列・ターミナルなど内部でスクロールする (切る) 箱の中身はここに入らない。
   */
  clippedByViewport: string[];
  /** 画面 (viewport) に収まっていないダイアログ (`[role=dialog|alertdialog]` と `[data-dialog]` とその直下)。 */
  dialogsOutsideViewport: string[];
}

export function measureLayout(page: Page): Promise<LayoutReport> {
  return page.evaluate(() => {
    const de = document.documentElement;
    const vw = de.clientWidth;
    const vh = de.clientHeight;
    const EPS = 1;
    const describe = (el: Element) => {
      const r = el.getBoundingClientRect();
      const id = el.id ? `#${el.id}` : '';
      const cls =
        typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
      const dialog = (el as HTMLElement).dataset?.dialog ? `[data-dialog=${(el as HTMLElement).dataset.dialog}]` : '';
      return `${el.tagName.toLowerCase()}${id}${cls}${dialog} [${Math.round(r.left)},${Math.round(r.top)} - ${Math.round(r.right)},${Math.round(r.bottom)}]`;
    };
    const rendered = (el: Element) => {
      const r = el.getBoundingClientRect();
      // 1px 以下は読み上げ専用に画面外へ置く手法 (visually hidden。Monaco の aria コンテナなど)。
      return r.width > 1 && r.height > 1 && el.checkVisibility({ visibilityProperty: true, opacityProperty: false });
    };
    const fitsX = (r: DOMRect) => r.left >= -EPS && r.right <= vw + EPS;

    const clipped: Element[] = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (!rendered(el) || fitsX(el.getBoundingClientRect())) continue;
      let contained = false;
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        if (getComputedStyle(a).overflowX !== 'visible' && fitsX(a.getBoundingClientRect())) {
          contained = true;
          break;
        }
      }
      if (!contained) clipped.push(el);
    }
    // はみ出した要素の子孫も同じ理由ではみ出すので、いちばん外側だけを報告する。
    const outermost = clipped.filter((el) => !clipped.some((o) => o !== el && o.contains(el)));

    const dialogs = new Set<Element>();
    for (const el of document.querySelectorAll('[role="dialog"],[role="alertdialog"],[data-dialog]')) {
      dialogs.add(el);
      if (el.hasAttribute('data-dialog')) for (const child of el.children) dialogs.add(child);
    }
    const outside = [...dialogs].filter((el) => {
      if (!rendered(el)) return false;
      const r = el.getBoundingClientRect();
      return !(fitsX(r) && r.top >= -EPS && r.bottom <= vh + EPS);
    });

    return {
      pageScrollsX: de.scrollWidth > vw + EPS,
      clippedByViewport: outermost.map(describe),
      dialogsOutsideViewport: outside.map(describe),
    };
  });
}
