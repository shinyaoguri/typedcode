import { appendFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { KNOWN_A11Y_VIOLATIONS, type KnownA11yViolation } from './a11yBaseline.js';
import type { ScreenId } from './uiTour.js';

/**
 * axe による a11y の退行検査 (#728)。
 *
 * 違反は「rule id + 対象 (axe が返す CSS セレクタ)」で数え、`a11yBaseline.ts` の既知違反 (その画面で
 * 出てよいもの) と突き合わせる。基準に無い違反が 1 つでもあれば落とす。基準にあるのに出なくなった違反
 * (直った) は落とさず、テストの annotation と出力で知らせる (基準から消す合図)。
 * rule を無効にしたり impact で足切りしたりはしない (axe の既定の rule をすべて回す)。
 *
 * axe が通ることは「機械で検出できる違反が基準から増えていない」ことだけを意味し、スクリーンリーダーで
 * 実際に操作できることの確認ではない (#305)。
 */

export interface ObservedA11yViolation {
  rule: string;
  impact: string | null;
  target: string;
}

/** axe の node.target (iframe / shadow DOM の段は入れ子の配列) を 1 本の文字列にする。 */
function targetKey(target: ReadonlyArray<string | readonly string[]>): string {
  return target.map((t) => (Array.isArray(t) ? t.join(' >>> ') : t)).join(' | ');
}

/** いまの画面に axe をかけ、違反を (rule, 対象) の組に展開して返す。 */
export async function scanA11y(page: Page): Promise<ObservedA11yViolation[]> {
  const result = await new AxeBuilder({ page }).analyze();
  return result.violations.flatMap((v) =>
    v.nodes.map((n) => ({ rule: v.id, impact: v.impact ?? null, target: targetKey(n.target) }))
  );
}

export interface A11yDiff {
  /** 基準に無い (新しい) 違反。 */
  unexpected: ObservedA11yViolation[];
  /** この画面の基準にあるのに出なかった違反 (直った可能性)。 */
  resolved: KnownA11yViolation[];
}

/** 観測した違反を、画面 `screen` の既知違反と突き合わせる (純関数)。 */
export function diffA11y(
  screen: ScreenId,
  observed: readonly ObservedA11yViolation[],
  baseline: readonly KnownA11yViolation[] = KNOWN_A11Y_VIOLATIONS
): A11yDiff {
  const known = baseline.filter((k) => k.screens.includes(screen));
  const isKnown = (o: ObservedA11yViolation) => known.some((k) => k.rule === o.rule && k.target === o.target);
  const seen = (k: KnownA11yViolation) => observed.some((o) => o.rule === k.rule && o.target === k.target);
  return { unexpected: observed.filter((o) => !isKnown(o)), resolved: known.filter((k) => !seen(k)) };
}

/** 基準に貼れる形 (a11yBaseline.ts の 1 行) にする。 */
function asBaselineEntry(screen: ScreenId, v: ObservedA11yViolation): string {
  return `{ rule: ${JSON.stringify(v.rule)}, target: ${JSON.stringify(v.target)}, screens: [${JSON.stringify(screen)}], issue: null }, // impact: ${v.impact}`;
}

/**
 * 画面 `screen` に axe をかけ、基準に無い違反があれば (soft に) 落とす。直った違反は annotation に残す。
 * soft にするのは、1 本の流れの中で後ろの画面の結果も一度に見せるため。
 */
export async function expectNoNewA11yViolations(page: Page, screen: ScreenId): Promise<void> {
  const observed = await scanA11y(page);
  // 基準を作り直すとき用: A11Y_DUMP=<ファイル> で、観測した違反をすべて JSON Lines で書き出す (README の手順)。
  const dump = process.env.A11Y_DUMP;
  if (dump) for (const v of observed) appendFileSync(dump, `${JSON.stringify({ screen, ...v })}\n`);
  const { unexpected, resolved } = diffA11y(screen, observed);
  for (const k of resolved) {
    const description = `${screen}: ${k.rule} ${k.target} は出なくなった (a11yBaseline.ts から外せる${k.issue ? ` / #${k.issue}` : ''})`;
    test.info().annotations.push({ type: 'a11y-resolved', description });
    console.log(`[a11y] resolved ${description}`);
  }
  expect
    .soft(
      unexpected.map((v) => asBaselineEntry(screen, v)),
      `${screen}: 基準 (tests/helpers/a11yBaseline.ts) に無い axe の違反。直すか、既知として Issue 番号付きで基準に足す`
    )
    .toEqual([]);
}
