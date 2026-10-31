/**
 * タブ復元順の解決 (#326)。
 *
 * 保存されたタブ行 (storedIds) を 1 件も取りこぼさず、保存済みの並び (tabOrder) を尊重して
 * 復元順を決める純関数。`createSession` は `tabOrder: []` で初期化するため、`tabOrder ?? ids` の
 * 形では空配列に fallback が効かず、tabOrder に載っていないタブが黙って復元されなくなる。
 *
 * - tabOrder のうち storedIds に実在する id を、tabOrder の順で採る (実在しない id は捨てる)
 * - tabOrder に載っていない storedIds を、storedIds の順で末尾に足す
 * - 重複は先勝ちで除く
 */
export function resolveRestoreOrder(tabOrder: readonly string[] | undefined, storedIds: readonly string[]): string[] {
  const stored = new Set(storedIds);
  const result: string[] = [];
  const seen = new Set<string>();

  for (const id of [...(tabOrder ?? []), ...storedIds]) {
    if (!stored.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}
