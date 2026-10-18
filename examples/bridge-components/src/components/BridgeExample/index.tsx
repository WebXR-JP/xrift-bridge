/**
 * 接続盤とテキスト表示板を結線した示例。ワールドはこれを1つ置けばよい。
 *
 * 接続手順とテキスト受信の生成・所有は各フックに任せ、このコンポーネントは配置と
 * ポート状態だけを持つ。盤・板だけを使いたい場合は、それぞれを直接組み合わせる。
 *
 * @packageDocumentation
 */
import { useMemo, useState, type JSX } from "react";
import { useBridgeConnection } from "../../connection/hooks.ts";
import { DEFAULT_PORT, buildEndpoint } from "../../endpoint.ts";
import { useTextReceiver } from "../../text/hooks.ts";
import { BridgeConnectionPanel } from "../BridgeConnectionPanel/index.tsx";
import { BridgeTextBoard } from "../BridgeTextBoard/index.tsx";

/** 示例の配置と初期ポート。 */
export interface Props {
  /** 接続ポートの初期値。変更すると接続を作り直す。 */
  readonly port?: number;
  /** 全体の配置。 */
  readonly position?: readonly [number, number, number];
}

/** SpawnPoint から見える既定位置（ワールド原点基準）。 */
const EXAMPLE_POSITION: readonly [number, number, number] = [0, 1.7, 4.6];

/**
 * 接続盤とテキスト表示板を結線した示例。
 *
 * @param props - 初期ポートと配置。
 * @returns 盤と板を含む group。Canvas・Physics・Provider は生成しない。
 */
export function BridgeExample(props: Props): JSX.Element {
  // ADR: ポートは初期値としてだけ使う。変更すると接続先が変わり、接続中の場合は
  // 接続を作り直す（接続手順の破棄・再生成）。
  const [port, setPort] = useState(props.port ?? DEFAULT_PORT);
  const endpoint = useMemo(() => buildEndpoint(port), [port]);
  const { connection, snapshot } = useBridgeConnection({ endpoint });
  const { snapshot: textSnapshot } = useTextReceiver({ connection, snapshot });
  const position = props.position ?? EXAMPLE_POSITION;
  return (
    <group position={[position[0], position[1], position[2]]}>
      <BridgeConnectionPanel
        connection={connection}
        snapshot={snapshot}
        port={port}
        onChangePort={setPort}
      />
      <BridgeTextBoard snapshot={textSnapshot} />
    </group>
  );
}
