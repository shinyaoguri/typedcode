/**
 * Supported locales
 */
export type SupportedLocale = 'ja' | 'en';

/**
 * Translation structure - organized by feature/component
 */
export interface TranslationKeys {
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

  // Settings menu
  settings: {
    title: string;
    verifyProof: string;
    github: string;
    toggleTheme: string;
    language: string;
    about: string;
    resetAll: string;
  };

  // Activity bar tooltips
  activityBar: {
    menu: string;
    newFile: string;
    newWindow: string;
    importTemplate: string;
    toggleTerminal: string;
    toggleLogPanel: string;
    togglePreview: string;
    runCode: string;
    stopExecution: string;
    download: string;
    downloadAll: string;
    exportCurrentTab: string;
    settings: string;
    newTab: string;
    closeTab: string;
    copyCode: string;
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
    description: string;
    itemTabs: string;
    itemLogs: string;
    itemProofs: string;
    itemData: string;
    confirmButton: string;
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
  };

  // Status bar
  statusBar: {
    recording: string;
    events: string;
    line: string;
    column: string;
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
    dropDetected: string;
    gettingDeviceInfo: string;
    initializingEditor: string;
    noActiveTab: string;
    alreadyRunning: string;
    languageNotExecutable: string;
    runtimeNotFound: string;
    executionFailed: string;
    compilationStarted: string;
    executionStarted: string;
    codeExecution: string;
    clearLogConfirm: string;
  };

  // Export
  export: {
    preAuthRunning: string;
    preAuthFailed: string;
    cancelled: string;
    success: string;
    successVerified: string;
    verifyFailed: string;
    failed: string;
    zipSuccess: string;
    zipFailed: string;
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
    online: string;
    offline: string;
    mousePosition: string;
    paste: string;
    drop: string;
    selectionClear: string;
    selectionCount: string;
    terminalInput: string;
    screenShareStart: string;
    screenShareStop: string;
    screenShareResumed: string;
    sessionResumed: string;
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
}
