import { describe, it, expect } from "vitest";
import { BRIDGE_SCRIPT_BODY } from "../src/routes/apps.js";

/**
 * The bridge script is injected into every iframe-served app HTML and runs
 * inside an opaque-origin sandbox. We can't easily JSDOM the whole thing
 * (it touches ResizeObserver, document.fonts, requestAnimationFrame), so we
 * pin the load-bearing pieces by string match. These are the invariants
 * that, if broken, cause the "iframe is short, content scrolls inside"
 * class of bug the wizard fragment hit.
 */
describe("BRIDGE_SCRIPT_BODY", () => {
  it("measures body dimensions to size the iframe to actual content", () => {
    // body.scrollHeight/offsetHeight reflect actual content size regardless
    // of the iframe viewport. documentElement.scrollHeight (and
    // getBoundingClientRect) used to be in the max() but they're at minimum
    // the html element's rendered box — which by default fills the iframe
    // viewport — so once the iframe grew they would keep reporting that
    // larger size forever (a one-way ratchet preventing later, shorter
    // wizard steps from shrinking the iframe back down).
    expect(BRIDGE_SCRIPT_BODY).toContain("b.scrollHeight");
    expect(BRIDGE_SCRIPT_BODY).toContain("b.offsetHeight");
    expect(BRIDGE_SCRIPT_BODY).not.toContain("d.scrollHeight");
    expect(BRIDGE_SCRIPT_BODY).not.toContain("getBoundingClientRect");
  });

  it("observes both documentElement and body for resizes", () => {
    // We still observe the html element so layout changes that resize it
    // (e.g. viewport-relative children) re-fire the measurement function.
    expect(BRIDGE_SCRIPT_BODY).toContain("ro.observe(document.body)");
    expect(BRIDGE_SCRIPT_BODY).toContain("ro.observe(document.documentElement)");
  });

  it("re-measures after fonts settle so font-induced shifts don't leave a stale height", () => {
    expect(BRIDGE_SCRIPT_BODY).toContain("document.fonts");
    expect(BRIDGE_SCRIPT_BODY).toContain("document.fonts.ready.then(v)");
  });

  it("posts a desk.app.resize message keyed to the bridge", () => {
    expect(BRIDGE_SCRIPT_BODY).toContain('"desk.app.resize"');
    expect(BRIDGE_SCRIPT_BODY).toContain("key:c.bridgeKey");
  });

  it("does not break out of its surrounding script tag", () => {
    // Defense in depth: the body is concatenated into a `<script>` tag and
    // must not contain a closing tag, comment opener, or CDATA opener.
    expect(BRIDGE_SCRIPT_BODY).not.toMatch(/<\/script/i);
    expect(BRIDGE_SCRIPT_BODY).not.toContain("<!--");
    expect(BRIDGE_SCRIPT_BODY).not.toContain("<![CDATA[");
  });
});
