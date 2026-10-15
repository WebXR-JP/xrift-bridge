/**
 * UDPデータグラム転送の契約（ワールドと本体の双方が参照する）。
 *
 * ブラウザ安全のため、サーバー側の実装依存を import しない。
 * 型と純粋関数のみで構成する（`import` 文を持たない）。
 *
 * データ形状：
 * - PC→ワールドは受信データグラム一件の転送（`{ op: "datagram", dataBase64,
 *   source: { address, port } }`）。逆方向の送信はしない。
 * - 本文ではなく base64 で運び、復号後の上限（48,000 バイト）を超える
 *   受信は転送せず破棄する（セッションは切断しない）。
 *
 * base64 の符号化・復号は `btoa`・`atob` グローバルを使う。どちらも
 * ブラウザ・Node・Bun に存在する。
 *
 * @packageDocumentation
 */

/** PC→ワールドのデータグラム転送の操作名。 */
export const UDP_DATAGRAM_OP = "datagram" as const;

/**
 * ワールドが生成する UDP 専用セッションの論理名。
 *
 * 割当て候補の特定に使う。論理名の一致は内容の互換性や真正性の証明ではない。
 */
export const UDP_SESSION_ID = "udp" as const;

/**
 * 転送するデータグラムの復号後上限（バイト）。
 *
 * 輸送 JSON フレーム上限は 65,536 バイトであり、base64 膨張（4/3 倍＋
 * JSON 外殻）を見込んで復号後 48,000 バイトに抑える。
 * 超過した受信は破棄して数え、セッションは切断しない。
 */
export const UDP_MAX_DATAGRAM_BYTES = 48_000;

/**
 * 送信元アドレス文字列の上限（文字数）。
 *
 * IPv6 テキスト表記の最大（45 文字程度）に余裕を持たせた上限であり、
 * 異常に長い送信元表記を受信検証で拒否するためのものである。
 */
export const UDP_SOURCE_ADDRESS_MAX_LENGTH = 256;

/**
 * データグラムの送信元。
 *
 * 受信ソケットが報告した送信者であり、検証済みとは限らない。
 */
export interface UdpSource {
  /** 送信者のアドレス表記。非空・上限以内である。 */
  readonly address: string;
  /** 送信者のポート番号。0..65535 の整数である。 */
  readonly port: number;
}

/**
 * PC→ワールドのデータグラム転送。
 *
 * 受信一件ごとに作り、受信バイト列を base64 で運ぶ。本文の表示はしない。
 */
export interface UdpDatagramMessage {
  /** 操作名。データグラム転送のみである。 */
  readonly op: typeof UDP_DATAGRAM_OP;
  /** 受信バイト列の base64。復号後は上限以内である。 */
  readonly dataBase64: string;
  /** 受信ソケットが報告した送信者。 */
  readonly source: UdpSource;
}

/**
 * 受信バイト列を base64 に符号化する。
 *
 * @param data - 符号化するバイト列。変更しない。
 * @returns 正規 base64（`btoa` の出力）。
 */
export function encodeUdpData(data: Uint8Array): string {
  // ADR: `String.fromCharCode` の spread は引数上限で落ちるため、
  // 32KiB ずつに区切って連結する。データグラム上限（48,000 バイト）でも安全である。
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < data.length; i += CHUNK) {
    binary += String.fromCharCode(...data.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * base64 をバイト列に復号する。
 *
 * @param base64 - 復号する base64。
 * @returns 復号したバイト列（新しい領域）。
 * @throws `InvalidCharacterError` — base64 ではない場合。
 */
export function decodeUdpData(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * 正規 base64 の字形か判定する（復号はしない）。
 *
 * 4 文字単位・末尾 padding（0〜2 個）だけを受け付け、空文字列（空データグラム）
 * を許す。字形が正しくても復号後上限を超える場合は受信検証で拒否する。
 *
 * @param value - 判定する値。
 * @returns 正規 base64 の字形であれば真。
 */
export function isBase64Text(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

/**
 * プレーンオブジェクトか判定する。
 *
 * @param value - 判定する値。
 * @returns 配列でないオブジェクトであれば真。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * データグラムの送信元か判定する。
 *
 * アドレスの数値リテラル適合までは見ない（受信ソケットの報告形式の検査であり、
 * bind 設定の検証は本体が行う）。空・長過ぎる表記・範囲外ポートを拒否する。
 *
 * @param value - 判定する値。
 * @returns 送信元の形状であれば真。
 */
export function isUdpSource(value: unknown): value is UdpSource {
  if (!isRecord(value)) return false;
  // ADR: 余分なキーを黙って受理しない。未知の拡張は破壊的変更として扱う。
  if (Object.keys(value).length !== 2) return false;
  const address = value["address"];
  if (typeof address !== "string" || address.length === 0) return false;
  if (address.length > UDP_SOURCE_ADDRESS_MAX_LENGTH) return false;
  const port = value["port"];
  if (typeof port !== "number" || !Number.isInteger(port)) return false;
  return port >= 0 && port <= 65535;
}

/**
 * 受信したデータグラム転送を検証する。
 *
 * 余分なキー・未知の操作名・不正 base64・上限超過・不正な送信元を拒否する。
 *
 * @param payload - 受信した JSON 値。
 * @returns データグラム転送の形状であれば真。
 */
export function isUdpDatagramMessage(payload: unknown): payload is UdpDatagramMessage {
  if (!isRecord(payload)) return false;
  // ADR: 余分なキーを黙って受理しない。未知の拡張は破壊的変更として扱う。
  if (Object.keys(payload).length !== 3) return false;
  if (payload["op"] !== UDP_DATAGRAM_OP) return false;
  const encoded = payload["dataBase64"];
  if (!isBase64Text(encoded)) return false;
  let decoded: Uint8Array;
  try {
    decoded = decodeUdpData(encoded);
  } catch {
    return false;
  }
  // ADR: 正規形の再符号化一致までは要求しない。受信検証の目的は輸送上限の
  // 強制と形状保証であり、符号化の正規形統一は送信側の責務である。
  if (decoded.length > UDP_MAX_DATAGRAM_BYTES) return false;
  return isUdpSource(payload["source"]);
}

/**
 * 数値の IPv4 リテラルか判定する。
 *
 * 4 つの 10 進オクテット（0..255）のみを受け付け、ホスト名・空・
 * 省略（暗黙の全 interface）を拒否する。先行ゼロを持つオクテットは拒否する
 * （数値リテラルとして厳密に扱う）。bind 設定と子画面の事前表示で使う。
 *
 * @param value - 判定する値。
 * @returns 数値の IPv4 リテラルであれば真。
 */
export function isIPv4LiteralAddress(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return false;
    if (Number(part) > 255) return false;
  }
  return true;
}

/**
 * IPv6 アドレスの 16 進群か判定する（埋め込み IPv4 末尾を除く）。
 *
 * @param group - 判定する群。
 * @returns 1〜4 桁の 16 進であれば真。
 */
function isHexGroup(group: string): boolean {
  return /^[0-9a-fA-F]{1,4}$/.test(group);
}

/**
 * `::` の片側の群列を検証する。
 *
 * @param side - `::` で区切った片側。空は群なしを表す。
 * @returns 群列。末尾の埋め込み IPv4 が不正なら `null`。
 */
function parseIPv6Side(side: string): readonly string[] | null {
  if (side === "") return [];
  const groups = side.split(":");
  for (const group of groups) {
    if (group.includes(".")) {
      // 埋め込み IPv4 は末尾の一群だけに許す。
      if (group !== groups[groups.length - 1] || !isIPv4LiteralAddress(group)) return null;
    } else if (!isHexGroup(group)) {
      return null;
    }
  }
  return groups;
}

/**
 * 群列の 128bit 換算の群数を数える（埋め込み IPv4 は 2 群）。
 *
 * @param groups - 群列。
 * @returns 換算群数。
 */
function countIPv6Groups(groups: readonly string[]): number {
  let count = 0;
  for (const group of groups) {
    count += group.includes(".") ? 2 : 1;
  }
  return count;
}

/**
 * 数値の IPv6 リテラルか判定する。
 *
 * 16 進群と `::` 省略（末尾の埋め込み IPv4 を含む）のみを受け付け、
 * ホスト名・空・zone id（`%` 付き）を拒否する。bind 設定と子画面の
 * 事前表示で使う。
 *
 * @param value - 判定する値。
 * @returns 数値の IPv6 リテラルであれば真。
 */
export function isIPv6LiteralAddress(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (!value.includes(":")) return false;
  if (!/^[0-9a-fA-F:.]+$/.test(value)) return false;
  const halves = value.split("::");
  if (halves.length > 2) return false;
  const left = parseIPv6Side(halves[0] ?? "");
  const right = halves.length === 2 ? parseIPv6Side(halves[1] ?? "") : [];
  if (left === null || right === null) return false;
  const total = countIPv6Groups(left) + countIPv6Groups(right);
  // `::` ありは省略があるため 7 群以下、`::` なしはちょうど 8 群である。
  return halves.length === 2 ? total <= 7 : total === 8;
}

/**
 * loopback の数値リテラルか判定する。
 *
 * IPv4 は `127.0.0.0/8`、IPv6 は `::1` とその完全形のみを loopback とする。
 * 射影形（`::ffff:127.0.0.1` 等）は非 loopback として扱い、確認を要求する
 * （安全側への倒し方である）。
 *
 * @param address - 判定するアドレス表記。
 * @returns loopback の数値リテラルであれば真。
 */
export function isLoopbackAddress(address: string): boolean {
  if (isIPv4LiteralAddress(address)) {
    return address.split(".")[0] === "127";
  }
  if (!isIPv6LiteralAddress(address)) return false;
  const folded = address.toLowerCase();
  return folded === "::1" || folded === "0:0:0:0:0:0:0:1";
}
