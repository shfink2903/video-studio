import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ROOT, JOBS_DIR, BIN, WHISPER_MODEL, loadProjects } from "./lib/config.mjs";
import { loadAll, createJob, getJob, listJobs, enqueue, subscribe, resetEvents, dirOf } from "./lib/jobs.mjs";
import { processJob, fixJob, exportJob } from "./lib/pipeline.mjs";

const PORT = +(process.env.PORT || 4620);
const HOST = "127.0.0.1"; // local only: never exposed to the network
const PUBLIC = path.join(ROOT, "public");

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".mp4": "video/mp4", ".mov": "video/quicktime",
};

loadAll();

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function readJSON(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => {
      s += c;
      if (s.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch {
        reject(new Error("JSON invalide"));
      }
    });
  });
}

/** Static file with HTTP Range support (needed for <video> seeking). */
function serveFile(req, res, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: "Introuvable" });
  const size = fs.statSync(file).size;
  const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
  const range = req.headers.range && req.headers.range.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? +range[1] : 0;
    const end = range[2] ? Math.min(+range[2], size - 1) : size - 1;
    res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes", "Cache-Control": "no-store" });
    fs.createReadStream(file).pipe(res);
  }
}

function within(base, p) {
  const full = path.resolve(base, p);
  return full.startsWith(path.resolve(base) + path.sep) ? full : null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    /* pages and assets */
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) return serveFile(req, res, path.join(PUBLIC, "index.html"));
    if (req.method === "GET" && parts[0] === "public") {
      const f = within(PUBLIC, parts.slice(1).join("/"));
      return f ? serveFile(req, res, f) : send(res, 403, { error: "Interdit" });
    }
    if (req.method === "GET" && parts[0] === "media" && parts[1]) {
      if (!getJob(parts[1])) return send(res, 404, { error: "Vidéo inconnue" });
      const f = within(dirOf(parts[1]), parts.slice(2).join("/"));
      return f ? serveFile(req, res, f) : send(res, 403, { error: "Interdit" });
    }

    /* api */
    if (parts[0] !== "api") return send(res, 404, { error: "Introuvable" });

    if (req.method === "GET" && parts[1] === "health") {
      return send(res, 200, {
        whisperModel: fs.existsSync(WHISPER_MODEL),
        hyperframes: BIN.hyperframes || "npx",
        claude: fs.existsSync(BIN.claude),
      });
    }
    if (req.method === "GET" && parts[1] === "projects") return send(res, 200, loadProjects());
    if (req.method === "GET" && parts[1] === "jobs" && !parts[2]) return send(res, 200, listJobs(url.searchParams.get("project")));

    if (req.method === "POST" && parts[1] === "upload") {
      const project = url.searchParams.get("project") || "move";
      if (!loadProjects().some((p) => p.id === project)) return send(res, 400, { error: "Projet inconnu" });
      const name = path.basename(url.searchParams.get("name") || "video.mp4").slice(0, 120);
      const ext = (path.extname(name) || ".mp4").toLowerCase();
      if (![".mp4", ".mov", ".m4v", ".webm", ".mkv"].includes(ext)) return send(res, 400, { error: "Format non pris en charge : " + ext });
      const job = createJob({ project, name, ext });
      const out = fs.createWriteStream(path.join(dirOf(job.id), job.source));
      req.pipe(out);
      out.on("finish", () => {
        enqueue(job, processJob);
        send(res, 200, { id: job.id });
      });
      out.on("error", (e) => send(res, 500, { error: e.message }));
      return;
    }

    const job = parts[1] === "jobs" && parts[2] ? getJob(parts[2]) : null;
    if (parts[1] === "jobs" && parts[2] && !job) return send(res, 404, { error: "Vidéo inconnue" });

    if (req.method === "GET" && job && parts[3] === "events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      const { events, ...meta } = job;
      res.write(`data: ${JSON.stringify({ type: "hello", job: meta })}\n\n`);
      for (const e of events) res.write(`data: ${JSON.stringify({ ...e, history: true })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "live" })}\n\n`);
      const off = subscribe(job.id, (e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
      const ping = setInterval(() => res.write(": ping\n\n"), 20000);
      req.on("close", () => {
        off();
        clearInterval(ping);
      });
      return;
    }

    if (req.method === "POST" && job && parts[3] === "approve") {
      if (job.status !== "review") return send(res, 409, { error: "Cette vidéo n'attend pas de validation." });
      const { networks = [], captions = null } = await readJSON(req);
      if (!networks.length) return send(res, 400, { error: "Choisis au moins un réseau." });
      enqueue(job, (j) => exportJob(j, networks, captions));
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && job && parts[3] === "fix") {
      if (job.status !== "review" && job.status !== "failed") return send(res, 409, { error: "Attends la fin du montage pour demander une correction." });
      const { text = "" } = await readJSON(req);
      if (!text.trim()) return send(res, 400, { error: "Dis-moi quoi corriger." });
      enqueue(job, (j) => fixJob(j, text.trim().slice(0, 1000)));
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && job && parts[3] === "retry") {
      if (!["failed", "review"].includes(job.status)) return send(res, 409, { error: "Cette vidéo est déjà en cours de montage." });
      resetEvents(job);
      enqueue(job, processJob);
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && job && parts[3] === "reveal") {
      const target = job.exportDir || dirOf(job.id);
      spawn("open", [target]);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: "Introuvable" });
  } catch (err) {
    console.error(err);
    send(res, 500, { error: err.message });
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Le port ${PORT} est déjà pris : le studio tourne sans doute déjà sur http://localhost:${PORT}.`);
    console.error(`Ferme l'autre fenêtre, ou lance-le sur un autre port : PORT=4621 npm start`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`Studio prêt sur http://localhost:${PORT}`);
  if (!fs.existsSync(WHISPER_MODEL)) console.warn("Attention : modèle Whisper introuvable :", WHISPER_MODEL);
});
