import { decodeFlood, decodeMesh, type Flood, type Mesh } from "./binary";
import { computeFloodPieces, personColor } from "./flood";
import { buildPieces, extent, Projection, ringPieces, type Pieces } from "./geometry";
import { MarkerLayer } from "./markers";
import { FloodBatch, hex, LineBatch, Renderer } from "./renderer";
import { fmtSim, Timeline } from "./timeline";
import { attachControls, Camera } from "./view";

export const API = import.meta.env.DEV ? "/api" : (import.meta.env.VITE_API ?? "");

const BG = hex("#050404");
const ROAD = hex("#5a3522", 0.75);
const BORDER = hex("#8a7a6c", 0.8);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("map");
const status = $("status");
const fpsEl = $("fps");
const params = new URLSearchParams(location.search);
const debug = params.has("debug");

// Pessoas de exemplo (o mesmo exemplo.yaml da CLI) até o formulário do FE-07.
const DEMO = [
  { nome: "Ana", endereco: "Avenida Paulista, 1578" },
  { nome: "Bruno", endereco: "Rua Augusta, 2690" },
  { nome: "Carla", endereco: "Praça Silvio Romero, Tatuapé" },
  { nome: "Diego", endereco: "Avenida Engenheiro Luís Carlos Berrini, 1000" },
];

/** Largura das ruas (px CSS) conforme o zoom: finas na cidade inteira, mais grossas de perto. */
export function roadWidth(scalePxPerM: number): number {
  return Math.min(2.5, Math.max(0.5, scalePxPerM * 8));
}

async function fetchMesh(): Promise<Mesh> {
  const res = await fetch(`${API}/malha`);
  if (!res.ok) throw new Error(`GET /malha: ${res.status}`);
  return decodeMesh(await res.arrayBuffer());
}

async function fetchFlood(body: unknown): Promise<Flood> {
  const res = await fetch(`${API}/buscar?flood=1`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(typeof detail.detail === "string" ? detail.detail : `POST /buscar: ${res.status}`);
  }
  return decodeFlood(await res.arrayBuffer());
}

class App {
  renderer = new Renderer(canvas);
  cam = new Camera();
  roads: LineBatch;
  border: LineBatch;
  markers: MarkerLayer;
  flood: FloodBatch | null = null;
  timeline: Timeline | null = null;
  unit: "s" | "m" = "s";
  meet: { el: HTMLElement; tStar: number } | null = null;
  colors = [] as ReturnType<typeof hex>[];
  dirty = true;
  userMoved = false;
  home: [number, number, number, number];

  constructor(
    readonly mesh: Mesh,
    readonly proj: Projection,
    readonly pieces: Pieces,
  ) {
    this.roads = new LineBatch(this.renderer.gl, pieces.pos);
    this.border = new LineBatch(this.renderer.gl, ringPieces(mesh, proj));
    this.markers = new MarkerLayer($("markers"), proj);
    this.home = extent(pieces);
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
    attachControls(canvas, this.cam, () => {
      this.userMoved = true;
      this.dirty = true;
    });
  }

  resize(): void {
    const r = canvas.getBoundingClientRect();
    this.renderer.resize(r.width, r.height);
    this.cam.resize(r.width, r.height);
    if (!this.userMoved) this.cam.fit(this.home, 16);
    this.dirty = true;
  }

  showFlood(flood: Flood): void {
    const h = flood.header;
    const fp = computeFloodPieces(this.mesh, this.pieces, flood);
    this.flood?.dispose();
    this.flood = new FloodBatch(this.renderer.gl, this.roads, fp.arr, fp.who);
    this.unit = h.unidade;
    this.colors = Array.from({ length: h.pessoas }, (_, i) => hex(personColor(i)));

    this.markers.clear();
    const res = h.resultado;
    res.pessoas.forEach((p: any, i: number) =>
      this.markers.add(p.lat, p.lon, { label: p.nome, color: personColor(i) }),
    );
    const best = res.resultados[0];
    this.meet = best
      ? { el: this.markers.add(best.lat, best.lon, { className: "meet" }).el, tStar: h.t_encontro }
      : null;

    // 1 min simulado ≈ 0,5 s real; em distância, ~1 km por segundo real
    const tl = new Timeline(h.t_fim, h.unidade === "s" ? 120 : 1000);
    tl.onChange(() => this.syncControls());
    this.timeline = tl;
    this.bindControls(tl);
    const t0 = params.get("t"); // ?t=600: abre parado nesse instante (depuração, capturas)
    if (t0 !== null) tl.seek(t0 === "fim" ? tl.end : Number(t0));
    else tl.play();
  }

  bindControls(tl: Timeline): void {
    $("controls").hidden = false;
    const play = $<HTMLButtonElement>("play");
    const scrub = $<HTMLInputElement>("scrub");
    play.onclick = () => tl.toggle();
    $<HTMLButtonElement>("restart").onclick = () => tl.restart();
    $<HTMLSelectElement>("speed").onchange = (e) => tl.setSpeed(Number((e.target as HTMLSelectElement).value));
    let wasPlaying = false;
    scrub.onpointerdown = () => {
      wasPlaying = tl.playing;
      tl.pause();
    };
    scrub.oninput = () => tl.seek((Number(scrub.value) / 1000) * tl.end);
    scrub.onchange = () => {
      if (wasPlaying && !tl.done) tl.play();
    };
    window.onkeydown = (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.code === "Space") {
        e.preventDefault();
        tl.toggle();
      }
    };
  }

  syncControls(): void {
    const tl = this.timeline!;
    const play = $<HTMLButtonElement>("play");
    play.textContent = tl.playing ? "❚❚" : "▶";
    play.setAttribute("aria-label", tl.playing ? "Pausar" : "Reproduzir");
    $<HTMLInputElement>("scrub").value = String(Math.round((tl.t / tl.end) * 1000));
    $("clock").textContent = fmtSim(tl.t, this.unit);
    this.meet?.el.classList.toggle("on", tl.t >= this.meet.tStar);
    this.dirty = true;
  }

  draw(): void {
    const r = this.renderer;
    r.clear(BG);
    const f = r.frame(this.cam);
    const w = roadWidth(this.cam.scale);
    r.lines(this.roads, f, ROAD, w);
    r.lines(this.border, f, BORDER, 1.2);
    if (this.flood && this.timeline) {
      r.flood(this.flood, f, { t: this.timeline.t, hot: this.unit === "s" ? 60 : 500, colors: this.colors }, w);
    }
    this.markers.update(this.cam);
  }

  run(): void {
    let frames = 0;
    let lastFps = performance.now();
    let last = performance.now();
    const loop = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      if (this.timeline?.step(dt)) this.syncControls();
      if (this.dirty || debug) {
        this.draw();
        this.dirty = false;
        frames++;
      }
      if (debug && now - lastFps > 500) {
        fpsEl.hidden = false;
        fpsEl.textContent = `${Math.round((frames * 1000) / (now - lastFps))} fps · ${this.pieces.count.toLocaleString("pt-BR")} pedaços`;
        frames = 0;
        lastFps = now;
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}

function peopleFromUrl(): { nome: string; endereco: string }[] {
  const ps = params.getAll("p").map((s) => {
    const [nome, ...rest] = s.split("|");
    return { nome: nome.trim(), endereco: rest.join("|").trim() };
  });
  return ps.filter((p) => p.nome && p.endereco).length >= 2 ? ps : DEMO;
}

async function start() {
  const mesh = await fetchMesh();
  const proj = Projection.forMesh(mesh);
  const app = new App(mesh, proj, buildPieces(mesh, proj));
  app.run();
  status.textContent = "Calculando o ponto de encontro…";
  const flood = await fetchFlood({
    pessoas: peopleFromUrl(),
    criterio: params.get("criterio") ?? "justo",
    ao_vivo: params.get("ao_vivo") === "1",
  });
  app.showFlood(flood);
  const best = flood.header.resultado.resultados[0];
  status.textContent = best ? `Ponto de encontro: ${best.via ?? "sem nome"}` : "Nenhum ponto encontrado";
}

start().catch((e) => {
  console.error(e);
  status.textContent = `Erro: ${e.message}`;
});
