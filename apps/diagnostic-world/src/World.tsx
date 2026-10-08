import { SpawnPoint } from "@xrift/world-components";
import { RigidBody } from "@react-three/rapier";
import type { FC } from "react";
import { useMemo } from "react";
import { DiagnosticBoard } from "./components/DiagnosticBoard.tsx";
import { getBuildInfo } from "./build-info.ts";
import { captureWindowEnv } from "./diagnostic/env.ts";
import { COLORS, WORLD_CONFIG } from "./constants.ts";

/** ワールドの配置。 */
export interface WorldProps {
  /** 配置位置。 */
  readonly position?: readonly [number, number, number];
  /** 全体の倍率。 */
  readonly scale?: number;
}

/**
 * 診断ワールドの最小シーン。床・collider・SpawnPoint と in-world 診断操作盤を持つ。
 *
 * Skybox・画像・装飾・壁・影は持たない。Canvas・物理エンジン・XRiftProvider は
 * 生成しない（実行基盤側が用意する）。診断操作盤は XRift 公開 API
 *（`Interactable`・`TextInput`・3Dメッシュ＋文字板）だけで作り、DOM・通信には
 * 触れない。通信・集計は `DiagnosticSession` を共用する。
 */
export const World: FC<WorldProps> = ({ position = [0, 0, 0], scale = 1 }) => {
  // ADR: 環境・ビルド識別子は自ウィンドウから World 内で採取する。本番では
  // 呼び出し側（ホスト）が prop を渡さないため、ここで用意する必要がある。
  const env = useMemo(() => captureWindowEnv(), []);
  const build = useMemo(() => getBuildInfo(), []);
  const floorSize = WORLD_CONFIG.size * scale;
  return (
    <group position={position} scale={scale}>
      <ambientLight intensity={0.6} />
      <directionalLight position={[5, 10, 5]} intensity={1.2} />
      <RigidBody type="fixed" colliders="cuboid" restitution={0} friction={0}>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
          <planeGeometry args={[floorSize, floorSize]} />
          <meshLambertMaterial color={COLORS.ground} />
        </mesh>
      </RigidBody>
      <group position={[0, 0, 8]}>
        <SpawnPoint />
      </group>
      <DiagnosticBoard env={env} build={build} />
    </group>
  );
};
