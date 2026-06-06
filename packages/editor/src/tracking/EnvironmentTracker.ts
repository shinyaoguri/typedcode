/**
 * EnvironmentTracker - 環境/自動化プローブ (ADR-0007 Tier 0 B 群)
 *
 * 起動時にワンショットで `navigator.webdriver` と自動化由来のグローバル痕跡を捕捉する。
 * リスナーは持たない (attach/detach は no-op)。両モード共通で記録する (ADR-0007 は捕捉を
 * 両モード同一とする)。fingerprint が既に持つ環境値は重複させない。
 */

import type { EnvironmentProbeData } from '@typedcode/shared';
import { t } from '../i18n/index.js';
import { BaseTracker } from './BaseTracker.js';

export interface EnvironmentTrackerEvent {
  type: 'environmentProbe';
  data: EnvironmentProbeData;
  description: string;
}

export type EnvironmentTrackerCallback = (
  event: EnvironmentTrackerEvent,
  isInitial: boolean
) => void;

/** 既知の自動化由来グローバル名 (存在すれば自動化ブラウザの痕跡)。 */
const AUTOMATION_GLOBAL_HINTS = [
  '__playwright',
  '__puppeteer',
  '__pw_manual',
  '__nightmare',
  '_phantom',
  'phantom',
  'callPhantom',
  'domAutomation',
  'domAutomationController',
  '__selenium_unwrapped',
  '__webdriver_evaluate',
  '__driver_evaluate',
  '__webdriver_script_fn',
  '_Selenium_IDE_Recorder',
] as const;

export class EnvironmentTracker extends BaseTracker<
  EnvironmentTrackerEvent,
  EnvironmentTrackerCallback
> {
  protected attachListeners(): void {
    // ワンショットのためリスナーは無い
  }

  protected detachListeners(): void {
    // ワンショットのためリスナーは無い
  }

  /** 起動時に環境/自動化シグナルをワンショットで記録する。 */
  recordInitial(): void {
    const data = this.capture();
    this.callback?.(
      {
        type: 'environmentProbe',
        data,
        description: t('events.environmentProbe', { webdriver: String(data.webdriver) }),
      },
      true
    );
  }

  private capture(): EnvironmentProbeData {
    const webdriver: boolean | null =
      typeof navigator.webdriver === 'boolean' ? navigator.webdriver : null;

    const automationGlobals: string[] = [];
    const w = window as unknown as Record<string, unknown>;
    for (const name of AUTOMATION_GLOBAL_HINTS) {
      if (name in w) automationGlobals.push(name);
    }
    for (const key of Object.keys(w)) {
      if (key.startsWith('cdc_') || key.startsWith('$cdc_')) automationGlobals.push(key);
    }

    return { webdriver, automationGlobals };
  }
}
