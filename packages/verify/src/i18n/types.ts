/**
 * Translation keys for Verify application
 */
export interface VerifyTranslationKeys {
  // Index signature for dynamic key access
  [key: string]: unknown;

  // Common
  common: {
    cancel: string;
    close: string;
    delete: string;
    ready: string;
    verifying: string;
    files: string;
    file: string;
    reset: string;
  };

  // App-level
  app: {
    title: string;
    subtitle: string;
  };

  // 機能バッジ (ぱっと見で機能を判別)
  feature: {
    verify: string;
  };

  // Settings
  settings: {
    language: string;
    about: string;
    verifyMode: string;
  };

  // Activity bar
  activityBar: {
    menu: string;
    openFile: string;
    openFolder: string;
    explorer: string;
    settings: string;
    themeToggle: string;
    openEditor: string;
    github: string;
  };

  // Sidebar
  sidebar: {
    title: string;
    addFile: string;
    addFolder: string;
    emptyMessage: string;
    removeFile: string;
    removeFolder: string;
    removeConfirm: string;
  };

  // Welcome panel
  welcome: {
    title: string;
    subtitle: string;
    dropText: string;
    dropHint: string;
    browseButton: string;
    shortcutOpen: string;
  };

  // Verification progress
  progress: {
    verifying: string;
    metadataStep: string;
    metadataDesc: string;
    chainStep: string;
    chainDesc: string;
    samplingStep: string;
    samplingDesc: string;
    completeStep: string;
    completeDesc: string;
    statusRunning: string;
    statusDone: string;
    statusError: string;
    statusSkipped: string;
    statusFallback: string;
    statusNoCheckpoints: string;
    chainDetail: string;
    samplingDetail: string;
    samplingDetailWithTotal: string;
  };

  // Result panels
  result: {
    statusVerifying: string;
    statusSuccess: string;
    statusWarning: string;
    statusFailed: string;
    typingPure: string;
    typingExternal: string;
    timesCount: string;
    externalInputYes: string;
    externalInputNo: string;
    eventsUnit: string;
    screenshotsMissing: string;
    screenshotsMissingAndTampered: string;
    imageLoadFailed: string;
    sourceMismatchBanner: string;
    typing: string;
    pasteCount: string;
    internalPasteCount: string;
    externalInput: string;
    hashChain: string;
    verificationMethod: string;
    eventCount: string;
    screenshotVerification: string;
    screenshotsAllVerified: string;
    screenshotsSomeInvalid: string;
    screenshotsCount: string;
    posw: string;
    poswMode: string;
    poswSkipped: string;
    poswSampled: string;
    poswFull: string;
    poswNone: string;
    iterations: string;
    totalTime: string;
    humanAttestation: string;
    createTime: string;
    exportTime: string;
    typingPattern: string;
    analysis: string;
    anchoring: string;
    anchoringStatus: string;
    anchoringCoverage: string;
    anchoringTemporal: string;
    anchoringVerified: string;
    anchoringInvalid: string;
    anchoringUnavailable: string;
    anchoringNone: string;
    anchoringPostHoc: string;
    anchoringSparse: string;
    // 詳細展開セクション
    anchoringDetailsToggle: string;
    anchoringSectionKeys: string;
    anchoringSectionRange: string;
    anchoringSectionTemporal: string;
    anchoringSectionChecks: string;
    anchoringSectionFailures: string;
    anchoringKeyStatus: string;
    anchoringKeyStatusActive: string;
    anchoringKeyStatusRevoked: string;
    anchoringKeyStatusUnknown: string;
    anchoringKeyAlgorithm: string;
    anchoringKeyDescription: string;
    anchoringKeyValidFrom: string;
    anchoringKeyValidUntil: string;
    anchoringKeyRevokedAt: string;
    anchoringFirstSeenAt: string;
    anchoringInitialChainHash: string;
    anchoringFirstAnchor: string;
    anchoringLastAnchor: string;
    anchoringAnchorAt: string;
    anchoringAnchorTimestamp: string;
    anchoringServerSpan: string;
    anchoringClientSpan: string;
    anchoringRatio: string;
    anchoringPostHocCriteria: string;
    anchoringPostHocFlagged: string;
    anchoringPostHocClear: string;
    anchoringTotalCheckpoints: string;
    anchoringSignedCount: string;
    anchoringValidCount: string;
    anchoringNoFailures: string;
    anchoringFailedAt: string;
    anchoringWarningRevoked: string;
    // 試験束縛 (ADR-0006)
    examBinding: string;
    examProblem: string;
    examRootBinding: string;
    examSignature: string;
    examPackageHash: string;
    examContentHash: string;
    examTimeBox: string;
    examPackageNote: string;
    examLoadPackage: string;
    examPass: string;
    examFail: string;
    examRootBound: string;
    examRootUnbound: string;
    examBound: string;
    examFailed: string;
  };

  // Chain panel
  chain: {
    valid: string;
    invalid: string;
    samplingUsed: string;
    fullVerification: string;
    verifiedSuccessfully: string;
    verificationFailed: string;
    events: string;
    errorDetails: {
      header: string;
      position: string;
      type: string;
      message: string;
      expectedHash: string;
      computedHash: string;
      timestampDetail: string;
      errorTypes: {
        sequence: string;
        timestamp: string;
        previousHash: string;
        posw: string;
        hash: string;
        segmentEnd: string;
        unknown: string;
      };
    };
    segmentViz: {
      header: string;
      verified: string;
      unverified: string;
      error: string;
      segmentInfo: string;
      totalEvents: string;
      verifiedEvents: string;
      sampledSegments: string;
    };
  };

  // PoSW panel
  posw: {
    verified: string;
    failed: string;
    none: string;
    allEventsVerified: string;
    chainFailedPoswInvalid: string;
    noPoswMessage: string;
    iterationsPerEvent: string;
    seconds: string;
  };

  // Metadata panel
  metadata: {
    pureTyping: string;
    externalInputDetected: string;
    noPasteDetected: string;
    pasteDropCount: string;
  };

  // Attestation panel
  attestation: {
    valid: string;
    invalid: string;
    none: string;
    validCount: string;
    verifiedLegacy: string;
    exportTimeAuth: string;
    noAttestation: string;
  };

  // Screenshot capture type labels (lightbox / overlay / chart tooltips)
  screenshot: {
    typePeriodic: string;
    typeFocusLost: string;
    typeManual: string;
  };

  // Screenshot lightbox
  lightbox: {
    close: string;
    prev: string;
    next: string;
    type: string;
    time: string;
    resolution: string;
    hashVerification: string;
    verified: string;
    unverified: string;
  };

  // Status bar
  statusBar: {
    ready: string;
    verifying: string;
  };

  // Charts
  charts: {
    integrated: string;
    timeline: string;
    mouseTrajectory: string;
    keys: string;
    dwell: string;
    flight: string;
    mouse: string;
    eventFilter: string;
    axisTime: string;
    secondsShort: string;
    datasets: {
      typingSpeed: string;
      internalPaste: string;
      periodicCapture: string;
      focusLostCapture: string;
      manualCapture: string;
      humanAttestation: string;
      preExportAttestation: string;
      networkStatusChange: string;
      contentSnapshot: string;
    };
    tooltips: {
      screenshotMissing: string;
      screenshotTampered: string;
      screenshotVerified: string;
      humanAttestation: string;
      externalInput: string;
      internalPaste: string;
      termsAccepted: string;
      preExportAttestation: string;
      editorInitialized: string;
      networkStatusChange: string;
      codeExecution: string;
      terminalInput: string;
      screenShareStart: string;
      screenShareStop: string;
      templateInjection: string;
      windowResize: string;
      contentSnapshot: string;
    };
    categories: {
      content: string;
      cursor: string;
      input: string;
      window: string;
      system: string;
      auth: string;
      execution: string;
      capture: string;
    };
    events: {
      contentChange: string;
      contentSnapshot: string;
      externalInput: string;
      cursorPositionChange: string;
      selectionChange: string;
      keyDown: string;
      keyUp: string;
      mousePositionChange: string;
      focusChange: string;
      visibilityChange: string;
      windowResize: string;
      editorInitialized: string;
      networkStatusChange: string;
      humanAttestation: string;
      preExportAttestation: string;
      termsAccepted: string;
      codeExecution: string;
      terminalInput: string;
      screenshotCapture: string;
      screenShareStart: string;
      screenShareStop: string;
      screenShareOptOut: string;
      templateInjection: string;
      copyOperation: string;
      sessionResumed: string;
    };
  };

  // Trust calculation
  trust: {
    screenShareOptOut: string;
    summaryVerified: string;
    summaryPartial: string;
    summaryFailed: string;
    issueMetadataInvalid: string;
    issueChainInvalid: string;
    issueScreenshotsTampered: string;
    issueScreenshotsMissing: string;
    issueAttestationBoth: string;
    issueAttestationCreate: string;
    issueAttestationExport: string;
    issueSourceMismatch: string;
    issueAnchoringInvalid: string;
    issueAnchoringMissing: string;
    issueAnchoringPostHoc: string;
    issueAnchoringSparse: string;
    issueRootNotAnchored: string;
    issueNotPureTyping: string;
    issueExamBindingFailed: string;
    issueExamUnverified: string;
    components: {
      metadata: string;
      chain: string;
      posw: string;
      attestation: string;
      screenshots: string;
      source: string;
      anchoring: string;
      exam: string;
      typing: string;
    };
  };

  // Typing pattern analysis
  // プロセス要約 (Phase 8 W3)
  process: {
    title: string;
    duration: string;
    inserted: string;
    deleted: string;
    deletionRatio: string;
    executions: string;
    pauses: string;
    focusLosses: string;
    externalInputs: string;
    moments: string;
    reflectionNotes: string;
    chars: string;
    kindFirstRun: string;
    kindFirstFailedRun: string;
    kindFirstSuccessAfterFailure: string;
    kindLongestPause: string;
    kindLargestDeletion: string;
    kindLargestInsertion: string;
    kindFocusBurst: string;
    kindExternalInput: string;
  };

  // 三層保証語彙 (ADR-0020)
  assurance: {
    integrity: string;
    temporal: string;
    provenance: string;
    integrityProven: string;
    integrityFailed: string;
    temporalAnchored: string;
    temporalPartial: string;
    temporalUnanchored: string;
    temporalExamT0: string;
    pureTypingYes: string;
    pureTypingNo: string;
    signals: string;
    modeLabel: string;
    modeSelfAsserted: string;
    integrityHint: string;
    temporalHint: string;
    provenanceHint: string;
    mode: {
      casual: string;
      class: string;
      assignment: string;
      exam: string;
    };
  };

  // 分析層 (ADR-0009) — advisory レポートカード
  analysis: {
    advisory: string;
    noSignals: string;
    reviewPriority: string;
    evidence: string;
    score: string;
    confidence: string;
    analyzers: string;
    severityInfo: string;
    severityNotice: string;
    severityReview: string;
    dimensionAutomation: string;
    dimensionKeystrokeContent: string;
    dimensionTranscriptionTopology: string;
    dimensionFocusBurst: string;
    summary: {
      externalInput: string;
    };
  };

  pattern: {
    title: string;
    score: string;
    confidence: string;
    detailedAnalysis: string;
    human: string;
    uncertain: string;
    suspicious: string;
    criticalIssues: string;
    warnings: string;
    summary: {
      human: string;
      suspicious: string;
      uncertain: string;
      insufficientData: string;
    };
    insufficient: string;
    dwellConsistency: {
      normal: string;
      tooConsistent: string;
      highVariation: string;
    };
    flightTime: {
      normal: string;
      tooUniform: string;
      unusual: string;
    };
    rhythm: {
      normal: string;
      tooConsistent: string;
      periodic: string;
      highVariation: string;
    };
    speed: {
      normal: string;
      tooConsistent: string;
      highVariation: string;
    };
    pause: {
      normal: string;
      noPauses: string;
      tooMany: string;
    };
    burst: {
      normal: string;
      tooUniform: string;
      tooLong: string;
    };
    error: {
      normal: string;
      noCorrections: string;
      tooMany: string;
    };
    charTiming: {
      normal: string;
      tooUniform: string;
    };
  };

  // Seekbar
  seekbar: {
    speed: string;
    start: string;
    prev: string;
    play: string;
    pause: string;
    next: string;
    end: string;
  };

  // Errors
  errors: {
    accessDenied: string;
    fileReadError: string;
    folderReadError: string;
    browserNotSupported: string;
    browserNotSupportedDesc: string;
    examInvalidPackage: string;
    jsonParseError: string;
    fileLoadFailed: string;
    zipEmpty: string;
    zipLoadFailed: string;
    unsupportedFormat: string;
    noEvents: string;
  };

  // Messages
  messages: {
    folderOpened: string;
    fileAdded: string;
    fileUpdated: string;
    fileDeleted: string;
    folderAdded: string;
    folderDeleted: string;
  };

  // Plaintext view
  plaintext: {
    readOnly: string;
  };

  // Dialog
  dialog: {
    loadingData: string;
    pleaseWait: string;
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
}
