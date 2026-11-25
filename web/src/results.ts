// Ranking e rotas: transforma o JSON da API (output.to_dict) no que a tela mostra.
import type { Mesh } from "./binary";
import type { Projection } from "./geometry";

export interface ApiTrip {
  nome: string;
  tempo_s: number | null;
  distancia_m: number | null;
  fonte: "ao_vivo" | "estimativa_local";
  rota: string;
}
export interface ApiResult {
  rank: number;
  lat: number;
  lon: number;
  anfitriao: string | null;
  via: string | null;
  pontuacao: number | null;
  mapa: string;
  deslocamentos: ApiTrip[];
}
export interface ApiPerson {
  nome: string;
  endereco: string;
  rotulo?: string;
  lat: number;
  lon: number;
  geocoder: string;
}
export interface ApiSearch {
  criterio: string;
  objetivo: string;
  metrica: string;
  transito_ao_vivo: boolean;
  pessoas: ApiPerson[];
  resultados: ApiResult[];
  avisos: string[];
}

/** Mesmo formato do Python (output.fmt_time). */
export function fmtTime(s: number | null): string {
  if (s === null || !Number.isFinite(s)) return "—";
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
}

/** Mesmo formato do Python (output.fmt_dist). */
export function fmtDist(m: number | null): string {
  if (m === null || !Number.isFinite(m)) return "—";
  return `${(m / 1000).toFixed(1).replace(".", ",")} km`;
}

const COORD = /^\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*$/;

/** "Bairro/referência" curto para o rótulo do marcador: o que a pessoa digitou, resumido. */
export function shortPlace(endereco: string, max = 28): string {
  const e = endereco.trim();
  if (COORD.test(e)) {
    const [a, b] = e.split(",").map((x) => Number(x).toFixed(3));
    return `${a}, ${b}`;
  }
  if (e.length <= max) return e;
  const parts = e.split(",").map((x) => x.trim()).filter(Boolean);
  // "Praça Silvio Romero, Tatuapé, São Paulo" → o bairro costuma vir depois da 1ª vírgula
  const last = parts.slice(1).find((p) => !/^\d+/.test(p) && !/s[ãa]o paulo/i.test(p));
  const pick = last && last.length <= max ? last : parts[0];
  return pick.length <= max ? pick : pick.slice(0, max - 1).trimEnd() + "…";
}

export interface TripRow {
  person: number;
  name: string;
  time: string;
  dist: string;
  live: boolean;
  route: string;
}
export interface ResultCard {
  rank: number;
  title: string;
  score: string;
  map: string;
  lat: number;
  lon: number;
  trips: TripRow[];
}

export function scoreText(search: ApiSearch, value: number | null): string {
  const time = search.metrica === "tempo" || search.metrica === "time";
  if (search.criterio === "igualitario") return value === null ? "—" : `faixa ${value} (×${time ? "2 min" : "1 km"})`;
  return time ? fmtTime(value) : fmtDist(value);
}

/** Um cartão por resultado, na ordem da API. */
export function resultCards(search: ApiSearch): ResultCard[] {
  return search.resultados.map((r) => ({
    rank: r.rank,
    title: r.anfitriao ? `Casa de ${r.anfitriao}` : (r.via ?? "Ponto sem nome"),
    score: scoreText(search, r.pontuacao),
    map: r.mapa,
    lat: r.lat,
    lon: r.lon,
    trips: r.deslocamentos.map((d, i) => ({
      person: i,
      name: d.nome,
      time: fmtTime(d.tempo_s),
      dist: fmtDist(d.distancia_m),
      live: d.fonte === "ao_vivo",
      route: d.rota,
    })),
  }));
}

/** Índice (u, v) → trecho, nos dois sentidos, para achar a geometria de cada passo da rota. */
export function segmentIndex(mesh: Mesh): Map<number, number> {
  const V = mesh.header.nos;
  const idx = new Map<number, number>();
  for (let s = 0; s < mesh.segU.length; s++) {
    const u = mesh.segU[s];
    const v = mesh.segV[s];
    if (!idx.has(u * V + v)) idx.set(u * V + v, s);
    if (!idx.has(v * V + u)) idx.set(v * V + u, s);
  }
  return idx;
}

/**
 * A rota (lista de nós) como pedaços de reta [x0, y0, x1, y1, ...] em metros, seguindo a
 * geometria real das ruas (no sentido da viagem).
 */
export function routePieces(mesh: Mesh, idx: Map<number, number>, proj: Projection, nodes: number[]): Float32Array {
  const V = mesh.header.nos;
  const out: number[] = [];
  for (let k = 0; k + 1 < nodes.length; k++) {
    const a = nodes[k];
    const b = nodes[k + 1];
    const s = idx.get(a * V + b);
    if (s === undefined) continue; // não deveria acontecer: todo passo é uma rua da malha
    const from = mesh.offsets[s];
    const to = mesh.offsets[s + 1];
    const pts: number[] = [];
    for (let i = from; i < to; i++) pts.push(proj.x(mesh.coords[2 * i]), proj.y(mesh.coords[2 * i + 1]));
    const forward = mesh.segU[s] === a;
    const n = pts.length / 2;
    for (let i = 0; i + 1 < n; i++) {
      const p = forward ? i : n - 1 - i;
      const q = forward ? i + 1 : n - 2 - i;
      out.push(pts[2 * p], pts[2 * p + 1], pts[2 * q], pts[2 * q + 1]);
    }
  }
  return Float32Array.from(out);
}
