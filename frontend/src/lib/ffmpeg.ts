import { FFmpeg } from "@ffmpeg/ffmpeg";

import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";

let ffmpeg: FFmpeg | null = null;

async function toUint8Array(input: string | File | Blob): Promise<Uint8Array> {
  if (typeof input === "string") {
    const res = await fetch(input);
    const buffer = await res.arrayBuffer();
    return new Uint8Array(buffer);
  }
  const buffer = await input.arrayBuffer();
  return new Uint8Array(buffer);
}

export async function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpeg) return ffmpeg;

  const instance = new FFmpeg();
  await instance.load({ coreURL, wasmURL });
  ffmpeg = instance;

  return ffmpeg;
}

export async function writeInput(file: File, name = "input.mp4") {
  const ff = await getFFmpeg();
  await ff.writeFile(name, await toUint8Array(file));
  return name;
}

export async function cutVideoToTS(
  file: File,
  segmentDuration: number
): Promise<Uint8Array[]> {
  const ff = await getFFmpeg();
  const inputName = await writeInput(file);

  const outputPattern = "segment_%03d.ts";

  await ff.exec([
    "-i",
    inputName,
    "-c",
    "copy",
    "-f",
    "segment",
    "-segment_time",
    `${segmentDuration}`,
    "-segment_format",
    "mpegts",
    outputPattern,
  ]);

  const tsFiles: Uint8Array[] = [];
  let index = 0;
  while (true) {
    const name = `segment_${index.toString().padStart(3, "0")}.ts`;
    try {
      const fileData = await ff.readFile(name);
      let data: Uint8Array;
      if (fileData instanceof Uint8Array) {
        data = fileData;
      } else if (
        typeof fileData === "object" &&
        fileData !== null &&
        "data" in fileData
      ) {
        data = (fileData as { data: Uint8Array }).data;
      } else {
        throw new Error("Unknown FFmpeg file data type");
      }

      tsFiles.push(data);
      index++;
    } catch {
      break;
    }
  }

  return tsFiles;
}
