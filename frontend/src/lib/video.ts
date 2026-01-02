import { fetchFile } from "@ffmpeg/util";
import type { FFmpeg } from "@ffmpeg/ffmpeg";

// ============================================================================
// 影片前處理
//
// 目標
// - 產出一個可被 HLS 播放器讀取的 m3u8，但「實際影片資料」會被合併成單一 blob：video.bin
// - m3u8 透過 `#EXT-X-BYTERANGE` 指向 video.bin 的不同位移
// - 加密使用 AES-128（AES-CBC）；每個 segment 使用獨立 IV，並在 m3u8 中為每段寫入 `#EXT-X-KEY`
//
// 搭配播放端
// - m3u8 內的 key URI 固定為 "video.key"，播放端會攔截此請求並回傳「解密後的 key」
// - m3u8 內的 media URI 固定為 "video.bin"，播放端會攔截並導向 Walrus Aggregator 的 video blob
// ============================================================================

interface VideoSegment {
  name: string;
  data: Uint8Array;
  duration: number;
  iv?: Uint8Array;
}

async function reEncodingSplitVideo(
  ffmpegInstance: FFmpeg,
  videoFile: File,
  splitDuration: number,
  setProgress: (progress: number) => void,
  setStatusText: (text: string) => void
): Promise<{ segments: VideoSegment[]; coverFile: File }> {
  // 重新編碼/切割影片
  // - 使用 FFmpeg.wasm 在瀏覽器端處理
  // - 這裡用 HLS muxer 產生 `.ts` 片段與暫時的 `output.m3u8`
  // - 我們最後不直接沿用 output.m3u8，而是「讀片段 + 片段時長」後自行生成 BYTERANGE m3u8
  // - 同時抓取一張封面圖（thumbnail / cover）
  const inputFileName = "input.mp4";
  const outputPattern = "segment_%03d.ts";

  // 寫入輸入影片到 FFmpeg 虛擬檔案系統
  setStatusText("Writing file...");
  setProgress(5);
  await ffmpegInstance.writeFile(inputFileName, await fetchFile(videoFile));

  console.debug("Starting FFmpeg splitting (copy mode)...");
  setStatusText("Splitting...");

  ffmpegInstance.on("progress", ({ progress }) => {
    const percentage = 5 + progress * 35; // Map 0-1 to 5-40%
    setProgress(Math.round(percentage));
  });

  // FFmpeg 不重新編碼（Copy）並分割成 .ts 片段
  // 注意（Note）：copy 模式的切割點受限於關鍵影格（keyframe），
  // 因此實際片段時長可能不會精確等於 splitDuration。
  const ret = await ffmpegInstance.exec([
    "-i",
    inputFileName,
    "-c:v",
    // 不重新編碼
    "copy",
    // 重編成 h264(很慢)
    // "libx264",
    "-c:a",
    "aac",
    "-hls_time",
    splitDuration.toString(),
    "-hls_list_size",
    "0", // 0 代表保留所有片段在 m3u8 中 避免只保留最後幾個片段
    "-hls_segment_filename",
    outputPattern, // 格式如 "segment_%03d.ts"
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

  // 列出虛擬文件系統中的所有檔案（除錯用）
  setStatusText("Reading segments...");
  setProgress(40);
  try {
    const files = await ffmpegInstance.listDir("/");
    console.debug("Files in FFmpeg virtual filesystem:", files);
  } catch (e) {
    console.warn("Failed to list directory:", e);
  }

  // 取暫時 m3u8 播放清單
  // 我們只用它來：
  // - 取片段檔名（segment_###.ts）
  // - 取每段 EXTINF 時長
  const playlistData = await ffmpegInstance.readFile("output.m3u8");
  const playlist =
    typeof playlistData === "string"
      ? playlistData
      : new TextDecoder().decode(playlistData);

  console.debug("Generated playlist:", playlist);

  // 解析 m3u8 提取片段時間（EXTINF）
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
  // `ffmpeg.readFile()` 可能回傳帶有 ArrayBufferLike 的 Uint8Array view。
  // 這會讓 TS 在 `new File([bytes])` 時抱怨 BlobPart 型別不相容。
  // 這裡用 `Uint8Array.from()` materialize 成標準 ArrayBuffer-backed 的 Uint8Array。
  const coverBytes =
    typeof coverData === "string"
      ? new TextEncoder().encode(coverData)
      : Uint8Array.from(coverData);
  const coverFile = new File([coverBytes], "cover.png", {
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
  // 產生 AES-128 金鑰並逐段加密
  // - HLS `METHOD=AES-128` 使用 16-byte key + CBC 模式（AES-CBC）
  // - 每個 segment 使用獨立的隨機 IV
  // - 回傳 raw key（Uint8Array, 16 bytes）與加密後片段（encrypted bytes + iv）
  const cryptoKey = await window.crypto.subtle.generateKey(
    {
      name: "AES-CBC",
      length: 128,
    },
    true,
    ["encrypt", "decrypt"]
  );

  // console.debug("Generated AES-128 crypto key:", cryptoKey);

  setStatusText("Encrypting segments...");
  setProgress(40);

  const rawKey = await window.crypto.subtle.exportKey("raw", cryptoKey);
  // console.debug("Generated AES-128 key:", new Uint8Array(rawKey));

  let processedCount = 0;
  for (const segment of segments) {
    processedCount++;
    setStatusText(`Encrypting segment ${processedCount}/${segments.length}...`);
    const percentage = 40 + (processedCount / segments.length) * 50;
    setProgress(Math.round(percentage));

    // 使用隨機 IV（16 bytes）
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
    // 將加密後的資料存回，並記錄 IV
    segment.data = new Uint8Array(encryptedData);
    segment.iv = iv;
    console.debug(
      `Segment ${segment.name} encrypted, size: ${segment.data.length}`
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
  // 合併所有片段並產生 BYTERANGE m3u8
  //
  // 為什麼要合併？
  // - Walrus 對大量小檔（很多 segment）會增加註冊與上傳筆數，成本與簽名次數都會飆升
  // - 因此我們把所有 segment 串成單一 `video.bin`，再用 `#EXT-X-BYTERANGE` 讓播放器按位移抓取
  //
  // 加密 key URI
  // - m3u8 內的 `URI="video.key"` 是「占位符」（placeholder）
  // - 播放端（video-player）會攔截 key 請求並回傳解密後的 AES key
  setStatusText("Generating m3u8 playlist...");
  setProgress(90);

  const totalLength = segments.reduce((acc, seg) => acc + seg.data.length, 0);
  const mergedData = new Uint8Array(totalLength);

  let m3u8Content = "#EXTM3U\n#EXT-X-VERSION:3\n";
  m3u8Content += `#EXT-X-TARGETDURATION:${Math.ceil(segmentDuration)}\n`;
  m3u8Content += "#EXT-X-MEDIA-SEQUENCE:0\n";

  let byteOffset = 0;
  for (const segment of segments) {
    const segmentSize = segment.data.length;
    mergedData.set(segment.data, byteOffset);

    if (segment.iv) {
      // 每段寫一個 EXT-X-KEY，讓播放器對應使用不同 IV
      const ivHex = Array.from(segment.iv)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      m3u8Content += `#EXT-X-KEY:METHOD=AES-128,URI="video.key",IV=0x${ivHex}\n`;
    }

    m3u8Content += `#EXTINF:${segment.duration.toFixed(3)},\n`;
    // 透過 BYTERANGE 指向合併後的單一檔（video.bin）
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
