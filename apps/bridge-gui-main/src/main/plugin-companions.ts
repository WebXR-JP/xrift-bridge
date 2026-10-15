/**
 * プラグイン所有の GUI companion の登録表（ホスト実装）。
 *
 * 解決済み companion（表示名・相対 entry の解決結果である解決済み view パス）と
 * endpoint 工場の対応付けだけを持ち、WebView 生成・transport・束縛・失効は
 * 持たない。共通の対応付け・結線（coordinator・channel factory）は種別分岐を
 * 持たず、ここから引いた記述子に委譲する。新しい companion の追加は
 * backend ごとの表への登録だけであり、共通コードの分岐追加は要らない。
 *
 * 解決前の宣言を登録表に載せない。view パスの解決は backend の registrar が
 * 登録時に静的 manifest 由来の resolver で行い、解決済みだけを載せる。
 *
 * @packageDocumentation
 */
import { isPluginKind } from "bridge-gui-plugin-sdk/management";
import type {
  PluginEmissionPort,
  PluginEndpoint,
  ResolvedPluginCompanion,
} from "bridge-gui-plugin-sdk/companion";
import type { BoundPluginRef } from "bridge-gui-plugin-sdk/management";

/**
 * 型を消した endpoint 工場。登録時に具象型の到達を閉包へ包み、
 * 駆動は消した型で行う。型消去は閉包内に限定し、ホストは状態の型・
 * 内容を解釈しない。
 */
export type ErasedEndpointFactory = (
  ref: BoundPluginRef<unknown, unknown>,
  emission: PluginEmissionPort,
) => PluginEndpoint;

/**
 * 登録表の1行。解決済み companion と endpoint 工場の組である。
 */
export interface PluginCompanionEntry {
  /** 解決済み companion。表示名と解決済み view パスを持つ。 */
  readonly companion: ResolvedPluginCompanion;
  /** 束縛個体用の endpoint 工場。 */
  readonly createEndpoint: ErasedEndpointFactory;
}

/**
 * companion の登録表。種別トークンから記述子を引く。
 *
 * backend ごとに生成し、使い捨てる。共有 singleton は持たない。
 * テスト専用の unregister は持たない（表を使い捨てる）。
 */
export class PluginCompanionRegistry {
  private readonly entries = new Map<string, PluginCompanionEntry>();

  /**
   * 解決済み companion と endpoint 工場を登録する。同梱だけを登録し、
   * 任意の追加はしない。
   *
   * @param companion - 登録する解決済み companion。
   * @param createEndpoint - 束縛個体用の endpoint 工場。
   * @throws `Error` — 種別トークンが空・形式外・登録済みの場合。
   */
  register(companion: ResolvedPluginCompanion, createEndpoint: ErasedEndpointFactory): void {
    if (!isPluginKind(companion.kind)) {
      throw new Error("companion の種別トークンが形式外である。");
    }
    if (companion.viewPath.length === 0) {
      throw new Error("companion の view パスが空である。");
    }
    if (this.entries.has(companion.kind)) {
      throw new Error(`companion は登録済みである: ${companion.kind}`);
    }
    this.entries.set(companion.kind, { companion, createEndpoint });
  }

  /**
   * 種別トークンから行を引く。未登録なら `undefined` とし、
   * 呼び出し側が拒否・回収する。
   *
   * @param kind - 照合する種別トークン。
   * @returns 行。未登録なら `undefined`。
   */
  getEntry(kind: string): PluginCompanionEntry | undefined {
    return this.entries.get(kind);
  }

  /**
   * 種別トークンから解決済み companion を引く。
   *
   * @param kind - 照合する種別トークン。
   * @returns 解決済み companion。未登録なら `undefined`。
   */
  getCompanion(kind: string): ResolvedPluginCompanion | undefined {
    return this.entries.get(kind)?.companion;
  }

  /**
   * 登録済み行を登録順に返す。配置の解決済み view パス集合・遷移規則の
   * 生成に使う。
   *
   * @returns 登録済みの行の一覧。
   */
  list(): readonly PluginCompanionEntry[] {
    return [...this.entries.values()];
  }

  /**
   * 登録済み companion を登録順に返す。
   *
   * @returns 登録済みの解決済み companion の一覧。
   */
  listCompanions(): readonly ResolvedPluginCompanion[] {
    return [...this.entries.values()].map((entry) => entry.companion);
  }
}
