import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { useState } from "react";
import { ffmpegInstance } from "@/lib/ffmpeg";
import {
  reEncodingSplitVideo,
  aesEncryptSegments,
  mergeTSGenerateM3U8,
} from "@/lib/video";

export default function UploadPage() {
  // 多種頁面狀態
  const [pageStatus, setPageStatus] = useState<
    | "waiting"
    | "videoSelected"
    | "videoProcessing"
    | "videoProcessSuccess"
    | "videoProcessError"
    | "waitingCover"
    | "coverSelected"
    | "uploadingWalrus"
    | "walrusUploadSuccess"
    | "walrusUploadError"
    | "uploadingSeal"
    | "sealUploadSuccess"
    | "sealUploadError"
    | "contractCalling"
    | "contractCallSuccess"
    | "contractCallError"
  >("waiting");
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoProcessingProgress, setVideoProcessingProgress] =
    useState<number>(0);
  const [videoProcessingText, setVideoProcessingText] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [encryptedSegments, setEncryptedSegments] = useState<any[]>([]);
  const [mergedVideo, setMergedVideo] = useState<Uint8Array | null>(null);
  const [aesKey, setAesKey] = useState<Uint8Array | null>(null);
  const [m3u8Content, setM3u8Content] = useState<string>("");
  const videoSplitDuration = 10; // 每個片段秒數

  const videoProcess = async (videoFile: File) => {
    setPageStatus("videoProcessing");
    setErrorMessage("");
    // load ffmpeg.wasm
    const { ffmpeg } = await ffmpegInstance().catch((err) => {
      console.error("FFmpeg load error:", err);
      setPageStatus("videoProcessError");
      setErrorMessage(err.message || "Failed to load FFmpeg");
      throw err;
    });
    setVideoProcessingProgress(5);
    setVideoProcessingText("Converter Ready");
    // 重新編碼並切割為 特定秒一片段之 .ts 檔案
    const { segments } = await reEncodingSplitVideo(
      ffmpeg,
      videoFile,
      videoSplitDuration,
      setVideoProcessingProgress,
      setVideoProcessingText
    ).catch((err) => {
      console.error("Video processing error:", err);
      setPageStatus("videoProcessError");
      setErrorMessage(err.message || "Video processing failed");
      throw err;
    });
    console.info("Video segments:", segments);
    setVideoProcessingProgress(40);
    setVideoProcessingText("Video processed");
    // 產生一 AES-128 加密金鑰逐一加密每個 .ts 檔案
    const encryptedData = await aesEncryptSegments(
      segments,
      setVideoProcessingProgress,
      setVideoProcessingText
    ).catch((err) => {
      console.error("Video encryption error:", err);
      setPageStatus("videoProcessError");
      setErrorMessage(err.message || "Video encryption failed");
      throw err;
    });
    setEncryptedSegments(encryptedData.segments);
    setAesKey(encryptedData.key);
    setVideoProcessingProgress(70);
    setVideoProcessingText("Segments encrypted");
    // 將所有 .ts 片段逐一接合同時紀錄每個片段 ByteRange
    const { m3u8Content, mergedData } = await mergeTSGenerateM3U8(
      encryptedData.segments,
      videoSplitDuration,
      setVideoProcessingProgress,
      setVideoProcessingText
    ).catch((err) => {
      console.error("M3U8 generation error:", err);
      setPageStatus("videoProcessError");
      setErrorMessage(err.message || "M3U8 generation failed");
      throw err;
    });
    // 設定三檔案至 State
    setMergedVideo(mergedData);
    setM3u8Content(m3u8Content);
    setVideoProcessingProgress(100);
    setVideoProcessingText("M3U8 generated");
    setPageStatus("videoProcessSuccess");
    // 測試用 download video.bin video.m3u8 video.key
    const downloadFile = (data: Uint8Array, filename: string) => {
      const blob = new Blob([data as any]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    };
    downloadFile(mergedData, "video.bin");
    downloadFile(
      new Uint8Array(m3u8Content.split("").map((c) => c.charCodeAt(0))),
      "video.m3u8"
    );
    downloadFile(encryptedData.key, "video.key");
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen">
      {(pageStatus === "waiting" || pageStatus === "videoSelected") && (
        <div className="flex flex-col items-center gap-4">
          {/* 等待使用者選擇影片並按下一步 */}
          <h1 className="text-2xl font-bold mb-4">Select a Video</h1>
          <Input
            type="file"
            accept=".mp4"
            onChange={(e) => {
              const file = e.target.files?.[0] ?? null;
              setVideoFile(file);
              setPageStatus("videoSelected");
            }}
          />
          <Button
            disabled={!videoFile}
            onClick={() => {
              // 取得影片
              if (!videoFile) return;
              // 開始處理影片
              videoProcess(videoFile);
            }}
          >
            Next
          </Button>
        </div>
      )}
      {pageStatus === "videoProcessing" && (
        <div className="flex flex-col items-center gap-4">
          {/* 等待影片處理中 */}
          <h1 className="text-2xl font-bold mb-4">Processing Video</h1>
          <Progress value={videoProcessingProgress} className="w-64" />
          <p>{videoProcessingText}</p>
        </div>
      )}
      {pageStatus === "videoProcessError" && (
        <div className="flex flex-col items-center gap-4">
          <h1 className="text-2xl font-bold mb-4">Processing Failed</h1>
          <p className="text-red-500">{errorMessage}</p>
          <Button
            onClick={() => {
              setPageStatus("waiting");
              setVideoFile(null);
              setErrorMessage("");
            }}
          >
            Try Again
          </Button>
        </div>
      )}
      {pageStatus === "videoProcessSuccess" && (
        <div className="flex flex-col items-center gap-4">
          {/* 影片處理成功，顯示結果 */}
          <h1 className="text-2xl font-bold mb-4">Processing Successful</h1>
          <p>Encrypted Segments: {encryptedSegments.length}</p>
          <p>
            AES Key:{" "}
            {aesKey
              ? Array.from(aesKey)
                  .map((b) => b.toString(16).padStart(2, "0"))
                  .join("")
              : ""}
          </p>
          <p>Merged Video Size: {mergedVideo ? mergedVideo.length : 0} bytes</p>
          <h2 className="text-xl font-semibold mt-4">M3U8 Content:</h2>
          <pre className="bg-gray-100 p-4 rounded max-w-md overflow-x-auto">
            {m3u8Content}
          </pre>
          <Button
            onClick={() => {
              setPageStatus("waiting");
              setVideoFile(null);
              setEncryptedSegments([]);
              setMergedVideo(null);
              setAesKey(null);
              setM3u8Content("");
            }}
          >
            Upload Another Video
          </Button>
        </div>
      )}
    </div>
  );
}

export { UploadPage };
