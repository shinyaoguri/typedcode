// DOM要素のキャッシュ

// ドロップゾーン
export const dropZone = document.getElementById('drop-zone');
export const dropZoneSection = document.querySelector('.drop-zone-section') as HTMLElement | null;
export const fileInput = document.getElementById('file-input') as HTMLInputElement | null;

// 結果セクション
export const resultSection = document.getElementById('result-section');
export const statusCard = document.getElementById('status-card');
export const statusIcon = document.getElementById('status-icon');
export const statusTitle = document.getElementById('status-title');
export const statusMessage = document.getElementById('status-message');

// 結果表示要素
export const typingProofHashEl = document.getElementById('typing-proof-hash');
export const copyHashBtn = document.getElementById('copy-hash-btn');
export const pureTypingBadge = document.getElementById('pure-typing-badge');
export const pasteInfo = document.getElementById('paste-info');
export const deviceIdEl = document.getElementById('device-id');
export const totalEventsEl = document.getElementById('total-events');
export const insertEventsEl = document.getElementById('insert-events');
export const deleteEventsEl = document.getElementById('delete-events');
export const typingTimeEl = document.getElementById('typing-time');
export const typingSpeedEl = document.getElementById('typing-speed');
export const chainValidBadge = document.getElementById('chain-valid-badge');
export const chainMessage = document.getElementById('chain-message');
export const poswValidBadge = document.getElementById('posw-valid-badge');
export const poswMessage = document.getElementById('posw-message');
export const poswIterationsEl = document.getElementById('posw-iterations');
export const poswAvgTimeEl = document.getElementById('posw-avg-time');
export const poswTotalTimeEl = document.getElementById('posw-total-time');
export const versionEl = document.getElementById('version');
export const languageEl = document.getElementById('language');
export const timestampEl = document.getElementById('timestamp');
export const userAgentEl = document.getElementById('user-agent');
export const contentPreview = document.getElementById('content-preview');
export const verifyAgainBtn = document.getElementById('verify-again-btn');
export const externalInputPreview = document.getElementById('external-input-preview');
export const externalInputList = document.getElementById('external-input-list');

// チャート関連
export const typingSpeedChart = document.getElementById('typing-speed-chart');
export const speedChartCanvas = document.getElementById('speed-chart') as HTMLCanvasElement | null;
export const integratedTimeline = document.getElementById('integrated-timeline');
export const integratedTimelineCanvas = document.getElementById('integrated-timeline-chart') as HTMLCanvasElement | null;
export const mouseTrajectorySection = document.getElementById('mouse-trajectory-section');
export const mouseTrajectoryCanvas = document.getElementById('mouse-trajectory-chart') as HTMLCanvasElement | null;

// 統計要素
export const mouseEventCountEl = document.getElementById('mouse-event-count');
export const focusEventCountEl = document.getElementById('focus-event-count');
export const visibilityEventCountEl = document.getElementById('visibility-event-count');
export const keyDownCountEl = document.getElementById('keydown-count');
export const avgDwellTimeEl = document.getElementById('avg-dwell-time');
export const avgFlightTimeEl = document.getElementById('avg-flight-time');

// シークバー要素
export const floatingSeekbar = document.getElementById('floating-seekbar');
export const seekbarSlider = document.getElementById('seekbar-slider') as HTMLInputElement | null;
export const seekbarProgress = document.getElementById('seekbar-progress');
export const seekbarTime = document.getElementById('seekbar-time');
export const seekbarEventCount = document.getElementById('seekbar-event-count');
export const seekbarStart = document.getElementById('seekbar-start');
export const seekbarPrev = document.getElementById('seekbar-prev');
export const seekbarPlay = document.getElementById('seekbar-play');
export const playIcon = document.getElementById('play-icon');
export const seekbarNext = document.getElementById('seekbar-next');
export const seekbarEnd = document.getElementById('seekbar-end');
