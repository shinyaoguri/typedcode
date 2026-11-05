/**
 * E2E 用の editor dev サーバの設定 (#229)。packages/editor/vite.config.ts をそのまま使い、
 * exam の出題者鍵だけ差し替える (exam-keys/vite-plugin.mjs)。起動時の空き容量の試験の書き込み量も縮める (#626)。
 *
 * playwright.config.ts の webServer が `--config` で指す。editor 本体の設定には何も足さないので、
 * 本番ビルドや通常の `npm run dev` は E2E 用の鍵を信頼しない。
 */
import { mergeConfig } from 'vite';
import editorConfig from '../editor/vite.config.ts';
import { examAuthorityKeysPlugin } from './exam-keys/vite-plugin.mjs';

// 起動時の空き容量の試験 (#626) で書く量を 1MB に縮める。既定の 200MB を全テストで毎回書かない
// (Playwright の既定の context は IndexedDB をメモリに置くので、CI のメモリも守る)。editor は dev ビルドの
// ときだけこの値を読む (services/StorageCapacityProbe.ts)。Vite は process.env にある VITE_* を .env より優先する
process.env.VITE_STORAGE_PROBE_BYTES ??= String(1024 * 1024);

export default mergeConfig(editorConfig, { plugins: [examAuthorityKeysPlugin()] });
