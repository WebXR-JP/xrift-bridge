/**
 * ブリッジ v0 の wire メッセージ型。
 *
 * フィールド名・型・必須/任意の共有定義はここに置く。外部入力の境界検証は
 * `validate.ts`、動的契約はテスト、上位の設計判断は `design/protocol.md`
 * を見る。型注釈だけでは外部入力を信用しない。
 *
 * @packageDocumentation
 */

/** プロトコルのバージョン。互換性のない変更時に上げる。 */
export const PROTOCOL_VERSION = "0.1.0";

/** 接続セッション識別子。ブリッジが認証成功時に発行する。 */
export type SessionId = string;

/** ストリーム識別子。送信側が採番とは別に選ぶ論理名。 */
export type StreamId = string;

/** 要求/応答を対応付ける識別子。送信側が生成する。 */
export type RequestId = string;

/** 配送種別。`reliable` が既定で `latest` は明示選択のみ。 */
export type StreamKind = "reliable" | "latest";

/** すべての v0 メッセージが持つ共通フィールド。 */
export interface MessageBase {
  /** プロトコルバージョン。`PROTOCOL_VERSION` と一致すること。 */
  readonly v: string;
  /** メッセージ種別。 */
  readonly type: string;
}

/**
 * 認証要求。WebSocket 確立後の最初のアプリケーションメッセージで送る。
 *
 * 秘密値を URL・クエリ・Cookie に入れず JSON 本文でのみ送る。
 */
export interface AuthMessage extends MessageBase {
  readonly type: "auth";
  /** CLI ペアリングで発行された秘密値。 */
  readonly secret: string;
}

/** 認証成功の応答。ブリッジが接続セッションを払い出す。 */
export interface AuthOkMessage extends MessageBase {
  readonly type: "auth_ok";
  /** この接続に紐付くセッション識別子。 */
  readonly sessionId: SessionId;
  /** reliable 送信に使える初期クレジット（接続単位）。 */
  readonly window: number;
}

/**
 * 到達性確認の要求。`reliable` 配送で往復する。
 *
 * `seq` は送信側（world-client）がストリームごとに採番する連番である。
 */
export interface EchoMessage extends MessageBase {
  readonly type: "echo";
  readonly sessionId: SessionId;
  readonly streamId: StreamId;
  readonly kind: "reliable";
  readonly seq: number;
  readonly requestId: RequestId;
  /** 折り返し対象の JSON 値。 */
  readonly payload: unknown;
}

/** 到達性確認の応答。要求の `requestId`・`payload` をそのまま返す。 */
export interface EchoResponseMessage extends MessageBase {
  readonly type: "echo_response";
  readonly sessionId: SessionId;
  readonly streamId: StreamId;
  readonly kind: "reliable";
  readonly seq: number;
  readonly requestId: RequestId;
  readonly payload: unknown;
}

/** コマンド処理要求。結果は `command_response` で `requestId` に対応付ける。 */
export interface CommandRequestMessage extends MessageBase {
  readonly type: "command_request";
  readonly sessionId: SessionId;
  readonly streamId: StreamId;
  readonly kind: "reliable";
  readonly seq: number;
  readonly requestId: RequestId;
  /** 実行するコマンド名（B1 は `ping` のみ受理）。 */
  readonly command: string;
  /** コマンド引子の JSON 値。 */
  readonly params?: unknown;
}

/** コマンド処理応答。切断時の未完了分は送らず結果不明として扱う。 */
export interface CommandResponseMessage extends MessageBase {
  readonly type: "command_response";
  readonly sessionId: SessionId;
  readonly requestId: RequestId;
  readonly ok: boolean;
  /** `ok` が真の場合の結果 JSON 値。 */
  readonly result?: unknown;
  /** `ok` が偽の場合の失敗内容。 */
  readonly error?: CommandErrorDetail;
}

/** コマンド失敗の内容。 */
export interface CommandErrorDetail {
  readonly code: string;
  readonly message: string;
}

/**
 * 汎用データ配送。`latest` は未送信の古い値を最新値で置換でき欠番を許容する。
 *
 * `seq` はストリーム内の連番で、`latest` の置換・欠番計数に使う。
 */
export interface DataMessage extends MessageBase {
  readonly type: "data";
  readonly sessionId: SessionId;
  readonly streamId: StreamId;
  readonly kind: StreamKind;
  readonly seq: number;
  readonly payload: unknown;
}

/**
 * 受信側容量を反映するクレジット付与（ブリッジ→クライアント）。
 *
 * 処理完了の応答とは別物で、送信側は累積付与から累積送信を引いた範囲でのみ
 * reliable を送る。`limit` はこの接続で送信を許可した累積件数であり、残数の
 * 上書きではない。同じ `limit` の再通知は追加付与にならない。
 * 初期付与は `auth_ok.window` が担い、以降の追加はこの通知で送る。
 */
export interface CreditMessage extends MessageBase {
  readonly type: "credit";
  readonly sessionId: SessionId;
  /** この接続で送信を許可した累積件数。送信可能残数 = `limit` − 累積送信件数。 */
  readonly limit: number;
}

/** 明示エラーの通知。黙って捨てず待機または明示エラーで返す。 */
export interface ErrorMessage extends MessageBase {
  readonly type: "error";
  /** 機械可読の符号（例: `UNAUTHORIZED`）。 */
  readonly code: string;
  /** 人間可読の説明。秘密値などの機微値は含めない。 */
  readonly message: string;
  /** 対応する要求がある場合の識別子。 */
  readonly sessionId?: SessionId;
  /** 対応する要求がある場合の識別子。 */
  readonly requestId?: RequestId;
}

/** v0 の全メッセージの合併。 */
export type BridgeMessage =
  | AuthMessage
  | AuthOkMessage
  | EchoMessage
  | EchoResponseMessage
  | CommandRequestMessage
  | CommandResponseMessage
  | DataMessage
  | CreditMessage
  | ErrorMessage;

/** クライアント→ブリッジ方向のメッセージ。 */
export type ClientToBridgeMessage = AuthMessage | EchoMessage | CommandRequestMessage | DataMessage;

/** ブリッジ→クライアント方向のメッセージ。 */
export type BridgeToClientMessage =
  | AuthOkMessage
  | EchoResponseMessage
  | CommandResponseMessage
  | CreditMessage
  | ErrorMessage;
