/**
 * 試作観測用の最小 Logger。
 *
 * @packageDocumentation
 */

import type { Logger } from "@libp2p/interface";

/** 記録したログ1件分。 */
export interface SpikeLogRecord {
  readonly scope: string;
  readonly level: "log" | "error" | "trace";
  readonly message: string;
}

/**
 * libp2p の Logger 形状を満たす最小実装を作る。
 *
 * @param scope - このロガーの適用範囲名。
 * @param sink - 記録先。省略時は標準出力へ出さず破棄する。
 * @returns libp2p の YamuxMuxer へ渡せる Logger。
 */
export function createSpikeLogger(scope: string, sink?: (record: SpikeLogRecord) => void): Logger {
  const emit = (level: SpikeLogRecord["level"], formatter: unknown, args: unknown[]): void => {
    if (sink === undefined) return;
    const rest = args.map((arg) => String(arg)).join(" ");
    sink({ scope, level, message: `${String(formatter)} ${rest}`.trim() });
  };
  const log = ((formatter: unknown, ...args: unknown[]): void => {
    emit("log", formatter, args);
  }) as Logger;
  // ADR: Logger は呼び出し可能オブジェクトであり型推論では組み立てられないため、
  // 形状が一致すること（呼び出し・error・trace・enabled・newScope）を根拠に主張する。
  log.error = (formatter: unknown, ...args: unknown[]): void => {
    emit("error", formatter, args);
  };
  log.trace = (formatter: unknown, ...args: unknown[]): void => {
    emit("trace", formatter, args);
  };
  log.enabled = sink !== undefined;
  log.newScope = (name: string): Logger => createSpikeLogger(`${scope}:${name}`, sink);
  return log;
}
