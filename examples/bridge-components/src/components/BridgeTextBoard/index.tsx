/**
 * in-world テキスト表示板。直近本文と受信状態を3D内に置く。
 *
 * XRift 公開 API と3Dメッシュだけで作る。新しい Canvas・Physics・`XRiftProvider`
 * は生成しない。通信・受信は UI 非依存の `TextReceiver` を共用し、この表示板には
 * 通信を持たない。
 *
 * @packageDocumentation
 */
import { useMemo, type JSX } from "react";
import { CanvasPlate } from "../commons/CanvasPlate/index.tsx";
import { TEXT_BOARD_POSITION, TEXT_BOARD_SIZE, TEXT_PLATE_SIZE } from "./constants.ts";
import type { Props } from "./types.ts";
import { formatTextLines, textLineColor } from "./utils.ts";

/**
 * in-world テキスト表示板。
 *
 * @param props - テキスト表示用の写しと配置。
 * @returns 表示板の要素。Canvas・Physics・Provider は生成しない。
 */
export function BridgeTextBoard(props: Props): JSX.Element {
  const lines = useMemo<readonly string[]>(() => formatTextLines(props.snapshot), [props.snapshot]);
  const position = props.position ?? TEXT_BOARD_POSITION;
  const lit = props.snapshot?.status === "received";
  return (
    <group position={[position[0], position[1], position[2]]}>
      <mesh>
        <boxGeometry args={[TEXT_BOARD_SIZE[0], TEXT_BOARD_SIZE[1], TEXT_BOARD_SIZE[2]]} />
        <meshStandardMaterial color="#23262c" />
      </mesh>
      <mesh position={[-1.6, 1.4, 0.06]}>
        <sphereGeometry args={[0.07, 16, 16]} />
        <meshStandardMaterial color={lit ? "#69db7c" : "#9aa0a6"} />
      </mesh>
      <group position={[0, 0.45, 0]}>
        <CanvasPlate
          lines={lines}
          width={TEXT_PLATE_SIZE[0]}
          height={TEXT_PLATE_SIZE[1]}
          colorOf={textLineColor}
        />
      </group>
    </group>
  );
}
