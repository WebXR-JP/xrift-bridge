import { Electroview } from "electrobun/view";
import type { ManagementRpc, ManagementSnapshot, PairingViewResult } from "../shared/management.ts";
import { selectNewer } from "../shared/management.ts";

function el(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`管理画面の要素が見つからない: #${id}`);
  }
  return element;
}

/** 受信記録へ1行追加する（デバッグ表示用。比較コード本文・payload は載せない）。 */
function appendLog(message: string): void {
  const log = document.querySelector<HTMLUListElement>("#event-log");
  if (!log) {
    return;
  }
  const item = document.createElement("li");
  item.textContent = message;
  log.append(item);
}

/** 残りミリ秒を人間向けの秒表示にする（切り上げ）。 */
function formatRemain(ms: number): string {
  return `${Math.max(0, Math.ceil(ms / 1000))} 秒`;
}

// 現在採用中の表示状態。未取得の間は null である。
let current: ManagementSnapshot | null = null;
// 採用時点の単調時計（`performance.now()`）。残時間の減算起点である。
let receivedAt = 0;
// 表示用に取得した比較コード。承認には使わない（明示操作だけが承認する）。
const pairingViews = new Map<string, { view: PairingViewResult; receivedAt: number }>();

/** 取得値から画面側の単調時計で減算した残時間を返す。期限判断には使わない。 */
function remain(initialMs: number, base: number): number {
  return Math.max(0, initialMs - (performance.now() - base));
}

/** 採用中の表示状態を画面に反映する。 */
function render(snapshot: ManagementSnapshot): void {
  // 改訂番号を文書題にも反映する。画面での表示確認用である。
  document.title = `XRift Bridge 管理画面 — rev ${snapshot.revision}`;
  el("revision").textContent = String(snapshot.revision);
  el("backend").textContent = snapshot.backend;
  el("endpoint").textContent =
    snapshot.endpoint === null
      ? "未公開"
      : `${snapshot.endpoint.url}（${snapshot.endpoint.listening ? "受付中" : "停止中"}）`;
  el("admission").textContent = snapshot.admission.accepting
    ? `受付中（残り ${formatRemain(remain(snapshot.admission.remainingMs, receivedAt))}）`
    : "受付停止中";
  el("pending").textContent = `${snapshot.pending.length} 件`;
  el("connections").textContent = `${snapshot.connections.length} 件`;
  el("sessions").textContent = `${snapshot.sessions.length} 件`;
  el("plugins").textContent =
    `実体 ${snapshot.plugins.instances.length}・割当て ${snapshot.plugins.assignments.length}`;
  renderPending(snapshot);
  renderConnections(snapshot);
  renderSessions(snapshot);
}

/** 保留一覧を描画する。比較コード本文は載せない。 */
function renderPending(snapshot: ManagementSnapshot): void {
  const list = document.querySelector<HTMLUListElement>("#pending-list");
  if (!list) {
    return;
  }
  list.replaceChildren();
  if (snapshot.pending.length === 0) {
    const item = document.createElement("li");
    item.textContent = "保留は無い";
    list.append(item);
    return;
  }
  for (const entry of snapshot.pending) {
    const item = document.createElement("li");
    const rest = document.createElement("span");
    // 残時間の減算表示用。期限・承認可否の判断は server が行う。
    rest.id = `pending-remain-${entry.requestId}`;
    rest.textContent = `残り ${formatRemain(remain(entry.expiresInMs, receivedAt))}`;
    item.append(`${entry.requestId}（`, rest, "）");
    item.append(
      actionButton("show-code", entry.requestId, "比較コードを表示する"),
      " ",
      codeInput(entry.requestId),
      " ",
      actionButton("approve", entry.requestId, "承認する"),
      " ",
      actionButton("reject", entry.requestId, "取り下げる"),
    );
    const stored = pairingViews.get(entry.requestId);
    if (stored !== undefined) {
      const shown = stored.view;
      if (shown.available) {
        const detail = document.createElement("div");
        detail.className = "code";
        const codeRest = document.createElement("span");
        codeRest.id = `code-remain-${entry.requestId}`;
        codeRest.textContent = `残り ${formatRemain(remain(shown.expiresInMs, stored.receivedAt))}`;
        // 表示用の比較コード。本文の記録（ログ）には載せない。
        detail.append(`比較コード: ${shown.displayCode}（`, codeRest, "）");
        item.append(detail);
      } else {
        const detail = document.createElement("div");
        detail.className = "code";
        detail.textContent = `取得できない: ${shown.reason}`;
        item.append(detail);
      }
    }
    list.append(item);
  }
}

/** 接続一覧を描画する。認可段階を表示する。 */
function renderConnections(snapshot: ManagementSnapshot): void {
  const list = document.querySelector<HTMLUListElement>("#connection-list");
  if (!list) {
    return;
  }
  list.replaceChildren();
  if (snapshot.connections.length === 0) {
    const item = document.createElement("li");
    item.textContent = "接続は無い";
    list.append(item);
    return;
  }
  for (const connection of snapshot.connections) {
    const item = document.createElement("li");
    item.append(
      `${connection.connectionId}（${connection.origin}・${connection.authorized ? "認可済み" : "未認可"}・${connection.phase}） `,
      actionButton("disconnect", connection.connectionId, "切断する"),
    );
    list.append(item);
  }
}

/** 生存セッション一覧を描画する。 */
function renderSessions(snapshot: ManagementSnapshot): void {
  const list = document.querySelector<HTMLUListElement>("#session-list");
  if (!list) {
    return;
  }
  list.replaceChildren();
  if (snapshot.sessions.length === 0) {
    const item = document.createElement("li");
    item.textContent = "生存セッションは無い";
    list.append(item);
    return;
  }
  for (const session of snapshot.sessions) {
    const item = document.createElement("li");
    item.append(
      `${session.localSessionId}（論理名 ${session.sessionId}・${session.kind}・${session.direction}・接続 ${session.connectionId}） `,
      actionButton("assign", session.localSessionId, "診断を割り当てる"),
    );
    list.append(item);
  }
}

/** 操作ボタンを作る。識別子は data 属性で渡し、選択子には使わない。 */
function actionButton(action: string, id: string, label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset["action"] = action;
  button.dataset["id"] = id;
  button.textContent = label;
  return button;
}

/** 比較コードの入力欄を作る。入力値はそのまま送り、整形しない。 */
function codeInput(requestId: string): HTMLInputElement {
  const input = document.createElement("input");
  input.id = `code-input-${requestId}`;
  input.type = "text";
  input.maxLength = 6;
  input.placeholder = "比較コード（6桁）";
  input.autocomplete = "off";
  return input;
}

/** 受信した表示状態を revision 規約で採用し、採用時のみ描画する。 */
function adopt(incoming: ManagementSnapshot, via: "getSnapshot" | "stateChanged"): void {
  const previous = current;
  const next = selectNewer(current, incoming);
  current = next;
  if (next !== previous) {
    receivedAt = performance.now();
    // 消えた保留の表示用コードは捨てる（再送基盤は作らない）。
    for (const requestId of pairingViews.keys()) {
      if (!next.pending.some((entry) => entry.requestId === requestId)) {
        pairingViews.delete(requestId);
      }
    }
    console.log(`[bridge-gui] 状態を更新した: via=${via} revision=${next.revision}`);
    appendLog(`更新 via=${via} revision=${next.revision}`);
    render(next);
  } else {
    console.log(
      `[bridge-gui] 古い状態を無視した: via=${via} incoming=${incoming.revision} current=${previous?.revision}`,
    );
    appendLog(`無視 via=${via} incoming=${incoming.revision} current=${previous?.revision}`);
  }
}

/** 残時間の減算表示だけを進める。期限判断は server が行う。 */
function tick(): void {
  const snapshot = current;
  if (snapshot === null) {
    return;
  }
  if (snapshot.admission.accepting) {
    el("admission").textContent =
      `受付中（残り ${formatRemain(remain(snapshot.admission.remainingMs, receivedAt))}）`;
  }
  for (const entry of snapshot.pending) {
    const rest = document.getElementById(`pending-remain-${entry.requestId}`);
    if (rest) {
      rest.textContent = `残り ${formatRemain(remain(entry.expiresInMs, receivedAt))}`;
    }
    const stored = pairingViews.get(entry.requestId);
    if (stored !== undefined) {
      const shown = stored.view;
      if (shown.available) {
        const codeRest = document.getElementById(`code-remain-${entry.requestId}`);
        if (codeRest) {
          codeRest.textContent = `残り ${formatRemain(remain(shown.expiresInMs, stored.receivedAt))}`;
        }
      }
    }
  }
}

const rpc = Electroview.defineRPC<ManagementRpc>({
  handlers: {
    requests: {},
    messages: {
      stateChanged: ({ snapshot }) => {
        adopt(snapshot, "stateChanged");
      },
    },
  },
});

const view = new Electroview({ rpc });

/** 操作後に最新状態を読み直す。履歴・再送基盤は作らない。 */
async function refresh(via: string): Promise<void> {
  try {
    adopt(await rpc.request.getSnapshot({}), "getSnapshot");
  } catch (error: unknown) {
    console.log(`[bridge-gui] ${via}後の再取得に失敗した: ${String(error)}`);
  }
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) {
    return;
  }
  const action = target.dataset["action"];
  const id = target.dataset["id"];
  if (action === undefined || id === undefined) {
    return;
  }
  void handleAction(action, id);
});

/** 画面操作を限定 request として送る。比較コード本文はログに残さない。 */
async function handleAction(action: string, id: string): Promise<void> {
  try {
    switch (action) {
      case "open-acceptance": {
        await rpc.request.openAcceptance({});
        console.log("[bridge-gui] 受付を開いた");
        await refresh("受付を開く");
        break;
      }
      case "close-acceptance": {
        await rpc.request.closeAcceptance({});
        console.log("[bridge-gui] 受付を閉じた");
        await refresh("受付を閉じる");
        break;
      }
      case "show-code": {
        const result: PairingViewResult = await rpc.request.getPairingView({ requestId: id });
        pairingViews.set(id, { view: result, receivedAt: performance.now() });
        console.log(
          result.available
            ? `[bridge-gui] 比較コード表示を取得した: requestId=${id}`
            : `[bridge-gui] 比較コード表示を取得できない: requestId=${id} reason=${result.reason}`,
        );
        if (current !== null) {
          render(current);
        }
        break;
      }
      case "approve": {
        const input = document.getElementById(`code-input-${id}`);
        const code = input instanceof HTMLInputElement ? input.value : "";
        const result = await rpc.request.approvePairing({ requestId: id, code });
        // 成否の符号だけを残す。期限・承認可否は server が決める。
        console.log(`[bridge-gui] 承認の結果: requestId=${id} status=${result.status}`);
        await refresh("承認");
        break;
      }
      case "reject": {
        const result = await rpc.request.rejectPairing({ requestId: id });
        console.log(`[bridge-gui] 取り下げの結果: requestId=${id} status=${result.status}`);
        await refresh("取り下げ");
        break;
      }
      case "disconnect": {
        await rpc.request.disconnectConnection({ connectionId: id });
        console.log(`[bridge-gui] 接続を切断した: connectionId=${id}`);
        await refresh("切断");
        break;
      }
      case "assign": {
        const result = await rpc.request.assignDiagnostics({ localSessionId: id });
        console.log(
          `[bridge-gui] 診断を割り当てた: localSessionId=${id} instanceId=${result.instanceId}`,
        );
        await refresh("診断割当て");
        break;
      }
      case "quit": {
        await rpc.request.quit({});
        console.log("[bridge-gui] アプリの終了を要求した");
        break;
      }
      default: {
        console.log(`[bridge-gui] 未知の操作を無視した: action=${action}`);
        break;
      }
    }
  } catch (error: unknown) {
    console.log(`[bridge-gui] 操作に失敗した: action=${action} ${String(error)}`);
  }
}

// 更新ハンドラ登録後に初回取得し、revision が新しいときだけ採用する。
// 画面再読込みで再取得する（履歴・再送基盤は作らない）。
try {
  adopt(await rpc.request.getSnapshot({}), "getSnapshot");
} catch (error: unknown) {
  console.log(`[bridge-gui] 初回取得・表示に失敗した: ${String(error)}`);
}
try {
  rpc.send.viewReady({ title: document.title });
  console.log("[bridge-gui] 準備完了を通知した");
} catch (error: unknown) {
  console.log(`[bridge-gui] 準備完了の通知に失敗した: ${String(error)}`);
}

setInterval(tick, 500);

void view;
