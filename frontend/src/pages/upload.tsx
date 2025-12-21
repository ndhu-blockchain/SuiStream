import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { useState } from "react";
import { ffmpegInstance } from "@/lib/ffmpeg";
import {
  reEncodingSplitVideo,
  aesEncryptSegments,
  mergeTSGenerateM3U8,
} from "@/lib/video";
import { bytesToDisplaySize } from "@/lib/conversion";
import { Label } from "@/components/ui/label";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
} from "@mysten/dapp-kit";
import { uploadVideoAssetsFlow } from "@/lib/sui";

export default function UploadPage() {
  const currentAccount = useCurrentAccount();
  const { mutateAsync: signAndExecuteTransaction } =
    useSignAndExecuteTransaction();

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
  const [mergedVideo, setMergedVideo] = useState<Uint8Array | null>(null);
  const [aesKey, setAesKey] = useState<Uint8Array | null>(null);
  const [m3u8Content, setM3u8Content] = useState<string>("");
  const videoSplitDuration = 10; // 每個片段秒數
  const [videoCoverFile, setVideoCoverFile] = useState<File | null>(null);
  const [videoTitle, setVideoTitle] = useState<string>("");
  const [videoDescription, setVideoDescription] = useState<string>("");
  const [videoPrice, setVideoPrice] = useState<number>(0);
  const [uploadStatusText, setUploadStatusText] = useState<string>("");

  const resetStates = () => {
    setPageStatus("waiting");
    setVideoFile(null);
    setVideoProcessingProgress(0);
    setVideoProcessingText("");
    setErrorMessage("");
    setMergedVideo(null);
    setAesKey(null);
    setM3u8Content("");
    setVideoCoverFile(null);
    setVideoTitle("");
    setVideoDescription("");
    setVideoPrice(0);
    setUploadStatusText("");
  };

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
    setVideoProcessingText("Transcoding & Splitting Video...");
    const { segments, coverFile } = await reEncodingSplitVideo(
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
    setVideoCoverFile(coverFile);
    // 產生一 AES-128 加密金鑰逐一加密每個 .ts 檔案
    setVideoProcessingText("Encrypting Segments...");
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
    setAesKey(encryptedData.key);
    setVideoProcessingProgress(90);
    setVideoProcessingText("Segments encrypted");
    // 將所有 .ts 片段逐一接合同時紀錄每個片段 ByteRange
    setVideoProcessingText("Generating M3U8 Playlist...");
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
    // 設定檔案至 State
    setMergedVideo(mergedData);
    setM3u8Content(m3u8Content);
    setVideoProcessingProgress(100);
    setVideoProcessingText("M3U8 generated");
    setPageStatus("videoProcessSuccess");
    // 測試用 download video.bin video.m3u8 video.key cover.png
    // const downloadFile = (data: Uint8Array, filename: string) => {
    //   const blob = new Blob([data as any]);
    //   const url = URL.createObjectURL(blob);
    //   const a = document.createElement("a");
    //   a.href = url;
    //   a.download = filename;
    //   a.click();
    //   URL.revokeObjectURL(url);
    // };
    // downloadFile(mergedData, "video.bin");
    // downloadFile(
    //   new Uint8Array(m3u8Content.split("").map((c) => c.charCodeAt(0))),
    //   "video.m3u8"
    // );
    // downloadFile(encryptedData.key, "video.key");
    // downloadFile(
    //   new Uint8Array(
    //     coverFile ? await coverFile.arrayBuffer() : new Uint8Array()
    //   ),
    //   "cover.png"
    // );
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
              resetStates();
            }}
          >
            Try Again
          </Button>
        </div>
      )}
      {(pageStatus === "videoProcessSuccess" ||
        pageStatus === "waitingCover" ||
        pageStatus === "coverSelected") && (
        <div className="flex flex-col items-center gap-4">
          {/* 影片處理成功，列出 video and m3u8 file size */}
          <h1 className="text-2xl font-bold mb-4">Processing Successful</h1>
          <p>
            Encrypted Video Size:{" "}
            {mergedVideo ? bytesToDisplaySize(mergedVideo.length) : "N/A"}
          </p>
          <p>
            M3U8 File Size:{" "}
            {m3u8Content
              ? bytesToDisplaySize(new TextEncoder().encode(m3u8Content).length)
              : "N/A"}
          </p>
          {/* 顯示 cover */}
          {videoCoverFile && (
            <div className="flex flex-col items-center">
              <h2 className="text-xl font-semibold mb-2">Selected Cover:</h2>
              <img
                src={URL.createObjectURL(videoCoverFile)}
                alt="Video Cover"
                className="max-w-xs max-h-64 object-contain border"
              />
            </div>
          )}
          {/* 讓使用者上傳封面 */}
          <Label className="text-lg font-medium">
            Upload Cover Image (JPG/PNG)
          </Label>
          <Input
            type="file"
            accept=".jpg,.png"
            onChange={(e) => {
              const file = e.target.files?.[0] ?? null;
              setVideoCoverFile(file);
              setPageStatus("coverSelected");
            }}
          />
          <Label className="text-lg font-medium">Video Title</Label>
          <Input
            type="text"
            value={videoTitle}
            onChange={(e) => setVideoTitle(e.target.value)}
            placeholder="Enter video title"
          />
          <Label className="text-lg font-medium">Video Description</Label>
          <Input
            type="text"
            value={videoDescription}
            onChange={(e) => setVideoDescription(e.target.value)}
            placeholder="Enter video description"
          />
          <Label className="text-lg font-medium">Price (SUI)</Label>
          <Input
            type="number"
            value={videoPrice}
            onChange={(e) => setVideoPrice(Number(e.target.value))}
            placeholder="Enter video price in SUI"
          />
          {/* 按鈕：上傳至 Walrus / 重置 */}
          <Button
            onClick={async () => {
              if (
                !mergedVideo ||
                !m3u8Content ||
                !videoCoverFile ||
                !currentAccount
              )
                return;

              setPageStatus("uploadingWalrus");
              try {
                await uploadVideoAssetsFlow(
                  {
                    video: mergedVideo,
                    m3u8: m3u8Content,
                    cover: videoCoverFile,
                    aesKey: aesKey!,
                  },
                  {
                    title: videoTitle,
                    description: videoDescription,
                    price: videoPrice * 1_000_000_000, // 轉為 MIST
                  },
                  currentAccount.address,
                  signAndExecuteTransaction,
                  (status) => setUploadStatusText(status)
                );
                setPageStatus("walrusUploadSuccess");
              } catch (error) {
                console.error("Upload failed:", error);
                setErrorMessage(
                  error instanceof Error ? error.message : "Upload failed"
                );
                setPageStatus("walrusUploadError");
              }
            }}
            disabled={
              !mergedVideo ||
              !m3u8Content ||
              !aesKey ||
              !videoCoverFile ||
              !videoTitle ||
              !currentAccount
            }
          >
            Upload to Walrus
          </Button>
          <Button
            onClick={() => {
              resetStates();
            }}
          >
            Reset
          </Button>
        </div>
      )}
      {pageStatus === "uploadingWalrus" && (
        <div className="flex flex-col items-center gap-4">
          <h1 className="text-2xl font-bold mb-4">Uploading to Walrus...</h1>
          <p>{uploadStatusText || "Initializing upload..."}</p>
          <Spinner />
        </div>
      )}
      {pageStatus === "walrusUploadSuccess" && (
        <div className="flex flex-col items-center gap-4">
          <h1 className="text-2xl font-bold mb-4 text-green-600">
            Upload Successful!
          </h1>
          <p>Your video has been uploaded to Walrus and registered on Sui.</p>
          <Button onClick={resetStates}>Upload Another Video</Button>
        </div>
      )}
      {pageStatus === "walrusUploadError" && (
        <div className="flex flex-col items-center gap-4">
          <h1 className="text-2xl font-bold mb-4 text-red-600">
            Upload Failed
          </h1>
          <p className="text-red-500">{errorMessage}</p>
          <Button onClick={() => setPageStatus("coverSelected")}>
            Try Again
          </Button>
        </div>
      )}
    </div>
  );
}

export { UploadPage };
