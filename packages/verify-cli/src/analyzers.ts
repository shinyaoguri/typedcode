/**
 * 外部アナライザの読込 (ADR-0009 / 分析プラットフォーム方針)。
 *
 * TypedCode は「判定器」ではなく「**多様な分析手法を載せられる基盤**」を目指す。
 * 採点者・研究者が自前の `Analyzer` (ADR-0009 の契約) を**フォークせずに** proof / コーパスへ
 * 走らせられるよう、CLI は外部 ES モジュールを動的 import して `runAnalysis` に渡す。
 *
 * 境界 (verify-cli CLAUDE.md #1): **分析ロジックは CLI に書かない**。ここがやるのは I/O
 * (モジュール読込 + 契約バリデーション) だけで、分析の中身は外部モジュール側にある。
 *
 * 受け付けるモジュール形:
 *   export default analyzer            // 単一
 *   export default [a1, a2]            // 配列
 *   export const analyzer = {...}      // named 単一
 *   export const analyzers = [...]     // named 配列
 * これらは併存してよく、見つかった Analyzer をすべて集める。
 */

import { pathToFileURL } from 'node:url';
import { resolve, isAbsolute } from 'node:path';
import type { Analyzer } from '@typedcode/shared';

function isAnalyzer(x: unknown): x is Analyzer {
  if (!x || typeof x !== 'object') return false;
  const a = x as Record<string, unknown>;
  return typeof a['id'] === 'string' && typeof a['version'] === 'string' && typeof a['analyze'] === 'function';
}

/** 1 モジュールの export 群から Analyzer を抽出する。0 件なら明示エラー。 */
function collectFromModule(mod: Record<string, unknown>, label: string): Analyzer[] {
  const found: Analyzer[] = [];
  const candidates: unknown[] = [];
  for (const key of ['default', 'analyzer', 'analyzers']) {
    const v = mod[key];
    if (Array.isArray(v)) candidates.push(...v);
    else if (v !== undefined) candidates.push(v);
  }
  for (const c of candidates) {
    if (isAnalyzer(c)) found.push(c);
  }
  if (found.length === 0) {
    throw new Error(
      `External analyzer module has no valid Analyzer export: ${label}. ` +
        `Export a default / named "analyzer" / "analyzers" that has { id: string, version: string, analyze(input) }.`
    );
  }
  return found;
}

/**
 * `--analyzer <path>` で指定された外部モジュール群を読み込み、Analyzer の配列を返す。
 * パスは cwd 基準で解決し file URL として動的 import する。
 *
 * @throws 読込失敗 / 契約不適合 のとき (呼び出し側で stderr 表示 + exit 1)。
 */
export async function loadExternalAnalyzers(paths: readonly string[]): Promise<Analyzer[]> {
  const all: Analyzer[] = [];
  const seenIds = new Set<string>();
  for (const p of paths) {
    const abs = isAbsolute(p) ? p : resolve(process.cwd(), p);
    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`Failed to load external analyzer "${p}": ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const analyzer of collectFromModule(mod, p)) {
      if (seenIds.has(analyzer.id)) {
        throw new Error(`Duplicate analyzer id "${analyzer.id}" from ${p} (ids must be unique across analyzers).`);
      }
      seenIds.add(analyzer.id);
      all.push(analyzer);
    }
  }
  return all;
}
