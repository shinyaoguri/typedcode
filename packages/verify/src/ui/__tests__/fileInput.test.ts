// @vitest-environment happy-dom
/**
 * ファイル選択ダイアログ (`#file-input`, `multiple`) の取り込み。
 *
 * 以前は WelcomePanel と AppController が同じ change を二重購読し、先に走った側が `value` を
 * 空にすることで後の側が空振りする、という順序依存で二重処理を免れていた。購読は
 * `bindFileInput` の 1 か所に限ったので、その振る舞いと「1 か所だけ」をここで固定する。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bindFileInput, processFilesInOrder } from '../fileInput.js';
import { mountVerifyIndexHtml, setInputFiles } from './verifyDom.js';

function fileInput(): HTMLInputElement {
  return document.getElementById('file-input') as HTMLInputElement;
}

function proof(name: string): File {
  return new File(['{}'], name, { type: 'application/json' });
}

beforeEach(() => {
  mountVerifyIndexHtml();
});

describe('#file-input markup', () => {
  it('lets the user pick several proofs at once', () => {
    expect(fileInput().multiple).toBe(true);
  });
});

describe('bindFileInput', () => {
  it('hands every selected file to the handler exactly once, in selection order', () => {
    const onFiles = vi.fn();
    bindFileInput(fileInput(), onFiles);

    setInputFiles(fileInput(), [proof('a_proof.json'), proof('b_proof.json')]);
    fileInput().dispatchEvent(new Event('change'));

    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles.mock.calls[0]?.[0].map((f: File) => f.name)).toEqual(['a_proof.json', 'b_proof.json']);
  });

  it('keeps the handed-over files after clearing the input for the next selection', () => {
    const onFiles = vi.fn();
    bindFileInput(fileInput(), onFiles);

    setInputFiles(fileInput(), [proof('a_proof.json')]);
    fileInput().dispatchEvent(new Event('change'));

    expect(fileInput().files?.length ?? 0).toBe(0);
    expect(onFiles.mock.calls[0]?.[0]).toHaveLength(1);
  });

  it('ignores a change that carries no files (dialog cancelled)', () => {
    const onFiles = vi.fn();
    bindFileInput(fileInput(), onFiles);

    fileInput().dispatchEvent(new Event('change'));

    expect(onFiles).not.toHaveBeenCalled();
  });
});

describe('processFilesInOrder', () => {
  it('does not start the next file until the previous one has finished', async () => {
    const log: string[] = [];
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const run = processFilesInOrder([proof('a'), proof('b')], async (file) => {
      log.push(`start ${file.name}`);
      if (file.name === 'a') await firstDone;
      log.push(`end ${file.name}`);
    });
    await Promise.resolve();
    expect(log).toEqual(['start a']);

    releaseFirst();
    await run;
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b']);
  });
});

/** 走査対象はこのパッケージの `src/` (テストファイル位置から解決し、cwd に依存しない)。 */
const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__') continue;
      out.push(...collectSourceFiles(full));
    } else if (name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('#file-input subscription policy', () => {
  it('is looked up by exactly one source file so its change event is handled once', () => {
    const owners = collectSourceFiles(SRC_ROOT)
      .filter((file) => /['"]file-input['"]/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC_ROOT, file));

    expect(owners).toEqual(['ui/AppController.ts']);
  });
});
