import { useState } from "react";
import { UploadButton } from "@/components/common/upload-button";
import { useVideoProcessor } from "@/hooks/use-video-processor";
import { Progress } from "@/components/ui/progress";

export default function Upload() {
  const [processing, setProcessing] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [progress, setProgress] = useState(0);
  const { processVideo } = useVideoProcessor();

  const handleFile = async (file: File) => {
    setProcessing(true);
    setProgress(0);
    const res = await processVideo(file, 1, setProgress);
    setResult(res);
    setProcessing(false);
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4">
      <h1 className="text-4xl font-bold mb-4">Upload Page</h1>
      <UploadButton onFileSelected={handleFile} />
      {processing && <p>Processing video...</p>}
      {result && (
        <div className="mt-4">
          <p>Video processed successfully!</p>
          <p>video.bin size: {result.videoBin.length} bytes</p>
          <textarea
            className="w-full h-40 mt-2 p-2 border"
            value={result.m3u8}
            readOnly
          />
        </div>
      )}
      {processing && (
        <div className="w-full max-w-md mt-4">
          <Progress value={progress} />
        </div>
      )}
    </div>
  );
}

export { Upload };
