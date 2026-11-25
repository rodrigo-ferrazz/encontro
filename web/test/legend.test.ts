import { describe, expect, it } from "vitest";
import { decodeFlood, type Flood } from "../src/binary";
import { floodLegend } from "../src/legend";
import { fixture } from "./helpers";

const base = decodeFlood(fixture("grid_flood.bin")).header;

describe("floodLegend: nunca sugere trânsito ao vivo sem ser", () => {
  it("fixture sem TomTom: estimativa local", () => {
    expect(base.fonte).toBe("estimativa_local");
    const l = floodLegend(base, ["Ana", "Bia"]);
    expect(l.live).toBe(false);
    expect(l.text).toBe("Estimativa sem trânsito");
    expect(l.text + l.detail).not.toMatch(/ao vivo medido/);
  });

  it("calibrada: diz que é aproximação e mostra os fatores", () => {
    const h: Flood["header"] = { ...base, fonte: "calibrada_ao_vivo", fatores: [1.8, 1.25] };
    const l = floodLegend(h, ["Ana", "Bia"]);
    expect(l.live).toBe(true);
    expect(l.text).toMatch(/^Aproximação/);
    expect(l.detail).toContain("Ana ×1,80");
    expect(l.detail).toContain("Bia ×1,25");
    expect(l.detail).toMatch(/sem trânsito/);
  });

  it("fonte calibrada sem fatores cai para estimativa", () => {
    expect(floodLegend({ ...base, fonte: "calibrada_ao_vivo" }, []).live).toBe(false);
  });

  it("distância: nunca é ao vivo", () => {
    const l = floodLegend({ ...base, unidade: "m", fonte: "calibrada_ao_vivo", fatores: [2] }, ["A"]);
    expect(l.live).toBe(false);
    expect(l.text).toMatch(/distância/);
  });
});
