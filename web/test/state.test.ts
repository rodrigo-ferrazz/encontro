import { describe, expect, it } from "vitest";
import { defaultState, parseQuery, requestBody, toQuery, validate, type SearchState } from "../src/state";

const two = (): SearchState => ({
  ...defaultState(),
  pessoas: [
    { nome: "Ana", endereco: "Av. Paulista, 1578" },
    { nome: "Beto", endereco: "Tatuapé", lat: -23.54, lon: -46.57 },
  ],
});

describe("query string", () => {
  it("ida e volta preserva a busca (link compartilhável)", () => {
    const s: SearchState = { ...two(), objetivo: "casa", criterio: "limite", metrica: "distancia", k: 3, limite: 12.5, aoVivo: false };
    const back = parseQuery(new URLSearchParams(toQuery(s).toString()));
    expect(back).toEqual({ ...s, pessoas: [s.pessoas[0], { ...s.pessoas[1], lat: -23.54, lon: -46.57 }] });
  });

  it("valores padrão não poluem o link", () => {
    const q = toQuery(two()).toString();
    expect(q).not.toMatch(/criterio|metrica|objetivo|k=|ao_vivo/);
  });

  it("ignora valores inválidos e aceita vírgula decimal", () => {
    const s = parseQuery(new URLSearchParams("p=A|x&criterio=bobo&metrica=litros&k=abc&limite=2,5&objetivo=praia"));
    expect(s.criterio).toBe("justo");
    expect(s.metrica).toBe("tempo");
    expect(s.objetivo).toBe("cidade");
    expect(s.k).toBe(5);
    expect(s.limite).toBe(2.5);
    expect(s.pessoas).toEqual([{ nome: "A", endereco: "x" }]);
  });

  it("barra vertical no texto não quebra o formato", () => {
    const s = { ...two() };
    s.pessoas[0] = { nome: "A|B", endereco: "Rua 1 | fundos" };
    const back = parseQuery(toQuery(s));
    expect(back.pessoas[0]).toEqual({ nome: "A/B", endereco: "Rua 1 / fundos" });
  });
});

describe("validate (mesmas regras da CLI)", () => {
  it("válido", () => expect(validate(two())).toEqual([]));
  it("pelo menos 2 pessoas", () => {
    expect(validate({ ...two(), pessoas: [two().pessoas[0]] })).toContain("Informe pelo menos 2 pessoas.");
  });
  it("nome e endereço", () => {
    const s = two();
    s.pessoas[0].nome = "";
    s.pessoas[1] = { nome: "Beto", endereco: "" };
    expect(validate(s)).toEqual(["Pessoa 1: falta o nome.", "Beto: falta o endereço."]);
  });
  it("critério limite exige limite; limite e K válidos", () => {
    expect(validate({ ...two(), criterio: "limite" })).toContain("O critério limite exige um limite.");
    expect(validate({ ...two(), limite: 0 })).toContain("O limite deve ser maior que zero.");
    expect(validate({ ...two(), k: 0 })).toHaveLength(1);
  });
});

describe("requestBody", () => {
  it("manda a posição confirmada como lat, lon", () => {
    const b = requestBody({ ...two(), limite: 30 }) as any;
    expect(b.pessoas).toEqual([
      { nome: "Ana", endereco: "Av. Paulista, 1578" },
      { nome: "Beto", endereco: "-23.540000, -46.570000" },
    ]);
    expect(b).toMatchObject({ objetivo: "cidade", criterio: "justo", metrica: "tempo", k: 5, limite: 30, ao_vivo: true });
  });
});
