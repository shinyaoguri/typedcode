#!/usr/bin/env node
/**
 * README の依存表と package.json の突合 (#269) — 各 `packages/<名>/README.md` の依存表を名前で
 * package.json と突き合わせ、ずれがあれば報告して exit 1 する。
 *
 * 背景: dependabot は package.json だけを書き換え README には触れないので、版を README に書き写すと
 * 必ずずれる (#257 / #262 / #269)。表記規則は「README に版を書かず用途だけ書く。版は package.json が正」
 * (`| パッケージ | 用途 |` の表)。人が依存を足し引きしたときしか鳴らないので、dependabot PR は落とさない。
 *
 * 検査 (どちらも名前だけを見る):
 *   (i)  package.json の `dependencies` にあって、表に無い名前
 *   (ii) 表にあって、package.json の `dependencies` / `devDependencies` のどちらにも無い名前
 * 依存表 (先頭セルが「パッケージ」の Markdown 表) の無い README は飛ばす。devDependencies は任意掲載。
 *
 * 比較 (compareDependencies) と表の読み取り (parseDependencyTable) は純関数。ファイル入出力は main に閉じる。
 *
 * 使い方:
 *   node scripts/check-deps.mjs            # リポジトリルートで実行
 *   node scripts/check-deps.mjs <root>     # 別のルート (fixture など) を調べる
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * README から依存表の名前列を取り出す (純関数)。表が無ければ null。
 * 先頭セルが「パッケージ」の表の、データ行の第 1 セル (バッククォートは外す) を返す。
 *
 * @param {string} markdown
 * @returns {string[] | null}
 */
export function parseDependencyTable(markdown) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => cells(line)?.[0] === 'パッケージ');
  if (start === -1) return null;
  const names = [];
  for (const line of lines.slice(start + 1)) {
    const row = cells(line);
    if (!row) break;
    if (row.every((cell) => /^:?-+:?$/.test(cell))) continue; // 区切り行
    names.push(row[0].replace(/`/g, ''));
  }
  return names;
}

/** `| a | b |` を ['a', 'b'] に。表の行でなければ null。 */
function cells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  return trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/**
 * 表の名前と package.json の依存を突き合わせる (純関数)。
 *
 * @param {{ tableNames: string[], dependencies?: Record<string, string>, devDependencies?: Record<string, string> }} input
 * @returns {{ missingFromTable: string[], notInPackageJson: string[] }}
 */
export function compareDependencies({ tableNames, dependencies = {}, devDependencies = {} }) {
  const inTable = new Set(tableNames);
  const declared = new Set([...Object.keys(dependencies), ...Object.keys(devDependencies)]);
  return {
    missingFromTable: Object.keys(dependencies).filter((name) => !inTable.has(name)),
    notInPackageJson: tableNames.filter((name) => !declared.has(name)),
  };
}

/**
 * ルート直下の `packages/*` を検査し、ずれの一覧を返す。
 *
 * @param {string} root
 * @returns {{ checked: string[], problems: string[] }}
 */
export function checkRepo(root) {
  const checked = [];
  const problems = [];
  const packagesDir = join(root, 'packages');
  for (const name of readdirSync(packagesDir).sort()) {
    const readmePath = join(packagesDir, name, 'README.md');
    const pkgPath = join(packagesDir, name, 'package.json');
    if (!existsSync(readmePath) || !existsSync(pkgPath)) continue;
    const tableNames = parseDependencyTable(readFileSync(readmePath, 'utf8'));
    if (tableNames === null) continue;
    checked.push(name);
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const { missingFromTable, notInPackageJson } = compareDependencies({
      tableNames,
      dependencies: pkg.dependencies,
      devDependencies: pkg.devDependencies,
    });
    for (const dep of missingFromTable) {
      problems.push(`packages/${name}/README.md: dependencies の ${dep} が依存表に無い (表に行を足す)`);
    }
    for (const dep of notInPackageJson) {
      problems.push(
        `packages/${name}/README.md: 依存表の ${dep} が package.json の dependencies / devDependencies に無い (表から行を消す)`
      );
    }
  }
  return { checked, problems };
}

function main() {
  const root = process.argv[2] ?? '.';
  const { checked, problems } = checkRepo(root);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error(`check-deps: ${problems.length} 件のずれ。版は書かず、名前と用途だけを表に載せる (#269)`);
    process.exitCode = 1;
    return;
  }
  console.log(`check-deps: ずれ 0 件 (検査した README: ${checked.join(', ') || 'なし'})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
