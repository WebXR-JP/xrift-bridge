/**
 * 診断状態の表示文言。React・R3F に依存しない。
 *
 * DOM パネルと in-world 操作盤で文言をそろえるための共用部品である。
 * 比較コード本文・業務 payload は扱いに注意する。比較コードは画面表示の
 * ために整形するだけで、証拠 JSON・ログ・永続保存には混ぜないこと。
 *
 * @packageDocumentation
 */
import { formatPairingCode as formatPairingCodeCanonical, isPairingCode } from "bridge-protocol";
import type { DiagnosticSnapshot } from "./session.ts";

/** 表示1行の上限文字数。3D 板の幅に収めるための目安である。 */
export const DISPLAY_LINE_LIMIT = 48;

/**
 * 表示1行を指定幅に収める。
 *
 * @param line - 表示する1行。
 * @returns 上限を超える場合は末尾を省略記号に置き換えた行。
 */
export function truncateLine(line: string): string {
  if (line.length <= DISPLAY_LINE_LIMIT) return line;
  return `${line.slice(0, DISPLAY_LINE_LIMIT - 1)}…`;
}

/**
 * 進行の表示文言を返す。
 *
 * @param phase - 診断のおおまかな進行。
 * @returns 日本語の短い表示。
 */
export function phaseLabel(phase: string): string {
  if (phase === "connecting") return "接続中";
  if (phase === "awaiting_approval") return "承認待ち";
  if (phase === "authorized") return "認証済み";
  if (phase === "ended") return "終了（切断・失敗）";
  return "未接続";
}

/**
 * 比較コードを区切り表示にそろえる。ASCII 数字 6 文字は3桁区切りにする。
 *
 * 画面表示のための整形であり、証拠・ログに残す用途ではない。
 *
 * @param code - ブリッジが発行した比較コード。
 * @returns 6 桁数字の場合は `123 456` 形式、それ以外はそのまま。
 */
export function formatPairingCode(code: string): string {
  // 書式判定は正本（`bridge-protocol`）に寄せる。不正時は入力をそのまま返す。
  if (!isPairingCode(code)) {
    return code;
  }
  return formatPairingCodeCanonical(code);
}

/**
 * echo の表示文言を返す。payload 本文・wire 連番は扱わない。
 *
 * wire の連番は表示せず、診断が採番した操作番号・バイト数・往復時間を載せる。
 *
 * @param echo - echo 往復の表示内容。
 * @returns 日本語の短い表示。
 */
export function echoLabel(echo: DiagnosticSnapshot["echo"]): string {
  const detail =
    echo.opNo === undefined
      ? ""
      : `（op=${echo.opNo}` +
        (echo.bytes === undefined ? "" : ` ${echo.bytes}b`) +
        (echo.rttMs === undefined ? "" : ` ${echo.rttMs}ms`) +
        "）";
  if (echo.status === "matched") return `一致${detail}`;
  if (echo.status === "mismatched") return `不一致${detail}`;
  if (echo.status === "running") return "実行中";
  if (echo.status === "unknown") return "結果不明";
  if (echo.status === "failed") return `失敗（${echo.error?.code ?? "UNKNOWN"}）`;
  return "未実行";
}

/**
 * ping の表示文言を返す。
 *
 * 業務ハンドラの応答確認であり、yamux 監視 Ping とは別物である。
 * wire の連番は表示せず、操作番号・往復時間を載せる。
 *
 * @param ping - ping の表示内容。
 * @returns 日本語の短い表示。
 */
export function pingLabel(ping: DiagnosticSnapshot["ping"]): string {
  const detail =
    ping.opNo === undefined
      ? ""
      : `（op=${ping.opNo}` + (ping.rttMs === undefined ? "" : ` ${ping.rttMs}ms`) + "）";
  if (ping.status === "pong") return `pong${detail}`;
  if (ping.status === "running") return "実行中";
  if (ping.status === "unknown") return "結果不明";
  if (ping.status === "failed") return `失敗（${ping.error?.code ?? "UNKNOWN"}）`;
  return "未実行";
}

/**
 * 快照を表示用の行にそろえる。比較コード本文は画面表示の行にのみ含める。
 *
 * 呼び出し側はこの戻り値を証拠・ログ・永続保存に混ぜないこと。証拠用の
 * JSON は `toResultJson` を使い、比較コード本文を含めない。
 *
 * @param snapshot - 診断の写し。
 * @param portError - ポート入力の誤り。無い場合は `null`。
 * @returns 表示する行の一覧。
 */
export function formatDiagnosticLines(
  snapshot: DiagnosticSnapshot,
  portError: string | null = null,
): readonly string[] {
  const lines: string[] = [
    `接続先 ${snapshot.endpoint}`,
    `進行 ${phaseLabel(snapshot.phase)} / 接続 ${snapshot.connectionState}`,
  ];
  if (snapshot.pairing !== null) {
    lines.push(`比較コード ${formatPairingCode(snapshot.pairing.code)} 照合して承認`);
  }
  if (snapshot.lastError === null) {
    lines.push("エラーなし");
  } else {
    lines.push(`失敗 ${snapshot.lastError.code}: ${snapshot.lastError.message}`);
    if (snapshot.lastError.hint !== undefined) lines.push(`案内 ${snapshot.lastError.hint}`);
  }
  lines.push(`echo ${echoLabel(snapshot.echo)} / ping ${pingLabel(snapshot.ping)}`);
  if (portError !== null) lines.push(`ポート入力 ${portError}`);
  lines.push(`origin ${snapshot.env.origin}`);
  lines.push(`secure ${snapshot.env.secureContext ? "true" : "false"}`);
  lines.push(`frame ${snapshot.env.topLevel ? "top-level" : "embedded"}`);
  lines.push(
    `build ${snapshot.build.version} / ${snapshot.build.commit} / ${snapshot.build.builtAt}`,
  );
  return lines.map((line) => truncateLine(line));
}
