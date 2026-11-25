// Marcadores em HTML sobre o canvas (pessoas, ponto de encontro), reposicionados a cada quadro.
import type { Projection } from "./geometry";
import type { Camera } from "./view";

export interface Marker {
  el: HTMLElement;
  x: number;
  y: number;
}

export class MarkerLayer {
  private markers: Marker[] = [];
  constructor(
    private root: HTMLElement,
    private proj: Projection,
  ) {}

  add(lat: number, lon: number, opts: { label?: string; color?: string; className?: string }): Marker {
    const el = document.createElement("div");
    el.className = "marker" + (opts.className ? ` ${opts.className}` : "");
    if (opts.color) el.style.setProperty("--c", opts.color);
    const dot = document.createElement("span");
    dot.className = "dot";
    el.appendChild(dot);
    if (opts.label) {
      const lab = document.createElement("span");
      lab.className = "label";
      lab.textContent = opts.label;
      el.appendChild(lab);
    }
    this.root.appendChild(el);
    const m = { el, x: this.proj.x(lon), y: this.proj.y(lat) };
    this.markers.push(m);
    return m;
  }

  clear(): void {
    for (const m of this.markers) m.el.remove();
    this.markers = [];
  }

  update(cam: Camera): void {
    for (const m of this.markers) {
      const [sx, sy] = cam.toScreen(m.x, m.y);
      m.el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
    }
  }
}
