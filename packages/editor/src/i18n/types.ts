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
    resetAll: string;
  };

  // Activity bar tooltips
  activityBar: {
    toggleTerminal: string;
    toggleLogPanel: string;
    runCode: string;
    stopExecution: string;
    downloadAll: string;
    saveCodeOnly: string;
    exportProofOnly: string;
    settings: string;
    newTab: string;
    closeTab: string;
    copyCode: string;
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
    operationLogTitle: string;
    operationLogDesc: string;
    operationLogKeystrokes: string;
    operationLogCursor: string;
    operationLogMouse: string;
    operationLogClipboard: string;
    botDetectionTitle: string;
    botDetectionDesc: string;
    dataStorageTitle: string;
    dataStorageDesc: string;
    agreeCheckbox: string;
    agreeButton: string;
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
}
