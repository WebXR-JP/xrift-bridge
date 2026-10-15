/**
 * UDP転送契約の単体試験。
 *
 * 契約モジュール（型・検証関数・定数）の振る舞いと、ブラウザ安全の条件
 * （サーバー依存の import がないこと・subpath の公開）を確かめる。
 * 契約の検証は実行時の検証であり、型注釈では代替しない。
 *
 * @packageDocumentation
 */
import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "vite-plus/test";
import {
  UDP_DATAGRAM_OP,
  UDP_MAX_DATAGRAM_BYTES,
  UDP_SESSION_ID,
  UDP_SOURCE_ADDRESS_MAX_LENGTH,
  decodeUdpData,
  encodeUdpData,
  isBase64Text,
  isIPv4LiteralAddress,
  isIPv6LiteralAddress,
  isLoopbackAddress,
  isUdpDatagramMessage,
  isUdpSource,
} from "../src/contract.ts";

test("空のデータグラムは転送形状になる", () => {
  // 空受信（0 バイト）は破棄せず転送できることを確かめる。
  const 空 = new Uint8Array(0);
  const 送信 = {
    op: "datagram",
    dataBase64: encodeUdpData(空),
    source: { address: "127.0.0.1", port: 40000 },
  };
  expect(isUdpDatagramMessage(送信)).toBe(true);
  expect(decodeUdpData(送信.dataBase64)).toEqual(空);
});

test("バイナリは欠けずに往復する", () => {
  // 全バイト値を含む受信が base64 で欠けずに戻ることを確かめる。
  const 全値 = new Uint8Array(256);
  for (let i = 0; i < 全値.length; i += 1) {
    全値[i] = i;
  }
  const 符号化 = encodeUdpData(全値);
  expect(isBase64Text(符号化)).toBe(true);
  expect(decodeUdpData(符号化)).toEqual(全値);
  expect(
    isUdpDatagramMessage({
      op: "datagram",
      dataBase64: 符号化,
      source: { address: "::1", port: 40000 },
    }),
  ).toBe(true);
});

test("上限ちょうどは通り超過は拒否される", () => {
  // 復号後上限（48,000 バイト）の境界を確かめる。
  expect(UDP_MAX_DATAGRAM_BYTES).toBe(48_000);
  const 上限ちょうど = new Uint8Array(UDP_MAX_DATAGRAM_BYTES);
  expect(
    isUdpDatagramMessage({
      op: "datagram",
      dataBase64: encodeUdpData(上限ちょうど),
      source: { address: "127.0.0.1", port: 40000 },
    }),
  ).toBe(true);
  const 上限超過 = new Uint8Array(UDP_MAX_DATAGRAM_BYTES + 1);
  expect(
    isUdpDatagramMessage({
      op: "datagram",
      dataBase64: encodeUdpData(上限超過),
      source: { address: "127.0.0.1", port: 40000 },
    }),
  ).toBe(false);
});

test("不正なbase64は拒否される", () => {
  // 字形不正・復号不能な dataBase64 を受け付けないことを確かめる。
  const 不正値: unknown[] = ["あいうえお", "****", "abc", "abcd=", "ab cd", 123, null];
  for (const dataBase64 of 不正値) {
    expect(
      isUdpDatagramMessage({
        op: "datagram",
        dataBase64,
        source: { address: "127.0.0.1", port: 1 },
      }),
    ).toBe(false);
  }
});

test("不正な形状・余分なキーは拒否される", () => {
  // 操作名・キー数・送信元の不正を確かめる。
  const 正当 = encodeUdpData(new Uint8Array([1, 2, 3]));
  const 不正値: unknown[] = [
    { op: "datagram", dataBase64: 正当 },
    { op: "datagram", source: { address: "127.0.0.1", port: 1 } },
    { op: "datagram", dataBase64: 正当, source: { address: "127.0.0.1", port: 1 }, 余分: true },
    { op: "datagram", dataBase64: 正当, source: { address: "127.0.0.1", port: 1, 余分: true } },
    { op: "show", dataBase64: 正当, source: { address: "127.0.0.1", port: 1 } },
    { op: "datagram", dataBase64: 正当, source: { address: "", port: 1 } },
    { op: "datagram", dataBase64: 正当, source: { address: "a".repeat(257), port: 1 } },
    { op: "datagram", dataBase64: 正当, source: { address: "127.0.0.1", port: -1 } },
    { op: "datagram", dataBase64: 正当, source: { address: "127.0.0.1", port: 65536 } },
    { op: "datagram", dataBase64: 正当, source: { address: "127.0.0.1", port: 1.5 } },
    { op: "datagram", dataBase64: 正当, source: { address: "127.0.0.1" } },
    null,
    [],
    "文字列",
  ];
  for (const payload of 不正値) {
    expect(isUdpDatagramMessage(payload)).toBe(false);
  }
  expect(UDP_SOURCE_ADDRESS_MAX_LENGTH).toBe(256);
});

test("送信元の判定は表記とポート範囲を見る", () => {
  // 送信元単体の正常・不正形状を確かめる。
  expect(isUdpSource({ address: "127.0.0.1", port: 0 })).toBe(true);
  expect(isUdpSource({ address: "fe80::1", port: 65535 })).toBe(true);
  expect(isUdpSource({ address: "", port: 1 })).toBe(false);
  expect(isUdpSource({ address: "127.0.0.1", port: 65536 })).toBe(false);
  expect(isUdpSource({ address: "127.0.0.1", port: 1, 余分: true })).toBe(false);
  expect(isUdpSource(null)).toBe(false);
});

test("数値リテラルの判定はホスト名と省略を拒否する", () => {
  // bind 設定に使える表記だけを通すことを確かめる。
  expect(isIPv4LiteralAddress("127.0.0.1")).toBe(true);
  expect(isIPv4LiteralAddress("0.0.0.0")).toBe(true);
  expect(isIPv4LiteralAddress("255.255.255.255")).toBe(true);
  expect(isIPv4LiteralAddress("localhost")).toBe(false);
  expect(isIPv4LiteralAddress("")).toBe(false);
  expect(isIPv4LiteralAddress("127.0.0.256")).toBe(false);
  expect(isIPv4LiteralAddress("127.0.0")).toBe(false);
  expect(isIPv6LiteralAddress("::1")).toBe(true);
  expect(isIPv6LiteralAddress("::")).toBe(true);
  expect(isIPv6LiteralAddress("fe80::1")).toBe(true);
  expect(isIPv6LiteralAddress("0:0:0:0:0:0:0:1")).toBe(true);
  expect(isIPv6LiteralAddress("::ffff:192.0.2.1")).toBe(true);
  expect(isIPv6LiteralAddress("localhost")).toBe(false);
  expect(isIPv6LiteralAddress("")).toBe(false);
  expect(isIPv6LiteralAddress("127.0.0.1")).toBe(false);
  expect(isIPv6LiteralAddress("1::2::3")).toBe(false);
  expect(isIPv6LiteralAddress("fe80::1%eth0")).toBe(false);
});

test("先行ゼロのIPv4リテラルは拒否される", () => {
  // 数値リテラルとして厳密に扱い、先行ゼロ付きオクテットを拒否することを確かめる。
  expect(isIPv4LiteralAddress("0.0.0.0")).toBe(true);
  expect(isIPv4LiteralAddress("127.0.0.1")).toBe(true);
  expect(isIPv4LiteralAddress("255.255.255.255")).toBe(true);
  expect(isIPv4LiteralAddress("01.2.3.4")).toBe(false);
  expect(isIPv4LiteralAddress("1.2.3.004")).toBe(false);
  expect(isIPv4LiteralAddress("00.0.0.0")).toBe(false);
  expect(isIPv4LiteralAddress("256.0.0.1")).toBe(false);
  expect(isLoopbackAddress("0127.0.0.1")).toBe(false);
});

test("loopbackの判定は安全側に倒す", () => {
  // loopback だけを確認なしで bind できることを確かめる。
  expect(isLoopbackAddress("127.0.0.1")).toBe(true);
  expect(isLoopbackAddress("127.0.0.2")).toBe(true);
  expect(isLoopbackAddress("::1")).toBe(true);
  expect(isLoopbackAddress("0:0:0:0:0:0:0:1")).toBe(true);
  expect(isLoopbackAddress("192.168.0.1")).toBe(false);
  expect(isLoopbackAddress("0.0.0.0")).toBe(false);
  expect(isLoopbackAddress("::")).toBe(false);
  expect(isLoopbackAddress("localhost")).toBe(false);
});

test("論理名と操作名はudpとdatagramである", () => {
  // 割当て特定と転送形状の固定値を確かめる。
  expect(UDP_SESSION_ID).toBe("udp");
  expect(UDP_DATAGRAM_OP).toBe("datagram");
});

test("契約ソースはサーバー依存をimportしない", () => {
  // ブラウザ安全の条件をソース検査で確かめる。
  // 契約は型と純粋関数のみで構成し、`bridge-server` 等を引き込まない。
  const ソース = readFileSync(new URL("../src/contract.ts", import.meta.url), "utf8");
  expect(ソース).not.toMatch(/bridge-server/);
  expect(ソース).not.toMatch(/bridge-protocol/);
  expect(ソース).not.toMatch(/node:dgram/);
  expect(ソース).not.toMatch(/^\s*import\s/m);
});

test("契約subpathが公開され成果物がサーバー依存を持たない", () => {
  // `exports` の subpath 宣言と、ビルド成果物の中身を確かめる。
  // 成果物の検査は root import で `bridge-server` を引き込まない根拠になる。
  const 台帳 = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    readonly exports?: Record<string, string>;
  };
  // ADR: `as` は JSON 境界の読替えであり、後続の存在検査で不正を検出する。
  // `JSON.parse` の `any` をそのまま広げないための主張である。
  const 成果物相対径 = 台帳.exports?.["./contract"];
  expect(typeof 成果物相対径).toBe("string");
  if (typeof 成果物相対径 !== "string") throw new Error("契約 subpath の公開がない。");
  const 成果物 = new URL(`../${成果物相対径}`, import.meta.url);
  expect(existsSync(成果物)).toBe(true);
  const 中身 = readFileSync(成果物, "utf8");
  expect(中身).not.toMatch(/bridge-server/);
  expect(中身).not.toMatch(/bridge-protocol/);
  expect(中身).not.toMatch(/node:dgram/);
});
