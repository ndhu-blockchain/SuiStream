"use client";

import { useState, useRef, useEffect } from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Progress } from "@/components/ui/progress";

interface ProcessingState {
  isProcessing: boolean;
  progress: number;
  status: string;
  binSize: number | null;
  error: string | null;
}

export default function Upload() {
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<ProcessingState>({
    isProcessing: false,
    progress: 0,
    status: "",
    binSize: null,
    error: null,
  });

  const ffmpegRef = useRef(new FFmpeg());
  const abortControllerRef = useRef<AbortController | null>(null);

  // 初始化 FFmpeg
  useEffect(() => {
    const init = async () => {
      const ffmpeg = ffmpegRef.current;
      if (ffmpeg.loaded) return;

      try {
        const baseURL =
          "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm";
        await ffmpeg.load({
          coreURL: await toBlobURL(
            `${baseURL}/ffmpeg-core.js`,
            "text/javascript"
          ),
          wasmURL: await toBlobURL(
            `${baseURL}/ffmpeg-core.wasm`,
            "application/wasm"
          ),
        });
      } catch (error) {
        console.error("FFmpeg initialization failed:", error);
      }
    };

    init();
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile?.type.startsWith("video/")) {
      setFile(selectedFile);
      setState((prev) => ({ ...prev, binSize: null, error: null }));
    } else {
      setState((prev) => ({ ...prev, error: "請選擇有效的影片檔案" }));
    }
  };

  const downloadFile = (
    data: Uint8Array | string,
    filename: string,
    mimeType: string
  ) => {
    console.log(
      `Downloading ${filename}, size: ${
        typeof data === "string" ? data.length : (data as any).byteLength
      }`
    );
    const blobData: BlobPart[] =
      typeof data === "string" ? [data] : [data as any];
    const blob = new Blob(blobData, { type: mimeType });
    console.log(`Blob created, actual size: ${blob.size}`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const processVideo = async () => {
    if (!file) return;

    abortControllerRef.current = new AbortController();

    try {
      setState({
        isProcessing: true,
        progress: 0,
        status: "準備中...",
        binSize: null,
        error: null,
      });

      // 讀取視頻檔案
      const fileData = await file.arrayBuffer();
      const videoBytes = new Uint8Array(fileData);
      console.log("Video file loaded, size:", videoBytes.length);

      // 定義分片參數
      const segmentDuration = 10; // 10 秒
      const totalDuration = 242; // 估計總時長（秒）
      const totalSegments = Math.ceil(totalDuration / segmentDuration);
      const bytesPerSegment = Math.floor(videoBytes.length / totalSegments);

      console.log(
        `Total segments: ${totalSegments}, bytes per segment: ${bytesPerSegment}`
      );

      // 生成 AES-128 密鑰和 IV
      setState((prev) => ({
        ...prev,
        progress: 20,
        status: "生成加密密鑰...",
      }));
      const key = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(16));

      console.log("Key generated:", key.length, "bytes");
      console.log("IV generated:", iv.length, "bytes");

      // 分片加密
      setState((prev) => ({
        ...prev,
        progress: 30,
        status: "分片加密中...",
      }));

      const encryptedSegments: Uint8Array[] = [];

      for (let i = 0; i < totalSegments; i++) {
        if (abortControllerRef.current?.signal.aborted) {
          throw new Error("操作已取消");
        }

        // 計算片段範圍
        let start = i * bytesPerSegment;
        let end =
          i === totalSegments - 1
            ? videoBytes.length
            : (i + 1) * bytesPerSegment;

        const segmentData = videoBytes.slice(start, end);
        console.log(
          `Segment ${i}: offset ${start}-${end}, size ${segmentData.length}`
        );

        // 加密片段
        const encrypted = await encryptSegment(segmentData, key, iv);
        console.log(
          `Segment ${i} encrypted: ${segmentData.length} -> ${encrypted.length}`
        );
        encryptedSegments.push(encrypted);

        const progress = 30 + (i / totalSegments) * 50;
        setState((prev) => ({
          ...prev,
          progress: Math.round(progress),
          status: `加密片段 ${i + 1}/${totalSegments}...`,
        }));
      }

      // 合併所有加密片段
      setState((prev) => ({
        ...prev,
        progress: 85,
        status: "合併片段...",
      }));

      let totalEncryptedSize = 0;
      for (const seg of encryptedSegments) {
        totalEncryptedSize += seg.length;
      }

      const binaryData = new Uint8Array(totalEncryptedSize);
      let offset = 0;
      for (const encrypted of encryptedSegments) {
        binaryData.set(encrypted, offset);
        offset += encrypted.length;
      }

      console.log("=== SUMMARY ===");
      console.log("Original size:", videoBytes.length, "bytes");
      console.log("Total encrypted size:", binaryData.length, "bytes");
      console.log(
        "Size increase:",
        binaryData.length - videoBytes.length,
        "bytes"
      );
      console.log("Total segments:", totalSegments);
      console.log("=== SUMMARY END ===");

      // 生成 byterange M3U8 播放列表
      setState((prev) => ({
        ...prev,
        progress: 90,
        status: "生成播放列表...",
      }));

      const m3u8Content = generateM3U8(
        totalSegments,
        segmentDuration,
        key,
        iv,
        encryptedSegments.map((seg) => seg.length)
      );

      console.log("M3U8 generated");

      // 自動下載所有檔案
      setState((prev) => ({
        ...prev,
        progress: 95,
        status: "下載檔案...",
      }));

      downloadFile(key, "encryption.key", "application/octet-stream");
      await new Promise((resolve) => setTimeout(resolve, 100));
      downloadFile(
        m3u8Content,
        "playlist.m3u8",
        "application/vnd.apple.mpegurl"
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      downloadFile(binaryData, "stream.bin", "application/octet-stream");

      console.log("All files downloaded");

      setState((prev) => ({
        ...prev,
        progress: 100,
        status: "完成",
        binSize: binaryData.length,
        isProcessing: false,
      }));
    } catch (error: any) {
      if (error.message !== "操作已取消") {
        setState((prev) => ({
          ...prev,
          error: error.message || "處理失敗",
          isProcessing: false,
        }));
      } else {
        setState((prev) => ({
          ...prev,
          error: "操作已取消",
          isProcessing: false,
        }));
      }
      console.error("Processing error:", error);
    }
  };

  const encryptSegment = async (
    data: Uint8Array,
    key: Uint8Array,
    iv: Uint8Array
  ): Promise<Uint8Array> => {
    console.log("=== Encryption Debug ===");
    console.log("Input data size:", data.byteLength);
    console.log("Key size:", key.byteLength);
    console.log("IV size:", iv.byteLength);

    // 驗證数据不是空的
    if (data.byteLength === 0) {
      console.error("Input data is empty!");
      return new Uint8Array(0);
    }

    try {
      // 導入密鑰 - 轉換為 ArrayBuffer
      const keyArrayBuffer = key.buffer.slice(
        key.byteOffset,
        key.byteOffset + key.byteLength
      );
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        keyArrayBuffer as ArrayBuffer,
        { name: "AES-CBC" },
        false,
        ["encrypt"]
      );
      console.log("Key imported successfully");

      // 執行加密 - 轉換 IV 和 data 為 ArrayBuffer
      const ivArrayBuffer = iv.buffer.slice(
        iv.byteOffset,
        iv.byteOffset + iv.byteLength
      );
      const dataArrayBuffer = data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength
      );

      const encrypted = await crypto.subtle.encrypt(
        { name: "AES-CBC", iv: ivArrayBuffer as ArrayBuffer },
        cryptoKey,
        dataArrayBuffer as ArrayBuffer
      );

      console.log("Encrypted result size:", encrypted.byteLength);
      console.log("Size difference:", encrypted.byteLength - data.byteLength);

      const result = new Uint8Array(encrypted);
      console.log("Final result size:", result.byteLength);
      console.log("=== Encryption Complete ===");

      return result;
    } catch (error: any) {
      console.error("Encryption error:", error.message);
      throw error;
    }
  };

  const generateM3U8 = (
    segmentCount: number,
    segmentDuration: number,
    _key: Uint8Array,
    iv: Uint8Array,
    segmentSizes: number[]
  ): string => {
    const ivHex = Array.from(iv)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    let m3u8 = "#EXTM3U\n";
    m3u8 += "#EXT-X-VERSION:3\n";
    m3u8 += `#EXT-X-TARGETDURATION:${segmentDuration}\n`;
    m3u8 += "#EXT-X-MEDIA-SEQUENCE:0\n";
    m3u8 += `#EXT-X-KEY:METHOD=AES-128,URI="encryption.key",IV=0x${ivHex}\n`;

    let byteStart = 0;
    for (let i = 0; i < segmentCount; i++) {
      const segmentSize = segmentSizes[i] || 0;
      m3u8 += `#EXTINF:${segmentDuration}.0,\n`;
      m3u8 += `#EXT-X-BYTERANGE:${segmentSize}@${byteStart}\n`;
      m3u8 += "stream.bin\n";
      byteStart += segmentSize;
    }

    m3u8 += "#EXT-X-ENDLIST\n";
    return m3u8;
  };

  const handleCancel = () => {
    abortControllerRef.current?.abort();
  };

  const handleReset = () => {
    setFile(null);
    setState({
      isProcessing: false,
      progress: 0,
      status: "",
      binSize: null,
      error: null,
    });
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-b from-background to-muted/20 p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="space-y-2 text-center">
          <h1 className="text-3xl font-bold">影片加密處理</h1>
          <p className="text-muted-foreground">選擇 MP4 影片進行加密轉換</p>
        </div>

        {!state.isProcessing && state.binSize === null ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="video-input">選擇影片</Label>
              <Input
                id="video-input"
                type="file"
                accept=".mp4,video/mp4"
                onChange={handleFileSelect}
                disabled={state.isProcessing}
                className="cursor-pointer"
              />
            </div>

            {file && (
              <div className="rounded-lg border bg-card p-3 text-sm">
                <p className="font-medium">{file.name}</p>
                <p className="text-muted-foreground text-xs">
                  大小: {(file.size / 1024 / 1024).toFixed(2)} MB
                </p>
              </div>
            )}

            {state.error && (
              <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                {state.error}
              </div>
            )}

            <Button
              onClick={processVideo}
              disabled={!file || state.isProcessing}
              className="w-full"
              size="lg"
            >
              開始處理
            </Button>
          </div>
        ) : state.isProcessing ? (
          <div className="space-y-4">
            <div className="flex items-center justify-center gap-3">
              <Spinner className="size-6" />
              <div className="text-sm">
                <p className="font-medium">{state.status}</p>
                <p className="text-xs text-muted-foreground">
                  進度: {state.progress}%
                </p>
              </div>
            </div>

            <Progress value={state.progress} className="h-2" />

            <Button
              onClick={handleCancel}
              variant="outline"
              className="w-full"
              disabled={!state.isProcessing}
            >
              取消
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-center">
              <p className="font-medium text-green-900">處理完成！</p>
              <p className="text-sm text-green-700 mt-1">
                二進制文件大小:{" "}
                <span className="font-bold">
                  {(state.binSize! / 1024 / 1024).toFixed(2)} MB
                </span>
              </p>
              <p className="text-xs text-green-600 mt-2">
                已下載所有文件 (.key, .m3u8, .bin)
              </p>
            </div>

            <Button onClick={handleReset} className="w-full" size="lg">
              重置
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export { Upload };
