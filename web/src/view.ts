// Câmera 2D: centro em metros + escala em pixels por metro. Tela com y para baixo.

export interface Pad {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export class Camera {
  cx = 0;
  cy = 0;
  scale = 0.01; // px por metro
  width = 1; // px CSS
  height = 1;
  minScale = 1e-4;
  maxScale = 20;

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
  }

  /**
   * Enquadra o retângulo [x0, y0, x1, y1] (metros) com folga em px — um número para os quatro
   * lados ou {top, right, bottom, left} (ex.: para não ficar atrás do painel).
   * `home` = true redefine o zoom mínimo (enquadramento da cidade inteira).
   */
  fit(
    [x0, y0, x1, y1]: [number, number, number, number],
    pad: number | Pad = 16,
    home = true,
  ): void {
    const p = typeof pad === "number" ? { top: pad, right: pad, bottom: pad, left: pad } : pad;
    const w = Math.max(this.width - p.left - p.right, 1);
    const h = Math.max(this.height - p.top - p.bottom, 1);
    const scale = Math.max(Math.min(w / Math.max(x1 - x0, 1), h / Math.max(y1 - y0, 1)), 1e-6);
    this.scale = home ? scale : Math.min(this.maxScale, Math.max(this.minScale, scale));
    if (home) this.minScale = this.scale * 0.5;
    // centro do retângulo no centro da área livre
    const freeCx = p.left + w / 2;
    const freeCy = p.top + h / 2;
    this.cx = (x0 + x1) / 2 - (freeCx - this.width / 2) / this.scale;
    this.cy = (y0 + y1) / 2 + (freeCy - this.height / 2) / this.scale;
  }

  toScreen(x: number, y: number): [number, number] {
    return [(x - this.cx) * this.scale + this.width / 2, this.height / 2 - (y - this.cy) * this.scale];
  }

  toWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.width / 2) / this.scale + this.cx, (this.height / 2 - sy) / this.scale + this.cy];
  }

  /** Zoom mantendo fixo o ponto da tela (sx, sy). */
  zoomAt(sx: number, sy: number, factor: number): void {
    const [wx, wy] = this.toWorld(sx, sy);
    this.scale = Math.min(this.maxScale, Math.max(this.minScale, this.scale * factor));
    const [nx, ny] = this.toWorld(sx, sy);
    this.cx += wx - nx;
    this.cy += wy - ny;
  }

  panBy(dxPx: number, dyPx: number): void {
    this.cx -= dxPx / this.scale;
    this.cy += dyPx / this.scale;
  }
}

/**
 * Liga mouse, roda e toque (arrastar e pinça) à câmera. `onChange` é chamado a cada mudança.
 */
export function attachControls(el: HTMLElement, cam: Camera, onChange: () => void): () => void {
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDist = 0;

  const local = (e: { clientX: number; clientY: number }) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = local(e);
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    cam.zoomAt(p.x, p.y, Math.exp(-delta * 0.0015));
    onChange();
  };

  const onDown = (e: PointerEvent) => {
    el.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };

  const onMove = (e: PointerEvent) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const p = local(e);
    if (pointers.size === 1) {
      cam.panBy(p.x - prev.x, p.y - prev.y);
    } else if (pointers.size === 2) {
      pointers.set(e.pointerId, p);
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      // metade do movimento do dedo que mexeu move o ponto médio
      cam.panBy((p.x - prev.x) / 2, (p.y - prev.y) / 2);
      if (pinchDist > 0) cam.zoomAt(mid.x, mid.y, d / pinchDist);
      pinchDist = d;
    }
    pointers.set(e.pointerId, p);
    onChange();
  };

  const onUp = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    pinchDist = 0;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };

  el.addEventListener("wheel", onWheel, { passive: false });
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
  return () => {
    el.removeEventListener("wheel", onWheel);
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onUp);
  };
}
