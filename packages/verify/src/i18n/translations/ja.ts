import type { VerifyTranslationKeys } from '../types';

export const ja: VerifyTranslationKeys = {
  common: {
    cancel: 'キャンセル',
    close: '閉じる',
    ready: 'Ready',
    verifying: '検証中',
    files: 'ファイル',
    file: 'ファイル',
    reset: 'リセット',
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
    typingPattern: 'タイピングパターン',
  },

  chain: {
    valid: '有効',
    invalid: '無効',
    samplingUsed: 'サンプリング検証で${count}チェックポイントを使用',
    fullVerification: '全イベントを検証',
    verifiedSuccessfully: '${count}イベント',
    verificationFailed: 'ハッシュ鎖の検証に失敗しました',
    events: 'イベント',
    errorDetails: {
      header: 'エラー詳細',
      position: 'エラー位置',
      type: 'エラー種別',
      message: 'メッセージ',
      expectedHash: '期待されるハッシュ',
      computedHash: '計算されたハッシュ',
      timestampDetail: 'タイムスタンプ',
      errorTypes: {
        sequence: 'シーケンス番号エラー',
        timestamp: 'タイムスタンプエラー',
        previousHash: '前ハッシュ不一致',
        posw: 'PoSW検証失敗',
        hash: 'ハッシュ不一致',
        segmentEnd: 'セグメント終端ハッシュ不一致',
        unknown: '不明なエラー',
      },
    },
    segmentViz: {
      header: '検証区間',
      verified: '検証済み',
      unverified: '未検証',
      error: 'エラー',
      segmentInfo: '区間 ${index}: イベント ${start} - ${end} (${count}件)',
      totalEvents: '全イベント数: ${count}',
      verifiedEvents: '検証済み: ${count}件',
      sampledSegments: 'サンプリング区間: ${count}/${total}',
    },
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
    eventFilter: 'イベントフィルター',
    categories: {
      content: 'コンテンツ',
      cursor: 'カーソル',
      input: '入力',
      window: 'ウィンドウ',
      system: 'システム',
      auth: '認証',
      execution: '実行',
      capture: 'キャプチャ',
    },
    events: {
      contentChange: 'コンテンツ変更',
      contentSnapshot: 'コンテンツスナップショット',
      externalInput: '外部入力',
      cursorPositionChange: 'カーソル位置変更',
      selectionChange: '選択範囲変更',
      keyDown: 'キー押下',
      keyUp: 'キー離し',
      mousePositionChange: 'マウス移動',
      focusChange: 'フォーカス変更',
      visibilityChange: '可視性変更',
      windowResize: 'ウィンドウリサイズ',
      editorInitialized: 'エディタ初期化',
      networkStatusChange: 'ネットワーク状態変更',
      humanAttestation: '人間証明',
      preExportAttestation: 'エクスポート前証明',
      termsAccepted: '利用規約同意',
      codeExecution: 'コード実行',
      terminalInput: 'ターミナル入力',
      screenshotCapture: 'スクリーンショット',
      screenShareStart: '画面共有開始',
      screenShareStop: '画面共有終了',
      templateInjection: 'テンプレート挿入',
    },
  },

  pattern: {
    title: 'タイピングパターン',
    score: 'スコア',
    confidence: '信頼度',
    detailedAnalysis: '詳細分析',
    human: '人間らしい',
    uncertain: '不明確',
    suspicious: '疑わしい',
    criticalIssues: '重大な問題',
    warnings: '警告',
    summary: {
      human: 'タイピングパターンは人間らしい特徴を示しています',
      suspicious: '自動入力や不正入力の可能性があります',
      uncertain: '一部のパターンに不明確な点があります',
      insufficientData: '分析に必要なイベント数が不足しています',
    },
    insufficient: 'データ不足',
    dwellConsistency: {
      normal: 'キー押下時間の変動が自然な範囲内',
      tooConsistent: 'キー押下時間が不自然なほど一定 - 自動入力の可能性',
      highVariation: 'キー押下時間の変動が大きい',
    },
    flightTime: {
      normal: 'キー間隔の分布が人間らしいパターン',
      tooUniform: 'キー間隔が均一すぎる - 機械的なパターン',
      unusual: 'キー間隔の分布が通常と異なる',
    },
    rhythm: {
      normal: 'タイピングリズムに自然な変動あり',
      tooConsistent: 'タイピングリズムが不自然なほど一定',
      periodic: '周期的なパターンを検出 - 自動入力の疑い',
      highVariation: 'タイピングリズムの変動が大きい',
    },
    speed: {
      normal: 'タイピング速度に自然な変動あり',
      tooConsistent: 'タイピング速度が不自然なほど一定',
      highVariation: 'タイピング速度の変動が大きい',
    },
    pause: {
      normal: '自然な休止パターン',
      noPauses: '長時間タイピングで休止なし - 不自然',
      tooMany: '休止が多すぎる',
    },
    burst: {
      normal: '連続タイピングのパターンが自然',
      tooUniform: 'バースト長が不自然なほど均一',
      tooLong: '休止なしの長い連続タイピング',
    },
    error: {
      normal: '適度なエラー修正パターン',
      noCorrections: 'エラー修正がほぼない - 不自然',
      tooMany: 'エラー修正が多い',
    },
    charTiming: {
      normal: 'キー位置による押下時間の違いが自然',
      tooUniform: '全キーの押下時間が均一 - 不自然',
    },
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
