// Projeção local em metros e quebra das ruas em "pedaços" (retas curtas) para a GPU.
import type { Mesh } from "./binary";

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON_EQ = 111_320;

/** Projeção equiretangular centrada no meio do bbox (a mesma usada no backend). */
export class Projection {
  readonly kx: number;
  readonly ky = M_PER_DEG_LAT;
  constructor(
    readonly lon0: number,
    readonly lat0: number,
    latRef: number,
  ) {
    this.kx = M_PER_DEG_LON_EQ * Math.cos((latRef * Math.PI) / 180);
  }
  static forMesh(mesh: Mesh): Projection {
    const [a, b, c, d] = mesh.header.bbox;
    return new Projection((a + c) / 2, (b + d) / 2, mesh.header.lat_ref);
  }
  x(lon: number): number {
    return (lon - this.lon0) * this.kx;
  }
  y(lat: number): number {
    return (lat - this.lat0) * this.ky;
  }
  lon(x: number): number {
    return x / this.kx + this.lon0;
  }
  lat(y: number): number {
    return y / this.ky + this.lat0;
  }
}

/**
 * Pedaços de reta. Cada pedaço i vai de (x0,y0) a (x1,y1), pertence ao trecho `seg[i]` e
 * cobre a fração [f0, f1] do comprimento do trecho (0 = nó u, 1 = nó v). A fração é o que a
 * inundação usa para interpolar o tempo de chegada ao longo da rua.
 */
export interface Pieces {
  count: number;
  pos: Float32Array; // [count * 4]: x0, y0, x1, y1 (metros)
  seg: Uint32Array; // [count]
  frac: Float32Array; // [count * 2]: f0, f1
}

/** Quebra as polilinhas em pedaços de no máximo `maxLen` metros. */
export function buildPieces(mesh: Mesh, proj: Projection, maxLen = 60): Pieces {
  const { coords, offsets } = mesh;
  const nSeg = offsets.length - 1;
  const px = new Float64Array(coords.length / 2);
  const py = new Float64Array(coords.length / 2);
  for (let i = 0; i < px.length; i++) {
    px[i] = proj.x(coords[2 * i]);
    py[i] = proj.y(coords[2 * i + 1]);
  }
  // 1ª passada: contar
  let count = 0;
  for (let s = 0; s < nSeg; s++) {
    for (let k = offsets[s]; k < offsets[s + 1] - 1; k++) {
      const len = Math.hypot(px[k + 1] - px[k], py[k + 1] - py[k]);
      count += Math.max(1, Math.ceil(len / maxLen));
    }
  }
  const pos = new Float32Array(count * 4);
  const seg = new Uint32Array(count);
  const frac = new Float32Array(count * 2);
  let j = 0;
  for (let s = 0; s < nSeg; s++) {
    const a = offsets[s];
    const b = offsets[s + 1];
    let total = 0;
    for (let k = a; k < b - 1; k++) total += Math.hypot(px[k + 1] - px[k], py[k + 1] - py[k]);
    const inv = total > 0 ? 1 / total : 0;
    let acc = 0;
    for (let k = a; k < b - 1; k++) {
      const dx = px[k + 1] - px[k];
      const dy = py[k + 1] - py[k];
      const len = Math.hypot(dx, dy);
      const n = Math.max(1, Math.ceil(len / maxLen));
      for (let q = 0; q < n; q++) {
        const t0 = q / n;
        const t1 = (q + 1) / n;
        pos[4 * j] = px[k] + dx * t0;
        pos[4 * j + 1] = py[k] + dy * t0;
        pos[4 * j + 2] = px[k] + dx * t1;
        pos[4 * j + 3] = py[k] + dy * t1;
        seg[j] = s;
        frac[2 * j] = total > 0 ? (acc + len * t0) * inv : 0;
        frac[2 * j + 1] = total > 0 ? (acc + len * t1) * inv : 1;
        j++;
      }
      acc += len;
    }
  }
  return { count, pos, seg, frac };
}

/** Anéis do contorno como pedaços de reta (sem subdividir). */
export function ringPieces(mesh: Mesh, proj: Projection): Float32Array {
  const { ringCoords: c, ringOffsets: o } = mesh;
  const out: number[] = [];
  for (let r = 0; r < o.length - 1; r++) {
    for (let k = o[r]; k < o[r + 1] - 1; k++) {
      out.push(proj.x(c[2 * k]), proj.y(c[2 * k + 1]), proj.x(c[2 * k + 2]), proj.y(c[2 * k + 3]));
    }
  }
  return Float32Array.from(out);
}

/** Retângulo (em metros) que contém a malha. */
export function extent(pieces: Pieces): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const p = pieces.pos;
  for (let i = 0; i < p.length; i += 2) {
    if (p[i] < x0) x0 = p[i];
    if (p[i] > x1) x1 = p[i];
    if (p[i + 1] < y0) y0 = p[i + 1];
    if (p[i + 1] > y1) y1 = p[i + 1];
  }
  return [x0, y0, x1, y1];
}
