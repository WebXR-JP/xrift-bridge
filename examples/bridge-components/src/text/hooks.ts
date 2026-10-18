/**
 * テキスト受信の React バインディング。
 *
 * 生成・購読・破棄の所有は effect が持つ。接続が認可中のあいだだけ、認可済みの
 * 管理口からテキスト専用セッション（論理名 `text`、`reliable`・`bidirectional`）
 * を開いて `TextReceiver` を生成・購読する。切断・再接続・実アンマウント・
 * StrictMode 再実行では旧個体を破棄し、開いた専用セッションだけを中断する
 * （接続やほかのセッションは閉じない）。切断・再接続では本文を消す。
 *
 * @packageDocumentation
 */
import { useEffect, useState } from "react";
import { TEXT_SESSION_ID } from "bridge-plugin-text/contract";
import { WorldClientError, type ReliableSession } from "world-client";
import type { BridgeConnection } from "../connection/connection.ts";
import type { BridgeSnapshot } from "../connection/types.ts";
import { TextReceiver } from "./receiver.ts";
import type { TextSnapshot } from "./types.ts";

/** フックの引数。 */
export interface UseTextReceiverArgs {
  /** 接続手順。生成前は `null`。 */
  readonly connection: BridgeConnection | null;
  /** 接続状態の写し。生成前は `null`。 */
  readonly snapshot: BridgeSnapshot | null;
}

/**
 * テキスト受信を生成・購読する。
 *
 * 認可前・切断後・生成前は `receiver`・`snapshot` ともに `null` を返す。呼び出し側は
 * `null` のあいだ表示板を未受信表示にすること。
 *
 * @param args - 接続手順とその写し。
 * @returns 受信手順と最新の写し。待機・未受信時はどちらも `null`。
 */
export function useTextReceiver(args: UseTextReceiverArgs): {
  readonly receiver: TextReceiver | null;
  readonly snapshot: TextSnapshot | null;
} {
  const [receiver, setReceiver] = useState<TextReceiver | null>(null);
  const [snapshot, setSnapshot] = useState<TextSnapshot | null>(null);
  const phase = args.snapshot?.phase ?? null;
  useEffect(() => {
    // ADR: 生成・購読・破棄を同一 effect が所有する。描画時の生成物を effect が
    // 破棄する構成では、StrictMode の再実行で破棄済み個体へ再購読してしまう。
    // 接続手順の所有物には触れず、開いた専用セッションだけを中断する。
    const connection = args.connection;
    if (connection === null || phase !== "authorized") return;
    const provider = connection.getAuthorizedProvider();
    if (provider === null) return;
    let cancelled = false;
    let textSession: ReliableSession | null = null;
    let next: TextReceiver | null = null;
    let unsubscribe: (() => void) | null = null;
    const open = (): Promise<ReliableSession> =>
      provider.tryCreateSession({
        sessionId: TEXT_SESSION_ID,
        kind: "reliable",
        direction: "bidirectional",
      });
    const handleOpened = (opened: ReliableSession): void => {
      if (cancelled) {
        // ADR: effect 破棄後に開設が解けた専用セッションは残さない。同名再生成の
        // 重複を避けるため、当該セッションだけを中断する。
        try {
          opened.abort();
        } catch {
          // 後片付けの失敗は無視する。
        }
        return;
      }
      textSession = opened;
      next = new TextReceiver({ session: opened });
      unsubscribe = next.subscribe(setSnapshot);
      setReceiver(next);
      setSnapshot(next.getSnapshot());
    };
    const handleFailed = (): void => {
      // ADR: 専用セッションの開設失敗は局所化し、接続やほかのセッションを閉じない。
      // 表示は中断（本文なし）に留める。
      if (cancelled) return;
      setReceiver(null);
      setSnapshot({ status: "ended", text: null, id: null });
    };
    void open().then(handleOpened, (error: unknown) => {
      if (cancelled) return;
      // ADR: StrictMode 再実行では旧 effect の開設と新 effect の開設が競合し、
      // 同名重複で拒否され得る。旧個体の破棄による中断の後に一度だけ開設し直す。
      if (error instanceof WorldClientError && error.code === "DUPLICATE_SESSION") {
        void open().then(handleOpened, handleFailed);
        return;
      }
      handleFailed();
    });
    return () => {
      // ADR: 切断・再接続では本文を消す。旧個体の購読を外し、開いた専用セッション
      // だけを中断する。接続は維持する。
      cancelled = true;
      setReceiver(null);
      setSnapshot(null);
      try {
        unsubscribe?.();
      } catch {
        // 購読解除の失敗は無視する。
      }
      next?.dispose();
      if (textSession !== null) {
        try {
          textSession.abort();
        } catch {
          // 後片付けの失敗は無視する。
        }
      }
    };
  }, [args.connection, phase]);
  return { receiver, snapshot };
}
