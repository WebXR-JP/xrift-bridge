import { describe, expect, it } from "vite-plus/test";
import { DEV_OBSERVE_TARGETS, buildNgDevObserveResult } from "../src/app/dev-observe.ts";
import type { DevObserveInput } from "../src/app/dev-observe.ts";

// 開発専用の段階観測（DOM 反映）。固定要素キー・矩形・表示/disabled・
// 焦点だけを返し、入力値・本文・実体を含まないことを固定する。

/** 観測入力の試験値。判定に要る項目だけを載せる。 */
function makeInput(overrides?: Partial<DevObserveInput>): DevObserveInput {
  return {
    devMode: true,
    hasNg: true,
    componentMounted: true,
    resolvedComponent: true,
    adoptedRevision: 3,
    focus: true,
    activeKey: "status-summary",
    elements: DEV_OBSERVE_TARGETS.map((target) => ({
      key: target.key,
      present: true,
      visible: true,
      disabled: false,
      rect: { x: 0, y: 0, width: 100, height: 20 },
    })),
    ...overrides,
  };
}

describe("段階観測の応答組み立て", () => {
  it("開発条件が揃うと有効になり固定要素表の順で返す", () => {
    const reversed = {
      ...makeInput(),
      activeKey: null as string | null,
      elements: [...makeInput().elements].reverse(),
    };
    const result = buildNgDevObserveResult(reversed);
    expect(result.available).toBe(true);
    expect(result.reason).toBe("");
    expect(result.adoptedRevision).toBe(3);
    expect(result.focus).toBe(true);
    expect(result.activeKey).toBe(null);
    expect(result.elements.map((element) => element.key)).toEqual(
      DEV_OBSERVE_TARGETS.map((target) => target.key),
    );
    expect(result.hasNg).toBe(true);
    expect(result.componentMounted).toBe(true);
    expect(result.resolvedComponent).toBe(true);
  });

  it("製品ビルドでは無効になり改訂番号を載せない", () => {
    const result = buildNgDevObserveResult(makeInput({ devMode: false, hasNg: false }));
    expect(result.available).toBe(false);
    expect(result.reason).toBe("開発口が無効である（製品ビルドまたは未描画）。");
    // 無効時は採用したことにならないため `null` である。
    expect(result.adoptedRevision).toBe(null);
  });

  it("表外の要素キーは応答に載せない", () => {
    const result = buildNgDevObserveResult(
      makeInput({
        elements: [
          ...makeInput().elements,
          {
            key: "任意の要素",
            present: true,
            visible: true,
            disabled: false,
            rect: { x: 0, y: 0, width: 1, height: 1 },
          },
        ],
      }),
    );
    expect(result.elements.some((element) => element.key === "任意の要素")).toBe(false);
  });

  it("応答は許可項目だけを持ち本文の置き場が無い", () => {
    const result = buildNgDevObserveResult(makeInput());
    const dumped = JSON.stringify(result);
    expect(dumped).not.toContain("041003");
    // 要素の記録は固定項目だけを持つ。
    for (const element of result.elements) {
      expect(Object.keys(element).sort()).toEqual([
        "disabled",
        "key",
        "present",
        "rect",
        "visible",
      ]);
    }
    // 固定表のキーだけを載せる。
    const keys = new Set(DEV_OBSERVE_TARGETS.map((target) => target.key));
    for (const element of result.elements) {
      expect(keys.has(element.key)).toBe(true);
    }
  });

  it("固定表はスロット構成であり旧節を載せない", () => {
    const keys = DEV_OBSERVE_TARGETS.map((target) => target.key);
    for (const key of [
      "plugin-operations",
      "plugin-view-retry",
      "plugin-view-fallback",
      "plugin-slot",
      "plugin-host",
      "panel-operations",
    ]) {
      expect(keys).toContain(key);
    }
    for (const key of ["plugin-mounts", "spike-section", "spike-host"]) {
      expect(keys).not.toContain(key);
    }
    // 包含要素より具体部品を先に置く（焦点の吸収を避ける）。
    expect(keys.indexOf("plugin-view-retry")).toBeLessThan(keys.indexOf("plugin-view-fallback"));
    expect(keys.indexOf("plugin-view-fallback")).toBeLessThan(keys.indexOf("plugin-slot"));
  });
});
