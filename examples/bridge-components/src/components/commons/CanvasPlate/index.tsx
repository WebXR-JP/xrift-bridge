/**
 * 文字板。分離 canvas を `CanvasTexture` にして平面へ貼る共用部品。
 *
 * 文書に追加しない分離 canvas を three の texture 素材としてだけ使う。ホストの
 * DOM を探したり変えたりしない。外部フォントは取得せず system font で描く。
 *
 * @packageDocumentation
 */
import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import * as THREE from "three";
// ADR: `<mesh>` などの JSX intrinsic element の型を読み込むための型のみの import。
// 実行時には残らない。R3F の型は `@react-three/fiber` が宣言する。
import type {} from "@react-three/fiber";
import {
  CANVAS_BACKGROUND,
  CANVAS_FONT,
  CANVAS_HEIGHT,
  CANVAS_LINE_HEIGHT,
  CANVAS_MAX_ROWS,
  CANVAS_PADDING,
  CANVAS_TEXT_COLOR,
  CANVAS_WIDTH,
} from "./constants.ts";
import type { Props } from "./types.ts";
import { fitLine } from "./utils.ts";

/**
 * 文字板。生成前は何も描かない。
 *
 * @param props - 表示する行と板の大きさ、行ごとの文字色。
 * @returns 文字板の平面。canvas の用意前は空の group。
 */
export function CanvasPlate(props: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [texture, setTexture] = useState<THREE.CanvasTexture | null>(null);
  const key = useMemo(() => props.lines.join("\n"), [props.lines]);

  useEffect(() => {
    // ADR: 文書に追加しない分離 canvas を使う。ホスト DOM の探索・注入・変更では
    // なく、three の texture 素材としての利用に限る。SSR など document の無い
    // 環境では描かない。
    if (typeof document === "undefined") return;
    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;
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
    context.fillStyle = CANVAS_BACKGROUND;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.font = CANVAS_FONT;
    context.textBaseline = "top";
    const maxWidth = canvas.width - CANVAS_PADDING * 2;
    const measure = (text: string): number => context.measureText(text).width;
    const { lines, colorOf } = props;
    lines.slice(0, CANVAS_MAX_ROWS).forEach((line, index) => {
      context.fillStyle = colorOf?.(line) ?? CANVAS_TEXT_COLOR;
      context.fillText(
        fitLine(line, maxWidth, measure),
        CANVAS_PADDING,
        CANVAS_PADDING + index * CANVAS_LINE_HEIGHT,
      );
    });
    texture.needsUpdate = true;
  }, [texture, key, props.lines, props.colorOf]);

  if (texture === null) return <group />;
  return (
    <mesh position={[0, 0, 0.06]}>
      <planeGeometry args={[props.width, props.height]} />
      <meshBasicMaterial map={texture} toneMapped={false} />
    </mesh>
  );
}
