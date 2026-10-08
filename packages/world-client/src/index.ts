/**
 * ワールド内からブリッジへ接続するためのクライアント。
 *
 * @packageDocumentation
 */
import { PROTOCOL_VERSION } from "bridge-protocol";

/** クライアント生成時の設定。 */
export interface WorldClientOptions {
  /** ブリッジの基底URL (例: `http://localhost:3100`)。 */
  readonly baseUrl: string;
}

/** ブリッジへ接続するためのクライアント。 */
export interface WorldClient {
  /** 接続先の基底URL。末尾の `/` は除去される。 */
  readonly baseUrl: string;
  /** 対応するプロトコルのバージョン。 */
  readonly protocolVersion: string;
}

/**
 * クライアントを生成する。
 *
 * @param options - 接続先の設定。
 * @returns 生成したクライアント。
 * @throws `RangeError` — `baseUrl` が空文字または `/` のみの場合。
 */
export function createWorldClient(options: WorldClientOptions): WorldClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  if (baseUrl === "") {
    throw new RangeError("baseUrl は空にできない。");
  }
  return { baseUrl, protocolVersion: PROTOCOL_VERSION };
}
