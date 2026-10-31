/**
 * UI テスト用に verify の実際の `index.html` の body を happy-dom に組み立てる。
 *
 * UI コンポーネントは constructor で `getElementById` により要素を掴むので、テスト用の
 * 断片 HTML を手で書くと本物の DOM とずれる。本物のマークアップを読むことで、ID の
 * 改名・削除もテストで検出できる。`<script>` は外す (main.ts を起動させない)。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const INDEX_HTML = join(dirname(fileURLToPath(import.meta.url)), '../../../index.html');

export function mountVerifyIndexHtml(): void {
  const html = readFileSync(INDEX_HTML, 'utf8');
  const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)?.[1] ?? '';
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, '');
}

/** `<input type="file">` に選択済みファイルを積む (ブラウザのファイル選択ダイアログの代わり)。 */
export function setInputFiles(input: HTMLInputElement, files: File[]): void {
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  input.files = transfer.files;
}
