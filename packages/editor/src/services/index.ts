/**
 * Services Module
 *
 * Provides shared utility services for the editor.
 */

export {
  downloadString,
  downloadJson,
  downloadBlob,
  generateTimestamp,
  generateFilename,
  type DownloadOptions,
} from './DownloadService.js';

export {
  SingleInstanceGuard,
  showDuplicateInstanceOverlay,
  hideDuplicateInstanceOverlay,
} from './SingleInstanceGuard.js';
