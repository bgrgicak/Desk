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
  it("measures documentElement, not just body", () => {
    // body.scrollHeight understates when a min-height + flex-center child
    // is taller than the min — documentElement always reflects the real
    // layout box.
    expect(BRIDGE_SCRIPT_BODY).toContain("documentElement");
    expect(BRIDGE_SCRIPT_BODY).toContain("d.scrollHeight");
  });

  it("observes both documentElement and body for resizes", () => {
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
