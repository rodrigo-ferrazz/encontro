// Leitura dos formatos binários da API (ver src/encontro_sp/mesh.py e flood.py).

export interface MeshHeader {
  versao: number;
  nos: number;
  trechos: number;
  aneis: number;
  bbox: [number, number, number, number]; // lon_min, lat_min, lon_max, lat_max
  lat_ref: number;
  sem_sentido: number;
  atribuicao: string;
}

export interface Mesh {
  header: MeshHeader;
  /** lon/lat já dequantizados, intercalados [lon0, lat0, lon1, lat1, ...] */
  coords: Float64Array;
  offsets: Uint32Array; // [S+1]
  segU: Uint32Array;
  segV: Uint32Array;
  /** tempo u→v e v→u em segundos (Infinity = contramão) */
  segTuv: Float32Array;
  segTvu: Float32Array;
  segLen: Float32Array; // metros
  ringCoords: Float64Array;
  ringOffsets: Uint32Array;
}

function readHeader(buf: ArrayBuffer, magic: string): { header: any; base: number } {
  const bytes = new Uint8Array(buf);
  const got = String.fromCharCode(...bytes.subarray(0, 4));
  if (got !== magic) throw new Error(`formato inválido: esperado ${magic}, veio ${got}`);
  const hlen = new DataView(buf).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + hlen)));
  return { header, base: 8 + hlen };
}

type ArrayInfo = { nome: string; dtype: string; shape: number[]; offset: number };

const CTORS: Record<string, any> = { "<u2": Uint16Array, "<u4": Uint32Array, "<f4": Float32Array, "|u1": Uint8Array };

function dequantize(q: Uint16Array, bbox: MeshHeader["bbox"]): Float64Array {
  const [lon0, lat0, lon1, lat1] = bbox;
  const out = new Float64Array(q.length);
  const sx = (lon1 - lon0) / 65535;
  const sy = (lat1 - lat0) / 65535;
  for (let i = 0; i < q.length; i += 2) {
    out[i] = lon0 + q[i] * sx;
    out[i + 1] = lat0 + q[i + 1] * sy;
  }
  return out;
}

export function decodeMesh(buf: ArrayBuffer): Mesh {
  const { header, base } = readHeader(buf, "ENCM");
  const arrays: Record<string, any> = {};
  for (const a of header.arrays as ArrayInfo[]) {
    const Ctor = CTORS[a.dtype];
    if (!Ctor) throw new Error(`dtype não suportado: ${a.dtype}`);
    const count = a.shape.reduce((x, y) => x * y, 1);
    arrays[a.nome] = new Ctor(buf, base + a.offset, count);
  }
  const noWay = header.sem_sentido as number;
  const toSeconds = (d: Uint16Array) => {
    const out = new Float32Array(d.length);
    for (let i = 0; i < d.length; i++) out[i] = d[i] === noWay ? Infinity : d[i] / 10;
    return out;
  };
  return {
    header,
    coords: dequantize(arrays.coords, header.bbox),
    offsets: arrays.offsets,
    segU: arrays.seg_u,
    segV: arrays.seg_v,
    segTuv: toSeconds(arrays.seg_t_uv),
    segTvu: toSeconds(arrays.seg_t_vu),
    segLen: Float32Array.from(arrays.seg_len as Uint16Array),
    ringCoords: dequantize(arrays.ring_coords, header.bbox),
    ringOffsets: arrays.ring_offsets,
  };
}

export interface Flood {
  header: {
    versao: number;
    pessoas: number;
    nos: number;
    unidade: "s" | "m";
    nao_alcancado: number;
    t_encontro: number;
    t_fim: number;
    no_encontro: number | null;
    resultado?: any;
    /** rotas[r][i]: nós do caminho da pessoa i até o resultado r */
    rotas?: (number[] | null)[][];
  };
  /** arrival[p * nos + v], em segundos ou metros; nao_alcancado = não chega */
  arrival: Uint16Array;
}

export function decodeFlood(buf: ArrayBuffer): Flood {
  const { header, base } = readHeader(buf, "ENCF");
  const arrival = new Uint16Array(buf, base, header.pessoas * header.nos);
  return { header, arrival };
}
