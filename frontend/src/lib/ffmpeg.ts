import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";

async function ffmpegInstance(): Promise<{ ffmpeg: FFmpeg }> {
  const baseURL = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
  const ffmpeg = new FFmpeg();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ffmpeg.on("log", (e: any) => {
    console.debug(e);
  });

  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
  });

  return { ffmpeg };
}

export { ffmpegInstance };
