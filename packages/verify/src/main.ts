/**
 * TypedCode Verify - New VSCode-like UI Entry Point
 */

import { AppController } from './ui/AppController';
import { initDOMi18n, t } from './i18n/index';

// 機能別アクセント (要望: ぱっと見で機能を判別)。検証アプリ = 緑。
document.documentElement.setAttribute('data-feature', 'verify');

// Initialize the application when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  // Initialize i18n first
  initDOMi18n();

  // 機能バッジを sidebar-header に挿入。
  const badge = document.createElement('span');
  badge.className = 'feature-badge';
  badge.innerHTML = `<i class="fas fa-circle-check"></i> ${t('feature.verify')}`;
  document.querySelector('.sidebar-header')?.prepend(badge);

  new AppController();
});
