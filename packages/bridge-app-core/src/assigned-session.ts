/**
 * 割当て期間だけ有効なセッション操作口。
 *
 * 生の Session を保持・露出せず、capability に合う操作だけを型と実行時の
 * 両方で提供する。合わない操作は型に存在しない（実行時にも存在しない）。
 * 解除・削除・終了・Session 終端で失効し、失効後の送信は拒否（`Promise` の
 * 拒否・例外送出）、購読登録は例外になる。配送済み通知の到達時点で失効
 * していれば、購読者へは届けない。
 *
 * @packageDocumentation
 */
import type { BridgeSessionInfo, ServerSession } from "bridge-server";
import type { SessionEnd } from "bridge-protocol/transport";
import type { LatestReceiverSession, ReliableSession } from "bridge-protocol/transport";

/** 購読解除関数。終端後の呼び出しも安全である。 */
export type Unsubscribe = () => void;

/**
 * 双方向 reliable セッションの操作口（PC 側は送受信可能）。
 *
 * `sendReliable` と `onMessage` を持つ。
 */
export interface AssignedReliableSession {
  /** 配送種別。reliable は双方向のみである。 */
  readonly kind: "reliable";
  /** 許す送信方向。reliable は双方向のみである。 */
  readonly direction: "bidirectional";
  /** 割り当てた生存セッションの公開情報。 */
  readonly info: BridgeSessionInfo;
  /** この Session の論理名。 */
  readonly sessionId: string;
  /** 失効しておらず全体終端していなければ真。 */
  readonly isAlive: boolean;
  /**
   * 受信した payload を購読する。
   *
   * @param handler - payload を受け取る処理。例外は隔離する。
   * @returns 購読解除。
   * @throws `RangeError` — 失効済みの場合。
   */
  onMessage(handler: (payload: unknown) => void): Unsubscribe;
  /**
   * Session 全体の終端を購読する。一度だけ通知する。
   *
   * @param handler - 終端内容を受け取る処理。例外は隔離する。
   * @returns 購読解除。
   * @throws `RangeError` — 失効済みの場合。
   */
  onEnd(handler: (end: SessionEnd) => void): Unsubscribe;
  /**
   * 相手 FIN（読み終わり）を購読する。
   *
   * @param handler - 相手 FIN の処理。例外は隔離する。
   * @returns 購読解除。
   * @throws `RangeError` — 失効済みの場合。
   */
  onRemoteEnd(handler: () => void): Unsubscribe;
  /**
   * 失効を購読する。一度だけ通知する。
   *
   * 解除・削除・終了・基盤終了のいずれで失効しても、終端購読とは別に
   * 届く。資源の後始末用であり、終端内容は含まない。
   *
   * @param handler - 失効時の処理。例外は隔離する。
   * @returns 購読解除。
   * @throws `RangeError` — 失効済みの場合。
   */
  onRevoked(handler: () => void): Unsubscribe;
  /**
   * 確実に届けたい値を送る。
   *
   * @param value - 配送する JSON 値（`null` を含む）。
   * @returns ローカル送信処理の完了で解ける約束。相手受信・業務完了ではない。
   * 失効済みなら `RangeError` で拒否する。
   */
  sendReliable(value: unknown): Promise<void>;
  /**
   * 送信方向を正常終了する（FIN）。
   *
   * @returns FIN 送出の完了で解ける約束。失効済みなら `RangeError` で拒否する。
   */
  closeWrite(): Promise<void>;
  /**
   * 即時中断する（RST）。失効済みなら何もしない。
   *
   * @param error - 中断の原因。省略時は Session の中断として扱う。
   */
  abort(error?: Error): void;
}

/**
 * latest 受信側セッションの操作口（PC 側は受信のみ）。
 *
 * `onMessage` だけを持ち、送信口は持たない。
 */
export interface AssignedLatestReceiverSession {
  /** 配送種別。latest は一方向のみである。 */
  readonly kind: "latest";
  /** 許す送信方向。サーバー側の受信方向のみである。 */
  readonly direction: "to_server";
  /** 割り当てた生存セッションの公開情報。 */
  readonly info: BridgeSessionInfo;
  /** この Session の論理名。 */
  readonly sessionId: string;
  /** 失効しておらず全体終端していなければ真。 */
  readonly isAlive: boolean;
  /**
   * 受信した payload を購読する。
   *
   * @param handler - payload を受け取る処理。例外は隔離する。
   * @returns 購読解除。
   * @throws `RangeError` — 失効済みの場合。
   */
  onMessage(handler: (payload: unknown) => void): Unsubscribe;
  /**
   * Session 全体の終端を購読する。一度だけ通知する。
   *
   * @param handler - 終端内容を受け取る処理。例外は隔離する。
   * @returns 購読解除。
   * @throws `RangeError` — 失効済みの場合。
   */
  onEnd(handler: (end: SessionEnd) => void): Unsubscribe;
  /**
   * 相手 FIN（読み終わり）を購読する。
   *
   * @param handler - 相手 FIN の処理。例外は隔離する。
   * @returns 購読解除。
   * @throws `RangeError` — 失効済みの場合。
   */
  onRemoteEnd(handler: () => void): Unsubscribe;
  /**
   * 失効を購読する。一度だけ通知する。
   *
   * 解除・削除・終了・基盤終了のいずれで失効しても、終端購読とは別に
   * 届く。資源の後始末用であり、終端内容は含まない。
   *
   * @param handler - 失効時の処理。例外は隔離する。
   * @returns 購読解除。
   * @throws `RangeError` — 失効済みの場合。
   */
  onRevoked(handler: () => void): Unsubscribe;
  /**
   * 送信方向を正常終了する（FIN）。
   *
   * @returns FIN 送出の完了で解ける約束。失効済みなら `RangeError` で拒否する。
   */
  closeWrite(): Promise<void>;
  /**
   * 即時中断する（RST）。失効済みなら何もしない。
   *
   * @param error - 中断の原因。省略時は Session の中断として扱う。
   */
  abort(error?: Error): void;
}

/**
 * latest 送信側セッションの操作口（PC 側は送信のみ）。
 *
 * `sendLatest` だけを持ち、`onMessage` は持たない。サーバー起点の作成口が
 * ないため現状は生成されず、接続口の宣言用に型だけを置く。
 */
export interface AssignedLatestSenderSession {
  /** 配送種別。latest は一方向のみである。 */
  readonly kind: "latest";
  /** 許す送信方向。サーバー側の送信方向のみである。 */
  readonly direction: "to_client";
  /** 割り当てた生存セッションの公開情報。 */
  readonly info: BridgeSessionInfo;
  /** この Session の論理名。 */
  readonly sessionId: string;
  /** 失効しておらず全体終端していなければ真。 */
  readonly isAlive: boolean;
  /**
   * Session 全体の終端を購読する。一度だけ通知する。
   *
   * @param handler - 終端内容を受け取る処理。例外は隔離する。
   * @returns 購読解除。
   * @throws `RangeError` — 失効済みの場合。
   */
  onEnd(handler: (end: SessionEnd) => void): Unsubscribe;
  /**
   * 相手 FIN（読み終わり）を購読する。
   *
   * @param handler - 相手 FIN の処理。例外は隔離する。
   * @returns 購読解除。
   * @throws `RangeError` — 失効済みの場合。
   */
  onRemoteEnd(handler: () => void): Unsubscribe;
  /**
   * 失効を購読する。一度だけ通知する。
   *
   * 解除・削除・終了・基盤終了のいずれで失効しても、終端購読とは別に
   * 届く。資源の後始末用であり、終端内容は含まない。
   *
   * @param handler - 失効時の処理。例外は隔離する。
   * @returns 購読解除。
   * @throws `RangeError` — 失効済みの場合。
   */
  onRevoked(handler: () => void): Unsubscribe;
  /**
   * 最新の状態を送る（同期受付）。
   *
   * @param value - 配送する JSON 値（`null` を含む）。
   * @throws `RangeError` — 失効済みの場合。
   */
  sendLatest(value: unknown): void;
  /**
   * 送信方向を正常終了する（FIN）。
   *
   * @returns FIN 送出の完了で解ける約束。失効済みなら `RangeError` で拒否する。
   */
  closeWrite(): Promise<void>;
  /**
   * 即時中断する（RST）。失効済みなら何もしない。
   *
   * @param error - 中断の原因。省略時は Session の中断として扱う。
   */
  abort(error?: Error): void;
}

/**
 * 割当て期間だけ有効な操作口（`kind`・`direction` で判別する合併）。
 *
 * 生の Session ではなく、失効付きのラッパーである。
 */
export type AssignedSession =
  | AssignedReliableSession
  | AssignedLatestReceiverSession
  | AssignedLatestSenderSession;

/** 失効付き操作口の内部表現。 */
export interface RevocableAssignedSession {
  /** プラグインへ渡す操作口。 */
  readonly session: AssignedSession;
  /**
   * 操作口を失効させる。
   *
   * 購読者集合の破棄を先に行ってから生 Session 側の購読を解除する。
   * 冪等である。
   */
  revoke(): void;
}

/**
 * 失効理由の接頭辞。表示・関連付け用であり、制御には使わない。
 *
 * @param reason - 失効した理由。
 * @returns `RangeError` の理由文。
 */
function revokedReason(reason: string): string {
  return `操作口は失効している（${reason}）。`;
}

/**
 * 生 Session と購読者集合をつなぐ土台。
 *
 * 生 Session への購読は一つずつ持ち、配送時に失効を確認してから
 * スナップショットへ届ける。購読者の例外は隔離する。
 */
abstract class AssignedSessionBase {
  private revoked = false;
  private readonly rawUnsubs: Unsubscribe[] = [];
  private readonly messageHandlers = new Set<(payload: unknown) => void>();
  private readonly endHandlers = new Set<(end: SessionEnd) => void>();
  private readonly remoteEndHandlers = new Set<() => void>();
  private readonly revokedHandlers = new Set<() => void>();

  /**
   * @param raw - 委譲先の生 Session。外部へ露出しない。
   * @param info - 割り当てた生存セッションの公開情報。
   */
  constructor(
    private readonly raw: ServerSession,
    readonly info: BridgeSessionInfo,
  ) {
    // ADR: `ServerSession`（inbound）は受信口を持つため、基盤側の配送購読を
    // 生成時に確定する。送信専用（`to_client`）は公開 Session がないため
    // 生成経路を持たず、ここでは扱わない。
    this.rawUnsubs.push(
      raw.onMessage((payload) => {
        if (this.revoked) return;
        for (const handler of [...this.messageHandlers]) {
          try {
            handler(payload);
          } catch {
            // 購読者の例外で配送を止めない。
          }
        }
      }),
      raw.onEnd((end) => {
        if (this.revoked) return;
        for (const handler of [...this.endHandlers]) {
          try {
            handler(end);
          } catch {
            // 購読者の例外で配送を止めない。
          }
        }
      }),
      raw.onRemoteEnd(() => {
        if (this.revoked) return;
        for (const handler of [...this.remoteEndHandlers]) {
          try {
            handler();
          } catch {
            // 購読者の例外で配送を止めない。
          }
        }
      }),
    );
  }

  /** この Session の論理名。 */
  get sessionId(): string {
    return this.raw.sessionId;
  }

  /** 失効しておらず全体終端していなければ真。 */
  get isAlive(): boolean {
    return !this.revoked && this.raw.isAlive;
  }

  /** 失効していれば真。 */
  protected get isRevoked(): boolean {
    return this.revoked;
  }

  /** 生 Session への委譲口。外部へ露出しない。 */
  protected get rawSession(): ServerSession {
    return this.raw;
  }

  /**
   * 操作口を失効させる。
   *
   * 購読者集合の破棄を先に行ってから生 Session 側の購読を解除する。
   * 配送中のスナップショット側の確認（`revoked` 標識）と合わせ、
   * 失効済み購読者へは届けない。失効購読者へは一度だけ同期通知する。
   */
  revoke(): void {
    if (this.revoked) return;
    this.revoked = true;
    // ADR: 失効購読の通知は終端購読の配送とは別に行う。`revoke()` は終端
    // 購読を先に消すため、解除経路では `onEnd` が届かない場合がある。
    // 失効したことだけを一度通知し、資源の後始末（UDP ソケットの close 等）
    // を確実に行えるようにする。通知後の再入（`onRevoked` 登録）は
    // `revoked` 標識で拒否し、二重通知はしない。
    const revokedSnapshot = [...this.revokedHandlers];
    this.messageHandlers.clear();
    this.endHandlers.clear();
    this.remoteEndHandlers.clear();
    this.revokedHandlers.clear();
    for (const handler of revokedSnapshot) {
      try {
        handler();
      } catch {
        // 購読者の例外で配送を止めない。
      }
    }
    for (const unsubscribe of this.rawUnsubs.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // 購読解除の失敗は失効を止めない。
      }
    }
  }

  /**
   * 受信購読を登録する。
   *
   * @param handler - payload を受け取る処理。
   * @returns 購読解除。
   * @throws `RangeError` — 失効済みの場合。
   */
  protected addMessageHandler(handler: (payload: unknown) => void): Unsubscribe {
    if (this.revoked) throw new RangeError(revokedReason("購読の登録はできない"));
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  /**
   * 終端購読を登録する。
   *
   * @param handler - 終端内容を受け取る処理。
   * @returns 購読解除。
   * @throws `RangeError` — 失効済みの場合。
   */
  protected addEndHandler(handler: (end: SessionEnd) => void): Unsubscribe {
    if (this.revoked) throw new RangeError(revokedReason("購読の登録はできない"));
    this.endHandlers.add(handler);
    return () => {
      this.endHandlers.delete(handler);
    };
  }

  /**
   * 相手 FIN 購読を登録する。
   *
   * @param handler - 相手 FIN の処理。
   * @returns 購読解除。
   * @throws `RangeError` — 失効済みの場合。
   */
  protected addRemoteEndHandler(handler: () => void): Unsubscribe {
    if (this.revoked) throw new RangeError(revokedReason("購読の登録はできない"));
    this.remoteEndHandlers.add(handler);
    return () => {
      this.remoteEndHandlers.delete(handler);
    };
  }

  /**
   * 失効購読を登録する。
   *
   * @param handler - 失効時の処理。
   * @returns 購読解除。
   * @throws `RangeError` — 失効済みの場合。
   */
  protected addRevokedHandler(handler: () => void): Unsubscribe {
    if (this.revoked) throw new RangeError(revokedReason("購読の登録はできない"));
    this.revokedHandlers.add(handler);
    return () => {
      this.revokedHandlers.delete(handler);
    };
  }

  /**
   * 失効を確認して生 Session の送信終了へ委譲する。
   *
   * @returns FIN 送出の完了で解ける約束。失効済みなら拒否する。
   */
  protected delegateCloseWrite(reason: string): Promise<void> {
    if (this.revoked) return Promise.reject(new RangeError(revokedReason(reason)));
    return this.raw.closeWrite();
  }

  /**
   * 失効を確認して生 Session の中断へ委譲する。失効済みなら何もしない。
   *
   * @param error - 中断の原因。
   */
  protected delegateAbort(error?: Error): void {
    if (this.revoked) return;
    try {
      this.raw.abort(error);
    } catch {
      // 中断の失敗は呼び出し側へ伝えない。
    }
  }
}

/** 双方向 reliable の操作口の実装。 */
class ReliableAssignedSession extends AssignedSessionBase implements AssignedReliableSession {
  readonly kind = "reliable" as const;
  readonly direction = "bidirectional" as const;

  /** @param raw - 委譲先の reliable Session。 */
  constructor(raw: ReliableSession<"server">, info: BridgeSessionInfo) {
    super(raw, info);
  }

  /** {@inheritDoc AssignedReliableSession.onMessage} */
  onMessage(handler: (payload: unknown) => void): Unsubscribe {
    return this.addMessageHandler(handler);
  }

  /** {@inheritDoc AssignedReliableSession.onEnd} */
  onEnd(handler: (end: SessionEnd) => void): Unsubscribe {
    return this.addEndHandler(handler);
  }

  /** {@inheritDoc AssignedReliableSession.onRemoteEnd} */
  onRemoteEnd(handler: () => void): Unsubscribe {
    return this.addRemoteEndHandler(handler);
  }

  /** {@inheritDoc AssignedReliableSession.onRevoked} */
  onRevoked(handler: () => void): Unsubscribe {
    return this.addRevokedHandler(handler);
  }

  /** {@inheritDoc AssignedReliableSession.sendReliable} */
  sendReliable(value: unknown): Promise<void> {
    if (this.isRevoked) {
      return Promise.reject(new RangeError(revokedReason("送信はできない")));
    }
    const raw = this.rawSession;
    if (raw.kind !== "reliable") {
      return Promise.reject(new RangeError("操作口の種別と生 Session が一致しない。"));
    }
    return raw.sendReliable(value);
  }

  /** {@inheritDoc AssignedReliableSession.closeWrite} */
  closeWrite(): Promise<void> {
    return this.delegateCloseWrite("送信終了はできない");
  }

  /** {@inheritDoc AssignedReliableSession.abort} */
  abort(error?: Error): void {
    this.delegateAbort(error);
  }
}

/** latest 受信側の操作口の実装。送信口は持たない。 */
class LatestReceiverAssignedSession
  extends AssignedSessionBase
  implements AssignedLatestReceiverSession
{
  readonly kind = "latest" as const;
  readonly direction = "to_server" as const;

  /** @param raw - 委譲先の latest 受信 Session。 */
  constructor(raw: LatestReceiverSession<"server">, info: BridgeSessionInfo) {
    super(raw, info);
  }

  /** {@inheritDoc AssignedLatestReceiverSession.onMessage} */
  onMessage(handler: (payload: unknown) => void): Unsubscribe {
    return this.addMessageHandler(handler);
  }

  /** {@inheritDoc AssignedLatestReceiverSession.onEnd} */
  onEnd(handler: (end: SessionEnd) => void): Unsubscribe {
    return this.addEndHandler(handler);
  }

  /** {@inheritDoc AssignedLatestReceiverSession.onRemoteEnd} */
  onRemoteEnd(handler: () => void): Unsubscribe {
    return this.addRemoteEndHandler(handler);
  }

  /** {@inheritDoc AssignedLatestReceiverSession.onRevoked} */
  onRevoked(handler: () => void): Unsubscribe {
    return this.addRevokedHandler(handler);
  }

  /** {@inheritDoc AssignedLatestReceiverSession.closeWrite} */
  closeWrite(): Promise<void> {
    return this.delegateCloseWrite("送信終了はできない");
  }

  /** {@inheritDoc AssignedLatestReceiverSession.abort} */
  abort(error?: Error): void {
    this.delegateAbort(error);
  }
}

/**
 * 生 Session を失効付き操作口で包む。
 *
 * @param raw - 委譲先の生 Session。戻り値の外へ露出しない。
 * @param info - 割り当てた生存セッションの公開情報。
 * @returns 操作口と失効口の組。
 * @throws `RangeError` — 公開 Session のない組合せ（`to_client` 等）の場合。
 */
export function wrapServerSession(
  raw: ServerSession,
  info: BridgeSessionInfo,
): RevocableAssignedSession {
  // ADR: `ServerSession` は inbound のみ（reliable 双方向・latest 受信側）で
  // あるため、網羅分岐で包む。送信専用は生成経路がないため例外にする。
  if (raw.kind === "reliable") {
    const session = new ReliableAssignedSession(raw, info);
    return { session, revoke: () => session.revoke() };
  }
  if (raw.kind === "latest") {
    const session = new LatestReceiverAssignedSession(raw, info);
    return { session, revoke: () => session.revoke() };
  }
  throw new RangeError("公開 Session のない組合せである。");
}
