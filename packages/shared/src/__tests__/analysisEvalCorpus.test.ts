/**
 * 分析器 実証評価のコーパスランナー (W5, ADR-0009)。
 *
 * 1) 常時 (環境変数なし) — **合成ラベル付きコーパス**を脚本生成し、手打ち無しでパイプライン
 *    (proof → runAnalysis → evaluateAnalysis) をメモリ上で端から端まで動かして、回帰 assert
 *    (`genuine-clean` は signal 0、ai-paste / transcribe / synthetic-keys / webdriver /
 *    genuine-think-burst が期待の次元を踏む) を確かめる。通常の test:run と CI で走る (#594)。
 *    GEN_FIXTURES=1 を付けると、同じコーパスの proof 群・labels.json と評価レポートを
 *    /tmp/typedcode-fixtures/ にも書き出す (EVAL_CORPUS への入力や検分用)。
 *      cd packages/shared && GEN_FIXTURES=1 npx vitest run analysisEvalCorpus
 *    注意: これは **合成データであり実証の代替ではない** (人間の打鍵分布を模していない)。
 *    本番のしきい値判断は EVAL_CORPUS で実データを食わせること。
 *
 * 2) EVAL_CORPUS=<dir> (gate 付き) — **実データ評価**。<dir>/labels.json (収集プロトコル参照) と
 *    そこに並ぶ proof JSON を読み、同じ集計を回してレポートを書く。
 *      cd packages/shared && EVAL_CORPUS=/path/to/corpus npx vitest run analysisEvalCorpus
 *
 * 収集手順・倫理・ラベル定義: docs/analysis-eval-protocol.md
 *
 * PoSW はテスト環境のモック値 → **fast 検証専用** (full は PoSW 再計算で落ちる)。
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TypingProof, computeHash, verifyProofFile, runAnalysis } from '../index.js';
import { evaluateAnalysis, formatEvalReportMarkdown } from '../analysis/eval.js';
import type { EvalLabel, EvalReport, LabeledAnalysis } from '../analysis/eval.js';
import type { AnalysisReport } from '../analysis/types.js';
import type { FingerprintComponents } from '../types.js';

const OUT_DIR = '/tmp/typedcode-fixtures';

function baseComponents(): FingerprintComponents {
  return {
    userAgent: 'Mozilla/5.0 (Eval Corpus)',
    language: 'ja',
    languages: ['ja', 'en'],
    platform: 'EvalOS',
    hardwareConcurrency: 8,
    deviceMemory: 16,
    screen: {
      width: 1920,
      height: 1080,
      availWidth: 1920,
      availHeight: 1040,
      colorDepth: 24,
      pixelDepth: 24,
      devicePixelRatio: 1,
    },
    timezone: 'Asia/Tokyo',
    timezoneOffset: -540,
    canvas: 'eval-canvas',
    webgl: { vendor: 'Eval Vendor', renderer: 'Eval Renderer' },
    fonts: ['Arial'],
    cookieEnabled: true,
    doNotTrack: 'unspecified',
    maxTouchPoints: 0,
  };
}

/** 仮想時計で 1 セッションを脚本生成し、検証可能な exported proof を返す小さなビルダ。 */
interface Session {
  type(text: string, msPerChar?: number): Promise<void>;
  del(n: number): Promise<void>;
  wait(ms: number): void;
  blur(): Promise<void>;
  focus(): Promise<void>;
  keystroke(key: string, isTrusted: boolean): Promise<void>;
  probe(data: { webdriver: boolean | null; automationGlobals: string[] }): Promise<void>;
  paste(text: string): Promise<void>;
  finish(): Promise<{ proof: unknown }>;
}

async function buildSession(components: FingerprintComponents): Promise<Session> {
  // セッションはローカル仮想時計を所有する。TypingProof は内部で performance.now() を
  // 呼んで timestamp を焼くので、ここで差し替えないと停止/バーストの時系列を再現できない。
  // finish() で必ず元に戻す (セッションは逐次・await されるので入れ子にはならない)。
  let now = 0;
  const realNow = performance.now.bind(performance);
  // eslint-disable-next-line no-global-assign
  performance.now = () => now;

  let content = '';
  const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));
  const proof = new TypingProof();
  await proof.initialize(fingerprintHash, components);

  return {
    async type(text, msPerChar = 110) {
      for (const ch of text) {
        now += msPerChar + (ch.charCodeAt(0) % 40);
        await proof.recordEvent({
          type: 'contentChange',
          inputType: 'insertText',
          data: ch,
          rangeOffset: content.length,
          rangeLength: 0,
          insertLength: ch.length,
        });
        content += ch;
      }
    },
    async del(n) {
      for (let i = 0; i < n; i++) {
        now += 80;
        await proof.recordEvent({
          type: 'contentChange',
          inputType: 'deleteContentBackward',
          data: '',
          rangeOffset: Math.max(0, content.length - 1),
          rangeLength: 1,
        });
        content = content.slice(0, -1);
      }
    },
    wait(ms) {
      now += ms;
    },
    async blur() {
      await proof.recordEvent({ type: 'focusChange', data: { focused: false } });
    },
    async focus() {
      await proof.recordEvent({ type: 'focusChange', data: { focused: true } });
    },
    async keystroke(key, isTrusted) {
      now += 90;
      const modifiers = { shift: false, ctrl: false, alt: false, meta: false };
      await proof.recordEvent({
        type: 'keyDown',
        data: isTrusted
          ? { key, code: `Key${key.toUpperCase()}`, modifiers }
          : { key, code: `Key${key.toUpperCase()}`, modifiers, isTrusted: false },
      });
      now += 40;
      await proof.recordEvent({
        type: 'keyUp',
        data: isTrusted
          ? { key, code: `Key${key.toUpperCase()}`, modifiers }
          : { key, code: `Key${key.toUpperCase()}`, modifiers, isTrusted: false },
      });
    },
    async probe(data) {
      await proof.recordEvent({ type: 'environmentProbe', data: { ...data, editorAssist: null } });
    },
    async paste(text) {
      now += 200;
      await proof.recordEvent({
        type: 'contentChange',
        inputType: 'insertFromPaste',
        data: text,
        rangeOffset: content.length,
        rangeLength: 0,
        insertLength: text.length,
      });
      content += text;
    },
    async finish() {
      const exported = await proof.exportProof(content);
      // eslint-disable-next-line no-global-assign
      performance.now = realNow;
      return { proof: { ...exported, content, language: 'c' } };
    },
  };
}

interface CorpusEntry {
  id: string;
  label: EvalLabel;
  condition: string;
  proof: unknown;
}

/** 合成ラベル付きコーパスを生成する (4 genuine / 4 automated)。 */
async function generateSyntheticCorpus(): Promise<CorpusEntry[]> {
  const entries: CorpusEntry[] = [];

  // --- genuine #1: clean (短く・修正あり・手掛かりゼロ) ---
  {
    const s = await buildSession(baseComponents());
    await s.type('#include <stdio.h>\n\nint main(void) {\n  printf("hi");\n');
    await s.del(4);
    await s.type('hello");\n  return 0;\n}\n');
    entries.push({ id: 'genuine-clean', label: 'genuine', condition: 'genuine-noime', ...(await s.finish()) });
  }

  // --- genuine #2: revising (>100 編集・十分な削除率 → transcription 発火しない) ---
  {
    const s = await buildSession(baseComponents());
    await s.type('// iterative solution with trial and error and several rewrites along the way\n');
    await s.type('int add(int a, int b) {\n  int r = a - b;\n');
    await s.del(8); // 間違いを直す
    await s.type('a + b;\n  return r;\n}\n');
    await s.type('int main(void){ printf("%d", add(2,3)); return 0; }\n');
    await s.del(12);
    await s.type('add(20, 22)); return 0; }\n');
    entries.push({ id: 'genuine-revising', label: 'genuine', condition: 'genuine-noime', ...(await s.finish()) });
  }

  // --- genuine #3: IME っぽい入力 (日本語コメント混じり・修正あり) ---
  {
    const s = await buildSession(baseComponents());
    await s.type('// 二分探索を実装する。境界条件に注意しながら書き直していく。\n');
    await s.type('int bsearch(int* a, int n, int key) {\n  int lo = 0, hi = n;\n');
    await s.del(6);
    await s.type('n - 1;\n  while (lo <= hi) {\n    int mid = (lo + hi) / 2;\n');
    await s.type('    if (a[mid] == key) return mid;\n  }\n  return -1;\n}\n');
    entries.push({ id: 'genuine-ime', label: 'genuine', condition: 'genuine-ime', ...(await s.finish()) });
  }

  // --- genuine #4: think-burst (離席して考え、戻って一気に書く正規ケース) ---
  //     → focus-burst が発火する **正直な偽陽性**。削除を入れて transcription は避ける。
  {
    const s = await buildSession(baseComponents());
    await s.type('int main(void) {\n');
    s.wait(60_000); // 1 分離席して設計を考える
    await s.blur();
    s.wait(60_000);
    await s.focus();
    // 復帰後 20s 窓内に 200+ 文字を高速入力 (考えがまとまって一気に書く)。30ms/char × 240 ≈ 7.2s < 20s。
    await s.type(
      '  // worked out the whole algorithm in my head while away, now i am writing it all at once in one focused burst because the design finally clicked and i can type the full implementation straight through\n  for (int i = 0; i < n; i++) { total += weights[i] * values[i]; }\n',
      30
    );
    await s.del(12);
    await s.type('; return 0;\n}\n', 30);
    entries.push({ id: 'genuine-think-burst', label: 'genuine', condition: 'genuine-noime', ...(await s.finish()) });
  }

  // --- automated #1: AI paste (禁止 InputType → pureTyping 発火) ---
  {
    const s = await buildSession(baseComponents());
    await s.type('// my solution\n');
    await s.paste(
      '#include <stdio.h>\nint main(void){\n  int n; scanf("%d",&n);\n  printf("%d", n*n);\n  return 0;\n}\n'
    );
    entries.push({ id: 'ai-paste', label: 'automated', condition: 'ai-paste', ...(await s.finish()) });
  }

  // --- automated #2: 逐語転写 (>100 編集・削除ほぼ無し → transcription 発火) ---
  {
    const s = await buildSession(baseComponents());
    // AI 出力を見ながら一切間違えずに打ち直す: 修正イベントが出ない。
    await s.type(
      '#include <stdio.h>\n#include <stdlib.h>\nint compare(const void* a, const void* b) {\n  return (*(int*)a - *(int*)b);\n}\nint main(void) {\n  int n; scanf("%d", &n);\n  int* arr = malloc(n * sizeof(int));\n  for (int i = 0; i < n; i++) scanf("%d", &arr[i]);\n  qsort(arr, n, sizeof(int), compare);\n  return 0;\n}\n'
    );
    entries.push({ id: 'transcribe', label: 'automated', condition: 'transcribe-noime', ...(await s.finish()) });
  }

  // --- automated #3: 合成打鍵 (isTrusted=false → automation review) ---
  {
    const s = await buildSession(baseComponents());
    for (const ch of 'int main(){return 0;}') {
      await s.keystroke(ch, false);
      await s.type(ch, 5);
    }
    entries.push({ id: 'synthetic-keys', label: 'automated', condition: 'synthetic-keystroke', ...(await s.finish()) });
  }

  // --- automated #4: 自動化ブラウザ (webdriver + headless GPU → automation review/notice) ---
  {
    const comps = baseComponents();
    comps.webgl = { vendor: 'Google Inc.', renderer: 'ANGLE', unmaskedRenderer: 'Google SwiftShader' };
    const s = await buildSession(comps);
    await s.probe({ webdriver: true, automationGlobals: ['cdc_adoQpoasnfa76pfcZLmcfl_Array', '__playwright'] });
    await s.type('int main(void){ return 0; }\n', 20);
    entries.push({ id: 'webdriver', label: 'automated', condition: 'webdriver-headless', ...(await s.finish()) });
  }

  return entries;
}

interface CorpusEval {
  labeled: LabeledAnalysis[];
  evalReport: EvalReport;
}

/** ラベル付き proof 群をメモリ上で検証 (fast) → 分析 → 評価する。ファイルには何も書かない。 */
async function analyzeCorpus(entries: CorpusEntry[]): Promise<CorpusEval> {
  const labeled: LabeledAnalysis[] = [];
  for (const e of entries) {
    const verification = await verifyProofFile(e.proof as never, undefined, { mode: 'fast' });
    expect(verification.chainValid, `${e.id} chain`).toBe(true);
    const report = await runAnalysis({ proof: e.proof as never, verification });
    labeled.push({ id: e.id, label: e.label, condition: e.condition, report });
  }
  return { labeled, evalReport: evaluateAnalysis(labeled) };
}

/** 生成した proof と labels.json を OUT_DIR/corpus/ に書き、EVAL_CORPUS で再利用・検分できるようにする。 */
function writeCorpus(entries: CorpusEntry[]): void {
  mkdirSync(join(OUT_DIR, 'corpus'), { recursive: true });
  const labels: Record<string, { label: string; condition: string }> = {};
  for (const e of entries) {
    writeFileSync(join(OUT_DIR, 'corpus', `${e.id}.json`), JSON.stringify(e.proof, null, 2));
    labels[`${e.id}.json`] = { label: e.label, condition: e.condition };
  }
  writeFileSync(join(OUT_DIR, 'corpus', 'labels.json'), JSON.stringify(labels, null, 2));
}

/** 評価レポートと個々の signal (診断用) を OUT_DIR に書き、Markdown を stdout に出す。 */
function writeEvalReport({ labeled, evalReport }: CorpusEval): void {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'eval-report.json'), JSON.stringify(evalReport, null, 2));
  writeFileSync(join(OUT_DIR, 'eval-report.md'), formatEvalReportMarkdown(evalReport));
  writeFileSync(
    join(OUT_DIR, 'eval-signals.json'),
    JSON.stringify(
      labeled.map((l) => ({
        id: l.id,
        label: l.label,
        condition: l.condition,
        signals: l.report.signals,
        reviewPriority: l.report.reviewPriority,
      })),
      null,
      2
    )
  );
  console.log(`\n${formatEvalReportMarkdown(evalReport)}\n→ ${OUT_DIR}/eval-report.{json,md}`);
}

// 合成コーパスの回帰 assert は環境変数なしで常に走らせる (#594)。分析器の変更で正規の提出物に
// 出る signal (偽陽性) が増えたら、ここで赤くなる (ADR-0023 の「実測まで review に昇格しない」の前提)。
// 生成・分析はメモリ上だけで行い、ファイルへの書き出しは下の GEN_FIXTURES=1 に分ける。
describe('synthetic analysis-eval corpus', () => {
  let entries: CorpusEntry[];
  let corpus: CorpusEval;
  const report = (id: string): AnalysisReport => {
    const found = corpus.labeled.find((l) => l.id === id);
    if (!found) throw new Error(`corpus has no entry: ${id}`);
    return found.report;
  };
  const dims = (id: string): string[] => report(id).signals.map((s) => s.dimension);

  beforeAll(async () => {
    entries = await generateSyntheticCorpus();
    corpus = await analyzeCorpus(entries);
  }, 120_000);

  // --- 期待される手掛かりの sanity (合成シナリオがアナライザを意図どおり踏むこと) ---
  it('an AI paste raises a transcription-topology signal', () => {
    expect(dims('ai-paste')).toContain('transcription-topology'); // pureTyping (paste)
  });

  it('a verbatim transcription with almost no corrections raises a transcription-topology signal', () => {
    expect(dims('transcribe')).toContain('transcription-topology'); // 低修正率
  });

  it('synthetic keystrokes (isTrusted=false) raise an automation signal', () => {
    expect(dims('synthetic-keys')).toContain('automation');
  });

  it('a webdriver session with automation globals raises an automation signal', () => {
    expect(dims('webdriver')).toContain('automation');
  });

  it('a webdriver session raises at least one review-severity signal', () => {
    expect(report('webdriver').signals.some((s) => s.severity === 'review')).toBe(true);
  });

  it('a genuine think-burst raises focus-burst-correlation as an honest false positive', () => {
    expect(dims('genuine-think-burst')).toContain('focus-burst-correlation');
  });

  it('a clean genuine session raises no signal at all', () => {
    expect(report('genuine-clean').signals).toEqual([]);
  });

  describe.runIf(process.env['GEN_FIXTURES'] === '1')('with GEN_FIXTURES=1', () => {
    it('writes the corpus, labels and eval report to OUT_DIR', () => {
      writeCorpus(entries);
      writeEvalReport(corpus);
    });
  });
});

describe.runIf(typeof process.env['EVAL_CORPUS'] === 'string' && process.env['EVAL_CORPUS'] !== '')(
  'real analysis-eval corpus',
  () => {
    it('reads labeled proofs from EVAL_CORPUS and evaluates them', async () => {
      const dir = process.env['EVAL_CORPUS']!;
      const labels = JSON.parse(readFileSync(join(dir, 'labels.json'), 'utf-8')) as Record<
        string,
        { label: EvalLabel; condition?: string }
      >;
      const entries: CorpusEntry[] = [];
      for (const file of readdirSync(dir)) {
        if (file === 'labels.json' || !file.endsWith('.json')) continue;
        const meta = labels[file];
        if (!meta) {
          console.warn(`skip (no label): ${file}`);
          continue;
        }
        const proof = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
        entries.push({ id: file, label: meta.label, condition: meta.condition ?? '(none)', proof });
      }
      expect(entries.length, 'corpus has labeled proofs').toBeGreaterThan(0);
      writeEvalReport(await analyzeCorpus(entries));
    }, 600_000);
  }
);
