/**
 * editor の dev サーバで `/verify` を開いたときのリダイレクト先 (#829)。
 *
 * 本番では検証 Web は editor の `/verify/` 配下 (verify の `base: '/verify/'`) にあるので、エディタと作問画面の
 * 「証明を検証」のリンクは `/verify/` を指す。dev の verify は `base: '/'` で別のポートに立つため、以前は
 * editor が `/verify` を転送してパスを外していたが、返る HTML の `/src/main.ts` をブラウザが editor の
 * オリジンで解決して editor の main.ts を読み、壊れた画面になった。dev では転送をやめ、verify の dev
 * サーバへリダイレクトする (packages/editor/vite.config.ts のミドルウェアが使う)。
 *
 * ホスト名はリクエストの `Host` から取る (`127.0.0.1` や LAN の名前で開いたときに追従する)。
 */

/**
 * `url` (リクエストのパスとクエリ) が `/verify` か `/verify/...` なら、verify の dev サーバの URL を返す。
 * それ以外 (`/verifyfoo` など、`/verify` で始まるだけの別のパスを含む) は null。
 *
 * @param {string | undefined} url リクエストの URL (`req.url`。`/verify/?mode=fast` の形)
 * @param {string | undefined} host リクエストの `Host` ヘッダ (`localhost:5173` / `[::1]:5173` の形)
 * @param {number} verifyPort verify の dev サーバのポート
 * @returns {string | null}
 */
export function verifyRedirectLocation(url, host, verifyPort) {
  if (!url) return null;
  const match = /^\/verify(?=$|[/?#])(.*)$/.exec(url);
  if (!match) return null;
  let rest = match[1];
  if (!rest.startsWith('/')) rest = `/${rest}`;
  return `http://${hostnameOf(host)}:${verifyPort}${rest}`;
}

/** `Host` ヘッダからポートを外したホスト名。取れなければ `localhost`。IPv6 の角括弧は残す。 */
function hostnameOf(host) {
  if (!host) return 'localhost';
  const match = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::\d+)?$/.exec(host.trim());
  return match ? match[1] : 'localhost';
}
