/**
 * E2E 用の editor dev サーバの設定 (#229)。packages/editor/vite.config.ts をそのまま使い、
 * exam の出題者鍵だけ差し替える (exam-keys/vite-plugin.mjs)。
 *
 * playwright.config.ts の webServer が `--config` で指す。editor 本体の設定には何も足さないので、
 * 本番ビルドや通常の `npm run dev` は E2E 用の鍵を信頼しない。
 */
import { mergeConfig } from 'vite';
import editorConfig from '../editor/vite.config.ts';
import { examAuthorityKeysPlugin } from './exam-keys/vite-plugin.mjs';

export default mergeConfig(editorConfig, { plugins: [examAuthorityKeysPlugin()] });
