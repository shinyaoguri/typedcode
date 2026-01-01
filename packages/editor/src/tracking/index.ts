/**
 * Tracking Module
 *
 * Provides user behavior tracking components for the editor.
 */

export {
  KeystrokeTracker,
  type KeystrokeThresholds,
  type KeystrokeEvent,
  type KeystrokeEventCallback,
} from './KeystrokeTracker.js';

export {
  MouseTracker,
  type MouseEvent,
  type MouseEventCallback,
  type MouseTrackerOptions,
} from './MouseTracker.js';

export { InputDetector } from './InputDetector.js';
export { OperationDetector } from './OperationDetector.js';
export { WindowTracker } from './WindowTracker.js';
export { VisibilityTracker } from './VisibilityTracker.js';
export {
  NetworkTracker,
  type NetworkTrackerEvent,
  type NetworkTrackerCallback,
} from './NetworkTracker.js';
export {
  ScreenshotTracker,
  type ScreenshotTrackerEvent,
  type ScreenshotTrackerCallback,
  type ScreenshotTrackerOptions,
} from './ScreenshotTracker.js';
export {
  initializeTrackers,
  type RecordEventCallback,
} from './TrackersInitializer.js';
