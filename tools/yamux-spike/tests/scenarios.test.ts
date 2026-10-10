import { expect, test } from "vite-plus/test";
import {
  scenarioCoalesce,
  scenarioFin,
  scenarioGoAway,
  scenarioMultiplex,
  scenarioPing,
  scenarioPrelude,
  scenarioRst,
  scenarioSplit,
  scenarioWindow,
  scenarioWindowGrowthControl,
  scenarioWindowNoGrowth,
} from "../src/scenarios.ts";

test("認可プリリュードを経て同じソケットで mux が動き echo が往復する", async () => {
  const found = await scenarioPrelude();
  expect(found.ok).toBe(true);
}, 20_000);

test("複数の stream を同時に開き独立に往復できる", async () => {
  const found = await scenarioMultiplex();
  expect(found.ok).toBe(true);
  expect(found.data["echoed"]).toHaveLength(4);
}, 20_000);

test("WS メッセージを分割しても集約しても復元できる", async () => {
  const split = await scenarioSplit();
  expect(split.ok).toBe(true);
  expect((split.data["wsMessageCount"] as number) > (split.data["sendDataCalls"] as number)).toBe(
    true,
  );
  const coalesced = await scenarioCoalesce();
  expect(coalesced.ok).toBe(true);
  expect(
    (coalesced.data["wsMessageCount"] as number) < (coalesced.data["sendDataCalls"] as number),
  ).toBe(true);
}, 20_000);

test("FIN で片方向が終わり逆方向は継続できる", async () => {
  const found = await scenarioFin();
  expect(found.ok).toBe(true);
  expect(found.data["clientMuxerStatus"]).toBe("open");
  expect(found.data["serverMuxerStatus"]).toBe("open");
}, 20_000);

test("RST で対象 stream だけが中断し他 stream は継続する", async () => {
  const found = await scenarioRst();
  expect(found.ok).toBe(true);
}, 20_000);

test("GoAway で mux 全体の終了が観測できる", async () => {
  const found = await scenarioGoAway();
  expect(found.ok).toBe(true);
  expect(found.data["serverMuxerStatus"]).toBe("closed");
}, 20_000);

test("window 枯渇で送信が待たされ読み再開で進む", async () => {
  const found = await scenarioWindow();
  expect(found.ok).toBe(true);
  expect(found.data["drainWhilePaused"]).toBe(false);
  expect(found.data["receivedBytes"]).toBe(40 * 32 * 1024);
}, 30_000);

test("RTT 既知でも受信 window が 256KiB を超えて拡大しない", async () => {
  const found = await scenarioWindowNoGrowth();
  expect(found.ok).toBe(true);
  expect(found.data["maxRecvWindow"]).toBeLessThanOrEqual(256 * 1024);
}, 30_000);

test("抑止を外すと受信 window が拡大する（対照）", async () => {
  const found = await scenarioWindowGrowthControl();
  expect(found.ok).toBe(true);
  expect(found.data["maxRecvWindow"]).toBeGreaterThan(256 * 1024);
}, 30_000);

test("ping が往復し終了後の ping は失敗する", async () => {
  const found = await scenarioPing();
  expect(found.ok).toBe(true);
}, 20_000);
