// テスト fixture: 解決しない Promise を返す Analyzer (#315)。
// await 忘れ・未接続の外部 API 待ちのようなバグでも同じ形になる。タイマーも I/O も
// 残さないので、ここで止まると Node はイベントループが空になった時点で自然終了する。
export default {
  id: 'hang',
  version: '1.0.0',
  analyze() {
    return new Promise(() => {});
  },
};
