/**
 * 削除イベントに乗った未署名 cp (contentHash: '') を含む proof を CLI が通す (#571)。
 *
 * editor は contentHash が空の cp を署名に回さなくなったので、提出される proof には削除に乗った
 * 未署名 cp がそのまま残る。proof の形式と検証器は変えていないので、CLI は従来どおり exit 0 で通す。
 *
 * exportProof は最終イベントに cp が無ければ強制的に作るので、最後のイベントを削除にすれば
 * 削除に乗った cp ができる。CLI は既定の `--mode full` で PoSW を再計算するので、`postMessage` が
 * throw する Worker を渡して PoswManager の main-thread fallback で本物の PoSW を計算させる
 * (`fixtures/proofs/generate-valid.mts` と同じ方法)。
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { TypingProof, computeHash, type ExportedProof, type FingerprintComponents } from '@typedcode/shared';
import { runSourceCli } from './helpers/runCli.js';

/** `postMessage` が throw する Worker。PoswManager が main-thread の実 PoSW に落ちる。 */
class FailingWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage(): void {
    throw new Error('no worker in Node');
  }
  terminate(): void {}
}

const components: FingerprintComponents = {
  userAgent: 'TypedCode verify-cli empty contentHash checkpoint test',
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

/** [挿入 'a', 挿入 'b', 削除] を記録して export した proof (最終イベントが削除)。 */
async function exportProofEndingWithDeletion(): Promise<{ exported: ExportedProof; content: string }> {
  const fingerprintHash = await computeHash(JSON.stringify(components, null, 0));
  const proof = new TypingProof();
  // fallback 時の console.warn はテストの出力として不要なので黙らせる
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await proof.initialize(fingerprintHash, components, new FailingWorker() as unknown as Worker);
    let content = '';
    for (const ch of 'ab') {
      await proof.recordEvent({
        type: 'contentChange',
        inputType: 'insertText',
        data: ch,
        rangeOffset: content.length,
        rangeLength: 0,
      });
      content += ch;
    }
    await proof.recordEvent({
      type: 'contentChange',
      inputType: 'deleteContentBackward',
      data: '',
      rangeOffset: content.length - 1,
      rangeLength: 1,
    });
    content = content.slice(0, -1);
    return { exported: await proof.exportProof(content), content };
  } finally {
    console.warn = originalWarn;
  }
}

let exported: ExportedProof;
let proofPath: string;

beforeAll(async () => {
  const built = await exportProofEndingWithDeletion();
  exported = built.exported;
  proofPath = join(mkdtempSync(join(tmpdir(), 'tc-verify-cli-571-')), 'deletion_proof.json');
  writeFileSync(
    proofPath,
    JSON.stringify({
      ...exported,
      mode: 'casual',
      filename: 'deletion',
      content: built.content,
      language: 'javascript',
    }),
    'utf-8'
  );
}, 60_000);

describe('unsigned checkpoint on a deletion event (#571)', () => {
  it('exports an unsigned checkpoint with an empty contentHash on the final deletion event', () => {
    const lastIndex = exported.proof.events.length - 1;
    expect(exported.proof.events[lastIndex]!.inputType).toBe('deleteContentBackward');
    const deletionCheckpoint = (exported.checkpoints ?? []).find((cp) => cp.eventIndex === lastIndex);
    expect(deletionCheckpoint?.contentHash).toBe('');
    expect(deletionCheckpoint?.signature).toBeUndefined();
  });

  it('verifies a proof carrying an unsigned checkpoint on a deletion event and exits 0', () => {
    const res = runSourceCli([proofPath]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/^Hash Chain: {2}PASS$/m);
  }, 60_000);
});
