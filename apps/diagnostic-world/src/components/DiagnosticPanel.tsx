/**
 * 診断パネル。開発文書内の自ツリーに描く PC 向け操作盤。
 *
 * 本番 `./World` の in-world 操作盤（`DiagnosticBoard`）とは別物であり、
 * 開発エントリ専用である。ホスト DOM の探索・改変はしない。自ツリーの要素と、
 * 呼び出し側から渡る自ウィンドウの環境値・ビルド識別子だけを使う。接続は
 * ボタン操作時のみ行い、自動接続・自動再接続はしない。比較コードは画面表示
 * のみに使い、永続保存・URL・console・証拠に残さない。コピーは手動選択式とし、
 * clipboard API・storage API は使わない。
 *
 * @packageDocumentation
 */
import { useMemo, useRef, useState } from "react";
import { useDiagnosticSession } from "../diagnostic/useDiagnosticSession.ts";
import { DEFAULT_PORT, buildEndpoint, parsePortInput } from "../diagnostic/endpoint.ts";
import { echoLabel, formatPairingCode, phaseLabel, pingLabel } from "../diagnostic/display.ts";
import type { DiagnosticEnv } from "../diagnostic/session.ts";
import type { DiagnosticSession } from "../diagnostic/session.ts";
import type { DiagnosticBuildInfo } from "../build-info.ts";
import "./DiagnosticPanel.css";

/** パネルの入力。 */
export interface DiagnosticPanelRootProps {
  /** 自ウィンドウの環境。呼び出し側が採取した値。 */
  readonly env: DiagnosticEnv;
  /** 実行ビルドの識別子。 */
  readonly build: DiagnosticBuildInfo;
}

/**
 * 診断パネル全体。接続先・接続開始・比較コード・操作・結果を自ツリーに描く。
 *
 * @param props - 自ウィンドウの環境とビルド識別子。
 * @returns パネル要素。
 */
export function DiagnosticPanelRoot(props: DiagnosticPanelRootProps): React.JSX.Element {
  const [port, setPort] = useState<number>(DEFAULT_PORT);
  const [portText, setPortText] = useState<string>(String(DEFAULT_PORT));
  const [portError, setPortError] = useState<string | null>(null);
  const endpoint = useMemo(() => buildEndpoint(port), [port]);
  const { session, snapshot } = useDiagnosticSession({
    endpoint,
    env: props.env,
    build: props.build,
  });

  const handlePortChange = (value: string): void => {
    setPortText(value);
    const parsed = parsePortInput(value);
    if (!parsed.ok) {
      setPortError(parsed.error);
      return;
    }
    setPortError(null);
    setPort(parsed.port);
  };

  if (snapshot === null) {
    return (
      <div className="diag-panel" aria-label="ブリッジ接続の診断パネル">
        <h1 className="diag-title">ブリッジ接続診断</h1>
        <p className="diag-note">準備中…</p>
      </div>
    );
  }

  return (
    <div className="diag-panel" aria-label="ブリッジ接続の診断パネル">
      <h1 className="diag-title">ブリッジ接続診断</h1>
      <EndpointSection
        endpoint={endpoint}
        portText={portText}
        portError={portError}
        editable={snapshot.phase === "idle" || snapshot.phase === "ended"}
        onPortChange={handlePortChange}
      />
      <ConnectSection session={session} snapshot={snapshot} />
      <StatusSection snapshot={snapshot} />
      <ProbeSection session={session} snapshot={snapshot} />
      <EnvSection snapshot={snapshot} />
      <ResultSection session={session} />
      <NotesSection />
    </div>
  );
}

/** 接続先の表示とポート入力。 */
function EndpointSection(props: {
  readonly endpoint: string;
  readonly portText: string;
  readonly portError: string | null;
  readonly editable: boolean;
  readonly onPortChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <section className="diag-section" aria-label="接続先">
      <h2>接続先</h2>
      <p className="diag-endpoint">{props.endpoint}</p>
      <label className="diag-row">
        ポート
        <input
          className="diag-port"
          type="number"
          min={1}
          max={65535}
          value={props.portText}
          disabled={!props.editable}
          onChange={(event) => {
            props.onPortChange(event.target.value);
          }}
        />
      </label>
      {props.portError !== null && <p className="diag-error">{props.portError}</p>}
      <p className="diag-note">
        ホスト・パスは loopback 固定（`127.0.0.1`・`/v1`）。未接続時のみ変更できる。
      </p>
    </section>
  );
}

/** 接続開始・比較コード表示・取消・切断。 */
function ConnectSection(props: {
  readonly session: DiagnosticSession | null;
  readonly snapshot: ReturnType<DiagnosticSession["getSnapshot"]>;
}): React.JSX.Element {
  const { session, snapshot } = props;
  const busy = snapshot.phase === "connecting" || snapshot.phase === "awaiting_approval";
  const connected = snapshot.phase === "authorized";

  const handleConnect = (): void => {
    if (session === null) return;
    void session.connect().catch(() => {
      // 失敗は写し（lastError）に反映済み。未処理拒否にしないためのみ catch する。
    });
  };

  const handleCancel = (): void => {
    try {
      session?.cancel();
    } catch {
      // 待機なし・破棄済みの操作は写しに反映しないため無視する。
    }
  };

  return (
    <section className="diag-section" aria-label="接続操作">
      <h2>接続</h2>
      <div className="diag-buttons">
        <button
          type="button"
          disabled={session === null || busy || connected}
          onClick={handleConnect}
        >
          接続開始
        </button>
        <button type="button" disabled={session === null || !busy} onClick={handleCancel}>
          取消
        </button>
        <button
          type="button"
          disabled={session === null || (!busy && !connected)}
          onClick={() => {
            session?.disconnect();
          }}
        >
          切断
        </button>
      </div>
      {snapshot.pairing === null ? (
        <p className="diag-note">
          接続開始で比較コードを表示する。bridge 側の表示と照合して承認すること。
        </p>
      ) : (
        <div className="diag-pairing" role="status" aria-label="比較コード">
          <p className="diag-pairing-code">{formatPairingCode(snapshot.pairing.code)}</p>
          <p className="diag-note">
            bridge 側の表示と照合して承認すること。承認待ちのまま放置しないこと。
          </p>
        </div>
      )}
      <p className="diag-note">
        接続待機（比較コード受信前）は診断用に120秒。bridge
        の認証待ち制限は変えない。期限切れは新規に接続開始すること。
      </p>
    </section>
  );
}

/** 接続状態とエラーの表示。 */
function StatusSection(props: {
  readonly snapshot: ReturnType<DiagnosticSession["getSnapshot"]>;
}): React.JSX.Element {
  const { snapshot } = props;
  return (
    <section className="diag-section" aria-label="状態">
      <h2>状態</h2>
      <dl className="diag-dl">
        <dt>進行</dt>
        <dd>{phaseLabel(snapshot.phase)}</dd>
        <dt>接続状態</dt>
        <dd>{snapshot.connectionState}</dd>
      </dl>
      {snapshot.lastError === null ? (
        <p className="diag-note">エラーなし。</p>
      ) : (
        <div className="diag-error-box" role="alert">
          <p>
            {snapshot.lastError.code}: {snapshot.lastError.message}
          </p>
          {snapshot.lastError.hint !== undefined && (
            <p className="diag-hint">{snapshot.lastError.hint}</p>
          )}
        </div>
      )}
    </section>
  );
}

/** echo・ping の実行と結果表示。 */
function ProbeSection(props: {
  readonly session: DiagnosticSession | null;
  readonly snapshot: ReturnType<DiagnosticSession["getSnapshot"]>;
}): React.JSX.Element {
  const { session, snapshot } = props;
  const operable = session !== null && snapshot.phase === "authorized";
  const echoRunning = snapshot.echo.status === "running";
  const pingRunning = snapshot.ping.status === "running";

  const handleEcho = (): void => {
    void session?.runEcho().catch(() => {
      // 失敗は写しに反映済み。
    });
  };
  const handlePing = (): void => {
    void session?.runPing().catch(() => {
      // 失敗は写しに反映済み。
    });
  };

  return (
    <section className="diag-section" aria-label="応答確認">
      <h2>応答確認</h2>
      <div className="diag-buttons">
        <button type="button" disabled={!operable || echoRunning} onClick={handleEcho}>
          echo 往復
        </button>
        <button type="button" disabled={!operable || pingRunning} onClick={handlePing}>
          ping
        </button>
      </div>
      {!operable && <p className="diag-note">未認証時の操作は禁止。先に接続・認証すること。</p>}
      <dl className="diag-dl">
        <dt>echo</dt>
        <dd>{echoLabel(snapshot.echo)}</dd>
        <dt>ping</dt>
        <dd>{pingLabel(snapshot.ping)}</dd>
      </dl>
    </section>
  );
}

/** 自ウィンドウの環境とビルド識別子の表示。 */
function EnvSection(props: {
  readonly snapshot: ReturnType<DiagnosticSession["getSnapshot"]>;
}): React.JSX.Element {
  const { snapshot } = props;
  return (
    <section className="diag-section" aria-label="環境">
      <h2>環境</h2>
      <dl className="diag-dl">
        <dt>origin</dt>
        <dd>{snapshot.env.origin}</dd>
        <dt>secure</dt>
        <dd>{snapshot.env.secureContext ? "true" : "false"}</dd>
        <dt>frame</dt>
        <dd>{snapshot.env.topLevel ? "top-level" : "embedded"}</dd>
        <dt>build</dt>
        <dd>{`${snapshot.build.version} / ${snapshot.build.commit} / ${snapshot.build.builtAt}`}</dd>
      </dl>
    </section>
  );
}

/** 診断結果の保存・コピー。比較コード・payload は含まない。 */
function ResultSection(props: { readonly session: DiagnosticSession | null }): React.JSX.Element {
  const areaRef = useRef<HTMLTextAreaElement>(null);
  if (props.session === null) {
    return (
      <section className="diag-section" aria-label="診断結果">
        <h2>診断結果</h2>
        <p className="diag-note">準備中…</p>
      </section>
    );
  }
  return <ResultBody session={props.session} areaRef={areaRef} />;
}

/** 診断結果の本文。セッション確定後に描く。 */
function ResultBody(props: {
  readonly session: DiagnosticSession;
  readonly areaRef: React.RefObject<HTMLTextAreaElement | null>;
}): React.JSX.Element {
  // 親の再描画（写しの更新）ごとに最新の証拠 JSON を作る。比較コード本文・payload は含まない。
  const liveText = JSON.stringify(props.session.toResultJson(), null, 2);

  const handleSelectAll = (): void => {
    props.areaRef.current?.focus();
    props.areaRef.current?.select();
  };
  const handleSave = (): void => {
    // ADR: 保存は JSON Blob の anchor ダウンロードで行う。JS 実行用 Blob でも
    // DOM 注入でもなく、ホスト文書へ要素を追加しない（detached のまま click）。
    const blob = new Blob([liveText], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "diagnostic-result.json";
    anchor.click();
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);
  };

  return (
    <section className="diag-section" aria-label="診断結果">
      <h2>診断結果</h2>
      <p className="diag-note">
        比較コード・業務 payload を含まない。手動で選択してコピーすること。
      </p>
      <textarea ref={props.areaRef} className="diag-result" readOnly rows={12} value={liveText} />
      <div className="diag-buttons">
        <button type="button" onClick={handleSelectAll}>
          全選択
        </button>
        <button type="button" onClick={handleSave}>
          保存
        </button>
      </div>
    </section>
  );
}

/** 運用の注意書き。 */
function NotesSection(): React.JSX.Element {
  return (
    <section className="diag-section" aria-label="注意">
      <h2>注意</h2>
      <ul className="diag-list">
        <li>接続はボタン操作時のみ。自動接続・自動再ペアリングはしない。</li>
        <li>比較コードは画面表示のみとし、永続保存・URL・console・証拠に残さない。</li>
        <li>期限切れ・拒否・失敗上限の後は新規に接続開始すること。</li>
        <li>
          開発許可なしでは localhost Origin が拒否される（bridge は `--dev --origin
          http://localhost:5173` で起動すること）。
        </li>
      </ul>
    </section>
  );
}
