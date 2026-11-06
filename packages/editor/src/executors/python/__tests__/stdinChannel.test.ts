/**
 * Python の stdin のチャネル (#649)。メインが書き、Worker が `Atomics.wait` で待って読む。
 *
 * テストは 1 つのスレッドで書き手と読み手を動かす。読み手が待つ場面は、onWait (Worker が
 * `stdin-request` を送るところ) で書き手が offer することで表す。
 */

import { describe, it, expect } from 'vitest';
import { StdinChannelReader, StdinChannelWriter, createStdinBuffer } from '../stdinChannel.js';

const decode = (chunks: Uint8Array[]): string => {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(all);
};

function channel(capacity?: number) {
  const buffer = createStdinBuffer(capacity);
  return { writer: new StdinChannelWriter(buffer), reader: new StdinChannelReader(buffer) };
}

/** 書き手が貯めた入力を、読み手が求めるたびに渡して、全部読み切るまでの断片を返す */
function drain(writer: StdinChannelWriter, reader: StdinChannelReader): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  while (writer.pendingBytes > 0) chunks.push(reader.read(() => writer.offer()));
  return chunks;
}

describe('stdin channel', () => {
  it('delivers a pushed line to the reader as its UTF-8 bytes', () => {
    const { writer, reader } = channel();
    writer.push('3 5\n');
    expect(writer.offer()).toBe(true);
    expect(decode([reader.read()])).toBe('3 5\n');
  });

  it('keeps lines typed before the reader asks and delivers them in order', () => {
    const { writer, reader } = channel(4);
    writer.push('a\n');
    writer.push('bc\n');
    writer.push('d\n');
    expect(drain(writer, reader).map((c) => decode([c]))).toEqual(['a\nbc', '\nd\n']);
  });

  it('does not overwrite a chunk the reader has not read yet', () => {
    const { writer, reader } = channel();
    writer.push('first\n');
    expect(writer.offer()).toBe(true);
    writer.push('second\n');
    expect(writer.offer()).toBe(false);
    expect(decode([reader.read()])).toBe('first\n');
    expect(decode([reader.read(() => writer.offer())])).toBe('second\n');
  });

  it('splits a line longer than the data area into chunks that join back to the original', () => {
    const { writer, reader } = channel(4);
    writer.push('abcdefghij\n');
    const chunks = drain(writer, reader);
    expect(chunks.map((c) => c.length)).toEqual([4, 4, 3]);
    expect(decode(chunks)).toBe('abcdefghij\n');
  });

  it('restores multibyte characters split across chunks', () => {
    const { writer, reader } = channel(5);
    writer.push('名前は太郎\n');
    const chunks = drain(writer, reader);
    expect(chunks.length).toBeGreaterThan(1);
    expect(decode(chunks)).toBe('名前は太郎\n');
  });

  it('asks the writer only when there is nothing to read', () => {
    const { writer, reader } = channel();
    writer.push('x\n');
    writer.offer();
    let asked = 0;
    reader.read(() => asked++);
    expect(asked).toBe(0);
    writer.push('y\n');
    reader.read(() => {
      asked++;
      writer.offer();
    });
    expect(asked).toBe(1);
  });
});
