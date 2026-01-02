import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";

// FFmpeg.wasm 載入器
//
// 為什麼用 toBlobURL？
// - 直接從 CDN 取 core/wasm，並轉成 Blob URL，避免某些環境下的 CORS / MIME 類型問題
// - 也避免 Vite / SPA routing 把 wasm 請求導到 index.html
//
// 注意
// - 這裡使用 CDN 的 @ffmpeg/core 版本需與 @ffmpeg/ffmpeg 相容
// - 首次載入可能較慢，建議在 UI 上有清楚的進度/提示

async function ffmpegInstance(): Promise<{ ffmpeg: FFmpeg }> {
  const baseURL = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
  const ffmpeg = new FFmpeg();
  ffmpeg.on("log", (e) => {
    console.debug(e);
  });

  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
  });

  return { ffmpeg };
}

export { ffmpegInstance };
