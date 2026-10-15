/**
 * in-world UDP表示板。本番 `./World` に含める3D内の表示である。
 *
 * XRift 公開 API だけを使う。表示は3Dメッシュ＋自前 `CanvasTexture` の文字板で
 * 行う。新しい Canvas（R3F）・Physics・XRiftProvider は生成しない。DOM 要素の
 * 探索・追加・変更もしない（表示用 canvas は文書に追加しない分離物であり、
 * 状態板と同様の扱いである）。通信・受信は UI 非依存の `UdpReceiver` を共用し、
 * UI 層に通信を持たない。外部フォント取得は増やさず system font 描画にする。
 * 復号内容は表示専用であり、診断証拠 JSON・ログ・同期状態に含めない。
 * `useInstanceState` 等で他利用者へ同期しない。
 *
 * @packageDocumentation
 */
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { formatUdpLines } from "../udp/display.ts";
import type { UdpSnapshot } from "../udp/receiver.ts";

/** 表示板の入力。 */
export interface UdpBoardProps {
  /** UDP表示用の写し。生成前・切断時は `null`（未受信表示）。 */
  readonly snapshot: UdpSnapshot | null;
}

/** 表示板の配置（診断操作盤の左隣）。 */
export const UDP_BOARD_POSITION: readonly [number, number, number] = [-4.2, 1.7, 4.6];

/** 受信板の大きさ（メートル）。 */
export const UDP_PLATE_SIZE: readonly [number, number] = [3.4, 2.1];

/**
 * 複数行の受信板。分離 canvas を `CanvasTexture` にして平面に貼る。
 *
 * 長い行（送信元・先頭hex）は測幅で収める仕上げだけを行う（測りながら切り詰める）。
 *
 * @param props - 表示する行。
 * @returns 受信板の平面。生成前は描かない。
 */
function UdpPlate(props: { readonly lines: readonly string[] }): React.JSX.Element {
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
    context.fillStyle = "#101418";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.font = "30px sans-serif";
    context.textBaseline = "top";
    const maxWidth = canvas.width - 48;
    props.lines.slice(0, 12).forEach((line, index) => {
      context.fillStyle = line.startsWith("UDP 中断") ? "#ffb3b3" : "#e8ecf1";
      context.fillText(fitLine(context, line, maxWidth), 24, 20 + index * 56);
    });
    texture.needsUpdate = true;
  }, [texture, key, props.lines]);

  if (texture === null) return <group />;
  return (
    <mesh position={[0, 0.45, 0.06]}>
      <planeGeometry args={[UDP_PLATE_SIZE[0], UDP_PLATE_SIZE[1]]} />
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
 * in-world UDP表示板。受信状態・統計・直近データグラムの概要を3D内に置く。
 *
 * @param props - UDP表示用の写し。
 * @returns 表示板の要素。Canvas・Physics・Provider は生成しない。
 */
export function UdpBoard(props: UdpBoardProps): React.JSX.Element {
  const lines = useMemo<readonly string[]>(() => formatUdpLines(props.snapshot), [props.snapshot]);
  const lit = props.snapshot?.status === "received" ? "#69db7c" : "#9aa0a6";
  return (
    <group position={[UDP_BOARD_POSITION[0], UDP_BOARD_POSITION[1], UDP_BOARD_POSITION[2]]}>
      <mesh>
        <boxGeometry args={[3.6, 3.1, 0.1]} />
        <meshStandardMaterial color="#23262c" />
      </mesh>
      <mesh position={[-1.6, 1.4, 0.06]}>
        <sphereGeometry args={[0.07, 16, 16]} />
        <meshStandardMaterial color={lit} />
      </mesh>
      <UdpPlate lines={lines} />
    </group>
  );
}
