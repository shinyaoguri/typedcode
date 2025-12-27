/**
 * UI Module
 *
 * Provides UI components for the editor application.
 */

// Components
export {
  NotificationManager,
  getNotificationManager,
  initNotificationManager,
  showNotification,
  type NotificationOptions,
} from './components/NotificationManager.js';

export {
  showModal,
  showConfirmDialog,
  showAlertDialog,
  TermsModalManager,
  getTermsModalManager,
  type ModalOptions,
  type ModalButton,
} from './components/Modal.js';
