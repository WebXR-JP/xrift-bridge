/**
 * PC上で動作する中継アプリの起動点。
 *
 * @packageDocumentation
 */
import { PROTOCOL_VERSION } from "bridge-protocol";

// 中継処理は未実装のため、起動確認の出力のみ行う。
console.log(`xrift-bridge 起動 (protocol ${PROTOCOL_VERSION})。`);
