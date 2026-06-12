/**
 * 合成 proof フィクスチャ生成器 (GEN_FIXTURES=1 のときだけ動く。通常の test:run では skip)。
 *
 * 実際の TypingProof で「現実的なセッション」を脚本どおりに演じ、検証可能な proof JSON を
 * 吐く。performance.now をモンキーパッチして停止・バースト・デバッグサイクル等のタイムラインを
 * 数百 ms で再現する。**手打ち不要で動作検証/UI レビューを自動化する土台**:
 *   GEN_FIXTURES=1 npx vitest run genFixtureProof -w @typedcode/shared
 *   → /tmp/typedcode-fixtures/messy_session_proof.json
 * これを verify-cli の golden テストや verify(web) の Playwright スモークに食わせる。
 *
 * 注意: PoSW はテスト環境のモック値なので **fast モード検証専用**。full モードは PoSW
 * 再計算で落ちる (実 PoSW を焼くには本物の poswWorker 経路が要る)。
 */

import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { TypingProof, computeHash, verifyProofFile } from '../index.js';
import type { FingerprintComponents } from '../types.js';

const components: FingerprintComponents = {
  userAgent: 'Mozilla/5.0 (Fixture Session)',
  language: 'ja',
  languages: ['ja', 'en'],
  platform: 'FixtureOS',
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
  canvas: 'fixture-canvas',
  webgl: { vendor: 'Fixture Vendor', renderer: 'Fixture Renderer' },
  fonts: ['Arial'],
  cookieEnabled: true,
  doNotTrack: 'unspecified',
  maxTouchPoints: 0,
};

describe.runIf(process.env['GEN_FIXTURES'] === '1')('generate fixture proofs', () => {
  it('generates a realistic messy session proof', async () => {
    // 仮想時計
    let now = 0;
    const realNow = performance.now.bind(performance);
    // eslint-disable-next-line no-global-assign
    performance.now = () => now;

    try {
      const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));
      const proof = new TypingProof();
      await proof.initialize(fingerprintHash, components);

      let content = '';
      const type = async (text: string, msPerChar = 120): Promise<void> => {
        for (const ch of text) {
          now += msPerChar + (ch.charCodeAt(0) % 70); // 決定的なゆらぎ
          await proof.recordEvent({
            type: 'contentChange',
            inputType: 'insertText',
            data: ch,
            rangeOffset: content.length,
            rangeLength: 0,
          });
          content += ch;
        }
      };
      const deleteChars = async (n: number): Promise<void> => {
        for (let i = 0; i < n; i++) {
          now += 90;
          await proof.recordEvent({
            type: 'contentChange',
            inputType: 'deleteContentBackward',
            data: '',
            rangeOffset: content.length - 1,
            rangeLength: 1,
          });
          content = content.slice(0, -1);
        }
      };
      const run = async (outcome: 'success' | 'failure', exitCode: number): Promise<void> => {
        now += 800;
        await proof.recordEvent({
          type: 'codeExecution',
          data: { phase: 'start', filename: 'main.c', language: 'c' },
          description: 'main.c を実行',
        });
        now += 1500;
        await proof.recordEvent({
          type: 'codeExecution',
          data: { phase: 'result', filename: 'main.c', language: 'c', outcome, exitCode, elapsedMs: 1500 },
          description: `main.c: ${outcome} (exit ${exitCode})`,
        });
      };

      // --- セッションの脚本 ---
      await type('#include <stdio.h>\n\nint main(void) {\n');
      now += 18_000; // 考え中 (長い停止)
      await type('  printf("hello world")\n  return 0;\n}\n');
      await run('failure', 1); // セミコロン忘れで失敗
      now += 4_000;
      await deleteChars(20);
      await type('");\n  return 0;\n}\n'); // 修正
      await run('success', 0); // 失敗からの初成功

      // 離脱 → 復帰 → バースト
      now += 1_000;
      await proof.recordEvent({ type: 'focusChange', data: { focused: false } });
      now += 45_000;
      await proof.recordEvent({ type: 'focusChange', data: { focused: true } });
      await type('// add a comment that is long enough to look like a paste burst after refocus!!\n', 25);

      // 外部ペースト (禁止 InputType)
      now += 2_000;
      const pasted = '/* pasted from somewhere */\n';
      await proof.recordEvent({
        type: 'contentChange',
        inputType: 'insertFromPaste',
        data: pasted,
        rangeOffset: content.length,
        rangeLength: 0,
      });
      content += pasted;

      // 振り返りノート (ADR-0022)
      now += 5_000;
      await proof.recordEvent({
        type: 'reflectionNote',
        data: { text: 'セミコロン忘れでコンパイルエラー。エラーメッセージの行番号の読み方を覚えた。' },
      });

      const exported = await proof.exportProof(content);

      // 自己検証 (fast: PoSW 再計算スキップ)
      const result = await verifyProofFile(
        { ...exported, content, language: 'c' } as never,
        undefined,
        { mode: 'fast' }
      );
      expect(result.chainValid).toBe(true);
      expect(result.metadataValid).toBe(true);

      mkdirSync('/tmp/typedcode-fixtures', { recursive: true });
      writeFileSync(
        '/tmp/typedcode-fixtures/messy_session_proof.json',
        JSON.stringify({ ...exported, content, language: 'c' }, null, 2)
      );
      console.log('events:', exported.proof.totalEvents, '→ /tmp/typedcode-fixtures/messy_session_proof.json');
    } finally {
      performance.now = realNow;
    }
  }, 120_000);
});
