import { describe, expect, it } from "vitest";
import { decodeMesh } from "../src/binary";
import { buildPieces, extent, Projection, ringPieces } from "../src/geometry";
import { fixture } from "./helpers";

describe("buildPieces", () => {
  const mesh = decodeMesh(fixture("grid_mesh.bin"));
  const proj = Projection.forMesh(mesh);

  it("sem subdividir, um pedaço por trecho reto", () => {
    const p = buildPieces(mesh, proj, 1000);
    expect(p.count).toBe(40);
    expect([...p.frac.subarray(0, 2)]).toEqual([0, 1]);
  });

  it("subdivide trechos longos e as frações cobrem 0..1 em ordem", () => {
    const p = buildPieces(mesh, proj, 30); // ~110 m → 4 pedaços
    expect(p.count).toBe(160);
    const s0 = [...p.seg].map((s, i) => [s, i] as const).filter(([s]) => s === 0).map(([, i]) => i);
    expect(s0.length).toBe(4);
    expect(p.frac[2 * s0[0]]).toBe(0);
    expect(p.frac[2 * s0[3] + 1]).toBeCloseTo(1, 6);
    for (let k = 1; k < 4; k++) expect(p.frac[2 * s0[k]]).toBeCloseTo(p.frac[2 * s0[k - 1] + 1], 6);
    // pedaços contíguos: o fim de um é o começo do próximo
    expect(p.pos[4 * s0[1]]).toBeCloseTo(p.pos[4 * s0[0] + 2], 3);
  });

  it("projeta em metros (~100 m por passo de 0,001°)", () => {
    const p = buildPieces(mesh, proj, 1000);
    const [x0, y0, x1, y1] = extent(p);
    expect(y1 - y0).toBeGreaterThan(430);
    expect(y1 - y0).toBeLessThan(450);
    expect(x1 - x0).toBeGreaterThan(395);
    expect(proj.lon(proj.x(-46.63))).toBeCloseTo(-46.63, 9);
  });

  it("sem contorno, nenhum pedaço de borda", () => {
    expect(ringPieces(mesh, proj).length).toBe(0);
  });
});

describe("frações exatas nas pontas", () => {
  it("todo trecho começa em 0 e termina exatamente em 1", () => {
    const mesh = decodeMesh(fixture("grid_mesh.bin"));
    const p = buildPieces(mesh, Projection.forMesh(mesh), 7); // pedaços tortos de propósito
    for (let j = 0; j < p.count; j++) {
      const first = j === 0 || p.seg[j - 1] !== p.seg[j];
      const last = j === p.count - 1 || p.seg[j + 1] !== p.seg[j];
      if (first) expect(p.frac[2 * j]).toBe(0);
      if (last) expect(p.frac[2 * j + 1]).toBe(1);
    }
  });
});
