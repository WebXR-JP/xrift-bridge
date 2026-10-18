/**
 * 接続盤の表示文言と色。React・R3F・DOM に依存しない。
 *
 * 比較コードは表示のみに使い、保存・送信・同期の対象にしない。
 *
 * @packageDocumentation
 */
import type { BridgePhase, BridgeSnapshot } from "../../connection/types.ts";

/** 失敗・注意を示す文字色。 */
const WARNING_COLOR = "#ffb3b3";

/**
 * 進行の表示文言を返す。
 *
 * @param phase - 接続の進行。
 * @returns 日本語の短い表示。
 */
export function phaseLabel(phase: BridgePhase): string {
  if (phase === "connecting") return "接続中";
  if (phase === "awaiting_approval") return "承認待ち";
  if (phase === "authorized") return "認証済み";
  if (phase === "ended") return "終了";
  return "未接続";
}

/**
 * 接続盤の表示行にそろえる。
 *
 * @param snapshot - 接続状態の写し。`null` は接続手順の生成前である。
 * @param portError - ポート入力の不備。無ければ `null`。
 * @returns 表示する行の一覧。
 */
export function formatConnectionLines(
  snapshot: BridgeSnapshot | null,
  portError: string | null,
): readonly string[] {
  if (snapshot === null) return ["ブリッジ 準備中…"];
  const lines: string[] = [`接続先 ${snapshot.endpoint}`, `状態 ${phaseLabel(snapshot.phase)}`];
  if (snapshot.pairing !== null) lines.push(`比較コード ${snapshot.pairing.code}`);
  if (snapshot.error !== null) lines.push(`失敗 ${snapshot.error.code}: ${snapshot.error.message}`);
  if (portError !== null) lines.push(`ポート入力 ${portError}`);
  return lines;
}

/**
 * 行の文字色を返す。失敗・入力不備の行だけを目立たせる。
 *
 * @param line - 表示する1行。
 * @returns CSS の色。
 */
export function connectionLineColor(line: string): string {
  return line.startsWith("失敗") || line.startsWith("ポート入力") ? WARNING_COLOR : "#e8ecf1";
}

/**
 * 進行に対応する表示灯の色を返す。文字を読まなくても大枠が分かるための補助である。
 *
 * @param phase - 接続の進行。`null` は接続手順の生成前である。
 * @returns CSS の色。
 */
export function phaseColor(phase: BridgePhase | null): string {
  if (phase === "authorized") return "#69db7c";
  if (phase === "connecting" || phase === "awaiting_approval") return "#ffd43b";
  if (phase === "ended") return "#ff6b6b";
  return "#9aa0a6";
}
