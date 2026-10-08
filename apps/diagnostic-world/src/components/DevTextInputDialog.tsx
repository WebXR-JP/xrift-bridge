/**
 * 開発用の文字入力アダプター。開発エントリ専用であり、本番 `./World` から
 * import しないこと。
 *
 * 既定実装（request を console に出し `window.prompt` を使う）の代わりに、
 * 開発文書の自ツリー内の対話板で入力を受け付ける。request・入力値の console
 * 出力はしない。入力欄は `password` で覆い隠し、確定・取消の直後に入力状態を
 * 消す。完了値は呼び出し元の `onSubmit` に直接渡し、ここに残さない。
 *
 * @packageDocumentation
 */
import { useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { TextInputContextValue, TextInputRequest } from "@xrift/world-components";

/** アダプターの対話板つき実装。 */
export interface DevTextInputAdapter {
  /** `XRiftProvider` の `textInputImplementation` に渡す値。 */
  readonly implementation: TextInputContextValue;
  /** 開発ツリーに置く対話板の要素。自所有 DOM の範囲に描く。 */
  readonly dialog: React.JSX.Element;
}

/**
 * 開発用の文字入力アダプターを作る。
 *
 * @returns ホストへ渡す実装と自ツリーに置く対話板。
 */
export function useDevTextInputAdapter(): DevTextInputAdapter {
  const [pending, setPending] = useState<TextInputRequest | null>(null);
  const [value, setValue] = useState<string>("");
  const pendingRef = useRef<TextInputRequest | null>(null);

  const implementation = useMemo<TextInputContextValue>(
    () => ({
      // ADR: 既定実装は request を console に出す。開発板では出さず、
      // 自ツリーの対話板だけで受け付ける。
      requestTextInput: (request: TextInputRequest) => {
        pendingRef.current?.onCancel?.();
        pendingRef.current = request;
        setValue("");
        setPending(request);
      },
      isActive: pending !== null,
    }),
    [pending],
  );

  const clear = (): void => {
    pendingRef.current = null;
    setValue("");
    setPending(null);
  };

  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault();
    const request = pendingRef.current;
    const input = value;
    // ADR: 秘密値かもしれない完了値は状態に残さず、引数のまま渡して消す。
    clear();
    request?.onSubmit(input);
  };

  const handleCancel = (): void => {
    const request = pendingRef.current;
    clear();
    request?.onCancel?.();
  };

  const dialog =
    pending === null ? (
      <></>
    ) : (
      <div className="diag-textinput-overlay" role="dialog" aria-label="文字入力">
        <form className="diag-textinput-box" onSubmit={handleSubmit} onReset={handleCancel}>
          <p className="diag-textinput-title">{pending.placeholder ?? "文字を入力"}</p>
          <input
            className="diag-textinput-field"
            type="password"
            autoComplete="off"
            maxLength={pending.maxLength}
            value={value}
            autoFocus
            onChange={(event) => {
              setValue(event.target.value);
            }}
          />
          <div className="diag-buttons">
            <button type="submit">決定</button>
            <button type="reset">取消</button>
          </div>
        </form>
      </div>
    );

  return { implementation, dialog };
}
