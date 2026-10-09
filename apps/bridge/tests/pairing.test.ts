import { expect, test } from "vite-plus/test";
import { PAIRING_CODE_LENGTH, isPairingRequestId } from "bridge-protocol";
import { resolveLimits } from "../src/config.ts";
import {
  AcceptanceController,
  PairingRateLimiter,
  PairingStore,
  generatePairingCode,
} from "../src/pairing.ts";
import type { Clock } from "../src/clock.ts";

/** 壁時計と単調時計を独立に操作できる手動時計。 */
function manualClock(
  wall: number,
  mono: number,
): {
  readonly clock: Clock;
  set(wall: number, mono: number): void;
  advanceWall(delta: number): void;
  advanceMono(delta: number): void;
} {
  let wallNow = wall;
  let monoNow = mono;
  return {
    clock: {
      now: () => wallNow,
      monotonic: () => monoNow,
    },
    set(nextWall: number, nextMono: number): void {
      wallNow = nextWall;
      monoNow = nextMono;
    },
    advanceWall(delta: number): void {
      wallNow += delta;
    },
    advanceMono(delta: number): void {
      monoNow += delta;
    },
  };
}

/** 受付を開く前の保留管理とその部品を組立てる。 */
function setupPairing(
  overrides?: Parameters<typeof resolveLimits>[0],
  options?: {
    readonly generateCode?: () => string;
    readonly isConnectionAlive?: (connectionId: string) => boolean;
  },
): {
  readonly ctl: ReturnType<typeof manualClock>;
  readonly acceptance: AcceptanceController;
  readonly store: PairingStore;
} {
  const ctl = manualClock(1_000_000, 5_000);
  const limits = resolveLimits(overrides);
  const acceptance = new AcceptanceController({ limits, clock: ctl.clock });
  const store = new PairingStore({
    limits,
    clock: ctl.clock,
    acceptance,
    generateCode: options?.generateCode,
    isConnectionAlive: options?.isConnectionAlive,
  });
  return { ctl, acceptance, store };
}

/** キューから順に返す生成子。使い切りは試験の失敗にする。 */
function queuedCodes(queue: string[], calls: { count: number }): () => string {
  return () => {
    calls.count += 1;
    const next = queue.shift();
    if (next === undefined) throw new Error("生成回数が想定を超えた。");
    return next;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test("生成コードは6桁の数字で先頭ゼロが出る", () => {
  expect(PAIRING_CODE_LENGTH).toBe(6);
  let leadingZero = false;
  for (let index = 0; index < 1_000; index += 1) {
    const code = generatePairingCode();
    expect(code).toMatch(/^[0-9]{6}$/);
    expect(code).toHaveLength(6);
    if (code.startsWith("0")) {
      leadingZero = true;
    }
  }
  // 乱数源が一様なら先頭ゼロは必ず現れる。出なければ生成が壊れている。
  expect(leadingZero).toBe(true);
});

test("注入コードの先頭ゼロは承認まで文字列で保持される", () => {
  const { acceptance, store } = setupPairing(undefined, { generateCode: () => "000042" });
  acceptance.open();
  const created = store.create("conn-zero", "https://app.example");
  if (created.status !== "CREATED") throw new Error("保留が作れない。");
  expect(created.code).toBe("000042");
  expect(store.approve(created.requestId, "000042")).toEqual({
    status: "APPROVED",
    connectionId: "conn-zero",
    origin: "https://app.example",
  });
  // 承認は一度だけ成功する。
  expect(store.approve(created.requestId, "000042")).toEqual({ status: "NOT_PENDING" });
});

test("生存保留と重複するコードは全Origin横断で再生成する", () => {
  const calls = { count: 0 };
  const { acceptance, store } = setupPairing(undefined, {
    generateCode: queuedCodes(["111111", "111111", "222222"], calls),
  });
  acceptance.open();
  const first = store.create("conn-a", "https://a.example");
  if (first.status !== "CREATED") throw new Error("1件目が作れない。");
  expect(first.code).toBe("111111");
  const second = store.create("conn-b", "https://b.example");
  if (second.status !== "CREATED") throw new Error("2件目が作れない。");
  // 別 Origin の生存コードと衝突した分を作り直している。
  expect(second.code).toBe("222222");
  expect(calls.count).toBe(3);
  expect(store.size()).toBe(2);
});

test("16回衝突し続けると失敗しエントリを残さない", () => {
  const calls = { count: 0 };
  const { acceptance, store } = setupPairing(undefined, {
    generateCode: () => {
      calls.count += 1;
      return "111111";
    },
  });
  acceptance.open();
  const first = store.create("conn-a", "https://a.example");
  if (first.status !== "CREATED") throw new Error("1件目が作れない。");
  expect(calls.count).toBe(1);
  const second = store.create("conn-b", "https://b.example");
  expect(second).toEqual({ status: "CODE_GENERATION_FAILED" });
  // 上限回数ちょうどで打ち切る。
  expect(calls.count).toBe(1 + 16);
  // 失敗した要求のエントリは残らない。
  expect(store.size()).toBe(1);
  expect(store.list().map((entry) => entry.connectionId)).toEqual(["conn-a"]);
});

test("書式不正の生成値は試行として数えエントリを残さない", () => {
  const { acceptance, store } = setupPairing(undefined, { generateCode: () => "abc" });
  acceptance.open();
  expect(store.create("conn-a", "https://a.example")).toEqual({
    status: "CODE_GENERATION_FAILED",
  });
  expect(store.size()).toBe(0);
});

test("要求IDは削除後も再利用しない", () => {
  const { acceptance, store } = setupPairing();
  acceptance.open();
  const ids: string[] = [];
  const first = store.create("conn-a", "https://a.example");
  if (first.status !== "CREATED") throw new Error("1件目が作れない。");
  ids.push(first.requestId);
  // 承認成功で消えた ID は再利用しない。
  const code = store.get(first.requestId)?.code;
  if (code === undefined) throw new Error("保留が見えない。");
  expect(store.approve(first.requestId, code)).toEqual({
    status: "APPROVED",
    connectionId: "conn-a",
    origin: "https://a.example",
  });
  const second = store.create("conn-b", "https://b.example");
  if (second.status !== "CREATED") throw new Error("2件目が作れない。");
  ids.push(second.requestId);
  // 明示の取下げで消えた ID も再利用しない。
  expect(store.remove(second.requestId)).toBe(true);
  const third = store.create("conn-c", "https://c.example");
  if (third.status !== "CREATED") throw new Error("3件目が作れない。");
  ids.push(third.requestId);
  expect(new Set(ids).size).toBe(3);
  for (const id of ids) {
    expect(isPairingRequestId(id)).toBe(true);
  }
});

test("保留期限は発行＋承認待ちと受付終了の早い方である", () => {
  // 受付終了が早い場合。
  {
    const { acceptance, store } = setupPairing({
      pairingApprovalTimeoutMs: 120_000,
      acceptanceDurationMs: 60_000,
    });
    acceptance.open();
    const created = store.create("conn-a", "https://a.example");
    if (created.status !== "CREATED") throw new Error("保留が作れない。");
    // 単調: min(5000+120000, 5000+60000)、壁: min(1000000+120000, 1000000+60000)。
    expect(created.expiresInMs).toBe(60_000);
    expect(created.expiresAt).toBe(1_060_000);
    expect(store.get(created.requestId)?.monotonicDeadline).toBe(65_000);
  }
  // 承認待ちが早い場合。
  {
    const { acceptance, store } = setupPairing({
      pairingApprovalTimeoutMs: 30_000,
      acceptanceDurationMs: 120_000,
    });
    acceptance.open();
    const created = store.create("conn-a", "https://a.example");
    if (created.status !== "CREATED") throw new Error("保留が作れない。");
    expect(created.expiresInMs).toBe(30_000);
    expect(created.expiresAt).toBe(1_030_000);
    expect(store.get(created.requestId)?.monotonicDeadline).toBe(35_000);
  }
});

test("小数の単調時計でも残時間は正の整数になる", () => {
  const ctl = manualClock(1_000_000, 5_000.25);
  const limits = resolveLimits({
    pairingApprovalTimeoutMs: 120_000,
    acceptanceDurationMs: 60_000,
  });
  const acceptance = new AcceptanceController({ limits, clock: ctl.clock });
  const store = new PairingStore({
    limits,
    clock: ctl.clock,
    acceptance,
    generateCode: () => "123456",
  });
  acceptance.open();
  // 受付期限側が早い方の残りが小数になるよう半端に進める。
  ctl.advanceMono(0.5);
  const created = store.create("conn-a", "https://a.example");
  if (created.status !== "CREATED") throw new Error("保留が作れない。");
  // 生の残りは 59999.5、小数にならず切り上げの正の整数になる。
  expect(created.expiresInMs).toBe(60_000);
  expect(Number.isInteger(created.expiresInMs)).toBe(true);
  expect(created.expiresInMs).toBeGreaterThanOrEqual(1);
  // 取得・一覧・受付状態の残時間も整数である。
  const got = store.get(created.requestId);
  if (got === undefined) throw new Error("保留が見えない。");
  expect(Number.isInteger(got.remainingMs)).toBe(true);
  expect(got.remainingMs).toBeGreaterThanOrEqual(1);
  expect(store.list()[0]?.remainingMs).toBe(got.remainingMs);
  const status = acceptance.get();
  expect(Number.isInteger(status.remainingMs)).toBe(true);
  expect(status.remainingMs).toBeGreaterThanOrEqual(1);
  // 期限直前（残り 0.2ms）は切り上げで 1 になり、期限ちょうどでは失効する。
  ctl.set(1_000_000, 65_000.05);
  expect(store.get(created.requestId)?.remainingMs).toBe(1);
  ctl.set(1_000_000, 65_000.25);
  expect(store.get(created.requestId)).toBeUndefined();
});

test("期限以上では取得できず掃除される", () => {
  const { ctl, acceptance, store } = setupPairing(
    { pairingApprovalTimeoutMs: 1_000, acceptanceDurationMs: 60_000 },
    { generateCode: () => "123456" },
  );
  acceptance.open();
  const created = store.create("conn-a", "https://a.example");
  if (created.status !== "CREATED") throw new Error("保留が作れない。");
  // 期限内 (deadline 6000 の直前) は取得できる。
  ctl.set(1_000_000, 5_999);
  expect(store.get(created.requestId)?.requestId).toBe(created.requestId);
  // `now >= deadline` は失効する。境界ちょうどを含む。
  ctl.set(1_000_000, 6_000);
  expect(store.get(created.requestId)).toBeUndefined();
  expect(store.size()).toBe(0);
});

test("承認での失効は初回に理由を返し二度目は未保留になる", () => {
  const { ctl, acceptance, store } = setupPairing(
    { pairingApprovalTimeoutMs: 1_000, acceptanceDurationMs: 60_000 },
    { generateCode: () => "123456" },
  );
  acceptance.open();
  const created = store.create("conn-a", "https://a.example");
  if (created.status !== "CREATED") throw new Error("保留が作れない。");
  ctl.set(1_000_000, 6_000);
  expect(store.approve(created.requestId, "123456")).toEqual({ status: "PAIRING_EXPIRED" });
  expect(store.approve(created.requestId, "123456")).toEqual({ status: "NOT_PENDING" });
  expect(store.size()).toBe(0);
});

test("一覧・取得・重複開始は期限を延長しない", () => {
  const { ctl, acceptance, store } = setupPairing(
    { pairingApprovalTimeoutMs: 1_000, acceptanceDurationMs: 60_000 },
    { generateCode: () => "123456" },
  );
  acceptance.open();
  const created = store.create("conn-a", "https://a.example");
  if (created.status !== "CREATED") throw new Error("保留が作れない。");
  ctl.advanceMono(500);
  expect(store.list()).toHaveLength(1);
  expect(store.get(created.requestId)?.requestId).toBe(created.requestId);
  ctl.advanceMono(200);
  // 重複開始は新規作成せず期限も延ばさない。
  const duplicate = store.create("conn-a", "https://a.example");
  expect(duplicate).toEqual({ status: "ALREADY_PENDING", requestId: created.requestId });
  ctl.set(1_000_000, 6_000);
  expect(store.approve(created.requestId, "123456")).toEqual({ status: "PAIRING_EXPIRED" });
});

test("壁時計の変更では期限が延びも縮みもしない", () => {
  const { ctl, acceptance, store } = setupPairing(
    { pairingApprovalTimeoutMs: 1_000, acceptanceDurationMs: 600_000 },
    { generateCode: () => "123456" },
  );
  acceptance.open();
  const first = store.create("conn-a", "https://a.example");
  if (first.status !== "CREATED") throw new Error("1件目が作れない。");
  // 壁時計だけが大きく進んでも単調期限は動かない。
  ctl.advanceWall(10_000_000);
  expect(store.get(first.requestId)?.requestId).toBe(first.requestId);
  expect(store.approve(first.requestId, "123456").status).toBe("APPROVED");
  const second = store.create("conn-b", "https://b.example");
  if (second.status !== "CREATED") throw new Error("2件目が作れない。");
  // 単調時計だけが期限を超えれば壁時計が止まっていても失効する。
  ctl.advanceMono(1_001);
  expect(store.get(second.requestId)).toBeUndefined();
});

test("受付は起動時に閉じていて保留を作れない", () => {
  const { store, acceptance } = setupPairing();
  expect(acceptance.get()).toEqual({ state: "closed", endsAt: null, remainingMs: 0 });
  expect(acceptance.isOpen()).toBe(false);
  expect(store.create("conn-a", "https://a.example")).toEqual({
    status: "ACCEPTANCE_CLOSED",
  });
  expect(store.size()).toBe(0);
});

test("受付は開くと期限で自動クローズする", async () => {
  // 実タイマー経路: 短い受付時間で自動クローズを観測する。
  // タイマー遅延の揺らぎに備え、待ち時間に十分な猶予を持つ。
  {
    const limits = resolveLimits({ acceptanceDurationMs: 60 });
    const acceptance = new AcceptanceController({ limits });
    const opened = acceptance.open();
    expect(opened.state).toBe("open");
    expect(opened.endsAt).not.toBeNull();
    expect(opened.remainingMs).toBeGreaterThan(0);
    expect(opened.remainingMs).toBeLessThanOrEqual(60);
    await sleep(500);
    expect(acceptance.get().state).toBe("closed");
  }
  // 遅延タイマーに依らない経路: 単調時計が期限を超えれば待たずに閉じる。
  {
    const ctl = manualClock(1_000_000, 5_000);
    const limits = resolveLimits({ acceptanceDurationMs: 60_000 });
    const acceptance = new AcceptanceController({ limits, clock: ctl.clock });
    acceptance.open();
    ctl.advanceMono(60_001);
    expect(acceptance.get().state).toBe("closed");
    expect(acceptance.isOpen()).toBe(false);
  }
});

test("受付の再操作は期限を延長しない", () => {
  const ctl = manualClock(1_000_000, 5_000);
  const limits = resolveLimits({ acceptanceDurationMs: 1_000 });
  const acceptance = new AcceptanceController({ limits, clock: ctl.clock });
  const first = acceptance.open();
  expect(first).toEqual({ state: "open", endsAt: 1_001_000, remainingMs: 1_000 });
  ctl.advanceMono(600);
  const second = acceptance.open();
  expect(second).toEqual({ state: "open", endsAt: 1_001_000, remainingMs: 400 });
  // 閉じた後の再開は新しい期限を持つ。
  acceptance.close();
  ctl.advanceMono(100);
  ctl.advanceWall(700);
  const reopened = acceptance.open();
  expect(reopened).toEqual({ state: "open", endsAt: 1_001_700, remainingMs: 1_000 });
});

test("受付を手動で閉じると保留は失効し開き直しても復活しない", () => {
  const { acceptance, store } = setupPairing(undefined, { generateCode: () => "123456" });
  acceptance.open();
  const created = store.create("conn-a", "https://a.example");
  if (created.status !== "CREATED") throw new Error("保留が作れない。");
  acceptance.close();
  // 閉じた後は一覧・取得が空であり、旧要求は未保留になる。
  expect(store.list()).toEqual([]);
  expect(store.get(created.requestId)).toBeUndefined();
  expect(store.size()).toBe(0);
  expect(store.approve(created.requestId, "123456")).toEqual({ status: "NOT_PENDING" });
  expect(store.reject(created.requestId)).toEqual({ status: "NOT_PENDING" });
  // 開き直しても旧世代の保留は復活しない。
  acceptance.open();
  expect(store.list()).toEqual([]);
  expect(store.get(created.requestId)).toBeUndefined();
  expect(store.approve(created.requestId, "123456")).toEqual({ status: "NOT_PENDING" });
});

test("受付を閉じても要求ID採番は初期化しない", () => {
  const { acceptance, store } = setupPairing(undefined, { generateCode: () => "123456" });
  acceptance.open();
  const first = store.create("conn-a", "https://a.example");
  if (first.status !== "CREATED") throw new Error("1件目が作れない。");
  acceptance.close();
  acceptance.open();
  const second = store.create("conn-b", "https://b.example");
  if (second.status !== "CREATED") throw new Error("2件目が作れない。");
  // 失効した旧 ID は再利用しない。
  expect(second.requestId).not.toBe(first.requestId);
  expect(isPairingRequestId(second.requestId)).toBe(true);
});

test("承認の失敗理由は未保留・期限・ID・コード・接続の順で区別する", () => {
  const { ctl, acceptance, store } = setupPairing(
    { pairingApprovalTimeoutMs: 1_000, acceptanceDurationMs: 60_000 },
    { generateCode: () => "123456" },
  );
  // 未知 ID は他条件より先に未保留になる。
  expect(store.approve("pairing-unknown-1", "not-a-code")).toEqual({ status: "NOT_PENDING" });
  acceptance.open();
  const created = store.create("conn-a", "https://a.example");
  if (created.status !== "CREATED") throw new Error("保留が作れない。");
  // 閉じた世代の要求は受付終了ではなく未保留になる（不可逆に失効する）。
  acceptance.close();
  ctl.set(1_000_000, 6_000);
  expect(store.approve(created.requestId, "123456")).toEqual({ status: "NOT_PENDING" });
  // 閉じた受付での新規作成は受け付けない。
  expect(store.create("conn-b", "https://b.example")).toEqual({ status: "ACCEPTANCE_CLOSED" });
});

test("受付期限の到来を入口で検出すると保留は失効する", () => {
  const { ctl, acceptance, store } = setupPairing(
    { pairingApprovalTimeoutMs: 600_000, acceptanceDurationMs: 1_000 },
    { generateCode: () => "123456" },
  );
  acceptance.open();
  const created = store.create("conn-a", "https://a.example");
  if (created.status !== "CREATED") throw new Error("保留が作れない。");
  // 単調時計が受付期限を超えたら、どの入口でも閉として扱い保留は残らない。
  ctl.advanceMono(1_001);
  expect(acceptance.isOpen()).toBe(false);
  expect(store.list()).toEqual([]);
  expect(store.get(created.requestId)).toBeUndefined();
  expect(store.size()).toBe(0);
  expect(store.approve(created.requestId, "123456")).toEqual({ status: "NOT_PENDING" });
  // 期限をまたぐ新規作成は受け付けず、発行＋承認待ちへのフォールバックもしない。
  expect(store.create("conn-b", "https://b.example")).toEqual({ status: "ACCEPTANCE_CLOSED" });
  expect(store.size()).toBe(0);
});

test("遅延タイマーによる自動クローズでも閉から再開で旧要求は承認できない", async () => {
  const limits = resolveLimits({ pairingApprovalTimeoutMs: 600_000, acceptanceDurationMs: 60 });
  const { acceptance, store } = (() => {
    const inner = new AcceptanceController({ limits });
    const innerStore = new PairingStore({
      limits,
      acceptance: inner,
      generateCode: () => "123456",
    });
    return { acceptance: inner, store: innerStore };
  })();
  acceptance.open();
  const created = store.create("conn-a", "https://a.example");
  if (created.status !== "CREATED") throw new Error("保留が作れない。");
  // 自動クローズの遅延揺らぎに備え、十分な猶予をもって待つ。
  await sleep(500);
  expect(acceptance.get().state).toBe("closed");
  expect(store.list()).toEqual([]);
  expect(store.approve(created.requestId, "123456")).toEqual({ status: "NOT_PENDING" });
  acceptance.open();
  expect(store.list()).toEqual([]);
  expect(store.approve(created.requestId, "123456")).toEqual({ status: "NOT_PENDING" });
  // 新世代では新規作成ができる。
  const retry = store.create("conn-b", "https://b.example");
  expect(retry.status).toBe("CREATED");
});

test("閉直前の保留は閉で終わり閉後の承認と新規作成の前後関係を保つ", () => {
  const { acceptance, store } = setupPairing(undefined, { generateCode: () => "123456" });
  acceptance.open();
  const created = store.create("conn-a", "https://a.example");
  if (created.status !== "CREATED") throw new Error("保留が作れない。");
  const code = store.get(created.requestId)?.code;
  if (code === undefined) throw new Error("保留が見えない。");
  // 閉前の承認は成功する。
  expect(store.approve(created.requestId, code)).toEqual({
    status: "APPROVED",
    connectionId: "conn-a",
    origin: "https://a.example",
  });
  // 承認済みの要求は閉後に未保留であり、再開でも復活しない。
  acceptance.close();
  expect(store.approve(created.requestId, code)).toEqual({ status: "NOT_PENDING" });
  acceptance.open();
  expect(store.approve(created.requestId, code)).toEqual({ status: "NOT_PENDING" });
});

test("コード生成中に受付が閉じたら保留を作らず受付終了にする", () => {
  const ctl = manualClock(1_000_000, 5_000);
  const limits = resolveLimits();
  const acceptance = new AcceptanceController({ limits, clock: ctl.clock });
  const store = new PairingStore({
    limits,
    clock: ctl.clock,
    acceptance,
    generateCode: () => {
      acceptance.close();
      return "123456";
    },
  });
  acceptance.open();
  // 登録時の世代確認がなければ保留が残ってしまう。
  expect(store.create("conn-a", "https://a.example")).toEqual({ status: "ACCEPTANCE_CLOSED" });
  expect(store.size()).toBe(0);
  expect(store.list()).toEqual([]);
});

test("世代をまたぐ保留の持ち越しは拒否され同一接続は新規作成できる", () => {
  const { acceptance, store } = setupPairing(undefined, { generateCode: () => "123456" });
  acceptance.open();
  const first = store.create("conn-a", "https://a.example");
  if (first.status !== "CREATED") throw new Error("1件目が作れない。");
  acceptance.close();
  acceptance.open();
  // 旧世代の要求は未保留であり、同一接続の新規作成を妨げない。
  expect(store.get(first.requestId)).toBeUndefined();
  expect(store.approve(first.requestId, "123456")).toEqual({ status: "NOT_PENDING" });
  const second = store.create("conn-a", "https://a.example");
  expect(second.status).toBe("CREATED");
  if (second.status !== "CREATED") throw new Error("2件目が作れない。");
  expect(second.requestId).not.toBe(first.requestId);
});

test("複数の保留は受付クローズですべて終わる", () => {
  const calls = { count: 0 };
  const { acceptance, store } = setupPairing(undefined, {
    generateCode: queuedCodes(["111111", "222222"], calls),
  });
  acceptance.open();
  const first = store.create("conn-a", "https://a.example");
  const second = store.create("conn-b", "https://b.example");
  if (first.status !== "CREATED" || second.status !== "CREATED") {
    throw new Error("保留が作れない。");
  }
  expect(store.size()).toBe(2);
  acceptance.close();
  // 開始待ち・承認待ちはこのモジュールでは保留エントリとして表され、すべて消える。
  expect(store.list()).toEqual([]);
  expect(store.size()).toBe(0);
  expect(store.get(first.requestId)).toBeUndefined();
  expect(store.get(second.requestId)).toBeUndefined();
  expect(store.approve(first.requestId, "111111")).toEqual({ status: "NOT_PENDING" });
  expect(store.approve(second.requestId, "222222")).toEqual({ status: "NOT_PENDING" });
});

test("生存判定の例外は内部エラーとして対象だけを終わらせる", () => {
  const { acceptance, store } = setupPairing(undefined, {
    generateCode: (() => {
      const codes = ["111111", "222222"];
      return () => {
        const next = codes.shift();
        if (next === undefined) throw new Error("生成回数が想定を超えた。");
        return next;
      };
    })(),
    isConnectionAlive: (connectionId: string) => {
      if (connectionId === "conn-bad") throw new Error("生存確認が壊れた。");
      return true;
    },
  });
  acceptance.open();
  const good = store.create("conn-good", "https://a.example");
  const bad = store.create("conn-bad", "https://b.example");
  if (good.status !== "CREATED" || bad.status !== "CREATED") {
    throw new Error("保留が作れない。");
  }
  // 生存不明を切断済みと断定せず、専用の失敗結果を返す。例外は呼び出し側へ漏らさない。
  expect(store.approve(bad.requestId, "222222")).toEqual({ status: "CONNECTION_CHECK_ERROR" });
  // 対象のエントリは残らないが、他要求は巻き込まない。
  expect(store.approve(bad.requestId, "222222")).toEqual({ status: "NOT_PENDING" });
  expect(store.get(bad.requestId)).toBeUndefined();
  expect(store.approve(good.requestId, "111111")).toEqual({
    status: "APPROVED",
    connectionId: "conn-good",
    origin: "https://a.example",
  });
});

test("書式不正のコードは無効で保留は残る", () => {
  const { acceptance, store } = setupPairing(undefined, { generateCode: () => "123456" });
  acceptance.open();
  const created = store.create("conn-a", "https://a.example");
  if (created.status !== "CREATED") throw new Error("保留が作れない。");
  expect(store.approve(created.requestId, "abc")).toEqual({ status: "INVALID_CODE" });
  expect(store.approve(created.requestId, "12345")).toEqual({ status: "INVALID_CODE" });
  expect(store.get(created.requestId)?.requestId).toBe(created.requestId);
  expect(store.approve(created.requestId, "123456").status).toBe("APPROVED");
});

test("コード不一致は区別され保留は残る", () => {
  const { acceptance, store } = setupPairing(undefined, { generateCode: () => "123456" });
  acceptance.open();
  const created = store.create("conn-a", "https://a.example");
  if (created.status !== "CREATED") throw new Error("保留が作れない。");
  expect(store.approve(created.requestId, "654321")).toEqual({ status: "CODE_MISMATCH" });
  expect(store.get(created.requestId)?.requestId).toBe(created.requestId);
  expect(store.approve(created.requestId, "123456").status).toBe("APPROVED");
});

test("接続が死んだ保留は承認できず終わる", () => {
  const alive = new Set(["conn-a", "conn-b"]);
  const calls = { count: 0 };
  const { acceptance, store } = setupPairing(undefined, {
    generateCode: queuedCodes(["111111", "222222"], calls),
    isConnectionAlive: (connectionId: string) => alive.has(connectionId),
  });
  acceptance.open();
  const first = store.create("conn-a", "https://a.example");
  const second = store.create("conn-b", "https://b.example");
  if (first.status !== "CREATED" || second.status !== "CREATED") {
    throw new Error("保留が作れない。");
  }
  alive.delete("conn-b");
  expect(store.approve(second.requestId, "222222")).toEqual({ status: "CONNECTION_GONE" });
  expect(store.approve(second.requestId, "222222")).toEqual({ status: "NOT_PENDING" });
  expect(store.approve(first.requestId, "111111").status).toBe("APPROVED");
});

test("拒否・取下げ・掃除ができる", () => {
  const { ctl, acceptance, store } = setupPairing(
    { pairingApprovalTimeoutMs: 1_000, acceptanceDurationMs: 600_000 },
    { generateCode: () => "123456" },
  );
  acceptance.open();
  const created = store.create("conn-a", "https://a.example");
  if (created.status !== "CREATED") throw new Error("保留が作れない。");
  expect(store.reject(created.requestId)).toEqual({ status: "REJECTED" });
  expect(store.reject(created.requestId)).toEqual({ status: "NOT_PENDING" });
  expect(store.remove("pairing-unknown-1")).toBe(false);
  const second = store.create("conn-b", "https://b.example");
  if (second.status !== "CREATED") throw new Error("2件目が作れない。");
  // 同一コードの使い回し生成でも生存衝突はない（1件目は拒否済み）。
  expect(store.remove(second.requestId)).toBe(true);
  expect(store.size()).toBe(0);

  const third = store.create("conn-c", "https://c.example");
  if (third.status !== "CREATED") throw new Error("3件目が作れない。");
  ctl.advanceMono(5_000);
  expect(store.sweep()).toBe(1);
  expect(store.size()).toBe(0);
});

test("保留枠が満杯なら拒否し期限後に回復する", () => {
  const { ctl, acceptance, store } = setupPairing({
    pairingApprovalTimeoutMs: 1_000,
    acceptanceDurationMs: 600_000,
    maxPendingPairings: 2,
    maxUnauthorizedConnections: 2,
  });
  acceptance.open();
  const first = store.create("conn-a", "https://a.example");
  const second = store.create("conn-b", "https://b.example");
  if (first.status !== "CREATED" || second.status !== "CREATED") {
    throw new Error("保留が作れない。");
  }
  expect(store.create("conn-c", "https://c.example")).toEqual({ status: "PENDING_FULL" });
  ctl.advanceMono(5_000);
  const retry = store.create("conn-c", "https://c.example");
  expect(retry.status).toBe("CREATED");
});

test("レートは60秒境界で窓から外れる", () => {
  const ctl = manualClock(0, 0);
  const limits = resolveLimits({
    pairingRateWindowMs: 60_000,
    maxPairingRequestsPerOrigin: 2,
    maxPairingRequestsTotal: 10,
  });
  const limiter = new PairingRateLimiter({ limits, clock: ctl.clock });
  expect(limiter.checkAndRecord("https://a.example")).toEqual({ allowed: true });
  expect(limiter.checkAndRecord("https://a.example")).toEqual({ allowed: true });
  expect(limiter.checkAndRecord("https://a.example")).toEqual({
    allowed: false,
    reason: "ORIGIN_RATE_LIMITED",
  });
  // 境界ちょうど前は窓内であり続ける。
  ctl.set(0, 59_999);
  expect(limiter.checkAndRecord("https://a.example")).toEqual({
    allowed: false,
    reason: "ORIGIN_RATE_LIMITED",
  });
  // `(now-window, now]` から外れた記録は数えない。
  ctl.set(0, 60_000);
  expect(limiter.checkAndRecord("https://a.example")).toEqual({ allowed: true });
  expect(limiter.countFor("https://a.example")).toBe(1);
});

test("Origin別と全体の上限は独立に判定する", () => {
  const ctl = manualClock(0, 0);
  const limits = resolveLimits({
    pairingRateWindowMs: 60_000,
    maxPairingRequestsPerOrigin: 5,
    maxPairingRequestsTotal: 10,
  });
  const limiter = new PairingRateLimiter({ limits, clock: ctl.clock });
  for (let index = 0; index < 5; index += 1) {
    expect(limiter.checkAndRecord("https://a.example")).toEqual({ allowed: true });
  }
  // Origin 別の上限は他 Origin に影響しない。
  expect(limiter.checkAndRecord("https://a.example")).toEqual({
    allowed: false,
    reason: "ORIGIN_RATE_LIMITED",
  });
  for (let index = 0; index < 5; index += 1) {
    expect(limiter.checkAndRecord("https://b.example")).toEqual({ allowed: true });
  }
  // 全体が満杯でも Origin 別に空きがある要求は全体理由で拒否する。
  expect(limiter.checkAndRecord("https://c.example")).toEqual({
    allowed: false,
    reason: "TOTAL_RATE_LIMITED",
  });
  expect(limiter.countTotal()).toBe(10);
  expect(limiter.countFor("https://c.example")).toBe(0);
});

test("受付の開閉でレート履歴はリセットしない", () => {
  const ctl = manualClock(0, 0);
  const limits = resolveLimits();
  const acceptance = new AcceptanceController({ limits, clock: ctl.clock });
  const limiter = new PairingRateLimiter({ limits, clock: ctl.clock });
  for (let index = 0; index < 3; index += 1) {
    expect(limiter.checkAndRecord("https://a.example")).toEqual({ allowed: true });
  }
  acceptance.open();
  acceptance.close();
  expect(limiter.countFor("https://a.example")).toBe(3);
  expect(limiter.countTotal()).toBe(3);
});

test("拒否した試行は履歴に追加しない", () => {
  const ctl = manualClock(0, 0);
  const limits = resolveLimits({
    pairingRateWindowMs: 1_000,
    maxPairingRequestsPerOrigin: 2,
    maxPairingRequestsTotal: 10,
  });
  const limiter = new PairingRateLimiter({ limits, clock: ctl.clock });
  expect(limiter.checkAndRecord("https://a.example")).toEqual({ allowed: true });
  ctl.set(0, 100);
  expect(limiter.checkAndRecord("https://a.example")).toEqual({ allowed: true });
  // 3件目は拒否され、履歴に残らない。
  ctl.set(0, 200);
  expect(limiter.checkAndRecord("https://a.example")).toEqual({
    allowed: false,
    reason: "ORIGIN_RATE_LIMITED",
  });
  // 1件目の記録だけが窓から外れた時点で空きが戻る。
  // 拒否分が残っていれば 2件（100・200）で拒否され続ける。
  ctl.set(0, 1_000);
  expect(limiter.countFor("https://a.example")).toBe(1);
  expect(limiter.checkAndRecord("https://a.example")).toEqual({ allowed: true });
});
