/**
 * テキスト受信の React バインディング。3D盤側だけが使う。
 *
 * 生成・購読・破棄の所有はこのフックの effect が持つ。診断セッションが認可中に
 * 限り、認可済み管理口からテキスト専用セッション（論理名 `text`、`reliable`・
 * `bidirectional`）を開き、`TextReceiver` を生成・購読する。開発 DOM パネル側では
 * 生成しない。切断・再接続・実アンマウント・StrictMode 再実行では旧個体を破棄し、
 * 開いた専用セッションだけを中断する（Connection や診断セッションは閉じない）。
 * 切断・再接続では本文を消す（写しを `null` に戻す）。
 *
 * @packageDocumentation
 */
import { useEffect, useState } from "react";
import { TEXT_SESSION_ID } from "bridge-app-core/text-contract";
import { WorldClientError, type ReliableSession } from "world-client";
import { TextReceiver, type TextSnapshot } from "./receiver.ts";
import type { DiagnosticSession, DiagnosticSnapshot } from "../diagnostic/session.ts";

/** フックの引数。診断セッションとその写しを受け取る。 */
export interface UseTextReceiverArgs {
  /** 診断セッション。生成前は `null`。 */
  readonly session: DiagnosticSession | null;
  /** 診断の写し。生成前は `null`。 */
  readonly snapshot: DiagnosticSnapshot | null;
}

/**
 * テキスト受信を生成・購読する。3D盤側だけが呼ぶこと。
 *
 * 認可前・切断後・生成前は `receiver`・`snapshot` ともに `null` を返す。
 * 呼び出し側は `null` のあいだ表示板を未受信表示にすること。
 *
 * @param args - 診断セッションとその写し。
 * @returns 受信手順と最新の表示用写し。待機・未受信時はどちらも `null`。
 */
export function useTextReceiver(args: UseTextReceiverArgs): {
  readonly receiver: TextReceiver | null;
  readonly snapshot: TextSnapshot | null;
} {
  const [receiver, setReceiver] = useState<TextReceiver | null>(null);
  const [snapshot, setSnapshot] = useState<TextSnapshot | null>(null);
  const phase = args.snapshot?.phase ?? null;
  useEffect(() => {
    // ADR: 生成・購読・破棄を同一 effect が所有する。描画時の生成物を
    // effect が破棄する構成では、StrictMode の再実行で破棄済み個体へ
    // 再購読してしまうため採らない。診断セッション本体（`useDiagnosticSession`
    // の所有物）には触れず、開いた専用セッションだけを中断する。
    const diagnostic = args.session;
    if (diagnostic === null || phase !== "authorized") return;
    const provider = diagnostic.getAuthorizedProvider();
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
        // ADR: effect 破棄後に開設が解けた専用セッションは残さない。
        // 同名再生成の重複を避けるため、当該セッションだけを中断する。
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
      // ADR: 専用セッションの開設失敗は局所化し、診断セッションや
      // Connection を閉じない。表示は中断（本文なし）に留める。
      if (cancelled) return;
      setReceiver(null);
      setSnapshot({ status: "ended", text: null, id: null });
    };
    void open().then(handleOpened, (error: unknown) => {
      if (cancelled) return;
      // ADR: StrictMode 再実行では旧 effect の開設と新 effect の開設が競合し、
      // 同名重複で拒否され得る。旧個体の破棄による中断の後に一度だけ開設し直す。
      // 診断セッション・Connection には触れない。
      if (error instanceof WorldClientError && error.code === "DUPLICATE_SESSION") {
        void open().then(handleOpened, handleFailed);
        return;
      }
      handleFailed();
    });
    return () => {
      // ADR: 切断・再接続では本文を消す。旧個体の購読を外し、開いた専用
      // セッションだけを中断する。診断セッション・Connection は維持する。
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
  }, [args.session, phase]);
  return { receiver, snapshot };
}
