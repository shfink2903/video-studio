import fs from "node:fs";
import path from "node:path";
import { BIN, WHISPER_MODEL, EXPORTS_DIR, loadProject, projectMusic } from "./config.mjs";
import { run } from "./run.mjs";
import { emit, update, dirOf } from "./jobs.mjs";
import { askJSON } from "./claude.mjs";
import { renderFormat } from "./render.mjs";

const r3 = (n) => Math.round(n * 1000) / 1000;
const step = (job, id, state, note) => emit(job, { type: "step", step: id, state, note });
const say = (job, text) => emit(job, { type: "say", text });
const log = (job, text, detail) => emit(job, { type: "log", text, detail });
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/* ---------------------------------------------------------------- probe */

async function probe(file) {
  const { stdout } = await run(BIN.ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", file]);
  const j = JSON.parse(stdout);
  return {
    duration: parseFloat(j.format?.duration || "0"),
    hasAudio: (j.streams || []).some((s) => s.codec_type === "audio"),
    hasVideo: (j.streams || []).some((s) => s.codec_type === "video"),
  };
}

function wavPeaks(file, bins = 120) {
  const buf = fs.readFileSync(file);
  let off = 12;
  while (off < buf.length - 8 && buf.toString("ascii", off, off + 4) !== "data") off += 8 + buf.readUInt32LE(off + 4);
  const start = off + 8;
  const samples = Math.floor((buf.length - start) / 2);
  const per = Math.max(1, Math.floor(samples / bins));
  const peaks = [];
  for (let b = 0; b < bins; b++) {
    let sum = 0;
    for (let i = 0; i < per; i++) {
      const idx = start + (b * per + i) * 2;
      if (idx + 1 >= buf.length) break;
      const v = buf.readInt16LE(idx) / 32768;
      sum += v * v;
    }
    peaks.push(Math.sqrt(sum / per));
  }
  const max = Math.max(...peaks, 1e-6);
  return peaks.map((p) => r3(p / max));
}

/* ---------------------------------------------------------------- transcription */

function parseWords(raw) {
  const words = [];
  for (const t of raw.transcription || []) {
    const txt = t.text || "";
    if (!txt.trim()) continue;
    if (/^\s*[[(].*[\])]\s*$/.test(txt) || /[♪�]/.test(txt)) continue;
    const s = t.offsets.from / 1000;
    const e = t.offsets.to / 1000;
    if (!/^\s/.test(txt) && words.length) {
      const w = words[words.length - 1];
      w.text += txt.trim();
      w.end = Math.max(w.end, e);
      continue;
    }
    words.push({ text: txt.trim(), start: s, end: e });
  }
  return words;
}

function buildLines(words) {
  const lines = [];
  let from = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    const endSentence = /[.?!…]$/.test(w.text);
    const gap = next ? next.start - w.end : 99;
    if (endSentence || gap > 0.7 || i - from >= 14 || !next) {
      lines.push({ t: r3(words[from].start), from, to: i, text: words.slice(from, i + 1).map((x) => x.text).join(" ") });
      from = i + 1;
    }
  }
  return lines;
}

async function detectSilences(wav, cfg, duration) {
  const { stderr } = await run(BIN.ffmpeg, ["-hide_banner", "-i", wav, "-af", `silencedetect=noise=${cfg.noiseDb}dB:d=${cfg.minDuration}`, "-f", "null", "-"]);
  const out = [];
  let cur = null;
  for (const line of stderr.split("\n")) {
    const a = line.match(/silence_start: ([\d.]+)/);
    const b = line.match(/silence_end: ([\d.]+)/);
    if (a) cur = parseFloat(a[1]);
    if (b && cur !== null) {
      out.push({ start: cur, end: parseFloat(b[1]) });
      cur = null;
    }
  }
  if (cur !== null) out.push({ start: cur, end: duration });
  return out;
}

/* ---------------------------------------------------------------- Claude's editing plan */

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    hook: {
      type: "object",
      properties: { use: { type: "boolean" }, startWord: { type: "integer" }, endWord: { type: "integer" }, reason: { type: "string" } },
      required: ["use", "startWord", "endWord", "reason"],
    },
    remove: {
      type: "array",
      items: {
        type: "object",
        properties: { startWord: { type: "integer" }, endWord: { type: "integer" }, reason: { type: "string" } },
        required: ["startWord", "endWord", "reason"],
      },
    },
    zoomWords: { type: "array", items: { type: "integer" } },
    highlightWords: { type: "array", items: { type: "integer" } },
    style: {
      type: "object",
      properties: { captionScale: { type: "number" }, wordsPerGroup: { type: "integer" } },
      required: ["captionScale", "wordsPerGroup"],
    },
    title: { type: "string" },
    captions: {
      type: "object",
      properties: { tiktok: { type: "string" }, instagram: { type: "string" }, youtube: { type: "string" }, linkedin: { type: "string" } },
      required: ["tiktok", "instagram", "youtube", "linkedin"],
    },
    note: { type: "string" },
  },
  required: ["hook", "remove", "zoomWords", "highlightWords", "style", "title", "captions", "note"],
};

function transcriptForPrompt(words, lines) {
  return lines
    .map((l, k) => {
      const ws = words.slice(l.from, l.to + 1).map((w, j) => `[${l.from + j}]${w.text}`).join(" ");
      return `L${k} (${l.t.toFixed(2)}s) ${ws}`;
    })
    .join("\n");
}

function planPrompt(project, words, lines, duration) {
  return `Tu es le monteur vidéo du projet « ${project.name} ».
Contexte du projet : ${project.tone}

Voici la transcription mot à mot d'une vidéo face caméra de ${duration.toFixed(1)} s. Chaque mot est précédé de son index entre crochets, chaque ligne de son début en secondes.

${transcriptForPrompt(words, lines)}

Décide le montage d'une vidéo verticale courte (TikTok, Reels, Shorts) :
1. hook : si une phrase plus loin accroche mieux que le début (question, problème fort, promesse), donne startWord et endWord d'une phrase complète de 3 à 8 s à placer en ouverture et explique pourquoi en une phrase. use=false si le début est déjà la meilleure accroche (mets alors 0 et 0).
2. remove : prises ratées, phrases recommencées, faux départs, « euh » isolés, « attends je reprends », répétitions. Plages de mots inclusives, raison courte. Ne coupe jamais une idée utile. Les silences sont déjà coupés automatiquement : ne les liste pas.
3. zoomWords : 2 à ${project.zoom?.max ?? 4} mots forts pour un zoom léger, au moins 4 s d'écart.
4. highlightWords : 3 à 8 mots clés à colorer dans les sous-titres.
5. style : captionScale 1 et wordsPerGroup ${project.captions?.wordsPerGroup ?? 3} sauf raison particulière.
6. title : titre interne court de la vidéo.
7. captions : une légende par réseau, dans la langue parlée dans la vidéo, avec le ton du projet. tiktok : courte avec 3 à 5 hashtags. instagram : 1 ou 2 phrases, un appel à l'action, des hashtags. youtube : titre accrocheur de moins de 70 caractères. linkedin : 3 ou 4 phrases à la première personne, 3 hashtags maximum.
8. note : une phrase qui résume tes choix de montage, adressée à Simon.

Réponds uniquement avec le JSON demandé.`;
}

function fixPrompt(project, words, lines, duration, plan, request) {
  return `${planPrompt(project, words, lines, duration)}

Tu as déjà proposé ce plan :
${JSON.stringify(plan, null, 2)}

Simon a regardé le résultat et demande cette correction : « ${request} »

Renvoie le plan complet corrigé. Pour « sous-titres plus gros/petits », change style.captionScale (par exemple 1.2 ou 0.85). Pour « plus/moins de mots à l'écran », change style.wordsPerGroup. Dans note, dis en une phrase ce que tu as changé.`;
}

function sanitizePlan(plan, n, project) {
  const clamp = (i) => Math.max(0, Math.min(n - 1, Math.round(i)));
  const p = structuredClone(plan);
  p.hook.startWord = clamp(p.hook.startWord);
  p.hook.endWord = Math.max(p.hook.startWord, clamp(p.hook.endWord));
  p.remove = (p.remove || [])
    .map((r) => ({ ...r, startWord: clamp(r.startWord), endWord: clamp(r.endWord) }))
    .filter((r) => r.endWord >= r.startWord);
  p.zoomWords = (p.zoomWords || []).map(clamp);
  p.highlightWords = (p.highlightWords || []).map(clamp);
  p.style = {
    captionScale: Math.max(0.6, Math.min(1.6, p.style?.captionScale || 1)),
    wordsPerGroup: Math.max(1, Math.min(7, p.style?.wordsPerGroup || project.captions?.wordsPerGroup || 3)),
  };
  return p;
}

function basePlan(project) {
  return {
    hook: { use: false, startWord: 0, endWord: 0, reason: "" },
    remove: [],
    zoomWords: [],
    highlightWords: [],
    style: { captionScale: 1, wordsPerGroup: project.captions?.wordsPerGroup ?? 3 },
    title: "",
    captions: null,
    note: "",
    withoutClaude: true,
  };
}

/* ---------------------------------------------------------------- edit decision list */

function buildEdit(words, silences, plan, duration, cfg) {
  const pad = cfg.keepPadding;
  const cuts = [];
  if (words.length) {
    if (words[0].start > 0.6) cuts.push({ start: 0, end: words[0].start - 0.15, kind: "sil", reason: "Début silencieux" });
    const last = words[words.length - 1].end;
    if (duration - last > 0.6) cuts.push({ start: last + 0.25, end: duration, kind: "sil", reason: "Fin silencieuse" });
  }
  for (const s of silences) {
    const a = s.start + pad;
    const b = s.end - pad;
    if (b - a >= 0.25) cuts.push({ start: a, end: b, kind: "sil", reason: `Silence de ${(s.end - s.start).toFixed(1)} s` });
  }
  for (const r of plan.remove) {
    cuts.push({
      start: Math.max(0, words[r.startWord].start - 0.06),
      end: Math.min(duration, words[r.endWord].end + 0.06),
      kind: "bad",
      reason: r.reason,
    });
  }
  cuts.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const c of cuts) {
    const prev = merged[merged.length - 1];
    if (prev && c.start <= prev.end + 0.05) {
      prev.end = Math.max(prev.end, c.end);
      if (c.kind === "bad") {
        prev.kind = "bad";
        prev.reason = c.reason;
      }
    } else merged.push({ ...c });
  }

  // hook range (only worth moving if it is not already near the start)
  let hook = null;
  if (plan.hook.use) {
    const a = Math.max(0, words[plan.hook.startWord].start - 0.08);
    const b = Math.min(duration, words[plan.hook.endWord].end + 0.15);
    if (a > 1.5 && b - a > 0.8) hook = { start: a, end: b };
  }

  // source-order segments: keep pieces between cuts, split at the hook edges
  const segs = [];
  let t = 0;
  const pushKeep = (a, b) => {
    if (b - a < 0.12) return;
    if (hook && a < hook.end && b > hook.start) {
      if (a < hook.start) segs.push({ start: a, end: hook.start, kind: "keep" });
      segs.push({ start: Math.max(a, hook.start), end: Math.min(b, hook.end), kind: "hook" });
      if (b > hook.end) segs.push({ start: hook.end, end: b, kind: "keep" });
    } else segs.push({ start: a, end: b, kind: "keep" });
  };
  for (const c of merged) {
    if (c.start > t) pushKeep(t, c.start);
    if (c.end - c.start > 0.05) segs.push({ ...c });
    t = Math.max(t, c.end);
  }
  if (t < duration) pushKeep(t, duration);
  const clean = segs.filter((s) => s.end - s.start > 0.05).map((s, i) => ({ id: "s" + i, ...s, start: r3(s.start), end: r3(s.end) }));

  const order = [...clean.filter((s) => s.kind === "hook"), ...clean.filter((s) => s.kind === "keep")];
  let off = 0;
  for (const s of order) {
    s.offset = off;
    off += s.end - s.start;
  }
  return { segs: clean, order, finalDuration: r3(off), hook };
}

function retime(words, order, highlightSet) {
  const out = [];
  words.forEach((w, i) => {
    const mid = (w.start + w.end) / 2;
    const seg = order.find((s) => mid >= s.start && mid <= s.end);
    if (!seg) return;
    out.push({
      i,
      text: w.text,
      start: r3(seg.offset + Math.max(0, w.start - seg.start)),
      end: r3(seg.offset + Math.min(seg.end, w.end) - seg.start),
      hl: highlightSet.has(i),
    });
  });
  return out.sort((a, b) => a.start - b.start);
}

function buildGroups(words, perGroup, duration) {
  const groups = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    groups.push({ words: cur });
    cur = [];
  };
  words.forEach((w, k) => {
    cur.push(w);
    const next = words[k + 1];
    if (cur.length >= perGroup || /[.?!,…:]$/.test(w.text) || !next || next.start - w.end >= 0.15) flush();
  });
  groups.forEach((g, k) => {
    const first = g.words[0];
    const last = g.words[g.words.length - 1];
    g.start = Math.max(k === 0 ? 0.1 : 0, first.start - 0.05);
    const nextStart = groups[k + 1] ? groups[k + 1].words[0].start - 0.05 : duration;
    g.end = Math.min(nextStart, last.end + 0.25, duration);
    if (g.end - g.start < 0.25) g.end = Math.min(duration, g.start + 0.25);
    g.text = g.words.map((w) => w.text).join(" ");
  });
  return groups;
}

/* ---------------------------------------------------------------- phase 1: listen */

export async function processJob(job) {
  const dir = dirOf(job.id);
  const project = loadProject(job.project);
  const src = path.join(dir, job.source);
  const info = await probe(src);
  if (!info.hasVideo) throw new Error("Ce fichier ne contient pas de vidéo.");
  if (!info.hasAudio) throw new Error("Cette vidéo n'a pas de son : je ne peux pas transcrire ta voix.");

  step(job, "transcribe", "active");
  say(job, "Je prépare ta vidéo");
  await run(BIN.ffmpeg, ["-v", "error", "-y", "-i", src, "-vf", "scale=-2:960,fps=30", "-c:v", "h264_videotoolbox", "-b:v", "4M", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "preview.mp4"], { cwd: dir });
  emit(job, { type: "job", name: job.name, project: project.id, duration: r3(info.duration), preview: `/media/${job.id}/preview.mp4` });

  await run(BIN.ffmpeg, ["-v", "error", "-y", "-i", src, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "audio.wav"], { cwd: dir });
  emit(job, { type: "wave", peaks: wavPeaks(path.join(dir, "audio.wav")) });
  say(job, "J'écoute ta voix");

  if (!fs.existsSync(WHISPER_MODEL)) throw new Error(`Modèle Whisper introuvable : ${WHISPER_MODEL}`);
  let lastP = -10;
  await run(BIN.whisper, ["-m", WHISPER_MODEL, "-l", "auto", "-ml", "1", "-sow", "-pp", "-oj", "-of", "transcript", "audio.wav"], {
    cwd: dir,
    onStderr: (s) => {
      const m = [...s.matchAll(/progress\s*=\s*(\d+)%/g)].pop();
      if (m && +m[1] - lastP >= 10) {
        lastP = +m[1];
        emit(job, { type: "progress", step: "transcribe", p: lastP });
      }
    },
  });
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "transcript.json"), "utf8"));
  const silences = await detectSilences(path.join(dir, "audio.wav"), project.silence, info.duration);
  // whisper tends to invent words over long silences: drop them
  const words = parseWords(raw).filter((w) => {
    const mid = (w.start + w.end) / 2;
    return !silences.some((s) => s.end - s.start > 1 && mid > s.start + 0.2 && mid < s.end - 0.2);
  });
  if (words.length < 3) throw new Error("Je n'entends presque pas de voix dans cette vidéo.");
  const lines = buildLines(words);
  const language = raw.result?.language || "?";
  emit(job, { type: "progress", step: "transcribe", p: 100 });
  emit(job, { type: "script", lines: lines.map(({ t, text }) => ({ t, text })) });
  step(job, "transcribe", "done", `${words.length} mots`);
  log(job, "Transcription terminée", `${words.length} mots, langue : ${language}`);
  say(job, `${words.length} mots, c'est noté`);

  const data = { duration: info.duration, words, lines, silences, language };
  fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify(data));

  /* the editing plan */
  step(job, "hook", "active");
  say(job, "Je relis ce que tu dis");
  let plan;
  try {
    plan = sanitizePlan(await askJSON(planPrompt(project, words, lines, info.duration), PLAN_SCHEMA), words.length, project);
  } catch (err) {
    emit(job, { type: "warn", text: err.message });
    step(job, "hook", "error", "Claude indisponible");
    log(job, "Montage de base sans Claude", "Silences coupés seulement, pas d'accroche ni de légendes");
    plan = basePlan(project);
  }
  await editPhase(job, project, data, plan);
}

/* ---------------------------------------------------------------- phase 2: edit, render, review */

async function editPhase(job, project, data, plan, { isFix = false } = {}) {
  const dir = dirOf(job.id);
  const { words, lines, silences, duration } = data;
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan, null, 2));
  job.plan = plan;

  const edit = buildEdit(words, silences, plan, duration, project.silence);
  emit(job, { type: "segments", segs: edit.segs.map(({ id, start, end, kind, reason }) => ({ id, start, end, kind, reason })), duration: r3(duration), isFix });

  /* hook */
  if (!plan.withoutClaude) {
    if (edit.hook) {
      const line = lines.findIndex((l) => plan.hook.startWord >= l.from && plan.hook.startWord <= l.to);
      emit(job, { type: "hook", segIds: edit.segs.filter((s) => s.kind === "hook").map((s) => s.id), line, reason: plan.hook.reason });
      log(job, "Accroche placée en ouverture", plan.hook.reason);
      step(job, "hook", "done", fmt(edit.hook.start));
    } else {
      say(job, "Ton début accroche déjà");
      log(job, "Début gardé", plan.hook.reason || "Le début est la meilleure accroche");
      step(job, "hook", "done", "début gardé");
    }
  }

  /* cuts */
  step(job, "cut", "active");
  const removed = edit.segs.filter((s) => s.kind === "sil" || s.kind === "bad");
  let running = duration;
  for (const s of removed) {
    running -= s.end - s.start;
    emit(job, { type: "cut", segId: s.id, kind: s.kind, reason: s.reason, duration: r3(running) });
  }
  say(job, "J'assemble les morceaux");
  await cutVideo(job, dir, edit.order);
  log(job, `${removed.length} coupes`, `${fmt(duration)} → ${fmt(edit.finalDuration)}`);
  step(job, "cut", "done", `${removed.length} coupes`);

  /* subtitles */
  step(job, "subs", "active");
  const hl = new Set(plan.highlightWords);
  const tw = retime(words, edit.order, hl);
  const groups = buildGroups(tw, plan.style.wordsPerGroup, edit.finalDuration);
  emit(job, { type: "subs", groups: groups.map((g) => ({ text: g.text, start: r3(g.start), end: r3(g.end), hl: g.words.map((w) => w.hl) })), duration: edit.finalDuration });
  log(job, "Sous-titres posés", `${groups.length} groupes de mots${hl.size ? `, ${hl.size} mots clés en couleur` : ""}`);
  step(job, "subs", "done", `${groups.length} lignes`);

  /* zooms */
  step(job, "zoom", "active");
  const zooms = [];
  for (const wi of [...plan.zoomWords].sort((a, b) => a - b)) {
    const w = tw.find((x) => x.i === wi);
    if (!w) continue;
    if (zooms.length && w.start - zooms[zooms.length - 1] < 4) continue;
    if (w.start > edit.finalDuration - 2) continue;
    zooms.push(w.start);
    if (zooms.length >= (project.zoom?.max ?? 4)) break;
  }
  emit(job, { type: "zoom", times: zooms });
  if (zooms.length) log(job, `${zooms.length} zooms ajoutés`, "sur les moments forts");
  step(job, "zoom", "done", zooms.length ? String(zooms.length) : "aucun");

  /* music */
  const music = projectMusic(project.id);
  if (music) {
    step(job, "music", "active");
    emit(job, { type: "music", state: "added", name: path.basename(music) });
    log(job, "Musique ajoutée", `${path.basename(music)}, volume bas sous ta voix`);
    step(job, "music", "done");
  } else {
    emit(job, { type: "music", state: "none" });
    step(job, "music", "skip", "pas de piste");
    log(job, "Pas de musique", `Dépose un mp3 dans projects/${project.id}/music pour l'activer`);
  }

  /* render */
  step(job, "render", "active");
  const outputs = {};
  const formats = project.formats || ["9:16"];
  for (let k = 0; k < formats.length; k++) {
    const format = formats[k];
    emit(job, { type: "render", format, p: 0 });
    let lastP = -10;
    const out = await renderFormat({
      dir,
      format,
      duration: edit.finalDuration,
      groups,
      zooms,
      music,
      project,
      style: plan.style,
      onProgress: (p) => {
        if (p - lastP >= 5 || p === 100) {
          lastP = p;
          emit(job, { type: "render", format, p });
        }
      },
    });
    const real = (await probe(out)).duration;
    if (Math.abs(real - edit.finalDuration) > 1) throw new Error(`Le rendu ${format} dure ${real.toFixed(1)} s au lieu de ${edit.finalDuration.toFixed(1)} s.`);
    outputs[format] = `/media/${job.id}/out/${path.basename(out)}?v=${Date.now()}`;
    emit(job, { type: "output", format, url: outputs[format] });
    log(job, `Rendu ${format} prêt`, `${fmt(real)}`);
  }
  step(job, "render", "done", `${formats.length} format${formats.length > 1 ? "s" : ""}`);

  /* captions */
  step(job, "captions", "active");
  if (plan.captions) {
    emit(job, { type: "captions", captions: plan.captions, networks: project.networks });
    log(job, "Légendes écrites", project.networks.join(", "));
    step(job, "captions", "done", String(project.networks.length));
  } else {
    emit(job, { type: "captions", captions: null, networks: project.networks });
    step(job, "captions", "error", "Claude indisponible");
  }

  /* review */
  update(job, { status: "review", outputs, finalDuration: edit.finalDuration, title: plan.title || job.name });
  step(job, "review", "wait");
  emit(job, { type: "review", outputs, note: plan.note || "" });
  log(job, "En attente de ta validation", "rien ne part sans ton accord");
}

async function cutVideo(job, dir, order) {
  const parts = [];
  const labels = [];
  order.forEach((s, i) => {
    const d = s.end - s.start;
    parts.push(`[0:v]trim=start=${s.start}:end=${s.end},setpts=PTS-STARTPTS[v${i}]`);
    parts.push(
      `[0:a]atrim=start=${s.start}:end=${s.end},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.02,afade=t=out:st=${Math.max(0, d - 0.03).toFixed(3)}:d=0.03[a${i}]`,
    );
    labels.push(`[v${i}][a${i}]`);
  });
  parts.push(`${labels.join("")}concat=n=${order.length}:v=1:a=1[vc][ac]`);
  parts.push(`[vc]scale=w='if(gt(iw,ih),trunc(iw*1080/ih/2)*2,1080)':h='if(gt(iw,ih),1080,trunc(ih*1080/iw/2)*2)',fps=30,format=yuv420p[vo]`);
  const total = order.reduce((a, s) => a + s.end - s.start, 0);
  let lastP = -10;
  await run(
    BIN.ffmpeg,
    ["-v", "error", "-y", "-i", job.source, "-filter_complex", parts.join(";"), "-map", "[vo]", "-map", "[ac]",
      "-c:v", "h264_videotoolbox", "-b:v", "14M", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", "cut.mp4"],
    {
      cwd: dir,
      onStdout: (s) => {
        const m = [...s.matchAll(/out_time_us=(\d+)/g)].pop();
        if (!m) return;
        const p = Math.min(100, Math.round((+m[1] / 1e6 / total) * 100));
        if (p - lastP >= 10) {
          lastP = p;
          emit(job, { type: "progress", step: "cut", p });
        }
      },
    },
  );
}

/* ---------------------------------------------------------------- after review */

export async function fixJob(job, request) {
  const dir = dirOf(job.id);
  const project = loadProject(job.project);
  const data = JSON.parse(fs.readFileSync(path.join(dir, "data.json"), "utf8"));
  const prev = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));
  emit(job, { type: "fix", text: request });
  step(job, "review", "active", "correction");
  say(job, "Compris, je corrige");
  log(job, "Correction demandée", request);
  step(job, "hook", "active");
  let plan;
  try {
    plan = sanitizePlan(await askJSON(fixPrompt(project, data.words, data.lines, data.duration, prev, request), PLAN_SCHEMA), data.words.length, project);
  } catch (err) {
    emit(job, { type: "warn", text: err.message });
    step(job, "hook", "error", "Claude indisponible");
    throw new Error("Impossible d'appliquer la correction : " + err.message);
  }
  if (plan.note) log(job, "Ce que je change", plan.note);
  await editPhase(job, project, data, plan, { isFix: true });
}

export async function exportJob(job, networks) {
  const dir = dirOf(job.id);
  const project = loadProject(job.project);
  const plan = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));
  step(job, "review", "done", "validée");
  step(job, "publish", "active");
  const slug = (plan.title || job.name).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || job.id;
  const target = path.join(EXPORTS_DIR, project.id, `${job.id.slice(0, 10)}-${slug}`);
  fs.mkdirSync(target, { recursive: true });
  for (const f of fs.readdirSync(path.join(dir, "out"))) fs.copyFileSync(path.join(dir, "out", f), path.join(target, f));
  const keys = { TikTok: "tiktok", "Instagram Reels": "instagram", "YouTube Shorts": "youtube", LinkedIn: "linkedin" };
  const md = [`# ${plan.title || job.name}`, ""];
  for (const n of networks) {
    md.push(`## ${n}`, "", plan.captions?.[keys[n]] || "(pas de légende)", "");
  }
  fs.writeFileSync(path.join(target, "legendes.md"), md.join("\n"));
  for (const n of networks) {
    emit(job, { type: "published", network: n, mode: "export" });
  }
  emit(job, { type: "exported", dir: target, networks });
  log(job, "Exporté, prêt à poster", target.replace(process.env.HOME, "~"));
  step(job, "publish", "done", "exportée");
  update(job, { status: "exported", exportDir: target, networks });
}
