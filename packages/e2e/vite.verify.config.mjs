/**
 * E2E 用の verify dev サーバの設定 (#229)。packages/verify/vite.config.ts をそのまま使い、
 * exam の出題者鍵だけ差し替える (exam-keys/vite-plugin.mjs。editor の vite.editor.config.mjs と同じ仕組み)。
 *
 * verify Web は `.tcexam` の署名を shared の examAuthorityKeys (registry + localKeys) で検証する。差し替えないと
 * E2E の使い捨ての出題者鍵を信頼せず、束縛が検証済みにならない (temporal が exam-t0 にならない)。
 *
 * playwright.config.ts の webServer が `--config` で指す。verify 本体の設定には何も足さないので、
 * 本番ビルドや通常の `npm run dev` は E2E 用の鍵を信頼しない。fixture が無ければプラグインは何もしない。
 */
import { mergeConfig } from 'vite';
import verifyConfig from '../verify/vite.config.ts';
import { examAuthorityKeysPlugin } from './exam-keys/vite-plugin.mjs';

export default mergeConfig(verifyConfig, { plugins: [examAuthorityKeysPlugin()] });
