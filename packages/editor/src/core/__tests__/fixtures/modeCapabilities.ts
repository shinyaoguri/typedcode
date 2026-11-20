import type { EditorMode, ModeCapabilities } from '../../mode.js';

/**
 * モードごとの能力の現在値 (#645 の着手時点。`core/mode.ts` の `MODE_CAPABILITIES` の写し)。
 *
 * `.tcclass` の方針 (policy) を足す前に、入口 (`/class` `/assignment` ほか) が持っていた能力を固定する。
 * 方針の無い旧ファイルはこの値のまま開き、/author の「教室で実施」「持ち帰り」はそれぞれ class / assignment の
 * 値を生成する (#645 の受け入れ条件)。能力を意図して変えるときは、この写しも同じ PR で直す。
 */
export const MODE_CAPABILITIES_FIXTURE: Readonly<Record<EditorMode, Readonly<ModeCapabilities>>> = {
  casual: {
    sealedProblem: false,
    screenshots: true,
    promptScreenShareAtStart: false,
    fullscreenTracking: false,
    fullscreenBanner: false,
    tabLock: false,
    unifyDownloadToProblemPanel: false,
    problemPanel: false,
    preExportBestEffort: false,
    selfReview: true,
  },
  class: {
    sealedProblem: false,
    screenshots: true,
    promptScreenShareAtStart: true,
    fullscreenTracking: true,
    fullscreenBanner: false,
    tabLock: false,
    unifyDownloadToProblemPanel: false,
    problemPanel: true,
    preExportBestEffort: true,
    selfReview: true,
  },
  assignment: {
    sealedProblem: false,
    screenshots: false,
    promptScreenShareAtStart: false,
    fullscreenTracking: false,
    fullscreenBanner: false,
    tabLock: false,
    unifyDownloadToProblemPanel: false,
    problemPanel: true,
    preExportBestEffort: false,
    selfReview: true,
  },
  exam: {
    sealedProblem: true,
    screenshots: true,
    promptScreenShareAtStart: true,
    fullscreenTracking: true,
    fullscreenBanner: true,
    tabLock: true,
    unifyDownloadToProblemPanel: true,
    problemPanel: true,
    preExportBestEffort: true,
    selfReview: false,
  },
};
