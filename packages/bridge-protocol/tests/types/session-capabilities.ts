/**
 * Session capability 公開型の型レベル契約。
 *
 * 実行はしない（`.test.ts` にしないため `vp test` の対象外）。`tsc --noEmit`
 * （`test:types`）で検証する。許容は代入で確かめ、不正な組合せ・存在しない
 * capability は `@ts-expect-error` で棄却を確かめる。
 *
 * 実行時の公開値は engine そのものであるため、ここでは呼ばない。
 * `transport` は型検査用であり実行時には使わない。
 */

import type { MessageStream } from "@libp2p/interface";
import {
  Connection,
  type ConnectionRole,
  type CreateSessionRequest,
} from "../../src/transport/connection.ts";
import type {
  InboundSession,
  LatestReceiverSession,
  LatestSenderSession,
  OutboundSession,
  ReliableSession,
  Session,
} from "../../src/transport/session-types.ts";

declare const transport: MessageStream;
declare const senderSession: LatestSenderSession<"client">;
declare const receiverSession: LatestReceiverSession<"client">;
declare const reliableSession: ReliableSession<"client">;
declare const anyClientSession: Session<"client">;

/** 型の一致を確かめる（実行時は何もしない）。 */
function expectType<T>(value: T): void {
  void value;
}

// --- `Connection` は `role` から推論される ---
const clientConn = new Connection({ transport, role: "client", connectionId: "conn-1" });
expectType<Connection<"client">>(clientConn);

const serverConn = new Connection({
  transport,
  role: "server",
  connectionId: "conn-1",
  onSession: (session) => {
    expectType<InboundSession<"server">>(session);
  },
});
expectType<Connection<"server">>(serverConn);

// --- `createSession` の戻り型は要求の組合せで決まる ---
async function checkCreateSession(): Promise<void> {
  expectType<Promise<ReliableSession<"client">>>(
    clientConn.createSession({ sessionId: "r", kind: "reliable", direction: "bidirectional" }),
  );
  expectType<Promise<LatestSenderSession<"client">>>(
    clientConn.createSession({ sessionId: "s", kind: "latest", direction: "to_server" }),
  );
  expectType<Promise<LatestSenderSession<"server">>>(
    serverConn.createSession({ sessionId: "s", kind: "latest", direction: "to_client" }),
  );

  const clientWrongDirection = { sessionId: "x", kind: "latest", direction: "to_client" } as const;
  // @ts-expect-error — client は `to_client` を開けない。
  await clientConn.createSession(clientWrongDirection);
  const serverWrongDirection = { sessionId: "x", kind: "latest", direction: "to_server" } as const;
  // @ts-expect-error — server は `to_server` を開けない。
  await serverConn.createSession(serverWrongDirection);
  const reliableMismatch = { sessionId: "x", kind: "reliable", direction: "to_client" } as const;
  // @ts-expect-error — reliable は双方向のみ。
  await clientConn.createSession(reliableMismatch);
  const latestMismatch = { sessionId: "x", kind: "latest", direction: "bidirectional" } as const;
  // @ts-expect-error — latest に双方向はない。
  await clientConn.createSession(latestMismatch);
}

// --- capability の有無 ---
async function checkCapabilities(): Promise<void> {
  await reliableSession.sendReliable({ n: 1 });
  reliableSession.onMessage(() => {});
  senderSession.sendLatest({ n: 1 });
  receiverSession.onMessage(() => {});
  // @ts-expect-error — sender に受信購読はない。
  senderSession.onMessage(() => {});
  // @ts-expect-error — receiver に latest 送信はない。
  receiverSession.sendLatest({ n: 1 });
  // @ts-expect-error — sender に確実送信はない。
  senderSession.sendReliable({ n: 1 });
  // @ts-expect-error — receiver に確実送信はない。
  receiverSession.sendReliable({ n: 1 });
}

// --- 動的 Union 要求の戻りは `OutboundSession`、`getSession` は公開 Union ---
async function checkDynamic<R extends ConnectionRole>(
  conn: Connection<R>,
  request: CreateSessionRequest<R>,
): Promise<void> {
  expectType<Promise<OutboundSession<R>>>(conn.createSession(request));
  expectType<Session<R> | undefined>(conn.getSession(request.sessionId));
}

// --- 正常操作は `kind`・`direction` で絞ってから呼べる ---
function useSession(session: Session<"client">): void {
  if (session.kind === "reliable") {
    void session.sendReliable({ n: 1 });
    session.onMessage(() => {});
  } else if (session.direction === "to_server") {
    session.sendLatest({ n: 1 });
  } else {
    session.onMessage(() => {});
  }
  expectType<string>(session.sessionId);
  expectType<boolean>(session.isAlive);
  expectType<number>(session.receivedCount);
  expectType<number>(session.staleDroppedCount);
  expectType<number>(session.missingSeqCount);
  expectType<number>(session.lastRecvSeq);
  expectType<boolean>(session.writeEnded);
  expectType<boolean>(session.peerEnded);
}

void checkCreateSession();
void checkCapabilities();
void checkDynamic(clientConn, {
  sessionId: "d",
  kind: "reliable",
  direction: "bidirectional",
});
useSession(anyClientSession);
