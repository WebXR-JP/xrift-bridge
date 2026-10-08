/**
 * 診断状態の表示文言。React・R3F に依存しない。
 *
 * DOM パネルと in-world 操作盤で文言をそろえるための共用部品である。
 * 秘密値・業務 payload は扱わない。入力が秘密値を含む場合も、そのまま
 * 表示文言に混ぜず、呼び出し側で渡さないこと。
 *
 * @packageDocumentation
 */
import type { DiagnosticSnapshot } from "./session.ts";

/** 表示1行の上限文字数。3D 板の幅に収めるための目安である。 */
export const DISPLAY_LINE_LIMIT = 48;

/**
 * 表示1行を指定幅に収める。秘密値の有無で切り詰め方は変えない。
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
  if (phase === "authorized") return "認証済み";
  if (phase === "ended") return "終了（切断・失敗）";
  return "未接続";
}

/**
 * echo の表示文言を返す。payload 本文は扱わない。
 *
 * @param echo - echo 往復の表示内容。
 * @returns 日本語の短い表示。
 */
export function echoLabel(echo: DiagnosticSnapshot["echo"]): string {
  if (echo.status === "matched") return `一致（seq=${echo.seq ?? "?"} ${echo.bytes ?? "?"}b）`;
  if (echo.status === "mismatched") return "不一致";
  if (echo.status === "running") return "実行中";
  if (echo.status === "failed") return `失敗（${echo.error?.code ?? "UNKNOWN"}）`;
  return "未実行";
}

/**
 * ping の表示文言を返す。
 *
 * @param ping - ping の表示内容。
 * @returns 日本語の短い表示。
 */
export function pingLabel(ping: DiagnosticSnapshot["ping"]): string {
  if (ping.status === "pong") return "pong";
  if (ping.status === "running") return "実行中";
  if (ping.status === "failed") return `失敗（${ping.error?.code ?? "UNKNOWN"}）`;
  return "未実行";
}

/**
 * 快照を表示用の行にそろえる。秘密値・payload 本文は含まない。
 *
 * 呼び出し側は秘密値をこの関数に渡さないこと。快照自体が秘密値を
 * 持たない設計であり、ここでの整形で混入の余地を作らない。
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
