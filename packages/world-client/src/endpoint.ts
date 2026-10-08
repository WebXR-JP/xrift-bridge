/**
 * ブリッジ接続先 endpoint の検証。
 *
 * 初期スコープでは `ws://127.0.0.1:<port>/v1` のみ受け付ける。非 loopback、
 * 名前解決への依存（`localhost` 等）、`wss`、任意パスは拒否する。
 *
 * @packageDocumentation
 */

/** 正規の接続パス。 */
export const BRIDGE_PATH = "/v1";

/** 正規の接続ホスト（数値 IP のみ）。 */
export const BRIDGE_HOST = "127.0.0.1";

/**
 * endpoint が正規の loopback 接続先か検証し、正規化して返す。
 *
 * @param endpoint - 接続先候補（例: `ws://127.0.0.1:3100/v1`）。
 * @returns 正規化した endpoint（入力が既に正規形のため同値）。
 * @throws `RangeError` — 書式・ scheme・ホスト・ポート・パス・ query・fragment のいずれかが正規形でない場合。
 */
export function parseBridgeEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new RangeError("endpoint は URL 形式であること。");
  }
  if (url.protocol !== "ws:") {
    throw new RangeError("endpoint の scheme は `ws` のみ受け付ける。");
  }
  if (url.hostname !== BRIDGE_HOST) {
    throw new RangeError("endpoint のホストは `127.0.0.1` のみ受け付ける（loopback 限定）。");
  }
  if (url.port === "") {
    throw new RangeError("endpoint のポートは明示すること。");
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError("endpoint のポートが範囲外である。");
  }
  if (url.pathname !== BRIDGE_PATH) {
    throw new RangeError("endpoint のパスは `/v1` のみ受け付ける。");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new RangeError("endpoint に query・fragment は付けない。");
  }
  if (url.username !== "" || url.password !== "") {
    throw new RangeError("endpoint に資格情報を含めない。");
  }
  return `ws://${BRIDGE_HOST}:${port}${BRIDGE_PATH}`;
}
