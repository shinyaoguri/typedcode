/**
 * ファイル選択ダイアログ (`#file-input`) の購読を 1 か所にまとめる。
 *
 * 以前は WelcomePanel と AppController が同じ change を二重に購読していて、先に走った側が
 * `value` を空にすることで後の側が空振りする、という順序依存で二重処理を免れていた。
 * 購読はここ (AppController から 1 回だけ呼ぶ) に限り、他の UI は `click()` で開くだけにする。
 * 単一購読は `ui/__tests__/fileInput.test.ts` が機械的に固定する。
 */

/**
 * change で選ばれたファイルを配列に写し取ってから `value` を空にし、`onFiles` に 1 回だけ渡す。
 * 写し取ってから空にするのは、`value = ''` で `input.files` が空の FileList に差し替わるため
 * (空にしないと同じファイルを選び直したとき change が発火しない)。
 */
export function bindFileInput(input: HTMLInputElement, onFiles: (files: File[]) => void): void {
  input.addEventListener('change', () => {
    const files = input.files ? Array.from(input.files) : [];
    input.value = '';
    if (files.length > 0) onFiles(files);
  });
}

/**
 * ファイルを選ばれた順に 1 件ずつ処理する (前のファイルの処理が終わってから次へ)。
 * 並列にすると ZIP 展開やフォルダ生成がサイドバー上で入り乱れる。
 */
export async function processFilesInOrder(
  files: Iterable<File>,
  process: (file: File) => Promise<void>
): Promise<void> {
  for (const file of files) {
    await process(file);
  }
}
