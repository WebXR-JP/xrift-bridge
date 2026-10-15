/**
 * UDP子画面。束縛個体の bind 開始・停止と状態表示だけを行う。
 *
 * main が束縛した個体の現割当てを使い、子から識別子を指定しない。
 * 受付・保留・照合・承認・接続断・割当て／解除・終了といった管理操作、
 * 他個体の情報は持たない。状態同期は管理画面と同じ規約（更新ハンドラ登録→
 * 初期取得→最新全状態 push、新しい revision のみ採用）で行う。
 *
 * 受信 payload の本文は表示しない（統計だけを見る）。bind 設定は入力欄に
 * だけ置き、破棄・再生成・再接続で引き継がない。開始・停止の失敗では入力を
 * 保持し、自動再送しない。RPC 自体の失敗は開始・停止の成否とみなさず、
 * 状態再取得で確かめる。暫定フォームへの自動フォールバックは無い。
 */
import { Electroview } from "electrobun/view";
import { isIPv4LiteralAddress, isIPv6LiteralAddress, isLoopbackAddress } from "../contract.ts";
import type { UdpControlResult, UdpPhase } from "../plugin.ts";
import type { UdpInstanceRpc, UdpInstanceSnapshot } from "../gui-contract.ts";
import { UDP_MOUNT_KIND, UDP_SEND_REQUEST_TIMEOUT_MS } from "../gui-contract.ts";
import {
  PLUGIN_INITIAL_FETCH_ATTEMPTS,
  PLUGIN_INITIAL_FETCH_RETRY_MS,
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
 * 段階を人間向けの短い説明にする。
 *
 * @param phase - UDP インスタンスの段階。
 * @returns 表示用の短い説明。
 */
function describePhase(phase: UdpPhase): string {
  if (phase === "unassigned") return "未割当て";
  if (phase === "stopped") return "停止中";
  if (phase === "starting") return "開始中";
  if (phase === "running") return "受信中";
  if (phase === "stopping") return "停止中（閉塞中）";
  if (phase === "error") return "bind 失敗";
  return "破棄済み";
}

/**
 * 開始・停止の失敗理由を人間向けの短い説明にする。
 *
 * @param result - 失敗で確定した制御結果。
 * @returns 表示用の短い説明。
 */
function describeControlFailure(result: Extract<UdpControlResult, { ok: false }>): string {
  if (result.reason === "invalid-config") return `設定が不正である: ${result.message}`;
  if (result.reason === "confirmation-required") {
    return "非 loopback のため確認が必要である（チェックを入れて再試行すること）。";
  }
  if (result.reason === "busy") return "操作中である。終わってから再試行すること。";
  if (result.reason === "bind-failed") return `bind に失敗した: ${result.message}`;
  return `取り消された: ${result.message}`;
}

/**
 * 操作失敗の説明を作る。本文・バイト列は含めない（失敗理由だけである）。
 *
 * @param error - 失敗の原因。
 * @returns 表示用の短い説明。
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 入力欄の bind 設定を読む。
 *
 * @returns bind 設定。空・不正があれば `null`。
 */
function readBindInput(): { address: string; port: number } | null {
  const addressElement = document.getElementById("udp-address");
  const portElement = document.getElementById("udp-port");
  const address = addressElement instanceof HTMLInputElement ? addressElement.value.trim() : "";
  const portText = portElement instanceof HTMLInputElement ? portElement.value.trim() : "";
  if (address === "" || portText === "") return null;
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { address, port };
}

/**
 * 非 loopback 確認のチェック欄を読む。
 *
 * @returns チェックされていれば真。
 */
function readAllowNonLoopback(): boolean {
  const check = document.getElementById("udp-allow-non-loopback");
  return check instanceof HTMLInputElement && check.checked;
}

/**
 * 非 loopback 入力の警告を更新する。開始の可否は変えない。
 *
 * 有効な数値リテラルの非 loopback のみ注意喚起する。不正入力の拒否は本体の
 * `invalid-config` が担う。
 */
function refreshNonLoopbackWarning(): void {
  const addressElement = document.getElementById("udp-address");
  const address = addressElement instanceof HTMLInputElement ? addressElement.value.trim() : "";
  const isNumericLiteral = isIPv4LiteralAddress(address) || isIPv6LiteralAddress(address);
  if (address !== "" && isNumericLiteral && !isLoopbackAddress(address)) {
    show(
      "udp-warn",
      "外部から到達し得るアドレスである。開始には非 loopback の確認（チェック）が必要である。",
    );
  } else {
    show("udp-warn", "");
  }
}

// 自分のマウント識別子。URL 断片から読む（申告では決めない）。
const mountId = parsePluginMountId(window.location.href);

if (mountId === null || pluginMountKindOf(mountId) !== UDP_MOUNT_KIND) {
  show("udp-error", "配置識別子が無いため開始できない。不正な URL である。");
} else {
  // 現在採用中の表示状態。未取得の間は null である。
  let current: UdpInstanceSnapshot | null = null;

  /**
   * 採用中の束縛個体の表示を画面に反映する。入力欄の内容には触れない。
   *
   * payload 本文は表示せず、統計だけを見る。
   *
   * @param snapshot - 採用中の表示状態。
   */
  function render(snapshot: UdpInstanceSnapshot): void {
    show("udp-assignment", `${snapshot.localSessionId}（instanceId ${snapshot.instanceId}）`);
    show("udp-status", describePhase(snapshot.phase));
    if (snapshot.boundAddress === null) {
      const requested = snapshot.requestedBind;
      show(
        "udp-bound",
        requested === null ? "未開始" : `未待受け（要求: ${requested.address}:${requested.port}）`,
      );
    } else {
      const bound = snapshot.boundAddress;
      show("udp-bound", `${bound.address}:${bound.port}（${bound.family}）`);
    }
    const stats = snapshot.stats;
    show(
      "udp-stats",
      `受信 ${stats.receivedDatagrams} 件・${stats.receivedBytes}B・転送完了 ${stats.forwardedDatagrams} 件・${stats.forwardedBytes}B・破棄（上限 ${stats.droppedOversize}・送信中 ${stats.droppedBusy}・送信元不正 ${stats.droppedInvalidMetadata}）・送信失敗 ${stats.sendFailures}`,
    );
    show("udp-lasterror", snapshot.lastError ?? "なし");
    show("udp-revision", String(snapshot.revision));
    const startButton = document.getElementById("udp-start");
    if (startButton instanceof HTMLButtonElement) {
      startButton.disabled = !snapshot.canStart;
    }
    const stopButton = document.getElementById("udp-stop");
    if (stopButton instanceof HTMLButtonElement) {
      stopButton.disabled =
        snapshot.phase === "stopped" ||
        snapshot.phase === "unassigned" ||
        snapshot.phase === "disposed";
    }
  }

  /** 受信した表示状態を revision 規約で採用し、採用時のみ描画する。 */
  function adopt(incoming: UdpInstanceSnapshot): void {
    const next = selectNewerInstanceSnapshot(current, incoming);
    if (next !== current) {
      current = next;
      console.log(`[bridge-gui] 状態を更新した: revision=${next.revision}`);
      render(next);
    } else {
      console.log(`[bridge-gui] 古い状態を無視した: incoming=${incoming.revision}`);
    }
  }

  const rpc = Electroview.defineRPC<UdpInstanceRpc>({
    handlers: {
      requests: {},
      messages: {
        udpStateChanged: (message) => {
          adopt(message.snapshot);
        },
      },
    },
  });

  const view = new Electroview({ rpc });

  /** 最新状態を読み直す。履歴・再送基盤は作らない。 */
  async function refresh(via: string): Promise<void> {
    try {
      adopt(await rpc.request.getUdpState({}));
    } catch (error: unknown) {
      console.log(`[bridge-gui] ${via}後の再取得に失敗した: ${String(error)}`);
    }
  }

  /**
   * 操作失敗の表示を出す。空なら表示を消す。
   *
   * @param message - 表示する説明。
   */
  function setError(message: string): void {
    show("udp-error", message);
  }

  /** 入力欄の bind 設定で束縛個体の UDP 受信を開始する。識別子の指定はしない。 */
  async function startCurrentBind(): Promise<void> {
    const snapshot = current;
    if (snapshot === null) {
      setError("状態を取得してから開始すること。");
      return;
    }
    if (!snapshot.canStart) {
      setError("開始できない状態である。管理画面の割当てを確認すること。");
      return;
    }
    const bind = readBindInput();
    if (bind === null) {
      setError("待受けアドレス・ポートが不正である（数値リテラル・1..65535）。");
      return;
    }
    // ADR: 同期的な `RangeError`（束縛外・失効）と `Promise` の解決（理由付きの
    // 成否）を区別するため、要求の発行と待機を分けて扱う。待機期限は手元の
    // bind・閉塞完了待ちに見合う範囲とし、自動再送はしない。
    let flight: Promise<UdpControlResult>;
    try {
      flight = rpc.request.startUdp(
        { bind, allowNonLoopback: readAllowNonLoopback() },
        { maxRequestTime: UDP_SEND_REQUEST_TIMEOUT_MS },
      );
    } catch (error: unknown) {
      console.log(`[bridge-gui] UDP開始を拒否した: ${String(error)}`);
      setError(`開始できない: ${describeError(error)}`);
      return;
    }
    try {
      const result = await flight;
      if (result.ok) {
        console.log("[bridge-gui] UDP受信を開始した");
        setError("");
      } else {
        console.log(`[bridge-gui] UDP開始が失敗で確定した: reason=${result.reason}`);
        setError(describeControlFailure(result));
      }
    } catch (error: unknown) {
      // ADR: RPC 自体の失敗（期限超過・切断）は開始の成否ではない。自動再送せず、
      // 状態再取得で確かめる。暫定フォームへの自動フォールバックは無い。
      console.log(`[bridge-gui] UDP開始に失敗した: ${String(error)}`);
      setError(`開始に失敗した: ${describeError(error)}`);
    }
    await refresh("UDP開始");
  }

  /** 束縛個体の UDP 受信を停止する。識別子の指定はしない。 */
  async function stopCurrentBind(): Promise<void> {
    if (current === null) {
      setError("状態を取得してから停止すること。");
      return;
    }
    let flight: Promise<UdpControlResult>;
    try {
      flight = rpc.request.stopUdp({}, { maxRequestTime: UDP_SEND_REQUEST_TIMEOUT_MS });
    } catch (error: unknown) {
      console.log(`[bridge-gui] UDP停止を拒否した: ${String(error)}`);
      setError(`停止できない: ${describeError(error)}`);
      return;
    }
    try {
      const result = await flight;
      if (result.ok) {
        console.log("[bridge-gui] UDP受信を停止した");
        setError("");
      } else {
        console.log(`[bridge-gui] UDP停止が失敗で確定した: reason=${result.reason}`);
        setError(describeControlFailure(result));
      }
    } catch (error: unknown) {
      console.log(`[bridge-gui] UDP停止に失敗した: ${String(error)}`);
      setError(`停止に失敗した: ${describeError(error)}`);
    }
    await refresh("UDP停止");
  }

  document.getElementById("udp-start")?.addEventListener("click", () => {
    void startCurrentBind();
  });
  document.getElementById("udp-stop")?.addEventListener("click", () => {
    void stopCurrentBind();
  });
  document.getElementById("udp-address")?.addEventListener("input", () => {
    refreshNonLoopbackWarning();
  });
  refreshNonLoopbackWarning();

  try {
    // 更新ハンドラ登録後に初回取得し、revision が新しいときだけ採用する。
    // ADR: 初回同期の到達保証のため bounded に再試行する。子画面側の接続確立や
    // 主処理の混雑で RPC の既定待機に間に合わない場合に備える。使い果たしたら
    // 子画面に残し、main 側の準備完了待ちの期限超過に任せる。自動再送はしない。
    let fetched = false;
    for (let attempt = 1; attempt <= PLUGIN_INITIAL_FETCH_ATTEMPTS; attempt += 1) {
      try {
        const initial = await rpc.request.getUdpState({});
        adopt(initial);
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
      show("udp-error", "初期取得に失敗した。管理画面の割当てを確認すること。");
    }
  } catch (error: unknown) {
    console.log(`[bridge-gui] 初回取得・表示に失敗した: ${String(error)}`);
    show("udp-error", "初期取得に失敗した。管理画面の割当てを確認すること。");
  }

  void view;
}
