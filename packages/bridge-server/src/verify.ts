/**
 * WebSocket 昇格前の接続前検証。
 *
 * 接続元 IP が loopback、Host・port・path が設定 endpoint と一致、Origin が
 * 完全一致で許可されていることを昇格前に確認する。CORS には依存しない。
 * 欠落 `Origin`・`null`・ワイルドカード・接尾辞一致はすべて拒否する。
 *
 * @packageDocumentation
 */

/** 正規の接続パス。 */
export const BRIDGE_PATH = "/v1";

/** 待ち受けホスト。明示 bind のみで `0.0.0.0`/`::` は使わない。 */
export const LOOPBACK_HOST = "127.0.0.1";

/** 本番の許可 `Origin`。 */
export const PRODUCTION_ORIGIN = "https://app.xrift.net";

/** 接続前検証の入力。 */
export interface UpgradeInput {
  /** 接続元 IP（`req.socket.remoteAddress`）。 */
  readonly remoteAddress: string | undefined;
  /** `Host` ヘッダ。 */
  readonly host: string | undefined;
  /** 要求パス（`req.url`）。 */
  readonly url: string | undefined;
  /** `Origin` ヘッダ。 */
  readonly origin: string | string[] | undefined;
}

/** 検証結果。 */
export type UpgradeVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * 接続元 IP が loopback か判定する。
 *
 * @param remoteAddress - ソケットの接続元表示。
 * @returns `127.0.0.0/8`・`::1`・`::ffff:127.0.0.0/8` の場合に真。
 */
export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  if (remoteAddress === undefined) return false;
  if (remoteAddress === "::1") return true;
  const ipv4 = remoteAddress.startsWith("::ffff:")
    ? remoteAddress.slice("::ffff:".length)
    : remoteAddress;
  const parts = ipv4.split(".");
  if (parts.length !== 4) return false;
  if (parts[0] !== "127") return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * `Origin` 候補が許可集合の要素と完全一致するか判定する。
 *
 * @param origin - 要求の `Origin` ヘッダ値。
 * @param allowed - 許可 `Origin` の集合。パターンは扱わない。
 */
export function isAllowedOrigin(
  origin: string | string[] | undefined,
  allowed: ReadonlySet<string>,
): boolean {
  if (typeof origin !== "string") return false;
  if (origin === "" || origin === "null") return false;
  return allowed.has(origin);
}

/**
 * 昇格前の検証を行う。
 *
 * @param input - 要求の接続情報。
 * @param expectedAuthority - 設定 endpoint の authority（例: `127.0.0.1:3100`）。
 * @param allowedOrigins - 許可 `Origin` の集合。
 * @returns 検証結果。拒否時は理由を含む。
 */
export function verifyUpgrade(
  input: UpgradeInput,
  expectedAuthority: string,
  allowedOrigins: ReadonlySet<string>,
): UpgradeVerdict {
  if (!isLoopbackAddress(input.remoteAddress)) {
    return { ok: false, reason: "non_loopback_remote" };
  }
  if (input.host !== expectedAuthority) {
    return { ok: false, reason: "host_mismatch" };
  }
  if (input.url !== BRIDGE_PATH) {
    return { ok: false, reason: "path_mismatch" };
  }
  if (!isAllowedOrigin(input.origin, allowedOrigins)) {
    return { ok: false, reason: "origin_rejected" };
  }
  return { ok: true };
}

/**
 * 許可 `Origin` の書式を検証する。
 *
 * @param origin - 設定候補。
 * @returns 正規化した `Origin`。
 * @throws `RangeError` — scheme・ホスト・パス等の書式が `Origin` として不正な場合。
 */
export function parseAllowedOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new RangeError("許可 Origin は URL 形式であること。");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new RangeError("許可 Origin の scheme は http/https のみ扱う。");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username !== "") {
    throw new RangeError("許可 Origin は scheme・host・port のみで指定する。");
  }
  if (url.hostname.includes("*")) {
    throw new RangeError("許可 Origin にワイルドカードは使えない。");
  }
  return url.origin;
}
