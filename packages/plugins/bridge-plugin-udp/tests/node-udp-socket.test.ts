/**
 * 既定 factory（`node:dgram` 背負い）の実ソケット試験。
 *
 * 偽ソケットでは再現しない OS との相互作用（bind 確定・受信配送・係争・
 * 閉塞）を確かめる。ポートは一時 bind で空きを調達してから使う（本体が
 * `0` を拒否するため）。使い終わったソケットは必ず閉じ、送受データは
 * macOS の `net.inet.udp.maxdgram=9216` 以下にする。
 *
 * @packageDocumentation
 */
import dgram from "node:dgram";
import { expect, test } from "vite-plus/test";
import { createNodeUdpSocket, UdpSocketClosedError } from "../src/node-udp-socket.ts";

/** 一時 bind で空きポートを調達する。 */
function 空きポート確保(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const 調達 = dgram.createSocket("udp4");
    調達.once("error", (原因: Error) => {
      try {
        調達.close();
      } catch {
        // 閉塞の失敗は調達の失敗に含めない。
      }
      reject(原因);
    });
    調達.bind(0, "127.0.0.1", () => {
      const 実際 = 調達.address();
      const ポート = typeof 実際 === "string" ? 0 : 実際.port;
      調達.close(() => {
        if (ポート === 0) {
          reject(new Error("空きポートを調達できない。"));
          return;
        }
        resolve(ポート);
      });
    });
  });
}

/**
 * 約束に期限を付ける。
 *
 * 期限切れは試験の失敗であり、未解決の約束を残したまま次へ進まない
 * ための口である（bind 途中の close の回帰など）。
 *
 * @param 約束 - 待つ対象。
 * @param 期限ミリ秒 - 有限時間の上限。
 * @param 説明 - 期限切れ時の失敗説明。
 * @returns 対象の決着値。期限切れ時は拒否する。
 */
async function 有限待ち<T>(約束: Promise<T>, 期限ミリ秒: number, 説明: string): Promise<T> {
  let 計時: ReturnType<typeof setTimeout> | undefined;
  const 期限切れ = new Promise<never>((_, 拒否) => {
    計時 = setTimeout(() => {
      拒否(new Error(説明));
    }, 期限ミリ秒);
  });
  try {
    return await Promise.race([約束, 期限切れ]);
  } finally {
    clearTimeout(計時);
  }
}

/**
 * bind の決着を失敗値として捕まえる。
 *
 * @param 約束 - 決着を待つ bind 約束。
 * @returns 成功時は `null`、失敗時は原因。
 */
function 失敗捕捉(約束: Promise<unknown>): Promise<unknown> {
  return 約束.then(
    () => null,
    (原因: unknown) => 原因,
  );
}

test("実ソケットでbindして受信し閉塞できる", async () => {
  const ポート = await 空きポート確保();
  const 受信側 = createNodeUdpSocket({ type: "udp4" });
  try {
    const 確定 = await 有限待ち(受信側.bind("127.0.0.1", ポート), 2000, "bind が確定しない。");
    expect(確定.port).toBe(ポート);
    expect(確定.family).toBe("IPv4");
    const 送信内容 = new Uint8Array(1024).map((_, 番号) => 番号 % 256);
    const 到着 = new Promise<{ data: Uint8Array; rinfo: { address: string; port: number } }>(
      (resolve) => {
        const 解除 = 受信側.onMessage((data, rinfo) => {
          解除();
          resolve({ data, rinfo });
        });
      },
    );
    const 送信側 = dgram.createSocket("udp4");
    try {
      await new Promise<void>((resolve, 拒否) => {
        送信側.send(送信内容, ポート, "127.0.0.1", (原因) => {
          if (原因) {
            拒否(原因);
            return;
          }
          resolve();
        });
      });
      const 受信 = await 有限待ち(到着, 2000, "受信が届かない。");
      expect(受信.data).toEqual(送信内容);
      expect(受信.rinfo.address).toBe("127.0.0.1");
    } finally {
      送信側.close();
    }
  } finally {
    await 受信側.close();
  }
});

test("確定前のcloseはbindを有限時間で取り消す", async () => {
  // bind 途中の close で `bind()` が未解決のまま残る回帰を防ぐ。
  const ポート = await 空きポート確保();
  const 対象 = createNodeUdpSocket({ type: "udp4" });
  try {
    const 束縛中 = 対象.bind("127.0.0.1", ポート);
    await 対象.close();
    const 失敗 = await 有限待ち(失敗捕捉(束縛中), 1000, "bind が有限時間で決着しない。");
    expect(失敗).toBeInstanceOf(UdpSocketClosedError);
  } finally {
    await 対象.close();
  }
});

test("同一ポートへの二重bindはEADDRINUSE相当で失敗する", async () => {
  const ポート = await 空きポート確保();
  const 先勝 = createNodeUdpSocket({ type: "udp4" });
  const 後攻 = createNodeUdpSocket({ type: "udp4" });
  try {
    await 有限待ち(先勝.bind("127.0.0.1", ポート), 2000, "先の bind が確定しない。");
    const 失敗 = await 有限待ち(
      失敗捕捉(後攻.bind("127.0.0.1", ポート)),
      2000,
      "後の bind が決着しない。",
    );
    expect(失敗).toBeInstanceOf(Error);
    const 符号 = 失敗 instanceof Error && "code" in 失敗 ? 失敗.code : undefined;
    expect(符号).toBe("EADDRINUSE");
  } finally {
    await 先勝.close();
    await 後攻.close();
  }
});

test("closeの二重呼びは例外を出さず同一ポートへ再bindできる", async () => {
  const ポート = await 空きポート確保();
  const 初代 = createNodeUdpSocket({ type: "udp4" });
  await 有限待ち(初代.bind("127.0.0.1", ポート), 2000, "初の bind が確定しない。");
  await 初代.close();
  // 二重 close は例外を出さない（同じ完了を返す）。
  await 初代.close();
  const 二代目 = createNodeUdpSocket({ type: "udp4" });
  try {
    const 確定 = await 有限待ち(二代目.bind("127.0.0.1", ポート), 2000, "再 bind が確定しない。");
    expect(確定.port).toBe(ポート);
  } finally {
    await 二代目.close();
  }
});

test("係争bind中にcloseするとbindが取り消される", async () => {
  const ポート = await 空きポート確保();
  const 先勝 = createNodeUdpSocket({ type: "udp4" });
  const 後攻 = createNodeUdpSocket({ type: "udp4" });
  try {
    await 有限待ち(先勝.bind("127.0.0.1", ポート), 2000, "先の bind が確定しない。");
    const 束縛中 = 後攻.bind("127.0.0.1", ポート);
    await 後攻.close();
    const 失敗 = await 有限待ち(失敗捕捉(束縛中), 1000, "係争中の bind が有限時間で決着しない。");
    // 閉塞取消と係争失敗のいずれで決着してもよいが、未解決のまま残さない。
    expect(失敗).toBeInstanceOf(Error);
  } finally {
    await 先勝.close();
    await 後攻.close();
  }
});
