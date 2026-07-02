// テスト fixture: named export (analyzer 単体 + analyzers 配列) の併存
export const analyzer = {
  id: 'fixture-named-single',
  version: '1.0.0',
  analyze() {
    return [];
  },
};

export const analyzers = [
  {
    id: 'fixture-named-a',
    version: '1.0.0',
    analyze() {
      return [];
    },
  },
  {
    id: 'fixture-named-b',
    version: '1.0.0',
    analyze() {
      return [];
    },
  },
];
