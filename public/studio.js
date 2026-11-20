/* Studio: the dashboard follows the real job events and the robot acts them out. */
const $ = (s) => document.querySelector(s);
const studio = $("#studio"), robot = $("#robot"), bubble = $("#bubble"), tool = $("#tool");

const STEPS = [
  ["transcribe", "Transcription"], ["hook", "Accroche"], ["cut", "Découpe"], ["subs", "Sous-titres"], ["zoom", "Zoom"],
  ["music", "Musique"], ["render", "Rendu"], ["captions", "Légendes"], ["review", "Ta validation"], ["publish", "Export"],
];
const NET_KEYS = { TikTok: "tiktok", "Instagram Reels": "instagram", "YouTube Shorts": "youtube", LinkedIn: "linkedin" };
const STATUS = { uploading: "Envoi", queued: "En file", running: "En cours", review: "À valider", exported: "Exportée", done: "Terminée", failed: "Erreur" };

const TOOLS = {
  scissors: `<svg viewBox="0 0 8 8" shape-rendering="crispEdges"><rect x="0" y="3" width="2" height="2" fill="#EDEDEF"/><rect class="blade" x="2" y="3" width="6" height="1" fill="#EDEDEF"/><rect x="2" y="4" width="6" height="1" fill="#EDEDEF"/></svg>`,
  pen: `<svg viewBox="0 0 8 8" shape-rendering="crispEdges"><rect x="3" y="0" width="2" height="6" fill="#EDEDEF"/><rect x="3" y="6" width="2" height="2" fill="#9D8FF8"/></svg>`,
  loupe: `<svg viewBox="0 0 8 8" shape-rendering="crispEdges" fill="none"><rect x=".5" y=".5" width="4" height="4" stroke="#EDEDEF"/><rect x="5" y="5" width="2" height="2" fill="#EDEDEF"/></svg>`,
  note: `<svg viewBox="0 0 8 8" shape-rendering="crispEdges"><rect x="5" y="0" width="1" height="6" fill="#4CB782"/><rect x="2" y="5" width="4" height="3" fill="#4CB782"/><rect x="6" y="0" width="2" height="1" fill="#4CB782"/></svg>`,
  headset: `<svg viewBox="0 0 8 8" shape-rendering="crispEdges"><rect x="1" y="1" width="6" height="1" fill="#EDEDEF"/><rect x="0" y="2" width="1" height="4" fill="#EDEDEF"/><rect x="7" y="2" width="1" height="4" fill="#EDEDEF"/></svg>`,
};

/* ---------------------------------------------------------------- state */
let projects = [], project = null, currentJob = null, es = null, epoch = 0;
let queue = [], draining = false, fast = false;
let st = {};

/* ---------------------------------------------------------------- helpers */
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const speed = () => (queue.length > 12 ? 4 : queue.length > 5 ? 2 : 1);
function sleep(ms) {
  const my = epoch;
  if (fast) return Promise.resolve();
  return new Promise((res, rej) => setTimeout(() => (my === epoch ? res() : rej("stop")), ms / speed()));
}
const el = (t) => (typeof t === "string" ? $(t) : t);
function pt(target, ax = 0.5, ay = 0, dx = 0, dy = 0) {
  const r = el(target).getBoundingClientRect(), b = studio.getBoundingClientRect();
  return { x: r.left - b.left + r.width * ax + dx, y: r.top - b.top + r.height * ay + dy };
}
let pos = { x: 0, y: 0 }, lastTarget = null;
function place(x, y, ms) {
  robot.style.transitionDuration = ms + "ms";
  robot.style.transform = `translate(${x - 26}px,${y - 41}px)`;
  pos = { x, y };
}
async function go(target, ax = 0.5, ay = 0, dx = 0, dy = 0, pace = 0.9) {
  if (!el(target)) return;
  lastTarget = [target, ax, ay, dx, dy];
  const p = pt(target, ax, ay, dx, dy);
  const dist = Math.hypot(p.x - pos.x, p.y - pos.y);
  robot.classList.remove("sleeping");
  if (fast || dist < 2) return place(p.x, p.y, 0);
  robot.style.setProperty("--dir", p.x < pos.x ? -1 : 1);
  robot.classList.add("walking");
  const ms = Math.max(200, dist / pace) / speed();
  place(p.x, p.y, ms);
  await sleep(ms * speed());
  robot.classList.remove("walking");
}
function say(t) {
  if (!t) return bubble.classList.remove("show");
  bubble.textContent = t;
  const w = studio.clientWidth;
  bubble.classList.toggle("right", pos.x > w - 140);
  bubble.classList.toggle("left", pos.x < 140);
  bubble.classList.add("show");
}
const hold = (name, mode) => {
  tool.innerHTML = name ? TOOLS[name] : "";
  tool.className = "tool" + (name ? " show" : "") + (mode ? " " + mode : "");
};
const busy = (on) => robot.classList.toggle("busy", on);
function log(text, detail, kind = "", at) {
  const ul = $("#log");
  ul.querySelector(".muted")?.remove();
  const li = document.createElement("li");
  if (kind) li.className = kind;
  const s = st.t0 && at ? Math.max(0, Math.round((at - st.t0) / 1000)) : null;
  li.innerHTML = `<time>${s !== null ? fmt(s) : ""}</time><span>${esc(text)}${detail ? ` <span class="k">· ${esc(detail)}</span>` : ""}</span>`;
  ul.appendChild(li);
  ul.scrollTop = 1e6;
}
function toast(m, action) {
  const t = $("#toast");
  t.innerHTML = esc(m);
  if (action) {
    const b = document.createElement("button");
    b.textContent = action.label;
    b.onclick = action.fn;
    t.appendChild(b);
  }
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), action ? 6000 : 2800);
}
function setStep(id, state, note) {
  const li = document.querySelector(`#steps li[data-s="${id}"]`);
  if (!li) return;
  li.className = state === "wait" ? "wait" : state;
  if (note !== undefined) li.querySelector(".r").textContent = note || "";
}
function setDur(d) {
  st.dur = d;
  $("#sDur").textContent = fmt(d);
  $("#tlEnd").textContent = fmt(d);
}
function setVideo(url, label) {
  const v = $("#vid");
  if (!url) {
    v.removeAttribute("src");
    v.load();
    $("#frame").classList.remove("has-video");
    return;
  }
  if (v.getAttribute("src") !== url) {
    v.src = url;
    v.play().catch(() => {});
  }
  $("#frame").classList.add("has-video");
  $("#fLabel").textContent = label;
}

/* ---------------------------------------------------------------- reset */
function resetStage() {
  epoch++;
  queue = [];
  st = { cuts: 0, dur: 0, outputs: {}, t0: null };
  $("#steps").innerHTML = STEPS.map(([id, label]) => `<li data-s="${id}"><i></i>${label}<span class="r"></span></li>`).join("");
  $("#lines").innerHTML = "";
  $("#vtrack").innerHTML = "";
  $("#wave").innerHTML = "";
  $("#strack").innerHTML = "";
  $("#mtrack .fill").style.width = "0";
  $("#cap").innerHTML = "";
  $("#outs").innerHTML = "";
  $("#frame").classList.remove("zoom");
  $("#brk").classList.remove("show");
  $("#render").classList.remove("show");
  $("#log").innerHTML = `<li class="muted">Rien pour l'instant.</li>`;
  $("#review").classList.remove("show");
  $("#fix").classList.remove("show");
  $("#doneCard").classList.remove("show");
  $("#sCuts").textContent = "0";
  $("#sDur").textContent = "–";
  $("#sTime").textContent = "–";
  $("#tlEnd").textContent = "–";
  setVideo(null);
  say("");
  hold();
  busy(false);
  robot.className = "robot sleeping";
  requestAnimationFrame(() => {
    const p = pt("#frame", 0.5, 1, 0, -8);
    place(p.x, p.y, 0);
    lastTarget = ["#frame", 0.5, 1, 0, -8];
  });
}

/* ---------------------------------------------------------------- event handlers */
const H = {
  async hello(e) {
    const j = e.job;
    $("#jobTitle").textContent = j.title || j.name;
    $("#jobSub").textContent = STATUS[j.status] ? subFor(j.status) : "";
    st.t0 = Date.parse(j.createdAt);
    st.status = j.status;
  },
  async live() {
    fast = false;
  },
  async status(e) {
    st.status = e.status;
    $("#jobSub").textContent = subFor(e.status, e.error);
    refreshJobs();
  },
  async job(e) {
    setDur(e.duration);
    setVideo(e.preview, "Original");
    $("#jobTitle").textContent = e.name;
  },
  async step(e) {
    setStep(e.step, e.state, e.note);
  },
  async say(e) {
    say(e.text);
    await sleep(900);
  },
  async log(e) {
    log(e.text, e.detail, "", e.at);
  },
  async warn(e) {
    log(e.text, "", "warn", e.at);
    robot.classList.add("sad");
    say("Je n'arrive pas à joindre Claude");
    await sleep(1800);
    robot.classList.remove("sad");
  },
  async error(e) {
    log(e.text, "", "err", e.at);
    const active = document.querySelector("#steps li.active");
    if (active) setStep(active.dataset.s, "error", "erreur");
    hold();
    busy(false);
    robot.classList.add("sad");
    say("Oups, ça a planté");
  },
  async wave(e) {
    $("#wave").innerHTML = e.peaks.map((p) => `<i style="height:${Math.max(8, p * 92)}%"></i>`).join("");
    await go("#wave", 0.01, 0.5, 0, 6);
    hold("headset");
    busy(true);
  },
  async progress(e) {
    if (e.step === "transcribe") {
      const bars = [...document.querySelectorAll("#wave i")];
      const n = Math.round((bars.length * e.p) / 100);
      bars.forEach((b, i) => b.classList.toggle("lit", i < n));
      if (bars.length) await go(bars[Math.max(0, n - 1)], 0.5, 0.5, 0, 6, 1.6);
      if (e.p >= 100) {
        hold();
        busy(false);
      }
    } else if (e.step === "cut") {
      if (document.querySelector("#vtrack .seg")) await go("#vtrack", Math.min(0.98, e.p / 100), 0, 0, 0, 2);
    }
  },
  async script(e) {
    $("#lines").innerHTML = e.lines.map((l) => `<p><span class="tc">${fmt(l.t)}</span>${esc(l.text)}</p>`).join("");
    for (const p of document.querySelectorAll("#lines p")) {
      p.classList.add("show");
      await sleep(90);
    }
    document.querySelectorAll("#wave i").forEach((b) => b.classList.add("lit"));
  },
  async segments(e) {
    st.segDur = e.duration;
    if (e.isFix) {
      $("#strack").innerHTML = "";
      $("#cap").innerHTML = "";
      $("#outs").innerHTML = "";
      $("#mtrack .fill").style.width = "0";
      $("#frame").classList.remove("zoom");
      $("#review").classList.remove("show");
      st.cuts = 0;
      $("#sCuts").textContent = "0";
      setDur(e.duration);
    }
    $("#vtrack").innerHTML = e.segs
      .map((s) => `<div class="seg ${s.kind === "hook" ? "keep" : s.kind}" id="seg-${s.id}" data-k="${s.kind}" style="flex-grow:${(s.end - s.start).toFixed(3)}" title="${esc(s.reason || "")}"></div>`)
      .join("");
  },
  async hook(e) {
    const line = document.querySelectorAll("#lines p")[e.line];
    if (line) {
      await go(line, 0.85, 0, 0, 2);
      hold("loupe");
      say("Celle-là accroche");
      line.classList.add("hook");
      await sleep(1300);
    }
    const segs = e.segIds.map((id) => $("#seg-" + id)).filter(Boolean);
    if (segs.length) {
      segs.forEach((s) => s.classList.add("hook", "lift"));
      segs[0].textContent = "Accroche";
      await go(segs[0], 0.5, 0);
      say("Je la mets au début");
      await sleep(600);
      await go("#vtrack", 0.03, 0, 0, 0, 0.7);
      segs.reverse().forEach((s) => $("#vtrack").prepend(s));
      segs.forEach((s) => s.classList.remove("lift"));
      const f = $("#flash");
      f.classList.remove("go");
      void f.offsetWidth;
      f.classList.add("go");
    }
    hold();
    log("Accroche placée en ouverture", e.reason, "", e.at);
    await sleep(400);
  },
  async cut(e) {
    const s = $("#seg-" + e.segId);
    if (!s) return;
    s.classList.add("target");
    await go(s, 0.5, 0, 0, 0, 1.2);
    hold("scissors", "snip");
    busy(true);
    say(e.kind === "bad" ? e.reason || "Prise ratée, je retire" : "Silence, je coupe");
    await sleep(e.kind === "bad" ? 1100 : 550);
    s.classList.add("cut");
    st.cuts++;
    $("#sCuts").textContent = st.cuts;
    setDur(e.duration);
    if (e.kind === "bad") log("Passage retiré", e.reason, "", e.at);
    busy(false);
    hold();
    await sleep(200);
  },
  async subs(e) {
    await go("#cap", 0.5, 0, 0, -8);
    hold("pen");
    busy(true);
    say("J'écris les sous-titres");
    const total = e.duration || 1;
    $("#strack").innerHTML = "";
    const shown = e.groups.slice(0, 6);
    for (const g of e.groups) {
      const c = document.createElement("div");
      c.className = "chip" + (g.hl.some(Boolean) ? " hl" : "");
      c.style.flexGrow = Math.max(0.1, g.end - g.start).toFixed(2);
      c.title = g.text;
      $("#strack").appendChild(c);
    }
    for (const g of shown) {
      const words = g.text.split(" ");
      $("#cap").innerHTML = words.map((w, i) => `<span class="${g.hl[i] ? "hot" : ""}">${esc(w)}</span>`).join("");
      await sleep(520);
    }
    $("#cap").innerHTML = "";
    busy(false);
    hold();
  },
  async zoom(e) {
    if (!e.times.length) return;
    await go("#frame", 0.8, 0.3);
    say(e.times.length > 1 ? `${e.times.length} zooms sur les moments forts` : "Un zoom sur le moment fort");
    $("#brk").classList.add("show");
    await sleep(500);
    $("#frame").classList.add("zoom");
    await sleep(1200);
    $("#frame").classList.remove("zoom");
    $("#brk").classList.remove("show");
  },
  async music(e) {
    if (e.state !== "added") {
      await go("#mtrack", 0.05, 0.5, 0, 6);
      say("Pas de musique dans le projet, je passe");
      await sleep(1200);
      return;
    }
    await go("#mtrack", 0.02, 0.5, 0, 6);
    hold("note");
    say("Un peu de musique");
    for (let p = 0; p <= 100; p += 20) {
      $("#mtrack .fill").style.width = p + "%";
      await go("#mtrack", Math.max(0.02, (p / 100) * 0.96), 0.5, 0, 6, 1.8);
    }
    hold();
  },
  async render(e) {
    let out = document.getElementById("out-" + e.format.replace(":", "x"));
    if (!out) {
      out = document.createElement("div");
      out.className = "out show";
      out.id = "out-" + e.format.replace(":", "x");
      const [w, h] = e.format === "9:16" ? [14, 24] : e.format === "4:5" ? [18, 22] : [24, 14];
      out.innerHTML = `<div class="shape" style="width:${w}px;height:${h}px"></div><div style="flex:1"><b>${e.format}</b><span>Rendu en cours</span><div class="bar"><i></i></div></div>`;
      $("#outs").appendChild(out);
    }
    out.querySelector(".bar i").style.width = e.p + "%";
    $("#render").classList.add("show");
    $("#render i").style.width = e.p + "%";
    busy(true);
    await go("#vtrack", Math.min(0.98, e.p / 100), 0, 0, 0, 2.5);
    say(`Rendu ${e.format} : ${e.p} %`);
  },
  async output(e) {
    st.outputs[e.format] = e.url;
    const out = document.getElementById("out-" + e.format.replace(":", "x"));
    if (out) {
      out.classList.add("ready");
      out.querySelector("span").textContent = "Prêt, clique pour voir";
      out.onclick = () => setVideo(e.url, e.format);
    }
    $("#render").classList.remove("show");
    busy(false);
    if (e.format === "9:16" || !st.outputs["9:16"]) setVideo(e.url, e.format);
  },
  async captions(e) {
    st.networks = e.networks;
    $("#nets").innerHTML = e.networks
      .map((n) => {
        const txt = e.captions ? e.captions[NET_KEYS[n]] || "" : "";
        return `<label class="net"><div class="n"><span>${esc(n)}</span><input type="checkbox" data-net="${esc(n)}" ${n === "LinkedIn" ? "" : "checked"}></div>${
          e.captions ? `<textarea rows="3" data-cap="${esc(n)}">${esc(txt)}</textarea>` : `<p style="color:var(--faint)">Pas de légende : Claude n'était pas connecté.</p>`
        }</label>`;
      })
      .join("");
    if (e.captions) {
      await go("#outs", 0.1, 1, 0, 0);
      hold("pen");
      say("J'écris une légende par réseau");
      await sleep(1200);
      hold();
    }
  },
  async review(e) {
    await go("#frame", 1, 1, 34, 0);
    robot.style.setProperty("--dir", -1);
    robot.classList.add("look-up");
    say("C'est bon pour toi ?");
    $("#reviewNote").textContent = e.note || "Regarde le rendu, relis les légendes et choisis les réseaux.";
    if (st.status === "review" || !st.status) $("#review").classList.add("show");
  },
  async fix(e) {
    $("#review").classList.remove("show");
    robot.classList.remove("look-up");
    say("Compris, je corrige");
    await sleep(900);
  },
  async published(e) {
    const p = document.createElement("div");
    p.className = "plane";
    p.style.left = pos.x + 10 + "px";
    p.style.top = pos.y - 30 + "px";
    p.innerHTML = `<svg viewBox="0 0 8 5" shape-rendering="crispEdges" width="16" height="10"><rect x="0" y="2" width="8" height="1" fill="#EDEDEF"/><rect x="2" y="1" width="5" height="1" fill="#EDEDEF"/><rect x="4" y="0" width="2" height="1" fill="#EDEDEF"/><rect x="2" y="3" width="4" height="1" fill="#EDEDEF"/></svg>`;
    if (!fast) {
      studio.appendChild(p);
      setTimeout(() => p.remove(), 1400);
    }
    say("Prêt pour " + e.network);
    await sleep(700);
  },
  async exported(e) {
    robot.classList.remove("look-up");
    robot.classList.add("jump");
    say("C'est exporté !");
    $("#review").classList.remove("show");
    $("#doneText").textContent = `Les vidéos et les légendes sont dans ${e.dir.replace(/^\/Users\/[^/]+/, "~")}. La publication automatique sur les réseaux n'est pas encore branchée.`;
    $("#doneCard").classList.add("show");
    if (!fast) toast("Exportée : vidéos et légendes prêtes", { label: "Ouvrir le dossier", fn: reveal });
    await sleep(1300);
    robot.classList.remove("jump");
  },
};

function subFor(status, error) {
  return (
    {
      uploading: "Envoi de la vidéo…",
      queued: "En file d'attente, Claude finit une autre vidéo",
      running: "Claude monte ta vidéo pour " + (project?.name || ""),
      review: "Prête, en attente de ta validation",
      exported: "Exportée, prête à poster",
      done: "Terminée",
      failed: "Le montage a échoué" + (error ? " : " + error.split("\n")[0] : ""),
    }[status] || ""
  );
}

/* ---------------------------------------------------------------- event queue */
function push(e) {
  queue.push(e);
  if (!draining) drain();
}
async function drain() {
  draining = true;
  const my = epoch;
  while (queue.length && my === epoch) {
    const e = queue.shift();
    fast = !!e.history || st.status === undefined;
    if (e.type === "hello" || e.type === "live") fast = false;
    try {
      await (H[e.type] || (async () => {}))(e);
    } catch (err) {
      if (err !== "stop") console.error(err);
    }
  }
  fast = false;
  draining = false;
  if (my !== epoch && queue.length) drain();
}

/* ---------------------------------------------------------------- jobs */
function openJob(id) {
  if (es) es.close();
  resetStage();
  currentJob = id;
  history.replaceState(null, "", id ? "#job=" + id : "#");
  refreshJobs();
  if (!id) {
    $("#jobTitle").textContent = "Aucune vidéo";
    $("#jobSub").textContent = "Glisse une vidéo pour que Claude la monte";
    return;
  }
  st.status = undefined;
  es = new EventSource(`/api/jobs/${id}/events`);
  es.onmessage = (m) => push(JSON.parse(m.data));
}

async function refreshJobs() {
  if (!project) return;
  const jobs = await fetch(`/api/jobs?project=${project.id}`).then((r) => r.json()).catch(() => []);
  $("#jobs").innerHTML = jobs.length
    ? jobs
        .map(
          (j) =>
            `<li data-id="${j.id}" class="${j.id === currentJob ? "on" : ""}"><span class="d ${j.status}"></span><span class="t">${esc(j.title || j.name)}</span><span class="s">${STATUS[j.status] || j.status}</span></li>`,
        )
        .join("")
    : `<li class="muted">Aucune vidéo pour l'instant.</li>`;
  document.querySelectorAll("#jobs li[data-id]").forEach((li) => (li.onclick = () => openJob(li.dataset.id)));
  return jobs;
}

addEventListener("hashchange", () => {
  const id = location.hash.match(/job=([\w-]+)/)?.[1];
  if (id && id !== currentJob) openJob(id);
});
setInterval(refreshJobs, 5000);

setInterval(() => {
  if (st.t0 && ["running", "queued"].includes(st.status)) $("#sTime").textContent = fmt((Date.now() - st.t0) / 1000);
}, 1000);

/* ---------------------------------------------------------------- upload */
function upload(f) {
  if (!f) return;
  if (!/^video\//.test(f.type) && !/\.(mov|mp4|m4v|webm|mkv)$/i.test(f.name)) return toast("Ce fichier n'est pas une vidéo");
  openJob(null);
  $("#jobTitle").textContent = f.name;
  robot.classList.remove("sleeping");
  const xhr = new XMLHttpRequest();
  xhr.open("POST", `/api/upload?project=${project.id}&name=${encodeURIComponent(f.name)}`);
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const p = Math.round((e.loaded / e.total) * 100);
      $("#jobSub").textContent = `Envoi de la vidéo : ${p} %`;
      say(`Je reçois ta vidéo : ${p} %`);
    }
  };
  xhr.onload = () => {
    const r = JSON.parse(xhr.responseText || "{}");
    if (xhr.status !== 200) return toast(r.error || "L'envoi a échoué");
    openJob(r.id);
  };
  xhr.onerror = () => toast("L'envoi a échoué : le serveur ne répond pas");
  xhr.send(f);
}
const file = $("#file");
$("#uploadTop").onclick = () => file.click();
$("#empty").onclick = () => file.click();
file.onchange = () => {
  upload(file.files[0]);
  file.value = "";
};
let dragDepth = 0;
addEventListener("dragenter", (e) => {
  if ([...(e.dataTransfer?.types || [])].includes("Files")) {
    dragDepth++;
    $("#dropcover").classList.add("show");
  }
});
addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $("#dropcover").classList.remove("show");
  }
});
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("#dropcover").classList.remove("show");
  upload(e.dataTransfer.files[0]);
});

/* ---------------------------------------------------------------- review actions */
$("#approve").onclick = async () => {
  const networks = [...document.querySelectorAll("#nets input:checked")].map((i) => i.dataset.net);
  if (!networks.length) return toast("Coche au moins un réseau");
  const r = await fetch(`/api/jobs/${currentJob}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ networks }) });
  if (!r.ok) return toast((await r.json()).error || "Impossible de valider");
  $("#review").classList.remove("show");
};
$("#fixBtn").onclick = () => {
  $("#fix").classList.toggle("show");
  $("#fixText").focus();
};
$("#sendFix").onclick = async () => {
  const text = $("#fixText").value.trim();
  if (!text) return $("#fixText").focus();
  const r = await fetch(`/api/jobs/${currentJob}/fix`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  if (!r.ok) return toast((await r.json()).error || "Impossible d'envoyer la correction");
  $("#fixText").value = "";
  $("#fix").classList.remove("show");
  $("#review").classList.remove("show");
};
function reveal() {
  if (currentJob) fetch(`/api/jobs/${currentJob}/reveal`, { method: "POST" });
}
$("#reveal").onclick = reveal;
$("#sound").onclick = () => {
  const v = $("#vid");
  v.muted = !v.muted;
  $("#sound").textContent = v.muted ? "Son coupé" : "Son activé";
};

/* ---------------------------------------------------------------- projects */
function setProject(p) {
  project = p;
  $("#projSw").textContent = p.initial || p.name[0];
  $("#projSw").style.background = p.color || "#7C6CF0";
  $("#projName").textContent = p.name;
  document.querySelectorAll(".pname").forEach((n) => (n.textContent = p.name));
}
$("#projBtn").onclick = (e) => {
  e.stopPropagation();
  $("#menu").classList.toggle("open");
};
document.addEventListener("click", () => $("#menu").classList.remove("open"));

addEventListener("resize", () => {
  if (lastTarget) {
    const [t, ax, ay, dx, dy] = lastTarget;
    if (el(t)) {
      const p = pt(t, ax, ay, dx, dy);
      place(p.x, p.y, 0);
    }
  }
});

(async function init() {
  resetStage();
  projects = await fetch("/api/projects").then((r) => r.json());
  setProject(projects[0]);
  $("#menu").innerHTML =
    projects.map((p) => `<button data-p="${p.id}"><span class="sw" style="background:${p.color}">${esc(p.initial || p.name[0])}</span>${esc(p.name)}</button>`).join("") +
    `<button class="add" id="addProj"><span class="sw" style="background:transparent;border:1px dashed var(--faint);color:var(--muted)">+</span>Nouveau projet</button>`;
  document.querySelectorAll("#menu [data-p]").forEach(
    (b) =>
      (b.onclick = async () => {
        setProject(projects.find((p) => p.id === b.dataset.p));
        const jobs = await refreshJobs();
        openJob(jobs[0]?.id || null);
      }),
  );
  $("#addProj").onclick = () => toast("Pour l'instant : copie projects/move dans un nouveau dossier et modifie project.json");
  await document.fonts.ready;
  const jobs = await refreshJobs();
  const fromHash = location.hash.match(/job=([\w-]+)/)?.[1];
  openJob(fromHash || jobs[0]?.id || null);
})();
