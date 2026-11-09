import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface RecordOptions {
  /** Where the mp4 goes. Omit to keep the frames and skip encoding. */
  path?: string;
  /** Frame directory. Defaults to a temporary directory. */
  dir?: string;
  format?: "jpeg" | "png";
  /** jpeg quality, 0-100. Lower is smaller. */
  quality?: number;
  /** Cap the frame width. The aspect ratio is kept. */
  maxWidth?: number;
  /** 1 captures every painted frame, 2 every other, and so on. */
  everyNthFrame?: number;
  /** Keep the frames after encoding. Off by default once an mp4 exists. */
  keepFrames?: boolean;
}

export interface RecordingResult {
  /** The encoded file, when a path was given and ffmpeg was available. */
  path?: string;
  /** Where the frames are, if they were kept. */
  dir?: string;
  frames: number;
  durationMs: number;
  /** Why there is no mp4, when there is no mp4. */
  note?: string;
}

export interface Recording {
  readonly dir: string;
  stop(): Promise<RecordingResult>;
}

interface Frame {
  file: string;
  /** Seconds since the epoch, from the page's own paint clock. */
  timestamp?: number;
}

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Collects screencast frames and, on stop, encodes them at the rate they were
 * actually painted rather than a guessed constant. CDP hands back a paint
 * timestamp per frame, so the concat list carries real per-frame durations and
 * the clip plays back at the speed the run happened.
 */
export function createRecorder(options: RecordOptions): {
  dir: string;
  addFrame(data: string, timestamp?: number): void;
  finish(): Promise<RecordingResult>;
} {
  const dir =
    options.dir ??
    fs.mkdtempSync(path.join(os.tmpdir(), "agentcursor-recording-"));
  fs.mkdirSync(dir, { recursive: true });

  const extension = options.format === "png" ? "png" : "jpg";
  const frames: Frame[] = [];
  const startedAt = Date.now();

  return {
    dir,
    addFrame(data, timestamp) {
      const file = path.join(
        dir,
        `${String(frames.length).padStart(6, "0")}.${extension}`,
      );
      fs.writeFileSync(file, Buffer.from(data, "base64"));
      frames.push({ file, timestamp });
    },

    async finish(): Promise<RecordingResult> {
      const durationMs = Date.now() - startedAt;
      fs.writeFileSync(
        path.join(dir, "manifest.json"),
        JSON.stringify({ frames: frames.length, durationMs, frameList: frames }, null, 2),
      );

      if (!options.path) {
        return { dir, frames: frames.length, durationMs };
      }
      if (frames.length === 0) {
        return { dir, frames: 0, durationMs, note: "no frames were captured" };
      }
      if (!hasFfmpeg()) {
        return {
          dir,
          frames: frames.length,
          durationMs,
          note: "ffmpeg is not on PATH, so the frames were kept unencoded",
        };
      }

      // Per-frame durations from the paint clock, falling back to an even
      // spread when the browser did not report timestamps.
      const fallback = durationMs / 1000 / frames.length;
      const quote = (file: string) => `file '${file.replace(/'/g, "'\\''")}'`;
      const lines: string[] = [];
      for (const [index, current] of frames.entries()) {
        const next = frames[index + 1];
        const gap =
          current.timestamp && next?.timestamp
            // Floor well under a frame: the screencast can paint faster than
            // 60fps, and a 16ms floor stretches the clip past real time.
            ? Math.min(Math.max(next.timestamp - current.timestamp, 0.002), 5)
            : fallback;
        lines.push(quote(current.file));
        lines.push(`duration ${gap.toFixed(4)}`);
      }
      // The concat demuxer drops the final entry's duration unless the last
      // file is repeated.
      const last = frames[frames.length - 1];
      if (last) lines.push(quote(last.file));

      const listFile = path.join(dir, "frames.txt");
      fs.writeFileSync(listFile, lines.join("\n"));

      fs.mkdirSync(path.dirname(path.resolve(options.path)), { recursive: true });
      const scale = options.maxWidth ? `scale=${options.maxWidth}:-2,` : "";
      await run("ffmpeg", [
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "concat", "-safe", "0", "-i", listFile,
        "-vf", `${scale}pad=ceil(iw/2)*2:ceil(ih/2)*2,fps=30`,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
        "-pix_fmt", "yuv420p",
        options.path,
      ]);

      if (!options.keepFrames) {
        fs.rmSync(dir, { recursive: true, force: true });
      }

      return {
        path: options.path,
        dir: options.keepFrames ? dir : undefined,
        frames: frames.length,
        durationMs,
      };
    },
  };
}
