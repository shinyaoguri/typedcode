/**
 * PoSW 反復の固定ベクタ (#267, #587)。
 *
 * `node:crypto` の createHash で独立に計算した期待値。vitest の `setup.ts` は `crypto.subtle.digest` を
 * `node:crypto` に差し替えるので、実装同士の一致だけでは差し替え先との一致しか見えない。そのため
 * ハードコードした値で縛る。検証側 (`poswSync.test.ts`) と記録側 (`poswWorker.test.ts`) が同じ表を使う。
 *
 * h_1 = SHA256(utf8(seed)), h_k = SHA256(utf8(hex(h_{k-1})))
 *
 * 反復数はリテラルで持つ (`POSW_ITERATIONS` を変えても表は変わらない)。
 */
export const POSW_FIXED_VECTORS: ReadonlyArray<readonly [seed: string, iterations: number, expected: string]> = [
  ['typedcode-posw', 1, '31e9a49284ec075a61692cae3067b69c99395c4c01118e0fac6677193788ab67'],
  ['typedcode-posw', 2, 'b69cd9f127e7a0eb543907d19896e6c1003677b024538b310c8d8a700ecfef88'],
  ['typedcode-posw', 10000, 'e53b14c541237231007a9250a172ff93f22622e0622a28681ce8afc135cd3e34'],
  ['タイピング証明', 1, 'edee7f2f1efe57fedc3cee5967ae64dee277e125c20ba8098dec35d066f3d863'],
  ['タイピング証明', 2, 'dbf19b3b2ba4162c0e5aeecfe15563d7d2979dc3bcef6f062df38c11837c72ad'],
  ['タイピング証明', 10000, 'cd3a67b36c92b830336e2726ee483fceca89d5508fc3a31d2031253d81337603'],
  ['', 1, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['', 2, 'cd372fb85148700fa88095e3492d3f9f5beb43e555e5ff26d95f5a6adc36f8e6'],
  ['', 10000, '2ad3c5c5c75605cfd9398880b7ef36e5c9cc1f5cf60244da34e3525f022dd0ba'],
];
