import { describe, expect, it } from "vitest";
import { decodeFlood, decodeMesh } from "../src/binary";
import { Projection } from "../src/geometry";
import { fmtDist, fmtTime, resultCards, routePieces, segmentIndex, shortPlace, type ApiSearch } from "../src/results";
import { fixture } from "./helpers";

const flood = decodeFlood(fixture("grid_flood.bin"));
const search = flood.header.resultado as ApiSearch;

describe("formatos iguais aos da CLI", () => {
  it("tempo", () => {
    expect(fmtTime(0)).toBe("0 min");
    expect(fmtTime(89)).toBe("1 min");
    expect(fmtTime(3600)).toBe("1h00");
    expect(fmtTime(4500)).toBe("1h15");
    expect(fmtTime(null)).toBe("—");
  });
  it("distância", () => {
    expect(fmtDist(2640)).toBe("2,6 km");
    expect(fmtDist(null)).toBe("—");
  });
});

describe("resultCards", () => {
  it("o ranking da tela é idêntico ao JSON da API", () => {
    const cards = resultCards(search);
    expect(cards.map((c) => c.rank)).toEqual(search.resultados.map((r) => r.rank));
    expect(cards.map((c) => [c.lat, c.lon])).toEqual(search.resultados.map((r) => [r.lat, r.lon]));
    cards.forEach((c, i) => {
      const r = search.resultados[i];
      expect(c.map).toBe(r.mapa);
      expect(c.trips.map((t) => t.name)).toEqual(r.deslocamentos.map((d) => d.nome));
      expect(c.trips.map((t) => t.time)).toEqual(r.deslocamentos.map((d) => fmtTime(d.tempo_s)));
      expect(c.trips.map((t) => t.route)).toEqual(r.deslocamentos.map((d) => d.rota));
      expect(c.trips.every((t) => t.live === false)).toBe(true);
    });
    expect(cards[0].score).toBe("1 min"); // 40 s
  });

  it("título: anfitrião, via ou sem nome", () => {
    const s: ApiSearch = {
      ...search,
      resultados: [
        { ...search.resultados[0], anfitriao: "Ana", via: "Rua X" },
        { ...search.resultados[0], anfitriao: null, via: null, rank: 2 },
      ],
    };
    expect(resultCards(s).map((c) => c.title)).toEqual(["Casa de Ana", "Ponto sem nome"]);
  });
});

describe("shortPlace", () => {
  it("resume o endereço", () => {
    expect(shortPlace("Avenida Paulista, 1578")).toBe("Avenida Paulista, 1578");
    expect(shortPlace("Avenida Engenheiro Luís Carlos Berrini, 1000")).toBe("Avenida Engenheiro Luís Car…");
    expect(shortPlace("Praça Silvio Romero, número grande, Tatuapé, São Paulo")).toBe("número grande");
    expect(shortPlace("-23.550000, -46.630000")).toBe("-23.550, -46.630");
  });
});

describe("routePieces", () => {
  const mesh = decodeMesh(fixture("grid_mesh.bin"));
  const proj = Projection.forMesh(mesh);
  const idx = segmentIndex(mesh);

  it("as rotas da API vão da pessoa ao ponto, contínuas, pela geometria das ruas", () => {
    const routes = flood.header.rotas as number[][][];
    expect(routes.length).toBe(search.resultados.length);
    routes[0].forEach((nodes, i) => {
      const p = routePieces(mesh, idx, proj, nodes);
      expect(p.length / 4).toBe(nodes.length - 1); // grade: cada rua é uma reta
      const person = search.pessoas[i];
      const best = search.resultados[0];
      expect(p[0]).toBeCloseTo(proj.x(person.lon), 0);
      expect(p[1]).toBeCloseTo(proj.y(person.lat), 0);
      expect(p[p.length - 2]).toBeCloseTo(proj.x(best.lon), 0);
      expect(p[p.length - 1]).toBeCloseTo(proj.y(best.lat), 0);
      for (let k = 4; k < p.length; k += 4) {
        expect(p[k]).toBeCloseTo(p[k - 2], 3);
        expect(p[k + 1]).toBeCloseTo(p[k - 1], 3);
      }
    });
  });
});
