/**
 * in-world 診断操作盤。本番 `./World` に含める3D内の操作・表示である。
 *
 * XRift 公開 API だけを使う。ボタンは `Interactable`、入力は `TextInput`
 * （ポート変更は値表示可の `TextInput`）、表示は3Dメッシュ＋自前
 * `CanvasTexture` の文字板で行う。秘密値の入力は持たず、接続開始→比較コード
 * の表示→取消・切断の操作だけを持つ。新しい Canvas・Physics・XRiftProvider は
 * 生成しない。DOM 要素の探索・追加・変更もしない（表示用 canvas は文書に
 * 追加しない分離物である）。診断の通信・集計は `DiagnosticSession` を共用し、
 * UI 層に通信を持たない。テキスト受信（`TextReceiver`）とUDP受信（`UdpReceiver`）は
 * この盤だけが所有し、認可済み管理口から専用セッション（論理名 `text`・`udp`）を開いて
 * 直近本文・直近データグラムを隣の表示板（`TextBoard`・`UdpBoard`）に出す。
 * 開発 DOM パネル側では生成しない。比較コード・
 * 診断状態を `useInstanceState` 等で他利用者へ同期しない。
 *
 * @packageDocumentation
 */
import { Interactable, TextInput } from "@xrift/world-components";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { DiagnosticBuildInfo } from "../build-info.ts";
import { formatDiagnosticLines } from "../diagnostic/display.ts";
import { DEFAULT_PORT, buildEndpoint, parsePortInput } from "../diagnostic/endpoint.ts";
import type { DiagnosticEnv } from "../diagnostic/session.ts";
import { useDiagnosticSession } from "../diagnostic/useDiagnosticSession.ts";
import { useTextReceiver } from "../text/useTextReceiver.ts";
import { useUdpReceiver } from "../udp/useUdpReceiver.ts";
import { TextBoard } from "./TextBoard.tsx";
import { UdpBoard } from "./UdpBoard.tsx";

/** 操作盤の入力。 */
export interface DiagnosticBoardProps {
  /** 自ウィンドウの環境。呼び出し側が採取した値。 */
  readonly env: DiagnosticEnv;
  /** 実行ビルドの識別子。 */
  readonly build: DiagnosticBuildInfo;
}

/** 操作盤の配置（ワールド原点基準）。SpawnPoint（z=8）から見える位置にする。 */
const BOARD_POSITION: readonly [number, number, number] = [0, 1.7, 4.6];

/** 状態板の大きさ（メートル）。 */
const STATUS_SIZE: readonly [number, number] = [3.4, 2.1];

/** ボタンの配置。色で役割を示し、文字板に短い名前を載せる。 */
const BUTTONS_X = [-1.36, -0.68, 0, 0.68, 1.36] as const;

/**
 * 進行に対応する表示灯の色。文字を読まなくても大枠が分かるための補助である。
 *
 * @param phase - 診断のおおまかな進行。`null` は生成前。
 * @returns 表示色。
 */
function phaseColor(phase: string | null): string {
  if (phase === "authorized") return "#69db7c";
  if (phase === "connecting" || phase === "awaiting_approval") return "#ffd43b";
  if (phase === "ended") return "#ff6b6b";
  return "#9aa0a6";
}

/**
 * 複数行の状態板。分離 canvas を `CanvasTexture` にして平面に貼る。
 *
 * @param props - 表示する行。
 * @returns 状態板の平面。生成前は描かない。
 */
function StatusPlane(props: { readonly lines: readonly string[] }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [texture, setTexture] = useState<THREE.CanvasTexture | null>(null);
  const key = useMemo(() => props.lines.join("\n"), [props.lines]);

  useEffect(() => {
    // ADR: 文書に追加しない分離 canvas を使う。ホスト DOM の探索・注入・
    // 変更ではなく、three の texture 素材としての利用に限る。
    if (typeof document === "undefined") return;
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 704;
    canvasRef.current = canvas;
    const next = new THREE.CanvasTexture(canvas);
    next.colorSpace = THREE.SRGBColorSpace;
    setTexture(next);
    return () => {
      canvasRef.current = null;
      next.dispose();
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || texture === null) return;
    const context = canvas.getContext("2d");
    if (context === null) return;
    context.fillStyle = "#14171c";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.font = "30px sans-serif";
    context.textBaseline = "top";
    const maxWidth = canvas.width - 48;
    props.lines.slice(0, 12).forEach((line, index) => {
      context.fillStyle =
        line.startsWith("失敗") || line.startsWith("案内") || line.startsWith("ポート入力")
          ? "#ffb3b3"
          : "#e8ecf1";
      context.fillText(fitLine(context, line, maxWidth), 24, 20 + index * 56);
    });
    texture.needsUpdate = true;
  }, [texture, key, props.lines]);

  if (texture === null) return <group />;
  return (
    <mesh position={[0, 0.45, 0.06]}>
      <planeGeometry args={[STATUS_SIZE[0], STATUS_SIZE[1]]} />
      <meshBasicMaterial map={texture} toneMapped={false} />
    </mesh>
  );
}

/**
 * 行を測幅で収める。長い行は測りながら切り詰める。
 *
 * @param context - 描画先の文脈。設定済み font で測る。
 * @param line - 表示する1行。
 * @param maxWidth - 収める幅（ピクセル）。
 * @returns 収まる1行。
 */
function fitLine(context: CanvasRenderingContext2D, line: string, maxWidth: number): string {
  if (context.measureText(line).width <= maxWidth) return line;
  let low = 0;
  let high = line.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = `${line.slice(0, mid)}…`;
    if (context.measureText(candidate).width <= maxWidth) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return `${line.slice(0, Math.max(0, low - 1))}…`;
}

/**
 * ボタン表面の短い名前板。背景色で役割を示す。
 *
 * @param props - 表示名と背景色。
 * @returns 名前板の平面。生成前は描かない。
 */
function ButtonLabel(props: {
  readonly text: string;
  readonly background: string;
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [texture, setTexture] = useState<THREE.CanvasTexture | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 96;
    canvasRef.current = canvas;
    const next = new THREE.CanvasTexture(canvas);
    next.colorSpace = THREE.SRGBColorSpace;
    const context = canvas.getContext("2d");
    if (context !== null) {
      context.fillStyle = props.background;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#14171c";
      context.font = "bold 44px sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(props.text, canvas.width / 2, canvas.height / 2 + 2);
    }
    next.needsUpdate = true;
    setTexture(next);
    return () => {
      canvasRef.current = null;
      next.dispose();
    };
  }, [props.background, props.text]);

  if (texture === null) return <group />;
  return (
    <mesh position={[0, 0, 0.06]}>
      <planeGeometry args={[0.58, 0.22]} />
      <meshBasicMaterial map={texture} toneMapped={false} />
    </mesh>
  );
}

/**
 * in-world 診断操作盤。接続先・接続開始・比較コード表示・応答確認・取消・切断を3D内に置く。
 *
 * @param props - 自ウィンドウの環境とビルド識別子。
 * @returns 操作盤の要素。Canvas・Physics・Provider は生成しない。
 */
export function DiagnosticBoard(props: DiagnosticBoardProps): React.JSX.Element {
  const [port, setPort] = useState<number>(DEFAULT_PORT);
  const [portError, setPortError] = useState<string | null>(null);
  const endpoint = useMemo(() => buildEndpoint(port), [port]);
  const { session, snapshot } = useDiagnosticSession({
    endpoint,
    env: props.env,
    build: props.build,
  });
  // ADR: テキスト受信・UDP受信は3D盤側だけが所有する。認可済み管理口から専用
  // セッションを開き、切断・再接続では直近を消す。開発 DOM パネル側では生成しない。
  const { snapshot: textSnapshot } = useTextReceiver({ session, snapshot });
  const { snapshot: udpSnapshot } = useUdpReceiver({ session, snapshot });

  const phase = snapshot?.phase ?? null;
  const lines = useMemo<readonly string[]>(
    () => (snapshot === null ? ["準備中…"] : formatDiagnosticLines(snapshot, portError)),
    [snapshot, portError],
  );

  // ADR: 比較コードは表示のみに使い、盤の同期状態・証拠に残さない。
  // 接続開始は引数なしで行い、承認待ちの取消は `cancel` で閉じる。
  const handleConnect = useCallback(() => {
    if (session === null) return;
    void session.connect().catch(() => {
      // 失敗は快照（lastError）に反映済み。未処理拒否にしないためのみ catch する。
    });
  }, [session]);

  const handlePortSubmit = useCallback((value: string) => {
    const parsed = parsePortInput(value);
    if (!parsed.ok) {
      setPortError(parsed.error);
      return;
    }
    setPortError(null);
    setPort(parsed.port);
  }, []);

  const handleEcho = useCallback(() => {
    if (session === null) return;
    void session.runEcho().catch(() => {
      // 失敗は快照に反映済み。
    });
  }, [session]);

  const handlePing = useCallback(() => {
    if (session === null) return;
    void session.runPing().catch(() => {
      // 失敗は快照に反映済み。
    });
  }, [session]);

  const handleDisconnect = useCallback(() => {
    if (session === null || snapshot === null) return;
    try {
      if (snapshot.phase === "connecting" || snapshot.phase === "awaiting_approval") {
        session.cancel();
      } else {
        session.disconnect();
      }
    } catch {
      // 待機なし・破棄済みの操作は快照に反映しないため無視する。
    }
  }, [session, snapshot]);

  const ready = session !== null && snapshot !== null;
  const busy = phase === "connecting" || phase === "awaiting_approval";
  const connected = phase === "authorized";
  const operable = connected && ready;
  const cancelLabel = busy ? "取消" : "切断";
  const cancelText = busy ? "接続試行を取消" : "切断";

  return (
    <>
      <group position={[BOARD_POSITION[0], BOARD_POSITION[1], BOARD_POSITION[2]]}>
        <mesh>
          <boxGeometry args={[3.6, 3.1, 0.1]} />
          <meshStandardMaterial color="#23262c" />
        </mesh>
        <mesh position={[-1.6, 1.4, 0.06]}>
          <sphereGeometry args={[0.07, 16, 16]} />
          <meshStandardMaterial color={phaseColor(phase)} />
        </mesh>
        <StatusPlane lines={lines} />
        <Interactable
          id="diag-connect"
          onInteract={handleConnect}
          interactionText="接続開始（比較コード表示）"
          enabled={ready && !busy && !connected}
        >
          <group position={[BUTTONS_X[0], -1.25, 0.06]}>
            <mesh>
              <boxGeometry args={[0.62, 0.3, 0.08]} />
              <meshStandardMaterial color="#e8e8e8" />
            </mesh>
            <ButtonLabel text="接続" background="#e8e8e8" />
          </group>
        </Interactable>
        <TextInput
          id="diag-port-input"
          placeholder="ポート番号を入力"
          value={String(port)}
          maxLength={5}
          onSubmit={handlePortSubmit}
          interactionText="ポート番号を変更"
          disabled={!ready || busy || connected}
        >
          <group position={[BUTTONS_X[1], -1.25, 0.06]}>
            <mesh>
              <boxGeometry args={[0.62, 0.3, 0.08]} />
              <meshStandardMaterial color="#ffd43b" />
            </mesh>
            <ButtonLabel text="変更" background="#ffd43b" />
          </group>
        </TextInput>
        <Interactable
          id="diag-echo"
          onInteract={handleEcho}
          interactionText="echo 往復"
          enabled={operable}
        >
          <group position={[BUTTONS_X[2], -1.25, 0.06]}>
            <mesh>
              <boxGeometry args={[0.62, 0.3, 0.08]} />
              <meshStandardMaterial color="#4dabf7" />
            </mesh>
            <ButtonLabel text="echo" background="#4dabf7" />
          </group>
        </Interactable>
        <Interactable
          id="diag-ping"
          onInteract={handlePing}
          interactionText="ping"
          enabled={operable}
        >
          <group position={[BUTTONS_X[3], -1.25, 0.06]}>
            <mesh>
              <boxGeometry args={[0.62, 0.3, 0.08]} />
              <meshStandardMaterial color="#69db7c" />
            </mesh>
            <ButtonLabel text="ping" background="#69db7c" />
          </group>
        </Interactable>
        <Interactable
          id="diag-disconnect"
          onInteract={handleDisconnect}
          interactionText={cancelText}
          enabled={ready && (busy || connected)}
        >
          <group position={[BUTTONS_X[4], -1.25, 0.06]}>
            <mesh>
              <boxGeometry args={[0.62, 0.3, 0.08]} />
              <meshStandardMaterial color="#ff6b6b" />
            </mesh>
            <ButtonLabel text={cancelLabel} background="#ff6b6b" />
          </group>
        </Interactable>
      </group>
      <TextBoard snapshot={textSnapshot} />
      <UdpBoard snapshot={udpSnapshot} />
    </>
  );
}
