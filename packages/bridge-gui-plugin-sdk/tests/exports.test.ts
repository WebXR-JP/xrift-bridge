import { expect, test } from "vite-plus/test";
import { isPluginKind, isRelativeAssetPath } from "bridge-gui-plugin-sdk";
import { isPluginKind as isPluginKindSubpath } from "bridge-gui-plugin-sdk/management";
import { isRelativeAssetPath as isRelativeAssetPathSubpath } from "bridge-gui-plugin-sdk/assets";

// 公開 subpath の実行時表面を固定する。SDK は型中心であり、実行時値は
// 検証 helper のみを持つ。名前付き import 自体が存在の保証になり、
// 本体では判定の振る舞いだけを確かめる。

test("種別トークンの判定が管理層と登録表の規約に一致する", () => {
  expect(isPluginKind("text")).toBe(true);
  expect(isPluginKind("diagnostic")).toBe(true);
  expect(isPluginKindSubpath("alpha")).toBe(true);
  expect(isPluginKind("")).toBe(false);
  expect(isPluginKind("Text")).toBe(false);
  expect(isPluginKind("text-plugin")).toBe(false);
  expect(isPluginKind(123)).toBe(false);
  expect(isPluginKind(null)).toBe(false);
});

test("相対資産パスの判定が空・絶対・遡りを拒否する", () => {
  expect(isRelativeAssetPath("index.html")).toBe(true);
  expect(isRelativeAssetPath("assets/style.css")).toBe(true);
  expect(isRelativeAssetPathSubpath("assets/style.css")).toBe(true);
  expect(isRelativeAssetPath("")).toBe(false);
  expect(isRelativeAssetPath("/index.html")).toBe(false);
  expect(isRelativeAssetPath("views://plugin-text/index.html")).toBe(false);
  expect(isRelativeAssetPath("../secret")).toBe(false);
  expect(isRelativeAssetPath("a//b")).toBe(false);
  expect(isRelativeAssetPath(null)).toBe(false);
});
