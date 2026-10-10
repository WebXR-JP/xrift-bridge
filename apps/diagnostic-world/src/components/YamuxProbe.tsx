/**
 * yamux 探針の開発専用操作盤。開発文書内の自ツリーに描く。
 *
 * 本番 `./World` からは import しない。既存の `DiagnosticPanel`・
 * `DiagnosticSession` とは通信を共用せず、spike-server への疎通だけを
 * 確かめる。接続はボタン操作時のみ行い、自動接続・自動再接続はしない。
 * 送受信した値の中身は画面・console・証拠に残さず、応答の有無と
 * ping 往復時間だけを残す。ホスト DOM の探索・改変はしない。
 *
 * @packageDocumentation
 */
import { useEffect, useRef, useState } from "react";
import { runBrowserProbe } from "yamux-spike/browser-probe";
import type { BrowserProbeSession } from "yamux-spike/browser-probe";
import "./YamuxProbe.css";

/** 接続先の既定値。spike-server の待ち受けに合わせる。 */
export const YAMUX_PROBE_DEFAULT_URL = "ws://127.0.0.1:5180/spike";

/**
 * yamux 探針の操作盤。接続先・接続・応答確認・行ログを自ツリーに描く。
 *
 * @returns 操作盤要素。
 */
export function YamuxProbe(): React.JSX.Element {
  const [url, setUrl] = useState<string>(YAMUX_PROBE_DEFAULT_URL);
  const [lines, setLines] = useState<readonly string[]>([]);
  const [connected, setConnected] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  // ADR: 確立済み探針の所有はこの ref が持つ。描画時の生成物を effect が
  // 破棄する構成（StrictMode 再実行で破棄済み個体へ再接続する）は採らず、
  // unmount 時のみ閉じる。
  const sessionRef = useRef<BrowserProbeSession | null>(null);

  useEffect(
    () => (): void => {
      sessionRef.current?.close();
      sessionRef.current = null;
    },
    [],
  );

  /** 行ログへ1行足す。値の中身は呼び出し側で入れないこと。 */
  const appendLine = (line: string): void => {
    setLines((prev) => [...prev, line]);
  };

  const handleConnect = (): void => {
    if (busy || connected) return;
    setBusy(true);
    void (async () => {
      try {
        appendLine(`接続を開始する: ${url}`);
        const session = await runBrowserProbe(url, appendLine);
        sessionRef.current = session;
        setConnected(true);
        appendLine("Yamux接続が確立した。echo+ping で疎通を確かめられる。");
      } catch (cause) {
        appendLine(
          `Yamux接続に失敗した: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      } finally {
        setBusy(false);
      }
    })();
  };

  const handleProbe = (): void => {
    const session = sessionRef.current;
    if (session === null || busy) return;
    setBusy(true);
    void (async () => {
      try {
        const result = await session.probeEchoPing();
        appendLine(`echo応答あり。ping往復: ${String(result.rttMs)}ms`);
      } catch (cause) {
        appendLine(
          `echo+pingに失敗した: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div className="diag-panel yamux-panel" aria-label="yamux探針パネル">
      <h1 className="diag-title">yamux探針（開発専用）</h1>
      <section className="diag-section" aria-label="接続先">
        <h2>接続先</h2>
        <label className="diag-row">
          接続先
          <input
            className="yamux-url"
            type="text"
            value={url}
            disabled={connected || busy}
            onChange={(event) => {
              setUrl(event.target.value);
            }}
          />
        </label>
      </section>
      <section className="diag-section" aria-label="探針操作">
        <h2>操作</h2>
        <div className="diag-buttons">
          <button
            id="yamux-connect"
            type="button"
            disabled={connected || busy}
            onClick={handleConnect}
          >
            Yamux接続
          </button>
          <button id="yamux-ping" type="button" disabled={!connected || busy} onClick={handleProbe}>
            Yamux echo+ping
          </button>
        </div>
        {!connected && <p className="diag-note">未接続時のみ接続先を変更できる。</p>}
      </section>
      <section className="diag-section" aria-label="探針ログ">
        <h2>ログ</h2>
        <pre className="diag-log" aria-live="polite">
          {lines.join("\n")}
        </pre>
        <p className="diag-note">
          spike-server への疎通確認用。値の中身は残さず、応答の有無と ping 往復時間だけを残す。本番
          World には含めない。
        </p>
      </section>
    </div>
  );
}
