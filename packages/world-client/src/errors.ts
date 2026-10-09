/**
 * クライアント操作の失敗。
 *
 * 接続・ペアリング・認可後セッションの各層で使うため、循環参照を避けて
 * ここに置く。公開は `client.ts` からの再公開経由で行い、型・同一性は保つ。
 */

/** クライアント操作の失敗。 */
export class WorldClientError extends Error {
  /** 機械可読の符号。 */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorldClientError";
    this.code = code;
  }
}
