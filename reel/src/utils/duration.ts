const FPS = 30;

export function secToFrames(sec: number, fps = FPS): number {
  return Math.round(sec * fps);
}

export function framesToSec(frames: number, fps = FPS): number {
  return frames / fps;
}

/** Get audio duration using ffprobe */
export async function getAudioDuration(filePath: string): Promise<number> {
  const { execSync } = await import("node:child_process");
  const result = execSync(
    `ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`,
    { encoding: "utf-8" }
  );
  return parseFloat(result.trim());
}
