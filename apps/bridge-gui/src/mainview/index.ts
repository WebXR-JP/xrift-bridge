import { Electroview } from "electrobun/view";
import type { TextSendResult } from "bridge-app-core";
import { TEXT_SESSION_ID, validateTextForSend } from "bridge-app-core/text-contract";
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
  renderText(snapshot);
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
    );
    // テキスト表示用セッションは診断割当ての対象外であり、割当て操作を受け付けない。
    if (session.sessionId === TEXT_SESSION_ID) {
      const note = document.createElement("span");
      note.textContent = "診断対象外";
      item.append(note);
    } else {
      item.append(actionButton("assign", session.localSessionId, "診断を割り当てる"));
    }
    list.append(item);
  }
}

// ---- 固定テキスト送信（この節はテキスト送信カード内に閉じる） ----

/**
 * 結果不明の理由を人間向けの短い説明にする。
 *
 * 識別子そのままでは伝わらないため、応答期限切れ・切断・破棄を書き分ける。
 * 未知の理由はそのまま載せ、落とさない。
 *
 * @param reason - 結果不明の理由。
 * @returns 表示用の短い説明。
 */
function describeUnknownReason(reason: string): string {
  if (reason === "timeout") {
    return "応答期限切れ";
  }
  if (reason === "disconnected") {
    return "切断";
  }
  if (reason === "disposed") {
    return "破棄";
  }
  return reason;
}

/**
 * テキスト送信の失敗表示を出す。本文は載せない。
 *
 * @param message - 表示する説明。空なら表示を消す。
 */
function setTextError(message: string): void {
  const slot = document.getElementById("text-error");
  if (slot !== null) {
    slot.textContent = message;
  }
}

/**
 * 送信本文の入力欄を読む。入力欄の内容は表示更新で消さない。
 *
 * @returns 入力欄の本文。入力欄が無ければ空文字。
 */
function readTextInput(): string {
  const input = document.getElementById("text-input");
  return input instanceof HTMLTextAreaElement ? input.value : "";
}

/**
 * 反映確認で決着した送信の後に限って入力欄を空にする。
 *
 * 結果不明・失敗では本文を保持し、再送の手がかりを残す。
 */
function clearTextInput(): void {
  const input = document.getElementById("text-input");
  if (input instanceof HTMLTextAreaElement) {
    input.value = "";
  }
}

/** 操作失敗の説明を作る。本文は含めない（失敗理由だけである）。 */
function describeActionError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 固定テキスト送信カードを描画する。入力欄の内容には触れない。
 *
 * 割当て先・送信可能／実行中・直近結果・統計を示し、未割当て・送信中は
 * 送信ボタンを無効化する。直近結果の「反映確認」はワールドの表示用状態に
 * 反映した意味であり、送信完了や描画完了の保証ではない。
 *
 * @param snapshot - 採用中の表示状態。
 */
function renderText(snapshot: ManagementSnapshot): void {
  const text = snapshot.text;
  const assigned = text.localSessionId !== null && text.instanceId !== null;
  el("text-assignment").textContent = assigned
    ? `${text.localSessionId}（instanceId ${text.instanceId}）`
    : "未割当て";
  if (!assigned) {
    el("text-status").textContent = "未割当て";
  } else if (text.pendingId !== null) {
    el("text-status").textContent = `実行中（応答待ち id=${text.pendingId}）`;
  } else if (text.canSend) {
    el("text-status").textContent = "送信可能";
  } else {
    el("text-status").textContent = "送信不可";
  }
  const last = text.lastResult;
  if (last === null) {
    el("text-result").textContent = "まだ送信していない";
  } else if (last.status === "acknowledged") {
    el("text-result").textContent =
      "反映確認（ワールドの表示用状態に反映した・送信完了や描画完了の意味ではない）";
  } else {
    el("text-result").textContent =
      `結果不明（理由: ${describeUnknownReason(last.reason)}・表示用状態への反映を確認できない）`;
  }
  el("text-stats").textContent =
    `送信試行 ${text.stats.attempts}・反映確認 ${text.stats.acknowledged}・結果不明 ${text.stats.unknown}`;
  const assignButton = document.querySelector<HTMLButtonElement>(
    'button[data-action="assign-text"]',
  );
  if (assignButton !== null) {
    assignButton.disabled = assigned;
  }
  const unassignButton = document.querySelector<HTMLButtonElement>(
    'button[data-action="unassign-text"]',
  );
  if (unassignButton !== null) {
    unassignButton.disabled = !assigned;
  }
  const sendButton = document.querySelector<HTMLButtonElement>('button[data-action="send-text"]');
  if (sendButton !== null) {
    sendButton.disabled = !text.canSend;
  }
}

// ---- 固定テキスト送信の節ここまで ----

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
  if (action === undefined) {
    return;
  }
  // ADR: 識別子が不要な操作（受付の開閉・終了）もあるため `data-id` は
  // 必須にしない。必要な操作だけが `handleAction` 内で `id` を使う。
  const id = target.dataset["id"] ?? "";
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
      case "assign-text": {
        const result = await rpc.request.assignText({});
        console.log(
          `[bridge-gui] テキストを割り当てた: localSessionId=${result.localSessionId} instanceId=${result.instanceId}`,
        );
        setTextError("");
        await refresh("テキスト割当て");
        break;
      }
      case "unassign-text": {
        await rpc.request.unassignText({});
        console.log("[bridge-gui] テキストの割当てを外した");
        setTextError("");
        await refresh("テキスト割当て解除");
        break;
      }
      case "send-text": {
        const snapshot = current;
        const assignedLocal = snapshot?.text.localSessionId ?? null;
        const assignedInstance = snapshot?.text.instanceId ?? null;
        if (assignedLocal === null || assignedInstance === null) {
          setTextError("未割当てのため送信できない。先にテキストを割り当てること。");
          break;
        }
        // 未取得・未割当ては上で弾くため、ここでは応答待ちの有無だけを見る。
        const pendingId = snapshot?.text.pendingId ?? null;
        if (pendingId !== null) {
          setTextError("送信中のため待つこと。応答待ちが終わってから送ること。");
          break;
        }
        const validated = validateTextForSend(readTextInput());
        if (!validated.ok) {
          const reason =
            validated.reason === "empty"
              ? "本文が空のため送信しない。"
              : validated.reason === "too-long"
                ? "本文が長すぎるため送信しない（上限 512 文字・改行可）。"
                : "本文が文字列でないため送信しない。";
          console.log(`[bridge-gui] テキスト送信を送信前に拒否した: reason=${validated.reason}`);
          setTextError(reason);
          break;
        }
        // ADR: 同期的な `RangeError`（未割当て・識別子不一致・入力不正）と
        // `Promise` の拒否（同時実行等）を区別するため、要求の発行と待機を
        // 分けて扱う。本文は要求にだけ載せ、記録には残さない。
        let flight: Promise<TextSendResult>;
        try {
          flight = rpc.request.sendText({
            localSessionId: assignedLocal,
            instanceId: assignedInstance,
            text: validated.text,
          });
        } catch (error: unknown) {
          console.log(`[bridge-gui] テキスト送信を拒否した: ${String(error)}`);
          setTextError(`送信できない: ${describeActionError(error)}`);
          break;
        }
        try {
          const result = await flight;
          if (result.status === "acknowledged") {
            console.log("[bridge-gui] テキスト送信が反映確認で決着した");
            setTextError("");
            clearTextInput();
          } else {
            console.log(`[bridge-gui] テキスト送信が結果不明で決着した: reason=${result.reason}`);
            setTextError(
              `結果不明で決着した（理由: ${describeUnknownReason(result.reason)}）。本文は保持する。`,
            );
          }
        } catch (error: unknown) {
          console.log(`[bridge-gui] テキスト送信に失敗した: ${String(error)}`);
          setTextError(`送信に失敗した: ${describeActionError(error)}`);
        }
        await refresh("テキスト送信");
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
    // テキスト操作の失敗は状態表示にも残す。本文は含めない（失敗理由だけである）。
    if (action === "assign-text" || action === "unassign-text" || action === "send-text") {
      setTextError(`操作に失敗した: ${describeActionError(error)}`);
    }
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
