import type { VerifyTranslationKeys } from '../types';

export const ja: VerifyTranslationKeys = {
  common: {
    cancel: 'キャンセル',
    close: '閉じる',
    ready: 'Ready',
    verifying: '検証中',
    files: 'ファイル',
    file: 'ファイル',
  },

  app: {
    title: 'TypedCode Verify',
    subtitle: 'タイピング証明を検証',
  },

  settings: {
    language: '言語',
    about: 'バージョン情報',
  },

  activityBar: {
    menu: 'メニュー',
    openFile: 'ファイルを開く',
    explorer: 'エクスプローラー',
    settings: '設定',
    themeToggle: 'テーマ切替',
    openEditor: 'エディタを開く',
    github: 'GitHub',
  },

  sidebar: {
    title: 'エクスプローラー',
    addFile: 'ファイルを追加',
    addFolder: 'フォルダを追加',
    emptyMessage: 'ファイルを読み込むと\nここに表示されます',
  },

  welcome: {
    title: 'TypedCode Verify',
    subtitle: 'タイピング証明を検証',
    dropText: '証明ファイルをドロップ',
    dropHint: 'JSON または ZIP ファイル',
    browseButton: 'ファイルを選択',
    shortcutOpen: 'ファイルを開く',
  },

  progress: {
    verifying: '検証中',
    metadataStep: 'メタデータ検証',
    metadataDesc: 'ファイルの整合性とハッシュを確認',
    chainStep: '全件ハッシュチェーン検証',
    chainDesc: 'チェックポイントなしのためフォールバック',
    samplingStep: 'サンプリング検証',
    samplingDesc: 'チェックポイント区間の部分検証',
    completeStep: '完了',
    completeDesc: '検証結果の表示',
  },

  result: {
    statusVerifying: '検証中...',
    typing: 'タイピング',
    pasteCount: 'ペースト回数',
    externalInput: '外部入力',
    hashChain: 'ハッシュチェーン',
    verificationMethod: '検証方式',
    eventCount: 'イベント数',
    screenshotVerification: 'スクリーンショット',
    screenshotsAllVerified: '✓ ${verified}/${total}枚検証済み',
    screenshotsSomeInvalid: '⚠ ${invalid}/${total}枚が改ざんされている可能性',
    screenshotsCount: '${count}枚',
    posw: 'PoSW',
    iterations: '反復回数',
    totalTime: '合計時間',
    humanAttestation: '人間証明',
    createTime: '作成時',
    exportTime: 'エクスポート時',
  },

  chain: {
    valid: '有効',
    invalid: '無効',
    samplingUsed: 'サンプリング検証で${count}チェックポイントを使用',
    fullVerification: '全イベントを検証',
    verifiedSuccessfully: '${count}イベント',
    verificationFailed: 'ハッシュ鎖の検証に失敗しました',
    events: 'イベント',
  },

  posw: {
    verified: '検証済み',
    failed: '検証失敗',
    none: 'なし',
    allEventsVerified: '全${count}イベントのPoSWが検証されました',
    chainFailedPoswInvalid: 'ハッシュ鎖検証に失敗したためPoSWも無効',
    noPoswMessage: 'この証明ファイルにはPoSWが含まれていません',
    iterationsPerEvent: '回/イベント',
    seconds: '秒',
  },

  metadata: {
    pureTyping: '純粋なタイピング入力',
    externalInputDetected: '外部入力を検出',
    noPasteDetected: 'ペーストなし',
    pasteDropCount: 'ペースト${paste}回 / ドロップ${drop}回',
  },

  attestation: {
    valid: '有効',
    invalid: '無効',
    none: 'なし',
    verifiedLegacy: '検証済み（旧形式）',
    exportTimeAuth: 'エクスポート時に認証',
    noAttestation: '人間証明なし',
  },

  statusBar: {
    ready: 'Ready',
    verifying: '検証中 ${current}/${total}',
  },

  charts: {
    integrated: '統合チャート',
    timeline: 'タイムライン',
    mouseTrajectory: 'マウス軌跡',
    keys: 'キー',
    dwell: 'Dwell',
    flight: 'Flight',
    mouse: 'マウス',
  },

  seekbar: {
    start: '最初',
    prev: '前',
    play: '再生',
    pause: '停止',
    next: '次',
    end: '最後',
  },

  errors: {
    accessDenied: 'アクセス拒否',
    fileReadError: 'ファイル読み込みエラー',
    folderReadError: 'フォルダ読み取りエラー',
    browserNotSupported:
      'File System Access API は Chrome / Edge でのみ利用可能です',
    browserNotSupportedDesc:
      '代わりにファイル選択またはドラッグ＆ドロップをご利用ください',
  },

  messages: {
    folderOpened: 'フォルダを開きました',
    fileAdded: 'ファイル追加',
    fileUpdated: 'ファイル更新',
    fileDeleted: 'ファイル削除',
    folderAdded: 'フォルダ追加',
    folderDeleted: 'フォルダ削除',
  },

  plaintext: {
    readOnly: '読み取り専用',
  },

  dialog: {
    loadingData: 'データを読み込み中...',
    pleaseWait: 'しばらくお待ちください',
  },

  about: {
    title: 'TypedCode Verify について',
    appVersion: 'アプリバージョン',
    proofVersion: '証明フォーマット',
    storageVersion: 'ストレージフォーマット',
    commit: 'コミット',
    lastUpdate: '最終更新',
    buildDate: 'ビルド日時',
    viewOnGithub: 'GitHub で見る',
  },
};
