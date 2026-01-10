import type { VerifyTranslationKeys } from '../types';

export const en: VerifyTranslationKeys = {
  common: {
    cancel: 'Cancel',
    close: 'Close',
    ready: 'Ready',
    verifying: 'Verifying',
    files: 'files',
    file: 'file',
    reset: 'Reset',
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
    pasteCount: 'External Paste',
    internalPasteCount: 'Internal Paste',
    externalInput: 'External Input',
    hashChain: 'Hash Chain',
    verificationMethod: 'Verification Method',
    eventCount: 'Event Count',
    screenshotVerification: 'Screenshots',
    screenshotsAllVerified: '✓ ${verified}/${total} verified',
    screenshotsSomeInvalid: '⚠ ${invalid}/${total} possibly tampered',
    screenshotsCount: '${count} screenshots',
    posw: 'PoSW',
    iterations: 'Iterations',
    totalTime: 'Total Time',
    humanAttestation: 'Human Attestation',
    createTime: 'Created',
    exportTime: 'Exported',
    typingPattern: 'Typing Pattern',
  },

  chain: {
    valid: 'Valid',
    invalid: 'Invalid',
    samplingUsed: 'Sampling verification used ${count} checkpoints',
    fullVerification: 'Full event verification',
    verifiedSuccessfully: '${count} events',
    verificationFailed: 'Hash chain verification failed',
    events: 'events',
    errorDetails: {
      header: 'Error Details',
      position: 'Error Position',
      type: 'Error Type',
      message: 'Message',
      expectedHash: 'Expected Hash',
      computedHash: 'Computed Hash',
      timestampDetail: 'Timestamp',
      errorTypes: {
        sequence: 'Sequence Number Error',
        timestamp: 'Timestamp Error',
        previousHash: 'Previous Hash Mismatch',
        posw: 'PoSW Verification Failed',
        hash: 'Hash Mismatch',
        segmentEnd: 'Segment End Hash Mismatch',
        unknown: 'Unknown Error',
      },
    },
    segmentViz: {
      header: 'Verification Segments',
      verified: 'Verified',
      unverified: 'Unverified',
      error: 'Error',
      segmentInfo: 'Segment ${index}: Events ${start} - ${end} (${count})',
      totalEvents: 'Total events: ${count}',
      verifiedEvents: 'Verified: ${count}',
      sampledSegments: 'Sampled segments: ${count}/${total}',
    },
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
    integrated: 'Integrated Chart',
    timeline: 'Timeline',
    mouseTrajectory: 'Mouse Trajectory',
    keys: 'Keys',
    dwell: 'Dwell',
    flight: 'Flight',
    mouse: 'Mouse',
    eventFilter: 'Event Filter',
    categories: {
      content: 'Content',
      cursor: 'Cursor',
      input: 'Input',
      window: 'Window',
      system: 'System',
      auth: 'Authentication',
      execution: 'Execution',
      capture: 'Capture',
    },
    events: {
      contentChange: 'Content Change',
      contentSnapshot: 'Content Snapshot',
      externalInput: 'External Input',
      cursorPositionChange: 'Cursor Position Change',
      selectionChange: 'Selection Change',
      keyDown: 'Key Down',
      keyUp: 'Key Up',
      mousePositionChange: 'Mouse Move',
      focusChange: 'Focus Change',
      visibilityChange: 'Visibility Change',
      windowResize: 'Window Resize',
      editorInitialized: 'Editor Initialized',
      networkStatusChange: 'Network Status Change',
      humanAttestation: 'Human Attestation',
      preExportAttestation: 'Pre-Export Attestation',
      termsAccepted: 'Terms Accepted',
      codeExecution: 'Code Execution',
      terminalInput: 'Terminal Input',
      screenshotCapture: 'Screenshot Capture',
      screenShareStart: 'Screen Share Start',
      screenShareStop: 'Screen Share Stop',
      templateInjection: 'Template Injection',
    },
  },

  pattern: {
    title: 'Typing Pattern',
    score: 'Score',
    confidence: 'Confidence',
    detailedAnalysis: 'Detailed Analysis',
    human: 'Human-like',
    uncertain: 'Uncertain',
    suspicious: 'Suspicious',
    criticalIssues: 'Critical Issues',
    warnings: 'Warnings',
    summary: {
      human: 'Typing pattern shows human-like characteristics',
      suspicious: 'Possible automated or fraudulent input detected',
      uncertain: 'Some patterns are unclear',
      insufficientData: 'Insufficient data for analysis',
    },
    insufficient: 'Insufficient data',
    dwellConsistency: {
      normal: 'Key press duration variation is within natural range',
      tooConsistent: 'Key press duration is unnaturally consistent - possible automation',
      highVariation: 'High variation in key press duration',
    },
    flightTime: {
      normal: 'Inter-key timing shows human-like distribution',
      tooUniform: 'Inter-key timing is too uniform - mechanical pattern',
      unusual: 'Unusual inter-key timing distribution',
    },
    rhythm: {
      normal: 'Natural variation in typing rhythm',
      tooConsistent: 'Typing rhythm is unnaturally consistent',
      periodic: 'Periodic pattern detected - possible automation',
      highVariation: 'High variation in typing rhythm',
    },
    speed: {
      normal: 'Natural variation in typing speed',
      tooConsistent: 'Typing speed is unnaturally consistent',
      highVariation: 'High variation in typing speed',
    },
    pause: {
      normal: 'Natural pause pattern',
      noPauses: 'No pauses during extended typing - unnatural',
      tooMany: 'Too many pauses',
    },
    burst: {
      normal: 'Natural continuous typing pattern',
      tooUniform: 'Burst lengths are unnaturally uniform',
      tooLong: 'Very long continuous typing without pauses',
    },
    error: {
      normal: 'Moderate error correction pattern',
      noCorrections: 'Almost no error corrections - unnatural',
      tooMany: 'Too many error corrections',
    },
    charTiming: {
      normal: 'Natural timing variation based on key position',
      tooUniform: 'All keys have uniform timing - unnatural',
    },
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
