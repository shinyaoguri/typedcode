# ADR-0029: マージ後の掃除はバージョン管理されたスクリプト (git sweep) に集約する

- **Status**: Accepted
- **Date**: 2026-07-09
- **Deciders**: (PR 上の合意者 / レビュアー)
- **PR / Commit**: 導入 PR

## Context

ADR-0028 のタグ式 GitHub Flow では feature ブランチを頻繁に切り、作業は git worktree (`.claude/worktrees/`) で並行して行う (Claude Code のセッションも worktree 単位で動く)。PR マージのたびにローカルブランチと worktree の掃除が発生するが、これまで手順は暗黙で、掃除は各自の手作業だった。

同じ worktree 運用の姉妹プロジェクト (skopos) では「`git sweep` が、中で Claude Code セッションが動いている worktree を削除してしまい、セッションが再開不能になる」事故が実際に起きている (Claude Code のセッションは作業ディレクトリ単位で管理されるため、worktree が消えると `No conversation found with session ID` になり、未消化の依頼が宙に浮く)。対策として安全チェック付きスクリプトをバージョン管理する判断が下された (skopos ADR-0007)。TypedCode は同じ運用形態であり、同じ事故クラスを持つ。

## Considered Options

### Option A: CONTRIBUTING に手順・スニペットを書くだけ
- Pros: 実装不要。
- Cons: 危険な操作はドキュメントの注意書きでは防げない。「sweep 前にセッション有無を確認」と書いても、読み飛ばした瞬間に事故が再現する。スニペットを各自の `.git/config` に写す方式は修正が行き渡らずレビューもされない (コピペ運用は静かに腐る)。→ 却下。

### Option B: バージョン管理されたスクリプト + 薄い git alias (本 ADR)
- `scripts/sweep.sh` をリポジトリに置き、`git sweep` エイリアスは薄いエントリポイント (`!bash scripts/sweep.sh`) に留める。
- 安全側スキップ (現在地 / dirty / 使用中プロセス) を機械的なガードとして持つ。
- Pros: 安全判定が人・エージェントの注意力に依存しない。掃除ロジックの変更が PR としてレビュー・共有される。実行可能な実体があると指示が「`git sweep` を実行」の一語で済み、エージェントが手順書を毎回再解釈するブレがなくなる。
- Cons: clone ごとに一度のセットアップ (`fetch.prune` + alias 登録) が必要。→ **採用**。

### Option C: さらに自動化 (git hook / 定期実行で sweep)
- Cons: pull のたび・時間経過で worktree が消えるのは削除タイミングが予測できず、事故をむしろ起こしやすい。「マージ直後に明示的に実行」で十分軽い。→ 却下。

## Decision

**Option B** を採る。

- **削除対象** (worktree ごと削除): upstream が消えた (`[gone]`) ローカルブランチ、および一度も push されず既定ブランチに完全に含まれる `worktree-*` プレースホルダ (Claude Code の EnterWorktree が自動生成し、作業が別名ブランチで PR されると固有コミットなしで残るもの)。
- **安全側スキップ**: ①現在いる worktree ②未コミットの変更がある worktree ③使用中の worktree (lsof で「その中を cwd とするプロセス」を検出。生きているセッション・シェル等)。
- **運用**: PR をマージした者 (人・エージェント問わず) が、その流れでメインのチェックアウトから `git sweep` を実行する。定期バッチにはしない。
- **検証**: `scripts/sweep.test.ts` (vitest。使い捨ての bare origin + clone を組み立てて実挙動を確認する統合テスト) をスクリプト変更時に手元で回す (`npx vitest run scripts/sweep.test.ts`)。ユニット CI には常設しない (git 実環境依存かつ変更頻度が低いため。頻繁に触るようになったら再検討)。

## Consequences

### Positive
- 「生きているセッション入りの worktree を消す」事故クラスが機械的に防がれる。
- 掃除がコマンド一語になり、人にもエージェントにも運用が定着する。マージ→掃除までを 1 つの流れにできる。

### Negative / Trade-offs
- clone ごとに一度の初期設定が必要: `git config fetch.prune true` と `git config alias.sweep '!bash scripts/sweep.sh'` (CONTRIBUTING に記載)。
- lsof が使えない環境では使用中チェックは働かない (現在地・dirty チェックは働く)。
- **終了済みセッションの worktree は保護されない**。マージ後の追加依頼は古いセッションに投げず、main から新しいセッション・新しい worktree で始める運用とセットで機能する。引き継ぎの真実を Issue に置く運用 (CONTRIBUTING「Issue の書き方と引き継ぎ」) を守っていれば、セッションが消えても失われる情報はない。

## References

- skopos ADR-0007 (同運用での実事故と判断の原典。スクリプト・テストの移植元)
- [CONTRIBUTING.md](../../CONTRIBUTING.md) 「マージ後の掃除 (git sweep)」(日々の手順)
- [ADR-0028](0028-tag-based-github-flow.md) (worktree 運用の前提となるブランチモデル)
