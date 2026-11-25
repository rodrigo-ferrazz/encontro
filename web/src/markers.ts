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

  add(
    lat: number,
    lon: number,
    opts: {
      label?: string;
      color?: string;
      className?: string;
      text?: string;
      onClick?: () => void;
      title?: string;
      /** arrastável: chamado ao soltar, com a nova posição */
      onDrag?: (lat: number, lon: number) => void;
    },
  ): Marker {
    const el = document.createElement("div");
    el.className = "marker" + (opts.className ? ` ${opts.className}` : "");
    if (opts.color) el.style.setProperty("--c", opts.color);
    const dot = document.createElement("span");
    dot.className = "dot";
    if (opts.text) dot.textContent = opts.text;
    el.appendChild(dot);
    if (opts.title) el.title = opts.title;
    if (opts.onClick) {
      el.classList.add("clickable");
      el.addEventListener("click", opts.onClick);
    }
    if (opts.label) {
      const lab = document.createElement("span");
      lab.className = "label";
      lab.textContent = opts.label;
      el.appendChild(lab);
    }
    this.root.appendChild(el);
    const m = { el, x: this.proj.x(lon), y: this.proj.y(lat) };
    this.markers.push(m);
    if (opts.onDrag) this.draggable(m, opts.onDrag);
    return m;
  }

  private cam: Camera | null = null;

  private draggable(m: Marker, onDrag: (lat: number, lon: number) => void): void {
    const el = m.el;
    el.classList.add("draggable");
    el.title = el.title || "Arraste para corrigir a posição";
    let active = false;
    el.addEventListener("pointerdown", (e) => {
      e.stopPropagation(); // não arrasta o mapa junto
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      active = true;
      el.classList.add("dragging");
    });
    el.addEventListener("pointermove", (e) => {
      if (!active || !this.cam) return;
      const r = this.root.getBoundingClientRect();
      [m.x, m.y] = this.cam.toWorld(e.clientX - r.left, e.clientY - r.top);
      this.update(this.cam);
    });
    const end = () => {
      if (!active) return;
      active = false;
      el.classList.remove("dragging");
      onDrag(this.proj.lat(m.y), this.proj.lon(m.x));
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  remove(m: Marker): void {
    m.el.remove();
    this.markers = this.markers.filter((x) => x !== m);
  }

  clear(): void {
    for (const m of this.markers) m.el.remove();
    this.markers = [];
  }

  update(cam: Camera): void {
    this.cam = cam;
    for (const m of this.markers) {
      const [sx, sy] = cam.toScreen(m.x, m.y);
      m.el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
    }
  }
}
