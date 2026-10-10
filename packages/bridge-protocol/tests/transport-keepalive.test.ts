import { expect, test } from "vite-plus/test";
import {
  KEEPALIVE_FIRST_DELAY_MS,
  KEEPALIVE_INTERVAL_MS,
  KEEPALIVE_PING_TIMEOUT_MS,
  Keepalive,
} from "../src/transport/keepalive.ts";
import type { TimerScheduler } from "../src/transport/timers.ts";

/**
 * 手で時間を進める fake scheduler。発火順に処理し、残留を確認できる。
 *
 * 決定的な検証のため、実タイマーを使わない。
 */
class FakeScheduler implements TimerScheduler {
  private now = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { due: number; handler: () => void }>();

  setTimeout(handler: () => void, delayMs: number): unknown {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { due: this.now + delayMs, handler });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** 未発火の予約数。 */
  get pendingCount(): number {
    return this.timers.size;
  }

  /** 指定時間だけ進め、期限の来た予約を順に発火する。 */
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      let nextId: number | undefined;
      let nextDue = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.due <= end && timer.due < nextDue) {
          nextDue = timer.due;
          nextId = id;
        }
      }
      if (nextId === undefined) break;
      const timer = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.now = timer.due;
      timer.handler();
    }
    this.now = end;
  }
}

/** 解決・拒否を手で操る ping。呼び出し回数で発行を数える。 */
class ManualPing {
  calls = 0;
  private readonly waiting: Array<{
    resolve: (rtt: number) => void;
    reject: (cause: Error) => void;
  }> = [];

  readonly ping = (): Promise<number> => {
    this.calls += 1;
    return new Promise<number>((resolve, reject) => {
      this.waiting.push({ resolve, reject });
    });
  };

  get pendingCount(): number {
    return this.waiting.length;
  }

  resolveOldest(rtt = 1): void {
    this.waiting.shift()?.resolve(rtt);
  }

  rejectOldest(cause: Error): void {
    this.waiting.shift()?.reject(cause);
  }
}

/** マイクロタスクの消化を待つ。 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("定数が仕様値である", () => {
  expect(KEEPALIVE_FIRST_DELAY_MS).toBe(30_000);
  expect(KEEPALIVE_INTERVAL_MS).toBe(30_000);
  expect(KEEPALIVE_PING_TIMEOUT_MS).toBe(60_000);
});

test("30秒で最初のPingを送り正常応答で30秒後に次を送る", async () => {
  const scheduler = new FakeScheduler();
  const manual = new ManualPing();
  const failures: Error[] = [];
  const keepalive = new Keepalive({
    ping: manual.ping,
    scheduler,
    onFailure: (cause) => {
      failures.push(cause);
    },
  });
  keepalive.start();
  // 開始直後と29.999秒後には送らない。
  scheduler.advance(29_999);
  await tick();
  expect(manual.calls).toBe(0);
  scheduler.advance(1);
  await tick();
  expect(manual.calls).toBe(1);
  // 正常応答で次回は30秒後である。
  manual.resolveOldest();
  await tick();
  scheduler.advance(29_999);
  await tick();
  expect(manual.calls).toBe(1);
  scheduler.advance(1);
  await tick();
  expect(manual.calls).toBe(2);
  expect(failures).toHaveLength(0);
  expect(keepalive.running).toBe(true);
  keepalive.stop();
});

test("応答期限60秒の超過で失敗を通知し停止する", async () => {
  const scheduler = new FakeScheduler();
  const manual = new ManualPing();
  const failures: Error[] = [];
  const keepalive = new Keepalive({
    ping: manual.ping,
    scheduler,
    onFailure: (cause) => {
      failures.push(cause);
    },
  });
  keepalive.start();
  scheduler.advance(30_000);
  await tick();
  expect(manual.calls).toBe(1);
  // 発行から59.999秒では失敗しない。
  scheduler.advance(59_999);
  await tick();
  expect(failures).toHaveLength(0);
  // 60秒超過で失敗し、予約は残らない。
  scheduler.advance(1);
  await tick();
  expect(failures).toHaveLength(1);
  expect(keepalive.running).toBe(false);
  expect(scheduler.pendingCount).toBe(0);
  // 期限後の遅延成功は無視し、次を発行しない。
  manual.resolveOldest();
  await tick();
  expect(manual.calls).toBe(1);
  expect(failures).toHaveLength(1);
  expect(scheduler.pendingCount).toBe(0);
});

test("進行中は次のPingを発行しない", async () => {
  const scheduler = new FakeScheduler();
  const manual = new ManualPing();
  const failures: Error[] = [];
  const keepalive = new Keepalive({
    ping: manual.ping,
    scheduler,
    onFailure: (cause) => {
      failures.push(cause);
    },
  });
  keepalive.start();
  scheduler.advance(30_000);
  await tick();
  expect(manual.calls).toBe(1);
  // 応答がないまま長時間進めても追加発行はない（期限で失敗するだけ）。
  scheduler.advance(10_000);
  await tick();
  expect(manual.calls).toBe(1);
  expect(manual.pendingCount).toBe(1);
  expect(failures).toHaveLength(0);
  keepalive.stop();
});

test("Ping拒否で失敗を通知する", async () => {
  const scheduler = new FakeScheduler();
  const manual = new ManualPing();
  const failures: Error[] = [];
  const keepalive = new Keepalive({
    ping: manual.ping,
    scheduler,
    onFailure: (cause) => {
      failures.push(cause);
    },
  });
  keepalive.start();
  scheduler.advance(30_000);
  await tick();
  expect(manual.calls).toBe(1);
  manual.rejectOldest(new Error("mux が閉じた"));
  await tick();
  expect(failures).toHaveLength(1);
  expect(failures[0]!.message).toBe("mux が閉じた");
  expect(keepalive.running).toBe(false);
  expect(scheduler.pendingCount).toBe(0);
});

test("停止でタイマーを解除し遅延決着を無視する", async () => {
  const scheduler = new FakeScheduler();
  const manual = new ManualPing();
  const failures: Error[] = [];
  const keepalive = new Keepalive({
    ping: manual.ping,
    scheduler,
    onFailure: (cause) => {
      failures.push(cause);
    },
  });
  keepalive.start();
  scheduler.advance(30_000);
  await tick();
  expect(manual.calls).toBe(1);
  keepalive.stop();
  // 残留タイマーはない。
  expect(scheduler.pendingCount).toBe(0);
  expect(keepalive.running).toBe(false);
  // 停止後の遅延成功・拒否は失敗につながらない。
  manual.resolveOldest();
  await tick();
  expect(failures).toHaveLength(0);
  scheduler.advance(120_000);
  await tick();
  expect(manual.calls).toBe(1);
  expect(failures).toHaveLength(0);
  // 二重停止は安全である。
  keepalive.stop();
});

test("開始前の停止と二重開始は安全である", () => {
  const scheduler = new FakeScheduler();
  const manual = new ManualPing();
  const keepalive = new Keepalive({ ping: manual.ping, scheduler, onFailure: () => {} });
  keepalive.stop();
  expect(scheduler.pendingCount).toBe(0);
  keepalive.start();
  keepalive.start();
  // 二重開始でも予約は1件である。
  expect(scheduler.pendingCount).toBe(1);
  keepalive.stop();
});
