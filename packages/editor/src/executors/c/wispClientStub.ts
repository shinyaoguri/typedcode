/**
 * `@mercuryworkshop/wisp-js/client` の差し替え (vite.config.ts の resolve.alias から参照)
 *
 * `@wasmer/sdk` 0.19 は sandbox の network mode が "wisp" のときだけ
 * `wisp-network.js` を動的 import し、それが AGPL-3.0 の wisp-js を読み込む。
 * TypedCode (MIT) は sandbox のネットワークを使わない (CExecutor は既定の
 * `mode: "disabled"`) ので、AGPL のコードを配信物に入れないようこの空実装に置き換える (#364)。
 * 万一 wisp mode が使われたら黙って動かず、ここで明示的に失敗させる。
 */

const DISABLED_MESSAGE = 'WISP networking is disabled in TypedCode (see Issue #364)';

class ClientConnection {
  constructor() {
    throw new Error(DISABLED_MESSAGE);
  }
}

export const client = { ClientConnection };
