/**
 * 開発専用の Angular 段階観測（DOM 反映）の応答組み立て。
 *
 * DOM の読取りは呼び出し側（Angular のサービス）が行い、ここでは純粋に
 * 許可 DTO だけを組み立てる。固定要素キー・矩形・表示/disabled・焦点の
 * 有無だけを載せ、入力値・本文・実体・injector は扱わない。
 *
 * @packageDocumentation
 */
import type { NgDevObserveElement, NgDevObserveResult } from "bridge-gui-contract/management";

/**
 * 段階観測の固定要素表。管理画面の構成要素に対応する選択子だけを載せる。
 *
 * キーは応答に載せる固定名であり、選択子は文書内の Angular 要素を指す。
 * 任意の選択子・全文取得はしない。`readActiveKey` は表の順で `closest` を
 * 返すため、具体的な部品を先に、包含的な要素（子画面 host・パネル・
 * シェル側）を後に置く。包含側を先に置くと内側部品の焦点が包含側に
 * 吸収される。
 */
export const DEV_OBSERVE_TARGETS: readonly { key: string; selector: string }[] = [
  { key: "status-summary", selector: "app-status-summary" },
  { key: "acceptance-toggle", selector: "app-acceptance-toggle" },
  { key: "pending-list", selector: "app-pending-list" },
  { key: "connection-list", selector: "app-connection-list" },
  { key: "session-list", selector: "app-session-list" },
  { key: "plugin-list", selector: "app-plugin-list" },
  { key: "plugin-operations", selector: "app-plugin-operations" },
  { key: "plugin-view-retry", selector: "[data-plugin-view-retry]" },
  { key: "plugin-view-fallback", selector: "app-plugin-view-fallback" },
  { key: "event-log", selector: "app-event-log" },
  { key: "plugin-slot", selector: "#plugin-slot" },
  { key: "plugin-host", selector: "#plugin-host" },
  { key: "panel-connections", selector: '[data-panel="connections"]' },
  { key: "panel-sessions", selector: '[data-panel="sessions"]' },
  { key: "panel-plugins", selector: '[data-panel="plugins"]' },
  { key: "panel-operations", selector: '[data-panel="operations"]' },
  { key: "panel-log", selector: '[data-panel="log"]' },
  { key: "shell-sidebar", selector: "app-shell aside" },
  { key: "page-header", selector: "app-shell header" },
] as const;

/** 固定要素表の順に並べた観測入力（DOM 読取り済みの値）。 */
export interface DevObserveElementInput {
  /** 固定要素キー（観測対象表のいずれか）。 */
  readonly key: string;
  /** 対応する要素が文書にある場合に真。 */
  readonly present: boolean;
  /** 表示されている場合に真。 */
  readonly visible: boolean;
  /** 無効化されている入力要素を含む場合に真。 */
  readonly disabled: boolean;
  /** 要素の矩形（丸めた整数）。不在・測定不能なら `null`。 */
  readonly rect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null;
}

/** 観測口の応答に載せる入力。DOM 読取り済みの値だけを受ける。 */
export interface DevObserveInput {
  /** Angular の開発モードの場合に真。 */
  readonly devMode: boolean;
  /** `globalThis.ng` が存在する場合に真。 */
  readonly hasNg: boolean;
  /** ルートコンポーネントが文書にある場合に真。 */
  readonly componentMounted: boolean;
  /** ルート要素からコンポーネント実体が取得できた場合に真。 */
  readonly resolvedComponent: boolean;
  /** 採用中の表示状態の改訂番号。未取得なら `null`。 */
  readonly adoptedRevision: number | null;
  /** 文書が焦点を持っている場合に真。 */
  readonly focus: boolean;
  /** 焦点要素の固定キー。表外・不在なら `null`。 */
  readonly activeKey: string | null;
  /** 固定要素表の順の観測入力。 */
  readonly elements: readonly DevObserveElementInput[];
}

/**
 * 観測口の応答を組み立てる。
 *
 * 開発モードかつ `ng` 存在かつ描画済みの場合だけ有効とし、それ以外は
 * 無効応答にする（stable ビルドでの開発口無効の判定に使う）。無効応答では
 * 採用したことにならないため `adoptedRevision` は `null` に落とす
 * （`available:false` と紛らわしい値の共存を避ける）。要素表に
 * 無いキーは載せない。実体・injector・入力値・本文は載せない。
 *
 * @param input - DOM 読取り済みの観測入力。
 * @returns 許可 DTO だけの観測応答。
 */
export function buildNgDevObserveResult(input: DevObserveInput): NgDevObserveResult {
  const effective = input.devMode && input.hasNg && input.componentMounted;
  // 固定表の順に並べ替え、表外のキーは捨てる（任意要素の混入を防ぐ）。
  const order = new Map(DEV_OBSERVE_TARGETS.map((target, index) => [target.key, index]));
  const picked = input.elements
    .filter((element) => order.has(element.key))
    .sort(
      (left, right) =>
        (order.get(left.key) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right.key) ?? Number.MAX_SAFE_INTEGER),
    );
  const elements: readonly NgDevObserveElement[] = picked.map((element) => ({
    key: element.key,
    present: element.present,
    visible: element.visible,
    disabled: element.disabled,
    rect: element.rect,
  }));
  return {
    available: effective,
    reason: effective ? "" : "開発口が無効である（製品ビルドまたは未描画）。",
    // 無効時は採用したことにならないため載せない（`available:false` と整合させる）。
    adoptedRevision: effective ? input.adoptedRevision : null,
    focus: input.focus,
    activeKey: input.activeKey,
    elements,
    hasNg: input.hasNg,
    componentMounted: input.componentMounted,
    resolvedComponent: input.resolvedComponent,
  };
}
