/**
 * CLI ペアリングの秘密値の発行と消費。
 *
 * 128 ビット以上の暗号学的乱数を 120 秒有効・一度だけ・許可 Origin 紐付けで
 * 払い出す。秘密値は URL・query・Cookie・ログ・ブラウザ永続ストレージに出さ
 * ない運用とし、この記録器自体は秘密値を保持するが外へ出さない。
 *
 * @packageDocumentation
 */
import { randomBytes } from "node:crypto";
import { PAIRING_SECRET_BYTES, PAIRING_TTL_MS } from "./config.ts";

/** 発行したペアリングの公開内容。秘密値は呼び出し側が利用者へ手渡す。 */
export interface IssuedPairing {
  /** 利用者がワールド画面へ入力する秘密値。 */
  readonly secret: string;
  /** 紐付けた許可 `Origin`。 */
  readonly origin: string;
  /** 失効時刻（UNIX ミリ秒）。 */
  readonly expiresAt: number;
}

/** 消費結果。失敗理由を区別して監査できる。 */
export type ConsumeResult =
  | { readonly status: "ok" }
  | { readonly status: "unknown" }
  | { readonly status: "expired" }
  | { readonly status: "reused" }
  | { readonly status: "origin_mismatch" };

interface PairingEntry {
  readonly origin: string;
  readonly expiresAt: number;
  used: boolean;
}

/**
 * ペアリング秘密値の記録器。
 */
export class PairingStore {
  private readonly entries = new Map<string, PairingEntry>();
  private readonly now: () => number;

  /**
   * @param now - 現在時刻（ミリ秒）。試験で差し替えできる。
   */
  constructor(now?: () => number) {
    this.now = now ?? Date.now;
  }

  /**
   * 秘密値を発行する。
   *
   * @param origin - 紐付ける許可 `Origin`。完全一致で判定済みであること。
   * @returns 発行内容。秘密値は呼び出し側が利用者へ直接手渡す。
   */
  issue(origin: string): IssuedPairing {
    // ADR: 衝突時は作り直す。128 ビット乱数の衝突確率は無視できるが、記録器内の
    // 一意性は Map への格納条件として明示的に保証する。
    let secret = randomBytes(PAIRING_SECRET_BYTES).toString("hex");
    while (this.entries.has(secret)) {
      secret = randomBytes(PAIRING_SECRET_BYTES).toString("hex");
    }
    const expiresAt = this.now() + PAIRING_TTL_MS;
    this.sweep();
    this.entries.set(secret, { origin, expiresAt, used: false });
    return { secret, origin, expiresAt };
  }

  /**
   * 秘密値を消費する。成功時は一度だけで失効する。
   *
   * @param secret - 提示された秘密値。
   * @param origin - 接続の `Origin`。発行時の紐付けと完全一致が必要。
   * @returns 消費結果。
   */
  consume(secret: string, origin: string): ConsumeResult {
    const entry = this.entries.get(secret);
    if (entry === undefined) return { status: "unknown" };
    if (this.now() > entry.expiresAt) {
      this.entries.delete(secret);
      return { status: "expired" };
    }
    // 使用済みは失効まで記録を残し、再利用と未知値を区別する。
    if (entry.used) return { status: "reused" };
    if (entry.origin !== origin) return { status: "origin_mismatch" };
    entry.used = true;
    return { status: "ok" };
  }

  /** 有効な未使用ペアリングの件数。 */
  size(): number {
    this.sweep();
    return this.entries.size;
  }

  private sweep(): void {
    const now = this.now();
    for (const [secret, entry] of this.entries) {
      if (now > entry.expiresAt) {
        this.entries.delete(secret);
      }
    }
  }
}
