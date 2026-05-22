/**
 * Generated previews are untrusted agent/user-authored HTML. Let scripts run
 * for realistic rendering, but do not grant same-origin access to Desk's
 * sessionStorage, localStorage, cookies, or parent DOM.
 *
 * `allow-popups` lets fragments open external links via `<a target="_blank">`
 * or `window.open()` — without it the browser silently blocks navigation on
 * regular click (only middle-click bypasses sandbox via the user-agent path),
 * which is the exact "link only works when middle-clicked" bug in chat-cards.
 * `allow-popups-to-escape-sandbox` ensures the opened tab is a normal browsing
 * context, not itself sandboxed (so the destination site works as expected).
 */
export const GENERATED_APP_IFRAME_SANDBOX =
  'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox';
