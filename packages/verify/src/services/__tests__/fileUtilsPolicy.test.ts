import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getLanguageFromExtension as sharedGetLanguageFromExtension,
  getFileType as sharedGetFileType,
  isProofFilename as sharedIsProofFilename,
  isBinaryFile as sharedIsBinaryFile,
} from '@typedcode/shared';
import { getLanguageFromExtension, getFileType, isProofFilename, isBinaryFile, isImageFile } from '../fileUtils.js';

/**
 * 拡張子 → 言語の表を shared の `LANGUAGE_MAP` 一本に保つための機械的な歯止め (#278)。
 *
 * verify が同じ表を自前で持つと、片方に言語を足したときもう片方が置き去りになり、
 * 「エディタでは扱えるのに proof を読むと `unknown` に落ちる」という分かりにくい形でドリフトする
 * (`KNOWN_LANGUAGES` = proof の `language` の allowlist は shared 側から導出しているため。#248)。
 * 文書ルールだけでは再発するので (#149 / #234 と同じ)、ソースを読んで検査する。
 */
const FILE_UTILS_PATH = join(dirname(fileURLToPath(import.meta.url)), '../fileUtils.ts');

/** 表の全キー + 画像・バイナリ・未知・大文字混在・拡張子なし */
const SAMPLE_FILENAMES = [
  'a.c',
  'a.h',
  'a.cpp',
  'a.cc',
  'a.cxx',
  'a.hpp',
  'a.ts',
  'a.tsx',
  'a.js',
  'a.jsx',
  'a.py',
  'a.rb',
  'a.rs',
  'a.go',
  'a.java',
  'a.kt',
  'a.swift',
  'a.cs',
  'a.php',
  'a.html',
  'a.htm',
  'a.css',
  'a.scss',
  'a.sass',
  'a.less',
  'a.md',
  'a.json',
  'a.xml',
  'a.yaml',
  'a.yml',
  'a.toml',
  'a.sh',
  'a.bash',
  'a.zsh',
  'a.sql',
  'a.txt',
  // 画像 (isBinaryFile だけは意図的に差がある)
  'a.png',
  'a.jpg',
  'a.jpeg',
  'a.gif',
  'a.bmp',
  'a.webp',
  'a.ico',
  // バイナリ
  'a.exe',
  'a.dll',
  'a.so',
  'a.dylib',
  'a.bin',
  'a.mp3',
  'a.mp4',
  'a.wav',
  'a.avi',
  'a.mov',
  'a.webm',
  'a.pdf',
  'a.doc',
  'a.docx',
  'a.xls',
  'a.xlsx',
  'a.ppt',
  'a.pptx',
  'a.zip',
  'a.tar',
  'a.gz',
  'a.rar',
  'a.7z',
  'a.wasm',
  'a.o',
  'a.a',
  'a.lib',
  // 未知・大文字混在・拡張子なし・多重拡張子
  'a.unknown',
  'A.CPP',
  'Main.TS',
  'README',
  'archive.tar.gz',
  'dir.d/file',
  '.gitignore',
  'a.JSON',
  'A.ZIP',
];

describe('fileUtils policy (verify)', () => {
  it('does not carry its own extension-to-language table (shared LANGUAGE_MAP is the source of truth)', () => {
    const source = readFileSync(FILE_UTILS_PATH, 'utf8');
    // 表のリテラル (例: `'.cxx': 'cpp'`) を持たない
    expect(source).not.toMatch(/['"]\.(cxx|hpp|tsx|yml|zsh)['"]\s*:/);
    expect(source).not.toMatch(/languageMap/i);
  });

  it('imports the detection helpers from @typedcode/shared', () => {
    const source = readFileSync(FILE_UTILS_PATH, 'utf8');
    expect(source).toMatch(/from\s+['"]@typedcode\/shared['"]/);
  });
});

describe('fileUtils equivalence with shared (verify)', () => {
  it.each(SAMPLE_FILENAMES)('getLanguageFromExtension matches shared for %s', (name) => {
    expect(getLanguageFromExtension(name)).toBe(sharedGetLanguageFromExtension(name));
  });

  it.each(SAMPLE_FILENAMES)('getFileType / isProofFilename match shared for %s', (name) => {
    expect(getFileType(name)).toBe(sharedGetFileType(name));
    expect(isProofFilename(name)).toBe(sharedIsProofFilename(name));
  });

  it.each(SAMPLE_FILENAMES.filter((n) => !isImageFile(n)))('isBinaryFile matches shared for non-image %s', (name) => {
    expect(isBinaryFile(name)).toBe(sharedIsBinaryFile(name));
  });

  it('isBinaryFile excludes images (they are handled by a separate path in ZipFileProcessor)', () => {
    for (const name of ['a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.bmp', 'a.webp']) {
      expect(isImageFile(name)).toBe(true);
      expect(isBinaryFile(name)).toBe(false);
    }
  });

  it('keeps .ico as binary and not as an image (current behavior)', () => {
    expect(isImageFile('a.ico')).toBe(false);
    expect(isBinaryFile('a.ico')).toBe(true);
  });
});
