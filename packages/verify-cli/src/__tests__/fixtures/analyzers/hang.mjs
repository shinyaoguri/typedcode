// テスト fixture: 解決しない Promise を返す Analyzer (#315)。
// await 忘れ・未接続の外部 API 待ちのようなバグでも同じ形になる。タイマーも I/O も
// 残さない。#301 以降は shared の orchestrator が期限 (10 秒) で timeout として記録して先へ進む
// (それ以前は、ここで止まったまま Node がイベントループが空になった時点で自然終了していた)。
export default {
  id: 'hang',
  version: '1.0.0',
  analyze() {
    return new Promise(() => {});
  },
};
