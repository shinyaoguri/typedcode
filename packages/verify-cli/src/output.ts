/**
 * Result formatting and terminal output
 */

const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
} as const;

const useColors = process.stdout.isTTY && !process.env['NO_COLOR'];

function c(color: keyof typeof COLORS, text: string): string {
  return useColors ? `${COLORS[color]}${text}${COLORS.reset}` : text;
}

/** 未信頼値を 1 行に収めるための表示上限。超えた分は切り詰めて `(sanitized)` を付ける。 */
const MAX_UNTRUSTED_LENGTH = 200;

/**
 * proof / ZIP 由来の**未信頼**文字列を stdout へ出す前に無害化する (#266)。
 *
 * CLI の stdout はパイプして grep される (不変条件 4)。生値のままだと改行で任意の行を、
 * ANSI エスケープで色と既存行の上書きを注入でき、`✓ main_proof.json` のような
 * **偽の合格行を採点スクリプトに読ませられる** (ZIP エントリ名で実際に再現済み)。
 *
 * - C0 / C1 制御文字 (ESC・CR・LF を含む) を除去する
 * - `MAX_UNTRUSTED_LENGTH` で切り詰める
 * - **除去か切り詰めが起きたときだけ `(sanitized)` を付ける**。黙って消すと「元からその名前
 *   だった」と読めてしまい、採点者が異常に気づけない
 *
 * 保証するのは「**未信頼値が 1 行に収まり、行頭を乗っ取れない**」ところまで。`Error:` 行の中に
 * `Hash Chain:  PASS` という**文字列**が残ることは防げない (正当な本文と区別できない) ので、
 * 採点スクリプトは `^Hash Chain:` のように**行頭を固定して** grep すること。
 *
 * 注意: `c()` による着色は `safe()` の**外側**で行うこと。内側に入れると CLI 自身の ANSI まで
 * 落ちる。また非文字列も受ける — 未検証の proof には数値であるべき欄に文字列が入りうる。
 */
export function safe(value: unknown): string {
  const raw = typeof value === 'string' ? value : String(value);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字の除去そのものが目的
  const stripped = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  const truncated = stripped.slice(0, MAX_UNTRUSTED_LENGTH);
  return truncated === raw ? truncated : `${truncated} (sanitized)`;
}

import type {
  VerificationMode,
  SignedCheckpointsVerificationResult,
  AnalysisReport,
  AssuranceResult,
  ProcessSummary,
  ProcessKeyMoment,
  ScreenshotVerificationSummary,
} from '@typedcode/shared';
import type { CLIExamResult } from './verify.js';

export interface VerificationOutput {
  valid: boolean;
  metadataValid: boolean;
  chainValid: boolean;
  isPureTyping: boolean;
  eventCount: number;
  duration: number;
  pasteEvents: number;
  dropEvents: number;
  poswIterations?: number;
  errorAt?: number;
  errorMessage?: string;
  language?: string;
  mode?: VerificationMode;
  poswSkipped?: boolean;
  signedCheckpoints?: SignedCheckpointsVerificationResult;
  /** root がサーバアンカーされているか (ADR-0017) */
  rootAnchored?: boolean;
  /** 分析層 (ADR-0009) の advisory レポート。判定ではない。 */
  analysis?: AnalysisReport;
  /** 三層保証語彙 (ADR-0020)。 */
  assurance?: AssuranceResult;
  /** プロセス要約 (Phase 8 W3)。 */
  processSummary?: ProcessSummary;
  /** 試験モードの束縛検証 (ADR-0006)。exam proof でないときは undefined。 */
  exam?: CLIExamResult;
  /** スクリーンショット検証 (#147)。undefined = 未検査 (JSON 単体入力)。 */
  screenshots?: ScreenshotVerificationSummary;
}

function passFail(ok: boolean): string {
  return ok ? c('green', 'PASS') : c('red', 'FAIL');
}

/**
 * 三層保証語彙 (ADR-0020) の 1 行サマリ。
 * 整合性 / 時刻アンカーは決定的、著述性は常に advisory (判定ではない) として併記する。
 */
function formatAssurance(a: AssuranceResult): string[] {
  // #214: fast モードは PoSW を再計算していない = PROVEN ではない。PARTIAL は「改ざんの疑い」
  // ではなく「実施していない検査がある」の意なので、色も赤ではなく黄にする。
  const integrity =
    a.integrity === 'proven'
      ? c('green', 'PROVEN')
      : a.integrity === 'partial'
        ? c('yellow', 'PARTIAL')
        : c('red', 'FAILED');

  let temporal: string;
  switch (a.temporal) {
    case 'anchored':
      temporal = c('green', 'ANCHORED');
      break;
    case 'partial':
      temporal = c('yellow', 'PARTIAL');
      break;
    case 'exam-t0':
      temporal = c('green', 'EXAM-T0');
      break;
    default:
      temporal = c('yellow', 'UNANCHORED');
  }

  const parts: string[] = [a.provenance.pureTyping ? 'pure typing' : 'external input present'];
  if (a.provenance.notableSignals !== null) {
    parts.push(`${a.provenance.notableSignals} signal(s)`);
  }
  if (a.provenance.reviewPriority !== null) {
    parts.push(`review ${(a.provenance.reviewPriority * 100).toFixed(0)}%`);
  }

  const lines = [
    c('cyan', '--- Assurance (ADR-0020) ---'),
    `Integrity:  ${integrity}  ${c('dim', '(tamper evidence — cryptographic, deterministic)')}`,
  ];
  if (a.integrity === 'partial') {
    lines.push(c('dim', '            PoSW was not recomputed — the declared values are consistent with the proof,'));
    lines.push(c('dim', '            but the sequential work itself is unverified (see --mode full).'));
  }
  lines.push(
    `Timeline:   ${temporal}  ${c('dim', '(when it existed — server-signed / exam T0)')}`,
    `Authorship: ${c('yellow', 'ADVISORY')}  ${c('dim', `(${parts.join(', ')} — human judgment required)`)}`
  );
  return lines;
}

/** 試験モード (ADR-0006) の束縛検証セクションを描画する。 */
function formatExamSection(exam: CLIExamResult, lines: string[]): void {
  lines.push('');
  lines.push(c('cyan', '--- Exam binding (ADR-0006) ---'));

  // #218: package を渡したのに exam ブロックが無い = 採点ゲートの誤用。exam 情報も root 束縛も
  // 存在しないので描画せず、ゲートが対象外の proof に当たったことだけを明示する。
  if (!exam.present) {
    lines.push(c('red', '  ! --exam-package was provided but this proof has no exam block'));
    lines.push(c('dim', '    This submission is not an exam proof — the exam binding gate does not apply to it.'));
    if (exam.binding?.reason) {
      lines.push(c('red', `  Reason: ${safe(exam.binding.reason)}`));
    }
    return;
  }

  // examId / problemId / variant は proof の自己申告 (#273 で manifest 突合を検討中)。
  // 突合前でも「壊れた文字を出さない」ことだけは境界で保証する (#266)。
  const variant = exam.variant ? ` / ${safe(exam.variant)}` : '';
  lines.push(`Exam:         ${safe(exam.examId)} / ${safe(exam.problemId)}${variant}`);
  // root 束縛は proof 自己完結 (package 不要)。
  lines.push(`Root binding: ${passFail(exam.rootBindingValid)}  ${c('dim', '(answer bound to package + T0)')}`);

  const b = exam.binding;
  if (!b) {
    lines.push(c('yellow', '  ! Package not provided — signature/content checks skipped'));
    lines.push(c('dim', '    Pass --exam-package <file.tcexam> to fully verify authenticity.'));
    return;
  }

  lines.push(`Signature:    ${passFail(b.packageSignatureValid)}`);
  lines.push(`Package hash: ${passFail(b.packageHashMatches)}`);
  lines.push(`Content hash: ${passFail(b.problemContentHashMatches)}`);
  if (b.timeBox) {
    const tb = b.timeBox;
    lines.push(`Time-box:     ${safe(tb.releaseTime)} … ${safe(tb.deadline)}`);
    if (tb.withinWindow === null) {
      lines.push(c('dim', '    (submission time not provided — pass --submitted-at to check the window)'));
    } else if (tb.withinWindow) {
      lines.push('  Submitted within window: yes');
    } else {
      // time-box は advisory (ADR-0013)。束縛検証の合否ではないので PASS/FAIL の語彙を使わない
      // (総合 PASS の下に FAIL と出ると、採点者が失格条件と読み違える)。
      lines.push(
        `  Submitted within window: ${c('yellow', 'no')}  ${c('dim', '(advisory — the submission window is managed by Moodle, not by this proof)')}`
      );
    }
  }
  if (!b.valid && b.reason) {
    lines.push(c('red', `  Reason: ${safe(b.reason)}`));
  }
}

/** ms を「1h 23m」「4m 05s」「12s」形式へ。 */
function formatDurationMs(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

const MOMENT_LABELS: Record<ProcessKeyMoment['kind'], string> = {
  'first-run': 'First run',
  'first-failed-run': 'First failed run',
  'first-success-after-failure': 'First success after failure',
  'longest-pause': 'Longest pause',
  'largest-deletion': 'Largest rewrite',
  'largest-insertion': 'Largest bulk insert',
  'focus-return-burst': 'Burst after refocus',
  'external-input': 'External input',
};

/** プロセス要約 (Phase 8 W3) のセクション。中立な記述であって疑い表示ではない。 */
function formatProcessSummary(p: ProcessSummary): string[] {
  const lines: string[] = [];
  lines.push('');
  lines.push(c('cyan', '--- Process summary ---'));
  const ratio = p.deletionRatio !== null ? `${(p.deletionRatio * 100).toFixed(0)}%` : '—';
  lines.push(
    `Work:        ${formatDurationMs(p.durationMs)}, +${p.insertedChars.toLocaleString()} / -${p.deletedChars.toLocaleString()} chars (deletion ratio ${ratio})`
  );
  const runs = p.hasRunResults
    ? `${p.executionCount} run(s) [${p.runSuccessCount} ok / ${p.runFailureCount} failed]`
    : `${p.executionCount} run(s)`;
  lines.push(
    `Activity:    ${runs}, ${p.pauseCount} long pause(s), ${p.focusLossCount} focus loss(es), ${p.externalInputCount} external input(s)`
  );
  for (const note of p.reflectionNotes) {
    // 学習者が自由入力した文字列 = 未信頼 (#266)。改行は正当な入力なので ` / ` へ畳んでから
    // (捨てると文が繋がって読めなくなる)、残る制御文字を safe() で落とす。旧実装は \r と ESC を
    // 素通ししていた。
    lines.push(`Reflection:  ${safe(note.replace(/\n/g, ' / '))}`);
  }
  for (const m of p.moments) {
    const range =
      m.toEventIndex !== undefined && m.toEventIndex !== m.fromEventIndex
        ? `events ${m.fromEventIndex}–${m.toEventIndex}`
        : `event ${m.fromEventIndex}`;
    const value =
      m.value === undefined
        ? ''
        : m.kind === 'longest-pause'
          ? ` (${formatDurationMs(m.value)})`
          : ` (${m.value.toLocaleString()} chars)`;
    lines.push(c('dim', `  ${MOMENT_LABELS[m.kind]}${value} @ ${range}`));
  }
  return lines;
}

export function formatResult(result: VerificationOutput): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(c('bold', '=== TypedCode Proof Verification ==='));
  lines.push('');

  if (result.valid) {
    lines.push(c('green', '\u2713 Verification PASSED'));
  } else {
    lines.push(c('red', '\u2717 Verification FAILED'));
    // proof \u81ea\u4f53\u306f\u5065\u5168\u3067 exam \u675f\u7e1b\u3060\u3051\u304c\u5931\u6557\u3057\u305f\u3068\u304d\u3001\u30c1\u30a7\u30fc\u30f3\u306e (\u6210\u529f) \u30e1\u30c3\u30bb\u30fc\u30b8\u3092
    // \u300cError:\u300d\u3068\u3057\u3066\u51fa\u3059\u3068\u8aa4\u89e3\u3092\u62db\u304f\u3002\u305d\u306e\u5834\u5408\u306f exam \u675f\u7e1b\u306e\u7406\u7531\u3092\u51fa\u3059\u3002
    const examBindingFailedOnly =
      result.metadataValid && result.chainValid && !!result.exam?.binding && !result.exam.binding.valid;
    // #217: スクショ改ざんも同じ形の矛盾を起こす (チェーン健全 → errorMessage は成功文字列のまま、
    // 総合 valid だけが screenshotsValid で false になる)。改ざん枚数を失敗理由として出す。
    const tamperedShots = result.screenshots?.tampered ?? 0;
    const screenshotsFailedOnly = result.metadataValid && result.chainValid && tamperedShots > 0;
    if (examBindingFailedOnly || screenshotsFailedOnly) {
      // 両方落ちることもある (exam proof の ZIP でスクショも改ざん) ので、片方に潰さず両方出す。
      if (examBindingFailedOnly) {
        lines.push(c('red', `  Exam binding failed: ${safe(result.exam!.binding!.reason ?? 'see section below')}`));
      }
      if (screenshotsFailedOnly) {
        lines.push(
          c(
            'red',
            `  Screenshots failed: ${tamperedShots}/${result.screenshots!.total} tampered — hash mismatch or not backed by the chain`
          )
        );
      }
    } else {
      if (result.errorMessage) {
        // 検証失敗の理由には proof 由来の値が埋め込まれる (`got ${claimed[key]}` など)。
        lines.push(c('red', `  Error: ${safe(result.errorMessage)}`));
      }
      if (result.errorAt !== undefined) {
        lines.push(c('red', `  Failed at event: ${safe(result.errorAt)}`));
      }
    }
  }

  // #214: fast モードは PoSW の反復再計算をスキップする (spec §8.2)。PoSW 行だけの注記だと
  // 「PASSED」を見た採点者が逐次作業まで検証済みと読む。合否の直下で保証の範囲を明示する。
  if (result.poswSkipped) {
    lines.push(c('yellow', '  ! fast mode: PoSW was NOT recomputed — sequential work is unverified'));
    lines.push(c('dim', '    Re-run with --mode full to verify the PoSW iterations.'));
  }
  lines.push('');

  // 三層保証語彙 (ADR-0020): PASS/FAIL の直下で「何がどの強さで保証されているか」を先に示す。
  if (result.assurance) {
    lines.push(...formatAssurance(result.assurance));
    lines.push('');
  }

  lines.push(c('cyan', '--- Details ---'));
  if (result.language) {
    lines.push(`Language:        ${result.language}`);
  }
  lines.push(`Total Events:    ${result.eventCount.toLocaleString()}`);
  lines.push(`Verify Duration: ${result.duration.toFixed(1)}s`);
  lines.push('');

  lines.push(c('cyan', '--- Checks ---'));
  lines.push(`Metadata:    ${result.metadataValid ? c('green', 'PASS') : c('red', 'FAIL')}`);
  lines.push(`Hash Chain:  ${result.chainValid ? c('green', 'PASS') : c('red', 'FAIL')}`);

  if (result.isPureTyping) {
    lines.push(`Pure Typing: ${c('green', 'YES')} (no paste/drop detected)`);
  } else {
    lines.push(`Pure Typing: ${c('yellow', 'NO')}`);
    if (result.pasteEvents > 0) {
      lines.push(`  - Paste events: ${result.pasteEvents}`);
    }
    if (result.dropEvents > 0) {
      lines.push(`  - Drop events: ${result.dropEvents}`);
    }
  }

  if (result.poswIterations) {
    const poswStatus = result.poswSkipped ? c('yellow', 'SKIPPED (fast mode)') : c('green', 'VERIFIED');
    // 型は number だが値は proof の自己申告なので、非数値が来たら整形せず safe() で出す (#266)。
    const iterations =
      typeof result.poswIterations === 'number' && Number.isFinite(result.poswIterations)
        ? result.poswIterations.toLocaleString()
        : safe(result.poswIterations);
    lines.push(`PoSW:        ${iterations} iterations/event — ${poswStatus}`);
  }

  if (result.mode) {
    lines.push(`Mode:        ${result.mode}`);
  }

  // root のサーバアンカー (ADR-0017)。exam は独自の T0 束縛を持つため表示しない。
  if (!result.exam?.present) {
    if (result.rootAnchored) {
      lines.push(`Root anchor: ${c('green', 'VERIFIED')} (server-anchored chain root)`);
    } else {
      lines.push(`Root anchor: ${c('yellow', 'unanchored')} (no session start token — offline fabrication possible)`);
    }
  }

  const sc = result.signedCheckpoints;
  if (sc) {
    if (!sc.anchored) {
      lines.push(`Anchoring:   ${c('yellow', 'unavailable')} (no signed checkpoints)`);
    } else if (sc.valid) {
      const cov = sc.coverage;
      const pct = (cov.coverageRatio * 100).toFixed(1);
      lines.push(`Anchoring:   ${c('green', 'VERIFIED')} (${cov.signedCount} signed checkpoints, ${pct}% coverage)`);
      if (sc.temporal?.postHocSuspected) {
        lines.push(c('yellow', '  ! Post-hoc batch signing suspected (server span << client span)'));
      }
      // anchoring 密度 (ADR-0016): 主張イベント数/時間に対する署名 cp の間隔。
      if (sc.density) {
        const gapServerSec = (sc.density.maxGapServerMs / 1000).toFixed(0);
        lines.push(
          c(
            'dim',
            `  Density: max gap ${sc.density.maxGapEvents} events / ${gapServerSec}s, first anchor @ event ${sc.density.firstAnchorEventIndex}`
          )
        );
        if (sc.density.sparse) {
          lines.push(c('yellow', '  ! Anchoring is sparse for the claimed session (few/late signed checkpoints)'));
        }
      }
      if (sc.details.some((d) => d.warning === 'key-revoked-but-trusted-by-time')) {
        lines.push(c('yellow', '  ! Some envelopes signed with a key that was later revoked'));
      }
    } else {
      // reason には proof 由来の keyId / algorithm が埋め込まれる。
      lines.push(`Anchoring:   ${c('red', 'FAILED')} ${sc.reason ? safe(sc.reason) : ''}`);
    }
  }

  // スクリーンショット検証 (#147): Web と同一の shared 実装で突合した結果。
  // 未検査 (JSON 単体入力) は明示して overclaim を防ぐ。
  const ss = result.screenshots;
  if (ss) {
    if (ss.tampered > 0) {
      lines.push(
        `Screenshots: ${c('red', 'FAILED')} (${ss.tampered}/${ss.total} tampered — hash mismatch or not backed by the chain)`
      );
    } else if (ss.total > 0 || ss.chainOnly > 0) {
      const ok = ss.missing === 0 && ss.chainOnly === 0;
      lines.push(
        `Screenshots: ${ok ? c('green', 'VERIFIED') : c('yellow', 'PARTIAL')} (${ss.verified}/${ss.total} verified)`
      );
    }
    if (ss.missing > 0) {
      lines.push(c('yellow', `  ! ${ss.missing} image(s) listed in the manifest are missing from the ZIP`));
    }
    if (ss.chainOnly > 0) {
      lines.push(
        c(
          'yellow',
          `  ! ${ss.chainOnly} screenshot hash(es) recorded in the chain have no manifest entry (screenshots may have been stripped)`
        )
      );
    }
  } else {
    lines.push(c('dim', 'Screenshots: not checked (provide the export ZIP to verify screenshots)'));
  }

  // 試験モード (ADR-0006): exam ブロックがあれば束縛検証セクションを出す。
  if (result.exam) {
    formatExamSection(result.exam, lines);
  }

  // プロセス要約 (Phase 8 W3): 制作過程の中立な記述。採点者が 30 秒で掴むための要約。
  if (result.processSummary) {
    lines.push(...formatProcessSummary(result.processSummary));
  }

  // 分析層 (ADR-0009): 検証とは別軸の advisory。判定ではないことを明示する。
  const analysis = result.analysis;
  if (analysis) {
    lines.push('');
    lines.push(c('cyan', '--- Analysis (advisory) ---'));
    lines.push(c('dim', 'Heuristic, not a verdict — for human review only.'));
    if (analysis.signals.length === 0) {
      lines.push('No analysis signals.');
    } else {
      const pct = (analysis.reviewPriority * 100).toFixed(0);
      lines.push(`Review priority: ${pct}%`);
      for (const s of analysis.signals) {
        const tag =
          s.severity === 'review'
            ? c('yellow', 'REVIEW')
            : s.severity === 'notice'
              ? c('yellow', 'NOTICE')
              : c('dim', 'INFO');
        // signal の文言は proof 由来に加え、外部 `--analyzer` (ADR-0023) の出力も入る = 未信頼。
        lines.push(`  [${tag}] ${safe(s.dimension)}: ${safe(s.summary)}`);
        // 証拠リンク (ADR-0009 で必須): 人間が当該イベントを検分できるよう event index を出す。
        for (const ev of s.evidence) {
          const range =
            ev.toEventIndex !== undefined && ev.toEventIndex !== ev.fromEventIndex
              ? `events ${ev.fromEventIndex}–${ev.toEventIndex}`
              : `event ${ev.fromEventIndex}`;
          lines.push(c('dim', `      evidence: ${range}${ev.note ? ` (${safe(ev.note)})` : ''}`));
        }
      }
    }
  }

  lines.push('');

  return lines.join('\n');
}

/**
 * ZIP 内の proof ごとの見出し (複数 proof のときだけ出る)。
 *
 * ファイル名は **ZIP エントリ名** = 攻撃者が自由に決められる文字列 (#266)。整形を `cli.ts` の
 * `console.log` に置いたままだとテストを当てられないので、出力の組み立てはここに寄せる。
 */
export function formatProofHeader(filename: string): string {
  return `\n=== ${safe(filename)} ===`;
}

/**
 * 複数 proof の合否一覧。
 *
 * 採点運用はこの `✓` 行を grep する。エントリ名に改行を仕込まれても**行数が entries.length + 1
 * のまま**であることが不変条件で、`output.test.ts` がそれを固定する (#266)。
 */
export function formatMultiSummary(entries: ReadonlyArray<{ filename: string; valid: boolean }>): string {
  const passed = entries.filter((e) => e.valid).length;
  const lines = [`\n=== Summary: ${passed}/${entries.length} proofs passed ===`];
  for (const e of entries) {
    lines.push(`  ${e.valid ? '✓' : '✗'} ${safe(e.filename)}`);
  }
  return lines.join('\n');
}

export function printError(message: string): void {
  console.error(c('red', `Error: ${message}`));
}

export function printUsage(): void {
  console.log(`
${c('bold', 'typedcode-verify')} - Verify TypedCode proof files

${c('cyan', 'Usage:')}
  typedcode-verify <file.json|file.zip> [--mode <fast|audit|full>]
                   [--exam-package <file.tcexam>] [--submitted-at <ISO>]
                   [--require-anchor-density] [--require-root-anchor]
                   [--analysis-json <out.json>] [--analysis-bundle <out.json>]
                   [--analyzer <module>]... [--no-default-analyzers]

${c('cyan', 'Arguments:')}
  file    Path to proof file (.json) or exported archive (.zip)

${c('cyan', 'Options:')}
  --mode           Verification mode (default: full)
                   fast  - Skip PoSW recompute (tamper resistance only)
                   audit - unimplemented; currently equivalent to full (spec 6.1)
                   full  - Full PoSW verification
  --exam-package   Exam mode (ADR-0006): sealed problem package (.tcexam) to fully
                   verify the binding (signature, package hash, decrypted content).
                   Without it, only the self-contained exam root binding is checked.
  --submitted-at   Exam mode: submission timestamp (ISO 8601, e.g. Moodle submit time)
                   to evaluate the [releaseTime, deadline] time-box.
  --require-anchor-density
                   Fail (exit 1) when signed checkpoints are too sparse for the claimed
                   session (ADR-0016) — e.g. a single end checkpoint anchoring a long
                   chain. Off by default (sparse anchoring is only a warning).
  --require-root-anchor
                   Fail (exit 1) when the chain root is not server-anchored (ADR-0017) —
                   i.e. no session start token (offline/degraded or old proof). Off by
                   default (unanchored root is only a warning). Exam proofs are exempt
                   ONLY when their binding is verified via --exam-package (#131); a
                   self-declared exam block alone does not bypass the gate.
  --analysis-json  Write the advisory analysis report (ADR-0009) for every verified
                   proof to the given file as JSON, for aggregation / evaluation
                   tooling. Advisory only — never affects the exit code.
  --analysis-bundle
                   Write the Tier A analysis bundle (ADR-0024) for every proof:
                   content-free { processSummary, analysis, assurance } with NO
                   events / source / fingerprint. The input format for cohort
                   baselines (ADR-0025). Advisory — never affects the exit code.
  --analyzer       Load a custom analyzer (ADR-0009 / platform): an ES module that
                   exports a default / "analyzer" / "analyzers" Analyzer. Repeatable.
                   Runs alongside the built-in analyzers. Lets graders/researchers plug
                   their own analysis methods without forking. Advisory — never affects
                   the exit code.
  --no-default-analyzers
                   Disable the built-in analyzers and run only the --analyzer ones.

${c('cyan', 'Examples:')}
  typedcode-verify proof.json
  typedcode-verify my-code.zip --mode fast
  typedcode-verify ALL_TC.zip --exam-package p1.tcexam
  typedcode-verify ALL_TC.zip --exam-package p1.tcexam --submitted-at 2026-06-06T01:00:00Z
  typedcode-verify proof.json --analyzer ./my-analyzer.mjs --analysis-json out.json

${c('cyan', 'Exit codes:')}
  0 - Verification passed
  1 - Verification failed or error
`);
}
