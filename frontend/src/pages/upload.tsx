import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
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
import { MIST_PER_SUI, uploadVideoAssetsFlow } from "@/lib/sui";

export function UploadPage() {
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
    | "uploadingWalrus"
    | "walrusUploadSuccess"
    | "walrusUploadError"
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
    setVideoProcessingText("Loading processor...");
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
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen">
      {(pageStatus === "waiting" || pageStatus === "videoSelected") && (
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Select a Video</CardTitle>
            <CardDescription>
              Choose a video file to upload and process.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Input
              type="file"
              accept=".mp4"
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                setVideoFile(file);
                setPageStatus("videoSelected");
              }}
            />
          </CardContent>
          <CardFooter>
            <Button
              className="w-full"
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
          </CardFooter>
        </Card>
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
      {pageStatus === "videoProcessSuccess" && (
        <Card className="w-full max-w-2xl">
          <CardHeader>
            <CardTitle>Video Details</CardTitle>
            <CardDescription>
              Review processing results and add metadata for your video.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div className="flex flex-col gap-1">
                <span className="text-muted-foreground">
                  Encrypted Video Size
                </span>
                <span className="font-medium">
                  {mergedVideo ? bytesToDisplaySize(mergedVideo.length) : "N/A"}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-muted-foreground">M3U8 File Size</span>
                <span className="font-medium">
                  {m3u8Content
                    ? bytesToDisplaySize(
                        new TextEncoder().encode(m3u8Content).length
                      )
                    : "N/A"}
                </span>
              </div>
            </div>

            <Separator />

            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="cover-upload">Cover Image</Label>
                {videoCoverFile && (
                  <div className="relative aspect-video w-full overflow-hidden rounded-lg border bg-muted">
                    <img
                      src={URL.createObjectURL(videoCoverFile)}
                      alt="Video Cover"
                      className="h-full w-full object-cover"
                    />
                  </div>
                )}
                <Input
                  id="cover-upload"
                  type="file"
                  accept=".jpg,.png"
                  onChange={(e) => {
                    const file = e.target.files?.[0] ?? null;
                    setVideoCoverFile(file);
                  }}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="video-title">Video Title</Label>
                <Input
                  id="video-title"
                  type="text"
                  value={videoTitle}
                  onChange={(e) => setVideoTitle(e.target.value)}
                  placeholder="Enter video title"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="video-description">Video Description</Label>
                <Input
                  id="video-description"
                  type="text"
                  value={videoDescription}
                  onChange={(e) => setVideoDescription(e.target.value)}
                  placeholder="Enter video description"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="video-price">Price (SUI)</Label>
                <Input
                  id="video-price"
                  type="number"
                  value={videoPrice}
                  onChange={(e) => setVideoPrice(Number(e.target.value))}
                  placeholder="Enter video price in SUI"
                />
              </div>
            </div>
          </CardContent>
          <CardFooter className="flex justify-between">
            <Button variant="outline" onClick={resetStates}>
              Reset
            </Button>
            <Button
              onClick={async () => {
                if (!mergedVideo) return;
                if (!m3u8Content) return;
                if (!aesKey) return;
                if (!videoCoverFile) return;
                if (!videoTitle) return;
                if (!currentAccount) return;

                setPageStatus("uploadingWalrus");
                try {
                  await uploadVideoAssetsFlow(
                    {
                      video: mergedVideo,
                      m3u8: m3u8Content,
                      cover: videoCoverFile,
                      aesKey,
                    },
                    {
                      title: videoTitle,
                      description: videoDescription,
                      price: videoPrice * MIST_PER_SUI, // 轉為 MIST
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
          </CardFooter>
        </Card>
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
          <Button onClick={() => setPageStatus("videoProcessSuccess")}>
            Try Again
          </Button>
        </div>
      )}
    </div>
  );
}
