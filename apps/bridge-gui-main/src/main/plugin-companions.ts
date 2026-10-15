/**
 * プラグイン所有の GUI companion の登録表（ホスト実装）。
 *
 * companion の公開面（`PluginCompanion`・`CompanionRequestEnv`・
 * `CompanionDesiredBinding`）は `bridge-gui-plugin-sdk/companion` が正本で
 * あり、ここでは再 export する。ここには backend ごとの登録表の実装だけを
 * 置く。共通の対応付け・結線（binder・coordinator・channel factory）は種別分岐を
 * 持たず、ここから引いた記述子に委譲する。新しい companion の追加は
 * backend ごとの表への登録だけであり、共通コードの分岐追加は要らない。
 *
 * 実同梱には登録表への追加だけでは足りない。共通対応付け層の範囲に限り、
 * 登録だけで配置・結線・状態取得・push が通る。子画面の実体は別途
 * 静的 manifest（`src/composition/bundled-plugin-assets.ts`）から導く
 * `electrobun.config.ts` の `build.views`（子画面 entrypoint）と `copy`
 * （HTML・CSS の同梱）に載せ、遷移規則は登録済みの解決済み view パスから
 * backend が snapshot へ配布する（同期はテストで固定する）。
 *
 * companion は backend を capture した factory（例 `createTextCompanion(access)`）
 * で作り、backend を引数で受け取らない。共有の具象 companion インスタンス・
 * 既定引数・共有 singleton・共有表 helper は持たず、backend ごとに
 * registry を生成・注入する。登録順は text→diagnostic→udp である。
 *
 * WebView 生成・transport・個体束縛・失効・同梱許可・管理 DTO はホストが
 * 持ち続ける。`bridge-app-core` への GUI 逆依存は足さない。
 *
 * @packageDocumentation
 */
import { isPluginKind } from "bridge-gui-plugin-sdk/management";
import type { PluginCompanion } from "bridge-gui-plugin-sdk/companion";

export type {
  CompanionDesiredBinding,
  CompanionRequestEnv,
  PluginCompanion,
} from "bridge-gui-plugin-sdk/companion";

/**
 * companion の登録表。種別トークンから記述子を引く。
 *
 * backend ごとに生成し、使い捨てる。共有 singleton は持たない。
 * テスト専用の unregister は持たない（表を使い捨てる）。
 */
export class PluginCompanionRegistry {
  private readonly companions = new Map<string, PluginCompanion>();

  /**
   * companion を登録する。同梱 companion だけを登録し、任意の追加はしない。
   *
   * @param companion - 登録する companion の記述子。
   * @throws `Error` — 種別トークンが空・形式外・登録済みの場合。
   */
  register(companion: PluginCompanion): void {
    if (!isPluginKind(companion.kind)) {
      throw new Error("companion の種別トークンが形式外である。");
    }
    if (this.companions.has(companion.kind)) {
      throw new Error(`companion は登録済みである: ${companion.kind}`);
    }
    this.companions.set(companion.kind, companion);
  }

  /**
   * 種別トークンから記述子を引く。未登録なら `undefined` とし、
   * 呼び出し側が拒否・回収する。
   *
   * @param kind - 照合する種別トークン。
   * @returns 記述子。未登録なら `undefined`。
   */
  get(kind: string): PluginCompanion | undefined {
    return this.companions.get(kind);
  }

  /**
   * 登録済み companion を登録順に返す。配置の要望読みに使う。
   *
   * @returns 登録済みの記述子の一覧。
   */
  list(): readonly PluginCompanion[] {
    return [...this.companions.values()];
  }
}
