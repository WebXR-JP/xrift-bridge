/**
 * 自ウィンドウの診断環境の採取。React・R3F に依存しない。
 *
 * 他ウィンドウの属性は読まず、自ウィンドウの値だけを使う。
 * ホスト DOM の探索・改変はしない。
 *
 * @packageDocumentation
 */
import type { DiagnosticEnv } from "./session.ts";

/**
 * 自ウィンドウの環境を採取する。
 *
 * `window` が無い実行系（単体試験など）では不明値の写しを返す。
 *
 * @returns origin・SecureContext・top-level 判定の写し。
 */
export function captureWindowEnv(): DiagnosticEnv {
  if (typeof window === "undefined") {
    return { origin: "unknown", secureContext: false, topLevel: false };
  }
  return {
    origin: window.location.origin,
    secureContext: window.isSecureContext,
    // ADR: 他ウィンドウの属性は読まず、参照の等価比較だけ行う。
    topLevel: window.top === window.self,
  };
}
