/**
 * Node シナリオの実行口。各項目の生の観測結果を標準出力へ出す。
 *
 * 実行: `pnpm --filter yamux-spike run scenario`
 *
 * @packageDocumentation
 */

import { ALL_SCENARIOS } from "./scenarios.ts";

let failed = 0;
for (const run of ALL_SCENARIOS) {
  const started = Date.now();
  try {
    const found = await run();
    if (!found.ok) failed += 1;
    console.log(`=== ${found.name}: ${found.ok ? "成功" : "失敗"} (${Date.now() - started}ms) ===`);
    for (const note of found.notes) console.log(`- ${note}`);
    console.log(`data: ${JSON.stringify(found.data)}`);
  } catch (cause) {
    failed += 1;
    const message = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    console.log(`=== 不明なシナリオ: 失敗 (${Date.now() - started}ms) ===`);
    console.log(`- 実行中に例外が出た: ${message}`);
  }
}
if (failed > 0) {
  console.log(`結果: ${failed}件が失敗した`);
  process.exitCode = 1;
} else {
  console.log("結果: すべて成功した");
}
