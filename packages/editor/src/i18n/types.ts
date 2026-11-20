/**
 * Supported locales
 */
export type SupportedLocale = 'ja' | 'en';

/**
 * Translation structure - organized by feature/component
 */
export interface TranslationKeys {
  // Index signature for dynamic key access
  [key: string]: unknown;

  // Common UI elements
  common: {
    cancel: string;
    confirm: string;
    close: string;
    save: string;
    delete: string;
    reset: string;
    loading: string;
    error: string;
    success: string;
    warning: string;
    retry: string;
    retrying: string;
  };

  // App-level strings
  app: {
    title: string;
    description: string;
    preparing: string;
    initializing: string;
  };

  // 機能バッジ (ぱっと見で機能/モードを判別)
  feature: {
    casual: string;
    class: string;
    assignment: string;
    exam: string;
    author: string;
  };

  // 未知パスの「このページはありません」画面 (#644)
  notFound: {
    title: string;
    body: string;
    openEditor: string;
  };

  // 練習で規約に未同意のときの通知バナー (#644)
  termsNotice: {
    text: string; // 「利用を開始すると利用規約に同意したものとみなします」
    link: string; // 規約モーダルを開くボタン
    ok: string;
  };

  // どのモードでも証明しないことの注記 (#240 の D3。#644 で練習の規約通知と規約モーダルの冒頭へ移した)
  scopeNote: {
    text: string;
  };

  // Settings menu
  settings: {
    title: string;
    verifyProof: string;
    github: string;
    toggleTheme: string;
    language: string;
    about: string;
    /** 救出 (証明ではないコードの退避。#544。#779 でダウンロードメニューから設定メニューへ移した) */
    rescue: string;
    resetAll: string;
  };

  // Activity bar tooltips
  activityBar: {
    menu: string;
    newFile: string;
    importTemplate: string;
    toggleTerminal: string;
    toggleLogPanel: string;
    togglePreview: string;
    runCode: string;
    stopExecution: string;
    /** 全タブの証明 ZIP を書き出すボタン (メニューを持たない。#779) */
    download: string;
    settings: string;
    newTab: string;
    closeTab: string;
    copyCode: string;
    loadProblem: string;
  };

  // Browser preview panel
  preview: {
    title: string;
    refresh: string;
    noHtml: string;
  };

  // Reset confirmation dialog
  resetDialog: {
    title: string;
    warning: string;
    /** 消えるモード名 (`${mode}`) とそのモードのタブ数 (`${count}`) を差し込む */
    scope: string;
    itemTabs: string;
    itemLogs: string;
    itemProofs: string;
    itemData: string;
    confirmButton: string;
    failed: string;
  };

  // Tab close confirmation dialog
  tabCloseDialog: {
    title: string;
    warning: string;
    description: string;
    itemKeystrokes: string;
    itemHashChain: string;
    itemScreenshots: string;
    exportHint: string;
    confirmButton: string;
  };

  // Processing dialog (PoSW generation)
  processingDialog: {
    title: string;
    description: string;
    status: string;
    statusWithProgress: string;
  };

  // C compiler loading overlay
  clangDialog: {
    title: string;
    description: string;
    initializing: string;
  };

  // Human verification modal
  verification: {
    title: string;
    stepPrepare: string;
    stepChallenge: string;
    stepVerify: string;
    clickCheckbox: string;
    networkError: string;
    retryAttempt: string;
    retryCountdown: string;
  };

  // Terms of Service modal
  terms: {
    title: string;
    intro: string;

    // Operation Logging
    operationLogTitle: string;
    operationLogDesc: string;
    operationLogDetailHeading: string;
    operationLogKeystrokes: string;
    operationLogCursor: string;
    operationLogMouse: string;
    operationLogContent: string;
    operationLogClipboard: string;
    operationLogWindow: string;
    operationLogNote: string;

    // Hash Chain and Proof
    hashChainTitle: string;
    hashChainDesc: string;
    hashChainDetailHeading: string;
    hashChainSha256: string;
    hashChainCheckpoint: string;
    hashChainPosw: string;
    hashChainFingerprint: string;
    hashChainNote: string;

    // Bot Detection
    botDetectionTitle: string;
    botDetectionDesc: string;
    botDetectionDetailHeading: string;
    botDetectionInit: string;
    botDetectionExport: string;
    botDetectionNote: string;

    // Data Storage
    dataStorageTitle: string;
    dataStorageDesc: string;
    dataStorageDetailHeading: string;
    dataStorageCode: string;
    dataStorageEvents: string;
    dataStorageHash: string;
    dataStorageScreenshots: string;
    dataStorageSettings: string;
    dataStorageNote: string;

    // Screen Capture
    screenCaptureTitle: string;
    screenCaptureDesc: string;
    screenCaptureDetailHeading: string;
    screenCapturePermission: string;
    screenCaptureInterval: string;
    screenCaptureFocus: string;
    screenCaptureHash: string;
    screenCaptureStorage: string;
    screenCaptureNote: string;

    // Proof File Export
    exportTitle: string;
    exportDesc: string;
    exportDetailHeading: string;
    exportJson: string;
    exportScreenshots: string;
    exportManifest: string;
    exportReadme: string;
    exportNote: string;

    // Privacy and Considerations
    privacyTitle: string;
    privacyDesc: string;
    privacyDetailHeading: string;
    privacyBrowserInfo: string;
    privacyTypedContent: string;
    privacyScreenshots: string;
    privacyLocalOnly: string;
    privacyExportWarning: string;
    privacyNote: string;

    agreeCheckbox: string;
    agreeButton: string;
  };

  // Screen capture
  screenCapture: {
    requesting: string;
    permissionDenied: string;
    notSupported: string;
    captured: string;
    capturedPeriodic: string;
    capturedFocusLost: string;
    capturedManual: string;
    lockTitle: string;
    lockDescription: string;
    resumeButton: string;
    guideText: string;
    guideHint: string;
    // Error dialog
    errorTitle: string;
    errorUnknown: string;
    errorNotAllowed: string;
    errorNotAllowedDesc: string;
    errorNotSupported: string;
    errorNotSupportedDesc: string;
    errorNotReadable: string;
    errorNotReadableDesc: string;
    errorOverconstrained: string;
    errorOverconstrainedDesc: string;
    errorAborted: string;
    errorAbortedDesc: string;
    errorSecurityError: string;
    errorSecurityErrorDesc: string;
    errorOutOfMemory: string;
    errorOutOfMemoryDesc: string;
    errorMonitorRequired: string;
    errorMonitorRequiredDesc: string;
    errorStorageInitFailed: string;
    errorStorageInitFailedDesc: string;
    // Error solutions
    solutionTitle: string;
    solutionRefresh: string;
    solutionCloseOtherTabs: string;
    solutionCheckPermissions: string;
    solutionUseChrome: string;
    solutionSelectMonitor: string;
    solutionClearBrowserData: string;
    solutionRestartBrowser: string;
    solutionCheckHttps: string;
    solutionFreeMemory: string;
    // Screen share choice dialog
    choiceTitle: string;
    choiceDescription: string;
    startScreenShare: string;
    startScreenShareDesc: string;
    useWithoutScreenShare: string;
    useWithoutScreenShareDesc: string;
    // Opt-out confirmation dialog
    optOutConfirmTitle: string;
    optOutConfirmDescription: string;
    optOutWarning1: string;
    optOutWarning2: string;
    optOutWarning3: string;
    optOutConfirm: string;
    // Opt-out banner
    optedOutBanner: string;
    enableScreenShare: string;
    // Continue without screen share (lock overlay)
    continueWithoutButton: string;
  };

  // Status bar
  statusBar: {
    recording: string;
    events: string;
    line: string;
    column: string;
    synced: string;
    syncing: string;
    pending: string;
    /** 保存先の片方 (IndexedDB か sessionStorage) にだけ保存できた (#543) */
    degraded: string;
    /** どちらにも保存できなかった (#543) */
    failed: string;
    /** 言語の選択 (`#language-selector`) の名前 (aria-label) と、それを囲む `#language-status` の title (#736) */
    selectLanguage: string;
    /** ステータスバーの各項目の title (ツールチップ。#739) */
    proofStatusTitle: string;
    eventCountTitle: string;
    hashTitle: string;
    syncTitle: string;
    cursorPositionTitle: string;
  };

  // Tab management
  tabs: {
    untitled: string;
    newTab: string;
    closeTab: string;
    lastTabWarning: string;
    closeConfirm: string;
    verifiedTooltip: string;
    failedTooltip: string;
    failureTimeout: string;
    failureNetworkError: string;
    failureChallengeFailed: string;
    failureTokenFailed: string;
    failureUnknown: string;
  };

  // Notifications
  notifications: {
    authRunning: string;
    authFailed: string;
    authFailedReload: string;
    newTabCreated: string;
    codeCopied: string;
    copyFailed: string;
    pasteDetected: string;
    internalPasteDetected: string;
    dropDetected: string;
    copyDetected: string;
    gettingDeviceInfo: string;
    initializingEditor: string;
    noActiveTab: string;
    alreadyRunning: string;
    languageNotExecutable: string;
    languageNotAllowed: string;
    runtimeNotFound: string;
    executionFailed: string;
    compilationStarted: string;
    executionStarted: string;
    codeExecution: string;
    /** 新しい版が別のタブで開かれ、IndexedDB の接続を閉じた (#325) */
    storageVersionChange: string;
    /** IndexedDB の接続が強制的に閉じられ、開き直せなかった (#325) */
    storageConnectionLost: string;
    /** 保存が容量切れらしい失敗 (`isStorageFullError`) になった。セッション中 1 回だけ出す (#626) */
    storageFull: string;
  };

  // Export
  // 提出前セルフレビュー (ADR-0022)
  selfReview: {
    title: string;
    lead: string;
    duration: string;
    edits: string;
    runs: string;
    pauses: string;
    noteLabel: string;
    notePlaceholder: string;
    noteHint: string;
    cancel: string;
    proceed: string;
    recorded: string;
  };

  export: {
    preAuthRunning: string;
    preAuthFailed: string;
    cancelled: string;
    success: string;
    /** 書き出した全タブの proof.json が自己検証に通った (#586 / #779)。`${count}` = ファイル数 */
    zipSuccessVerified: string;
    /** 自己検証で 1 つでも invalid か throw があった (#586) */
    verifyFailed: string;
    zipFailed: string;
    /** 書き出すタブが無い (#779) */
    noTabs: string;
    /** 救出 ZIP を出した (#544) */
    rescueSuccess: string;
    /** ZIP を作れず単一 JSON で救出した (#544) */
    rescueJsonFallback: string;
    /** 救出ファイルを作れなかった (#544) */
    rescueFailed: string;
    progressTitle: string;
    phaseVerification: string;
    phasePreparing: string;
    phaseScreenshots: string;
    phaseGenerating: string;
    statusVerification: string;
    statusPreparing: string;
    statusScreenshots: string;
    statusGenerating: string;
    statusComplete: string;
    /** 記録キュー排出待ちの進捗 (#225)。`${count}` = 残件数 */
    statusDraining: string;
    /** 排出できず export を中止したときの通知 (#225) */
    queueNotDrained: string;
  };

  // Terminal / Runtime
  terminal: {
    title: string;
    cRuntime: string;
    cppRuntime: string;
    jsRuntime: string;
    tsRuntime: string;
    pythonRuntime: string;
    notAvailable: string;
    supportedLanguages: string;
    runHint: string;
    cDisclaimer: string;
    cppDisclaimer: string;
    resetRuntime: string;
    runtimeResetComplete: string;
    runtimeCorruptionDetected: string;
    runtimeResetting: string;
  };

  // Log viewer
  logViewer: {
    title: string;
    typeLabel: string;
    descriptionLabel: string;
    detailsLabel: string;
    hashLabel: string;
    position: string;
    rangeLength: string;
    deleted: string;
    inserted: string;
    direction: string;
    multiLine: string;
    contentChange: string;
    cursorMove: string;
    selectionChange: string;
    externalInput: string;
    editorInit: string;
    snapshot: string;
    mouseOperation: string;
    rangeSelection: string;
    characterInput: string;
    codeExecStart: string;
    codeExecResult: string;
    outcomeSuccess: string;
    outcomeFailure: string;
    outcomeError: string;
    outcomeAborted: string;
    outcomeTimeout: string;
    codeExecFile: string;
    codeExecExit: string;
    codeExecElapsed: string;
    reflectionNote: string;
  };

  // Event descriptions (for tracking)
  events: {
    keyDown: string;
    keyUp: string;
    dwellTime: string;
    tabActive: string;
    tabInactive: string;
    windowFocused: string;
    windowBlurred: string;
    windowResize: string;
    initialWindowSize: string;
    networkOnline: string;
    networkOffline: string;
    initialNetworkState: string;
    environmentProbe: string;
    online: string;
    offline: string;
    mousePosition: string;
    paste: string;
    internalPaste: string;
    drop: string;
    copy: string;
    selectionClear: string;
    selectionCount: string;
    terminalInput: string;
    screenShareStart: string;
    screenShareStop: string;
    screenShareResumed: string;
    screenShareOptOut: string;
    sessionResumed: string;
    examOpened: string;
  };

  // Operation types (input detection)
  operations: {
    input: string;
    enter: string;
    delete: string;
    multiCharDelete: string;
    tab: string;
    imeInput: string;
    multiLinePaste: string;
    multiLineChange: string;
    paste: string;
    drop: string;
    autoIndent: string;
    bulkDelete: string;
    formatIndent: string;
    formatOutdent: string;
    undo: string;
    redo: string;
    replace: string;
    unknown: string;
    internalPaste: string;
  };

  // About dialog
  about: {
    title: string;
    appVersion: string;
    proofVersion: string;
    storageVersion: string;
    commit: string;
    lastUpdate: string;
    buildDate: string;
    viewOnGithub: string;
  };

  // Duplicate instance detection
  duplicateInstance: {
    title: string;
    description: string;
    hint: string;
    closeThisTab: string;
  };

  // 別のタブに同じセッションを再開され、このタブが読み取り専用になった (#237)
  instanceConflict: {
    title: string;
    description: string;
    hint: string;
    rescue: string;
    closeThisTab: string;
  };

  // 起動失敗の画面 (#325)
  bootFailure: {
    title: string;
    description: string;
    blockedHint: string;
    reload: string;
    detail: string;
  };

  // 起動時の空き容量の試験で書けなかったときの警告 (#626)
  storageLow: {
    title: string;
    description: string;
    hint: string;
    continue: string;
    retry: string;
  };

  // Unsupported browser detection
  unsupportedBrowser: {
    title: string;
    description: string;
    untestedNote: string;
    hint: string;
  };

  // Welcome screen
  welcome: {
    title: string;
    tagline: string;
    startSection: string;
    newFile: string;
    importTemplate: string;
  };

  // Idle timeout
  idleTimeout: {
    warningTitle: string;
    warningMessage: string;
    countdownLabel: string;
    continueButton: string;
    suspendedTitle: string;
    suspendedMessage: string;
    suspendedHint: string;
    resumeButton: string;
    titleFlash: string;
  };

  // Template import
  template: {
    confirmTitle: string;
    templateName: string;
    fileCount: string;
    author: string;
    description: string;
    filesToCreate: string;
    warningExistingTabs: string;
    import: string;
    importing: string;
    success: string;
    partialSuccess: string;
    error: string;
    readError: string;
    invalidFormat: string;
    unnamedTemplate: string;
    dropTitle: string;
    dropHint: string;
  };

  // Session recovery dialog
  sessionRecovery: {
    title: string;
    message: string;
    lastActive: string;
    tabs: string;
    eventCount: string;
    warning: string;
    resume: string;
    startFresh: string;
    resuming: string;
    clearing: string;
  };

  // 復元時に証明と食い違った元のコードの通知 (#413)
  unprovenContent: {
    title: string;
    message: string;
    tabSummary: string;
    showDiff: string;
    download: string;
    diffLabel: string;
    note: string;
    close: string;
  };

  // Exam mode (ADR-0006 / ADR-0008)
  exam: {
    title: string;
    problemPlaceholder: string;
    fullscreenWarning: string;
    enterFullscreen: string;
    fsEntered: string;
    fsExited: string;
    fsDenied: string;
    fsUnavailable: string;
    submitNote: string;
    downloadButton: string;
    /** 問題パネルの救出ボタン (#544) */
    rescueButton: string;
    toggleProblem: string;
    gate: {
      title: string;
      description: string;
      packageLabel: string;
      dropHint: string;
      codeLabel: string;
      startButton: string;
      unlocking: string;
      errorNoFile: string;
      errorNoCode: string;
      errorInvalidFile: string;
      errorNewerFormat: string;
      errorUnsupportedFormat: string;
      errorUntrusted: string;
      errorWrongCode: string;
      errorUnlockFailed: string;
      /** ゲート内の人間確認 (Turnstile の先行取得。#236) */
      attestationPending: string;
      attestationVerified: string;
      attestationFailed: string;
    };
  };

  // 問題パネルの入出力例 (#648 / ADR-0048)。判定はせず、受講者が自分で見比べる
  problemExamples: {
    heading: string;
    instructions: string;
    input: string;
    output: string;
    noInput: string;
    copy: string;
    copied: string;
  };

  // 授業モード (/class, ADR-0014)
  class: {
    loader: {
      title: string;
      description: string;
      packageLabel: string;
      dropHint: string;
      loadButton: string;
      skipButton: string;
      loading: string;
      errorInvalidFile: string;
    };
  };

  // 試験問題オーサリング (/author, #80)
  author: {
    title: string;
    subtitle: string;
    copy: string;
    statusbar: { noExamId: string; problems: string };
    /** 文書の表示の切り替え (#796 / #797) */
    views: { edit: string; preview: string; form: string; text: string; studentPreview: string };
    /** 試験定義のフォーム (#797) */
    exam: {
      examId: string;
      kind: string;
      kindExam: string;
      kindClass: string;
      languages: string;
      adopted: string;
      available: string;
      noAdopted: string;
      noAvailable: string;
      moveUp: string;
      moveDown: string;
      remove: string;
      adopt: string;
      missing: string;
      invalid: string;
      duplicate: string;
      dragHint: string;
      invalidDefinition: string;
      openText: string;
      fieldInvalid: string;
      newExamTitle: string;
      newExamLabel: string;
    };
    /** ケースファイルのフォーム (#798) */
    cases: {
      heading: string;
      list: string;
      add: string;
      duplicate: string;
      remove: string;
      empty: string;
      name: string;
      public: string;
      publicHint: string;
      match: string;
      matchTrim: string;
      matchExact: string;
      stdin: string;
      stdout: string;
      trailingNone: string;
      trailingCount: string;
      crlfNote: string;
      nameEmpty: string;
      nameDuplicate: string;
      defaultName: string;
      copyName: string;
      publicMark: string;
      exactMark: string;
      invalidDefinition: string;
      openText: string;
      opFailed: string;
    };
    /** 学生プレビュー (#797) */
    preview: {
      note: string;
      problem: string;
      starter: string;
      examples: string;
      loading: string;
      empty: string;
      issuesHeading: string;
    };
    /** 書き出しのパネル (#797) */
    export: {
      heading: string;
      target: string;
      noExam: string;
      createExam: string;
      examId: string;
      kind: string;
      languages: string;
      problems: string;
      kindExam: string;
      kindClass: string;
      invalidTarget: string;
      classHint: string;
      buttonExam: string;
      buttonClass: string;
      working: string;
      errorNoTarget: string;
      errorUnknownExam: string;
      errorNoKey: string;
      errorGeneric: string;
      errorDirty: string;
      errorEmpty: string;
      errorNoLanguages: string;
    };
    run: { label: string; running: string; stop: string; terminal: string; compilerLoading: string };
    key: {
      heading: string;
      tabExisting: string;
      tabGenerate: string;
      keyIdLabel: string;
      jwkLabel: string;
      jwkHint: string;
      generateIntro: string;
      generateButton: string;
      generateFailed: string;
      settings: string;
      privateWarning: string;
      registryEntryLabel: string;
      registryHint: string;
      downloadPrivate: string;
    };
    /** 教材フォルダの起動画面 (#796) */
    welcome: {
      heading: string;
      intro: string;
      open: string;
      create: string;
      resume: string;
      unsupported: string;
      unavailableDenied: string;
      unavailableMissing: string;
      unavailableError: string;
      openFailed: string;
      opening: string;
      createTitle: string;
      createLabel: string;
      createExists: string;
      createInvalid: string;
    };
    /** エクスプローラー (#796) */
    explorer: {
      heading: string;
      problems: string;
      exams: string;
      noProblems: string;
      noExams: string;
      newProblem: string;
      newExam: string;
      refresh: string;
      openOther: string;
      addPart: string;
      assignPart: string;
      missing: string;
      invalid: string;
      definition: string;
      /** 問題ごとの操作「別のフォルダへコピー」(#800) */
      copyProblem: string;
    };
    /** 問題を別の教材フォルダへコピーした結果 (#800) */
    copyProblem: {
      title: string;
      close: string;
      copied: string;
      conflict: string;
      sourceInvalid: string;
      failed: string;
      failedNote: string;
      dirty: string;
      sameFolder: string;
      unsupported: string;
      writtenLabel: string;
      writtenBeforeFailureLabel: string;
      conflictLabel: string;
      dirtyLabel: string;
      failedLabel: string;
    };
    /** 問題定義が参照するファイルの役割 */
    roles: { statement: string; starter: string; hint: string; solution: string; cases: string };
    /** 「追加」で作るファイルの既定の名前に入れる語 */
    partWords: { starter: string; hint: string; solution: string };
    /** タブと分割エディタ (#796) */
    editor: {
      save: string;
      saveAll: string;
      split: string;
      closeGroup: string;
      closeTab: string;
      empty: string;
      unsaved: string;
      runNoFile: string;
    };
    dialogs: {
      ok: string;
      cancel: string;
      newProblemTitle: string;
      newProblemLabel: string;
      addPartTitle: string;
      assignPartTitle: string;
      roleLabel: string;
      fileNameLabel: string;
      fileLabel: string;
      noFiles: string;
      conflictTitle: string;
      conflictModified: string;
      conflictDeleted: string;
      conflictExists: string;
      conflictChoice: string;
      reload: string;
      overwrite: string;
      unsavedTitle: string;
      unsavedBody: string;
      discard: string;
      closeDirtyBody: string;
      closeDiscard: string;
    };
    /** 保存・読み込み・問題の操作の結果の知らせ */
    notices: {
      saved: string;
      saveFailed: string;
      reloadFailed: string;
      openFailed: string;
      invalidName: string;
      exists: string;
      unknownProblem: string;
      definitionDirty: string;
      definitionInvalid: string;
      alreadyAssigned: string;
      missingFile: string;
      readFailed: string;
      writeConflict: string;
      writeFailed: string;
    };
    /** 書き出しを止めた理由 (教材の欠損・重なり) */
    issues: {
      heading: string;
      missingFile: string;
      invalidReference: string;
      invalidDefinition: string;
      unreadableFile: string;
      duplicateId: string;
      duplicateFilename: string;
    };
    /** 教員用の一括検証 (#799) */
    verify: {
      explorerAction: string;
      tab: string;
      heading: string;
      empty: string;
      start: string;
      abort: string;
      runningHint: string;
      stateDone: string;
      stateAborted: string;
      solutionHeader: string;
      verdicts: {
        pending: string;
        running: string;
        match: string;
        mismatch: string;
        runtimeError: string;
        timeout: string;
        unsupported: string;
      };
      reasons: {
        problemInvalid: string;
        noSolutions: string;
        noCases: string;
        missingFile: string;
        readFailed: string;
        casesInvalid: string;
        emptyCases: string;
        terminalBusy: string;
      };
      runBlocked: string;
      detail: {
        selectHint: string;
        cellTitle: string;
        expected: string;
        actual: string;
        noLine: string;
        noNewline: string;
        stderr: string;
        exitCode: string;
        exitNone: string;
        modeTrim: string;
        modeExact: string;
        notRun: string;
      };
    };
    token: {
      heading: string;
      label: string;
      regenerate: string;
      hint: string;
      embedPubkey: string;
    };
    result: {
      title: string;
      redownload: string;
      downloadMemo: string;
      proctorCodeLabel: string;
      proctorWarning: string;
      keyId: string;
      packageHash: string;
    };
    memo: {
      title: string;
      generatedAt: string;
      problemFile: string;
      note1: string;
      note2: string;
      note3: string;
    };
  };
}
