# ADR-0007: 記録/試験モードで捕捉する生信号を最大化し確定する

- **Status**: Proposed
- **Date**: 2026-06-05
- **Deciders**: (PR 上の合意者 / レビュアー)
- **PR / Commit**: (this PR)

> このドラフトは「**何を捕捉するか**」の合意記録。**実装は後続 PR**。捕捉は不可逆 (過去の試験は録り直せない) なので、実装前に確定させる。**分析ロジックは別 ADR・後段で pluggable** にする方針なので本 ADR の対象外 (本 ADR はあくまで生信号の確保)。

## Context

試験での生成 AI / 自動入力ツール検出の**土台＝生信号の捕捉**を確定する。設計原則:

> **捕捉＝不可逆 / 分析＝後回し可。** 判定テスト「将来の分析器が記録済みストリームからこれを計算できるか? YES→後回し / NO (実行時にしか存在しない事実)→今捕捉」。

- **モード設計 (ADR-0006 と整合)**: 捕捉は**両モードで最大・同一**。モード差は機能のみ (exam = 封印問題の展開 + チェーン束縛、casual = ただ記録するエディタ)。proof フォーマット/イベントストリームは両モード完全同一で、違いは `exam` ブロックの有無だけ。
- **唯一の例外 = permission が要る API**: ユーザに許可プロンプトが出るため、casual の「ただのエディタ」では邪魔。→ **無許可信号は両モードで最大取得 / permissioned は exam モードのみ** (or opt-in)。
- **ハードな限界 (誠実に明記)**: ブラウザは **他アプリ・他タブの中身・OS クリップボード (paste 以外)・実行中プロセス・ChatGPT のウィンドウ・他タブの通信を一切見られない** (プロセス/オリジン分離)。「ChatGPT が開いている」を直接検出する API は存在しない。捕捉は常に (a) 自ページへの**入力の出自**、(b) **本セッションの環境/liveness**、(c) **ギャップ** の3観点で、AI 利用検出は間接的。
- **既に十分捕捉済みで追加不要なもの**: キーストローク timing (イベント時刻+code から再計算可)、転写トポロジー用の `rangeOffset/rangeLength/range`、focus/visibility 遷移、マウス、paste/drop/copy 本文、スクショ画像 (ZIP) + hash。→ これらに依存する行動/転写/相関分析は**追加捕捉ゼロで後段化**できる。

## Considered Options

- **最小捕捉 vs 最大捕捉** → **最大** (不可逆ゆえ「将来要るかも」は全部取る)。
- **無許可信号: 両モード vs exam 限定** → **両モード** (プロンプト無しなので casual でも害がない)。
- **permissioned 信号: 両モード vs exam 限定** → **exam 限定** (両モードで要求すると casual がプロンプト地獄)。
- **格納先: ハッシュチェーン vs サイドメタ** → **チェーン** (改ざん検出対象にする。限界: フル recorder 再実装には偽造可、拡張/page-JS 注入は捕捉)。
- **実験的 API (Compute Pressure) を入れるか** → **PoC で入れる** (graceful absence 前提、ローカル LLM 稼働のヒント)。

## Decision

捕捉信号を以下のティアで確定。**全信号に共通の堅牢性規約** = ① **graceful absence** (feature-detect し、無い/拒否は値を捏造せず「unavailable」を事実として記録 — 可用性自体が信号) ② **ハッシュチェーン格納** ③ **加算的・versioned スキーマ** ④ **高頻度信号はサンプリング/集約で容量管理**。

### Tier 0 — 両モード・無許可・常時取得 (「現実的に取れる最大」の背骨)

| 群 | 信号 |
|---|---|
| **A 入力出自** | `event.isTrusted` (key/input/paste/pointer)、`KeyboardEvent.repeat/location/getModifierState()`、`beforeinput`/`input` の `inputType`/`isComposing`/`getTargetRanges()`、`CompositionEvent`(start/update/end)、`PointerEvent`(pointerType/pressure/`getCoalescedEvents()`/`getPredictedEvents()`)、`navigator.userActivation` |
| **B 自動化/環境** | `navigator.webdriver`、自動化グローバル痕跡 (`cdc_*`/`__playwright` 等)、WebGL `UNMASKED_RENDERER_WEBGL` (headless tell)、`userAgentData.getHighEntropyValues()`、`hardwareConcurrency`/`deviceMemory`、`plugins`/permission 矛盾、`navigator.connection`、`Intl` timezone |
| **C liveness/ギャップ** | Visibility・focus/blur・`hasFocus()`、**Page Lifecycle** (`freeze/resume/pagehide/pageshow/wasDiscarded/beforeunload`)、rAF 刻み・Long Tasks、**Event Timing** (入力レイテンシ)、**ローカル heartbeat イベント** (サーバ不要・ギャップを first-class 化) |
| **D ディスプレイ (無許可分)** | `screen.*`/`screenX/Y`/`devicePixelRatio`/`visualViewport`、`matchMedia('(display-mode)')`、`document.fullscreenElement` |
| **E メディア (無許可分)** | `mediaDevices.enumerateDevices()` の台数 (仮想カメラ=画面横流しの tell) |
| **G タブ/窓関係** | `window.opener/parent/top`/`frames.length`、`document.referrer` |

### Tier 1 — exam モードのみ・要許可 (開始時に要求、grant/deny を事実記録、strict は拒否で開始不可)

- **Window Management API** (`getScreenDetails()`/`screen.isExtended`) — 第2モニタ検出 (`window-management`)
- **Idle Detection API** (`IdleDetector`) — フォーカス中でも idle/画面ロック検出 (`idle-detection`)
- 画面共有 (`getDisplayMedia`、既存) — displaySurface=monitor 強制
- 任意: camera (`getUserMedia`) — webcam proctoring

### Experimental — PoC・best-effort

- **Compute Pressure API** (`PressureObserver`) — CPU/GPU 負荷圧。ローカル LLM 稼働のヒントになり得る。可用性が低いので graceful absence 必須。信号でなく**ヒント**扱い。

### 堅牢性 (実装注意として確定)

- **Page Lifecycle**: early 配線 + `pagehide` 時に IndexedDB flush (既存 `flushToIndexedDB` 活用)。
- **beforeinput / composition**: Monaco の隠し入力要素に直接フック。**IME / paste / 通常入力の全経路で発火するキャプチャテスト必須** (本 ADR で唯一実装リスクが高い箇所)。
- **PointerEvent coalesced**: `getCoalescedEvents()` をサンプリング/集約 (生の数百点/秒をそのまま入れない)。捕捉レートは実装時に決定。

## Consequences

### Positive

- **任意の将来分析器に完全な材料**を残せる (再捕捉不要)。automation/liveness/第2モニタ信号が後から利用可能。
- **両モード均一フォーマット** = casual の記録も exam と同等に分析可能。
- 既存の豊富な生ストリームと合わせ、**転写/挙動/相関分析は追加捕捉ゼロで後段差し替え可能**。

### Negative / Trade-offs

- **高頻度信号 (pointer coalesced・rAF) の容量** → サンプリング/集約設計が必要。
- **Monaco 入力フック (beforeinput/composition) の複雑さ** → 全経路のキャプチャテストが要る。
- **exam の permissioned UX** → 開始時に複数プロンプト (儀式として許容、grant/deny 記録)。
- **偽造の限界** → フル recorder 再実装には全信号偽造可 (拡張/page-JS 注入クラスは捕捉)。
- **プライバシー姿勢** → exam = 明示同意の proctoring、casual = 取得しても**ローカル保持** (「データはブラウザ外に出ない」を維持)。要運用要項明記。
- **実験 API の差異** → Compute Pressure 等はブラウザ/版で可用性が揺れる。ヒント扱い。

### Follow-ups / 残課題

- 具体的な **event-type / field スキーマ**を `system-spec.md` に定義 (実装 PR と同時)。
- 高頻度信号の**捕捉レート/集約方式**の確定。
- Monaco の `beforeinput`/`composition` フックの**キャプチャテスト**整備。
- exam の **permission 要求 UX / 開始儀式**の設計 (grant/deny 記録、strict ポリシー)。
- **分析層 (転写トポロジー + focus↔バースト相関 + keystroke↔content 整合 + 自動化判定)** は**別 ADR**。本 ADR の捕捉データを消費する。
- Compute Pressure の PoC 評価 (誤検出率・可用性)。

## References

- [ADR-0006](0006-exam-mode-sealed-problem-binding.md) — 試験モードの封印問題束縛 (本 ADR の捕捉と対)
- [ADR-0005](0005-input-type-policy.md) — paste/import の構造的禁止 (入力出自の既存方針)
- [docs/system-spec.md](../system-spec.md) — イベント型・検証レイヤ (捕捉スキーマの定義先)
- `packages/editor/src/tracking/` — 既存トラッカ群 (KeystrokeTracker/Mouse/Window/Visibility/Network/Screenshot/InputDetector/OperationDetector)
- `packages/shared/src/fingerprint.ts` — 既存の環境フィンガープリント (B 群の一部)
- `packages/editor/src/ui/tabs/TabManager.ts` — `flushToIndexedDB` (Page Lifecycle flush に活用)
