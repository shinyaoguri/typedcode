/**
 * E2E 用の偽の非対話の実行の入口 (#799)。dev フック (`workspace/devWorkspaceHook.ts`) だけが使い、本番ビルドには
 * 入らない (フックは `authorMain.ts` の `import.meta.env.DEV` ガードの中で dynamic import される)。
 *
 * PR ごとの E2E は実物のコンパイラを使わないので、与えた対応表 (ファイル名と stdin → 結果) どおりに結果を返す。
 * `hang: true` の行は、中止 (signal) されるまで終わらない (実行中のまま止まったコンパイルや無限ループの代役)。
 * 対応表に無い呼び出しは `runtime-error` にし、stderr に理由を書く。呼ばれた順の記録を返す (中止の後に残りが
 * 走っていないことを確かめるため)。値は `page.evaluate` で渡せる形 (プレーンなオブジェクト) に限る。
 */

import type {
  NonInteractiveOutcome,
  NonInteractiveRequest,
  NonInteractiveResult,
  NonInteractiveRunner,
} from '../../executors/nonInteractive/runNonInteractive.js';

/** 対応表の 1 行 */
export interface FakeVerificationEntry {
  /** 解答例のファイル名 (basename) */
  filename: string;
  /** 省略すると、そのファイル名のどの stdin にも当てる */
  stdin?: string;
  outcome?: Exclude<NonInteractiveOutcome, 'aborted'>;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  /** 中止されるまで終わらない */
  hang?: boolean;
}

export interface FakeVerificationRunner {
  run: NonInteractiveRunner;
  /** 呼ばれた順の (ファイル名, stdin) */
  calls(): { filename: string; stdin: string }[];
}

function aborted(): NonInteractiveResult {
  return { stdout: '', stderr: '', outcome: 'aborted', exitCode: null };
}

/** 対応表から偽の入口を作る */
export function createFakeVerificationRunner(entries: readonly FakeVerificationEntry[]): FakeVerificationRunner {
  const calls: { filename: string; stdin: string }[] = [];
  const find = (request: NonInteractiveRequest): FakeVerificationEntry | undefined =>
    entries.find(
      (entry) => entry.filename === request.filename && (entry.stdin === undefined || entry.stdin === request.stdin)
    );

  const run: NonInteractiveRunner = async (request, options = {}) => {
    const { signal } = options;
    calls.push({ filename: request.filename, stdin: request.stdin });
    if (signal?.aborted) return aborted();
    const entry = find(request);
    if (!entry) {
      return {
        stdout: '',
        stderr: `[fake] no entry for ${request.filename}`,
        outcome: 'runtime-error',
        exitCode: null,
      };
    }
    if (entry.hang) {
      return new Promise<NonInteractiveResult>((resolve) => {
        signal?.addEventListener('abort', () => resolve(aborted()), { once: true });
      });
    }
    const outcome = entry.outcome ?? 'success';
    return {
      stdout: entry.stdout ?? '',
      stderr: entry.stderr ?? '',
      outcome,
      exitCode: entry.exitCode !== undefined ? entry.exitCode : outcome === 'success' ? 0 : null,
    };
  };

  return { run, calls: () => calls.map((call) => ({ ...call })) };
}
