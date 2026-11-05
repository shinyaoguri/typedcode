// テスト fixture (#304): 自由記述の欄すべてと契約外のフィールドに `SECRET-*` を詰めた signal を返す
// 外部 Analyzer。`--aggregate-bundle` (Tier S) の出力にこれらが 1 つも出ないことを確かめる。
export default {
  id: 'SECRET-ANALYZER-ID',
  version: 'SECRET-VERSION',
  analyze() {
    return [
      {
        analyzerId: 'SECRET-ANALYZER-ID',
        dimension: 'SECRET-DIMENSION',
        score: 0.5,
        confidence: 0.5,
        severity: 'notice',
        evidence: [{ fromEventIndex: 0, note: 'SECRET-EVIDENCE' }],
        summary: 'SECRET-SUMMARY',
        summaryKey: 'SECRET-SUMMARY-KEY',
        summaryParams: { x: 'SECRET-PARAM' },
        leak: 'SECRET-EXTRA-FIELD',
      },
    ];
  },
};
