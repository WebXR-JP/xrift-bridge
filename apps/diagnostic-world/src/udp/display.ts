/**
 * UDP表示板の表示文言。React・R3F・DOM に依存しない。
 *
 * 開発 DOM パネルとは共用せず、in-world 表示板だけが使う。復号内容（送信元・
 * 長さ・先頭プレビュー）は表示専用であり、証拠 JSON・ログ・永続保存・同期状態に
 * 混ぜないこと。受信バイト列の解釈（本文表示・コマンド実行）はせず、長さと
 * 先頭のhexだけを載せる。長い行の切り詰めは3D側の測幅に任せ、ここでは行の
 * 上限と文言だけを保証する。
 *
 * @packageDocumentation
 */
import type { UdpSnapshot } from "./receiver.ts";

/**
 * 受信状態の表示文言を返す。
 *
 * @param status - UDP受信の状態。`null` は受信手順の生成前である。
 * @returns 日本語の短い表示。
 */
export function udpStatusLabel(status: UdpSnapshot["status"] | null): string {
  if (status === "received") return "受信済み";
  if (status === "ended") return "中断";
  if (status === "waiting") return "待機中";
  return "未受信";
}

/**
 * 累計の統計行にそろえる。
 *
 * @param snapshot - UDP表示用の写し。
 * @returns `受信 N件 MB・不正 K件` の1行。
 */
export function formatUdpStats(snapshot: UdpSnapshot): string {
  return `受信 ${snapshot.receivedCount}件 ${snapshot.receivedBytes}B / 不正 ${snapshot.invalidCount}件`;
}

/**
 * UDP表示板の表示行にそろえる。呼び出し側は戻り値を証拠・ログ・永続保存に
 * 混ぜないこと。復号バイト列は解釈せず、長さと先頭hexだけを載せる。
 *
 * @param snapshot - UDP表示用の写し。`null` は受信手順の生成前である。
 * @returns 表示する行の一覧。
 */
export function formatUdpLines(snapshot: UdpSnapshot | null): readonly string[] {
  if (snapshot === null) return ["UDP 未受信"];
  if (snapshot.status === "waiting") {
    if (snapshot.receivedCount === 0 && snapshot.invalidCount === 0) {
      return ["UDP 待機中（受信なし）"];
    }
    return ["UDP 待機中（受信なし）", formatUdpStats(snapshot)];
  }
  const head = snapshot.status === "ended" ? "UDP 中断（直近表示を残す）" : "UDP 受信済み";
  const rows = [head, formatUdpStats(snapshot)];
  if (snapshot.source !== null && snapshot.byteLength !== null && snapshot.previewHex !== null) {
    rows.push(`送信元 ${snapshot.source.address}:${snapshot.source.port}`);
    // ADR: 空データグラムは長さ0の正規受信として「空」と明示する。
    // 先頭hexは測幅で切り詰めるため、ここでは折り返さない。
    rows.push(
      snapshot.byteLength === 0
        ? "直近 0B（空）"
        : `直近 ${snapshot.byteLength}B ${snapshot.previewHex}`,
    );
  }
  return rows;
}
