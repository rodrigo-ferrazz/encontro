// Relógio da animação: tempo simulado, play/pause, velocidade e arrastar.

export class Timeline {
  t = 0;
  playing = false;
  /** unidades simuladas (s ou m) por segundo real */
  rate: number;
  private listeners: Array<() => void> = [];

  constructor(
    public end: number,
    /** velocidade "1×": 1 min simulado ≈ 0,5 s real */
    readonly baseRate = 120,
    public speed = 1,
  ) {
    this.rate = baseRate * speed;
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  play(): void {
    if (this.t >= this.end) this.t = 0;
    this.playing = true;
    this.emit();
  }

  pause(): void {
    this.playing = false;
    this.emit();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  restart(): void {
    this.t = 0;
    this.playing = true;
    this.emit();
  }

  seek(t: number): void {
    this.t = Math.min(this.end, Math.max(0, t));
    this.emit();
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    this.rate = this.baseRate * speed;
    this.emit();
  }

  get done(): boolean {
    return this.t >= this.end;
  }

  /** Avança `dtReal` segundos reais. Devolve true se o tempo mudou. */
  step(dtReal: number): boolean {
    if (!this.playing) return false;
    // um quadro muito longo (aba em segundo plano) não pula a animação inteira
    const dt = Math.min(dtReal, 0.1);
    this.t = Math.min(this.end, this.t + dt * this.rate);
    if (this.t >= this.end) {
      this.playing = false;
      this.emit();
    }
    return true;
  }
}

export function fmtSim(t: number, unit: "s" | "m"): string {
  if (unit === "m") return `${(t / 1000).toFixed(1).replace(".", ",")} km`;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
