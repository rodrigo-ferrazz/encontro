import { describe, expect, it } from "vitest";
import { Camera } from "../src/view";

describe("Camera", () => {
  it("enquadra o retângulo com margem", () => {
    const c = new Camera();
    c.resize(400, 800);
    c.fit([0, 0, 1000, 1000], 16);
    expect(c.scale).toBeCloseTo(368 / 1000);
    const [sx, sy] = c.toScreen(0, 1000);
    expect(sx).toBeCloseTo(16);
    expect(sy).toBeCloseTo(400 - 184);
  });

  it("zoom mantém fixo o ponto sob o cursor", () => {
    const c = new Camera();
    c.resize(400, 400);
    c.fit([0, 0, 1000, 1000]);
    const before = c.toWorld(100, 50);
    c.zoomAt(100, 50, 3);
    const after = c.toWorld(100, 50);
    expect(after[0]).toBeCloseTo(before[0], 6);
    expect(after[1]).toBeCloseTo(before[1], 6);
  });

  it("pan move o mundo junto com o dedo; toWorld inverte toScreen", () => {
    const c = new Camera();
    c.resize(300, 300);
    c.fit([0, 0, 300, 300], 0);
    const w = c.toWorld(10, 10);
    c.panBy(20, 30);
    const s = c.toScreen(w[0], w[1]);
    expect(s[0]).toBeCloseTo(30);
    expect(s[1]).toBeCloseTo(40);
  });

  it("respeita o zoom mínimo", () => {
    const c = new Camera();
    c.resize(100, 100);
    c.fit([0, 0, 100, 100], 0);
    c.zoomAt(50, 50, 1e-6);
    expect(c.scale).toBeCloseTo(c.minScale);
  });
});

describe("Camera.fit com folgas diferentes", () => {
  it("centraliza o retângulo na área livre (fora do painel)", () => {
    const c = new Camera();
    c.resize(1000, 600);
    c.fit([0, 0, 1000, 1000], 0); // home
    c.fit([0, 0, 100, 100], { top: 0, right: 400, bottom: 0, left: 0 }, false);
    const [sx, sy] = c.toScreen(50, 50);
    expect(sx).toBeCloseTo(300); // meio dos 600 px livres à esquerda
    expect(sy).toBeCloseTo(300);
    const [ex] = c.toScreen(100, 50);
    expect(ex).toBeLessThanOrEqual(600 + 1e-6);
  });
});
