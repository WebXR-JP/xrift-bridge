// @vitest-environment happy-dom
/**
 * 診断セッションの React 結合の検証。生成・購読・破棄の所有を確かめる。
 *
 * StrictMode の effect 再実行で破棄済み個体へ再購読しないこと、実アンマウントと
 * 接続先変更で旧個体が残留しないことを、通信なし（未接続のまま）で検証する。
 */
import { afterEach, expect, test } from "vite-plus/test";
import { StrictMode, useEffect } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useDiagnosticSession } from "../src/diagnostic/useDiagnosticSession.ts";
import type { DiagnosticEnv } from "../src/diagnostic/session.ts";
import type { DiagnosticSession } from "../src/diagnostic/session.ts";
import type { DiagnosticBuildInfo } from "../src/build-info.ts";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const ENV: DiagnosticEnv = {
  origin: "http://localhost:5173",
  secureContext: false,
  topLevel: true,
};

const BUILD: DiagnosticBuildInfo = {
  version: "0.0.0-test",
  commit: "test",
  builtAt: "2026-01-01T00:00:00.000Z",
};

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;
const seen: DiagnosticSession[] = [];

function Probe(props: { readonly endpoint: string }): React.JSX.Element {
  const { session, snapshot } = useDiagnosticSession({
    endpoint: props.endpoint,
    env: ENV,
    build: BUILD,
  });
  useEffect(() => {
    if (session !== null) seen.push(session);
  }, [session]);
  return <div data-phase={snapshot?.phase ?? "none"} />;
}

function mount(endpoint: string, strict: boolean): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const tree = <Probe endpoint={endpoint} />;
  act(() => {
    root?.render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  });
}

function rerender(endpoint: string, strict: boolean): void {
  const tree = <Probe endpoint={endpoint} />;
  act(() => {
    root?.render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  seen.splice(0);
});

/** 破棄済みかを購読の可否で判定する。通信は行わない。 */
function isDisposed(session: DiagnosticSession): boolean {
  try {
    const unsubscribe = session.subscribe(() => {});
    unsubscribe();
    return false;
  } catch {
    return true;
  }
}

test("StrictMode の再実行では旧個体を破棄し、新個体だけが残る", () => {
  mount("ws://127.0.0.1:3100/v1", true);
  expect(seen.length).toBeGreaterThanOrEqual(1);
  const latest = seen[seen.length - 1];
  expect(isDisposed(latest)).toBe(false);
  expect(latest.getSnapshot().phase).toBe("idle");
  for (const older of seen.slice(0, -1)) {
    expect(isDisposed(older)).toBe(true);
  }
  // 破棄済み個体への再購読は起きない。最新だけが購読可能である。
  const active = seen.filter((session) => !isDisposed(session));
  expect(active).toEqual([latest]);
});

test("アンマウントで接続・購読を終え、以降の操作を拒否する", async () => {
  mount("ws://127.0.0.1:3100/v1", true);
  const latest = seen[seen.length - 1];
  expect(isDisposed(latest)).toBe(false);
  let notified = 0;
  const unsubscribe = latest.subscribe(() => {
    notified += 1;
  });
  act(() => {
    root?.unmount();
  });
  root = null;
  unsubscribe();
  expect(isDisposed(latest)).toBe(true);
  expect(notified).toBe(0);
  await expect(latest.connect()).rejects.toMatchObject({ code: "DISPOSED" });
});

test("接続先の変更で旧個体を破棄して新規生成する", () => {
  mount("ws://127.0.0.1:3100/v1", false);
  expect(seen.length).toBe(1);
  const first = seen[0];
  rerender("ws://127.0.0.1:3101/v1", false);
  expect(seen.length).toBe(2);
  expect(isDisposed(first)).toBe(true);
  expect(seen[1].getSnapshot().endpoint).toBe("ws://127.0.0.1:3101/v1");
  expect(isDisposed(seen[1])).toBe(false);
});

test("認証前の echo・ping は結合物でも禁止する", async () => {
  mount("ws://127.0.0.1:3100/v1", false);
  const latest = seen[seen.length - 1];
  await expect(latest.runEcho()).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
  await expect(latest.runPing()).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
});
