import { cutVideoToTS } from "@/lib/ffmpeg";
import { generateAESKey, encryptAES128 } from "@/lib/aes";
import { VIDEO_TIME_INTERVAL } from "@/lib/strategy";

export function useVideoProcessor() {
  async function processVideo(
    file: File,
    signal?: AbortSignal
  ) {
    const tsFiles = await cutVideoToTS(file, VIDEO_TIME_INTERVAL);
    const key = generateAESKey();
    const iv = new Uint8Array(16); // 註：全 0 IV

    const processedFiles: Uint8Array[] = [];
    
    // 遍歷所有檔案，無條件加密
    for (let idx = 0; idx < tsFiles.length; idx++) {
      if (signal?.aborted) {
        throw new Error("Video processing cancelled");
      }

      const data = tsFiles[idx];
      
      // 直接加密二進位資料
      const processedData = await encryptAES128(data, key, iv);
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
      // 這裡依然生成 m3u8，但因為資料已加密，播放器需要 key 才能播放
      m3u8 += `#EXTINF:${VIDEO_TIME_INTERVAL}.0,\n#EXT-X-BYTERANGE:${f.length}@${offset}\nvideo.bin\n`;
      offset += f.length;
    }
    m3u8 += "#EXT-X-ENDLIST";

    return { videoBin, m3u8, key };
  }

  return { processVideo };
}
