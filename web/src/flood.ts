// Tempo de chegada ao longo das ruas, por pedaço, a partir do tempo de chegada aos nós.
import type { Flood, Mesh } from "./binary";
import type { Pieces } from "./geometry";

export const NOBODY = 255;
export const NEVER = 1e9;

/**
 * Para cada pedaço, o instante em que a inundação chega a cada ponta (`arr`) e quem chega
 * primeiro (`who`). Num ponto à fração f do trecho u→v, a pessoa i chega em
 *
 *     min(a_u + f · c_uv, a_v + (1 − f) · c_vu)
 *
 * onde c é o custo de percorrer o trecho naquele sentido (∞ na contramão). A rua fica com a
 * cor de quem chegou primeiro, então duas frentes se encontram no meio da rua sem misturar.
 */
export interface FloodPieces {
  arr: Float32Array; // [count * 2]
  who: Uint8Array; // [count * 2]
}

export function segmentCosts(mesh: Mesh, unit: "s" | "m"): { uv: Float32Array; vu: Float32Array } {
  if (unit === "s") return { uv: mesh.segTuv, vu: mesh.segTvu };
  const n = mesh.segLen.length;
  const uv = new Float32Array(n);
  const vu = new Float32Array(n);
  for (let s = 0; s < n; s++) {
    uv[s] = Number.isFinite(mesh.segTuv[s]) ? mesh.segLen[s] : Infinity;
    vu[s] = Number.isFinite(mesh.segTvu[s]) ? mesh.segLen[s] : Infinity;
  }
  return { uv, vu };
}

export function computeFloodPieces(mesh: Mesh, pieces: Pieces, flood: Flood): FloodPieces {
  const { pessoas: n, nos: V, nao_alcancado: unreached, unidade } = flood.header;
  if (V !== mesh.header.nos) throw new Error(`inundação com ${V} nós, malha com ${mesh.header.nos}`);
  const { uv, vu } = segmentCosts(mesh, unidade);
  const A = flood.arrival;
  const at = (i: number, node: number) => {
    const x = A[i * V + node];
    return x === unreached ? Infinity : x;
  };

  const arr = new Float32Array(pieces.count * 2);
  const who = new Uint8Array(pieces.count * 2);
  // a_u e a_v de cada pessoa no trecho atual (pedaços do mesmo trecho são consecutivos)
  const au = new Float64Array(n);
  const av = new Float64Array(n);
  let cur = -1;
  for (let j = 0; j < pieces.count; j++) {
    const s = pieces.seg[j];
    if (s !== cur) {
      cur = s;
      const u = mesh.segU[s];
      const v = mesh.segV[s];
      for (let i = 0; i < n; i++) {
        au[i] = at(i, u);
        av[i] = at(i, v);
      }
    }
    for (let e = 0; e < 2; e++) {
      const f = pieces.frac[2 * j + e];
      let best = Infinity;
      let bi = NOBODY;
      for (let i = 0; i < n; i++) {
        // f = 0 ou 1 é a própria ponta: evita 0 · ∞ = NaN na contramão
        const fromU = f === 0 ? au[i] : au[i] + f * uv[s];
        const fromV = f === 1 ? av[i] : av[i] + (1 - f) * vu[s];
        const t = Math.min(fromU, fromV);
        if (t < best) {
          best = t;
          bi = i;
        }
      }
      arr[2 * j + e] = Number.isFinite(best) ? best : NEVER;
      who[2 * j + e] = Number.isFinite(best) ? bi : NOBODY;
    }
  }
  return { arr, who };
}

/** Paleta das pessoas: cores saturadas que brilham sobre o fundo escuro. */
export const PERSON_COLORS = [
  "#38d0ff", "#ff4fa3", "#ffb020", "#7cff5a", "#a78bff", "#ff7a3d",
  "#2de2b0", "#ff5a5a", "#f5f56a", "#5a8cff", "#ff9de0", "#b5ff9a",
];

export function personColor(i: number): string {
  return PERSON_COLORS[i % PERSON_COLORS.length];
}
