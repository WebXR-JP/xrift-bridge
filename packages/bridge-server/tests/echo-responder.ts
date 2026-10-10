/**
 * 公開 Session API で付ける試験用応答器。
 *
 * 開始した reliable Session を購読し、受信した payload をそのまま返す。
 * 内容の解釈はしない。サーバ側に既定の受信処理はなく、往復が必要な試験は
 * この応答器を付けて成立させる。
 *
 * @packageDocumentation
 */
import type { BridgeServer, BridgeSessionInfo } from "../src/server.ts";

/**
 * 試験用応答器を付ける。
 *
 * 既存セッションを初期走査し、以後の開始通知で追随する。
 *
 * @param server - 起動中のブリッジ。
 * @returns 応答器の購読解除。
 */
export function attachEchoResponder(server: BridgeServer): () => void {
  const attached = new Set<string>();
  const attach = (info: BridgeSessionInfo): void => {
    if (info.kind !== "reliable") return;
    if (attached.has(info.localSessionId)) return;
    attached.add(info.localSessionId);
    const session = server.getSession(info.localSessionId);
    if (session === undefined || session.kind !== "reliable") return;
    session.onMessage((payload) => {
      // ADR: 応答の送出失敗は Session 終端として扱い、ここで待機を作らない。
      void session.sendReliable(payload).catch(() => {
        // 送出失敗は Session が既に終端している場合が多く、何もしない。
      });
    });
  };
  for (const info of server.listSessions()) {
    attach(info);
  }
  return server.onManagementEvent((event) => {
    if (event.kind === "session-started") {
      attach(event.session);
    }
  });
}
