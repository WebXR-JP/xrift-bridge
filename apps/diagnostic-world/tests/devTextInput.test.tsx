// @vitest-environment happy-dom
/**
 * 開発用の文字入力の対話板の検証。入力・取消と秘密値の扱いを確かめる。
 *
 * 自ツリーの要素だけを使い、console・`window.prompt` を使わない。
 */
import { afterEach, expect, test, vi } from "vite-plus/test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  useDevTextInputAdapter,
  type DevTextInputAdapter,
} from "../src/components/DevTextInputDialog.tsx";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let adapter: DevTextInputAdapter | null = null;
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

function Host(): React.JSX.Element {
  adapter = useDevTextInputAdapter();
  return <>{adapter.dialog}</>;
}

function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<Host />);
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  adapter = null;
  vi.restoreAllMocks();
});

/** 対話板の入力欄を探す。無い場合は null。 */
function findField(): HTMLInputElement | null {
  return document.querySelector(".diag-textinput-field") as HTMLInputElement | null;
}

/** 入力欄に値を流し込む（制御入力の変更通知つき）。 */
function typeInto(field: HTMLInputElement, text: string): void {
  act(() => {
    // 制御入力へ反映させるため、原型の値設定子で書いて input 事象を送る。
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
      field,
      text,
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("入力の決定で完了値を渡し、対話板を閉じる", () => {
  mount();
  const onSubmitCalls: string[] = [];
  act(() => {
    adapter?.implementation.requestTextInput({
      id: "diag-secret-input",
      placeholder: "ペアリング秘密値を入力",
      onSubmit: (value) => {
        onSubmitCalls.push(value);
      },
    });
  });
  const field = findField();
  expect(field).not.toBeNull();
  // 覆い隠しであり、初期値に秘密が入らない。
  expect(field?.type).toBe("password");
  expect(field?.value).toBe("");
  typeInto(field as HTMLInputElement, "s3cr3t-value");
  act(() => {
    document
      .querySelector(".diag-textinput-box")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(onSubmitCalls).toEqual(["s3cr3t-value"]);
  expect(findField()).toBeNull();
});

test("取消では完了を渡さず、対話板を閉じる", () => {
  mount();
  let submitted = 0;
  let cancelled = 0;
  act(() => {
    adapter?.implementation.requestTextInput({
      id: "diag-secret-input",
      onSubmit: () => {
        submitted += 1;
      },
      onCancel: () => {
        cancelled += 1;
      },
    });
  });
  const field = findField();
  expect(field).not.toBeNull();
  typeInto(field as HTMLInputElement, "s3cr3t-value");
  act(() => {
    document
      .querySelector(".diag-textinput-box")
      ?.dispatchEvent(new Event("reset", { bubbles: true }));
  });
  expect(submitted).toBe(0);
  expect(cancelled).toBe(1);
  expect(findField()).toBeNull();
});

test("入力の要求・完了で console に出さない", () => {
  mount();
  const logged: unknown[][] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args);
  });
  act(() => {
    adapter?.implementation.requestTextInput({
      id: "diag-secret-input",
      placeholder: "ペアリング秘密値を入力",
      onSubmit: () => {},
    });
  });
  const field = findField();
  expect(field).not.toBeNull();
  typeInto(field as HTMLInputElement, "s3cr3t-value");
  act(() => {
    document
      .querySelector(".diag-textinput-box")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(spy).not.toHaveBeenCalled();
  expect(JSON.stringify(logged)).not.toContain("s3cr3t-value");
});

test("要求の置き換えでは旧要求を取り消す", () => {
  mount();
  let cancelled = 0;
  act(() => {
    adapter?.implementation.requestTextInput({
      id: "first",
      placeholder: "最初",
      onSubmit: () => {},
      onCancel: () => {
        cancelled += 1;
      },
    });
  });
  expect(document.querySelector(".diag-textinput-title")?.textContent).toBe("最初");
  act(() => {
    adapter?.implementation.requestTextInput({
      id: "second",
      placeholder: "次",
      onSubmit: () => {},
    });
  });
  expect(cancelled).toBe(1);
  expect(document.querySelector(".diag-textinput-title")?.textContent).toBe("次");
});
