import { cutVideoToTS } from "@/lib/ffmpeg";
import { generateAESKey, encryptAES128ToBase64 } from "@/lib/aes";
import { VIDEO_TIME_INTERVAL } from "@/lib/strategy";

export function useVideoProcessor() {
  async function processVideo(
    file: File,
    previewSegments: number,
    signal?: AbortSignal
  ) {
    const tsFiles = await cutVideoToTS(file, VIDEO_TIME_INTERVAL);
    const key = generateAESKey();
    const iv = new Uint8Array(16);

    const processedFiles = [];
    for (let idx = 0; idx < tsFiles.length; idx++) {
      if (signal?.aborted) {
        throw new Error("Video processing cancelled");
      }

      const data = tsFiles[idx];
      let processedData: Uint8Array;

      if (idx >= previewSegments) {
        const base64 = await encryptAES128ToBase64(
          new TextDecoder().decode(data),
          key,
          iv
        );
        processedData = new Uint8Array(
          atob(base64)
            .split("")
            .map((c) => c.charCodeAt(0))
        );
      } else {
        processedData = data;
      }

      processedFiles.push(processedData);
    }

    const totalLength = processedFiles.reduce((acc, f) => acc + f.length, 0);
    const videoBin = new Uint8Array(totalLength);
    let offset = 0;
    for (const f of processedFiles) {
      videoBin.set(f, offset);
      offset += f.length;
    }

    let m3u8 = "#EXTM3U\n#EXT-X-VERSION:3\n";
    offset = 0;
    for (const f of processedFiles) {
      m3u8 += `#EXTINF:${VIDEO_TIME_INTERVAL}.0,\n#EXT-X-BYTERANGE:${f.length}@${offset}\nvideo.bin\n`;
      offset += f.length;
    }
    m3u8 += "#EXT-X-ENDLIST";

    return { videoBin, m3u8, key };
  }

  return { processVideo };
}
