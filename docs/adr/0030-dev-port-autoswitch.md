# ADR-0030: dev サーバのポートはランチャーがセット単位で自動割当し、配線を環境変数で追従させる

- **Status**: Accepted
- **Date**: 2026-07-19
- **Deciders**: (PR 上の合意者 / レビュアー)
- **PR / Commit**: 導入 PR (Issue #196)

## Context

root の `npm run dev` は concurrently で editor (vite :5173) / verify (vite :5174) / workers (wrangler dev :8787) を同時起動する。ポート間には固定の配線がある:

- editor の `/verify` プロキシ → `http://localhost:5174` (vite.config に直書き)
- editor の Workers API → `VITE_API_URL` (.env に `http://localhost:8787` を直書き)

vite の既定 (`strictPort: false`) では、ポートが使用中だと**黙って +1 ずつずれて起動する**。別プロジェクトや別 worktree の dev サーバが先にポートを取っていると、editor だけが未知のポートへ流れ、上記の配線は**エラーも出さずに**別物 (前回セッションの残骸プロセス等) へつながる。実際に「別プロジェクトが 5173 を占有 → editor がずれ、`npm run dev` すると verify のページばかり目に付く」という混乱が起きた (concurrently の `[0][1][2]` 出力では 3 サーバの判別も難しい)。

CONTRIBUTING はこれまで「dev サーバのポートは全 worktree で共有。併用するときはポートを変える」と**手動運用**を注意書きしてきたが、「ポートを変える」は editor / verify / workers のポートに加えプロキシと `VITE_API_URL` を同期して変える作業であり、忘れた箇所から黙って壊れる。複数プロジェクト・複数 worktree を同時にデバッグする運用は今後も続くため、無調整で共存できる仕組みが要る。

## Considered Options

### Option A: `strictPort: true` を入れるだけ (fail-fast)
- Pros: 実装最小。黙認ずれによる誤配線は防げる (衝突が即エラーになる)。
- Cons: 衝突時に起動自体ができず、「同時にデバッグしたい」という要件に応えない。ユーザーが手でポートを探して指定する手間は残る。→ 却下 (ただしランチャー割当時の保険として部分採用)。

### Option B: worktree / プロジェクトごとに固定ポートを手で変える (現行 CONTRIBUTING の運用)
- Pros: 仕組み不要。
- Cons: ポート 3 つ + プロキシ + `VITE_API_URL` の 5 点を手で同期する運用で、忘れた箇所が黙って壊れる。実際に混乱が起きた。→ 却下。

### Option C: 起動ランチャーがセット単位で空きポートを探し、環境変数で配線ごと注入 (本 ADR)
- `scripts/dev.mjs` が起動前に {editor, verify, workers} の 3 ポートを**セットとして**確保し、決定値を `EDITOR_PORT` / `VERIFY_PORT` / `WORKERS_PORT` で各プロセスへ渡す。vite.config / wrangler がそれを読み、プロキシ先と `VITE_API_URL` も同じ値から導出する。
- Pros: 衝突時も無調整で起動し、配線が常に自己整合する。concurrently に名前 (`editor` / `verify` / `workers`) と色を付けられ、どの URL が何かも起動バナーで明示できる。個別起動 (`npm run dev:editor` 等) は従来挙動のまま。
- Cons: ランチャーという新しい可動部品が増える。→ **採用**。

### Option D: 各サーバが実ポートをファイル等で公示し、他が動的に発見する (service discovery)
- Cons: 起動順依存が生まれ、dev 用途には過剰な複雑さ。→ 却下。

## Decision

**Option C** を採る。

- **セット探索**: 既定 {editor 5173, verify 5174, workers 8787}。1 つでも使用中なら**セットごと +10** (5183/5184/8797, …) して再試行 (最大 10 セット)。個別に詰めず一貫したオフセットで動かすのは、覚えやすさと「編集系は 517x、API は 87xx」という帯の維持のため。
- **空き判定**: `127.0.0.1` と `::1` の両方で listen を試す (vite は `::1`、workerd は両方で listen するため片方だけでは見逃す)。`EADDRINUSE` / `EACCES` のみ使用中と判定し、IPv6 無効環境のエラーは空き扱い。
- **配線追従**: editor の `/verify` プロキシ先は `VERIFY_PORT` から導出。`VITE_API_URL` は .env の値が**ローカル既定 (`http://localhost:<port>`) のときだけ** `WORKERS_PORT` へ追従させ、staging 等の外部 URL を明示している場合は触らない (Vite は process.env を .env ファイルより優先する仕様を利用)。
- **黙認ずれの禁止**: ランチャーがポートを割り当てた場合 (`EDITOR_PORT` 等が設定されている場合) は `strictPort: true`。探索と listen の間の race で衝突したら黙ってずれず失敗させる (再実行すれば次の空きセットが選ばれる)。手動の個別起動 (env 未設定) は従来どおり vite のフォールバックに任せる。
- **変更しないもの**: workers の CORS (dev は localhost をポート不問で許可済み)。e2e (`E2E_EDITOR_PORT` / `E2E_WORKERS_PORT` で既に可変・独自起動)。

## Consequences

### Positive

- 複数プロジェクト・複数 worktree の dev サーバ同時起動が無調整で共存できる (CONTRIBUTING の手動注意書きを置換)。
- 「ずれた editor が古い残骸プロセスの verify / workers につながる」誤配線クラスの問題が根絶される (配線は常に同一セット内で自己整合)。
- concurrently の名前付き出力と起動バナーで「どの URL が何のサーバか」が一目で分かる。

### Negative

- ランチャー (`scripts/dev.mjs`) という保守対象が増える。ポート帯の変更はランチャーと各 vite.config の既定値の 2 箇所に現れる (env のフォールバック値)。
- 探索と実 listen の間の TOCTOU race は原理的に残る (strictPort により「黙って壊れる」ではなく「即失敗 → 再実行で回復」に倒してある)。
- `.env` の `VITE_API_URL` にローカル以外を書いている場合は追従しない (意図尊重)。ローカルの workers ではなく staging API に向けたデバッグは従来どおり可能。
