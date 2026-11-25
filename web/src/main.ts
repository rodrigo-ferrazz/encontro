import { decodeMesh } from "./binary";
import { buildPieces, extent, Projection, ringPieces } from "./geometry";
import { hex, LineBatch, Renderer } from "./renderer";
import { attachControls, Camera } from "./view";

export const API = import.meta.env.DEV ? "/api" : (import.meta.env.VITE_API ?? "");

const BG = hex("#050404");
const ROAD = hex("#5a3522", 0.75);
const BORDER = hex("#8a7a6c", 0.8);

const canvas = document.getElementById("map") as HTMLCanvasElement;
const status = document.getElementById("status")!;
const fpsEl = document.getElementById("fps")!;
const debug = new URLSearchParams(location.search).has("debug");

/** Largura das ruas (px CSS) conforme o zoom: finas na cidade inteira, mais grossas de perto. */
export function roadWidth(scalePxPerM: number): number {
  return Math.min(2.5, Math.max(0.5, scalePxPerM * 8));
}

async function start() {
  const t0 = performance.now();
  const res = await fetch(`${API}/malha`);
  if (!res.ok) throw new Error(`GET /malha: ${res.status}`);
  const mesh = decodeMesh(await res.arrayBuffer());
  const proj = Projection.forMesh(mesh);
  const pieces = buildPieces(mesh, proj);

  const renderer = new Renderer(canvas);
  const roads = new LineBatch(renderer.gl, pieces.pos);
  const border = new LineBatch(renderer.gl, ringPieces(mesh, proj));
  const cam = new Camera();

  let dirty = true;
  let userMoved = false; // até o usuário mexer, o mapa acompanha o tamanho da tela
  const home = extent(pieces);
  const draw = () => {
    renderer.clear(BG);
    const f = renderer.frame(cam);
    renderer.lines(roads, f, ROAD, roadWidth(cam.scale));
    renderer.lines(border, f, BORDER, 1.2);
  };

  const resize = () => {
    const r = canvas.getBoundingClientRect();
    renderer.resize(r.width, r.height);
    cam.resize(r.width, r.height);
    if (!userMoved) cam.fit(home, 16);
    dirty = true;
  };
  resize();
  new ResizeObserver(resize).observe(canvas);
  attachControls(canvas, cam, () => {
    userMoved = true;
    dirty = true;
  });

  let frames = 0;
  let last = performance.now();
  const loop = (now: number) => {
    if (dirty || debug) {
      draw();
      dirty = false;
      frames++;
    }
    if (debug && now - last > 500) {
      fpsEl.hidden = false;
      fpsEl.textContent = `${Math.round((frames * 1000) / (now - last))} fps · ${pieces.count.toLocaleString("pt-BR")} pedaços`;
      frames = 0;
      last = now;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  status.textContent = `${mesh.header.trechos.toLocaleString("pt-BR")} trechos de rua · ${Math.round(performance.now() - t0)} ms`;
}

start().catch((e) => {
  console.error(e);
  status.textContent = `Erro: ${e.message}`;
});
