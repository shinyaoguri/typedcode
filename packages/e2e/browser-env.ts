/**
 * 通常の E2E のブラウザの言語とタイムゾーン (#597)。明示しないと Playwright は locale を en-US、
 * timezone を実行プロセスの TZ から取るので、CI (UTC) と手元 (JST など) で日時の表示や処理の条件が変わる。
 * 値はいまの CI の挙動 (en-US・UTC) に合わせて固定し、3 つの config (playwright.config.ts /
 * playwright.build.config.ts / playwright.deployed.config.ts) の `use` が同じものを読む。
 * ja の UI を通す spec は `test.use({ locale: 'ja-JP', timezoneId: 'Asia/Tokyo' })` で個別に上書きする
 * (tests/happy-path-ja.spec.ts)。
 */
export const E2E_BROWSER_ENV = {
  locale: 'en-US',
  timezoneId: 'UTC',
} as const;
