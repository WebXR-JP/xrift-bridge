/**
 * 製品向けローカル業務操作の委譲（main 側）。
 *
 * 業務操作の実行は `GuiBackend` の既存操作へ委譲し、業務 logic を共有側・
 * MCP 側へ複写しない。工具の入力検証と広告 schema はここの同じ zod schema
 * 定義から行う。承認（ペアリングの承認／拒否）は扱わない。人間の
 * GUI 操作でのみ成立するため、共有契約の定型応答に落とし、backend を
 * 呼ばない。接続口ごとの差（承認を実行するか、DOM 段階観測を使うか）は
 * 各接続口に残し、ここでは接続口の種類で分岐しない。
 *
 * ADR: 広告と検証の正本はここの zod schema 定義であり、同じ定義から
 * 出すことでずれない構造にする。`registerTool` の `inputSchema` と実行子の
 * `safeParse` は同じ schema 对象を使う。引数の中身の最終的な検証は
 * backend 側が行う。
 *
 * ADR: 開発用接続口の `runDevOperation` と実行部分が重複するが、既存の
 * 開発用の挙動を変えないため共通化しない。意味が同一の部分だけを共有し、
 * 差がある部分（承認の実行・DOM 段階観測・再試行口）は各接続口に残す。
 * 重複より既存挙動の維持を優先する判断である。
 *
 * @packageDocumentation
 */
import { z } from "zod";
import {
  isLocalExecutableOp,
  isLocalHumanOnlyOp,
  localHumanApprovalNotice,
  summarizeLocalResult,
  type LocalExecutableOpName,
  type LocalHumanApprovalNotice,
  type LocalKnownOpName,
  type LocalToolResponseBody,
} from "bridge-gui-contract/local-ops";
import type { GuiBackend } from "./backend.ts";

/**
 * 工具ごとの入力 schema。広告と検証の正本であり、同じ定義から出す。
 *
 * 必須・任意・`null` の可否・空文字の拒否・整数と下限をここで一本化する。
 * 余分な項目は削って受け付ける（広告に無い項目を理由に拒否しない）。
 */
export const LOCAL_TOOL_SCHEMAS = {
  getSnapshot: z.object({}),
  enableAcceptance: z.object({}),
  disableAcceptance: z.object({}),
  getPairingView: z.object({
    requestId: z.string().min(1).describe("Pairing request ID to check."),
  }),
  assignPlugin: z.object({
    pluginKind: z.string().min(1).describe("Plugin kind token to assign."),
    localSessionId: z
      .string()
      .min(1)
      .optional()
      .describe("Target live session ID. Omit for automatic selection."),
  }),
  unassignPlugin: z.object({
    instanceId: z.string().min(1).describe("Owned instance ID to release."),
    localSessionId: z.string().min(1).describe("Live session ID of the ownership."),
    portId: z.string().min(1).describe("Port ID of the ownership."),
  }),
  setPluginView: z.object({
    instanceId: z
      .string()
      .min(1)
      .nullable()
      .describe("Instance ID to show, or null to end the viewing period."),
    // ADR: `.int()` は安全整数範囲に絞るため使わない。backend の外形検査と
    // 同じ受理範囲（非負の整数。安全整数範囲に限定しない）にするため、
    // `min(0)` と `multipleOf(1)` の組み合わせにする。広告 schema も同じ定義
    // から出すため、広告（`minimum: 0`・`multipleOf: 1`）と受理が一致する。
    baseViewGeneration: z
      .number()
      .min(0)
      .multipleOf(1)
      .describe("Observed adopted generation to match. Stale requests are not adopted."),
  }),
  approvePairing: z.object({}),
  rejectPairing: z.object({}),
} as const;

/**
 * 工具ごとの説明文。広告専用の定義であり、工具の挙動は変えない。
 */
export const LOCAL_TOOL_DESCRIPTIONS: Record<LocalKnownOpName, string> = {
  getSnapshot:
    "Read a redacted local status summary (revision, identifiers, and plugin view only).",
  enableAcceptance: "Enable pairing acceptance. Returns the new state.",
  disableAcceptance: "Disable pairing acceptance. Returns the new state.",
  getPairingView:
    "Check whether a pairing request is still pending. Returns availability and the request ID only, never the comparison code.",
  assignPlugin:
    "Assign a plugin kind to a live session. Returns the confirmed binding identifiers.",
  unassignPlugin: "Release a plugin instance by its three identifiers. Returns the release result.",
  setPluginView:
    "Adopt a plugin child view for a new generation. Returns adoption and the current adopted target.",
  approvePairing:
    "Request pairing approval. Always requires a human GUI operation; this tool never approves automatically.",
  rejectPairing:
    "Request pairing rejection. Always requires a human GUI operation; this tool never rejects automatically.",
};

/**
 * 業務操作を実行する。既存操作への委譲であり、業務 logic を複写しない。
 *
 * 引数の形の検証は zod schema で行い、ここでは検証済みの既知項目だけを
 * backend の既存操作へ渡す。
 *
 * @param backend - 表示状態の提供元と限定操作の実行先。
 * @param op - 実行する許可操作名。
 * @param params - 検証済みの操作引数（中身の検証は各操作側が行う）。
 * @returns 業務結果（要約前の生の応答）。
 * @throws `RangeError` — 引数・状態の不備の場合（定型失敗に写す）。
 * @throws `Error` — 終了中・起動失敗の場合（定型失敗に写す）。
 */
export function runLocalOperation(
  backend: GuiBackend,
  op: LocalExecutableOpName,
  params: Record<string, unknown>,
): unknown {
  switch (op) {
    case "getSnapshot":
      return backend.getSnapshot();
    case "enableAcceptance":
      return backend.enableAcceptance();
    case "disableAcceptance":
      return backend.disableAcceptance();
    case "getPairingView":
      return backend.getPairingView({ requestId: params["requestId"] });
    case "assignPlugin":
      return backend.assignPlugin({
        pluginKind: params["pluginKind"],
        localSessionId: params["localSessionId"],
      });
    case "unassignPlugin":
      return backend.unassignPlugin({
        instanceId: params["instanceId"],
        localSessionId: params["localSessionId"],
        portId: params["portId"],
      });
    case "setPluginView":
      return backend.setPluginView({
        instanceId: params["instanceId"],
        baseViewGeneration: params["baseViewGeneration"],
      });
  }
}

/**
 * 工具1件の実行結果。応答文の生成は登録側が行い、ここでは要約か失敗だけを返す。
 *
 * 失敗時は理由を区別せず、呼び出し側で定型文に落とす（例外内容・秘密は載せない）。
 */
export type LocalToolOutcome =
  | {
      /** 成功の場合に真。 */
      readonly ok: true;
      /** 応答本文にする要約（正常応答は改訂番号付き、人間案内は定型）。 */
      readonly body: LocalToolResponseBody | LocalHumanApprovalNotice;
    }
  | {
      /** 失敗の場合に偽。 */
      readonly ok: false;
    };

/**
 * 工具1件を実行する。検証→受付可否の再検査→委譲→射影→改訂番号の組付けの順であり、
 * 拒否した要求では業務処理を呼ばない。
 *
 * 人間限定の操作（承認／拒否）は backend を呼ばず、人間の GUI 操作を要する
 * 定型応答を返す（改訂番号は付けない）。検証の失敗・業務の例外・受付の失効は
 * 失敗に落とす（内容は載せない）。
 *
 * 正常応答には業務結果と操作完了直後の改訂番号を組にする。委譲の実行と
 * 直後の状態取得は同期区間で分断せず行う。`getSnapshot` は要約と同じ
 * snapshot の改訂番号を使い、読み直さない。読取・変更なし・stale の正常応答
 * でも付ける。番号の増加は要求しない。
 *
 * ADR: 受付可否の再検査は、同期の業務委譲の直前に同じ待受け個体について行う。
 * 本文の読取り・transport への委譲をまたぐ間に停止・再有効化が割り込んでも、
 * 旧個体の遅延要求が後から実行されない（再有効化で旧個体は復活しない）。
 * 検査口は個体ごとの `isOpen` であり、別個体の状態を見ない。口を省略した
 * 場合は開いているものとして扱う（直接の単体検証用）。
 *
 * @param backend - 表示状態の提供元と限定操作の実行先。
 * @param op - 知っている操作名。
 * @param args - 工具に渡された引数。
 * @param isOpen - 同じ待受け個体が開いているかの判定。省略時は検査しない。
 * @returns 要約または失敗。
 */
export function executeLocalTool(
  backend: GuiBackend,
  op: LocalKnownOpName,
  args: unknown,
  isOpen?: () => boolean,
): LocalToolOutcome {
  if (isLocalHumanOnlyOp(op)) {
    // 承認は人間の GUI 操作でのみ成立する。backend を呼ばず定型応答に落とす。
    return { ok: true, body: localHumanApprovalNotice() };
  }
  if (!isLocalExecutableOp(op)) {
    return { ok: false };
  }
  const parsed = LOCAL_TOOL_SCHEMAS[op].safeParse(args === undefined ? {} : args);
  if (!parsed.success) {
    return { ok: false };
  }
  // 同じ待受け個体の受付可否を委譲の直前に再検査する。閉じた個体の遅延要求では
  // 業務を呼ばない（fail-closed）。検査口の例外は閉じているものとして扱う。
  try {
    if (isOpen !== undefined && !isOpen()) {
      return { ok: false };
    }
  } catch {
    return { ok: false };
  }
  try {
    const summary = summarizeLocalResult(op, runLocalOperation(backend, op, parsed.data));
    // `getSnapshot` は要約と同じ snapshot の改訂番号を使い（読み直さない）、
    // それ以外は操作完了直後に状態を取得する。いずれも同期区間で行う。
    const revision =
      summary.kind === "status" ? summary.status.revision : backend.getSnapshot().revision;
    return { ok: true, body: { ...summary, revision } };
  } catch {
    // 例外内容（本文の混入があり得る）は載せない。
    return { ok: false };
  }
}
