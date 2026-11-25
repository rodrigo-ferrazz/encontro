import { describe, expect, it } from "vitest";
import { decodeFlood, decodeMesh, type Flood, type Mesh } from "../src/binary";
import { computeFloodPieces, NEVER, NOBODY } from "../src/flood";
import { buildPieces, Projection, type Pieces } from "../src/geometry";
import { fixture } from "./helpers";

/** Um trecho reto u=0 → v=1 de 100 m, quebrado em 4 pedaços. */
function oneStreet(tuv: number, tvu: number): { mesh: Mesh; pieces: Pieces } {
  const mesh = {
    header: { nos: 2, trechos: 1, sem_sentido: 65535 },
    segU: Uint32Array.of(0),
    segV: Uint32Array.of(1),
    segTuv: Float32Array.of(tuv),
    segTvu: Float32Array.of(tvu),
    segLen: Float32Array.of(100),
  } as unknown as Mesh;
  const pieces: Pieces = {
    count: 4,
    pos: new Float32Array(16),
    seg: new Uint32Array(4),
    frac: Float32Array.of(0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1),
  };
  return { mesh, pieces };
}

function floodOf(arrival: number[][], unit: "s" | "m" = "s"): Flood {
  return {
    header: {
      versao: 1, pessoas: arrival.length, nos: arrival[0].length, unidade: unit,
      nao_alcancado: 65535, t_encontro: 0, t_fim: 0, no_encontro: null,
    },
    arrival: Uint16Array.from(arrival.flat()),
  };
}

describe("computeFloodPieces", () => {
  it("frentes de lados opostos se encontram no meio da rua, cada uma com sua cor", () => {
    const { mesh, pieces } = oneStreet(40, 40);
    // Ana chega em u no instante 0; Bia chega em v no instante 0
    const fp = computeFloodPieces(mesh, pieces, floodOf([[0, 65535], [65535, 0]]));
    expect([...fp.arr]).toEqual([0, 10, 10, 20, 20, 10, 10, 0]);
    expect([...fp.who]).toEqual([0, 0, 0, 0, 0, 1, 1, 1]); // no meio exato, empate: quem vem antes
  });

  it("quem chegou primeiro fica com a rua (sem misturar)", () => {
    const { mesh, pieces } = oneStreet(40, 40);
    // Ana chega em u aos 5 s, Bia aos 2 s: Bia domina a rua inteira
    const fp = computeFloodPieces(mesh, pieces, floodOf([[5, 45], [2, 42]]));
    expect([...fp.who].every((w) => w === 1)).toBe(true);
    expect(fp.arr[0]).toBe(2);
  });

  it("mão única: não avança na contramão", () => {
    const { mesh, pieces } = oneStreet(Infinity, 40); // só v→u
    // Ana chega só em u: não consegue entrar na rua
    let fp = computeFloodPieces(mesh, pieces, floodOf([[0, 65535]]));
    expect(fp.arr[0]).toBe(0);
    expect(fp.arr[1]).toBe(NEVER);
    expect(fp.who[1]).toBe(NOBODY);
    // a partir de v, sim
    fp = computeFloodPieces(mesh, pieces, floodOf([[65535, 0]]));
    expect(fp.arr[7]).toBe(0);
    expect(fp.arr[0]).toBe(40);
  });

  it("na métrica de distância usa o comprimento", () => {
    const { mesh, pieces } = oneStreet(40, Infinity);
    const fp = computeFloodPieces(mesh, pieces, floodOf([[0, 65535]], "m"));
    expect(fp.arr[7]).toBe(100);
  });

  it("recusa inundação de outra malha", () => {
    const { mesh, pieces } = oneStreet(1, 1);
    expect(() => computeFloodPieces(mesh, pieces, floodOf([[0, 0, 0]]))).toThrow(/nós/);
  });

  it("na grade real (fixture do Python) as frentes se dividem na diagonal", () => {
    const mesh = decodeMesh(fixture("grid_mesh.bin"));
    const flood = decodeFlood(fixture("grid_flood.bin"));
    const pieces = buildPieces(mesh, Projection.forMesh(mesh), 1000);
    const fp = computeFloodPieces(mesh, pieces, flood);
    const pieceOf = (u: number, v: number) => {
      for (let j = 0; j < pieces.count; j++) {
        const s = pieces.seg[j];
        if (mesh.segU[s] === u && mesh.segV[s] === v) return j;
      }
      throw new Error("trecho não encontrado");
    };
    const a = pieceOf(0, 1); // perto da Ana
    expect([fp.arr[2 * a], fp.arr[2 * a + 1]]).toEqual([0, 10]);
    expect(fp.who[2 * a]).toBe(0);
    const b = pieceOf(23, 24); // perto da Bia
    expect([fp.arr[2 * b], fp.arr[2 * b + 1]]).toEqual([10, 0]);
    expect(fp.who[2 * b + 1]).toBe(1);
  });
});
