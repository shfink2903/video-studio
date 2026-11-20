import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { JOBS_DIR } from "./config.mjs";

/** In-memory index of jobs, backed by jobs/<id>/job.json + events.jsonl */
const jobs = new Map();
const listeners = new Map(); // id -> Set<fn>

function jobDir(id) {
  return path.join(JOBS_DIR, id);
}

function saveJob(job) {
  const { events, ...meta } = job;
  fs.writeFileSync(path.join(jobDir(job.id), "job.json"), JSON.stringify(meta, null, 2));
}

export function loadAll() {
  for (const id of fs.readdirSync(JOBS_DIR)) {
    const f = path.join(JOBS_DIR, id, "job.json");
    if (!fs.existsSync(f)) continue;
    const job = JSON.parse(fs.readFileSync(f, "utf8"));
    const ev = path.join(JOBS_DIR, id, "events.jsonl");
    job.events = fs.existsSync(ev)
      ? fs.readFileSync(ev, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    // A job that was running when the server stopped can't resume mid-step.
    if (job.status === "running" || job.status === "queued") {
      job.status = "failed";
      job.error = "Le serveur s'est arrêté pendant le montage. Relance la vidéo.";
    }
    jobs.set(id, job);
  }
}

export function createJob({ project, name, ext }) {
  const id = new Date().toISOString().slice(0, 10) + "-" + crypto.randomBytes(3).toString("hex");
  fs.mkdirSync(jobDir(id), { recursive: true });
  const job = {
    id,
    project,
    name,
    source: `source${ext}`,
    status: "uploading",
    createdAt: new Date().toISOString(),
    events: [],
  };
  jobs.set(id, job);
  saveJob(job);
  return job;
}

export function getJob(id) {
  return jobs.get(id);
}

export function listJobs(project) {
  return [...jobs.values()]
    .filter((j) => !project || j.project === project)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(({ events, plan, words, ...meta }) => meta);
}

export function update(job, patch) {
  Object.assign(job, patch);
  saveJob(job);
  broadcast(job.id, { type: "status", status: job.status, error: job.error || null });
}

export function emit(job, event) {
  const e = { ...event, at: Date.now() };
  job.events.push(e);
  fs.appendFileSync(path.join(jobDir(job.id), "events.jsonl"), JSON.stringify(e) + "\n");
  broadcast(job.id, e);
}

function broadcast(id, e) {
  for (const fn of listeners.get(id) || []) fn(e);
}

export function subscribe(id, fn) {
  if (!listeners.has(id)) listeners.set(id, new Set());
  listeners.get(id).add(fn);
  return () => listeners.get(id).delete(fn);
}

export const dirOf = jobDir;

/** Forget everything a previous run produced, so the job can start again from the source file. */
export function resetEvents(job) {
  job.events = [];
  fs.writeFileSync(path.join(jobDir(job.id), "events.jsonl"), "");
  for (const k of ["plan", "outputs", "finalDuration", "title", "exportDir", "networks", "error"]) delete job[k];
  saveJob(job);
}

/* ---------- one job at a time ---------- */
const queue = [];
let busy = false;

export function enqueue(job, task) {
  update(job, { status: "queued" });
  queue.push({ job, task });
  pump();
}

async function pump() {
  if (busy || !queue.length) return;
  busy = true;
  const { job, task } = queue.shift();
  update(job, { status: "running", error: null });
  try {
    await task(job);
    if (job.status === "running") update(job, { status: "done" });
  } catch (err) {
    console.error(`[${job.id}]`, err);
    emit(job, { type: "error", text: err.message.split("\n")[0], detail: err.message });
    update(job, { status: "failed", error: err.message });
  } finally {
    busy = false;
    pump();
  }
}
