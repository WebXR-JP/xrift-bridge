/**
 * Session capability の型検査（実行しない）。
 *
 * `kind`・`direction` による公開 API の制限を `@ts-expect-error` で確かめる。
 * この配置（`.test.ts` にしない）では試験走査の対象にならず、型検査だけが効く。
 */
import { ClientSessionProvider } from "../../src/session.ts";
import type {
  CreateSessionOptions,
  InboundSession,
  LatestCreateSessionRequest,
  LatestSenderSession,
  OutboundSession,
  ReliableCreateSessionRequest,
  ReliableSession,
  Session,
  SessionProvider,
} from "../../src/index.ts";
import type { Connection, RawSocket } from "bridge-protocol/transport";

/** reliable 要求は reliable で返り、送信口だけを持つ。 */
export async function reliable要求はreliableで返る(provider: SessionProvider): Promise<void> {
  const session = await provider.tryCreateSession({
    sessionId: "chat",
    kind: "reliable",
    direction: "bidirectional",
  });
  const check: ReliableSession = session;
  await check.sendReliable({ op: "ping" });
  const stop = check.onMessage(() => undefined);
  stop();
  // @ts-expect-error — reliable に sendLatest は無い
  check.sendLatest({ x: 1 });
}

/** latest 送信要求は sender で返り、購読口を持たない。 */
export async function latest送信はsenderで返る(provider: SessionProvider): Promise<void> {
  const session = await provider.tryCreateSession({
    sessionId: "pose",
    kind: "latest",
    direction: "to_server",
  });
  const sender: LatestSenderSession = session;
  sender.sendLatest({ x: 1 });
  // @ts-expect-error — sender に onMessage は無い
  sender.onMessage(() => undefined);
  // @ts-expect-error — sender に sendReliable は無い
  await sender.sendReliable({ x: 1 });
}

/** 要求型の別名経由でも枝の精度が保たれる。 */
export async function 要求型別名で開ける(
  provider: SessionProvider,
  reliable: ReliableCreateSessionRequest,
  latest: LatestCreateSessionRequest<"client">,
): Promise<void> {
  const openedReliable = await provider.tryCreateSession(reliable);
  await openedReliable.sendReliable({ op: "ping" });
  const openedSender = await provider.tryCreateSession(latest);
  openedSender.sendLatest({ x: 1 });
}

/** inbound 通知は受信二種であり、送信口は持たない。 */
export function inboundは受信二種である(provider: SessionProvider): void {
  provider.onSession((session) => {
    const inbound: InboundSession = session;
    if (inbound.kind === "reliable") {
      void inbound.sendReliable({ op: "ping" });
    } else {
      const stop = inbound.onMessage(() => undefined);
      stop();
      // @ts-expect-error — receiver に sendLatest は無い
      inbound.sendLatest({ x: 1 });
      // @ts-expect-error — receiver に sendReliable は無い
      void inbound.sendReliable({ x: 1 });
    }
  });
}

/** 動的な合法要求は outbound で返り、枝に絞ってから使う。 */
export async function 動的要求はoutboundで返る(
  provider: SessionProvider,
  options: CreateSessionOptions,
): Promise<void> {
  const session = await provider.tryCreateSession(options);
  const outbound: OutboundSession = session;
  if (outbound.kind === "reliable") {
    await outbound.sendReliable({ op: "ping" });
  } else {
    outbound.sendLatest({ x: 1 });
  }
  // @ts-expect-error — 合併のままでは購読口は決まらない
  outbound.onMessage(() => undefined);
}

/** 公開合併は判別してから操縦できる。 */
export function 合併は判別して使う(session: Session): void {
  if (session.kind === "reliable") {
    void session.sendReliable({ op: "ping" });
  } else if (session.direction === "to_server") {
    session.sendLatest({ x: 1 });
  } else {
    const stop = session.onMessage(() => undefined);
    stop();
  }
}

/** 不正な種別・方向・役割の組合せは受け付けない。 */
export async function 不正な組合せは受け付けない(provider: SessionProvider): Promise<void> {
  // @ts-expect-error — reliable は双方向のみ
  await provider.tryCreateSession({ sessionId: "x", kind: "reliable", direction: "to_server" });
  // @ts-expect-error — latest に双方向は無い
  await provider.tryCreateSession({ sessionId: "x", kind: "latest", direction: "bidirectional" });
  // @ts-expect-error — client は to_client を開けない（受信側のため）
  await provider.tryCreateSession({ sessionId: "x", kind: "latest", direction: "to_client" });
}

/** 管理口の生成は client 役割の接続だけ受け付ける。 */
export function provider生成はclient役割を要求する(
  connection: Connection<"client">,
  rawSocket: RawSocket,
): ClientSessionProvider {
  return new ClientSessionProvider(connection, rawSocket);
}

/** server 役割の接続は管理口に渡せない。 */
export function server役割はproviderに渡せない(
  connection: Connection<"server">,
  rawSocket: RawSocket,
): void {
  // @ts-expect-error — provider は client 役割の接続だけ受け付ける
  new ClientSessionProvider(connection, rawSocket);
}
