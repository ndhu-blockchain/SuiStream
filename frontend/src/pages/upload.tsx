import { useRef, useState } from "react";
import { UploadButton } from "@/components/common/upload-button";
import { useVideoProcessor } from "@/hooks/use-video-processor";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

// 下載 helper 函式
function downloadFile(data: BlobPart, filename: string, mimeType: string) {
  const blob = new Blob([data], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function Upload() {
  const [processing, setProcessing] = useState(false);
  const [result, setResult] = useState<any>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const { processVideo } = useVideoProcessor();

  const handleFile = async (file: File) => {
    setProcessing(true);
    abortControllerRef.current = new AbortController();

    try {
      const res = await processVideo(
        file,
        abortControllerRef.current.signal
      );
      setResult(res);

      // 自動下載三個檔案
      // 1. video.bin (二進位影片檔)
      downloadFile(res.videoBin, "video.bin", "application/octet-stream");
      
      // 2. video.m3u8 (播放清單)
      downloadFile(res.m3u8, "video.m3u8", "text/plain");

      // 3. video.key (加密金鑰)
      downloadFile(res.key, "video.key", "application/octet-stream");

    } catch (error) {
      if ((error as Error).message !== "Video processing cancelled") {
        console.error("Error processing video:", error);
      }
    } finally {
      setProcessing(false);
    }
  };

  const handleCancel = () => {
    abortControllerRef.current?.abort();
    setProcessing(false);
    setResult(null);
  };

  const handleReset = () => {
    setResult(null);
    abortControllerRef.current = null;
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4">
      {!processing && !result && <UploadButton onFileSelected={handleFile} />}

      {processing && (
        <div className="flex flex-col items-center gap-6">
          <div className="flex flex-row items-center gap-4">
            <Spinner />
            <p className="text-lg">Processing video...</p>
          </div>
          <Button variant="destructive" onClick={handleCancel}>
            Cancel
          </Button>
        </div>
      )}

      {result && !processing && (
        <div className="mt-4 flex flex-col items-center gap-4 w-full max-w-md">
          <p className="text-lg font-semibold text-green-600">
            Video processed successfully!
          </p>
          <div className="text-sm text-gray-600 text-center">
            <p>Files downloaded:</p>
            <ul className="list-disc list-inside">
              <li>video.bin ({(result.videoBin.length / 1024 / 1024).toFixed(2)} MB)</li>
              <li>video.m3u8</li>
              <li>video.key</li>
            </ul>
          </div>
          <textarea
            className="w-full h-40 p-2 border rounded"
            value={result.m3u8}
            readOnly
          />
          <div className="flex gap-2">
            <Button onClick={handleReset}>Upload Another</Button>
            <Button
              variant="destructive"
              onClick={() => {
                abortControllerRef.current?.abort();
                setResult(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export { Upload };
