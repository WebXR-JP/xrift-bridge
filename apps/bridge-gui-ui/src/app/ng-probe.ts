/**
 * 開発専用観測口（`ngDebugProbe`）の応答組み立て。
 *
 * DOM の読取りは呼び出し側（Angular のサービス）が行い、ここでは純粋に
 * 許可 DTO だけを組み立てる。比較コード本文・業務 payload・テキスト本文は
 * 扱わない（可否・件数・改訂番号のみ）。
 *
 * @packageDocumentation
 */
import type { NgDebugProbeResult } from "bridge-gui-contract/management";

/** 観測口の応答に載せる入力。DOM 読取り済みの値だけを受ける。 */
export interface NgProbeInput {
  /** Angular の開発モードの場合に真。 */
  readonly devMode: boolean;
  /** `globalThis.ng` が存在する場合に真。 */
  readonly hasNg: boolean;
  /** ルートコンポーネントが文書にある場合に真。 */
  readonly componentMounted: boolean;
  /** `ng.getComponent` 系が関数として使える場合に真。 */
  readonly hasGetComponent: boolean;
  /** ルート要素からコンポーネント実体が取得できた場合に真。 */
  readonly resolvedComponent: boolean;
  /** 取得の呼び出しが例外で終わった場合に真（内容は載せない）。 */
  readonly getFailed: boolean;
  /** 採用中の表示状態の改訂番号。未取得なら `null`。 */
  readonly revision: number | null;
  /** 文書にある `electrobun-webview` 要素の数。 */
  readonly webviewTagCount: number;
  /** main の JS 実行標識を検出した場合に真。 */
  readonly execMark: boolean;
}

/**
 * 観測口の応答を組み立てる。
 *
 * 開発モードかつ `ng` 存在かつ描画済みの場合だけ有効とし、それ以外は
 * 無効応答にする（stable ビルドでの開発口無効の判定に使う）。取得の例外は
 * 握りつぶさず定型の理由に落とす。実体・injector は載せない。
 *
 * @param input - DOM 読取り済みの観測入力。
 * @returns 許可 DTO だけの観測応答。
 */
export function buildNgDebugProbeResult(input: NgProbeInput): NgDebugProbeResult {
  const effective = input.devMode && input.hasNg && input.componentMounted;
  // 有効でも取得に失敗した場合はその旨を残す。無効の場合は無効の理由を優先する。
  const reason = effective
    ? input.getFailed
      ? "部品の取得に失敗した。"
      : ""
    : "開発口が無効である（製品ビルドまたは未描画）。";
  return {
    available: effective,
    reason,
    hasNg: input.hasNg,
    componentMounted: input.componentMounted,
    hasGetComponent: input.hasGetComponent,
    resolvedComponent: input.resolvedComponent,
    revision: input.revision,
    webviewTagCount: input.webviewTagCount,
    execMark: input.execMark,
  };
}
