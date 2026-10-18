/**
 * 単一行の名板。ボタン表面などに短い文字を中央寄せで描く共用部品。
 *
 * 分離 canvas を `CanvasTexture` にして平面へ貼る。文書に追加しない分離 canvas を
 * three の texture 素材としてだけ使う。外部フォントは取得せず system font で描く。
 *
 * @packageDocumentation
 */
import { useEffect, useRef, useState, type JSX } from "react";
import * as THREE from "three";
// ADR: `<mesh>` などの JSX intrinsic element の型を読み込むための型のみの import。
// 実行時には残らない。
import type {} from "@react-three/fiber";
import type { Props } from "./types.ts";

/** 名板 canvas の幅（ピクセル）。 */
const CANVAS_WIDTH = 256;

/** 名板 canvas の高さ（ピクセル）。 */
const CANVAS_HEIGHT = 96;

/** 名板の文字のフォント。 */
const CANVAS_FONT = "bold 44px sans-serif";

/** 名板の文字色。背景色は呼び出し側が決める。 */
const CANVAS_TEXT_COLOR = "#14171c";

/**
 * 単一行の名板。生成前は何も描かない。
 *
 * @param props - 表示する文字列・背景色・大きさ。
 * @returns 名板の平面。canvas の用意前は空の group。
 */
export function LabelPlate(props: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [texture, setTexture] = useState<THREE.CanvasTexture | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;
    canvasRef.current = canvas;
    const next = new THREE.CanvasTexture(canvas);
    next.colorSpace = THREE.SRGBColorSpace;
    const context = canvas.getContext("2d");
    if (context !== null) {
      context.fillStyle = props.background;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = CANVAS_TEXT_COLOR;
      context.font = CANVAS_FONT;
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
      <planeGeometry args={[props.width, props.height]} />
      <meshBasicMaterial map={texture} toneMapped={false} />
    </mesh>
  );
}
