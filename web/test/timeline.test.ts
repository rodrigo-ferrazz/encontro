import { describe, expect, it } from "vitest";
import { fmtSim, Timeline } from "../src/timeline";

describe("Timeline", () => {
  it("1 min simulado ≈ 0,5 s real na velocidade 1×", () => {
    const tl = new Timeline(1000);
    tl.play();
    for (let i = 0; i < 5; i++) tl.step(0.1);
    expect(tl.t).toBeCloseTo(60);
  });

  it("para no fim e play recomeça do zero", () => {
    const tl = new Timeline(100);
    let changes = 0;
    tl.onChange(() => changes++);
    tl.play();
    for (let i = 0; i < 20; i++) tl.step(0.1);
    expect(tl.t).toBe(100);
    expect(tl.playing).toBe(false);
    expect(tl.done).toBe(true);
    tl.play();
    expect(tl.t).toBe(0);
    expect(changes).toBeGreaterThanOrEqual(3);
  });

  it("um quadro longo (aba escondida) não pula a animação", () => {
    const tl = new Timeline(10000);
    tl.play();
    tl.step(30);
    expect(tl.t).toBeCloseTo(12);
  });

  it("velocidade, seek limitado e pausa", () => {
    const tl = new Timeline(500);
    tl.setSpeed(2);
    tl.play();
    tl.step(0.1);
    expect(tl.t).toBeCloseTo(24);
    tl.seek(9999);
    expect(tl.t).toBe(500);
    tl.seek(-5);
    expect(tl.t).toBe(0);
    tl.pause();
    expect(tl.step(0.1)).toBe(false);
    expect(tl.t).toBe(0);
  });
});

describe("fmtSim", () => {
  it("formata tempo e distância", () => {
    expect(fmtSim(0, "s")).toBe("0:00");
    expect(fmtSim(754.9, "s")).toBe("12:34");
    expect(fmtSim(1500, "m")).toBe("1,5 km");
  });
});
