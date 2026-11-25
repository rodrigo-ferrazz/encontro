import { decodeFlood, decodeMesh, type Flood, type Mesh } from "./binary";
import { computeFloodPieces, personColor } from "./flood";
import { buildPieces, extent, Projection, ringPieces, type Pieces } from "./geometry";
import { MarkerLayer, type Marker } from "./markers";
import { floodLegend } from "./legend";
import { SearchForm, type GeocodeResult } from "./form";
import { ResultsPanel } from "./panel";
import { parseQuery, requestBody, toQuery, type SearchState } from "./state";
import { resultCards, routePieces, segmentIndex, shortPlace, type ApiSearch } from "./results";
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

// Exemplo (o mesmo exemplo.yaml da CLI) para quem abre a página sem link.
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

async function geocode(q: string): Promise<GeocodeResult> {
  const res = await fetch(`${API}/geocode?q=${encodeURIComponent(q)}`);
  if (res.status === 404) throw new Error("endereço não encontrado");
  if (!res.ok) throw new Error(`erro ${res.status} ao localizar`);
  return res.json();
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
  pins: Marker[] = [];
  routes: { batch: LineBatch; color: ReturnType<typeof hex> }[] = [];
  routeNodes: (number[] | null)[][] = [];
  segIdx: Map<number, number> | null = null;
  lastSearch: ApiSearch | null = null;
  panel = new ResultsPanel($("results-body"));
  people: Marker[] = [];
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

    for (const m of this.pins) this.markers.remove(m);
    const res = h.resultado as ApiSearch;
    this.lastSearch = res;
    // demais do top-K: pinos menores e numerados (desenhados antes, ficam por baixo do 1º)
    const cards = resultCards(res);
    this.pins = [];
    for (let i = cards.length - 1; i >= 0; i--) {
      const c = cards[i];
      const m = this.markers.add(c.lat, c.lon, {
        className: i === 0 ? "meet" : "pin",
        text: String(c.rank),
        title: `#${c.rank} ${c.title}`,
        onClick: () => this.select(i),
      });
      this.pins[i] = m;
    }
    this.meet = cards.length ? { el: this.pins[0].el, tStar: h.t_encontro } : null;
    this.routeNodes = h.rotas ?? [];
    const lg = floodLegend(h, res.pessoas.map((p) => p.nome));
    const legendEl = $("legend");
    legendEl.hidden = false;
    legendEl.classList.toggle("live", lg.live);
    legendEl.querySelector(".legend-text")!.textContent = lg.text;
    legendEl.querySelector(".info")!.textContent = lg.detail;
    this.panel.render(cards, res.avisos, (i) => this.select(i));
    this.select(null);

    // 1 min simulado ≈ 0,5 s real; em distância, ~1 km por segundo real
    const tl = new Timeline(h.t_fim, h.unidade === "s" ? 120 : 1000);
    tl.onChange(() => this.syncControls());
    this.timeline = tl;
    this.bindControls(tl);
    const t0 = params.get("t"); // ?t=600: abre parado nesse instante (depuração, capturas)
    if (t0 !== null) tl.seek(t0 === "fim" ? tl.end : Number(t0));
    else tl.play();
  }

  /** Destaca o resultado i e desenha a rota de cada pessoa até ele (null = nenhum). */
  select(i: number | null): void {
    const gl = this.renderer.gl;
    for (const r of this.routes) r.batch.dispose(gl);
    this.routes = [];
    this.pins.forEach((p, k) => p.el.classList.toggle("sel", k === i));
    this.panel.select(i);
    if (i !== null && this.routeNodes[i]) {
      this.segIdx ??= segmentIndex(this.mesh);
      this.routeNodes[i].forEach((nodes, person) => {
        if (!nodes || nodes.length < 2) return;
        const pieces = routePieces(this.mesh, this.segIdx!, this.proj, nodes);
        this.routes.push({ batch: new LineBatch(gl, pieces), color: hex(personColor(person)) });
      });
      this.focus(i);
    }
    this.dirty = true;
  }

  /** Enquadra as pessoas e o resultado i, deixando livre o espaço do painel. */
  focus(i: number): void {
    const res = this.timeline && this.pins[i] ? this.lastSearch : null;
    if (!res) return;
    const pts = [...res.pessoas, res.resultados[i]].map((p) => [this.proj.x(p.lon), this.proj.y(p.lat)]);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const box: [number, number, number, number] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const panel = $("results").getBoundingClientRect();
    const view = canvas.getBoundingClientRect();
    const wide = panel.left > view.width / 2; // painel à direita (desktop) ou embaixo (celular)
    this.cam.fit(box, {
      top: 90,
      left: 40,
      right: wide ? view.right - panel.left + 40 : 40,
      bottom: wide ? 110 : view.bottom - panel.top + 40,
    }, false);
    this.userMoved = true;
  }

  /** Marcadores arrastáveis das pessoas com posição conhecida. */
  renderPeople(state: SearchState, onDrag: (i: number, lat: number, lon: number) => void): void {
    for (const m of this.people) this.markers.remove(m);
    this.people = [];
    let color = 0; // mesma ordem das pessoas mandadas à API (linhas vazias não contam)
    state.pessoas.forEach((p, i) => {
      if (!p.nome.trim() && !p.endereco.trim()) return;
      const c = color++;
      if (p.lat === undefined || p.lon === undefined) return;
      const label = p.endereco.trim() ? `${p.nome || "?"} · ${shortPlace(p.endereco)}` : p.nome;
      this.people.push(
        this.markers.add(p.lat, p.lon, { label, color: personColor(c), onDrag: (lat, lon) => onDrag(i, lat, lon) }),
      );
    });
    this.dirty = true;
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
    for (const rt of this.routes) {
      r.lines(rt.batch, f, hex("#050404", 0.9), 6); // contorno escuro para destacar do fundo
      r.lines(rt.batch, f, rt.color, 3);
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

function setTab(which: "busca" | "res"): void {
  const busca = which === "busca";
  $("tab-busca").setAttribute("aria-selected", String(busca));
  $("tab-res").setAttribute("aria-selected", String(!busca));
  $("busca").hidden = !busca;
  $("results-body").hidden = busca;
  $("results").classList.remove("collapsed");
}

async function start() {
  const initial = parseQuery(params);
  const fromLink = initial.pessoas.length >= 2;
  if (!fromLink) initial.pessoas = DEMO.map((p) => ({ ...p }));

  const mesh = await fetchMesh();
  const proj = Projection.forMesh(mesh);
  const app = new App(mesh, proj, buildPieces(mesh, proj));
  app.run();

  const side = $("results");
  const toggle = $<HTMLButtonElement>("results-toggle");
  toggle.onclick = () => {
    const c = side.classList.toggle("collapsed");
    toggle.setAttribute("aria-expanded", String(!c));
    toggle.setAttribute("aria-label", c ? "Abrir painel" : "Recolher painel");
  };
  $("tab-busca").onclick = () => setTab("busca");
  $("tab-res").onclick = () => setTab("res");

  let searched = false;
  const syncPeople = () =>
    app.renderPeople(form.state, (i, lat, lon) => form.moved(i, lat, lon));

  const run = async () => {
    form.setBusy(true);
    status.textContent = "Calculando o ponto de encontro…";
    try {
      const flood = await fetchFlood(requestBody(form.state));
      const res = flood.header.resultado as ApiSearch;
      // posições geocodificadas pelo servidor viram as posições confirmadas
      const filled = form.state.pessoas.filter((p) => p.nome.trim() || p.endereco.trim());
      filled.forEach((p, k) => {
        if (p.lat === undefined && res.pessoas[k]) Object.assign(p, { lat: res.pessoas[k].lat, lon: res.pessoas[k].lon });
      });
      form.render();
      syncPeople();
      app.showFlood(flood);
      searched = true;
      const q = toQuery(form.state);
      if (debug) q.set("debug", "");
      history.replaceState(null, "", `${location.pathname}?${q}`);
      $<HTMLButtonElement>("tab-res").disabled = false;
      setTab("res");
      const best = res.resultados[0];
      status.textContent = best ? `Ponto de encontro: ${best.anfitriao ? `casa de ${best.anfitriao}` : (best.via ?? "sem nome")}` : "Nenhum ponto encontrado";
      return flood;
    } catch (e) {
      status.textContent = `Erro: ${(e as Error).message}`;
      setTab("busca");
      return null;
    } finally {
      form.setBusy(false);
    }
  };

  const form: SearchForm = new SearchForm($<HTMLFormElement>("busca"), initial, {
    geocode,
    change: () => {
      syncPeople();
      if (searched) status.textContent = "A busca mudou — clique em Buscar para recalcular.";
    },
    submit: () => void run(),
  });
  syncPeople();

  if (fromLink) {
    const flood = await run();
    const r = Number(params.get("r")); // ?r=2: já abre com as rotas do 2º resultado
    if (flood && r >= 1) app.select(r - 1);
  } else {
    status.textContent = "Monte a busca e clique em Buscar";
  }
}

start().catch((e) => {
  console.error(e);
  status.textContent = `Erro: ${e.message}`;
});
