import { describe, expect, it } from "vitest";
import { decodeFlood, decodeMesh } from "../src/binary";
import { fixture } from "./helpers";

describe("decodeMesh", () => {
  const mesh = decodeMesh(fixture("grid_mesh.bin"));

  it("lê o cabeçalho e as contagens", () => {
    expect(mesh.header.nos).toBe(25);
    expect(mesh.header.trechos).toBe(40); // grade 5×5: 2·5·4 ruas
    expect(mesh.offsets.length).toBe(41);
    expect(mesh.segU.length).toBe(40);
    expect(mesh.header.atribuicao).toMatch(/OpenStreetMap/);
  });

  it("dequantiza as coordenadas dentro do bbox (lat −23.55, lon −46.63)", () => {
    const [lon0, lat0, lon1, lat1] = mesh.header.bbox;
    for (let i = 0; i < mesh.coords.length; i += 2) {
      expect(mesh.coords[i]).toBeGreaterThanOrEqual(lon0 - 1e-9);
      expect(mesh.coords[i]).toBeLessThanOrEqual(lon1 + 1e-9);
      expect(mesh.coords[i + 1]).toBeGreaterThanOrEqual(lat0 - 1e-9);
      expect(mesh.coords[i + 1]).toBeLessThanOrEqual(lat1 + 1e-9);
    }
    expect(mesh.coords[1]).toBeCloseTo(-23.55, 4);
  });

  it("converte tempos de décimos de segundo e marca contramão", () => {
    expect([...mesh.segTuv].every((t) => t === 10)).toBe(true);
    expect([...mesh.segTvu].every((t) => t === 10)).toBe(true);
    expect(mesh.segLen[0]).toBeGreaterThan(95);
  });

  it("recusa outro formato", () => {
    expect(() => decodeMesh(fixture("grid_flood.bin"))).toThrow(/ENCM/);
  });
});

describe("decodeFlood", () => {
  const f = decodeFlood(fixture("grid_flood.bin"));
  it("lê o cabeçalho, o ranking e os tempos", () => {
    expect(f.header.pessoas).toBe(2);
    expect(f.header.nos).toBe(25);
    expect(f.header.unidade).toBe("s");
    expect(f.header.t_encontro).toBe(40); // 8 arestas de 10 s, metade para cada
    expect(f.header.resultado.resultados[0].rank).toBe(1);
    expect(f.arrival.length).toBe(50);
    expect(f.arrival[0]).toBe(0); // Ana está no nó 0
    expect(f.arrival[24]).toBe(f.header.nao_alcancado); // canto oposto: depois do fim
    expect(f.arrival[25 + 24]).toBe(0); // Bia está no nó 24
  });
});
