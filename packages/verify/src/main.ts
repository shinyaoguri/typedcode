/**
 * TypedCode Verify - New VSCode-like UI Entry Point
 */

import { AppController } from './ui/AppController';
import { initDOMi18n } from './i18n/index';

// Initialize the application when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  // Initialize i18n first
  initDOMi18n();

  new AppController();
});
