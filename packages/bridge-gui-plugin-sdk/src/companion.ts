/**
 * プラグイン所有の GUI companion の公開面。
 *
 * companion 宣言（表示名・相対 entry）・endpoint 工場・endpoint・
 * emission port だけを持ち、WebView 生成・transport・束縛・失効は持たない。
 * ホスト側の登録表実装はここに置かず、ホストが所有する。
 * 具象プラグインの import・既定登録の副作用・Electrobun/Bun/Node 実体・
 * ホストソースパス参照を持たない。
 *
 * @packageDocumentation
 */
import type { PluginRelayEvent, PluginRelayRequest } from "bridge-gui-contract/plugin-instance";
import type { BoundPluginRef } from "./management.ts";

/**
 * 解決前の companion の宣言。表示名と相対 entrypoint だけを持ち、
 * 解決済み view パス・子画面 URL の組み立ては持たない。
 *
 * プラグイン側の登録単位が返し、composition が静的 manifest と照合して
 * 解決済み view パスを付与し、解決済み companion として登録表に載せる。
 * 解決前の宣言を登録表に載せない。
 */
export interface PluginCompanionDeclaration {
  /** マウント識別子に載る種別トークン。小文字始まりの英数字であること。 */
  readonly kind: string;
  /** 失敗表示用の種別名（表示名のみ）。 */
  readonly label: string;
  /** 子画面の view 配置先を起点とする相対 entrypoint（例 `index.html`）。空でないこと。 */
  readonly viewEntry: string;
}

/**
 * 解決済み companion。宣言にホストが解決した view パスを付けたもの。
 *
 * 解決は静的 manifest との照合だけであり、種別ごとの URL 組立ては
 * 汎用の共有手段が行う。登録表の実体はホストが所有し、ここには置かない。
 */
export interface ResolvedPluginCompanion extends PluginCompanionDeclaration {
  /** 結線後に読み込む同梱子画面の view パス。ホストが解決した値だけを載せる。 */
  readonly viewPath: string;
}

/**
 * その表示期間の子にだけイベントを送る口。endpoint 工場へ渡す。
 *
 * 表示用 DTO の組立てはプラグイン所有の GUI アダプターが行い、この口は
 * 外形（`event` が空でない文字列であること）だけを見る。アプリは同一
 * マウント生存時のみ子へ素通しし、マウント失効後の到達は止める。
 * キュー・再配信・最新状態キャッシュを持たない。
 */
export interface PluginEmissionPort {
  /**
   * その表示期間の子へ通知を送る。マウント失効後は届けず捨てる。
   *
   * @param event - 通知の共通形。`payload` は不透明な表示用 DTO である。
   */
  emit(event: PluginRelayEvent): void;
}

/**
 * 束縛個体用の endpoint。不透明な要求を処理する口と冪等な終了口を持つ。
 *
 * 要求名・イベント名・業務上の型・実行時検証はプラグインの `gui-contract`
 * とこの endpoint が所有する。未知 `method`・`params` の検証はここが行い、
 * 反射的呼出し（`operations[method]` 等）はしない。アプリは `params`・
 * 応答値を `unknown` として素通しし、内容検査をしない。
 */
export interface PluginEndpoint {
  /**
   * 不透明な要求を処理する。
   *
   * 業務エラーは投げず不透明な応答値として返す（プラグインの結果として
   * 扱う）。投げた例外は想定外の失敗として中継失敗に落とす。`RangeError`
   * を投げても束縛失効とは解釈しない（失効はホスト自身の照合が決める）。
   *
   * @param request - 中継要求の共通形。
   * @returns 不透明な応答値。
   */
  handleRequest(request: PluginRelayRequest): Promise<unknown>;
  /**
   * 冪等な終了。本体購読・集約タイマー・参照を解放する。
   *
   * 繰返し呼んでも二重解放しない。子の破棄でプラグイン本体・Session・
   * UDP ソケットは終了しない。
   */
  dispose(): void;
}

/**
 * endpoint 工場。起動時の静的登録で登録し、マウント時に個体へ束縛した
 * endpoint を生成する。
 *
 * 子が実行時に要求名や対象個体を登録する方式にはしない。参照口はホストが
 * 選んだ一個体に限定し、型消去はこの閉包内に限定する。本体の状態変更の
 * 購読は本体が公開する手段でこの中で組み立て、表示用 DTO を emission port
 * へ送る。
 *
 * @typeParam S - プラグイン本体の状態の型。
 * @typeParam O - プラグイン固有の操作口の型。
 * @param ref - ホストが選んだ一個体に限定した参照口。
 * @param emission - その表示期間の子にだけ送る口。
 * @returns 束縛個体用の endpoint。
 */
export type PluginEndpointFactory<S, O> = (
  ref: BoundPluginRef<S, O>,
  emission: PluginEmissionPort,
) => PluginEndpoint;
