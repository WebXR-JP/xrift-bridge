/**
 * 開発環境用エントリーポイント。
 *
 * ローカル開発時（`vp run diagnostic-world#dev`）に使用する。
 * 本番ビルド（`vp run diagnostic-world#build`）の `./World` 公開には含めない。
 * 診断パネルは自文書の自ツリーに描き、ホスト DOM の探索・改変はしない。
 * 文字入力は既定実装（console・`window.prompt`）ではなく、自ツリーの対話板で
 * 受け付ける開発用アダプターを注入する。
 * サンプルコンポーネント（`bridge-components`）も開発エントリだけに置き、本番
 * `./World` には含めない。
 */
import { DevEnvironment, XRiftProvider } from "@xrift/world-components";
import type { CameraConfig, PhysicsConfig } from "@xrift/world-components";
import { BridgeExample } from "bridge-components";
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { World } from "./World.tsx";
import { DiagnosticPanelRoot } from "./components/DiagnosticPanel.tsx";
import { YamuxProbe } from "./components/YamuxProbe.tsx";
import { useDevTextInputAdapter } from "./components/DevTextInputDialog.tsx";
import { captureWindowEnv } from "./diagnostic/env.ts";
import { getBuildInfo } from "./build-info.ts";
import xriftConfig from "../xrift.json";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Root element not found");

const worldConfig = xriftConfig.world as {
  physics?: PhysicsConfig;
  camera?: CameraConfig;
  outputBufferType?: string;
};

/** 開発ルート。3D 実行経路と診断パネルを自ツリーに並べる。 */
function DevRoot(): React.JSX.Element {
  const env = useMemo(() => captureWindowEnv(), []);
  const build = useMemo(() => getBuildInfo(), []);
  const textInput = useDevTextInputAdapter();
  return (
    <XRiftProvider baseUrl="/" textInputImplementation={textInput.implementation}>
      <DevEnvironment
        physicsConfig={worldConfig.physics}
        camera={worldConfig.camera}
        outputBufferType={worldConfig.outputBufferType}
      >
        <World />
        {/* ADR: サンプルコンポーネントの確認用に開発エントリだけへ置く。本番
            `./World` には含めない。診断盤（z=4.6）と重ならない位置にする。 */}
        <BridgeExample position={[0, 1.7, -4.6]} />
      </DevEnvironment>
      <DiagnosticPanelRoot env={env} build={build} />
      <YamuxProbe />
      {textInput.dialog}
    </XRiftProvider>
  );
}

createRoot(rootElement).render(<DevRoot />);
