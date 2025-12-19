import type { ChangeEvent } from "react";
import { Button } from "@/components/ui/button";

interface UploadButtonProps {
  onFileSelected: (file: File) => void;
}

export function UploadButton({ onFileSelected }: UploadButtonProps) {
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      onFileSelected(e.target.files[0]);
    }
  };

  return (
    <Button asChild>
      <label className="cursor-pointer">
        Upload Video
        <input
          type="file"
          className="hidden"
          onChange={handleChange}
          accept="video/*"
        />
      </label>
    </Button>
  );
}
