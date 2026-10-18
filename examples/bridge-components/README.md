# bridge-components（XRift ワールド向けサンプルコンポーネント）

XRift のワールド内でローカルブリッジへ接続し、テキストを受け取って表示するまでの
サンプル。作り方と利用方法の案内はスキル [`skills/xrift-world-component`](../../skills/xrift-world-component/SKILL.md) にあり、ここでは実物だけを置く。通信の意味は `world-client` と `bridge-plugin-text/contract` を正本とする。

## 構成

- `src/connection/` — UI 非依存の接続手順（`BridgeConnection`）と React 結合（`useBridgeConnection`）。
- `src/text/` — UI 非依存のテキスト受信手順（`TextReceiver`）と React 結合（`useTextReceiver`）。
- `src/components/` — 3D 側の部品。`BridgeConnectionPanel`（接続盤）、`BridgeTextBoard`（表示板）、`BridgeExample`（2つを結線した示例）。
- `src/components/commons/` — 文字板の共用部品（`CanvasPlate`・`LabelPlate`）。

ファイル構成は [`@xrift/world-components`](https://github.com/WebXR-JP/xrift-world-components) に合わせ、コンポーネントごとに `index.tsx`・`types.ts`・`utils.ts`・`constants.ts`・`__tests__/` を近接配置する。

## 使い方

ワールドに1つ置く場合は `BridgeExample` を使う。

```tsx
import { BridgeExample } from "bridge-components";

export const World = () => (
  <group>
    <SpawnPoint />
    <BridgeExample port={3100} />
  </group>
);
```

盤と板を分けて置く場合は、接続手順をワールド側で所有し、写しを各部品へ渡す。

```tsx
import {
  useBridgeConnection,
  useTextReceiver,
  BridgeConnectionPanel,
  BridgeTextBoard,
} from "bridge-components";

const { connection, snapshot } = useBridgeConnection({ endpoint: "ws://127.0.0.1:3100/v1" });
const { snapshot: textSnapshot } = useTextReceiver({ connection, snapshot });

<>
  <BridgeConnectionPanel
    connection={connection}
    snapshot={snapshot}
    port={3100}
    onChangePort={setPort}
  />
  <BridgeTextBoard snapshot={textSnapshot} position={[4.2, 0, 0]} />
</>;
```

## 前提

- `react`・`three`・`@react-three/fiber`・`@xrift/world-components` を peer に持つ。ワールドの `XRiftProvider` 配下で使う。
- 接続先は loopback（`ws://127.0.0.1:<port>/v1`）に限る。ブリッジ側で受付を有効にし、表示された比較コードを承認すると認可が成立する。
- テキスト受信は `bridge-plugin-text` の契約（`{ op: "show", id, text }` → `{ op: "shown", id }`）に合わせる。PC 側は GUI のテキストプラグインから送る。
- `bridge-plugin-text` の `./contract` はビルド済みの `dist` を参照する。クリーンな状態では先に `pnpm --filter bridge-gui-main gui:prepare` か `pnpm exec vp run -r build` を行う（ルート `README.md`）。

## 開発

```sh
pnpm exec vp test
pnpm exec vp run bridge-components#build
```
