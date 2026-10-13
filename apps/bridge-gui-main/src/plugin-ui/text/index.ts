/**
 * テキスト子画面。束縛個体の表示と本文送信だけを行う。
 *
 * main が束縛した個体の現割当てを使い、子から識別子を指定しない。
 * 受付・保留・照合・承認・接続断・割当て／解除・終了といった管理操作、
 * 他個体の情報は持たない。状態同期は管理画面と同じ規約（更新ハンドラ登録→
 * 初期取得→最新全状態 push、新しい revision のみ採用）で行う。
 *
 * 本文は入力欄と送信 request にだけ置き、破棄・再生成・再接続で引き継が
 * ない。反映確認で決着した場合だけ入力欄を空にし、結果不明・失敗では
 * 本文を保持する。RPC 自体の失敗は反映確認とみなさず、状態再取得で確かめ、
 * 自動再送しない。暫定フォームへの自動フォールバックは無い。
 */
import { Electroview } from "electrobun/view";
import { validateTextForSend } from "bridge-app-core/text-contract";
import type { TextSendResult } from "bridge-app-core";
import type { TextInstanceRpc, TextInstanceSnapshot } from "./contract.ts";
import { TEXT_MOUNT_KIND } from "./contract.ts";
import {
  PLUGIN_INITIAL_FETCH_ATTEMPTS,
  PLUGIN_INITIAL_FETCH_RETRY_MS,
  TEXT_SEND_REQUEST_TIMEOUT_MS,
  parsePluginMountId,
  pluginMountKindOf,
  selectNewerInstanceSnapshot,
} from "bridge-gui-contract/plugin-instance";

/**
 * 表示欄に短い文を出す。
 *
 * @param id - 要素の識別子。
 * @param value - 表示する文。
 */
function show(id: string, value: string): void {
  const element = document.getElementById(id);
  if (element !== null) {
    element.textContent = value;
  }
}

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
 * 送信の失敗表示を出す。本文は載せない。
 *
 * @param message - 表示する説明。空なら表示を消す。
 */
function setError(message: string): void {
  show("text-error", message);
}

/**
 * 送信本文の入力欄を読む。入力欄の内容は表示更新で消さない。
 *
 * @returns 入力欄の本文。入力欄が無ければ空文字。
 */
function readInput(): string {
  const input = document.getElementById("text-input");
  return input instanceof HTMLTextAreaElement ? input.value : "";
}

/**
 * 反映確認で決着した送信の後に限って入力欄を空にする。
 *
 * 結果不明・失敗では本文を保持し、再送の手がかりを残す。
 */
function clearInput(): void {
  const input = document.getElementById("text-input");
  if (input instanceof HTMLTextAreaElement) {
    input.value = "";
  }
}

/**
 * 操作失敗の説明を作る。本文は含めない（失敗理由だけである）。
 *
 * @param error - 失敗の原因。
 * @returns 表示用の短い説明。
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 自分のマウント識別子。URL 断片から読む（申告では決めない）。
const mountId = parsePluginMountId(window.location.href);

if (mountId === null || pluginMountKindOf(mountId) !== TEXT_MOUNT_KIND) {
  show("text-error", "配置識別子が無いため開始できない。不正な URL である。");
} else {
  // 現在採用中の表示状態。未取得の間は null である。
  let current: TextInstanceSnapshot | null = null;

  /**
   * 採用中の束縛個体の表示を画面に反映する。入力欄の内容には触れない。
   *
   * 直近結果の「反映確認」はワールドの表示用状態に反映した意味であり、
   * 送信完了や描画完了の保証ではない。
   *
   * @param snapshot - 採用中の表示状態。
   */
  function render(snapshot: TextInstanceSnapshot): void {
    show("text-assignment", `${snapshot.localSessionId}（instanceId ${snapshot.instanceId}）`);
    if (snapshot.pendingId !== null) {
      show("text-status", `実行中（応答待ち id=${snapshot.pendingId}）`);
    } else if (snapshot.canSend) {
      show("text-status", "送信可能");
    } else {
      show("text-status", "送信不可");
    }
    const last = snapshot.lastResult;
    if (last === null) {
      show("text-result", "まだ送信していない");
    } else if (last.status === "acknowledged") {
      show(
        "text-result",
        "反映確認（ワールドの表示用状態に反映した・送信完了や描画完了の意味ではない）",
      );
    } else {
      show(
        "text-result",
        `結果不明（理由: ${describeUnknownReason(last.reason)}・表示用状態への反映を確認できない）`,
      );
    }
    show(
      "text-stats",
      `送信試行 ${snapshot.stats.attempts}・反映確認 ${snapshot.stats.acknowledged}・結果不明 ${snapshot.stats.unknown}`,
    );
    show("text-revision", String(snapshot.revision));
    const sendButton = document.getElementById("text-send");
    if (sendButton instanceof HTMLButtonElement) {
      sendButton.disabled = !snapshot.canSend;
    }
  }

  /** 受信した表示状態を revision 規約で採用し、採用時のみ描画する。 */
  function adopt(incoming: TextInstanceSnapshot): void {
    const next = selectNewerInstanceSnapshot(current, incoming);
    if (next !== current) {
      current = next;
      console.log(`[bridge-gui] 状態を更新した: revision=${next.revision}`);
      render(next);
    } else {
      console.log(`[bridge-gui] 古い状態を無視した: incoming=${incoming.revision}`);
    }
  }

  const rpc = Electroview.defineRPC<TextInstanceRpc>({
    handlers: {
      requests: {},
      messages: {
        textStateChanged: (message) => {
          adopt(message.snapshot);
        },
      },
    },
  });

  const view = new Electroview({ rpc });

  /** 最新状態を読み直す。履歴・再送基盤は作らない。 */
  async function refresh(via: string): Promise<void> {
    try {
      adopt(await rpc.request.getTextState({}));
    } catch (error: unknown) {
      console.log(`[bridge-gui] ${via}後の再取得に失敗した: ${String(error)}`);
    }
  }

  /** 本文を束縛個体の現割当てへ送る。割当て識別子の指定はしない。 */
  async function sendCurrentText(): Promise<void> {
    const snapshot = current;
    if (snapshot === null) {
      setError("状態を取得してから送ること。");
      return;
    }
    if (!snapshot.canSend) {
      setError(
        snapshot.pendingId !== null
          ? "送信中のため待つこと。応答待ちが終わってから送ること。"
          : "送信できない状態である。管理画面の割当てを確認すること。",
      );
      return;
    }
    const validated = validateTextForSend(readInput());
    if (!validated.ok) {
      const reason =
        validated.reason === "empty"
          ? "本文が空のため送信しない。"
          : validated.reason === "too-long"
            ? "本文が長すぎるため送信しない（上限 512 文字・改行可）。"
            : "本文が文字列でないため送信しない。";
      console.log(`[bridge-gui] テキスト送信を送信前に拒否した: reason=${validated.reason}`);
      setError(reason);
      return;
    }
    // ADR: 同期的な `RangeError`（束縛外・失効）と `Promise` の拒否を区別する
    // ため、要求の発行と待機を分けて扱う。本文は要求にだけ載せ、記録には残さない。
    // 待機期限はプラグインの応答期限（10秒）より長くし、反映確認の到達を
    // RPC 側の期限切れで落とさない。
    let flight: Promise<TextSendResult>;
    try {
      flight = rpc.request.sendText(
        { text: validated.text },
        { maxRequestTime: TEXT_SEND_REQUEST_TIMEOUT_MS },
      );
    } catch (error: unknown) {
      console.log(`[bridge-gui] テキスト送信を拒否した: ${String(error)}`);
      setError(`送信できない: ${describeError(error)}`);
      return;
    }
    try {
      const result = await flight;
      if (result.status === "acknowledged") {
        console.log("[bridge-gui] テキスト送信が反映確認で決着した");
        setError("");
        clearInput();
      } else {
        console.log(`[bridge-gui] テキスト送信が結果不明で決着した: reason=${result.reason}`);
        setError(
          `結果不明で決着した（理由: ${describeUnknownReason(result.reason)}）。本文は保持する。`,
        );
      }
    } catch (error: unknown) {
      // ADR: RPC 自体の失敗（期限超過・切断）は反映確認ではない。自動再送せず、
      // 状態再取得で確かめる。暫定フォームへの自動フォールバックは無い。
      console.log(`[bridge-gui] テキスト送信に失敗した: ${String(error)}`);
      setError(`送信に失敗した: ${describeError(error)}`);
    }
    await refresh("テキスト送信");
  }

  document.getElementById("text-send")?.addEventListener("click", () => {
    void sendCurrentText();
  });

  try {
    // 更新ハンドラ登録後に初回取得し、revision が新しいときだけ採用する。
    // ADR: 初回同期の到達保証のため bounded に再試行する。子画面側の接続確立や
    // 主処理の混雑で RPC の既定待機に間に合わない場合に備える。使い果たしたら
    // 子画面に残し、main 側の準備完了待ちの期限超過に任せる。自動再送はしない。
    let fetched = false;
    for (let attempt = 1; attempt <= PLUGIN_INITIAL_FETCH_ATTEMPTS; attempt += 1) {
      try {
        adopt(await rpc.request.getTextState({}));
        fetched = true;
        break;
      } catch (error: unknown) {
        console.log(`[bridge-gui] 初回取得に失敗した（${attempt}回目）: ${String(error)}`);
        if (attempt < PLUGIN_INITIAL_FETCH_ATTEMPTS) {
          await new Promise((resolve) => {
            setTimeout(resolve, PLUGIN_INITIAL_FETCH_RETRY_MS);
          });
        }
      }
    }
    if (!fetched) {
      show("text-error", "初期取得に失敗した。管理画面の割当てを確認すること。");
    }
  } catch (error: unknown) {
    console.log(`[bridge-gui] 初回取得・表示に失敗した: ${String(error)}`);
    show("text-error", "初期取得に失敗した。管理画面の割当てを確認すること。");
  }

  void view;
}
