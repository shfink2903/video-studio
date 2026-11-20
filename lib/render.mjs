import fs from "node:fs";
import path from "node:path";
import { BIN } from "./config.mjs";
import { run } from "./run.mjs";

export const FORMATS = {
  "9:16": { w: 1080, h: 1920, font: 76, bottom: 640 },
  "4:5": { w: 1080, h: 1350, font: 64, bottom: 300 },
  "16:9": { w: 1920, h: 1080, font: 64, bottom: 110 },
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function linkOrCopy(src, dst) {
  try {
    fs.linkSync(src, dst);
  } catch {
    fs.copyFileSync(src, dst);
  }
}

/**
 * Build a HyperFrames project for one format and render it to <job>/out/<format>.mp4.
 * groups: [{ start, end, words: [{ text, start, hl }] }] on the cut timeline.
 */
export async function renderFormat({ dir, format, duration, groups, zooms, music, project, style, onProgress }) {
  const f = FORMATS[format];
  if (!f) throw new Error(`Format inconnu : ${format}`);
  const slug = format.replace(":", "x");
  const hf = path.join(dir, `hf-${slug}`);
  fs.rmSync(hf, { recursive: true, force: true });
  fs.mkdirSync(path.join(hf, "assets"), { recursive: true });
  linkOrCopy(path.join(dir, "cut.mp4"), path.join(hf, "assets", "cut.mp4"));
  let musicTag = "";
  if (music) {
    const ext = path.extname(music);
    linkOrCopy(music, path.join(hf, "assets", "music" + ext));
    musicTag = `<audio id="music" class="clip" src="assets/music${ext}" data-start="0" data-duration="${duration}" data-track-index="2" data-volume="${project.music?.volume ?? 0.12}" data-fade-in="0.6" data-fade-out="1.5"></audio>`;
  }

  const cap = project.captions || {};
  const fontSize = Math.round(f.font * (style.captionScale || 1));
  const zoomScale = project.zoom?.scale ?? 1.12;
  const D = duration.toFixed(3);

  const groupsHtml = groups
    .map(
      (g, i) =>
        `<div id="g${i}" class="cg">${g.words
          .map((w, j) => `<span id="g${i}w${j}" class="w${w.hl ? " hl" : ""}">${esc(w.text)}</span>`)
          .join(" ")}</div>`,
    )
    .join("\n      ");

  const data = groups.map((g) => ({ s: +g.start.toFixed(3), e: +g.end.toFixed(3), w: g.words.map((w) => +w.start.toFixed(3)) }));

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>
  html, body { margin: 0; background: #000; }
  #root { position: relative; width: ${f.w}px; height: ${f.h}px; overflow: hidden; background: #000; }
  #cam { position: absolute; inset: 0; transform-origin: 50% 38%; }
  #v { position: absolute; left: 0; top: 0; width: ${f.w}px; height: ${f.h}px; object-fit: cover; }
  #caps { position: absolute; inset: 0; z-index: 5; }
  .cg { position: absolute; left: 0; right: 0; bottom: ${f.bottom}px; padding: 0 80px; text-align: center;
        font-family: ${cap.font || "Inter"}; font-weight: ${cap.weight || 900}; font-size: ${fontSize}px; line-height: 1.12;
        color: ${cap.color || "#FFFFFF"}; text-shadow: 0 4px 22px rgba(0,0,0,.6), 0 2px 4px rgba(0,0,0,.5);
        opacity: 0; visibility: hidden; overflow: visible; }
  .cg .w { display: inline-block; }
  .cg .hl { color: ${cap.highlight || "#9D8FF8"}; }
</style>
</head>
<body>
  <div id="root" data-composition-id="main" data-start="0" data-duration="${D}" data-width="${f.w}" data-height="${f.h}" data-fps="30">
    <div id="cam">
      <video id="v" class="clip" src="assets/cut.mp4" data-start="0" data-duration="${D}" data-track-index="0" data-has-audio="true" playsinline></video>
    </div>
    ${musicTag}
    <div id="caps" data-layout-allow-caption-zone>
      ${groupsHtml}
    </div>
  </div>
  <script>
    const G = ${JSON.stringify(data)};
    const Z = ${JSON.stringify(zooms.map((t) => +t.toFixed(3)))};
    const tl = gsap.timeline({ paused: true });
    G.forEach((g, i) => {
      const el = "#g" + i;
      tl.set(el, { opacity: 1, visibility: "visible" }, g.s);
      g.w.forEach((ws, j) => {
        tl.fromTo("#g" + i + "w" + j, { opacity: 0, scale: 0.7 }, { opacity: 1, scale: 1, duration: 0.14, ease: "back.out(2)" }, Math.max(g.s, ws - 0.02));
      });
      tl.to(el, { opacity: 0, duration: 0.1, ease: "power2.in" }, Math.max(g.s, g.e - 0.1));
      tl.set(el, { opacity: 0, visibility: "hidden" }, g.e);
    });
    Z.forEach((t) => {
      tl.fromTo("#cam", { scale: 1 }, { scale: ${zoomScale}, duration: 0.4, ease: "power2.out", immediateRender: false }, t);
      tl.to("#cam", { scale: 1, duration: 0.6, ease: "power2.inOut" }, t + 1.6);
    });
    tl.set({}, {}, ${D});
    window.__timelines["main"] = tl;
  </script>
</body>
</html>
`;
  fs.writeFileSync(path.join(hf, "index.html"), html);

  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  const out = path.join(dir, "out", `${slug}.mp4`);
  fs.rmSync(out, { force: true });
  const args = ["render", "--quality", "looks", "--skill=hyperframes", "-o", out, "."];
  const [cmd, argv] = BIN.hyperframes ? [BIN.hyperframes, args] : ["npx", ["hyperframes", ...args]];
  let last = -1;
  const parse = (s) => {
    const m = [...s.matchAll(/(\d{1,3})(?:\.\d+)?\s*%/g)].pop();
    if (m) {
      const p = Math.min(100, +m[1]);
      if (p !== last) {
        last = p;
        onProgress && onProgress(p);
      }
    }
  };
  await run(cmd, argv, { cwd: hf, onStdout: parse, onStderr: parse });
  if (!fs.existsSync(out) || fs.statSync(out).size < 10_000) throw new Error(`Le rendu ${format} n'a pas produit de fichier.`);
  return out;
}
