/**
 * CLI の診断実行状態（app-core の同梱診断プラグインによる応答）。
 *
 * reliable Session ごとに診断インスタンスを生成して接続口 `"diagnostic"` に
 * 割り当て、応答統計を集める。サーバ側に診断の解釈はなく、応答確認相当の
 * 応答はこの割当てが担う。従来の複数診断 Session を維持するため、一つの
 * 接続口へ複数は付けず、Session ごとに1インスタンスを生成する。
 *
 * @packageDocumentation
 */
import type { BridgeServer, BridgeSessionInfo } from "bridge-server";
import {
  createBridgeAppCore,
  type BridgeAppCore,
  type PluginInstanceHandle,
} from "bridge-app-core/core";
import {
  DIAGNOSTIC_PORT_ID,
  diagnosticPlugin,
  type DiagnosticStats,
} from "bridge-plugin-diagnostic";
import { TEXT_SESSION_ID } from "bridge-plugin-text/contract";

/**
 * CLI の診断実行状態の操作口。
 */
export interface BridgeDiagnostics {
  /** 累積値と生存インスタンスの合計の応答統計。 */
  getStats(): DiagnosticStats;
  /** app-core を閉じる。 */
  close(): void;
}

/**
 * 診断の実行状態を開始する。
 *
 * 開始通知（reliable）でインスタンスを生成・割当てし、終了通知で統計を
 * 累積値へ回収してから削除する。既存セッションは初期走査で割り当てる。
 * 再接続の同名セッションへ割当ては継承しない。
 * テキスト表示用セッション（論理名 `text`）は診断割当ての対象外とし、
 * テキスト割当てと排他にする。
 *
 * @param server - 起動中のブリッジ。
 * @returns 診断統計の取得口と終了口。
 */
export function startDiagnostics(server: BridgeServer): BridgeDiagnostics {
  const core: BridgeAppCore = createBridgeAppCore(server);
  let closed = false;
  let echoAccumulated = 0;
  let pingAccumulated = 0;
  const live = new Map<string, PluginInstanceHandle<DiagnosticStats>>();

  const attach = (info: BridgeSessionInfo): void => {
    if (closed) return;
    if (info.kind !== "reliable") return;
    // テキスト表示用セッションは診断割当ての対象外とし、テキスト割当てと排他にする。
    if (info.sessionId === TEXT_SESSION_ID) return;
    if (live.has(info.localSessionId)) return;
    const handle = core.createInstance(diagnosticPlugin);
    try {
      core.assign(info.localSessionId, handle.instanceId, DIAGNOSTIC_PORT_ID);
    } catch {
      // 割当てに失敗した Session は残さず、生成したインスタンスだけを片付ける。
      try {
        core.removeInstance(handle.instanceId);
      } catch {
        // 片付けの失敗は開始を止めない。
      }
      return;
    }
    live.set(info.localSessionId, handle);
  };

  const detach = (info: BridgeSessionInfo): void => {
    const handle = live.get(info.localSessionId);
    if (handle === undefined) return;
    live.delete(info.localSessionId);
    // ADR: 終了通知の時点で応答統計を累積値へ回収してから削除する。
    // 再接続の同名セッションへ割当ては継承しない。
    try {
      const state = handle.getState();
      echoAccumulated += state.diagnosticEcho;
      pingAccumulated += state.diagnosticPing;
    } catch {
      // 状態取得の失敗は累積を止めない。
    }
    try {
      core.removeInstance(handle.instanceId);
    } catch {
      // 削除の失敗は終了通知を止めない。
    }
  };

  for (const info of server.listSessions()) {
    attach(info);
  }
  const unsubscribe = server.onManagementEvent((event) => {
    if (event.kind === "session-started") {
      attach(event.session);
    } else if (event.kind === "session-ended") {
      detach(event.session);
    }
  });

  return {
    getStats: (): DiagnosticStats => {
      let echo = echoAccumulated;
      let ping = pingAccumulated;
      for (const handle of live.values()) {
        try {
          const state = handle.getState();
          echo += state.diagnosticEcho;
          ping += state.diagnosticPing;
        } catch {
          // 状態取得の失敗は合計を止めない。
        }
      }
      return { diagnosticEcho: echo, diagnosticPing: ping };
    },
    close: (): void => {
      if (closed) return;
      closed = true;
      try {
        unsubscribe();
      } catch {
        // 購読解除の失敗は終了を止めない。
      }
      // ADR: 生存分の統計を失わないよう、app-core 終了前に累積へ回収する。
      for (const handle of live.values()) {
        try {
          const state = handle.getState();
          echoAccumulated += state.diagnosticEcho;
          pingAccumulated += state.diagnosticPing;
        } catch {
          // 状態取得の失敗は終了を止めない。
        }
      }
      live.clear();
      core.close();
    },
  };
}
