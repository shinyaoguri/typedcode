import type { VerifyTranslationKeys } from '../types';

export const en: VerifyTranslationKeys = {
  common: {
    cancel: 'Cancel',
    close: 'Close',
    ready: 'Ready',
    verifying: 'Verifying',
    files: 'files',
    file: 'file',
  },

  app: {
    title: 'TypedCode Verify',
    subtitle: 'Verify typing proofs',
  },

  settings: {
    language: 'Language',
    about: 'About',
  },

  activityBar: {
    menu: 'Menu',
    openFile: 'Open File',
    explorer: 'Explorer',
    settings: 'Settings',
    themeToggle: 'Toggle Theme',
    openEditor: 'Open Editor',
    github: 'GitHub',
  },

  sidebar: {
    title: 'Explorer',
    addFile: 'Add File',
    addFolder: 'Add Folder',
    emptyMessage: 'Files will appear here\nwhen loaded',
  },

  welcome: {
    title: 'TypedCode Verify',
    subtitle: 'Verify typing proofs',
    dropText: 'Drop proof files here',
    dropHint: 'JSON or ZIP files',
    browseButton: 'Browse Files',
    shortcutOpen: 'Open File',
  },

  progress: {
    verifying: 'Verifying',
    metadataStep: 'Metadata Verification',
    metadataDesc: 'Checking file integrity and hashes',
    chainStep: 'Full Hash Chain Verification',
    chainDesc: 'Fallback due to no checkpoints',
    samplingStep: 'Sampling Verification',
    samplingDesc: 'Partial verification of checkpoint segments',
    completeStep: 'Complete',
    completeDesc: 'Displaying verification results',
  },

  result: {
    statusVerifying: 'Verifying...',
    typing: 'Typing',
    pasteCount: 'Paste Count',
    externalInput: 'External Input',
    hashChain: 'Hash Chain',
    verificationMethod: 'Verification Method',
    eventCount: 'Event Count',
    posw: 'PoSW',
    iterations: 'Iterations',
    totalTime: 'Total Time',
    humanAttestation: 'Human Attestation',
    createTime: 'Created',
    exportTime: 'Exported',
  },

  chain: {
    valid: 'Valid',
    invalid: 'Invalid',
    samplingUsed: 'Sampling verification used ${count} checkpoints',
    fullVerification: 'Full event verification',
    verifiedSuccessfully: '${count} events',
    verificationFailed: 'Hash chain verification failed',
    events: 'events',
  },

  posw: {
    verified: 'Verified',
    failed: 'Failed',
    none: 'None',
    allEventsVerified: 'PoSW verified for all ${count} events',
    chainFailedPoswInvalid: 'PoSW invalid due to hash chain failure',
    noPoswMessage: 'This proof file does not contain PoSW',
    iterationsPerEvent: 'iter/event',
    seconds: 's',
  },

  metadata: {
    pureTyping: 'Pure typing input',
    externalInputDetected: 'External input detected',
    noPasteDetected: 'No paste detected',
    pasteDropCount: '${paste} pastes / ${drop} drops',
  },

  attestation: {
    valid: 'Valid',
    invalid: 'Invalid',
    none: 'None',
    verifiedLegacy: 'Verified (legacy)',
    exportTimeAuth: 'Authenticated at export',
    noAttestation: 'No human attestation',
  },

  statusBar: {
    ready: 'Ready',
    verifying: 'Verifying ${current}/${total}',
  },

  charts: {
    timeline: 'Timeline',
    mouseTrajectory: 'Mouse Trajectory',
    keys: 'Keys',
    dwell: 'Dwell',
    flight: 'Flight',
    mouse: 'Mouse',
  },

  seekbar: {
    start: 'Start',
    prev: 'Previous',
    play: 'Play',
    pause: 'Pause',
    next: 'Next',
    end: 'End',
  },

  errors: {
    accessDenied: 'Access Denied',
    fileReadError: 'File read error',
    folderReadError: 'Folder read error',
    browserNotSupported:
      'File System Access API is only available in Chrome / Edge',
    browserNotSupportedDesc:
      'Please use file selection or drag and drop instead',
  },

  messages: {
    folderOpened: 'Folder opened',
    fileAdded: 'File added',
    fileUpdated: 'File updated',
    fileDeleted: 'File deleted',
    folderAdded: 'Folder added',
    folderDeleted: 'Folder deleted',
  },

  plaintext: {
    readOnly: 'Read-only',
  },

  dialog: {
    loadingData: 'Loading data...',
    pleaseWait: 'Please wait',
  },

  about: {
    title: 'About TypedCode Verify',
    appVersion: 'App Version',
    proofVersion: 'Proof Format',
    storageVersion: 'Storage Format',
    commit: 'Commit',
    lastUpdate: 'Last Update',
    buildDate: 'Build Date',
    viewOnGithub: 'View on GitHub',
  },
};
