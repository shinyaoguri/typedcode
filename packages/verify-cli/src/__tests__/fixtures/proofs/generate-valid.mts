/**
 * `valid.json` (実 PoSW 付きの有効 proof) を作り直すスクリプト。
 *
 *   npx tsx packages/verify-cli/src/__tests__/fixtures/proofs/generate-valid.mts
 *   npx biome format --write packages/verify-cli/src/__tests__/fixtures/proofs/valid.json
 *
 * (main-thread fallback に落ちるまで Worker 待ちが入るので、生成には数十秒かかる)
 *
 * 子プロセステスト (`cliExitProcess.test.ts` / `distSmoke.test.ts`) は `--mode full` 既定で
 * PoSW を再計算するので、スタブ Worker の固定値ではなく本物の PoSW が要る。Node に Worker は
 * 無いため、`postMessage` が throw する偽 Worker を渡して PoswManager の main-thread
 * fallback で計算させる。proof フォーマットが変わって fixture が通らなくなったら再生成する。
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TypingProof, computeHash, type FingerprintComponents } from '@typedcode/shared';

const OUT = fileURLToPath(new URL('./valid.json', import.meta.url));

const components: FingerprintComponents = {
  userAgent: 'TypedCode verify-cli fixture',
  language: 'en',
  languages: ['en'],
  platform: 'FixtureOS',
  hardwareConcurrency: 4,
  deviceMemory: 8,
  screen: { width: 1, height: 1, availWidth: 1, availHeight: 1, colorDepth: 24, pixelDepth: 24, devicePixelRatio: 1 },
  timezone: 'UTC',
  timezoneOffset: 0,
  canvas: 'fixture',
  webgl: { vendor: 'fixture', renderer: 'fixture' },
  fonts: ['Arial'],
  cookieEnabled: true,
  doNotTrack: 'unspecified',
  maxTouchPoints: 0,
};

/** `postMessage` が throw する Worker。PoswManager が main-thread の実 PoSW に落ちる。 */
class FailingWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage(): void {
    throw new Error('no worker in Node');
  }
  terminate(): void {}
}

const text = 'ok';
const fingerprint = await computeHash(JSON.stringify(components, null, 0));
const proof = new TypingProof();
// fallback 時の console.warn は生成スクリプトの出力として不要なので黙らせる
const originalWarn = console.warn;
console.warn = () => {};
await proof.initialize(fingerprint, components, new FailingWorker() as unknown as Worker);
let content = '';
for (const ch of text) {
  await proof.recordEvent({
    type: 'contentChange',
    inputType: 'insertText',
    data: ch,
    rangeOffset: content.length,
    rangeLength: 0,
  });
  content += ch;
}
const exported = await proof.exportProof(content);
console.warn = originalWarn;

writeFileSync(
  OUT,
  `${JSON.stringify({ ...exported, mode: 'casual', filename: 'valid', content, language: 'javascript' }, null, 2)}\n`
);
console.log(`wrote ${OUT}`);
