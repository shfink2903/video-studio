import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const JOBS_DIR = path.join(ROOT, "jobs");
export const PROJECTS_DIR = path.join(ROOT, "projects");
export const EXPORTS_DIR = path.join(ROOT, "exports");

function firstExisting(...candidates) {
  return candidates.find((c) => c && fs.existsSync(c));
}

function findHyperframes() {
  if (process.env.HYPERFRAMES_BIN) return process.env.HYPERFRAMES_BIN;
  const npx = path.join(os.homedir(), ".npm", "_npx");
  if (fs.existsSync(npx)) {
    for (const d of fs.readdirSync(npx)) {
      const bin = path.join(npx, d, "node_modules", ".bin", "hyperframes");
      if (fs.existsSync(bin)) return bin;
    }
  }
  return null; // falls back to `npx hyperframes`
}

export const BIN = {
  ffmpeg: process.env.FFMPEG_BIN || firstExisting("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg") || "ffmpeg",
  ffprobe: process.env.FFPROBE_BIN || firstExisting("/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe") || "ffprobe",
  whisper: process.env.WHISPER_BIN || firstExisting("/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli") || "whisper-cli",
  claude: process.env.CLAUDE_BIN || firstExisting(path.join(os.homedir(), ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude") || "claude",
  hyperframes: findHyperframes(),
};

export const WHISPER_MODEL = process.env.WHISPER_MODEL || path.join(ROOT, "models", "ggml-small.bin");
export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-fable-5-2";

for (const d of [JOBS_DIR, EXPORTS_DIR]) fs.mkdirSync(d, { recursive: true });

export function loadProjects() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  return fs
    .readdirSync(PROJECTS_DIR)
    .filter((d) => fs.existsSync(path.join(PROJECTS_DIR, d, "project.json")))
    .map((d) => JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, d, "project.json"), "utf8")));
}

export function loadProject(id) {
  const p = path.join(PROJECTS_DIR, id, "project.json");
  if (!fs.existsSync(p)) throw new Error(`Projet introuvable : ${id}`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function projectMusic(id) {
  const dir = path.join(PROJECTS_DIR, id, "music");
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).find((n) => /\.(mp3|m4a|wav|aac)$/i.test(n));
  return f ? path.join(dir, f) : null;
}
