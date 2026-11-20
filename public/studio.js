/* Studio: the screen follows the real job events and the robot acts them out. */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const studio = $("#studio"), robot = $("#robot"), bubble = $("#bubble"), tool = $("#tool");

const STEPS = [
  ["transcribe", "Transcription"], ["hook", "Accroche"], ["cut", "Découpe"], ["subs", "Sous-titres"], ["zoom", "Zooms"],
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
const slug = (f) => f.replace(":", "x");
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
function sideBubble() {
  const w = studio.clientWidth;
  bubble.classList.toggle("right", pos.x > w - 170);
  bubble.classList.toggle("left", pos.x < 170);
}
function place(x, y, ms) {
  x = Math.max(30, Math.min(studio.clientWidth - 30, x));
  robot.style.transitionDuration = ms + "ms";
  robot.style.transform = `translate(${x - 26}px,${y - 41}px)`;
  pos = { x, y };
  sideBubble();
}
async function go(target, ax = 0.5, ay = 0, dx = 0, dy = 0, pace = 0.9) {
  const t = el(target);
  if (!t || !t.getClientRects().length) return; // hidden or missing: stay where we are
  lastTarget = [target, ax, ay, dx, dy];
  const p = pt(t, ax, ay, dx, dy);
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
  sideBubble();
  bubble.classList.add("show");
}
const hold = (name, mode) => {
  tool.innerHTML = name ? TOOLS[name] : "";
  tool.className = "tool" + (name ? " show" : "") + (mode ? " " + mode : "");
};
const busy = (on) => robot.classList.toggle("busy", on);

function log(text, detail, kind = "", at) {
  const ul = $("#log");
  ul.querySelector(".none")?.remove();
  const li = document.createElement("li");
  if (kind) li.className = kind;
  const s = st.t0 && at ? Math.max(0, Math.round((at - st.t0) / 1000)) : null;
  li.innerHTML = `<time>${s !== null ? fmt(s) : ""}</time><span>${esc(text)}${detail ? ` <span class="k">${esc(detail)}</span>` : ""}</span>`;
  ul.appendChild(li);
}
function toast(m, action) {
  const t = $("#toast");
  t.textContent = m;
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

/* ---------------------------------------------------------------- views, tabs, header */
function showView(name) {
  $("#home").hidden = name !== "home";
  $("#work").hidden = name !== "work";
}
function showTab(name) {
  $$("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  for (const t of ["review", "activity", "script"]) $("#tab-" + t).hidden = t !== name;
}
$$("#tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
function reviewTab(visible, label) {
  const b = $('#tabs [data-tab="review"]');
  b.hidden = !visible;
  if (label) b.textContent = label;
  if (!visible && b.classList.contains("on")) showTab("activity");
}

function setStep(id, state, note) {
  const li = $(`#steps li[data-s="${id}"]`);
  if (!li) return;
  li.className = state;
  if (note !== undefined) li.querySelector(".r").textContent = note || "";
  const done = $$("#steps li.done, #steps li.skip, #steps li.error").length;
  $("#prog").style.width = (done / STEPS.length) * 100 + "%";
  $(".prog").classList.toggle("done", done === STEPS.length);
  st.stepLabel = $("#steps li.active .l")?.textContent || "";
  renderSub();
}
function renderSub() {
  const s = st.status;
  let t = "";
  if (s === "uploading") t = "Envoi de la vidéo";
  else if (s === "queued") t = "En file d'attente : Claude termine une autre vidéo";
  else if (s === "running") t = "Claude monte ta vidéo" + (st.stepLabel ? " · " + st.stepLabel : "");
  else if (s === "review") t = "Prête. Regarde le rendu, puis valide ou demande une correction.";
  else if (s === "exported") t = "Exportée, prête à poster";
  else if (s === "failed") t = "Le montage s'est arrêté";
  $("#jobSub").textContent = t;
}
function renderMeta() {
  const parts = [];
  if (st.dur) parts.push(st.srcDur && Math.abs(st.srcDur - st.dur) > 0.5 ? `${fmt(st.srcDur)} → ${fmt(st.dur)}` : fmt(st.dur));
  if (st.cuts) parts.push(`${st.cuts} coupe${st.cuts > 1 ? "s" : ""}`);
  $("#meta").textContent = parts.join(" · ");
  $("#tlEnd").textContent = st.dur ? fmt(st.dur) : "";
}
function alertBar(text, kind) {
  if (text !== undefined) st.alert = text ? [text, kind] : null;
  [text, kind] = st.alert || [];
  $("#retry").hidden = !["failed", "review"].includes(st.status);
  $("#alert").hidden = !text;
  $("#alert").className = "alert" + (kind === "err" ? " err" : "");
  $("#alertText").textContent = text || "";
}

/* ---------------------------------------------------------------- video and formats */
function addFormat(key, label, url) {
  let b = $(`#fmts [data-f="${key}"]`);
  if (!b) {
    b = document.createElement("button");
    b.dataset.f = key;
    b.setAttribute("role", "tab");
    b.onclick = () => selectFormat(key);
    $("#fmts").appendChild(b);
  }
  b.textContent = label;
  b.disabled = !url;
  if (url) b.dataset.url = url;
  return b;
}
function selectFormat(key) {
  const b = $(`#fmts [data-f="${key}"]`);
  if (!b || !b.dataset.url) return;
  $$("#fmts button").forEach((x) => x.classList.toggle("on", x === b));
  const v = $("#vid"), f = $("#frame");
  f.classList.remove("r4x5", "r16x9");
  if (key === "4x5") f.classList.add("r4x5");
  if (key === "16x9") f.classList.add("r16x9");
  if (v.getAttribute("src") !== b.dataset.url) {
    v.src = b.dataset.url;
    v.play().catch(() => {});
  }
  f.classList.add("has-video");
  const final = key !== "original";
  v.controls = final;
  if (!final) v.muted = true;
}

/* ---------------------------------------------------------------- reset */
function resetStage() {
  epoch++;
  queue = [];
  st = { cuts: 0, bad: 0, dur: 0, srcDur: 0, zooms: 0, hook: null, t0: null, status: undefined };
  $("#steps").innerHTML = STEPS.map(([id, label]) => `<li data-s="${id}"><i></i><span class="l">${label}</span><span class="r"></span></li>`).join("");
  for (const id of ["#lines", "#vtrack", "#wave", "#strack", "#cap", "#fmts", "#nets", "#facts"]) $(id).innerHTML = "";
  $("#mtrack .fill").style.width = "0";
  $("#musicRow").hidden = true;
  $("#scriptEmpty").hidden = false;
  $("#frame").className = "frame";
  $("#wait").textContent = "Envoi de la vidéo…";
  $("#brk").classList.remove("show");
  $("#render").classList.remove("show");
  $("#log").innerHTML = `<li class="none">Rien pour l'instant.</li>`;
  $("#prog").style.width = "0";
  $(".prog").classList.remove("done");
  $("#fix").hidden = true;
  $("#acts").hidden = false;
  $("#doneActs").hidden = true;
  $("#reviewHint").hidden = false;
  $("#reviewTitle").textContent = "Prête. Tu valides ?";
  $("#reviewNote").textContent = "";
  reviewTab(false, "Validation");
  showTab("activity");
  alertBar("");
  renderMeta();
  const v = $("#vid");
  v.controls = false;
  v.muted = true;
  v.removeAttribute("src");
  v.load();
  say("");
  hold();
  busy(false);
  robot.className = "robot";
  const p = pt("#vtrack", 0.02, 0);
  place(p.x, p.y, 0);
  lastTarget = ["#vtrack", 0.02, 0, 0, 0];
}

/* ---------------------------------------------------------------- review panel */
function renderFacts() {
  const rows = [];
  if (st.srcDur && st.dur) rows.push(["Durée", `${fmt(st.srcDur)} → ${fmt(st.dur)}`]);
  const sil = st.cuts - st.bad;
  const plural = (n, word) => `${n} ${word}${n > 1 ? "s" : ""}`;
  const cuts = [sil ? plural(sil, "silence") : "", st.bad ? plural(st.bad, "passage") : ""].filter(Boolean);
  rows.push(["Coupé", cuts.join(", ") || "rien"]);
  if (st.hook !== null) rows.push(["Accroche", st.hook ? "déplacée au début" : "début gardé"]);
  rows.push(["Zooms", st.zooms ? String(st.zooms) : "aucun"]);
  rows.push(["Formats", $$("#fmts button").filter((b) => b.dataset.f !== "original").map((b) => b.dataset.f.replace("x", ":")).join(", ") || "–"]);
  $("#facts").innerHTML = rows.map(([a, b]) => `<li><span>${a}</span><span>${esc(b)}</span></li>`).join("");
}
function collectCaptions() {
  const out = {};
  $$("#nets textarea").forEach((t) => (out[NET_KEYS[t.dataset.cap]] = t.value.trim()));
  return Object.keys(out).length ? out : null;
}

/* ---------------------------------------------------------------- event handlers */
const H = {
  async hello(e) {
    const j = e.job;
    $("#jobTitle").textContent = j.title || j.name;
    st.title = j.title || "";
    st.t0 = Date.parse(j.createdAt);
    st.status = j.status;
    renderSub();
    if (j.status === "failed") alertBar((j.error || "Le montage a échoué.").split("\n")[0], "err");
  },
  async live() {
    fast = false;
  },
  async status(e) {
    st.status = e.status;
    renderSub();
    alertBar();
    if (e.status === "failed") alertBar((e.error || "Le montage a échoué.").split("\n")[0], "err");
    refreshJobs();
  },
  async job(e) {
    st.srcDur = e.duration;
    st.dur = e.duration;
    renderMeta();
    if (!st.title) $("#jobTitle").textContent = e.name;
    addFormat("original", "Original", e.preview);
    selectFormat("original");
  },
  async step(e) {
    setStep(e.step, e.state, e.note);
    if (e.step === "hook") {
      // Claude is reading the transcript: this is the longest quiet moment, so show it
      const thinking = e.state === "active";
      if (thinking) await go("#wave", 0.5, 0.5, 0, 6);
      hold(thinking ? "loupe" : null);
      busy(thinking);
    }
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
    alertBar("Montage de base seulement : silences coupés, sans accroche ni légendes. " + e.text);
    robot.classList.add("sad");
    say("Je n'arrive pas à joindre Claude");
    await sleep(1800);
    robot.classList.remove("sad");
  },
  async error(e) {
    log(e.text, "", "err", e.at);
    const active = $("#steps li.active");
    if (active) setStep(active.dataset.s, "error", "erreur");
    hold();
    busy(false);
    $("#render").classList.remove("show");
    robot.classList.add("sad");
    say("Ça a planté");
  },
  async wave(e) {
    $("#wave").innerHTML = e.peaks.map((p) => `<i style="height:${Math.max(8, p * 92)}%"></i>`).join("");
    await go("#wave", 0.01, 0.5, 0, 6);
    hold("headset");
    busy(true);
  },
  async progress(e) {
    if (e.step === "transcribe") {
      const bars = $$("#wave i");
      const n = Math.round((bars.length * e.p) / 100);
      bars.forEach((b, i) => b.classList.toggle("lit", i < n));
      if (bars.length) await go(bars[Math.max(0, n - 1)], 0.5, 0.5, 0, 6, 1.6);
      if (e.p >= 100) {
        hold();
        busy(false);
      }
    } else if (e.step === "cut" && $("#vtrack .seg")) {
      await go("#vtrack", Math.min(0.98, e.p / 100), 0, 0, 0, 2);
    }
  },
  async script(e) {
    $("#scriptEmpty").hidden = true;
    $("#lines").innerHTML = e.lines.map((l) => `<p><span class="tc">${fmt(l.t)}</span>${esc(l.text)}</p>`).join("");
    $$("#wave i").forEach((b) => b.classList.add("lit"));
  },
  async segments(e) {
    if (e.isFix) {
      for (const id of ["#strack", "#cap"]) $(id).innerHTML = "";
      $$("#fmts button").forEach((b) => b.dataset.f !== "original" && b.remove());
      selectFormat("original");
      $("#mtrack .fill").style.width = "0";
      st.cuts = 0;
      st.bad = 0;
      st.zooms = 0;
      st.hook = null;
    }
    st.dur = e.duration;
    renderMeta();
    $("#vtrack").innerHTML = e.segs
      .map((s) => `<div class="seg ${s.kind === "hook" ? "keep" : s.kind}" id="seg-${s.id}" style="flex-grow:${(s.end - s.start).toFixed(3)}" title="${esc(s.reason || "")}"></div>`)
      .join("");
    $$("#lines p").forEach((p) => p.classList.remove("hook"));
    if (st.hook === null) st.hook = false;
  },
  async hook(e) {
    st.hook = true;
    $$("#lines p")[e.line]?.classList.add("hook");
    const segs = e.segIds.map((id) => $("#seg-" + id)).filter(Boolean);
    if (!segs.length) return;
    await go(segs[0], 0.5, 0);
    hold("loupe");
    say("Cette phrase accroche mieux");
    segs.forEach((s) => s.classList.add("hook"));
    segs[0].textContent = "Accroche";
    await sleep(1400);
    say("Je la mets au début");
    segs.forEach((s) => s.classList.add("lift"));
    await sleep(500);
    await go("#vtrack", 0.03, 0, 0, 0, 0.7);
    [...segs].reverse().forEach((s) => $("#vtrack").prepend(s));
    segs.forEach((s) => s.classList.remove("lift"));
    const f = $("#flash");
    f.classList.remove("go");
    void f.offsetWidth;
    f.classList.add("go");
    hold();
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
    await sleep(e.kind === "bad" ? 1200 : 520);
    s.classList.add("cut");
    st.cuts++;
    if (e.kind === "bad") st.bad++;
    st.dur = e.duration;
    renderMeta();
    if (e.kind === "bad") log("Passage retiré", e.reason, "", e.at);
    busy(false);
    hold();
    await sleep(180);
  },
  async subs(e) {
    await go("#cap", 0.5, 0, 0, -8);
    hold("pen");
    busy(true);
    say("J'écris les sous-titres");
    $("#strack").innerHTML = e.groups
      .map((g) => `<div class="chip${g.hl.some(Boolean) ? " hl" : ""}" style="flex-grow:${Math.max(0.1, g.end - g.start).toFixed(2)}" title="${esc(g.text)}"></div>`)
      .join("");
    for (const g of e.groups.slice(0, 5)) {
      $("#cap").innerHTML = g.text.split(" ").map((w, i) => `<span class="${g.hl[i] ? "hot" : ""}">${esc(w)}</span>`).join("");
      await sleep(520);
    }
    $("#cap").innerHTML = "";
    busy(false);
    hold();
  },
  async zoom(e) {
    st.zooms = e.times.length;
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
    if (e.state !== "added") return;
    $("#musicRow").hidden = false;
    await go("#mtrack", 0.02, 0.5, 0, 6);
    hold("note");
    say("J'ajoute la musique");
    for (let p = 0; p <= 100; p += 20) {
      $("#mtrack .fill").style.width = p + "%";
      await go("#mtrack", Math.max(0.02, (p / 100) * 0.96), 0.5, 0, 6, 1.8);
    }
    hold();
  },
  async render(e) {
    addFormat(slug(e.format), `${e.format} · ${e.p} %`);
    $("#render").classList.add("show");
    $("#render i").style.width = e.p + "%";
    busy(true);
    await go("#vtrack", Math.min(0.98, e.p / 100), 0, 0, 0, 2.5);
    say(`Rendu ${e.format} : ${e.p} %`);
  },
  async output(e) {
    addFormat(slug(e.format), e.format, e.url);
    $("#render").classList.remove("show");
    $("#render i").style.width = "0";
    busy(false);
    const first = $$("#fmts button").filter((b) => b.dataset.f !== "original" && b.dataset.url).length === 1;
    if (first || e.format === "9:16") selectFormat(slug(e.format));
  },
  async captions(e) {
    $("#nets").innerHTML = e.networks
      .map((n, k) => {
        const txt = e.captions ? e.captions[NET_KEYS[n]] || "" : "";
        return `<div class="net"><div class="n"><label><input type="checkbox" data-net="${esc(n)}" ${n === "LinkedIn" ? "" : "checked"}>${esc(n)}</label>${
          e.captions ? `<button class="copy" data-copy="${k}">Copier</button>` : ""
        }</div>${e.captions ? `<textarea data-cap="${esc(n)}" aria-label="Légende ${esc(n)}">${esc(txt)}</textarea>` : `<p class="missing">Pas de légende : Claude n'était pas joignable.</p>`}</div>`;
      })
      .join("");
    $$("#nets .copy").forEach(
      (b) =>
        (b.onclick = async () => {
          await navigator.clipboard.writeText(b.closest(".net").querySelector("textarea").value);
          toast("Légende copiée");
        }),
    );
    $$("#nets input").forEach((i) => (i.onchange = () => i.closest(".net").classList.toggle("off", !i.checked)));
    $$("#nets input").forEach((i) => i.onchange());
    if (st.status === "exported") $$("#nets input, #nets textarea").forEach((i) => (i.disabled = true));
    if (e.captions) {
      await go("#fmts", 0.5, 1, 0, 26);
      hold("pen");
      say("J'écris une légende par réseau");
      await sleep(1200);
      hold();
    }
  },
  async review(e) {
    $("#reviewNote").textContent = e.note || "";
    renderFacts();
    if (st.status === "review") {
      $("#acts").hidden = false;
      $("#doneActs").hidden = true;
      $("#reviewHint").hidden = false;
      $("#reviewTitle").textContent = "Prête. Tu valides ?";
      reviewTab(true, "Validation");
      showTab("review");
    }
    await go("#frame", 1, 1, 34, 0);
    robot.style.setProperty("--dir", -1);
    robot.classList.add("look-up");
    say("C'est bon pour toi ?");
  },
  async fix() {
    reviewTab(false);
    $("#fix").hidden = true;
    robot.classList.remove("look-up");
    say("Compris, je corrige");
    await sleep(900);
  },
  async published(e) {
    if (!fast) {
      const p = document.createElement("div");
      p.className = "plane";
      p.style.left = pos.x + 10 + "px";
      p.style.top = pos.y - 30 + "px";
      p.innerHTML = `<svg viewBox="0 0 8 5" shape-rendering="crispEdges" width="16" height="10"><rect x="0" y="2" width="8" height="1" fill="#EDEDEF"/><rect x="2" y="1" width="5" height="1" fill="#EDEDEF"/><rect x="4" y="0" width="2" height="1" fill="#EDEDEF"/><rect x="2" y="3" width="4" height="1" fill="#EDEDEF"/></svg>`;
      studio.appendChild(p);
      setTimeout(() => p.remove(), 1400);
    }
    say("Prêt pour " + e.network);
    await sleep(600);
  },
  async exported(e) {
    renderFacts();
    $("#reviewTitle").textContent = "Exportée";
    $("#reviewNote").textContent = `Les vidéos et les légendes sont dans ${e.dir.replace(/^\/Users\/[^/]+/, "~")}. Il te reste à les poster : la publication automatique n'est pas encore branchée.`;
    $("#acts").hidden = true;
    $("#fix").hidden = true;
    $("#reviewHint").hidden = true;
    $("#doneActs").hidden = false;
    $$("#nets input, #nets textarea").forEach((i) => (i.disabled = true));
    reviewTab(true, "Export");
    showTab("review");
    robot.classList.remove("look-up");
    await go("#frame", 1, 1, 34, 0);
    robot.style.setProperty("--dir", -1);
    robot.classList.add("jump");
    say("C'est exporté");
    await sleep(1300);
    robot.classList.remove("jump");
  },
};

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
    fast = !!e.history;
    try {
      await (H[e.type] || (async () => {}))(e);
    } catch (err) {
      if (err !== "stop") console.error(err);
    }
  }
  fast = false;
  draining = false;
  if (queue.length) drain();
}

/* ---------------------------------------------------------------- jobs */
function openJob(id) {
  if (es) es.close();
  es = null;
  currentJob = id;
  history.replaceState(null, "", id ? "#job=" + id : location.pathname);
  refreshJobs();
  if (!id) return showView("home");
  showView("work");
  resetStage();
  $("#wait").textContent = "Chargement…";
  es = new EventSource(`/api/jobs/${id}/events`);
  es.onmessage = (m) => push(JSON.parse(m.data));
}

async function refreshJobs() {
  if (!project) return [];
  const jobs = await fetch(`/api/jobs?project=${project.id}`).then((r) => r.json()).catch(() => []);
  $("#jobs").innerHTML = jobs.length
    ? jobs
        .map(
          (j) =>
            `<li data-id="${j.id}" tabindex="0" class="${j.id === currentJob ? "on" : ""}"><span class="d ${j.status}"></span><span class="t" title="${esc(j.title || j.name)}">${esc(j.title || j.name)}</span><span class="s">${STATUS[j.status] || j.status}</span></li>`,
        )
        .join("")
    : `<li class="none">Aucune vidéo pour l'instant.</li>`;
  const mine = jobs.find((j) => j.id === currentJob);
  if (mine?.title) $("#jobTitle").textContent = mine.title;
  $$("#jobs li[data-id]").forEach((li) => {
    li.onclick = () => li.dataset.id !== currentJob && openJob(li.dataset.id);
    li.onkeydown = (e) => e.key === "Enter" && li.onclick();
  });
  return jobs;
}
setInterval(refreshJobs, 5000);
addEventListener("hashchange", () => {
  const id = location.hash.match(/job=([\w-]+)/)?.[1] || null;
  if (id !== currentJob) openJob(id);
});

/* ---------------------------------------------------------------- upload */
function upload(f) {
  if (!f) return;
  if (!/^video\//.test(f.type) && !/\.(mov|mp4|m4v|webm|mkv)$/i.test(f.name)) return toast("Ce fichier n'est pas une vidéo");
  if (es) es.close();
  currentJob = null;
  showView("work");
  resetStage();
  st.status = "uploading";
  $("#jobTitle").textContent = f.name;
  renderSub();
  const xhr = new XMLHttpRequest();
  xhr.open("POST", `/api/upload?project=${project.id}&name=${encodeURIComponent(f.name)}`);
  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    const p = Math.round((e.loaded / e.total) * 100);
    $("#wait").textContent = `Envoi de la vidéo : ${p} %`;
    $("#prog").style.width = p * 0.08 + "%";
  };
  xhr.onload = () => {
    let r = {};
    try {
      r = JSON.parse(xhr.responseText);
    } catch {}
    if (xhr.status !== 200) {
      toast(r.error || "L'envoi a échoué");
      return openJob(null);
    }
    openJob(r.id);
  };
  xhr.onerror = () => {
    toast("L'envoi a échoué : le studio ne répond pas");
    openJob(null);
  };
  xhr.send(f);
}
const file = $("#file");
for (const id of ["#newBtn", "#dropzone", "#another"]) $(id).onclick = () => file.click();
file.onchange = () => {
  upload(file.files[0]);
  file.value = "";
};
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  $("#dropcover").classList.add("show");
});
addEventListener("dragleave", (e) => {
  if (!hasFiles(e)) return;
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

/* ---------------------------------------------------------------- actions */
async function post(path, body) {
  const r = await fetch(`/api/jobs/${currentJob}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  if (r.ok) return true;
  const j = await r.json().catch(() => ({}));
  toast(r.status === 404 ? "Redémarre le studio dans ton terminal pour activer cette action" : j.error || "Ça n'a pas marché");
  return false;
}
$("#approve").onclick = async () => {
  const networks = $$("#nets input:checked").map((i) => i.dataset.net);
  if (!networks.length) return toast("Coche au moins un réseau");
  $("#approve").disabled = true;
  await post("approve", { networks, captions: collectCaptions() });
  $("#approve").disabled = false;
};
$("#fixBtn").onclick = () => {
  $("#fix").hidden = false;
  $("#acts").hidden = true;
  $("#fixText").focus();
};
$("#cancelFix").onclick = () => {
  $("#fix").hidden = true;
  $("#acts").hidden = false;
};
$("#sendFix").onclick = async () => {
  const text = $("#fixText").value.trim();
  if (!text) return $("#fixText").focus();
  if (await post("fix", { text })) {
    $("#fixText").value = "";
    showTab("activity");
  }
};
$("#fixText").onkeydown = (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("#sendFix").click();
};
$("#retry").onclick = async () => {
  const id = currentJob;
  if (await post("retry")) openJob(id);
};
$("#reveal").onclick = () => post("reveal");

/* ---------------------------------------------------------------- projects */
function setProject(p) {
  project = p;
  $("#projSw").textContent = p.initial || p.name[0];
  $("#projSw").style.background = p.color || "#7C6CF0";
  $("#projName").textContent = p.name;
}
$("#projBtn").onclick = (e) => {
  e.stopPropagation();
  const open = $("#menu").classList.toggle("open");
  $("#projBtn").setAttribute("aria-expanded", open);
};
document.addEventListener("click", () => {
  $("#menu").classList.remove("open");
  $("#projBtn").setAttribute("aria-expanded", false);
});

addEventListener("resize", () => {
  if (!lastTarget || $("#work").hidden) return;
  const [t, ax, ay, dx, dy] = lastTarget;
  const node = el(t);
  if (node && node.getClientRects().length) {
    const p = pt(node, ax, ay, dx, dy);
    place(p.x, p.y, 0);
  }
});

(async function init() {
  projects = await fetch("/api/projects").then((r) => r.json());
  setProject(projects[0]);
  $("#menu").innerHTML =
    projects.map((p) => `<button data-p="${p.id}"><span class="sw" style="background:${esc(p.color)}">${esc(p.initial || p.name[0])}</span>${esc(p.name)}</button>`).join("") +
    `<button class="add" id="addProj"><span class="sw" style="background:transparent;border:1px dashed var(--faint);color:var(--muted)">+</span>Nouveau projet</button>`;
  $$("#menu [data-p]").forEach(
    (b) =>
      (b.onclick = async () => {
        setProject(projects.find((p) => p.id === b.dataset.p));
        currentJob = null;
        const jobs = await refreshJobs();
        openJob(jobs[0]?.id || null);
      }),
  );
  $("#addProj").onclick = () => toast("Pour l'instant : copie le dossier projects/move et modifie project.json");
  await document.fonts.ready;
  const jobs = await refreshJobs();
  const fromHash = location.hash.match(/job=([\w-]+)/)?.[1];
  const active = jobs.find((j) => ["running", "queued", "review"].includes(j.status));
  openJob(jobs.some((j) => j.id === fromHash) ? fromHash : active?.id || null);
})();
