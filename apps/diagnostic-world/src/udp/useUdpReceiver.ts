/**
 * UDP受信の React バインディング。3D盤側だけが使う。
 *
 * 生成・購読・破棄の所有はこのフックの effect が持つ。診断セッションが認可中に
 * 限り、認可済み管理口からUDP専用セッション（論理名 `udp`、`reliable`・
 * `bidirectional`）を開き、`UdpReceiver` を生成・購読する。開発 DOM パネル側では
 * 生成しない。切断・再接続・実アンマウント・StrictMode 再実行では旧個体を破棄し、
 * 開いた専用セッションだけを中断する（Connection や診断セッションは閉じない）。
 * 切断・再接続では直近データを消す（写しを `null` に戻す）。
 *
 * Reactへの表示更新は最大10Hzに間引く。間引くのは表示の更新頻度だけであり、
 * 受信の計数（件数・バイト数・不正件数）は全受信で行う（最新写しが累計を持つため、
 * 間引きで統計は欠けない）。
 *
 * @packageDocumentation
 */
import { useEffect, useState } from "react";
import { UDP_SESSION_ID } from "bridge-plugin-udp/contract";
import { WorldClientError, type ReliableSession } from "world-client";
import { UdpReceiver, type UdpSnapshot } from "./receiver.ts";
import type { DiagnosticSession, DiagnosticSnapshot } from "../diagnostic/session.ts";

/** 表示更新の間引き間隔（ミリ秒）。10Hz相当である。 */
export const UDP_DISPLAY_THROTTLE_MS = 100;

/** フックの引数。診断セッションとその写しを受け取る。 */
export interface UseUdpReceiverArgs {
  /** 診断セッション。生成前は `null`。 */
  readonly session: DiagnosticSession | null;
  /** 診断の写し。生成前は `null`。 */
  readonly snapshot: DiagnosticSnapshot | null;
}

/**
 * UDP受信を生成・購読する。3D盤側だけが呼ぶこと。
 *
 * 認可前・切断後・生成前は `receiver`・`snapshot` ともに `null` を返す。
 * 呼び出し側は `null` のあいだ表示板を未受信表示にすること。
 *
 * @param args - 診断セッションとその写し。
 * @returns 受信手順と最新の表示用写し。待機・未受信時はどちらも `null`。
 */
export function useUdpReceiver(args: UseUdpReceiverArgs): {
  readonly receiver: UdpReceiver | null;
  readonly snapshot: UdpSnapshot | null;
} {
  const [receiver, setReceiver] = useState<UdpReceiver | null>(null);
  const [snapshot, setSnapshot] = useState<UdpSnapshot | null>(null);
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
    let udpSession: ReliableSession | null = null;
    let next: UdpReceiver | null = null;
    let unsubscribe: (() => void) | null = null;
    // ADR: 表示更新は最大10Hzに間引く。計数は受信側が全受信で行い、ここでは
    // 最新写しの反映だけを遅らせる（先行＋後続の両方を残すため、間隔内の最終
    // 写しは時限で流す）。統計自体の欠落はない。
    let lastSentAt = 0;
    let pending: UdpSnapshot | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = (): void => {
      timer = null;
      if (cancelled || pending === null) return;
      const latest = pending;
      pending = null;
      lastSentAt = Date.now();
      setSnapshot(latest);
    };
    const handleSnapshot = (fresh: UdpSnapshot): void => {
      const now = Date.now();
      if (now - lastSentAt >= UDP_DISPLAY_THROTTLE_MS) {
        lastSentAt = now;
        setSnapshot(fresh);
        return;
      }
      pending = fresh;
      if (timer === null) {
        timer = setTimeout(flush, UDP_DISPLAY_THROTTLE_MS - (now - lastSentAt));
      }
    };
    const open = (): Promise<ReliableSession> =>
      provider.tryCreateSession({
        sessionId: UDP_SESSION_ID,
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
      udpSession = opened;
      next = new UdpReceiver({ session: opened });
      unsubscribe = next.subscribe(handleSnapshot);
      setReceiver(next);
      lastSentAt = Date.now();
      setSnapshot(next.getSnapshot());
    };
    const handleFailed = (): void => {
      // ADR: 専用セッションの開設失敗は局所化し、診断セッションや
      // Connection を閉じない。表示は中断（直近なし）に留める。
      if (cancelled) return;
      setReceiver(null);
      setSnapshot({
        status: "ended",
        receivedCount: 0,
        receivedBytes: 0,
        invalidCount: 0,
        source: null,
        byteLength: null,
        previewHex: null,
      });
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
      // ADR: 切断・再接続では直近データを消す。旧個体の購読を外し、開いた専用
      // セッションだけを中断する。診断セッション・Connection は維持する。
      cancelled = true;
      setReceiver(null);
      setSnapshot(null);
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
      try {
        unsubscribe?.();
      } catch {
        // 購読解除の失敗は無視する。
      }
      next?.dispose();
      if (udpSession !== null) {
        try {
          udpSession.abort();
        } catch {
          // 後片付けの失敗は無視する。
        }
      }
    };
  }, [args.session, phase]);
  return { receiver, snapshot };
}
