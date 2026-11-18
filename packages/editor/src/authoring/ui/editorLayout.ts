/**
 * 作問画面のエディタ群の配置 (#796)。DOM・Monaco に触れない。
 *
 * - エディタ群は最大 2 つ (左右)。群ごとにタブ (開いている文書のパス) とアクティブなタブを持つ
 * - 同じ文書を両方の群で開ける (Monaco のモデルは文書ごとに 1 つで、群は表示だけを持つ)
 * - 文書の表示 (Markdown の編集 / プレビュー、試験定義のフォーム / テキスト / 学生プレビューなど) は群ごとに切り替える
 *   (群とパスの組で覚える)。表示の名前と種類ごとの既定は `documentViews.ts` が持ち、ここは名前を覚えるだけ
 * - 群のタブが空になったら群を畳む (2 つ目なら消す。1 つ目が空になったら 2 つ目を 1 つ目に繰り上げる)
 */

export type GroupIndex = 0 | 1;
/** 表示の名前 (`documentViews.ts` の `ViewName`)。覚えるだけなので文字列で持つ */
export type DocumentView = string;

export const MAX_GROUPS = 2;

export interface EditorGroupState {
  readonly tabs: readonly string[];
  readonly active: string | null;
}

interface GroupRecord {
  tabs: string[];
  active: string | null;
  views: Map<string, DocumentView>;
}

function emptyGroup(): GroupRecord {
  return { tabs: [], active: null, views: new Map() };
}

export class EditorLayout {
  private groups: GroupRecord[] = [emptyGroup()];
  private activeGroupIndex: GroupIndex = 0;

  get groupCount(): number {
    return this.groups.length;
  }

  get activeGroup(): GroupIndex {
    return this.activeGroupIndex;
  }

  group(index: GroupIndex): EditorGroupState | undefined {
    const group = this.groups[index];
    return group ? { tabs: [...group.tabs], active: group.active } : undefined;
  }

  /** アクティブな群のアクティブな文書 */
  get activePath(): string | null {
    return this.groups[this.activeGroupIndex]?.active ?? null;
  }

  /** 文書を群で開いてアクティブにする (既定はアクティブな群)。無い群を指したら最後の群 */
  open(path: string, index: GroupIndex = this.activeGroupIndex): void {
    const target = Math.min(index, this.groups.length - 1) as GroupIndex;
    const group = this.groups[target]!;
    if (!group.tabs.includes(path)) {
      const at = group.active ? group.tabs.indexOf(group.active) + 1 : group.tabs.length;
      group.tabs.splice(at, 0, path);
    }
    group.active = path;
    this.activeGroupIndex = target;
  }

  /** 群をアクティブにする */
  focus(index: GroupIndex): void {
    if (index < this.groups.length) this.activeGroupIndex = index;
  }

  /**
   * 2 つ目の群を出し、アクティブな文書をそこでも開く。既に 2 つあるか、開いている文書が無ければ false
   */
  split(): boolean {
    if (this.groups.length >= MAX_GROUPS) return false;
    const path = this.activePath;
    if (path === null) return false;
    const group = emptyGroup();
    group.tabs.push(path);
    group.active = path;
    const view = this.groups[this.activeGroupIndex]?.views.get(path);
    if (view) group.views.set(path, view);
    this.groups.push(group);
    this.activeGroupIndex = 1;
    return true;
  }

  /** 群を閉じる (群が 1 つなら何もしない) */
  closeGroup(index: GroupIndex): void {
    if (this.groups.length <= 1 || index >= this.groups.length) return;
    this.groups.splice(index, 1);
    this.activeGroupIndex = 0;
  }

  /** 群のタブを閉じる。空になった群は畳む */
  close(path: string, index: GroupIndex): void {
    const group = this.groups[index];
    if (!group) return;
    const at = group.tabs.indexOf(path);
    if (at === -1) return;
    group.tabs.splice(at, 1);
    group.views.delete(path);
    if (group.active === path) group.active = group.tabs[Math.min(at, group.tabs.length - 1)] ?? null;
    if (group.tabs.length === 0 && this.groups.length > 1) {
      this.groups.splice(index, 1);
      this.activeGroupIndex = 0;
    } else if (group.tabs.length > 0) {
      this.activeGroupIndex = index;
    }
  }

  /** すべての群から文書を外す */
  remove(path: string): void {
    for (let i = this.groups.length - 1; i >= 0; i--) this.close(path, i as GroupIndex);
  }

  /** どれかの群で開いているか */
  isOpen(path: string): boolean {
    return this.groups.some((group) => group.tabs.includes(path));
  }

  /** どれかの群で開いている文書 (重複なし) */
  openPaths(): string[] {
    return [...new Set(this.groups.flatMap((group) => group.tabs))];
  }

  /** 群で選んだ表示。選んでいなければ `fallback` (種類ごとの既定) */
  view(path: string, index: GroupIndex, fallback: DocumentView = 'edit'): DocumentView {
    return this.groups[index]?.views.get(path) ?? fallback;
  }

  setView(path: string, index: GroupIndex, view: DocumentView): void {
    const group = this.groups[index];
    if (!group?.tabs.includes(path)) return;
    group.views.set(path, view);
  }

  /** すべて閉じる (別のフォルダを開くとき) */
  reset(): void {
    this.groups = [emptyGroup()];
    this.activeGroupIndex = 0;
  }
}
