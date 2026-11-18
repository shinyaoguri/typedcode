/**
 * 作問画面の「ファイルの種類ごとの表示」の登録 (#797)。
 *
 * エディタ群は開いている文書を、その種類が持つ表示のどれかで見せる。種類ごとに「表示の一覧」と「既定の表示」を
 * ここに登録し、`EditorArea` はそれを引いて描くだけにする。
 *
 * - `edit` は Monaco のテキスト編集 (`mount` を持たない表示はすべて Monaco)。それ以外の表示は群の表示領域
 *   (`.author-preview`) に `mount` で描き、文書・索引が変わるたびに `update` を呼ぶ
 * - 状態契約: 群の `data-view` は表示の `name`、群のツールの切り替えボタンは `data-action="view-<name>"`
 *   (表示が 2 つ以上ある種類だけに出す)
 * - 今の種類: 試験定義 (`*.exam.yaml`) = `form` (既定)・`edit` (YAML のテキスト)・`preview` (学生プレビュー)、
 *   Markdown = `edit` (既定)・`preview`、それ以外 = `edit` だけ
 *
 * **種類を足すとき** (例: ケースファイルの表を #798 で足す): 表示の部品 (`ViewDefinition` の `mount`) を作り、
 * `DOCUMENT_KINDS` に 1 行足す。先に並んだ種類が勝つので、狭い一致 (接尾辞) を広い一致 (拡張子) より前に置く。
 */

import { t } from '../../i18n/index.js';
import { renderMarkdown } from '../../utils/markdown.js';
import type { AuthorWorkspace } from '../workspace/authorWorkspace.js';
import { mountExamForm } from './ExamFormView.js';
import { mountExamPreview } from './ExamPreviewView.js';
import { isExamDefinitionPath, isMarkdownPath } from './fileKinds.js';

/** 表示を描く場所と、描くのに使えるもの */
export interface ViewContext {
  /** 表示する文書のパス (一覧の綴り) */
  readonly path: string;
  /** 描く場所 (群の表示領域。表示が変わると中身ごと作り直す) */
  readonly host: HTMLElement;
  readonly workspace: AuthorWorkspace;
  /** この群の表示を切り替える (例: 読めない試験定義をテキストで開く) */
  setView(view: string): void;
}

/** 描いた表示。`update` は文書・索引が変わるたびに呼ぶ (重い表示は自分で間引く) */
export interface ViewInstance {
  update(): void;
  dispose(): void;
}

export interface ViewDefinition {
  /** `data-view` の値と、切り替えボタンの `data-action="view-<name>"` */
  readonly name: string;
  label(): string;
  /** 表示領域に足す class (Markdown の描画の見た目など) */
  readonly className?: string;
  /** Monaco 以外の表示を描く。無ければ Monaco (テキスト編集) */
  mount?(context: ViewContext): ViewInstance;
}

export interface DocumentKind {
  readonly id: string;
  matches(path: string): boolean;
  /** 切り替えボタンの並び順 */
  readonly views: readonly ViewDefinition[];
  /** 群で表示を選んでいないときの表示 (`views` のどれかの `name`) */
  readonly defaultView: string;
}

const EDIT: ViewDefinition = { name: 'edit', label: () => t('author.views.edit') };

const MARKDOWN_PREVIEW: ViewDefinition = {
  name: 'preview',
  label: () => t('author.views.preview'),
  className: 'markdown-rendered',
  mount(context) {
    const render = (): void => {
      context.host.innerHTML = renderMarkdown(context.workspace.document(context.path)?.text ?? '');
    };
    render();
    return { update: render, dispose: () => undefined };
  },
};

export const DOCUMENT_KINDS: readonly DocumentKind[] = [
  {
    id: 'exam',
    matches: isExamDefinitionPath,
    views: [
      { name: 'form', label: () => t('author.views.form'), mount: mountExamForm },
      { name: 'edit', label: () => t('author.views.text') },
      { name: 'preview', label: () => t('author.views.studentPreview'), mount: mountExamPreview },
    ],
    defaultView: 'form',
  },
  { id: 'markdown', matches: isMarkdownPath, views: [EDIT, MARKDOWN_PREVIEW], defaultView: 'edit' },
];

const PLAIN: DocumentKind = { id: 'plain', matches: () => true, views: [EDIT], defaultView: 'edit' };

/** パスの種類 (どれにも当たらなければテキスト編集だけ) */
export function documentKindFor(path: string): DocumentKind {
  return DOCUMENT_KINDS.find((kind) => kind.matches(path)) ?? PLAIN;
}

/** 群で選んだ表示 (無い名前なら既定) の定義 */
export function resolveView(kind: DocumentKind, chosen: string | undefined): ViewDefinition {
  return kind.views.find((view) => view.name === chosen) ?? kind.views.find((v) => v.name === kind.defaultView)!;
}
