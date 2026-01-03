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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
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
  useCurrentWallet,
  useSignAndExecuteTransaction,
} from "@mysten/dapp-kit";
import { uploadVideoAssetsFlow } from "@/lib/sui";

const U64_MAX = 18446744073709551615n;
const MIST_PER_SUI_BIGINT = 1_000_000_000n;
const MAX_PRICE_SUI = U64_MAX / MIST_PER_SUI_BIGINT;

function parseSuiToMist(input: string): bigint | null {
  const value = input.trim();
  if (value === "") return 0n;

  // 允許：123、123.、123.45（最多 9 位小數）
  if (!/^\d+(\.\d{0,9})?$/.test(value)) return null;

  const [wholePart, fracPartRaw] = value.split(".");
  const fracPart = (fracPartRaw ?? "").padEnd(9, "0");

  const whole = BigInt(wholePart || "0");
  const frac = BigInt(fracPart || "0");
  return whole * MIST_PER_SUI_BIGINT + frac;
}

// ============================================================================
// 上傳流程總覽
//
// 這個頁面負責前處理+上鏈/上傳整段流程
// 1) 使用 FFmpeg.wasm 將 mp4 切成 HLS 的 .ts 片段並產生封面
// 2) 使用 WebCrypto 產生 AES-128 金鑰，逐段加密
// 3) 將加密後的片段串接成單一檔案（video.bin），並產生 BYTERANGE m3u8
// 4) 走 uploadVideoAssetsFlow：Walrus register → upload-relay 上傳 → certify
//
// - UI 輸入的價格單位是 SUI；鏈上與交易使用的是 MIST（1 SUI = 1e9 MIST）。
// - 上傳流程會觸發多次錢包簽名：至少 1 次 registerTx，外加每個 blob 1 次 tipTx + 最後 1 次 certifyTx。
// - 因為 upload-relay tip 認 txid 無法 ptb 打包
// ============================================================================

export function UploadPage() {
  const currentAccount = useCurrentAccount();
  const { isConnected: isWalletConnected } = useCurrentWallet();
  const walletConnected = isWalletConnected && !!currentAccount;
  const { mutateAsync: signAndExecuteTransaction } =
    useSignAndExecuteTransaction();
  const navigate = useNavigate();

  // 頁面狀態
  // - waiting / videoSelected：選檔階段
  // - videoProcessing：本機前處理（FFmpeg + 加密 + 產 m3u8）
  // - videoProcessSuccess / videoProcessError：前處理成功/失敗
  // - uploadingWalrus：開始走 Walrus/Sui 上傳註冊
  // - walrusUploadSuccess / walrusUploadError：上傳成功/失敗
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
  const [videoPriceInput, setVideoPriceInput] = useState<string>("0");
  const [videoPriceError, setVideoPriceError] = useState<string>("");
  const [uploadStatusText, setUploadStatusText] = useState<string>("");
  const [uploadedVideoId, setUploadedVideoId] = useState<string | null>(null);

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
    setVideoPriceInput("0");
    setVideoPriceError("");
    setUploadStatusText("");
    setUploadedVideoId(null);
  };

  const videoProcess = async (videoFile: File) => {
    setPageStatus("videoProcessing");
    setVideoProcessingText("Loading processor...");
    setErrorMessage("");
    // 載入 FFmpeg.wasm
    const { ffmpeg } = await ffmpegInstance().catch((err) => {
      console.error("FFmpeg load error:", err);
      setPageStatus("videoProcessError");
      setErrorMessage(err.message || "Failed to load FFmpeg");
      throw err;
    });
    setVideoProcessingProgress(5);
    setVideoProcessingText("Converter Ready");
    // 重新編碼/切割成 HLS 片段
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
    // 產生 AES-128 金鑰，逐一加密每個 .ts 片段
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
    // 將所有片段串接成單一檔（video.bin），並產生 BYTERANGE m3u8
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
              disabled={!videoFile || !walletConnected}
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
                  inputMode="decimal"
                  min={"0"}
                  max={MAX_PRICE_SUI.toString()}
                  step={"0.000000001"}
                  value={videoPriceInput}
                  onChange={(e) => {
                    const next = e.target.value;
                    setVideoPriceInput(next);

                    const mist = parseSuiToMist(next);
                    if (mist === null) {
                      setVideoPriceError("Please enter a valid amount");
                      return;
                    }

                    if (mist < 0n || mist > U64_MAX) {
                      setVideoPriceError(
                        `Amount exceeds limit (max ${MAX_PRICE_SUI.toString()} SUI)`
                      );
                      return;
                    }

                    setVideoPriceError("");
                  }}
                  placeholder="Enter video price in SUI"
                />
                <p className="text-xs text-muted-foreground">
                  Max: {MAX_PRICE_SUI.toString()} SUI (u64 limit)
                </p>
                {videoPriceError && (
                  <p className="text-sm text-red-500">{videoPriceError}</p>
                )}
              </div>
              <Alert>
                <AlertTitle>Upload Notice</AlertTitle>
                <AlertDescription>
                  <p>Upload will require 6 wallet signatures!</p>
                </AlertDescription>
              </Alert>
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
                if (!walletConnected || !currentAccount) return;

                const priceMist = parseSuiToMist(videoPriceInput);
                if (
                  priceMist === null ||
                  priceMist < 0n ||
                  priceMist > U64_MAX
                ) {
                  setVideoPriceError(`Invalid price input: ${videoPriceInput}`);
                  return;
                }

                setPageStatus("uploadingWalrus");
                try {
                  // 進入上鏈上傳流程：register → upload-relay → certify
                  const result = await uploadVideoAssetsFlow(
                    {
                      video: mergedVideo,
                      m3u8: m3u8Content,
                      cover: videoCoverFile,
                      aesKey,
                    },
                    {
                      title: videoTitle,
                      description: videoDescription,
                      // 價格輸入是 SUI；鏈上用 MIST（u64）。用 bigint 避免 number 精度/溢位。
                      price: priceMist,
                    },
                    currentAccount.address,
                    signAndExecuteTransaction,
                    (status) => setUploadStatusText(status)
                  );
                  setUploadedVideoId(result.videoObjectId);
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
                !walletConnected ||
                !!videoPriceError
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
          <div className="w-full max-w-md">
            <Alert>
              <AlertTitle>Upload Notice</AlertTitle>
              <AlertDescription>
                <p>Upload will require 6 wallet signatures!</p>
              </AlertDescription>
            </Alert>
          </div>
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
          {uploadedVideoId ? (
            <Button
              onClick={() =>
                navigate(`/watch?v=${encodeURIComponent(uploadedVideoId)}`)
              }
            >
              Go to Video
            </Button>
          ) : (
            <p className="text-muted-foreground">
              Uploaded, but failed to extract Video object id.
            </p>
          )}
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
