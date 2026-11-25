// FE-09: exporta a animação como vídeo vertical 9:16 (MediaRecorder no navegador).
//
// O mapa é desenhado pelo mesmo renderer WebGL em 1080×1920, copiado quadro a quadro para
// um canvas 2D que recebe por cima o título, os rótulos, o relógio, a legenda e a atribuição
// do OSM; o stream desse canvas é gravado. A gravação é em tempo real.
import { fmtSim } from "./timeline";

export const VIDEO_W = 1080;
export const VIDEO_H = 1920;
export const VIDEO_FPS = 30;
/** duração da inundação no vídeo (s) + tempo parado no fim mostrando o encontro */
export const ANIM_SECONDS = 12;
export const HOLD_SECONDS = 2.5;

/** Formatos em ordem de preferência: MP4 (abre em qualquer celular) e depois WebM. */
export const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.640028",
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

export function pickMime(isSupported: (m: string) => boolean): string | null {
  return MIME_CANDIDATES.find((m) => isSupported(m)) ?? null;
}

export function fileName(mime: string, when = new Date()): string {
  const ext = mime.startsWith("video/mp4") ? "mp4" : "webm";
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}-${pad(when.getHours())}${pad(when.getMinutes())}`;
  return `encontro-sp-${stamp}.${ext}`;
}

/** Tempo simulado no instante `elapsed` (s reais) do vídeo: anda até tEnd e para. */
export function simTimeAt(elapsed: number, tEnd: number, animSeconds = ANIM_SECONDS): number {
  return Math.min(tEnd, Math.max(0, (elapsed / animSeconds) * tEnd));
}

export function totalSeconds(animSeconds = ANIM_SECONDS, hold = HOLD_SECONDS): number {
  return animSeconds + hold;
}

/** Áreas da tela do vídeo: faixa do título em cima, faixa do relógio embaixo, mapa no meio. */
export const LAYOUT = { top: 260, bottom: 300, side: 60 };

export interface OverlayPerson {
  name: string;
  color: string;
  x: number; // px no vídeo
  y: number;
}

export interface Overlay {
  title: string;
  subtitle: string;
  legend: string;
  unit: "s" | "m";
  people: OverlayPerson[];
  meet: { x: number; y: number } | null;
  tStar: number;
}

export function drawOverlay(ctx: CanvasRenderingContext2D, o: Overlay, t: number): void {
  const W = VIDEO_W;
  const H = VIDEO_H;
  // faixas com degradê para o texto ficar legível sobre o mapa
  let g = ctx.createLinearGradient(0, 0, 0, LAYOUT.top + 80);
  g.addColorStop(0, "rgba(5,4,4,0.95)");
  g.addColorStop(1, "rgba(5,4,4,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, LAYOUT.top + 80);
  g = ctx.createLinearGradient(0, H - LAYOUT.bottom - 80, 0, H);
  g.addColorStop(0, "rgba(5,4,4,0)");
  g.addColorStop(1, "rgba(5,4,4,0.95)");
  ctx.fillStyle = g;
  ctx.fillRect(0, H - LAYOUT.bottom - 80, W, LAYOUT.bottom + 80);

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#efe6dc";
  ctx.font = "700 72px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  ctx.fillText(o.title, W / 2, 140);
  ctx.fillStyle = "#c9bcb0";
  ctx.font = "500 40px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  ctx.fillText(o.subtitle, W / 2, 204, W - 2 * LAYOUT.side);

  // pessoas
  ctx.textAlign = "left";
  ctx.font = "700 38px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  for (const p of o.people) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 16, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 24;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 5;
    ctx.strokeStyle = "#050404";
    ctx.stroke();
    ctx.lineWidth = 8;
    ctx.strokeStyle = "rgba(5,4,4,0.85)";
    ctx.strokeText(p.name, p.x + 28, p.y + 13);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(p.name, p.x + 28, p.y + 13);
  }

  // encontro
  if (o.meet && t >= o.tStar) {
    const age = Math.min(1, (t - o.tStar) / Math.max(o.tStar * 0.15, 1));
    ctx.beginPath();
    ctx.arc(o.meet.x, o.meet.y, 22 + 50 * age, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,255,255,${0.8 * (1 - age) + 0.15})`;
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(o.meet.x, o.meet.y, 22, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.shadowColor = "#ffffff";
    ctx.shadowBlur = 40;
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // relógio, legenda e atribuição (obrigatória pela ODbL)
  ctx.textAlign = "center";
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 96px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillText(fmtSim(t, o.unit), W / 2, H - 170);
  ctx.fillStyle = "#c9bcb0";
  ctx.font = "500 34px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  ctx.fillText(o.legend, W / 2, H - 100, W - 2 * LAYOUT.side);
  ctx.fillStyle = "#8a7a6c";
  ctx.font = "400 26px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  ctx.fillText("© OpenStreetMap contributors", W / 2, H - 48);
}

export interface RecordSource {
  /** canvas WebGL do mapa */
  glCanvas: HTMLCanvasElement;
  tEnd: number;
  /** prepara o renderer/câmera para W×H; devolve a função que desfaz */
  begin(w: number, h: number): () => void;
  /** desenha o mapa no instante t (no canvas WebGL) */
  drawAt(t: number): void;
  /** overlay com posições já na tela do vídeo (chamado depois de begin) */
  overlay(): Overlay;
}

/** Grava o vídeo e devolve o arquivo. `onProgress` recebe 0..1. */
export async function record(src: RecordSource, onProgress?: (f: number) => void): Promise<File> {
  if (typeof MediaRecorder === "undefined") throw new Error("este navegador não grava vídeo (MediaRecorder)");
  const mime = pickMime((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) throw new Error("nenhum formato de vídeo suportado neste navegador");

  const out = document.createElement("canvas");
  out.width = VIDEO_W;
  out.height = VIDEO_H;
  const ctx = out.getContext("2d")!;
  const restore = src.begin(VIDEO_W, VIDEO_H);
  const overlay = src.overlay();

  const frame = (t: number) => {
    src.drawAt(t);
    ctx.drawImage(src.glCanvas, 0, 0, VIDEO_W, VIDEO_H);
    drawOverlay(ctx, overlay, t);
  };
  frame(0);

  const stream = out.captureStream(VIDEO_FPS);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise<void>((resolve) => (rec.onstop = () => resolve()));

  try {
    rec.start(250);
    const total = totalSeconds();
    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      const tick = () => {
        const elapsed = (performance.now() - t0) / 1000;
        frame(simTimeAt(elapsed, src.tEnd));
        onProgress?.(Math.min(1, elapsed / total));
        if (elapsed >= total) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    rec.stop();
    await stopped;
  } finally {
    stream.getTracks().forEach((tr) => tr.stop());
    restore();
  }
  return new File(chunks, fileName(mime), { type: mime.split(";")[0] });
}

/** Um quadro do vídeo no instante t, para pré-visualizar (não desfaz o `begin`). */
export function previewFrame(src: RecordSource, t: number): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = VIDEO_W;
  out.height = VIDEO_H;
  const ctx = out.getContext("2d")!;
  src.begin(VIDEO_W, VIDEO_H);
  const overlay = src.overlay();
  src.drawAt(t);
  ctx.drawImage(src.glCanvas, 0, 0, VIDEO_W, VIDEO_H);
  drawOverlay(ctx, overlay, t);
  return out;
}
