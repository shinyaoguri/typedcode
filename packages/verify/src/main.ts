/**
 * TypedCode Verify - New VSCode-like UI Entry Point
 */

import { AppController } from './ui/AppController';

// Initialize the application when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  new AppController();
});
