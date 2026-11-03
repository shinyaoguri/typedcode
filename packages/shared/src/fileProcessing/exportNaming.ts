/**
 * export ZIP 内のファイル名の付け方 (editor の `ProofExporter` と提出物検証の共有仕様, #293)
 *
 * ZIP のソースファイルと proof JSON は、タブ 1 つにつき 1 組出る。名前の決め方は editor が持っていたが、
 * 検証側 (`submissionSources.ts`) が「この proof の対のソースは何という名前か」を editor と同じ手順で
 * 作り直せないと、同名タブ (`main.c` × 2) や拡張子だけが違うタブ (`main.c` + `main.py`) を正しく
 * 対にできない。手順をここ 1 箇所に置き、editor はここから名前を作り、検証側はここで名前を再現する。
 * 別々に書き起こすとドリフトして、正常な提出が「ソース欠落」になる。
 *
 * 規則 (editor の複数タブ export と同じ):
 * - ソース: `filename` が `.<ext>` で終わっていなければ `.<ext>` を足す (`<ext>` は言語から決まる。未知の言語は `txt`)。
 *   同じ**拡張子込みの名前**が 2 つ目以降なら、拡張子の前に `_1`, `_2`… を挟む (`main.c` → `main_1.c`)
 * - proof: `filename` から最後の拡張子を除いた base に `_proof.json`。同じ **base** が 2 つ目以降なら
 *   `_proof_1.json`, `_proof_2.json`…
 * - 2 つの数え方は**キーが違う**: ソースは拡張子込み、proof は base。だから `main.c` + `main.py` は
 *   ソースが `main.c` / `main.py` (番号なし)、proof が `main_proof.json` / `main_proof_1.json` になる
 */

/**
 * 言語 ID → ソースファイルの拡張子 (ドットなし)。editor の対応言語の正本。
 * editor の `SUPPORTED_LANGUAGES[].fileExtension` はここから取る (表を別に持たない)。
 */
export const LANGUAGE_FILE_EXTENSIONS = {
  c: 'c',
  cpp: 'cpp',
  javascript: 'js',
  typescript: 'ts',
  python: 'py',
  html: 'html',
  css: 'css',
  plaintext: 'txt',
} as const;

/** 表に無い言語に使う拡張子。 */
export const FALLBACK_FILE_EXTENSION = 'txt';

/**
 * 言語 ID から拡張子 (ドットなし) を返す。表に無い言語 (自己申告の任意文字列を含む) は `txt`。
 * `__proto__` のような名前を引かないよう、自前のプロパティだけを見る。
 */
export function fileExtensionForLanguage(language: string): string {
  return Object.hasOwn(LANGUAGE_FILE_EXTENSIONS, language)
    ? LANGUAGE_FILE_EXTENSIONS[language as keyof typeof LANGUAGE_FILE_EXTENSIONS]
    : FALLBACK_FILE_EXTENSION;
}

/** タブ名に言語の拡張子を補う (既にその拡張子で終わっていれば足さない)。重複の番号付けはしない。 */
export function withLanguageExtension(filename: string, language: string): string {
  const ext = fileExtensionForLanguage(language);
  return filename.endsWith(`.${ext}`) ? filename : `${filename}.${ext}`;
}

/** proof ファイル名の base (タブ名から最後の拡張子を除いたもの)。 */
export function proofBaseName(filename: string): string {
  return filename.replace(/\.[^.]+$/, '');
}

/** タブ 1 つ分の入力。 */
export interface ExportTabName {
  filename: string;
  language: string;
}

/** タブ 1 つ分の ZIP 内ファイル名。 */
export interface ExportFilenames {
  source: string;
  proof: string;
}

/**
 * タブを**出力する順に** 1 つずつ渡して、重複を解決した ZIP 内ファイル名を返す関数を作る。
 * 状態 (重複の数え) を持つので、1 回の export (または 1 つの突き合わせ) につき 1 つ作ること。
 */
export function createExportNamer(): (tab: ExportTabName) => ExportFilenames {
  const usedSources = new Map<string, number>();
  const usedProofBases = new Map<string, number>();

  return (tab) => {
    const sourceName = withLanguageExtension(tab.filename, tab.language);
    const sourceCount = usedSources.get(sourceName) ?? 0;
    usedSources.set(sourceName, sourceCount + 1);
    let source = sourceName;
    if (sourceCount > 0) {
      const base = sourceName.replace(/\.[^.]+$/, '');
      const extension = sourceName.match(/\.[^.]+$/)?.[0] ?? '';
      source = `${base}_${sourceCount}${extension}`;
    }

    const base = proofBaseName(tab.filename);
    const proofCount = usedProofBases.get(base) ?? 0;
    usedProofBases.set(base, proofCount + 1);
    const proof = proofCount > 0 ? `${base}_proof_${proofCount}.json` : `${base}_proof.json`;

    return { source, proof };
  };
}

/** `createExportNamer` を全タブに順に当てた結果。複数タブ export が使う。 */
export function planExportFilenames(tabs: readonly ExportTabName[]): ExportFilenames[] {
  const next = createExportNamer();
  return tabs.map(next);
}
