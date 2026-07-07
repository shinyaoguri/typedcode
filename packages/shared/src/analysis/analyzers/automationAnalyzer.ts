/**
 * automation 分析器 (ADR-0009 の最初の本物の分析器)。
 *
 * 合成入力 / 自動化ブラウザの「環境レベルの tell」を見る:
 * - `environmentProbe` イベント (起動時ワンショット, ADR-0007): `navigator.webdriver` /
 *   自動化由来のグローバル痕跡
 * - fingerprint の WebGL renderer: ヘッドレス GPU (SwiftShader 等) の tell
 *
 * 注意 (誠実な限界): これは「自動化ブラウザか」を見るだけで、実ブラウザ + 手動転写
 * (人がAI出力を読んで打ち直す) は捕まえられない。それは別次元の分析器の仕事。
 * 出力は advisory signal のみ — 判定はしない (ADR-0009)。
 */

import type { AnalysisInput, AnalysisSignal, Analyzer } from '../types.js';
import type { EnvironmentProbeData, KeystrokeDynamicsData } from '../../types/events.js';

const ID = 'automation';

/** ヘッドレス / ソフトウェアレンダラの代表的な renderer 文字列。 */
const HEADLESS_RENDERER_RE = /swiftshader|llvmpipe|mesa offscreen/i;

export const automationAnalyzer: Analyzer = {
  id: ID,
  version: '0.1.0',
  analyze(input: AnalysisInput): AnalysisSignal[] {
    const signals: AnalysisSignal[] = [];
    const events = input.proof.proof.events;

    // 1) environmentProbe イベント: webdriver / 自動化グローバル
    const probeIndex = events.findIndex((e) => e.type === 'environmentProbe');
    if (probeIndex >= 0) {
      // type === 'environmentProbe' のとき data は EnvironmentProbeData。StoredEvent.data は
      // 大きな union で type と紐づかないため絞り込めない → ここで cast する。
      const data = events[probeIndex]!.data as EnvironmentProbeData | null;
      if (data) {
        if (data.webdriver === true) {
          signals.push({
            analyzerId: ID,
            dimension: 'automation',
            score: 0.9,
            confidence: 0.9,
            severity: 'review',
            evidence: [{ fromEventIndex: probeIndex, note: 'navigator.webdriver = true' }],
            summary: 'Automation flag present: navigator.webdriver = true',
          });
        }
        if (data.automationGlobals.length > 0) {
          const names = data.automationGlobals.join(', ');
          signals.push({
            analyzerId: ID,
            dimension: 'automation',
            score: 0.85,
            confidence: 0.8,
            severity: 'review',
            evidence: [{ fromEventIndex: probeIndex, note: names }],
            summary: `Automation globals detected: ${names}`,
          });
        }
      }
    }

    // 1.5) untrusted な合成打鍵 (ADR-0018)。keyDown/keyUp の data.isTrusted === false を数える。
    // = 拡張 / ページスクリプトが dispatch した KeyboardEvent。isTrusted は keystroke event の data
    // 経由で hash chain に焼かれるため改ざん耐性がある。**限界**: CDP / ハード注入は isTrusted=true で
    // 捕捉できない (部分的・advisory)。
    let untrustedKeystrokes = 0;
    let firstUntrustedIndex = -1;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      if (ev.type !== 'keyDown' && ev.type !== 'keyUp') continue;
      if ((ev.data as KeystrokeDynamicsData | null)?.isTrusted === false) {
        untrustedKeystrokes++;
        if (firstUntrustedIndex < 0) firstUntrustedIndex = i;
      }
    }
    if (untrustedKeystrokes > 0) {
      signals.push({
        analyzerId: ID,
        dimension: 'automation',
        score: 0.8,
        confidence: 0.85,
        severity: 'review',
        evidence: [
          { fromEventIndex: firstUntrustedIndex, note: `${untrustedKeystrokes} untrusted keystroke event(s)` },
        ],
        summary: `Synthetic (untrusted) keystrokes detected: ${untrustedKeystrokes} event(s) with isTrusted=false`,
      });
    }

    // 2) fingerprint の WebGL renderer (ヘッドレス tell)。重複捕捉せず fingerprint を読む。
    const renderer = input.proof.fingerprint?.components?.webgl?.unmaskedRenderer;
    if (renderer && HEADLESS_RENDERER_RE.test(renderer)) {
      signals.push({
        analyzerId: ID,
        dimension: 'automation',
        score: 0.5,
        confidence: 0.6,
        severity: 'notice',
        evidence: [],
        summary: `Headless-style GPU renderer: ${renderer}`,
      });
    }

    return signals;
  },
};
