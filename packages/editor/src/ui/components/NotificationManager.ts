/**
 * Notification Manager
 *
 * Handles displaying temporary notification messages to the user.
 */

export interface NotificationOptions {
  /** Duration in milliseconds to show the notification (default: 2000) */
  duration?: number;
  /** CSS class to add to the notification element */
  className?: string;
}

export class NotificationManager {
  private notificationEl: HTMLElement | null = null;
  private messageEl: HTMLElement | null = null;
  private hideTimeout: ReturnType<typeof setTimeout> | null = null;

  /**
   * Initialize the notification manager with DOM elements
   *
   * @param notificationElementId - ID of the notification container element
   * @param messageElementId - ID of the message text element
   */
  constructor(
    notificationElementId: string = 'block-notification',
    messageElementId: string = 'block-message'
  ) {
    this.notificationEl = document.getElementById(notificationElementId);
    this.messageEl = document.getElementById(messageElementId);

    if (!this.notificationEl) {
      console.warn(`[NotificationManager] Element #${notificationElementId} not found`);
    }
    if (!this.messageEl) {
      console.warn(`[NotificationManager] Element #${messageElementId} not found`);
    }
  }

  /**
   * Show a notification message
   *
   * @param message - Message to display
   * @param options - Optional configuration
   */
  show(message: string, options: NotificationOptions = {}): void {
    const { duration = 2000, className } = options;

    // Clear any existing timeout
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }

    // Update message
    if (this.messageEl) {
      this.messageEl.textContent = message;
    }

    // Add custom class if provided
    if (className && this.notificationEl) {
      this.notificationEl.classList.add(className);
    }

    // Show notification
    this.notificationEl?.classList.remove('hidden');

    // Auto-hide after duration
    this.hideTimeout = setTimeout(() => {
      this.hide();
      // Remove custom class if it was added
      if (className && this.notificationEl) {
        this.notificationEl.classList.remove(className);
      }
    }, duration);
  }

  /**
   * Hide the current notification
   */
  hide(): void {
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }
    this.notificationEl?.classList.add('hidden');
  }

  /**
   * Show a success notification
   */
  success(message: string, duration?: number): void {
    this.show(message, { duration, className: 'notification-success' });
  }

  /**
   * Show an error notification
   */
  error(message: string, duration?: number): void {
    this.show(message, { duration: duration ?? 3000, className: 'notification-error' });
  }

  /**
   * Show an info notification
   */
  info(message: string, duration?: number): void {
    this.show(message, { duration, className: 'notification-info' });
  }

  /**
   * Check if notification elements are available
   */
  isAvailable(): boolean {
    return this.notificationEl !== null && this.messageEl !== null;
  }
}

// Singleton instance
let instance: NotificationManager | null = null;

/**
 * Get the singleton NotificationManager instance
 */
export function getNotificationManager(): NotificationManager {
  if (!instance) {
    instance = new NotificationManager();
  }
  return instance;
}

/**
 * Initialize NotificationManager with custom element IDs
 */
export function initNotificationManager(
  notificationElementId?: string,
  messageElementId?: string
): NotificationManager {
  instance = new NotificationManager(notificationElementId, messageElementId);
  return instance;
}

/**
 * Convenience function to show a notification
 */
export function showNotification(message: string, options?: NotificationOptions): void {
  getNotificationManager().show(message, options);
}
