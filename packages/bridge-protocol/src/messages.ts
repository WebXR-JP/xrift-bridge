/**
 * ブリッジ v0.3 の wire メッセージ型。
 *
 * フィールド名・型・必須/任意の共有定義はここに置く。外部入力の境界検証は
 * `validate.ts`、動的契約はテスト、上位の設計判断は `design/protocol.md`
 * を見る。型注釈だけでは外部入力を信用しない。
 *
 * Connection＝WebSocket 接続1つ（認可は Connection 単位）。Session＝一連の
 * やりとりの単位。`data` の `kind` は wire に載せず Session が
 * 保持し、`seq` の要否（latest 必須・reliable 禁止）は Session 境界で扱う。
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

/** セッション内で許す送信方向。 */
export type SessionDirection = "to_client" | "to_server" | "bidirectional";

/** 一方向のみの送信方向。`latest` の `direction` に使う。 */
export type SimplexSessionDirection = Exclude<SessionDirection, "bidirectional">;

/** v0.3 のメッセージ種別。 */
export type MessageType =
  | "pairing_start"
  | "pairing_pending"
  | "auth_ok"
  | "create_session"
  | "data"
  | "error";

/** すべての v0.3 メッセージが持つ共通フィールド。 */
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
 * セッション作成要求。クライアントから送る。
 *
 * `sessionId` は送信側が選ぶ論理名。`kind` と `direction` の組合せは
 * reliable→`bidirectional`、latest→一方向のみであり、不整合は境界で拒否する。
 */
export interface CreateReliableSessionMessage extends MessageBase {
  readonly type: "create_session";
  /** 紐付ける接続の識別子。 */
  readonly connectionId: ConnectionId;
  /** 作成するセッションの論理名。 */
  readonly sessionId: SessionId;
  readonly kind: "reliable";
  readonly direction: "bidirectional";
}

/**
 * セッション作成要求。クライアントから送る。
 *
 * `latest` はセッション内連番情報を扱うため一方向専用である。
 */
export interface CreateLatestSessionMessage extends MessageBase {
  readonly type: "create_session";
  /** 紐付ける接続の識別子。 */
  readonly connectionId: ConnectionId;
  /** 作成するセッションの論理名。 */
  readonly sessionId: SessionId;
  readonly kind: "latest";
  readonly direction: SimplexSessionDirection;
}

/** セッション作成要求（`kind` による合併）。 */
export type CreateSessionMessage = CreateReliableSessionMessage | CreateLatestSessionMessage;

/**
 * 汎用データ配送。
 *
 * `kind` は wire に載せない（Session が保持する）。`seq` の要否は Session 境界で
 * 扱う：latest では必須、reliable では禁止である。
 */
export interface ReliableDataMessage extends MessageBase {
  readonly type: "data";
  /** 紐付ける接続の識別子。 */
  readonly connectionId: ConnectionId;
  /** 配送先セッションの論理名。 */
  readonly sessionId: SessionId;
  /** 配送する JSON 値（`null` を含む）。 */
  readonly payload: unknown;
}

/**
 * 汎用データ配送（latest 用）。
 *
 * `seq` はセッション内の連番で、`latest` の置換・欠番計数に使う。
 */
export interface LatestDataMessage extends MessageBase {
  readonly type: "data";
  /** 紐付ける接続の識別子。 */
  readonly connectionId: ConnectionId;
  /** 配送先セッションの論理名。 */
  readonly sessionId: SessionId;
  /** セッション内の連番。0 以上の安全な整数。 */
  readonly seq: number;
  /** 配送する JSON 値（`null` を含む）。 */
  readonly payload: unknown;
}

/** 汎用データ配送（`seq` の有無による合併）。 */
export type DataMessage = ReliableDataMessage | LatestDataMessage;

/** 明示エラーの通知。黙って捨てず待機または明示エラーで返す。 */
export interface ErrorMessage extends MessageBase {
  readonly type: "error";
  /** 機械可読の符号（例: `UNAUTHORIZED`）。 */
  readonly code: string;
  /** 人間可読の説明。秘密値などの機微値は含めない。 */
  readonly message: string;
  /** 対応する接続がある場合の識別子。 */
  readonly connectionId?: ConnectionId;
  /**
   * 対応するペアリング要求がある場合の識別子。
   *
   * ペアリング相関専用であり業務相関には使わない。request／response 相関は
   * ブリッジ層に持たず、上位層の責務である。
   */
  readonly requestId?: PairingRequestId;
}

/** v0.3 の全メッセージの合併。 */
export type BridgeMessage =
  | PairingStartMessage
  | PairingPendingMessage
  | AuthOkMessage
  | CreateSessionMessage
  | DataMessage
  | ErrorMessage;

/** クライアント→ブリッジ方向のメッセージ。 */
export type ClientToBridgeMessage = PairingStartMessage | CreateSessionMessage | DataMessage;

/** ブリッジ→クライアント方向のメッセージ。 */
export type BridgeToClientMessage =
  | PairingPendingMessage
  | AuthOkMessage
  | DataMessage
  | ErrorMessage;
