/**
 * 診断セッションの React バインディング。
 *
 * セッションの生成・購読・破棄の所有はこのフックの effect が持つ。
 * 生成を描画時（`useMemo` など）に行い破棄だけ effect で行う構成にしない。
 * StrictMode の effect 再実行では旧セッションを破棄して新規生成し、
 * 実アンマウントでも接続・タイマー・購読を残さない。
 * `env` と `build` は参照安定であること（変わるたびに作り直す）。
 *
 * @packageDocumentation
 */
import { useEffect, useState } from "react";
import { DiagnosticSession, type DiagnosticEnv, type DiagnosticSnapshot } from "./session.ts";
import type { DiagnosticBuildInfo } from "../build-info.ts";

/** フックの引数。`env` と `build` は参照安定であること。 */
export interface UseDiagnosticSessionArgs {
  /** ブリッジの接続先。変更時は旧セッションを破棄して新規生成する。 */
  readonly endpoint: string;
  /** 診断実行時の自ウィンドウの環境。 */
  readonly env: DiagnosticEnv;
  /** 実行ビルドの識別子。 */
  readonly build: DiagnosticBuildInfo;
}

/**
 * 診断セッションを生成・購読する。
 *
 * セッションは effect 内で生成するため、初回描画では `null` を返す。
 * 呼び出し側は `null` のあいだ操作盤を無効化すること。
 *
 * @param args - 接続先・環境・ビルド識別子。
 * @returns セッションと最新の写し。生成前はどちらも `null`。
 */
export function useDiagnosticSession(args: UseDiagnosticSessionArgs): {
  readonly session: DiagnosticSession | null;
  readonly snapshot: DiagnosticSnapshot | null;
} {
  const [session, setSession] = useState<DiagnosticSession | null>(null);
  const [snapshot, setSnapshot] = useState<DiagnosticSnapshot | null>(null);
  useEffect(() => {
    // ADR: 生成・購読・破棄を同一 effect が所有する。描画時の生成物を
    // effect が破棄する構成では、StrictMode の再実行で破棄済み個体へ
    // 再購読してしまうため採らない。
    const next = new DiagnosticSession({
      endpoint: args.endpoint,
      env: args.env,
      build: args.build,
    });
    setSession(next);
    setSnapshot(next.getSnapshot());
    const unsubscribe = next.subscribe(setSnapshot);
    return () => {
      unsubscribe();
      next.dispose();
    };
  }, [args.endpoint, args.env, args.build]);
  return { session, snapshot };
}
