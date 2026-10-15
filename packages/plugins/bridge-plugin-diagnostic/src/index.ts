/**
 * 同梱の診断プラグイン（応答確認相当の echo・ping）。
 *
 * `bridge-server` の診断ハンドラ相当の payload 検証・応答（echo・ping）・
 * 不正形状での Session 中断を担う。プラグイン基盤本体は診断の解釈を持たず、
 * 内容の検証・応答相関はこのプラグインの責務である。
 *
 * 診断 payload の形状：
 * - echo: `{ "op": "echo", "id": <文字列>, "value": <JSON 値> }`
 *   → `{ "op": "echo", "id": <同じ>, "value": <同じ値> }`
 * - ping: `{ "op": "ping", "id": <文字列> }` → `{ "op": "pong", "id": <同じ> }`
 *
 * 不正形状は当該 Session のみ中断（RST）し、他 Session と Connection は維持する。
 * 応答相関は診断 payload 内の明示 `id` で行う（到着順 FIFO にはしない。
 * タイムアウト後の遅延応答が次の要求へ誤対応するのを防ぐため）。
 *
 * @packageDocumentation
 */
import { isJsonValue } from "bridge-protocol";
import type { AssignedSession, PluginDefinition, PluginInstance } from "bridge-app-core/core";

/** 診断プラグインの接続口識別子。 */
export const DIAGNOSTIC_PORT_ID = "diagnostic";

/** 診断プラグインの識別子。 */
export const DIAGNOSTIC_PLUGIN_ID = "diagnostic";

/**
 * 診断の応答統計。
 *
 * 応答を送信試行した件数を数える（送出成否の確定ではない）。
 */
export interface DiagnosticStats {
  /** echo 応答の送信試行件数。 */
  readonly diagnosticEcho: number;
  /** ping 応答の送信試行件数。 */
  readonly diagnosticPing: number;
}

/**
 * 診断 payload を検証し、応答 payload を作る。
 *
 * @param payload - 受信した JSON 値。
 * @returns 応答 payload。想定外なら失敗。
 */
function toDiagnosticResponse(payload: unknown):
  | {
      readonly ok: true;
      readonly response:
        | { readonly op: "pong"; readonly id: string }
        | { readonly op: "echo"; readonly id: string; readonly value: unknown };
    }
  | { readonly ok: false; readonly response: null } {
  if (!isRecord(payload)) return { ok: false, response: null };
  const keys = Object.keys(payload);
  const op: unknown = payload["op"];
  if (op === "ping") {
    // ping は `op` と `id` のみ許し、余分なキーを黙って受理しない。
    if (keys.length !== 2) return { ok: false, response: null };
    const id: unknown = payload["id"];
    if (typeof id !== "string" || id.length === 0) return { ok: false, response: null };
    return { ok: true, response: { op: "pong", id } };
  }
  if (op === "echo") {
    if (keys.length !== 3) return { ok: false, response: null };
    if (!("id" in payload) || !("value" in payload)) return { ok: false, response: null };
    const id: unknown = payload["id"];
    if (typeof id !== "string" || id.length === 0) return { ok: false, response: null };
    const value: unknown = payload["value"];
    if (!isJsonValue(value)) return { ok: false, response: null };
    return { ok: true, response: { op: "echo", id, value } };
  }
  return { ok: false, response: null };
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

/** 診断インスタンス（単一の reliable 接続口を受ける）。 */
class DiagnosticInstance implements PluginInstance<DiagnosticStats> {
  private echoCount = 0;
  private pingCount = 0;
  private detach: (() => void) | null = null;
  private disposed = false;

  /** {@inheritDoc PluginInstance.attach} */
  attach(portId: string, session: AssignedSession): void {
    if (this.disposed) throw new RangeError("破棄済みのインスタンスである。");
    if (portId !== DIAGNOSTIC_PORT_ID) throw new RangeError(`不明な接続口である: ${portId}`);
    if (session.kind !== "reliable" || session.direction !== "bidirectional") {
      throw new RangeError("診断の接続口に合わない操作口である。");
    }
    this.detach?.();
    this.detach = session.onMessage((payload) => {
      this.handlePayload(session, payload);
    });
  }

  /** {@inheritDoc PluginInstance.getState} */
  getState(): DiagnosticStats {
    return { diagnosticEcho: this.echoCount, diagnosticPing: this.pingCount };
  }

  /** {@inheritDoc PluginInstance.dispose} */
  dispose(): void {
    this.disposed = true;
    this.detach?.();
    this.detach = null;
  }

  /**
   * 受信 payload を検証し、応答または中断を行う。
   *
   * @param session - 応答に使う操作口。
   * @param payload - 受信した JSON 値。
   */
  private handlePayload(
    session: Extract<AssignedSession, { kind: "reliable" }>,
    payload: unknown,
  ): void {
    const result = toDiagnosticResponse(payload);
    if (!result.ok) {
      // ADR: 不正形状は当該 Session のみ中断し、Connection・他 Session は維持する。
      try {
        session.abort(new Error("診断 payload の形状が不正である。"));
      } catch {
        // 中断の失敗は無視する。
      }
      return;
    }
    const response = result.response;
    if (response.op === "pong") {
      this.pingCount += 1;
    } else {
      this.echoCount += 1;
    }
    // ADR: 応答の送出失敗は Session 終端として扱い、ここで待機を作らない。
    // 計数は送信試行の時点で確定する（従来の意味）。
    void session.sendReliable(response).catch(() => {
      // 送出失敗は Session が既に終端している場合が多く、何もしない。
    });
  }
}

/**
 * 同梱の診断プラグイン定義。
 *
 * 単一の接続口（reliable 双方向）を持ち、インスタンスごとに独立した
 * 応答統計を持つ。
 */
export const diagnosticPlugin: PluginDefinition<DiagnosticStats> = {
  pluginId: DIAGNOSTIC_PLUGIN_ID,
  ports: [
    {
      portId: DIAGNOSTIC_PORT_ID,
      accepts: [{ kind: "reliable", direction: "bidirectional" }],
    },
  ],
  create(): PluginInstance<DiagnosticStats> {
    return new DiagnosticInstance();
  },
};
