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
    externalInput: string;
    hashChain: string;
    verificationMethod: string;
    eventCount: string;
    posw: string;
    iterations: string;
    totalTime: string;
    humanAttestation: string;
    createTime: string;
    exportTime: string;
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
    timeline: string;
    mouseTrajectory: string;
    keys: string;
    dwell: string;
    flight: string;
    mouse: string;
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
