/**
 * `--extract-sources <dir>`: proof ごとの submitted / verified / report.json の書き出し (#409)
 *
 * 採点者が「検証に通ったソース」を取り出す口。#293 で不一致を exit 1 にしたが、採点に使うソースを
 * 取り出す手段が無かった (jq で JSON から抜くしかない)。ここは**取り出して書くだけ**で、検証の判定には触れない。
 *
 * 守ること (verify-cli の AGENTS.md の不変条件 8):
 * - **元のソースを上書き・削除しない**。入力の ZIP は読むだけ。書き出し先のファイルは `wx` (O_EXCL) で作り、
 *   既存のものがあれば止める。シンボリックリンクも辿らない
 * - **`<dir>` の外に書かない**。名前は ZIP エントリ名と `proof.filename` (どちらも攻撃者が書ける) から作るので、
 *   basename だけを取り、使える文字を絞り、書く直前に解決したパスが `<dir>` の直下かを確かめる
 * - **submitted は対にできたものだけ** (`match` / `mismatch`)。`verified` はチェーンが検証に通った proof だけ
 *   (名前が「検証済み」を約束するので、改ざんされた proof の本文をその名で出さない)
 *
 * 判定 (対応規則) は shared の `matchSubmissionSources`、ZIP の読み出しは shared の予算付きリーダーが持つ。
 * このファイルはその結果を受けて書くだけで、規則を再実装しない。
 */

import { mkdir, open } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileExtensionForLanguage, type SubmissionPair } from '@typedcode/shared';

/** 名前 (ディレクトリ名) の最大長。 */
const MAX_NAME_LENGTH = 100;
/** 拡張子の最大長。 */
const MAX_EXTENSION_LENGTH = 16;
const FALLBACK_NAME = 'proof';
const FALLBACK_EXTENSION = 'txt';
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * 未信頼の文字列から、ファイルシステム上で安全な 1 階層の名前を作る。
 *
 * パス区切り (`/` `\`) で分けて**最後の 1 区間だけ**を使う (`../../x` → `x`、`/etc/passwd` → `passwd`)。
 * 文字は各言語の文字・数字・結合文字と `._-` だけを残し、他 (制御文字・NUL・ANSI・空白・記号) は `_` に置く。
 * 先頭の `.` (`.` / `..` / 隠しファイル) と末尾の `.` は落とし、空と Windows の予約名は置き換え、長さを切る。
 */
export function sanitizeEntryName(raw: string): string {
  const segments = raw.split(/[\\/]/).filter((s) => s !== '');
  const last = segments[segments.length - 1] ?? '';
  let name = last
    .replace(/[^\p{L}\p{N}\p{M}._-]/gu, '_')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .slice(0, MAX_NAME_LENGTH);
  if (name === '') name = FALLBACK_NAME;
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`;
  return name;
}

/** 拡張子 (ドットなし) を `[A-Za-z0-9]{1,16}` に絞る。外れたら `txt`。 */
export function sanitizeExtension(raw: string): string {
  return /^[A-Za-z0-9]+$/.test(raw) && raw.length <= MAX_EXTENSION_LENGTH ? raw : FALLBACK_EXTENSION;
}

/** proof の ZIP 内パスから、書き出し先ディレクトリの元になる名前 (フォルダと `.json` を除いたベース名) を作る。 */
export function proofDirBase(proofEntry: string): string {
  return sanitizeEntryName(proofEntry.replace(/\.json$/i, ''));
}

/**
 * 1 回の実行で使ったディレクトリ名を覚え、同じ名前 (大文字小文字を区別しない — macOS の既定 FS) の
 * 2 回目以降に `_2`, `_3`… を付ける。複数の ZIP が同じ `main_proof.json` を持っても、互いに潰し合わない。
 * 状態を持つので、1 回の実行につき 1 つ作る。
 */
export function createDirNamer(): (base: string) => string {
  const used = new Set<string>();
  return (base) => {
    let candidate = base;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${base}_${n}`;
    used.add(candidate.toLowerCase());
    return candidate;
  };
}

/** proof の検証結果の要約 (`report.json` に載せる)。 */
export type ExtractVerification =
  | {
      kind: 'completed';
      /** gate 込みの総合判定 (exit code を決めるもの) */
      valid: boolean;
      chainValid: boolean;
      metadataValid: boolean;
      /** 三層保証の Integrity (`proven` / `partial` / `failed` など) */
      integrity: string;
      errorMessage?: string;
    }
  /** `verifyProof` が例外を投げた (検証を完了できなかった) */
  | { kind: 'error'; reason: string };

export interface ExtractProofSourcesInput {
  /** 書き出し先 (`--extract-sources` の値) */
  outDir: string;
  namer: ReturnType<typeof createDirNamer>;
  /** 入力 ZIP のパス (`report.json` にはベース名だけ載せる) */
  input: string;
  /** proof の ZIP 内パス */
  proofEntry: string;
  /** proof の自己申告 (未検証なので unknown) */
  proofFilename: unknown;
  language: unknown;
  content: unknown;
  /** `matchSubmissionSources` の結果。無ければ未照合 */
  pair: SubmissionPair | undefined;
  /** `pair.expectedSource` の生バイト。ソースが無ければ undefined */
  sourceBytes: Uint8Array | undefined;
  verification: ExtractVerification;
}

export interface ExtractProofSourcesResult {
  /** 書き出したディレクトリ */
  dir: string;
  /** 書き出したファイル名 (`report.json` を含む) */
  files: string[];
}

/** `wx` (O_EXCL) でだけ書く。既存のファイルがあれば EEXIST で失敗し、上書きしない。 */
async function writeNew(path: string, data: Uint8Array | string): Promise<void> {
  const handle = await open(path, 'wx');
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

/**
 * proof 1 件分を `<outDir>/<名前>/` に書き出す。
 *
 * 書き出し先のディレクトリが既に在れば**何も書かずに**エラーにする (上書きしない。再実行で黙って別名も作らない)。
 * 例外は呼び出し側が失敗として数える (検証の合否とは独立に exit 1 へ倒す)。
 */
export async function extractProofSources(input: ExtractProofSourcesInput): Promise<ExtractProofSourcesResult> {
  const outDir = resolve(input.outDir);
  const name = input.namer(proofDirBase(input.proofEntry));
  const dir = join(outDir, name);
  // 多重防御: 無害化が正しければ常に真。外れたら書かない。
  if (dirname(resolve(dir)) !== outDir || basename(dir) !== name) {
    throw new Error(`Refusing to write outside the output directory: ${name}`);
  }

  await mkdir(outDir, { recursive: true });
  try {
    await mkdir(dir); // recursive にしない: 既存なら EEXIST (シンボリックリンクでも同じ)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Output directory already exists, not overwritten: ${dir}`);
    }
    throw error;
  }

  const expected = input.pair?.expectedSource;
  const ext = sanitizeExtension(
    expected?.includes('.')
      ? expected.slice(expected.lastIndexOf('.') + 1)
      : fileExtensionForLanguage(typeof input.language === 'string' ? input.language : '')
  );

  const files: string[] = [];
  const written: { submitted: string | null; verified: string | null } = { submitted: null, verified: null };

  // submitted: 対にできた (match / mismatch) ものだけ。他の proof のソースをこの proof の提出物として見せない。
  const status = input.pair?.status;
  if ((status === 'match' || status === 'mismatch') && input.sourceBytes !== undefined) {
    written.submitted = `submitted.${ext}`;
    await writeNew(join(dir, written.submitted), input.sourceBytes);
    files.push(written.submitted);
  }

  // verified: チェーンが検証に通った proof の proof.content だけ。
  const contentVerified =
    input.verification.kind === 'completed' && input.verification.chainValid && input.verification.metadataValid;
  if (contentVerified && typeof input.content === 'string') {
    written.verified = `verified.${ext}`;
    await writeNew(join(dir, written.verified), new TextEncoder().encode(input.content));
    files.push(written.verified);
  }

  const report = {
    schema: 1,
    input: basename(input.input),
    proofEntry: input.proofEntry,
    // 自己申告 (未検証)。JSON として文字列化するので制御文字は無害だが、信用はしない。
    proofFilename: typeof input.proofFilename === 'string' ? input.proofFilename : null,
    submission: input.pair
      ? {
          status: input.pair.status,
          ...(input.pair.expectedSource !== undefined ? { expectedSource: input.pair.expectedSource } : {}),
          ...(input.pair.mismatch ? { mismatch: input.pair.mismatch } : {}),
          ...(input.pair.reason !== undefined ? { reason: input.pair.reason } : {}),
        }
      : { status: 'not-checked' },
    files: written,
    ...(written.verified === null
      ? {
          verifiedSkipped: contentVerified
            ? 'proof has no text content'
            : 'proof verification did not pass the hash chain, so proof.content is not verified',
        }
      : {}),
    verification: input.verification,
  };
  await writeNew(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  files.push('report.json');

  return { dir, files };
}
