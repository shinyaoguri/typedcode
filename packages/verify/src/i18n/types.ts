/**
 * Translation keys for Verify application
 */
export interface VerifyTranslationKeys {
  // Common
  common: {
    cancel: string;
    close: string;
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

  // Settings
  settings: {
    language: string;
    about: string;
  };

  // Activity bar
  activityBar: {
    menu: string;
    openFile: string;
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
  };

  // Result panels
  result: {
    statusVerifying: string;
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
    iterations: string;
    totalTime: string;
    humanAttestation: string;
    createTime: string;
    exportTime: string;
    typingPattern: string;
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
    verifiedLegacy: string;
    exportTimeAuth: string;
    noAttestation: string;
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
  };

  // Typing pattern analysis
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
