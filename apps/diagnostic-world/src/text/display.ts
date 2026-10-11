/**
 * テキスト表示板の表示文言。React・R3F・DOM に依存しない。
 *
 * 開発 DOM パネルとは共用せず、in-world 表示板だけが使う。本文は表示専用であり、
 * 証拠 JSON・ログ・永続保存・同期状態に混ぜないこと。HTML・Markdown・コマンド
 * 解釈はせず、プレーンテキストのまま行に載せる。
 *
 * 折返し・省略表示の方針（明示）：
 * - 本文を改行（`\n`）で分割する（`\r\n` は `\n` にそろえる）。
 * - 各行をコードポイント単位で `TEXT_DISPLAY_WRAP_COLUMNS`（24）字ごとに折り返す。
 * - 先頭から `TEXT_DISPLAY_MAX_ROWS`（8）行まで表示し、超過分は最終行の末尾を
 *   省略記号（`…`）に置き換えて省略する。
 * - 3D 側の描画ではさらに測幅で切り詰める（`TextBoard` の `fitLine` 相当）が、
 *   論理行の上限はここで保証する。
 *
 * @packageDocumentation
 */
import type { TextSnapshot } from "./receiver.ts";

/** 折り返し幅（コードポイント数）。3D 板の幅に収めるための目安である。 */
export const TEXT_DISPLAY_WRAP_COLUMNS = 24;

/** 表示する論理行の上限。超過分は省略記号で省略する。 */
export const TEXT_DISPLAY_MAX_ROWS = 8;

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
 * @returns 折り返し後の行。上限を超える分は含まない。
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
 * テキスト表示板の表示行にそろえる。呼び出し側は戻り値を証拠・ログ・永続保存に
 * 混ぜないこと。本文は解釈せずそのまま載せる。
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
