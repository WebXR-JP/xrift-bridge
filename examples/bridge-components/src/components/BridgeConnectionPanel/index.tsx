/**
 * in-world 接続盤。接続開始・比較コード表示・取消／切断を3D内に置く。
 *
 * XRift 公開 API（`Interactable`・`TextInput`・3Dメッシュ＋文字板）だけで作る。
 * 新しい Canvas・Physics・`XRiftProvider` は生成しない。接続の通信・状態は
 * UI 非依存の `BridgeConnection` を共用し、この盤には通信を持たない。比較コードは
 * 表示のみに使い、保存・送信・同期の対象にしない。
 *
 * @packageDocumentation
 */
import { Interactable, TextInput } from "@xrift/world-components";
import { useCallback, useMemo, useState, type JSX } from "react";
import { parsePortInput } from "../../endpoint.ts";
import { CanvasPlate } from "../commons/CanvasPlate/index.tsx";
import { LabelPlate } from "../commons/LabelPlate/index.tsx";
import {
  BUTTON_LABEL_SIZE,
  BUTTON_SIZE,
  BUTTON_X,
  BUTTON_Y,
  PANEL_POSITION,
  PANEL_SIZE,
  STATUS_SIZE,
} from "./constants.ts";
import type { Props } from "./types.ts";
import { connectionLineColor, formatConnectionLines, phaseColor } from "./utils.ts";

/**
 * in-world 接続盤。
 *
 * @param props - 接続手順とその写し、表示ポート、配置。
 * @returns 接続盤の要素。Canvas・Physics・Provider は生成しない。
 */
export function BridgeConnectionPanel(props: Props): JSX.Element {
  const [portError, setPortError] = useState<string | null>(null);
  const phase = props.snapshot?.phase ?? null;
  const lines = useMemo(
    () => formatConnectionLines(props.snapshot, portError),
    [props.snapshot, portError],
  );
  const position = props.position ?? PANEL_POSITION;
  const ready = props.connection !== null && props.snapshot !== null;
  const busy = phase === "connecting" || phase === "awaiting_approval";
  const authorized = phase === "authorized";
  const canConnect = ready && !busy && !authorized;
  const canCancel = props.connection !== null && (busy || authorized);
  const cancelLabel = busy ? "取消" : "切断";

  const handleConnect = useCallback(() => {
    try {
      props.connection?.connect();
    } catch {
      // 進行中・認可済みの重複操作は写しの状態で分かるため、ここでは無視する。
    }
  }, [props.connection]);

  const handlePortSubmit = useCallback(
    (value: string) => {
      const parsed = parsePortInput(value);
      if (!parsed.ok) {
        setPortError(parsed.error);
        return;
      }
      setPortError(null);
      props.onChangePort(parsed.port);
    },
    [props.onChangePort],
  );

  const handleCancel = useCallback(() => {
    const connection = props.connection;
    if (connection === null) return;
    try {
      if (busy) {
        connection.cancel();
      } else {
        connection.disconnect();
      }
    } catch {
      // 待機なし・破棄済みの操作は無視する。
    }
  }, [props.connection, busy]);

  return (
    <group position={[position[0], position[1], position[2]]}>
      <mesh>
        <boxGeometry args={[PANEL_SIZE[0], PANEL_SIZE[1], PANEL_SIZE[2]]} />
        <meshStandardMaterial color="#23262c" />
      </mesh>
      <mesh position={[-1.6, 1.4, 0.06]}>
        <sphereGeometry args={[0.07, 16, 16]} />
        <meshStandardMaterial color={phaseColor(phase)} />
      </mesh>
      <group position={[0, 0.45, 0]}>
        <CanvasPlate
          lines={lines}
          width={STATUS_SIZE[0]}
          height={STATUS_SIZE[1]}
          colorOf={connectionLineColor}
        />
      </group>
      <Interactable
        id="bridge-connect"
        onInteract={handleConnect}
        interactionText="接続開始（比較コード表示）"
        enabled={canConnect}
      >
        <group position={[BUTTON_X[0], BUTTON_Y, 0.06]}>
          <mesh>
            <boxGeometry args={[BUTTON_SIZE[0], BUTTON_SIZE[1], BUTTON_SIZE[2]]} />
            <meshStandardMaterial color="#e8e8e8" />
          </mesh>
          <LabelPlate
            text="接続"
            background="#e8e8e8"
            width={BUTTON_LABEL_SIZE[0]}
            height={BUTTON_LABEL_SIZE[1]}
          />
        </group>
      </Interactable>
      <TextInput
        id="bridge-port-input"
        placeholder="ポート番号を入力"
        value={String(props.port)}
        maxLength={5}
        onSubmit={handlePortSubmit}
        interactionText="ポート番号を変更"
        disabled={!ready || busy || authorized}
      >
        <group position={[BUTTON_X[1], BUTTON_Y, 0.06]}>
          <mesh>
            <boxGeometry args={[BUTTON_SIZE[0], BUTTON_SIZE[1], BUTTON_SIZE[2]]} />
            <meshStandardMaterial color="#ffd43b" />
          </mesh>
          <LabelPlate
            text="変更"
            background="#ffd43b"
            width={BUTTON_LABEL_SIZE[0]}
            height={BUTTON_LABEL_SIZE[1]}
          />
        </group>
      </TextInput>
      <Interactable
        id="bridge-cancel"
        onInteract={handleCancel}
        interactionText={busy ? "接続試行を取消" : "切断"}
        enabled={canCancel}
      >
        <group position={[BUTTON_X[2], BUTTON_Y, 0.06]}>
          <mesh>
            <boxGeometry args={[BUTTON_SIZE[0], BUTTON_SIZE[1], BUTTON_SIZE[2]]} />
            <meshStandardMaterial color="#ff6b6b" />
          </mesh>
          <LabelPlate
            text={cancelLabel}
            background="#ff6b6b"
            width={BUTTON_LABEL_SIZE[0]}
            height={BUTTON_LABEL_SIZE[1]}
          />
        </group>
      </Interactable>
    </group>
  );
}
