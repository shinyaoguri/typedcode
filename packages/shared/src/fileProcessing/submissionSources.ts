/**
 * 提出物 (ZIP) の対応規則と照合 (#293)
 *
 * export ZIP には、タブごとに「ソース」と「proof JSON (`content` = 検証済みの本文)」が同梱される。
 * proof を検証しても、同梱ソースが `proof.content` と同じである保証にはならない — ZIP からソースを取り出して
 * 採点する運用では、**検証したものと採点するものがずれる**。この層が両者を対にして、バイト単位で照合する。
 * verify-cli と verify (web) は同じこの関数を通る (片方だけが落ちる乖離を作らない)。
 *
 * ## 対応規則
 *
 * proof 1 件につき「期待されるソースの名前」を**1 つだけ**作る。名前の推測 (ベース名の一致など) は使わない。
 *
 * 1. proof の自己申告 `filename` と `language` から、editor と同じ手順 (`exportNaming.ts`) でソース名を作る
 * 2. 同じ名前のタブが複数あるときは、proof ファイル名の `_proof` / `_proof_1` / `_proof_2`… の順
 *    (= タブの順) に、ソース名へ `_1`, `_2`… を割り当てる。ソースと proof で重複の数え方が違う
 *    (ソースは拡張子込み、proof は拡張子なし) ことも `exportNaming.ts` がそのまま再現する
 * 3. 期待名のソースが ZIP に無ければ `missing-source`。あれば `proof.content` とバイト単位で照合する
 *
 * `proof.filename` は自己申告 (改ざんされうる) だが、照合は「その名前のソースが `proof.content` と一致するか」
 * なので、名前を偽っても、検証済みでない内容を `match` にはできない。**内容が一致する別名のソースを探して
 * 割り当てることはしない**: 本物を `valid_1.js` に、偽物を期待名 `valid.js` に置かれたとき、本物と対にすると
 * 偽物が孤立ソース (警告) になるだけで通ってしまう。
 *
 * ## 比較
 *
 * `proof.content` を UTF-8 に符号化したバイト列と、ZIP から取り出した**生のバイト列**の厳密一致。
 * 改行 (CRLF / LF)・BOM・末尾の空白・Unicode 正規化は**正規化しない**。正規化は「検証した内容」と「採点する
 * 内容」の差を隠す。editor は同じ `content` 変数から両方を書くので、正直な ZIP が食い違うことはない。
 *
 * ## 結論の重さ (`submissionSeverity`)
 *
 * - `mismatch` / `ambiguous`: failure (提出物の不整合。proof 自体は改ざんされていないので integrity は落とさない)
 * - `missing-source` / 孤立ソース: warning
 * - `uncheckable`: ZIP にソースがあるなら failure、無ければ warning
 */

import { isBinaryFile } from './languageDetection.js';
import { createExportNamer } from './exportNaming.js';

/** 照合の入力に使う proof 1 件。自己申告の欄は未検証なので `unknown` で受ける。 */
export interface SubmissionProofInput {
  /** ZIP 内のパス (例 `main_proof_1.json`、サブフォルダなら `sub/main_proof.json`) */
  path: string;
  /** proof の自己申告 `filename` (タブ名) */
  filename: unknown;
  /** proof の自己申告 `language` */
  language: unknown;
  /** proof の `content` (検証済みの本文) */
  content: unknown;
}

/** ZIP から取り出したソース候補。 */
export interface SubmissionSourceInput {
  /** ZIP 内のパス */
  path: string;
  /** 生のバイト列 (BOM・改行を含めてそのまま) */
  bytes: Uint8Array;
}

export interface MatchSubmissionSourcesInput {
  proofs: readonly SubmissionProofInput[];
  /** proof の名前なのに読めなかったファイルのパス。タブ番号の欠番になるので、後続の対応を確定できなくする。 */
  unreadableProofPaths?: readonly string[];
  sources: readonly SubmissionSourceInput[];
}

export type SubmissionPairStatus =
  /** 期待名のソースがあり、`proof.content` とバイト単位で一致する */
  | 'match'
  /** 期待名のソースはあるが、`proof.content` と異なる */
  | 'mismatch'
  /** 期待名のソースが ZIP に無い */
  | 'missing-source'
  /** 期待名を一意に決められない (欠番・読めない proof が先にある、または他の proof と期待名が衝突する) */
  | 'ambiguous'
  /** `filename` / `content` が文字列でなく、期待名も比較対象も作れない */
  | 'uncheckable';

/** 不一致の要約 (内容そのものは含めない)。 */
export interface SubmissionMismatchDetail {
  /** `proof.content` の UTF-8 バイト数 */
  proofContentBytes: number;
  /** 同梱ソースのバイト数 */
  sourceBytes: number;
  /** 最初に食い違うバイトの位置 (0 始まり)。一方が他方の先頭部分なら短い方の長さ */
  firstDifferenceOffset: number;
}

export interface SubmissionPair {
  /** proof の ZIP 内パス */
  proofPath: string;
  status: SubmissionPairStatus;
  /** 期待されるソースの ZIP 内パス (作れなかったときは無い) */
  expectedSource?: string;
  /** `mismatch` のときの要約 */
  mismatch?: SubmissionMismatchDetail;
  /** `ambiguous` / `uncheckable` の理由 (固定文言。未信頼の値は含めない) */
  reason?: string;
}

export interface SubmissionReport {
  /** proof ごとの結果 (入力 `proofs` の順) */
  pairs: SubmissionPair[];
  /** どの proof の期待名にも当たらなかったソースのパス (昇順) */
  orphanSources: string[];
  /** ソース候補の数 */
  sourceCount: number;
}

/** 結論の重さ。 */
export type SubmissionSeverity = 'ok' | 'warning' | 'failure';

const ENCODER = new TextEncoder();

interface ProofSlot {
  /** 入力 `proofs` での位置。読めない proof は -1 */
  index: number;
  path: string;
  dir: string;
  base: string;
  n: number;
}

/** `dir/` と `file` に分ける。 */
function splitPath(path: string): { dir: string; file: string } {
  const slash = path.lastIndexOf('/');
  return { dir: path.slice(0, slash + 1), file: path.slice(slash + 1) };
}

/** `<base>_proof(_N)?.json` を分解する。当たらない名前 (構造だけで proof と判定された JSON) は N=0 の単独扱い。 */
function parseProofPath(path: string): Pick<ProofSlot, 'dir' | 'base' | 'n'> {
  const { dir, file } = splitPath(path);
  const m = /^(.*)_proof(?:_(\d+))?\.json$/i.exec(file);
  if (m) return { dir, base: m[1] ?? '', n: m[2] === undefined ? 0 : Number(m[2]) };
  return { dir, base: file.replace(/\.json$/i, ''), n: 0 };
}

function compareSlots(a: ProofSlot, b: ProofSlot): number {
  if (a.dir !== b.dir) return a.dir < b.dir ? -1 : 1;
  if (a.base !== b.base) return a.base < b.base ? -1 : 1;
  if (a.n !== b.n) return a.n - b.n;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function firstDifference(a: Uint8Array, b: Uint8Array): number {
  const limit = Math.min(a.length, b.length);
  for (let i = 0; i < limit; i++) if (a[i] !== b[i]) return i;
  return limit;
}

/**
 * ZIP のエントリ名が、ソースの候補か (= proof でも付属物でもないか)。
 *
 * 除くもの: ディレクトリ、`screenshots/` 配下、`.json` (proof・`tab-switches.json` など)、README
 * (`README.md` / `README.ja.md`。editor が同梱する)、隠しファイル、バイナリ。
 */
export function isSubmissionSourceEntry(path: string): boolean {
  if (path.endsWith('/')) return false;
  if (path.startsWith('screenshots/') || path.includes('/screenshots/')) return false;
  const file = splitPath(path).file;
  if (file === '' || file.startsWith('.')) return false;
  if (/\.json$/i.test(file)) return false;
  if (/^README(?:\.[A-Za-z-]+)?\.md$/i.test(file)) return false;
  if (isBinaryFile(file)) return false;
  return true;
}

/**
 * proof 群と同梱ソース群を対応規則 (ファイル先頭のコメント参照) で対にして照合する。純関数。
 */
export function matchSubmissionSources(input: MatchSubmissionSourcesInput): SubmissionReport {
  const sourceByPath = new Map<string, Uint8Array>();
  for (const s of input.sources) sourceByPath.set(s.path, s.bytes);

  // タブの順 (= proof ファイル名の N の順) に並べる。読めない proof も欠番として混ぜる。
  const slots: ProofSlot[] = [
    ...input.proofs.map((p, index) => ({ index, path: p.path, ...parseProofPath(p.path) })),
    ...(input.unreadableProofPaths ?? []).map((path) => ({ index: -1, path, ...parseProofPath(path) })),
  ].sort(compareSlots);

  const pairs: Array<SubmissionPair | undefined> = new Array(input.proofs.length).fill(undefined);
  const expectedOf: Array<string | undefined> = new Array(input.proofs.length).fill(undefined);
  const namerByDir = new Map<string, ReturnType<typeof createExportNamer>>();

  // グループ (dir + base) ごとに、番号の連続性と「名前を知れないタブが先にあるか」を追う。
  let groupKey = '';
  let nextN = 0;
  let unknownBefore = false;
  for (const slot of slots) {
    const key = `${slot.dir}\u0000${slot.base}`;
    if (key !== groupKey) {
      groupKey = key;
      nextN = 0;
      unknownBefore = false;
    }
    if (slot.n !== nextN) unknownBefore = true; // 欠番 (proof が抜かれた) か重複した番号
    nextN = slot.n + 1;

    if (slot.index < 0) {
      unknownBefore = true; // 読めない proof: そのタブの名前を知れない
      continue;
    }

    const proof = input.proofs[slot.index]!;
    if (typeof proof.filename !== 'string' || typeof proof.content !== 'string') {
      pairs[slot.index] = {
        proofPath: proof.path,
        status: 'uncheckable',
        reason: 'proof has no filename or content to compare',
      };
      unknownBefore = true;
      continue;
    }
    if (unknownBefore) {
      pairs[slot.index] = {
        proofPath: proof.path,
        status: 'ambiguous',
        reason:
          'an earlier proof in the same name group is unreadable or missing, so the source name cannot be determined',
      };
      continue;
    }

    let namer = namerByDir.get(slot.dir);
    if (!namer) {
      namer = createExportNamer();
      namerByDir.set(slot.dir, namer);
    }
    // language が文字列でなければ未知の言語 (拡張子 txt) 扱い。
    const language = typeof proof.language === 'string' ? proof.language : '';
    expectedOf[slot.index] = `${slot.dir}${namer({ filename: proof.filename, language }).source}`;
  }

  // 期待名が複数の proof に衝突していたら、どれがどのソースの対か決められない。
  const claimCount = new Map<string, number>();
  for (const expected of expectedOf) {
    if (expected !== undefined) claimCount.set(expected, (claimCount.get(expected) ?? 0) + 1);
  }

  const claimed = new Set<string>();
  input.proofs.forEach((proof, i) => {
    if (pairs[i]) return;
    const expected = expectedOf[i]!;
    claimed.add(expected);
    if ((claimCount.get(expected) ?? 0) > 1) {
      pairs[i] = {
        proofPath: proof.path,
        status: 'ambiguous',
        expectedSource: expected,
        reason: 'more than one proof expects the same source file',
      };
      return;
    }
    const bytes = sourceByPath.get(expected);
    if (bytes === undefined) {
      pairs[i] = { proofPath: proof.path, status: 'missing-source', expectedSource: expected };
      return;
    }
    const content = ENCODER.encode(proof.content as string);
    if (bytesEqual(bytes, content)) {
      pairs[i] = { proofPath: proof.path, status: 'match', expectedSource: expected };
      return;
    }
    pairs[i] = {
      proofPath: proof.path,
      status: 'mismatch',
      expectedSource: expected,
      mismatch: {
        proofContentBytes: content.length,
        sourceBytes: bytes.length,
        firstDifferenceOffset: firstDifference(bytes, content),
      },
    };
  });

  const orphanSources = input.sources
    .map((s) => s.path)
    .filter((path) => !claimed.has(path))
    .sort();

  return { pairs: pairs as SubmissionPair[], orphanSources, sourceCount: input.sources.length };
}

/**
 * 1 件の結論の重さ。CLI (exit code) と web (タブの status) がどちらもこれを使う。
 * `uncheckable` は、ZIP に採点対象になりうるソースがあるときだけ failure
 * (proof から `content` を抜けば比較を避けられる、を塞ぐ)。
 */
export function submissionSeverity(report: SubmissionReport, pair: SubmissionPair): SubmissionSeverity {
  switch (pair.status) {
    case 'match':
      return 'ok';
    case 'mismatch':
    case 'ambiguous':
      return 'failure';
    case 'missing-source':
      return 'warning';
    case 'uncheckable':
      return report.sourceCount > 0 ? 'failure' : 'warning';
  }
}
