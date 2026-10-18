/**
 * テキスト表示板の表示文言。React・R3F・DOM に依存しない。
 *
 * 折返し・省略表示の方針（明示）：
 * - 本文を改行（`\n`）で分割する（`\r\n` は `\n` にそろえる）。
 * - 各行をコードポイント単位で `TEXT_DISPLAY_WRAP_COLUMNS`（24）字ごとに折り返す。
 * - 先頭から `TEXT_DISPLAY_MAX_ROWS`（8）行まで表示し、超過分は最終行の末尾を
 *   省略記号（`…`）に置き換えて省略する。
 * - 3D 側の描画ではさらに測幅で切り詰める（`CanvasPlate` の `fitLine`）が、
 *   論理行の上限はここで保証する。
 *
 * 本文はプレーンテキストのまま載せ、HTML・Markdown・コマンド解釈はしない。
 *
 * @packageDocumentation
 */
import type { TextSnapshot } from "../../text/types.ts";

/** 折り返し幅（コードポイント数）。3D 板の幅に収めるための目安である。 */
export const TEXT_DISPLAY_WRAP_COLUMNS = 24;

/** 表示する論理行の上限。超過分は省略記号で省略する。 */
export const TEXT_DISPLAY_MAX_ROWS = 8;

/** 中断・未受信を示す文字色。 */
const WARNING_COLOR = "#ffb3b3";

/**
 * 受信状態の表示文言を返す。
 *
 * @param status - テキスト受信の状態。`null` は受信手順の生成前である。
 * @returns 日本語の短い表示。
 */
export function textStatusLabel(status: TextSnapshot["status"] | null): string {
  if (status === "received") return "受信済み";
  if (status === "ended") return "中断";
  if (status === "waiting") return "待機中";
  return "未受信";
}

/**
 * 本文を折り返し方針で論理行に割る。
 *
 * @param text - 表示する本文（プレーンテキスト）。
 * @returns 折り返し後の行。上限による省略は行わない。
 */
export function wrapTextBody(text: string): readonly string[] {
  const rows: string[] = [];
  const normalized = text.split("\r\n").join("\n");
  for (const line of normalized.split("\n")) {
    const points = Array.from(line);
    if (points.length === 0) {
      rows.push("");
      continue;
    }
    for (let start = 0; start < points.length; start += TEXT_DISPLAY_WRAP_COLUMNS) {
      rows.push(points.slice(start, start + TEXT_DISPLAY_WRAP_COLUMNS).join(""));
    }
  }
  return rows;
}

/**
 * 表示板の表示行にそろえる。
 *
 * @param snapshot - テキスト表示用の写し。`null` は受信手順の生成前である。
 * @returns 表示する行の一覧。
 */
export function formatTextLines(snapshot: TextSnapshot | null): readonly string[] {
  if (snapshot === null) return ["テキスト 未受信"];
  if (snapshot.status === "waiting") return ["テキスト 待機中（受信なし）"];
  const head =
    snapshot.status === "ended" ? "テキスト 中断（直近表示を残す）" : "テキスト 受信済み";
  if (snapshot.text === null) return [head];
  const rows = wrapTextBody(snapshot.text);
  const shown = rows.slice(0, TEXT_DISPLAY_MAX_ROWS);
  // ADR: 超過分は最終行の末尾省略で表す。行を落とさず、省略の存在が分かる形にする。
  if (rows.length > TEXT_DISPLAY_MAX_ROWS) {
    const last = shown[shown.length - 1] ?? "";
    shown[shown.length - 1] = `${last}…`;
  }
  return [head, ...shown];
}

/**
 * 行の文字色を返す。中断・未受信の行だけを目立たせる。
 *
 * @param line - 表示する1行。
 * @returns CSS の色。
 */
export function textLineColor(line: string): string {
  return line.startsWith("テキスト 中断") || line.startsWith("テキスト 未受信")
    ? WARNING_COLOR
    : "#e8ecf1";
}
