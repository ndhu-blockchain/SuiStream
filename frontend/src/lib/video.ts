import { fetchFile } from "@ffmpeg/util";
import type { FFmpeg } from "@ffmpeg/ffmpeg";

interface VideoSegment {
  name: string;
  data: Uint8Array;
  duration: number;
}

async function reEncodingSplitVideo(
  ffmpegInstance: FFmpeg,
  videoFile: File,
  splitDuration: number,
  setProgress: (progress: number) => void,
  setStatusText: (text: string) => void
): Promise<{ segments: VideoSegment[]; coverFile: File }> {
  // 重新編碼並切割為為 h264
  // 切割為 splitDuration 秒一片段之 .ts 檔案
  // 回傳所有片段檔案與m3u8播放清單檔案
  // 取第一張影片封面作為縮圖
  const inputFileName = "input.mp4";
  const outputPattern = "segment_%03d.ts";

  // 寫入輸入影片
  setStatusText("Writing file...");
  setProgress(5);
  await ffmpegInstance.writeFile(inputFileName, await fetchFile(videoFile));

  console.debug("Starting FFmpeg splitting (copy mode)...");
  setStatusText("Splitting...");

  ffmpegInstance.on("progress", ({ progress }) => {
    const percentage = 5 + progress * 35; // Map 0-1 to 5-40%
    setProgress(Math.round(percentage));
  });

  // FFmpeg 不重新編碼 (Copy) 並分割成 .ts 片段
  // 注意：使用 copy 模式時，切割點會受限於原始影片的關鍵影格 (Keyframe) 位置，
  // 因此片段長度可能不會精確等於 splitDuration。
  const ret = await ffmpegInstance.exec([
    "-i",
    inputFileName,
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-hls_time",
    splitDuration.toString(),
    "-hls_list_size",
    "0", // 0 代表保留所有片段在 m3u8 中，避免只保留最後幾個片段
    "-hls_segment_filename",
    outputPattern, // 確保格式如 "segment_%03d.ts"
    "-f",
    "hls",
    "output.m3u8",
  ]);

  if (ret !== 0) {
    throw new Error("Video format not supported. Please use H.264/AAC MP4.");
  }

  // 取縮圖
  console.debug("Generating thumbnail...");
  setStatusText("Generating thumbnail...");
  setProgress(40);
  await ffmpegInstance.exec([
    "-i",
    inputFileName,
    "-ss",
    "00:00:01.000",
    "-vframes",
    "1",
    "cover.png",
  ]);

  console.debug("FFmpeg processing completed.");

  // 列出虛擬文件系統中的所有檔案
  setStatusText("Reading segments...");
  setProgress(40);
  try {
    const files = await ffmpegInstance.listDir("/");
    console.debug("Files in FFmpeg virtual filesystem:", files);
  } catch (e) {
    console.warn("Failed to list directory:", e);
  }

  // 取 m3u8 播放清單
  const playlistData = await ffmpegInstance.readFile("output.m3u8");
  const playlist =
    typeof playlistData === "string"
      ? playlistData
      : new TextDecoder().decode(playlistData);

  console.debug("Generated playlist:", playlist);

  // 解析 m3u8 提取片段時間和檔名
  const extinf = playlist.match(/#EXTINF:([\d.]+)/g) || [];
  const durations = extinf.map((line) =>
    parseFloat(line.replace("#EXTINF:", ""))
  );

  console.debug("Segment durations:", durations);

  // 取所有片段檔名
  const segmentNames = Array.from(playlist.matchAll(/segment_\d+\.ts/g)).map(
    (m) => m[0]
  );

  console.debug("Segment names:", segmentNames);

  // 讀取所有片段
  const segments: VideoSegment[] = [];
  for (let i = 0; i < segmentNames.length; i++) {
    const segmentName = segmentNames[i];
    const segmentDataRaw = await ffmpegInstance.readFile(segmentName);
    const segmentData =
      typeof segmentDataRaw === "string"
        ? new TextEncoder().encode(segmentDataRaw)
        : segmentDataRaw;
    segments.push({
      name: segmentName,
      data: segmentData,
      duration: durations[i] || 0,
    });
  }

  console.debug("Extracted segments:", segments);

  // 清理臨時檔
  setStatusText("Cleaning up...");
  setProgress(40);
  ffmpegInstance.deleteFile(inputFileName);
  ffmpegInstance.deleteFile("output.m3u8");
  segmentNames.forEach((name) => {
    try {
      ffmpegInstance.deleteFile(name);
    } catch {
      // 忽略刪除錯誤
    }
  });

  console.debug("Temporary files cleaned up.");

  const coverData = await ffmpegInstance.readFile("cover.png");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const coverFile = new File([coverData as any], "cover.png", {
    type: "image/png",
  });
  ffmpegInstance.deleteFile("cover.png");

  return { segments, coverFile };
}

async function aesEncryptSegments(
  segments: VideoSegment[],
  setProgress: (progress: number) => void,
  setStatusText: (text: string) => void
): Promise<{ segments: VideoSegment[]; key: Uint8Array }> {
  // 產生一 AES-128 加密金鑰逐一加密每個 .ts 檔案
  // 回傳加密後的片段與金鑰
  const cryptoKey = await window.crypto.subtle.generateKey(
    {
      name: "AES-CBC",
      length: 128,
    },
    true,
    ["encrypt", "decrypt"]
  );

  console.debug("Generated AES-128 crypto key:", cryptoKey);

  setStatusText("Encrypting segments...");
  setProgress(40);

  const rawKey = await window.crypto.subtle.exportKey("raw", cryptoKey);
  console.debug("Generated AES-128 key:", new Uint8Array(rawKey));

  let processedCount = 0;
  for (const segment of segments) {
    processedCount++;
    setStatusText(`Encrypting segment ${processedCount}/${segments.length}...`);
    const percentage = 40 + (processedCount / segments.length) * 50;
    setProgress(Math.round(percentage));

    // 使用隨機 IV
    const iv = window.crypto.getRandomValues(new Uint8Array(16));
    console.debug(
      `Segment ${segment.name} raw size: ${segment.data.byteLength}`
    );
    const encryptedData = await window.crypto.subtle.encrypt(
      {
        name: "AES-CBC",
        iv: iv,
      },
      cryptoKey,
      segment.data as BufferSource
    );
    console.debug(
      `Segment ${segment.name} encrypted size: ${encryptedData.byteLength}`
    );
    // 將加密後的資料與 IV 組合起來存放
    const encryptedArray = new Uint8Array(encryptedData);
    const combinedData = new Uint8Array(iv.length + encryptedArray.length);
    combinedData.set(iv, 0);
    combinedData.set(encryptedArray, iv.length);
    segment.data = combinedData;
    console.debug(
      `Segment ${segment.name} encrypted, size: ${combinedData.length}`
    );
  }

  return { segments, key: new Uint8Array(rawKey) };
}

async function mergeTSGenerateM3U8(
  segments: VideoSegment[],
  segmentDuration: number,
  setProgress: (progress: number) => void,
  setStatusText: (text: string) => void
): Promise<{ m3u8Content: string; mergedData: Uint8Array }> {
  // 合併所有 TS 片段並產生對應的 byterange m3u8 播放清單檔案
  setStatusText("Generating m3u8 playlist...");
  setProgress(90);

  const totalLength = segments.reduce((acc, seg) => acc + seg.data.length, 0);
  const mergedData = new Uint8Array(totalLength);

  let m3u8Content = "#EXTM3U\n#EXT-X-VERSION:3\n";
  m3u8Content += `#EXT-X-TARGETDURATION:${Math.ceil(segmentDuration)}\n`;
  m3u8Content += "#EXT-X-MEDIA-SEQUENCE:0\n";
  m3u8Content += `#EXT-X-KEY:METHOD=AES-128,URI="video.key"\n`;

  let byteOffset = 0;
  for (const segment of segments) {
    const segmentSize = segment.data.length;
    mergedData.set(segment.data, byteOffset);

    m3u8Content += `#EXTINF:${segment.duration.toFixed(3)},\n`;
    m3u8Content += `#EXT-X-BYTERANGE:${segmentSize}@${byteOffset}\n`;
    m3u8Content += `video.bin\n`;
    byteOffset += segmentSize;
  }

  m3u8Content += "#EXT-X-ENDLIST\n";

  console.debug("Generated m3u8 content:", m3u8Content);

  return { m3u8Content, mergedData };
}

export { reEncodingSplitVideo, aesEncryptSegments, mergeTSGenerateM3U8 };
export type { VideoSegment };
