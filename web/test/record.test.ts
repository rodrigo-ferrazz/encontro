import { describe, expect, it } from "vitest";
import { ANIM_SECONDS, fileName, HOLD_SECONDS, MIME_CANDIDATES, pickMime, simTimeAt, totalSeconds } from "../src/record";

describe("vídeo 9:16", () => {
  it("prefere MP4 e cai para WebM", () => {
    expect(pickMime(() => true)).toBe(MIME_CANDIDATES[0]);
    expect(pickMime((m) => m.startsWith("video/webm"))).toBe("video/webm;codecs=vp9");
    expect(pickMime(() => false)).toBeNull();
  });

  it("nome do arquivo com extensão certa", () => {
    const d = new Date(2026, 10, 24, 9, 5);
    expect(fileName("video/mp4", d)).toBe("encontro-sp-20261124-0905.mp4");
    expect(fileName("video/webm;codecs=vp9", d)).toBe("encontro-sp-20261124-0905.webm");
  });

  it("a inundação inteira cabe em ANIM_SECONDS e o fim fica parado", () => {
    expect(simTimeAt(0, 1200)).toBe(0);
    expect(simTimeAt(ANIM_SECONDS / 2, 1200)).toBeCloseTo(600);
    expect(simTimeAt(ANIM_SECONDS, 1200)).toBe(1200);
    expect(simTimeAt(ANIM_SECONDS + 1, 1200)).toBe(1200);
    expect(totalSeconds()).toBe(ANIM_SECONDS + HOLD_SECONDS);
  });
});
