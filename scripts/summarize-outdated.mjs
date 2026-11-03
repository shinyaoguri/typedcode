#!/usr/bin/env node
/**
 * npm 依存の古さの集計 (#261) — `npm outdated --json` の出力を、人が読む Markdown の要約にする。
 * .github/workflows/freshness.yml が週次で呼び、結果を常設 Issue に追記する。
 *
 * 背景: 以前は workflow の中に埋め込んだ node -e で集計していて、次の問題があった。
 *   - major 判定が先頭の数字だけを比べていた。0.x は minor の更新が実質 breaking なので、
 *     `@wasmer/sdk 0.10 → 0.19` が major の表に出なかった
 *   - 意図して据え置いている更新 (typescript 7 など) が毎週「major N 件」として報告され続けた
 *   - latest < current の行 (DefinitelyTyped の stub 型など) まで古い依存として数えていた
 *
 * ルール:
 *   - breaking = latest が current より後で、かつ semver の caret が互換としない更新。
 *     major が上がる、または major が 0 のとき minor が上がる (0.10 → 0.19)、または 0.0.x のとき patch が上がる
 *   - latest が current より前の行 (stub 型の逆転) は数えない
 *   - IGNORED に当たる行 (名前が一致し、latest が `from` 以降) は本表から外し、「据え置き中」として別に出す。
 *     件数にも has_findings にも数えない (据え置きだけでは Issue に追記しない)
 *   - 前回の報告と、実行 ID と対象コミットの行を除いて同じなら、追記しない (isSameReport)
 *
 * 判定 (summarizeOutdated / isSameReport) は純関数。入出力は CLI 部分 (main) に閉じる。
 *
 * 使い方:
 *   node scripts/summarize-outdated.mjs --input outdated.json --body-file deps.md
 *       npm outdated --json の出力を読み、要約を書き出す。GITHUB_OUTPUT があれば `count` を書く
 *   node scripts/summarize-outdated.mjs --same-report previous.md current.md
 *       2 つの報告が (実行 ID と対象コミットを除いて) 同じなら exit 0、違えば exit 1
 *
 * exit 2 = 入力が読めないなどの入力エラー。
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 意図して据え置いている更新。`name` の latest が `from` 以降の行を「据え置き中」にする。
 * 決着したら該当行を消す (消すと次の run から本表に出る)。
 */
export const IGNORED = [
  {
    name: 'typescript',
    from: '7.0.0',
    issue: '#208',
    reason: 'TypeScript 7 (ネイティブコンパイラ) への移行を検討中',
  },
];

/** `1.2.3` / `v1.2.3-beta.1` を [major, minor, patch] にする。読めなければ null。 */
export function parseVersion(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** a < b なら負、a > b なら正、等しければ 0。読めない版が混ざれば null。 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * current → latest が breaking (caret が互換としない更新) か。
 * 後退 (latest < current) と読めない版は false。
 */
export function isBreaking(current, latest) {
  const c = parseVersion(current);
  const l = parseVersion(latest);
  if (!c || !l) return false;
  const order = compareVersions(latest, current);
  if (order === null || order <= 0) return false;
  if (l[0] !== c[0]) return true;
  if (c[0] !== 0) return false;
  if (l[1] !== c[1]) return true;
  return c[1] === 0 && l[2] !== c[2];
}

/** `npm outdated --json` の出力 (パッケージ名 → 情報または情報の配列) を行の配列にする。 */
export function toRows(data) {
  return Object.entries(data).flatMap(([name, info]) =>
    (Array.isArray(info) ? info : [info]).map((i) => ({
      name,
      current: i.current ?? '-',
      wanted: i.wanted ?? '-',
      latest: i.latest ?? '-',
      dependent: i.dependent ?? '-',
    }))
  );
}

/** 行が IGNORED のどれかに当たれば、その定義を返す。 */
export function findIgnore(row, ignored = IGNORED) {
  return ignored.find((rule) => rule.name === row.name && (compareVersions(row.latest, rule.from) ?? -1) >= 0);
}

/** 同じ name / current / latest の行を 1 行にまとめ、workspace を並べる。 */
function groupRows(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.name}\t${r.current}\t${r.latest}`;
    const g = groups.get(key) ?? { ...r, workspaces: [] };
    g.workspaces.push(r.dependent);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name) || a.current.localeCompare(b.current));
}

/**
 * 集計 (純関数)。
 *
 * @param {Record<string, unknown>} data `npm outdated --json` をパースしたもの
 * @param {typeof IGNORED} [ignored]
 * @returns {{ count: number, breaking: number, ignored: number, markdown: string }}
 *   count = 本表の件数 (据え置きと後退の行を除く)。0 のとき markdown は空文字
 */
export function summarizeOutdated(data, ignored = IGNORED) {
  const behind = toRows(data).filter((r) => (compareVersions(r.current, r.latest) ?? -1) <= 0);
  const held = [];
  const rows = [];
  for (const r of behind) {
    const rule = findIgnore(r, ignored);
    if (rule) held.push({ ...r, rule });
    else rows.push(r);
  }
  const breaking = rows.filter((r) => isBreaking(r.current, r.latest));
  if (rows.length === 0) {
    return { count: 0, breaking: 0, ignored: held.length, markdown: '' };
  }

  const lines = [`古い依存: **${rows.length} 件** (うち breaking の可能性あり: **${breaking.length} 件**)`, ''];

  if (breaking.length > 0) {
    lines.push('breaking の可能性があるもの (major が上がる、または 0.x で minor が上がる):', '');
    lines.push('| package | current | latest | workspace |', '|---|---|---|---|');
    for (const g of groupRows(breaking)) {
      lines.push(`| \`${g.name}\` | ${g.current} | ${g.latest} | ${g.workspaces.join(', ')} |`);
    }
    lines.push('');
  }

  if (held.length > 0) {
    lines.push(`据え置き中 (件数に数えない: ${held.length} 行):`, '');
    lines.push('| package | current | latest | workspace | 理由 |', '|---|---|---|---|---|');
    for (const g of groupRows(held)) {
      lines.push(
        `| \`${g.name}\` | ${g.current} | ${g.latest} | ${g.workspaces.join(', ')} | ${g.rule.reason} (${g.rule.issue}) |`
      );
    }
    lines.push('');
  }

  lines.push('<details><summary>全件 (npm outdated)</summary>', '');
  lines.push('| package | current | wanted | latest | workspace |', '|---|---|---|---|---|');
  for (const r of [...rows].sort((a, b) => a.name.localeCompare(b.name) || a.dependent.localeCompare(b.dependent))) {
    lines.push(`| \`${r.name}\` | ${r.current} | ${r.wanted} | ${r.latest} | ${r.dependent} |`);
  }
  lines.push('', '</details>');

  return { count: rows.length, breaking: breaking.length, ignored: held.length, markdown: `${lines.join('\n')}\n` };
}

/** 毎回変わる実行 ID と対象コミットの行を除き、末尾の空白をそろえる。 */
export function normalizeReport(body) {
  return String(body)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => !/^- (実行|対象コミット):/.test(line))
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

/** 前回の報告と今回の報告が、実行 ID と対象コミットを除いて同じか (同じなら追記しない)。 */
export function isSameReport(previous, current) {
  return normalizeReport(previous) === normalizeReport(current);
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv) {
  const same = argv.indexOf('--same-report');
  if (same >= 0) {
    const [previous, current] = [argv[same + 1], argv[same + 2]];
    if (!previous || !current) {
      console.error('--same-report には前回と今回のファイルを 2 つ渡す');
      return 2;
    }
    const equal = isSameReport(readFileSync(previous, 'utf8'), readFileSync(current, 'utf8'));
    console.log(equal ? '前回の報告と同じ内容' : '前回の報告から変わった');
    return equal ? 0 : 1;
  }

  const input = argValue(argv, '--input');
  const bodyFile = argValue(argv, '--body-file');
  if (!input || !bodyFile) {
    console.error('使い方: summarize-outdated.mjs --input outdated.json --body-file deps.md');
    return 2;
  }
  let data;
  try {
    const text = readFileSync(input, 'utf8').trim();
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    console.error(`${input} が読めない: ${error.message}`);
    return 2;
  }

  const result = summarizeOutdated(data);
  writeFileSync(bodyFile, result.markdown);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `count=${result.count}\n`);
  console.log(`Outdated dependencies: ${result.count} (breaking ${result.breaking}, 据え置き中 ${result.ignored})`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
