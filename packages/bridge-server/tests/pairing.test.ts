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

/** 受付を有効化する前の保留管理とその部品を組立てる。 */
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
  const acceptance = new AcceptanceController();
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
  acceptance.enable();
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

test("作成結果は要求IDとコードだけを持ち期限を持たない", () => {
  const { acceptance, store } = setupPairing(undefined, { generateCode: () => "123456" });
  acceptance.enable();
  const created = store.create("conn-a", "https://a.example");
  if (created.status !== "CREATED") throw new Error("保留が作れない。");
  expect(Object.keys(created).sort()).toEqual(["code", "requestId", "status"]);
  const got = store.get(created.requestId);
  if (got === undefined) throw new Error("保留が見えない。");
  expect(Object.keys(got).sort()).toEqual([
    "code",
    "connectionId",
    "issuedAt",
    "origin",
    "requestId",
  ]);
  expect(got.issuedAt).toBe(1_000_000);
});

test("生存保留と重複するコードは全Origin横断で再生成する", () => {
  const calls = { count: 0 };
  const { acceptance, store } = setupPairing(undefined, {
    generateCode: queuedCodes(["111111", "111111", "222222"], calls),
  });
  acceptance.enable();
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
  acceptance.enable();
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
  acceptance.enable();
  expect(store.create("conn-a", "https://a.example")).toEqual({
    status: "CODE_GENERATION_FAILED",
  });
  expect(store.size()).toBe(0);
});

test("要求IDは削除後も再利用しない", () => {
  const { acceptance, store } = setupPairing();
  acceptance.enable();
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

test("時計を大きく進めても受付と保留は自動終了しない", () => {
  const { ctl, acceptance, store } = setupPairing(undefined, {
    generateCode: () => "123456",
  });
  acceptance.enable();
  const created = store.create("conn-a", "https://a.example");
  if (created.status !== "CREATED") throw new Error("保留が作れない。");
  // 壁時計・単調時計の双方を大きく進めても、受付も保留も残る。
  ctl.advanceWall(10_000_000);
  ctl.advanceMono(10_000_000);
  expect(acceptance.isEnabled()).toBe(true);
  expect(acceptance.get()).toEqual({ enabled: true });
  expect(store.get(created.requestId)?.requestId).toBe(created.requestId);
  expect(store.list()).toHaveLength(1);
  expect(store.size()).toBe(1);
  // 承認も通る。
  expect(store.approve(created.requestId, "123456")).toEqual({
    status: "APPROVED",
    connectionId: "conn-a",
    origin: "https://a.example",
  });
  // 新規作成もできる。
  const second = store.create("conn-b", "https://b.example");
  expect(second.status).toBe("CREATED");
});

test("受付は起動時に無効で保留を作れない", () => {
  const { store, acceptance } = setupPairing();
  expect(acceptance.get()).toEqual({ enabled: false });
  expect(acceptance.isEnabled()).toBe(false);
  expect(store.create("conn-a", "https://a.example")).toEqual({
    status: "ACCEPTANCE_CLOSED",
  });
  expect(store.size()).toBe(0);
});

test("有効化と無効化は冪等で無効化通知は遷移時だけ送る", () => {
  const { acceptance, store } = setupPairing(undefined, { generateCode: () => "123456" });
  let closedCount = 0;
  acceptance.onClose(() => {
    closedCount += 1;
  });
  expect(acceptance.enable()).toEqual({ enabled: true });
  // 有効中の再有効化は冪等であり、世代も通知も動かさない。
  expect(acceptance.enable()).toEqual({ enabled: true });
  expect(closedCount).toBe(0);
  const created = store.create("conn-a", "https://a.example");
  if (created.status !== "CREATED") throw new Error("保留が作れない。");
  expect(acceptance.disable()).toEqual({ enabled: false });
  expect(closedCount).toBe(1);
  // 無効中の再無効化は通知を送らない。
  expect(acceptance.disable()).toEqual({ enabled: false });
  expect(closedCount).toBe(1);
  // 再有効化でも無効化通知は増えない。
  acceptance.enable();
  expect(closedCount).toBe(1);
  acceptance.disable();
  expect(closedCount).toBe(2);
});

test("受付を無効にすると保留は失効し再有効化で復活しない", () => {
  const { acceptance, store } = setupPairing(undefined, { generateCode: () => "123456" });
  acceptance.enable();
  const created = store.create("conn-a", "https://a.example");
  if (created.status !== "CREATED") throw new Error("保留が作れない。");
  acceptance.disable();
  // 無効化後は一覧・取得が空であり、旧要求は未保留になる。
  expect(store.list()).toEqual([]);
  expect(store.get(created.requestId)).toBeUndefined();
  expect(store.size()).toBe(0);
  expect(store.approve(created.requestId, "123456")).toEqual({ status: "NOT_PENDING" });
  expect(store.reject(created.requestId)).toEqual({ status: "NOT_PENDING" });
  // 再有効化しても旧世代の保留は復活しない。
  acceptance.enable();
  expect(store.list()).toEqual([]);
  expect(store.get(created.requestId)).toBeUndefined();
  expect(store.approve(created.requestId, "123456")).toEqual({ status: "NOT_PENDING" });
});

test("受付を切替えても要求ID採番は初期化しない", () => {
  const { acceptance, store } = setupPairing(undefined, { generateCode: () => "123456" });
  acceptance.enable();
  const first = store.create("conn-a", "https://a.example");
  if (first.status !== "CREATED") throw new Error("1件目が作れない。");
  acceptance.disable();
  acceptance.enable();
  const second = store.create("conn-b", "https://b.example");
  if (second.status !== "CREATED") throw new Error("2件目が作れない。");
  // 失効した旧 ID は再利用しない。
  expect(second.requestId).not.toBe(first.requestId);
  expect(isPairingRequestId(second.requestId)).toBe(true);
});

test("承認の失敗理由は未保留・書式・不一致・接続の順で区別する", () => {
  const { acceptance, store } = setupPairing(undefined, { generateCode: () => "123456" });
  // 未知 ID は他条件より先に未保留になる。
  expect(store.approve("pairing-unknown-1", "not-a-code")).toEqual({ status: "NOT_PENDING" });
  acceptance.enable();
  const created = store.create("conn-a", "https://a.example");
  if (created.status !== "CREATED") throw new Error("保留が作れない。");
  // 書式不正は無効であり保留は残る。
  expect(store.approve(created.requestId, "abc")).toEqual({ status: "INVALID_CODE" });
  expect(store.get(created.requestId)?.requestId).toBe(created.requestId);
  // コード不一致は区別され保留は残る。
  expect(store.approve(created.requestId, "654321")).toEqual({ status: "CODE_MISMATCH" });
  expect(store.get(created.requestId)?.requestId).toBe(created.requestId);
  // 無効化で失効した世代の要求は未保留になる（不可逆に失効する）。
  acceptance.disable();
  expect(store.approve(created.requestId, "123456")).toEqual({ status: "NOT_PENDING" });
  // 無効な受付での新規作成は受け付けない。
  expect(store.create("conn-b", "https://b.example")).toEqual({ status: "ACCEPTANCE_CLOSED" });
});

test("無効前の承認は成功し承認済みは再有効化で復活しない", () => {
  const { acceptance, store } = setupPairing(undefined, { generateCode: () => "123456" });
  acceptance.enable();
  const created = store.create("conn-a", "https://a.example");
  if (created.status !== "CREATED") throw new Error("保留が作れない。");
  const code = store.get(created.requestId)?.code;
  if (code === undefined) throw new Error("保留が見えない。");
  // 無効前の承認は成功する。
  expect(store.approve(created.requestId, code)).toEqual({
    status: "APPROVED",
    connectionId: "conn-a",
    origin: "https://a.example",
  });
  // 承認済みの要求は無効後に未保留であり、再有効化でも復活しない。
  acceptance.disable();
  expect(store.approve(created.requestId, code)).toEqual({ status: "NOT_PENDING" });
  acceptance.enable();
  expect(store.approve(created.requestId, code)).toEqual({ status: "NOT_PENDING" });
});

test("コード生成中の無効化と再有効化では旧世代として作らない", () => {
  const limits = resolveLimits();
  const acceptance = new AcceptanceController();
  const store = new PairingStore({
    limits,
    acceptance,
    generateCode: () => {
      acceptance.disable();
      acceptance.enable();
      return "123456";
    },
  });
  acceptance.enable();
  // 登録時の世代確認がなければ新世代の保留として残ってしまう。
  expect(store.create("conn-a", "https://a.example")).toEqual({ status: "ACCEPTANCE_CLOSED" });
  expect(store.size()).toBe(0);
  expect(store.list()).toEqual([]);
});

test("コード生成中の無効化だけでも保留を作らない", () => {
  const limits = resolveLimits();
  const acceptance = new AcceptanceController();
  const store = new PairingStore({
    limits,
    acceptance,
    generateCode: () => {
      acceptance.disable();
      return "123456";
    },
  });
  acceptance.enable();
  expect(store.create("conn-a", "https://a.example")).toEqual({ status: "ACCEPTANCE_CLOSED" });
  expect(store.size()).toBe(0);
});

test("世代をまたぐ保留の持ち越しは拒否され同一接続は新規作成できる", () => {
  const { acceptance, store } = setupPairing(undefined, { generateCode: () => "123456" });
  acceptance.enable();
  const first = store.create("conn-a", "https://a.example");
  if (first.status !== "CREATED") throw new Error("1件目が作れない。");
  acceptance.disable();
  acceptance.enable();
  // 旧世代の要求は未保留であり、同一接続の新規作成を妨げない。
  expect(store.get(first.requestId)).toBeUndefined();
  expect(store.approve(first.requestId, "123456")).toEqual({ status: "NOT_PENDING" });
  const second = store.create("conn-a", "https://a.example");
  expect(second.status).toBe("CREATED");
  if (second.status !== "CREATED") throw new Error("2件目が作れない。");
  expect(second.requestId).not.toBe(first.requestId);
});

test("複数の保留は受付無効化ですべて終わる", () => {
  const calls = { count: 0 };
  const { acceptance, store } = setupPairing(undefined, {
    generateCode: queuedCodes(["111111", "222222"], calls),
  });
  acceptance.enable();
  const first = store.create("conn-a", "https://a.example");
  const second = store.create("conn-b", "https://b.example");
  if (first.status !== "CREATED" || second.status !== "CREATED") {
    throw new Error("保留が作れない。");
  }
  expect(store.size()).toBe(2);
  acceptance.disable();
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
  acceptance.enable();
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
  acceptance.enable();
  const created = store.create("conn-a", "https://a.example");
  if (created.status !== "CREATED") throw new Error("保留が作れない。");
  expect(store.approve(created.requestId, "abc")).toEqual({ status: "INVALID_CODE" });
  expect(store.approve(created.requestId, "12345")).toEqual({ status: "INVALID_CODE" });
  expect(store.get(created.requestId)?.requestId).toBe(created.requestId);
  expect(store.approve(created.requestId, "123456").status).toBe("APPROVED");
});

test("コード不一致は区別され保留は残る", () => {
  const { acceptance, store } = setupPairing(undefined, { generateCode: () => "123456" });
  acceptance.enable();
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
  acceptance.enable();
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

test("生存確認中に対象が消えたら承認せず未保留になる", () => {
  // 切断処理との交差を再現する。生存確認の実行中に対象の保留が除去されても、
  // 確認結果だけで承認を成立させない。
  const limits = resolveLimits();
  const acceptance = new AcceptanceController();
  let storeRef: PairingStore | undefined;
  const store = new PairingStore({
    limits,
    acceptance,
    generateCode: () => "123456",
    isConnectionAlive: (connectionId: string) => {
      void connectionId;
      // 確認中に切断相当の除去が割り込む。
      storeRef?.remove(targetId);
      return true;
    },
  });
  storeRef = store;
  acceptance.enable();
  const created = store.create("conn-a", "https://a.example");
  if (created.status !== "CREATED") throw new Error("保留が作れない。");
  const targetId: string = created.requestId;
  expect(store.approve(targetId, "123456")).toEqual({ status: "NOT_PENDING" });
  expect(store.size()).toBe(0);
});

test("拒否・取下げができる", () => {
  const { acceptance, store } = setupPairing(undefined, { generateCode: () => "123456" });
  acceptance.enable();
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
});

test("保留枠が満杯なら拒否し取下げで回復する", () => {
  const { acceptance, store } = setupPairing({
    maxPendingPairings: 2,
    maxUnauthorizedConnections: 2,
  });
  acceptance.enable();
  const first = store.create("conn-a", "https://a.example");
  const second = store.create("conn-b", "https://b.example");
  if (first.status !== "CREATED" || second.status !== "CREATED") {
    throw new Error("保留が作れない。");
  }
  expect(store.create("conn-c", "https://c.example")).toEqual({ status: "PENDING_FULL" });
  // 時間経過ではなく取下げで枠が回復する。
  expect(store.reject(first.requestId)).toEqual({ status: "REJECTED" });
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

test("受付の切替でレート履歴はリセットしない", () => {
  const ctl = manualClock(0, 0);
  const limits = resolveLimits();
  const acceptance = new AcceptanceController();
  const limiter = new PairingRateLimiter({ limits, clock: ctl.clock });
  for (let index = 0; index < 3; index += 1) {
    expect(limiter.checkAndRecord("https://a.example")).toEqual({ allowed: true });
  }
  acceptance.enable();
  acceptance.disable();
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
