// @vitest-environment happy-dom
/**
 * Activity Bar のメニューボタン (`#main-menu-btn` / `#settings-btn`) の a11y (#743)。
 * popup を持つことを `aria-haspopup` で示し、`aria-expanded` が開閉 (`.visible`) に追従する。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MainMenuDropdown } from '../MainMenuDropdown.js';
import { SettingsDropdown } from '../SettingsDropdown.js';

const menus = [
  { name: 'MainMenuDropdown', Ctor: MainMenuDropdown, buttonId: 'main-menu-btn', dropdownId: 'main-menu-dropdown' },
  { name: 'SettingsDropdown', Ctor: SettingsDropdown, buttonId: 'settings-btn', dropdownId: 'settings-dropdown' },
] as const;

describe.each(menus)('$name aria-expanded', ({ Ctor, buttonId, dropdownId }) => {
  let menu: MainMenuDropdown | SettingsDropdown;
  const button = (): HTMLElement => document.getElementById(buttonId)!;
  const expanded = (): string | null => button().getAttribute('aria-expanded');

  beforeEach(() => {
    document.body.innerHTML = `
      <button id="${buttonId}" aria-controls="${dropdownId}">menu</button>
      <div id="${dropdownId}"><button id="item">item</button></div>
      <button id="outside">outside</button>`;
    menu = new Ctor();
    menu.initialize({ buttonId, dropdownId });
  });

  afterEach(() => {
    menu.dispose();
    document.body.innerHTML = '';
  });

  it('marks the button as opening a popup and starts collapsed', () => {
    expect(button().getAttribute('aria-haspopup')).toBe('true');
    expect(expanded()).toBe('false');
  });

  it('reports "true" while the menu is open and "false" after the button closes it again', () => {
    button().click();
    expect(menu.isVisible).toBe(true);
    expect(expanded()).toBe('true');
    button().click();
    expect(menu.isVisible).toBe(false);
    expect(expanded()).toBe('false');
  });

  it('reports "false" after a click outside the menu closes it', () => {
    button().click();
    document.getElementById('outside')!.click();
    expect(menu.isVisible).toBe(false);
    expect(expanded()).toBe('false');
  });

  it('follows open() and close() called by menu items', () => {
    menu.open();
    expect(expanded()).toBe('true');
    menu.close();
    expect(expanded()).toBe('false');
  });
});
