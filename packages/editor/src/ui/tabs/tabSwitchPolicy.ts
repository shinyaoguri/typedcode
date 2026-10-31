/**
 * タブ切り替えを tabSwitches に記録するかの判定 (#284)。
 *
 * 復元中の `switchTab` は、復元済みの `tabSwitches` に履歴が入っているうえで「最初のタブへ
 * 合わせる」ために呼ばれる。ここで `fromTabId: null` の合成エントリを足すと、リロードの
 * たびに履歴へ蓄積してしまうので、復元中は記録しない。同一タブへの切り替えも切り替えではない。
 */
export function shouldRecordTabSwitch(previousTabId: string | null, nextTabId: string, isRestoring: boolean): boolean {
  return previousTabId !== nextTabId && !isRestoring;
}
