/**
 * 双方向通信向けメッセージ型の構想スケッチ。
 *
 * protocol 0.3 構想のスケッチであり正本ではない。正本は `messages.ts`
 * （現状 0.2・0.3 未実装）である。
 *
 * ここでの定義では以下の通り
 * Connection: WebSocket 接続1つ。認可は Connection 単位のみに属する。
 * Session: 一連のやりとりの単位。旧 Stream。既定は双方向 yamux stream 1本。
 *
 * framing（固定4-byte長＋JSON本体）と yamux の FIN/RST/GoAway/keepalive は
 * 輸送層の責務であり、メッセージ型には現れない。
 *
 * @packageDocumentation
 */

/** プロトコルのバージョン。互換性のない変更時に上げる。 */
export const PROTOCOL_VERSION = "0.3.0";

/** 比較コードの文字数。ASCII 数字のみで先頭ゼロを保持する。 */
export const PAIRING_CODE_LENGTH = 6;

/** 接続識別子。ブリッジが認証成功時に発行する。 */
export type ConnectionId = string;

/** セッション識別子。送信側が採番とは別に選ぶ論理名。 */
export type SessionId = string;

/** ペアリング要求の識別子。ブリッジが発行し業務の要求 ID とは別物。 */
export type PairingRequestId = string;

/** 比較コード。ASCII 数字 6 文字の文字列で数値型にしない。 */
export type PairingCode = string;

/** 配送種別。`reliable` が既定で `latest` は明示選択のみ。 */
export type SessionKind = "reliable" | "latest";

/** セッション内での送信可能な方向 */
export type SessionDirection = "to_client" | "to_server" | "bidirectional";
export type SimplexSessionDirection = Exclude<SessionDirection, "bidirectional">;

/** WebSocket上でのメッセージ種別。framing と終了通知は輸送層のため含まない。 */
export type MessageType =
  | "pairing_start"
  | "pairing_pending"
  | "auth_ok"
  | "create_session"
  | "data"
  | "error";

/** すべてのメッセージが持つ共通フィールド。 */
export interface MessageBase {
  /** プロトコルバージョン。`PROTOCOL_VERSION` と一致すること。 */
  readonly v: string;
  /** メッセージ種別。 */
  readonly type: string;
}

/**
 * ペアリング開始。接続最初のアプリケーションメッセージとして送る。
 *
 * 追加フィールドは持たず `{v, type}` のみである。
 */
export interface PairingStartMessage extends MessageBase {
  readonly type: "pairing_start";
}

/**
 * 比較コードの発行通知。ブリッジが両画面表示用のコードを送る。
 *
 * `requestId` は再利用しない要求識別子、`code` は ASCII 数字 6 文字、
 * `expiresAt` は承認期限の絶対時刻、`expiresInMs` は残り時間である。
 */
export interface PairingPendingMessage extends MessageBase {
  readonly type: "pairing_pending";
  /** 再利用しないペアリング要求の識別子。 */
  readonly requestId: PairingRequestId;
  /** ASCII 数字 6 文字の比較コード。 */
  readonly code: PairingCode;
  /** 承認期限の絶対時刻。 */
  readonly expiresAt: number;
  /** 承認までの残り時間（ミリ秒）。 */
  readonly expiresInMs: number;
}

/** 認証成功の応答。ブリッジが接続識別子を払い出す。 */
export interface AuthOkMessage extends MessageBase {
  readonly type: "auth_ok";
  /** 承認したペアリング要求の識別子。 */
  readonly requestId: PairingRequestId;
  /** この接続に紐付く接続識別子。 */
  readonly connectionId: ConnectionId;
}

/**
 * セッション作成メッセージの基底インターフェース
 *
 * クライアントから送信する
 */
interface CreateSessionMessageBase extends MessageBase {
  readonly type: "create_session";
  readonly connectionId: ConnectionId;
  readonly direction: SessionDirection;
  readonly kind: SessionKind;
}

/**
 * Reliableセッション作成メッセージ
 *
 * チャットなどの双方向メッセージ送信に対応する
 */
export interface CreateReliableSessionMessage extends CreateSessionMessageBase {
  readonly kind: "reliable";
}

/**
 * Latestセッション作成メッセージ
 *
 * `latest`はセッション内連番情報を扱うため、片方向専用
 */
export interface CreateLatestSessionMessage extends CreateSessionMessageBase {
  readonly direction: SimplexSessionDirection;
  readonly kind: "latest";
}

/**
 * 汎用データ配送
 *
 * 従来のecho, commandは廃止して汎用データ転送に一本化
 * 意味は上のレイヤーで付ける。業務の requestId は持たせず、
 * request/response 相関はブリッジ層に持たない。
 */
interface DataMessageBase extends MessageBase {
  readonly type: "data";
  readonly connectionId: ConnectionId;
  readonly sessionId: SessionId;
  readonly payload: unknown;
}

/** `reliable`はDataMessageBaseそのまま。アプリ層の `seq` は持たない（順序は yamux に委ねる）。 */
export interface ReliableDataMessage extends DataMessageBase {}

/**
 * `latest` は未送信の古い値を最新値で置換でき欠番を許容する。
 *
 * `seq` はセッション内の連番で、`latest` の置換・欠番計数に使う。
 */
export interface LatestDataMessage extends DataMessageBase {
  readonly seq: number;
}

/** 明示エラーの通知。黙って捨てず待機または明示エラーで返す。 */
export interface ErrorMessage extends MessageBase {
  readonly type: "error";
  /** 機械可読の符号（例: `UNAUTHORIZED`）。 */
  readonly code: string;
  /** 人間可読の説明。秘密値などの機微値は含めない。 */
  readonly message: string;
  /** 対応する要求がある場合の識別子。 */
  readonly connectionId?: ConnectionId;
}

/** 全メッセージの合併。 */
export type BridgeMessage =
  | PairingStartMessage
  | PairingPendingMessage
  | AuthOkMessage
  | CreateReliableSessionMessage
  | CreateLatestSessionMessage
  | ReliableDataMessage
  | LatestDataMessage
  | ErrorMessage;

/** クライアント→ブリッジ方向のメッセージ。 */
export type ClientToBridgeMessage =
  | PairingStartMessage
  | CreateReliableSessionMessage
  | CreateLatestSessionMessage
  | ReliableDataMessage
  | LatestDataMessage;

/** ブリッジ→クライアント方向のメッセージ。 */
export type BridgeToClientMessage =
  | PairingPendingMessage
  | AuthOkMessage
  | ReliableDataMessage
  | LatestDataMessage
  | ErrorMessage;

/** 双方向メッセージ */
export type BidirectionalMessage = ReliableDataMessage;
