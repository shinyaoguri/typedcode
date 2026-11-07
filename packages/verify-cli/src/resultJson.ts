/**
 * `--result-json` (#588): 検証の結論を機械可読に書き出すための純関数。
 *
 * 「落ちたか」だけでなく「どの検査で落ちたか」を e2e などが assert できるようにする。
 * exit code の体系は変えない (advisory)。shared の検証ロジックには触れず、
 * `FullVerificationResult` が返す各フィールドから導くだけ。
 */

import {
  isProofVersionRejected,
  type AcceptancePolicyViolationCode,
  type ProofVersionStatus,
  type SignedCheckpointsVerificationResult,
  type TemporalLevel,
} from '@typedcode/shared';

/** 最初に落ちた層。valid なら null。 */
export type FailedCheck =
  | 'unreadable'
  | 'version'
  | 'metadata'
  | 'root'
  | 'chain'
  | 'content'
  | 'finalHash'
  | 'checkpoint'
  | 'rootAnchor'
  | 'sessionToken'
  | 'policy'
  // 上のどれにも当たらないのに valid=false のとき (exam 束縛の失敗・スクリーンショット改ざん・提出物の不一致)。
  | 'other';

/** `deriveFailedCheck` の入力。`FullVerificationResult` のフィールド + CLI が足す総合 valid。 */
export interface FailedCheckInput {
  /** CLI の総合 valid (exam 束縛・スクリーンショット・提出物の gate も含む) */
  valid: boolean;
  versionStatus?: ProofVersionStatus;
  metadataValid: boolean;
  rootValid?: boolean;
  chainValid: boolean;
  finalHashValid?: boolean;
  contentValid?: boolean;
  checkpointValid?: boolean;
  /** chain / checkpoint が落ちた index。chain の失敗では必ず付き、finalHash 単独の失敗では付かない */
  errorAt?: number;
  rootAnchorFailure?: unknown;
  sessionTokenMismatch?: boolean;
  signedCheckpoints?: Pick<SignedCheckpointsVerificationResult, 'anchored' | 'valid'>;
  policyViolationCodes: readonly string[];
}

/**
 * 最初に落ちた層を返す。**優先順位は `verifyProofFile` が `errorMessage` に採る順と同じ**
 * (shared/src/verification.ts の `verificationError`)。人が読む Error 行と機械可読の結論が食い違わないため。
 *
 *  1. version        バージョンゲート (tooOld / malformed)。`errorMessage` の先頭
 *  2. root           root の不一致 (fingerprint / nonce / deviceId / 初期ハッシュ)。metadata の一部だが、より具体的。
 *                    nonce の書き換えは typingProofHash も壊すため `errorMessage` は先にハッシュ不一致の文言を出すが、
 *                    落ちた層としてはより具体的な root を返す
 *     metadata       typingProofHash・イベント由来のメタデータ (totalEvents など)・欠落。root が通っているときだけ。
 *                    イベントの複製・削除は totalEvents の不一致でここで落ちる (chain / finalHash より前に評価される)
 *  3. chain          ハッシュチェーン (previousHash / hash / sequence / PoSW)。`errorAt` が付く
 *     finalHash      最終ハッシュの不一致 (チェーンは通る。末尾の切り詰めなど)
 *     checkpoint     ハッシュチェーン上の checkpoint の不一致
 *     content        イベントを再生した内容と proof.content の不一致
 *  4. rootAnchor     token を検証できない (#329。改ざんではなく時刻アンカー層の失敗)
 *  5. sessionToken   token と署名 cp の sessionId の不一致
 *     checkpoint     署名 cp の検証失敗 (anchored なのに invalid)
 *  6. policy         受理ポリシー (`--require-*`) の違反。整合性が通ったときだけ評価される
 *  7. other          上のどれでもないのに valid=false (exam 束縛・スクリーンショット・提出物)
 *
 * 既知の限界 (shared を変えずに導くための割り切り):
 * - chain と finalHash: `finalHashValid` はチェーンが落ちたときも false になる。`errorAt` の有無で分け、
 *   finalHash 単独の失敗と checkpoint の失敗が同時に起きて `errorAt` が付いたときは 'chain' と読む。
 * - 'root' と metadata 欠落: メタデータが丸ごと無い proof も `rootValid` が false で 'root' になる。
 */
export function deriveFailedCheck(input: FailedCheckInput): Exclude<FailedCheck, 'unreadable'> | null {
  if (input.valid) return null;

  if (input.versionStatus !== undefined && isProofVersionRejected(input.versionStatus)) return 'version';

  if (!input.metadataValid) return input.rootValid === false ? 'root' : 'metadata';

  if (!input.chainValid) {
    if (input.finalHashValid === false) return input.errorAt !== undefined ? 'chain' : 'finalHash';
    if (input.checkpointValid === false) return 'checkpoint';
    if (input.contentValid === false) return 'content';
    // chainValid が false なのにどの下位検査も false でない: chain の失敗と読む (フィールドの食い違い)
    return 'chain';
  }

  if (input.rootAnchorFailure) return 'rootAnchor';
  if (input.sessionTokenMismatch) return 'sessionToken';
  if (input.signedCheckpoints?.anchored && !input.signedCheckpoints.valid) return 'checkpoint';
  if (input.policyViolationCodes.length > 0) return 'policy';
  return 'other';
}

/** `--result-json` の 1 要素 */
export interface ResultJsonEntry {
  filename: string;
  valid: boolean;
  /** shared の `integrityValid` (受理ポリシー・CLI の gate を足す前の結論)。読めなかった入力は false */
  integrityValid: boolean;
  failedCheck: FailedCheck | null;
  errorMessage: string | null;
  rootAnchored: boolean;
  /** 三層保証 (`deriveAssurance`) の temporal。検証できなかった入力は null */
  temporal: TemporalLevel | null;
  policyViolations: AcceptancePolicyViolationCode[];
}

/** 読めなかった入力 (ZIP 内の壊れた proof・拡張子違い・検証中の例外) */
export function unreadableResultEntry(filename: string, reason: string): ResultJsonEntry {
  return {
    filename,
    valid: false,
    integrityValid: false,
    failedCheck: 'unreadable',
    errorMessage: reason,
    rootAnchored: false,
    temporal: null,
    policyViolations: [],
  };
}
