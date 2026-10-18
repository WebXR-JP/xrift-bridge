/**
 * ブリッジ接続の React バインディング。
 *
 * 手順の生成・購読・破棄の所有は effect が持つ。生成を描画時（`useMemo` など）に
 * 行い破棄だけ effect で行う構成にしない。`endpoint` が変わると旧手順を破棄して
 * 新規生成する（接続中の変更は中断になる）。
 *
 * @packageDocumentation
 */
import { useEffect, useState } from "react";
import { BridgeConnection } from "./connection.ts";
import type { BridgeSnapshot } from "./types.ts";

/** フックの引数。 */
export interface UseBridgeConnectionArgs {
  /** ブリッジの接続先。変更時は旧手順を破棄して新規生成する。 */
  readonly endpoint: string;
}

/**
 * 接続手順を生成・購読する。
 *
 * 手順は effect 内で生成するため、初回描画ではどちらも `null` を返す。呼び出し側は
 * `null` のあいだ操作盤を無効化すること。
 *
 * @param args - 接続先。
 * @returns 接続手順と最新の写し。生成前はどちらも `null`。
 */
export function useBridgeConnection(args: UseBridgeConnectionArgs): {
  readonly connection: BridgeConnection | null;
  readonly snapshot: BridgeSnapshot | null;
} {
  const [connection, setConnection] = useState<BridgeConnection | null>(null);
  const [snapshot, setSnapshot] = useState<BridgeSnapshot | null>(null);
  useEffect(() => {
    const next = new BridgeConnection({ endpoint: args.endpoint });
    setConnection(next);
    setSnapshot(next.getSnapshot());
    const unsubscribe = next.subscribe(setSnapshot);
    return () => {
      unsubscribe();
      next.dispose();
    };
  }, [args.endpoint]);
  return { connection, snapshot };
}
