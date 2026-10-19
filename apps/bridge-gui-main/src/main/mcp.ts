/**
 * 製品向けローカル業務操作 MCP（loopback 待受け）。
 *
 * Bun main 上で完結する製品用の待受であり、別プロセスは要らない。
 * クライアント→loopback 待受け→Bun main→既存操作（`GuiBackend`）の経路で
 * 状態を持たない要求/応答だけを扱う。購読・イベント再送・永続セッション・
 * ジョブ履歴は作らない。JSON-RPC や進捗管理を自作しない。
 *
 * ADR: 開発用の接続口への相乗りを選ばない理由は、stable で開いてはいけない
 * 経路との条件管理が複雑になるためである。製品用に独立の入口を持ち、
 * 起動ゲート・待受けを分ける。`Origin` の扱いを含む境界の条件は
 * 製品向けの口ごとに定め、ここでは非ブラウザのクライアントを前提として
 * `Origin` の欠落だけを許可する（`Origin: null` を含むブラウザ由来は拒否）。
 *
 * ADR: 有効条件は実行時の環境変数（`BRIDGE_GUI_MCP=1`）または管理画面の
 * 設定操作であり、ビルドチャンネルを問わない（stable を含む）。既定は無効であり、
 * 有効状態を次回起動へ保存しない。
 * 開発用の接続口のゲート・待受けとは混ぜない。
 *
 * ADR: 製品向けの口はクライアント認証を要求しない。有効化中は、到達した
 * ローカルプロセスが固定の許可操作を利用できる。開く範囲を広げる代わり、
 * 利用できるのは固定の許可操作に限り、承認・任意コード・アプリ終了・通信本文の
 * 取得は含めない。接続先 URL に資格情報は含めない。
 * 開発用の接続口の認証と stable での非公開は変更しない。
 *
 * ADR: 要求ごとに `McpServer` と Web Standard transport を新しく結線する
 * （状態を持たない要求/応答のみ。公式の stateless 構成と同じ形）。
 * 工具の登録は SDK の高水準 API（`registerTool`）で行い、工具の一覧広告と
 * 実行子の入力検証は main の同じ zod schema 定義から出す。射影は共有契約
 * （`bridge-gui-contract/local-ops`）の純粋な定義に、実行は `GuiBackend` の
 * 既存操作への委譲（`./local-ops.ts`）に寄せる。工具は9件の固定 allowlist
 * であり、任意の関数名や任意コードを受け付けない。業務 logic を MCP 側に
 * 書かず、`quit`・承認は実行しない（承認の要求には人間の GUI 操作を要する
 * 定型応答を返す）。
 *
 * ADR: 例外内容・入力文字列の応答混入は外向けの応答境界で塞ぐ。工具の処理は
 * 例外を投げず定型の失敗結果に落とすが、SDK 内部で生成される失敗（未知の
 * 工具名・引数検証・要求外形・不正 JSON・未知メソッド・本文サイズ超過）は
 * 実行子より前に起きるため、transport が返した応答を
 * `normalizeMcpFailureResponse` で正規化する。JSON-RPC の `error` は
 * `code` だけを残して文言・付帯を落とす。工具結果に失敗表示があるものは
 * 定型の失敗結果に再構成し（余分な項目・非真偽値の表示も残さない）、
 * 成功応答は変えない。SDK の `allowedOrigins`
 * 検証は要求の `Origin` を応答文に写すため使わず、自前の検査で定型文だけを
 * 返す。
 *
 * ADR: 初版は状態を持たない単一の要求/応答のみを扱い、JSON-RPC のバッチ
 * 要求（配列）は受け付けない（一次防御：transport へ渡す前に拒否する）。
 * 万一配列応答が返っても漏らさないための保険として、要素ごとの正規化を
 * 持つ（多重防御）。要素ごとに正規化する案を「受付」に採らないのは、
 * 配列の形状判定・要素ごとの対応付け・部分失敗の意味付けと境界の監査面を
 * 増やすためであり、正規化の保険と混同しない。
 *
 * @packageDocumentation
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { LOCAL_KNOWN_OPS } from "bridge-gui-contract/local-ops";
import type { LocalMcpStatus } from "bridge-gui-contract/management";
import type { GuiBackend } from "./backend.ts";
import { executeLocalTool, LOCAL_TOOL_DESCRIPTIONS, LOCAL_TOOL_SCHEMAS } from "./local-ops.ts";

/** 製品向け MCP の明示 opt-in の環境変数。実行単位の有効化の入口である。 */
export const MCP_OPT_IN_ENV = "BRIDGE_GUI_MCP";

/** 製品向け MCP の束縛先。loopback のみであり、外部には開かない。 */
export const MCP_HOST = "127.0.0.1";

/** 要求本文の上限（バイト。開発用の接続口と同値）。 */
export const MCP_MAX_BODY_BYTES = 64 * 1024;

/** 要求1件の処理期限（ミリ秒。開発用の接続口と同値）。超過時は定型応答に落とす。 */
export const MCP_OP_TIMEOUT_MS = 10_000;

/** 工具実行の失敗の定型文。例外内容・秘密は載せない。 */
export const MCP_TOOL_FAILURE = "操作に失敗した。";

/** 要求の失敗の定型文。入力文字列・例外本文・検証詳細は載せない。 */
export const MCP_REQUEST_INVALID = "要求が不正である。";

/** 未対応の方式の定型文。本文・秘密は載せない。 */
export const MCP_METHOD_NOT_ALLOWED = "GET には対応していない。";

/** 待受け個体の受付が失効している場合の定型文。本文・秘密は載せない。 */
export const MCP_NOT_ACCEPTING = "操作を受け付けていない。";

/** 要求処理の期限切れの定型文。本文・秘密は載せない。 */
export const MCP_OP_TIMEOUT_ERROR = "操作の期限が切れた。";

/** 製品向け MCP の待受。終了時は必ず閉じる。 */
export interface ProductMcp {
  /** 待ち受け中のポート番号。 */
  readonly port: number;
  /**
   * 待受を閉じる。冪等であり、成功後は二重に閉じない。
   *
   * 停止に失敗しても例外にせず、再試行できるよう偽を返す。
   * 受付の失効は成功の有無にかかわらず一度きりである。
   *
   * @returns 停止に成功した場合に真。
   */
  readonly close: () => Promise<boolean>;
}

/**
 * 製品向け MCP を開いてよいか実行時の引数から判定する。
 *
 * ビルドチャンネルを問わず、明示 opt-in（`BRIDGE_GUI_MCP=1`）の場合だけ真である。
 * 既定は無効であり、未設定・空・`1` 以外では開かない。
 *
 * @returns 開いてよい場合に真。
 */
export function shouldStartMcp(): boolean {
  return process.env[MCP_OPT_IN_ENV] === "1";
}

/**
 * `Host` 頭が待受け中の実ポートと完全一致するか判定する。
 *
 * 主部の抜き出しはしない。`127.0.0.1:<実ポート>` と一文字も違わず一致する
 * 場合だけ真である（開発用接続口の `checkDevHost` より厳しい）。
 *
 * @param host - `Host` 頭の値。欠けている場合は `null`。
 * @param port - 待ち受け中の実ポート。
 * @returns 完全一致する場合に真。
 */
export function checkMcpHost(host: string | null, port: number): boolean {
  if (host === null || !Number.isInteger(port) || port < 0 || port > 65535) {
    return false;
  }
  return host.toLowerCase() === `127.0.0.1:${port}`;
}

/**
 * `Origin` 頭が欠落しているか判定する。
 *
 * ヘッダーが存在する要求は値にかかわらず拒否し、欠落だけを許可する。
 * 空文字列であっても拒否する。非ブラウザのクライアントを前提とするため、
 * 空の `Origin` を送るクライアントは拒否される（送らないこと）。
 * ブラウザ向け CORS 頭は応答に載せない。
 *
 * @param origin - `Origin` 頭の値。欠けている場合は `null`。
 * @returns 欠落している場合に真。
 */
export function checkMcpOrigin(origin: string | null): boolean {
  return origin === null;
}

/**
 * 接続元が loopback か判定する。
 *
 * @param address - 接続元アドレス。欠けている場合は `null`。
 * @returns loopback（`127.0.0.1`・`::1`・写像形）の場合に真。
 */
export function isMcpLoopbackAddress(address: string | null | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/**
 * 工具の失敗結果の定型（再構成の正本）。
 *
 * 工具実行子が返す失敗と、正規化が返す失敗はいずれもこの形である。
 * `content` は定型文の `text` 1件のみ、`isError` は真偽値 `true` であり、
 * 余分な項目は持たない。工具実行子は例外を投げずこの定型結果を返す。
 *
 * @returns 失敗の工具結果。
 */
export function mcpToolFailure(): CallToolResult {
  return {
    content: [{ type: "text", text: MCP_TOOL_FAILURE }],
    isError: true,
  };
}

// ADR: `as` で object の包含を主張する理由は、呼び出し側で `typeof`・`null`
// 検査を済ませており、項目の読取りだけを行うためである。項目の中身の
// 検証（数値・真偽・配列）は各分岐で行い、主張に頼らない。
const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

/**
 * JSON-RPC の応答1件分を正規化する（単一応答・配列要素の共通規則）。
 *
 * 残すもの：要求との対応付けの `id`・JSON-RPC の `error.code`・成功の結果
 * （失敗表示の無いもの）。落とすもの：`error.message`・`error.data`
 * （入力文字列・例外本文・検証詳細の混入があり得る）。工具結果の失敗表示が
 * あるものは、本文・余分な項目・表示の値にかかわらず定型の失敗結果に
 * 再構成する。
 *
 * 配列応答への適用は、バッチ要求の受付拒否が何らかの経路で破れた場合の
 * 保険であり、多重防御である（一次防御は transport へ渡す前の拒否）。
 *
 * @param table - 解釈済みの応答オブジェクト。
 * @returns 正規化した応答オブジェクト。
 */
function normalizeJsonRpcPayload(table: Record<string, unknown>): unknown {
  const failure = asRecord(table["error"]);
  if (failure !== null && typeof failure["code"] === "number") {
    // JSON-RPC の失敗。`code` は残し、文言・付帯は落とす。
    // `id` は要求との対応付けに要るため残す（対応付けの識別子であり本文ではない）。
    return {
      jsonrpc: "2.0",
      id: table["id"] ?? null,
      error: { code: failure["code"], message: MCP_REQUEST_INVALID },
    };
  }
  const result = asRecord(table["result"]);
  if (result !== null && "isError" in result && result["isError"] !== false) {
    // 工具の失敗は定型の失敗結果に再構成する。本文・余分な項目・表示の値を
    // 問わず、失敗表示があるものはすべてこの形に落とす。`isError` が無い・
    // 偽の場合は成功として通す。
    return { jsonrpc: "2.0", id: table["id"] ?? null, result: mcpToolFailure() };
  }
  return table;
}

/**
 * SDK が生成した失敗応答を正規化する（外向けの応答境界）。
 *
 * 実行子の `try/catch` より前（SDK 内部）で起きる失敗は、入力文字列・例外
 * 本位・検証詳細を応答文に反射する（未登録の工具名・非対応の protocol 版・
 * 形状不正・不正 JSON・未知メソッド・本文サイズ超過）。公開 API の範囲内で
 * 応答だけを直し、SDK の内部は変えない。
 *
 * 残すもの：JSON-RPC の `error.code`（失敗の種類の識別）・要求との対応付け
 * の `id`（対応付けに要るため）・失敗表示そのもの（成功に化けさせない）。
 * 成功応答（失敗表示の無い結果・`202` の空応答）は変えない。配列応答は
 * 要素ごとに同じ規則で正規化する（バッチ要求の受付拒否が破れた場合の保険）。
 *
 * 落とすもの：`error.message`・`error.data`（入力文字列・例外本文・検証詳細
 * の混入があり得る）。工具結果の失敗表示があるものは、本文・余分な項目・
 * 表示の値にかかわらず定型の失敗結果に再構成する。
 *
 * ADR: 保証の範囲は「status・ヘッダー・本文の JSON 内容が不変」である。
 * 成功応答はバイト列を含めて変えない（読み直して再構成しない）。
 * 失敗応答の置換と配列応答の再構成は JSON 内容の等価のみを保証し、
 * バイト完全一致は保証しない。
 * 失敗表示の有無の判定は `isError` 項目の有無と値で行い、無い・偽の場合だけ
 * 成功として通す。項目はあるが偽でない場合（真偽値以外の値を含む）は失敗と
 * して再構成する（曖昧な失敗表示を成功として扱わない。fail-closed）。
 *
 * @param response - transport が返した応答。
 * @returns 正規化した応答（成功は不変、失敗は定型文）。
 */
export async function normalizeMcpFailureResponse(response: Response): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    // SSE を出さない構成では JSON 以外の成功は `202` の空応答だけである。
    // それ以外（平文の失敗）は定型に置き換える。
    if (response.status >= 200 && response.status < 300) {
      return response;
    }
    return Response.json({ ok: false, error: MCP_REQUEST_INVALID }, { status: response.status });
  }
  // 検査用に本文を別途解釈するが、通過させるのは原本のバイト列である。
  // 成功応答を文字どおり保つためである。
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    return Response.json({ ok: false, error: MCP_REQUEST_INVALID }, { status: response.status });
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    // JSON 頭で JSON でない本文は入力の写しの可能性があるため、失敗時は落とす。
    // 成功応答は SDK が JSON で返す前提であり、ここでは変えない。
    if (response.status >= 200 && response.status < 300) {
      return new Response(bytes, { status: response.status, headers: response.headers });
    }
    return Response.json({ ok: false, error: MCP_REQUEST_INVALID }, { status: response.status });
  }
  const table = asRecord(body);
  if (table === null && !Array.isArray(body)) {
    if (response.status >= 200 && response.status < 300) {
      return new Response(bytes, { status: response.status, headers: response.headers });
    }
    return Response.json({ ok: false, error: MCP_REQUEST_INVALID }, { status: response.status });
  }
  // 配列応答（バッチ）は要素ごとに同じ規則で正規化する。成功要素は変えず、
  // 失敗要素の `id`・`error.code` は保つ。受付自体は transport 手前で拒否
  // しており、ここは保険である。
  if (Array.isArray(body)) {
    const normalized = body.map((entry) => {
      const entryTable = asRecord(entry);
      return entryTable === null ? entry : normalizeJsonRpcPayload(entryTable);
    });
    return new Response(JSON.stringify(normalized), {
      status: response.status,
      headers: response.headers,
    });
  }
  const normalized = normalizeJsonRpcPayload(table as Record<string, unknown>);
  if (normalized === table) {
    // 成功応答はバイト列を含めて変えない。
    return new Response(bytes, { status: response.status, headers: response.headers });
  }
  return new Response(JSON.stringify(normalized), {
    status: response.status,
    headers: response.headers,
  });
}

/**
 * 要求ごとに製品向け MCP の工具を結線した server を作る。
 *
 * 状態を持たない要求/応答のみであり、工具の登録は9件の固定 allowlist
 * （実行する7件＋人間限定の2件）で行う。工具名・説明・引数 schema は
 * main の zod schema 定義と説明表から出し、実行子の検証と同じ定義を使う。
 * 射影は共有契約、実行は `GuiBackend` の既存操作への委譲で行い、MCP 側に
 * 業務 logic を書かない。承認の要求には人間の GUI 操作を要する定型応答を
 * 返し、自動では承認も拒否もしない。`quit` は公開しない。
 *
 * ADR: 工具の実行子は、同期の業務委譲の直前に同じ待受け個体の受付可否を
 * 再検査する。本文の読取り・transport への委譲をまたぐ間に停止・再有効化が
 * 割り込んでも、旧個体の遅延要求が後から実行されない（再有効化で旧個体は
 * 復活しない）。再検査の口はこの個体の `isOpen` であり、別個体の状態を見ない。
 *
 * @param backend - 表示状態の提供元と限定操作の実行先。
 * @param isOpen - 同じ待受け個体が開いているかの判定。偽の間は業務を呼ばない。
 * @returns 工具を登録した server（未接続）。
 */
function buildLocalMcpServer(backend: GuiBackend, isOpen: () => boolean): McpServer {
  // ADR: 版は包装物の `0.0.1`（`electrobun.config.ts`）に揃える。v0 台では
  // 版間の互換を考えず、使うときは版をそろえる運用である。
  const server = new McpServer({ name: "bridge-gui-local-ops", version: "0.0.1" });
  for (const name of LOCAL_KNOWN_OPS) {
    server.registerTool(
      name,
      { description: LOCAL_TOOL_DESCRIPTIONS[name], inputSchema: LOCAL_TOOL_SCHEMAS[name] },
      async (args: unknown): Promise<CallToolResult> => {
        try {
          // 実行子は SDK の検証済み値をそのまま信用せず、同じ schema で
          // `safeParse` し直す。広告と検証のずれを構造でなくす。
          const outcome = executeLocalTool(backend, name, args, isOpen);
          if (!outcome.ok) {
            return mcpToolFailure();
          }
          return { content: [{ type: "text", text: JSON.stringify(outcome.body) }] };
        } catch {
          return mcpToolFailure();
        }
      },
    );
  }
  return server;
}

/** 要求処理に要る実行時の結線。 */
export interface McpRequestContext {
  readonly backend: GuiBackend;
  /**
   * その待受け個体が開いているか。閉じた個体の要求は拒否する。
   *
   * 停止後の残存待受け・遅延要求の拒否を境界で表すための口である。個体ごとに
   * 一度きりの失効であり、再有効化で旧個体は復活しない。通常は待受の生存に
   * 連動し、試験では開閉を直接表せる。
   */
  readonly isOpen: () => boolean;
}

/**
 * 製品向け MCP が読む要求の最小形。fetch の `Request` が適合する。
 *
 * 試験では素朴な代役で `Host`・`Origin` の不正値を載せられる
 * （fetch の `Request` 生成では禁則頭になるため）。`raw` は SDK の
 * transport へ渡す fetch 実体であり、境界検査を通った要求だけを渡す。
 */
export interface McpHttpRequest {
  /** 要求 URL。 */
  readonly url: string;
  /** 要求方式。 */
  readonly method: string;
  /** 要求頭（検査に使う面）。 */
  readonly headers: { get: (name: string) => string | null };
  /** SDK の transport へ渡す fetch 実体。 */
  readonly raw: Request;
}

/** 製品向け MCP の上流（待受）の最小形。Bun の待受が適合する。 */
export interface McpUpstream {
  /** 待ち受け中の実ポート（`Host` の完全一致に使う）。 */
  readonly port: number;
  /** 接続元アドレスの取得。 */
  requestIP(request: Request): { address: string } | null;
}

/**
 * 要求本文を一度だけ読み切る（上限付き）。
 *
 * transport へ渡す前に境界で本文を確定させる。複製（tee）を使わず、
 * 原本の読取り口を直接読むため、未読分岐が残らない。文字列化・再エンコード
 * はせず、バイト列のまま扱う（BOM や非 UTF-8 で SDK 単独と挙動がずれない
 * ようにする）。上限を超えた場合は途中で打ち切り、transport へ渡さず
 * 上限超過として扱う。
 *
 * @param request - 受信した要求の fetch 実体。
 * @param maxBytes - 本文の上限（バイト）。
 * @returns 読み切ったバイト列・上限超過・読取り不能のいずれか。
 */
type BoundedBody =
  | { readonly kind: "ok"; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly kind: "tooLarge" }
  | { readonly kind: "unreadable" };

async function readBoundedBody(request: Request, maxBytes: number): Promise<BoundedBody> {
  if (request.body === null) {
    return { kind: "ok", bytes: new Uint8Array(0) };
  }
  const reader = request.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        return { kind: "tooLarge" };
      }
      chunks.push(value);
    }
  } catch {
    return { kind: "unreadable" };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "ok", bytes };
}

/**
 * バイト列が JSON-RPC のバッチ要求（配列）か先頭で判定する。
 *
 * 先頭の BOM（`EF BB BF`）と ASCII 空白（`09`〜`0D`・`20`）を読み飛ばし、
 * 次のバイトが `[`（`5B`）なら配列と判定する。読んだ本文全体で判定する
 * ため、空白の量に依存する判定不能は作らない。
 *
 * @param bytes - 要求本文のバイト列。
 * @returns 配列の場合に真。
 */
function startsWithArrayJson(bytes: Uint8Array): boolean {
  let index = 0;
  for (;;) {
    if (bytes[index] === 0xef && bytes[index + 1] === 0xbb && bytes[index + 2] === 0xbf) {
      index += 3;
      continue;
    }
    const byte = bytes[index];
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x20) {
      index += 1;
      continue;
    }
    break;
  }
  return bytes[index] === 0x5b;
}

/** 要求処理の選択肢（試験用の期限上書きに限る）。 */
export interface McpRequestOptions {
  /** 要求1件の処理期限（ミリ秒）。省略時は既定値を使う。 */
  readonly timeoutMs?: number;
}

/**
 * 要求1件の処理に期限を付ける。期限超過時は期限切れの失敗応答に落とす。
 *
 * @param work - MCP 要求の処理の応答。
 * @param timeoutMs - 要求1件の処理期限（ミリ秒）。省略時は既定値。
 * @param schedule - タイマー登録口。省略時は実行系の `setTimeout`。
 * @param unschedule - タイマー解除口。省略時は実行系の `clearTimeout`。
 * @returns 期限内なら本来の応答、期限超過なら `504` の定型応答。
 */
export function raceMcpWithTimeout(
  work: Promise<Response>,
  timeoutMs: number = MCP_OP_TIMEOUT_MS,
  schedule: (callback: () => void, ms: number) => unknown = setTimeout,
  unschedule: (timer: unknown) => void = (timer) => {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  },
): Promise<Response> {
  let timer: unknown;
  const timeout = new Promise<Response>((resolve) => {
    timer = schedule(() => {
      resolve(Response.json({ ok: false, error: MCP_OP_TIMEOUT_ERROR }, { status: 504 }));
    }, timeoutMs);
    // ADR: `as` で `unref` の有無を主張する理由は、実行系でタイマー型が
    // 異なるためである。待機の維持には使わず、単独滞留での固着を避ける
    // ために外せる場合だけ外す。無い環境では何もしない。
    try {
      (timer as unknown as { unref?: () => void }).unref?.();
    } catch {
      // 解除の失敗は期限監視を止めない。
    }
  });
  return Promise.race([work, timeout]).finally(() => {
    try {
      unschedule(timer);
    } catch {
      // 解除の失敗は応答を変えない。
    }
  });
}

/**
 * 製品向け MCP の要求を1件処理する。
 *
 * 順序は待受け個体の受付可否→`Host`→接続元→`Origin`→経路・方式→
 * 本文の読取り→SDK への委譲である。失敗応答に本文・秘密・例外内容は載せず、
 * 定型文だけを返す。ブラウザ向け CORS 頭は載せない。SDK の `allowedOrigins`
 * 検証は使わない（要求の `Origin` を応答文に写すため）。`Authorization` 頭は
 * 見ない（無認証で開く。あっても無くても同じ扱いである）。
 *
 * ADR: 受付の失効と停止完了は区別する。到達時点で個体が閉じていれば
 * `503` の定型で拒否し、業務は呼ばない。本文の読取り後にも同じ個体の
 * 受付可否を再検査し、さらに委譲先の工具実行子でも同期の業務委譲の直前に
 * 再検査するため、停止後の遅延本文・再有効化後の旧個体の遅延要求が後から
 * 実行されることはない（旧個体は復活しない）。
 *
 * ADR: 要求本文は境界で一度だけ読み切り（上限 `64KiB` で打ち切る）、
 * バイト列のまま transport へ渡す。複製（tee）による先読みは使わない。
 * tee の未読分岐は原本の読取りを止め得るためである。文字列化・再エンコード
 * もしないため、BOM や非 UTF-8 の扱いは SDK 単独と同じになる。
 * transport は既に本文を一括で扱う構成（`maxRequestBodySize` を設定済み、
 * SSE なしの JSON 応答）のため、本文のストリーム性は失われない。
 * 上限超過は transport と同じ扱い（`413` と定型）に揃える。
 * SDK 内部で生成される失敗は `normalizeMcpFailureResponse` で正規化する。
 *
 * ADR: 期限切れは応答の打切りであり、業務の取消し・再送はしない。業務実行子は
 * 同期の委譲であり、期限超過による重複実行は起きない（単一ディスパッチ）。
 * 打ち切った後の遅延処理があっても、取消しも再送も行わず、状態は再取得する
 * 運用である。開発用接続口の「期限切れは失敗・取消しを意味しない」扱いと
 * 整合させる。
 *
 * 状態を持たない要求/応答のみであり、経路は `/mcp` だけである。購読・SSE を
 * 持たないため `GET` には対応せず `405` を返す（`404` と区別する）。
 * JSON-RPC のバッチ要求（配列）は受け付けず、transport へ渡す前に `400` で
 * 拒否する（要素の業務処理は呼ばない）。
 *
 * @param request - 受信した要求。
 * @param upstream - 接続元照合に使う待受。
 * @param context - 実行時の結線。
 * @param options - 期限上書き（試験用）。省略時は既定値。
 * @returns MCP の応答または失敗応答。
 */
export async function handleMcpRequest(
  request: McpHttpRequest,
  upstream: McpUpstream,
  context: McpRequestContext,
  options: McpRequestOptions = {},
): Promise<Response> {
  // その待受け個体が開いている間のみ受け付ける。閉じた個体の残存待受け・
  // 遅延要求はここで拒否し、新規の業務操作を受け付けない（fail-closed）。
  if (!context.isOpen()) {
    return Response.json({ ok: false, error: MCP_NOT_ACCEPTING }, { status: 503 });
  }
  if (!checkMcpHost(request.headers.get("host"), upstream.port)) {
    return Response.json({ ok: false, error: "許可されていない Host である。" }, { status: 403 });
  }
  let remote: string | null = null;
  try {
    remote = upstream.requestIP(request.raw)?.address ?? null;
  } catch {
    remote = null;
  }
  if (!isMcpLoopbackAddress(remote)) {
    return Response.json({ ok: false, error: "loopback 以外からの要求である。" }, { status: 403 });
  }
  if (!checkMcpOrigin(request.headers.get("origin"))) {
    return Response.json({ ok: false, error: "許可されていない Origin である。" }, { status: 403 });
  }
  const url = new URL(request.url);
  if (url.pathname !== "/mcp") {
    return Response.json({ ok: false, error: "存在しない経路である。" }, { status: 404 });
  }
  if (request.method === "GET") {
    // 購読・SSE を持たないため `GET` には対応しない。経路の有無（`404`）とは
    // 区別し、方式の不許可（`405`）で返す。CORS 頭は載せない。
    return Response.json({ ok: false, error: MCP_METHOD_NOT_ALLOWED }, { status: 405 });
  }
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "存在しない経路である。" }, { status: 404 });
  }
  const timeoutMs = options.timeoutMs ?? MCP_OP_TIMEOUT_MS;
  const work = (async (): Promise<Response> => {
    // 本文を境界で一度だけ読み切る（上限付き）。文字列化・再エンコードは
    // せず、バイト列のまま扱う。BOM や非 UTF-8 で SDK 単独と挙動がずれない
    // ようにする。読んだ本文全体の先頭でバッチ要求（配列）を判定し、
    // transport へ渡す前に拒否する（要素の業務処理は呼ばない）。
    const bounded = await readBoundedBody(request.raw, MCP_MAX_BODY_BYTES);
    // 読取りをまたぐ間に閉じた個体の遅延本文はここで拒否し、委譲しない。
    if (!context.isOpen()) {
      return Response.json({ ok: false, error: MCP_NOT_ACCEPTING }, { status: 503 });
    }
    if (bounded.kind === "tooLarge") {
      // 上限超過は transport と同じ扱い（`413`）に揃える。
      // `code` は transport の上限超過応答と同じ値である。
      return Response.json(
        { jsonrpc: "2.0", id: null, error: { code: -32000, message: MCP_REQUEST_INVALID } },
        { status: 413 },
      );
    }
    if (bounded.kind === "unreadable") {
      return Response.json({ ok: false, error: MCP_REQUEST_INVALID }, { status: 400 });
    }
    if (startsWithArrayJson(bounded.bytes)) {
      return Response.json({ ok: false, error: MCP_REQUEST_INVALID }, { status: 400 });
    }
    try {
      // バッファ済みの本文をそのまま transport へ渡す。本文の中身・順序・
      // バイト列は変えず、URL・方式・頭は受信した要求と同じにする。
      // 委譲先の工具実行子が同じ個体の受付可否を再検査する（停止後の遅延本文・
      // 旧個体の遅延要求が後から実行されない）。
      const raw = await dispatchMcpRequest(
        {
          url: request.raw.url,
          method: request.raw.method,
          headers: request.raw.headers,
          body: bounded.bytes,
        },
        context.backend,
        context.isOpen,
      );
      return await normalizeMcpFailureResponse(raw);
    } catch {
      // 例外内容（本文の混入があり得る）は載せない。
      return Response.json({ ok: false, error: "操作に失敗した。" }, { status: 500 });
    }
  })();
  return raceMcpWithTimeout(work, timeoutMs);
}

/** transport への委譲内容。境界で確定した本文バイト列を持つ。 */
export interface McpDispatchInit {
  /** 要求 URL。 */
  readonly url: string;
  /** 要求方式。 */
  readonly method: string;
  /** 要求頭。 */
  readonly headers: Headers;
  /** 要求本文のバイト列。 */
  readonly body: Uint8Array<ArrayBuffer>;
}

/**
 * 要求を transport へ委譲し、そのままの応答を返す。正規化は呼び出し側が行う
 * （委譲と判定の責務を分ける）。
 *
 * 要求ごとに `McpServer` と Web Standard transport を新しく結線する
 * （状態を持たない要求/応答のみ）。工具の登録・実行子の検証・後始末は
 * ここで行い、外向けの成否判定（正規化）は呼び出し側が行う。
 *
 * @param init - 委譲内容（URL・方式・頭・本文バイト列）。
 * @param backend - 表示状態の提供元と限定操作の実行先。
 * @param isOpen - 同じ待受け個体が開いているかの判定。偽の間は業務を呼ばない。
 * @returns transport が返した生の応答。
 */
export async function dispatchMcpRequest(
  init: McpDispatchInit,
  backend: GuiBackend,
  isOpen: () => boolean = () => true,
): Promise<Response> {
  const buffered = new Request(init.url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
  });
  const server = buildLocalMcpServer(backend, isOpen);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: MCP_MAX_BODY_BYTES,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(buffered);
  } finally {
    try {
      await transport.close();
    } catch {
      // 後始末の失敗は応答を変えない。
    }
    try {
      await server.close();
    } catch {
      // 後始末の失敗は応答を変えない。
    }
  }
}

/**
 * 製品向け MCP の待受（`Bun.serve` 等）の最小形。試験では代役を注入できる。
 */
export interface McpListener {
  /** 束縛した実ポート。 */
  readonly port: number;
  /** 待受を止める。 */
  stop(): Promise<void> | void;
}
/**
 * 待受けを開く処理。`Bun.serve` に寄せる既定実装と試験用の代役を差し替えられる。
 *
 * @param hostname - 束縛先（`127.0.0.1`）。
 * @param port - 待ち受けポート（`0` で自動選択）。
 * @param onRequest - 要求到達時の処理。
 * @returns 開いた待受。失敗は同期例外で表す。
 */
export type McpListen = (
  hostname: string,
  port: number,
  onRequest: (raw: Request, upstream: McpUpstream) => Promise<Response>,
) => McpListener;

/** `startMcp` の選択肢。 */
export interface StartMcpOptions {
  /** 待ち受けポート。省略時は空きポートを自動選択する。 */
  readonly port?: number;
  /**
   * 待受けを開く処理。省略時は `Bun.serve` を使う。
   *
   * 待受けの失敗を注入するための口であり、通常は指定しない。
   */
  readonly listen?: McpListen;
}

/**
 * `Bun.serve` で製品向け MCP の待受けを開く（既定の `listen`）。
 *
 * @param hostname - 束縛先。
 * @param port - 待ち受けポート。
 * @param onRequest - 要求到達時の処理。
 * @returns 開いた待受。
 */
function serveBunMcp(
  hostname: string,
  port: number,
  onRequest: (raw: Request, upstream: McpUpstream) => Promise<Response>,
): McpListener {
  // ADR: 待受自身の参照は閉包で遅延して渡す。生成式の評価時点では未確定で
  // あるが、要求到達時には確定している（到達は生成より後である）。
  const server = Bun.serve({
    hostname,
    port,
    fetch: (raw, upstream): Promise<Response> => {
      // ADR: `as` で要求実体の包含を主張する理由は、実行時の要求が同一の
      // fetch `Request` 実体であり、読む項目の存在が fetch 仕様で保証される
      // ためである。`requestIP` の戻りも住所項目の存在だけを使う。
      return onRequest(raw, {
        // 束縛直後の実ポート。自動選択時はここで確定する。
        port: server.port ?? port,
        requestIP: (candidate) =>
          upstream.requestIP(candidate as unknown as Request) as unknown as {
            address: string;
          } | null,
      });
    },
  });
  return {
    port: server.port ?? port,
    stop: () => server.stop(),
  };
}

/**
 * 製品向け MCP を開始する。呼び出し前に有効条件の判定を済ませること。
 *
 * `127.0.0.1` のみ束縛する。終了処理で
 * 必ず閉じる（`close` を `GuiBackend.close()` と同じ終了経路に結線する）。
 * 待受ポートは通常のログ・標準出力・生成物へ出さない。
 * 呼び出し側は返ったポートをメモリ内に保持し、ログには出さない
 * （利用者への渡しは公開状態の URL の写しで行う）。
 *
 * 待受けの失敗（束縛できない等）は同期例外で表す。呼び出し側は口だけを
 * 閉じて通常の GUI と backend の起動を継続すること（`tryStartMcp`）。
 *
 * @param backend - 表示状態の提供元と限定操作の実行先。
 * @param options - 待ち受けポート・待受け処理の設定。
 * @returns 待受（ポート・閉鎖口）。
 * @throws `Error` — 待受けを開けない場合。半端な待受けは残さない。
 */
export function startMcp(backend: GuiBackend, options: StartMcpOptions = {}): ProductMcp {
  let closed = false;
  let stopped = false;
  // ADR: この個体の受付可否は閉包の `closed` で一度きり失効させる。再有効化では
  // 新しい個体（新しい閉包）を作るため、旧個体の遅延要求が後から実行される
  // ことはない（旧個体は復活しない）。
  const context: McpRequestContext = { backend, isOpen: () => !closed };
  const open = options.listen ?? serveBunMcp;
  const listener = open(MCP_HOST, options.port ?? 0, (raw, upstream) =>
    handleMcpRequest(
      { url: raw.url, method: raw.method, headers: raw.headers, raw },
      upstream,
      context,
    ),
  );
  return {
    port: listener.port,
    // ADR: 失効（`closed`）と停止成功（`stopped`）を分けて持つ。失効は一度きりで
    // 以後の要求を拒否し続ける（fail-closed）。停止は成功するまで再試行できる。
    // 二重の `close` は停止を一度だけ呼ぶ（成功後は呼ばない）。
    // 受付の失効だけでは停止完了としない。完了の条件は待受けの解放の確認
    // （`listener.stop` の成功）だけである。
    async close(): Promise<boolean> {
      closed = true;
      if (stopped) {
        return true;
      }
      try {
        await listener.stop();
        stopped = true;
        return true;
      } catch {
        // 停止の失敗は例外にせず、呼び出し側が再試行できるよう偽を返す。
        return false;
      }
    },
  };
}

/**
 * 製品向け MCP の開始を試み、失敗時は口だけを閉じる。
 *
 * 待受けを開けない場合も例外にせず `null` を返し、通常の GUI と backend は
 * 起動を継続する。開始の成否にかかわらず半端な待受けを残さない
 * （失敗時は待受が無いため閉じる対象が無い）。
 *
 * @param backend - 表示状態の提供元と限定操作の実行先。
 * @param options - 待ち受けポート・待受け処理の設定。
 * @returns 待受。開けない場合は `null`。
 */
export function tryStartMcp(backend: GuiBackend, options: StartMcpOptions = {}): ProductMcp | null {
  try {
    return startMcp(backend, options);
  } catch {
    console.log("[bridge-gui] MCPを開始できなかった。管理画面は起動を継続する。");
    return null;
  }
}

/**
 * 製品向け MCP の実行単位の寿命管理。
 *
 * 有効化の入口は二つ（起動時の環境変数と管理画面の設定操作）であり、
 * 同じゲートへの入口として扱う。有効状態は次回起動へ保存しない。
 * 管理画面から停止した後は、環境変数を理由に同一実行内で自動再開しない。
 * 停止は操作受付の失効と待受けの停止（ソケット解放）を区別し、解放が
 * 未完了の間は公開状態に載せて再試行できる。開始失敗は例外にせず、公開状態に
 * 載せて管理画面から分かるようにする。
 *
 * ADR: 寿命の所有者はこの controller であり、待受（`ProductMcp`）の生成・
 * 閉鎖と公開状態の通知先をここに閉じ込める。望ましい状態（`enabled`・
 * `disabled`・`closed`）を持ち、待受けの開始・停止は
 * 一つの直列な処理列で行う（前の処理の完了を待つ連鎖）。`closed` は終端で
 * あり、以後は `enable()` を受け付けない。待受けの生成・閉鎖は `enqueue`
 * 経由の一箇所だけを通す。`open`
 * 自体は同期的であり、開く・公開する一連は分断されない。`await` をまたぐ
 * 箇所では毎回望ましい状態を確認し、変わっていたら開いた待受けを閉じて
 * 公開しない。index.ts は起動・終了の結線だけを行い、RPC 層は公開操作
 * （状態・有効化・停止）だけを受けて委譲する。業務操作の
 * 一覧・射影・委譲には触らない。
 *
 * ADR: 公開状態と改訂番号はひとつの単位として確定して公開し、中間状態を
 * 外に出さない。読み取り専用の写し（`published`）だけを `getStatus` と
 * 通知に載せ、処理中の参照（`handle`・未終了の一覧）から直接組み立てない。
 * 同じ版は同じ内容を指し、新しい版はより後の状態を指す。待受け参照の消去は
 * 状態の確定と同じ同期区間に置く（間に `await` を挟まない）。
 * 停止は二段階で公開する。停止要求を受け付けた時点で「無効・未完了」を確定して
 * 公開し（参照の消去と同じ区間）、解放の確認が取れた時点で「無効・完了」へ
 * 進める。個体の受付失効（`closed`）だけでは停止完了としない。解放の確認
 * （待受けの `stop` の成功）だけが完了の条件である。
 * 未終了の再試行の間は未完了を示し続け、再試行の一覧を空にしてから待つ
 * 中間状態を作らない。
 *
 * ADR: 公開状態の改訂番号はこの controller が所有する単調な版である。公開状態を
 * 変えるたびに1つ以上進め、通知（`localMcpChanged`）と状態取得の応答に同じ値を
 * 載せる。読み取りは版を進めない。同値は同じ内容の公開状態を指す。
 */
export class LocalMcpController {
  /** 開いている待受の参照。公開状態の確定と同じ同期区間でだけ付け替える。 */
  private handle: ProductMcp | null = null;
  /** 管理画面から停止した後は、環境変数を理由に再開しない。 */
  private uiStopped = false;
  /** 公開済みの状態。内容と版をひとつの単位として持つ。読み取りは写しを返す。 */
  private published: LocalMcpStatus = {
    enabled: false,
    port: null,
    url: null,
    startFailed: false,
    cleanupPending: false,
    revision: 0,
  };
  /** 望ましい状態。`closed` は終端であり、以後は有効化されない。 */
  private desired: "enabled" | "disabled" | "closed" = "disabled";
  /** 停止に失敗して残った待受け。次回の終了・有効化・停止で再試行する。 */
  private readonly unsettled: ProductMcp[] = [];
  /** 待受けの開始・停止を直列化する処理列。失敗しても連鎖は止めない。 */
  private tail: Promise<void> = Promise.resolve();
  /** 公開状態の変化の購読。main→Webview の通知に使う。 */
  private readonly listeners = new Set<(state: LocalMcpStatus) => void>();

  /**
   * @param backend - 表示状態の提供元と限定操作の実行先。
   */
  constructor(private readonly backend: GuiBackend) {}

  /**
   * 公開状態の変化の購読を登録する。
   *
   * @param listener - 変化後の公開状態を受け取る処理。例外を投げないこと。
   * @returns 登録解除関数。
   */
  onChanged(listener: (state: LocalMcpStatus) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 公開状態をひとつの単位として確定して公開する。内容が変わるときだけ
   * 版を進め、購読者へ送る。購読者の例外は隔離する。
   *
   * 同じ区間で参照の付け替えと組にして呼び、間に `await` を挟まない。
   *
   * @param next - 版を除く公開内容。
   */
  private commit(next: Omit<LocalMcpStatus, "revision">): void {
    const current = this.published;
    if (
      current.enabled === next.enabled &&
      current.port === next.port &&
      current.url === next.url &&
      current.startFailed === next.startFailed &&
      current.cleanupPending === next.cleanupPending
    ) {
      return;
    }
    const state: LocalMcpStatus = { ...next, revision: current.revision + 1 };
    this.published = state;
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        // 購読者の例外で寿命管理を壊さない。
      }
    }
  }

  /** 現在の公開状態。URL に資格情報を含まない。読み取りは版を進めない。 */
  getStatus(): LocalMcpStatus {
    return { ...this.published };
  }

  /**
   * 仕事を直列な処理列へ積む。前の処理の完了を待ってから走る。
   *
   * 仕事自体は例外を投げない想定だが、連鎖が止まらないように守る。
   *
   * @param work - 直列に走らせる仕事。
   * @returns その仕事の完了。
   */
  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.tail.then(work);
    this.tail = next.catch(() => undefined);
    return next;
  }

  /**
   * 起動時の環境変数の入口。既定無効であり、明示 opt-in の場合だけ開く。
   *
   * 管理画面から停止した後は、環境変数を理由に同一実行内で再開しない。
   * 終了後は開かない。既に有効な場合は開き直さない。完了まで待てるよう
   * 処理列の完了を返す（起動時の記録と試験の確定に使う）。
   *
   * @param options - 待ち受けポート・待受け処理の設定（試験用の代役を含む）。
   * @returns 有効化の完了。開かない場合は即時解決する。
   */
  async startFromEnv(options: StartMcpOptions = {}): Promise<void> {
    if (this.uiStopped || !shouldStartMcp() || this.desired !== "disabled") {
      return;
    }
    await this.enable(options);
  }

  /**
   * 管理画面からの有効化。待受けを開く／作り直す。
   *
   * 望ましい状態を同期的に確定してから、直列な処理列で待受けを作り直す
   * （旧個体は失効し、復活しない）。終了後は受け付けず、公開状態をそのまま返す。
   *
   * @param options - 待ち受けポート・待受け処理の設定（試験用の代役を含む）。
   * @returns 有効化後の公開状態。
   */
  async enable(options: StartMcpOptions = {}): Promise<LocalMcpStatus> {
    if (this.desired === "closed") {
      return this.getStatus();
    }
    this.desired = "enabled";
    await this.enqueue(async () => {
      // 旧参照の解放だけを進め、公開は最後にひとつだけ行う。処理中の読み取りは
      // 公開済みの写しを返すため、中間を外に出さない。
      const previous = this.handle;
      await this.disposeTarget(previous);
      await this.drainUnsettled();
      // 進行中に止められた・閉じられた場合は開かない。参照だけ外し、公開は
      // 後続の停止・終了に委ねる（ここでは中間を出さない）。
      if (this.desired !== "enabled") {
        if (previous !== null && this.handle === previous) {
          this.handle = null;
        }
        return;
      }
      // 未終了の待受けが残る間は新しい待受けを開かない。開始失敗として現す。
      if (this.unsettled.length > 0) {
        this.handle = null;
        this.commit({
          enabled: false,
          port: null,
          url: null,
          startFailed: true,
          cleanupPending: true,
        });
        return;
      }
      const open = tryStartMcp(this.backend, options);
      // 開いた直後に望ましい状態が変わっていたら破棄して公開しない。
      // 失敗時は未終了として保持し、後続の処理で再試行する。
      if (this.desired !== "enabled") {
        await this.disposeTarget(open);
        if (this.handle === previous) {
          this.handle = null;
        }
        return;
      }
      // 参照の付け替えと公開の確定を同じ同期区間に置く。
      this.handle = open;
      if (open === null) {
        this.commit({
          enabled: false,
          port: null,
          url: null,
          startFailed: true,
          cleanupPending: false,
        });
      } else {
        this.commit({
          enabled: true,
          port: open.port,
          url: endpointUrl(open.port),
          startFailed: false,
          cleanupPending: false,
        });
      }
    });
    return this.getStatus();
  }

  /**
   * 管理画面からの停止。個体の受付を失効し、待受けを止める。
   *
   * 停止要求を受け付けた時点で「無効・未完了」を確定して公開し（参照の消去と
   * 同じ同期区間）、解放の確認が取れた時点で「無効・完了」へ進める。個体の
   * 受付失効だけでは完了としない。進行中の
   * 有効化が後から完了しても公開せず、開いた待受けはその場で閉じる。
   * 停止後は環境変数を理由に自動再開しない。処理中の副作用の巻き戻しは
   * 保証しない。解放が未完了の場合は未完了を示す公開状態を返し、再試行できる。
   *
   * @returns 停止後の公開状態（解放の確認結果を含む）。
   */
  async disable(): Promise<LocalMcpStatus> {
    if (this.desired === "closed") {
      return this.getStatus();
    }
    this.desired = "disabled";
    this.uiStopped = true;
    await this.enqueue(async () => {
      // 参照の消去と中間の確定を同じ同期区間に置く。間に `await` を挟まない。
      const open = this.handle;
      this.handle = null;
      const needsPending = open !== null || this.unsettled.length > 0;
      if (needsPending) {
        this.commit({
          enabled: false,
          port: null,
          url: null,
          startFailed: false,
          cleanupPending: true,
        });
      } else {
        this.commit({
          enabled: false,
          port: null,
          url: null,
          startFailed: false,
          cleanupPending: false,
        });
      }
      await this.disposeTarget(open);
      await this.drainUnsettled();
      // 解放の確認後に最終を確定する。受付失効だけでは完了としない。
      this.commit({
        enabled: false,
        port: null,
        url: null,
        startFailed: false,
        cleanupPending: this.unsettled.length > 0,
      });
    });
    return this.getStatus();
  }

  /**
   * 終了する。冪等であり、購読者の登録を破棄する。
   *
   * 望ましい状態を終端にし、以後は `enable()` を受け付けない。進行中の
   * 処理も破棄する。待受けの後始末が漏れないように閉じる。
   * 終了処理自体が購読解除を兼ねるため、呼び出し側で解除関数を保持しない
   * （購読の所有者は controller であり、終了時にまとめて捨てる）。
   * 公開写しは黙って最終へ進め、通知はしない。解放の確認前は未完了のまま残す。
   */
  async close(): Promise<void> {
    this.desired = "closed";
    this.listeners.clear();
    await this.enqueue(async () => {
      const open = this.handle;
      this.handle = null;
      if (open !== null || this.unsettled.length > 0) {
        this.commit({
          enabled: false,
          port: null,
          url: null,
          startFailed: false,
          cleanupPending: true,
        });
      }
      await this.disposeTarget(open);
      await this.drainUnsettled();
      this.commit({
        enabled: false,
        port: null,
        url: null,
        startFailed: false,
        cleanupPending: this.unsettled.length > 0,
      });
    });
  }

  /**
   * 待受を1つ閉じる。停止に失敗したら未終了として保持し、次回の
   * 終了・有効化・停止で再試行する。参照を失わない。
   *
   * @param open - 閉じる待受。`null` の場合は何もしない。
   */
  private async disposeTarget(open: ProductMcp | null): Promise<void> {
    if (open === null) {
      return;
    }
    const stopped = await open.close();
    if (!stopped) {
      this.unsettled.push(open);
    }
  }

  /**
   * 未終了の待受けを再試行する。止まったものから外していく。
   *
   * 一覧を空にしてから待つ中間状態を作らない。先頭から順に確かめ、止まった
   * ものだけを外す。残ったものは次回に回す（終了処理を止めない）。
   * 再試行の間も未完了を示し続け、解放の確認後にだけ完了へ進める。
   */
  private async drainUnsettled(): Promise<void> {
    let index = 0;
    while (index < this.unsettled.length) {
      const target = this.unsettled[index] as ProductMcp;
      const stopped = await target.close();
      if (stopped) {
        this.unsettled.splice(index, 1);
      } else {
        index += 1;
      }
    }
  }
}

/**
 * 接続先 URL を作る。待受は loopback の自動選択ポートであり、経路は固定である。
 *
 * @param port - 待ち受け中の実ポート。
 * @returns 接続先 URL。
 */
function endpointUrl(port: number): string {
  return `http://${MCP_HOST}:${port}/mcp`;
}
