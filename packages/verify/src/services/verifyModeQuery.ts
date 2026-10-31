/**
 * 検証モードの初期値を URL クエリ `?mode=fast|audit|full` から決める (E2E 用。ADR-0034)。
 *
 * 既定は `full` (PoSW を全反復で再計算する。spec §8.2)。クエリはあくまで初期値の上書きで、
 * 読み込み後は ActivityBar のボタンで従来どおり切り替えられる。値は allowlist で照合し、
 * 不正値・未指定は既定に戻す (URL は誰でも細工できるので、未知の値を検証キューへ流さない)。
 */
import type { VerificationMode } from '../types';

export const DEFAULT_VERIFY_MODE: VerificationMode = 'full';

const VERIFY_MODES: readonly VerificationMode[] = ['fast', 'audit', 'full'];

function isVerificationMode(value: string): value is VerificationMode {
  return (VERIFY_MODES as readonly string[]).includes(value);
}

/** `location.search` (先頭の `?` は有っても無くてもよい) から初期の検証モードを返す。 */
export function resolveInitialVerifyMode(search: string): VerificationMode {
  const raw = new URLSearchParams(search).get('mode');
  return raw !== null && isVerificationMode(raw) ? raw : DEFAULT_VERIFY_MODE;
}
