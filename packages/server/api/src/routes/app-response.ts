import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";

export interface BridgeContext {
  chatId: string;
  appName: string;
  bridgeKey: string;
  capabilities: string[];
}

/**
 * Vite emits module script tags without nonces. With `strict-dynamic`, the
 * entry bundle only runs when every script tag carries the request nonce.
 */
export function applyScriptNonce(html: string, nonce: string): string {
  return html.replace(
    /<script\b(?![^>]*\bnonce=)([^>]*)>/g,
    `<script nonce="${nonce}"$1>`,
  );
}

/**
 * Body of the iframe-side bridge. Exposed for tests; `injectBridge` wraps it
 * in an IIFE with the per-session payload and CSP nonce.
 */
export const BRIDGE_SCRIPT_BODY = `const t="roomy.app.request";const r="roomy.app.response";const s="roomy.app.resize";let n=0;const p=new Map;function q(method,params){return new Promise((resolve,reject)=>{const id=Date.now()+":"+(++n);p.set(id,{resolve,reject});window.parent.postMessage({type:t,id,key:c.bridgeKey,method,params},"*")})}window.addEventListener("message",e=>{const m=e.data;if(!m||m.type!==r||!p.has(m.id))return;const h=p.get(m.id);p.delete(m.id);m.ok?h.resolve(m.result):h.reject(new Error(m.error||"Roomy app bridge request failed"))});const storage={list(collection){return q("storage.list",{collection})},get(collection,id){return q("storage.get",{collection,id})},create(collection,doc){return q("storage.create",{collection,doc})},put(collection,id,doc){return q("storage.put",{collection,id,doc})},delete(collection,id){return q("storage.delete",{collection,id})}};const chat={sendMessage(text,opts){return q("chat.sendMessage",{text,artifactRefMessageId:opts&&opts.artifactRefMessageId})}};function u(){const b=document.body;const h=Math.ceil(Math.max(b?b.scrollHeight:0,b?b.offsetHeight:0));window.parent.postMessage({type:s,key:c.bridgeKey,height:h},"*")}let o=0;function v(){if(o)return;o=requestAnimationFrame(()=>{o=0;u()})}function w(){u();if(typeof ResizeObserver!=="undefined"){const ro=new ResizeObserver(v);if(document.body)ro.observe(document.body);if(document.documentElement)ro.observe(document.documentElement);window.addEventListener("load",v,{once:true});if(document.fonts&&document.fonts.ready)document.fonts.ready.then(v)}else{window.addEventListener("resize",v);window.addEventListener("load",v,{once:true})}}if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",w,{once:true})}else{w()}window.roomy={app:c.app,chatId:c.chatId,capabilities:c.capabilities,storage,chat,fetch(){throw new Error("roomy.fetch is not enabled; use explicit window.roomy capabilities")}};`;

export function injectBridge(html: string, ctx: BridgeContext, nonce: string): string {
  const payload = JSON.stringify({
    app: { name: ctx.appName },
    chatId: ctx.chatId,
    bridgeKey: ctx.bridgeKey,
    capabilities: ctx.capabilities,
  }).replace(/</g, "\\u003c");
  const script = `<script nonce="${nonce}">(()=>{const c=${payload};${BRIDGE_SCRIPT_BODY}})();</script>`;
  return html.includes("</head>")
    ? html.replace("</head>", `${script}</head>`)
    : script + html;
}

export function nonceForRequest(): string {
  return randomBytes(16).toString("base64");
}

export function setSecurityHeaders(res: ServerResponse, nonce: string): void {
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
  res.setHeader("Content-Security-Policy", csp);
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()",
  );
}
