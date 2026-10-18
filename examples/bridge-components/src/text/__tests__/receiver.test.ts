/**
 * テキスト受信手順の検証。テキスト専用セッションを偽物に差し替え、
 * 受信の反映・反映確認・不正要求の無視・中断の反映を確かめる。
 */
import { expect, test } from "vite-plus/test";
import type { ReliableSession } from "world-client";
import { TextReceiver } from "../receiver.ts";

/** 受信と送出を手で起こせる偽のテキスト専用セッション。 */
function createFakeSession(): {
  readonly session: ReliableSession;
  readonly emit: (payload: unknown) => void;
  readonly terminate: () => void;
  readonly sent: readonly unknown[];
} {
  const messageHandlers = new Set<(payload: unknown) => void>();
  const endHandlers = new Set<() => void>();
  const sent: unknown[] = [];
  const session = {
    onMessage: (handler: (payload: unknown) => void): (() => void) => {
      messageHandlers.add(handler);
      return () => {
        messageHandlers.delete(handler);
      };
    },
    onRemoteEnd: (handler: () => void): (() => void) => {
      endHandlers.add(handler);
      return () => {
        endHandlers.delete(handler);
      };
    },
    onEnd: (handler: () => void): (() => void) => {
      endHandlers.add(handler);
      return () => {
        endHandlers.delete(handler);
      };
    },
    sendReliable: (value: unknown): Promise<void> => {
      sent.push(value);
      return Promise.resolve();
    },
  };
  return {
    session: session as unknown as ReliableSession,
    emit: (payload: unknown): void => {
      for (const handler of messageHandlers) handler(payload);
    },
    terminate: (): void => {
      for (const handler of endHandlers) handler();
    },
    sent,
  };
}

test("表示要求を受けて本文を反映し、同じ識別子で反映確認を返す", () => {
  const fake = createFakeSession();
  const receiver = new TextReceiver({ session: fake.session });
  expect(receiver.getSnapshot()).toEqual({ status: "waiting", text: null, id: null });

  fake.emit({ op: "show", id: "req-1", text: "こんにちは" });
  expect(receiver.getSnapshot()).toEqual({ status: "received", text: "こんにちは", id: "req-1" });
  expect(fake.sent).toEqual([{ op: "shown", id: "req-1" }]);
});

test("不正な表示要求は無視し、セッションを閉じない", () => {
  const fake = createFakeSession();
  const receiver = new TextReceiver({ session: fake.session });

  fake.emit({ op: "show", id: "req-1", text: "本文", extra: true });
  fake.emit({ op: "other", id: "req-2", text: "本文" });
  fake.emit(null);
  expect(receiver.getSnapshot()).toEqual({ status: "waiting", text: null, id: null });
  expect(fake.sent).toEqual([]);

  fake.emit({ op: "show", id: "req-3", text: "正しい本文" });
  expect(receiver.getSnapshot().text).toBe("正しい本文");
});

test("専用セッションの終端は中断表示に留め、直近本文を残す", () => {
  const fake = createFakeSession();
  const receiver = new TextReceiver({ session: fake.session });

  fake.emit({ op: "show", id: "req-1", text: "本文" });
  fake.terminate();
  expect(receiver.getSnapshot()).toEqual({ status: "ended", text: "本文", id: "req-1" });
});
