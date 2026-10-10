/**
 * ブラウザ確認用の常駐サーバ（人間が実機で試す相手方）。
 *
 * 実行: `pnpm --filter yamux-spike run spike-server`
 * 127.0.0.1:5180 で待ち受け、プリリュード→mux→echo 応答する。
 *
 * @packageDocumentation
 */

import { WebSocketServer } from "ws";
import type { YamuxStream } from "@chainsafe/libp2p-yamux/stream";
import { attachMuxer, createPeerLogs, waitForInboundStream } from "./peer.ts";
import { runPreludeServer } from "./prelude.ts";
import { FrameDecoder, encodeFrameJson } from "./framing.ts";
import { readChunk } from "./peer.ts";

const PORT = 5180;
const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });

/** 受けた framing 値をそのまま返す echo 応答を回す。 */
async function serveEcho(stream: YamuxStream): Promise<void> {
  const decoder = new FrameDecoder();
  try {
    for (;;) {
      const chunk = await readChunk(stream, 60_000);
      const values = decoder.push(chunk);
      for (const value of values) stream.send(encodeFrameJson({ echo: value }));
    }
  } catch {
    // stream 終了・サーバ停止で抜ける。
  }
}

wss.on("connection", (ws) => {
  console.log("接続を受けた。プリリュードを開始する。");
  void (async () => {
    try {
      await runPreludeServer(ws);
      console.log("認可（auth_ok 送出）完了。mux を開始する。");
      const logs = createPeerLogs("spike-server");
      const muxer = attachMuxer(ws, "inbound", logs, undefined, { enableKeepAlive: false });
      for (;;) {
        const stream = await waitForInboundStream(muxer, 60_000);
        console.log(`stream を受けた id=${stream.streamId}`);
        void serveEcho(stream);
      }
    } catch (cause) {
      console.log(`接続処理が終わった: ${cause instanceof Error ? cause.message : String(cause)}`);
      ws.close();
    }
  })();
});

wss.on("listening", () => {
  console.log(`spike-server が待ち受け中: ws://127.0.0.1:${PORT}/spike`);
});
