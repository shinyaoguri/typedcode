/**
 * `tsx --import <このファイル> cli.ts …` で verify-cli に出題者鍵の差し替え (node-hook.mjs) を登録する (#229)。
 * helpers/verifyCli.ts の `examAuthorityKeys` オプションが付ける。
 */
import { register } from 'node:module';

register('./node-hook.mjs', import.meta.url);
