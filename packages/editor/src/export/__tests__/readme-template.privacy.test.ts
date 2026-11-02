/**
 * export ZIP の README「プライバシーに関する注意」の固定 (#470)。
 *
 * 利用規約の dataStorageDesc (#412) と同じ事実 (サーバーへ送るのは Turnstile トークンと、
 * 時刻証明のためのセッション ID・端末 fingerprint のハッシュ・ハッシュチェーンの値と時刻だけ)
 * を書いていること、「自動アップロードなし」という事実と食い違う断言が戻らないことを確かめる。
 */

import { describe, it, expect } from 'vitest';
import { generateReadmeJa } from '../readme-template-ja.js';
import { generateReadmeEn } from '../readme-template-en.js';

const params = {
  timestamp: '2026-01-01T00:00:00.000Z',
  totalFiles: 1,
  totalScreenshots: 0,
  sourceFiles: ['main.ts'],
  proofFiles: ['proof.json'],
};

describe('README のプライバシーに関する注意', () => {
  it('ja: 送信内容を規約と同じ事実で書き、「自動アップロードなし」とは書かない', () => {
    const readme = generateReadmeJa(params);
    expect(readme).not.toContain('サーバーへの自動アップロードなし');
    expect(readme).toContain('コード・打鍵内容・個人情報はサーバーへ送信しない');
    expect(readme).toContain('Turnstile トークン');
    expect(readme).toContain('セッション ID');
    expect(readme).toContain('端末 fingerprint のハッシュ');
    expect(readme).toContain('ハッシュチェーンの値と時刻');
  });

  it('en: 送信内容を規約と同じ事実で書き、「No automatic upload」とは書かない', () => {
    const readme = generateReadmeEn(params);
    expect(readme).not.toMatch(/No automatic (server )?uploads?/);
    expect(readme).toContain('never sent to the server');
    expect(readme).toContain('Turnstile token');
    expect(readme).toContain('session ID');
    expect(readme).toContain('hash of the device fingerprint');
    expect(readme).toContain('hash-chain values with their timestamps');
  });
});
