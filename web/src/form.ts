// Formulário da busca (DOM). O estado vive em `SearchState`; ver state.ts.
import { personColor } from "./flood";
import { MAX_PEOPLE, validate, type SearchState } from "./state";

export interface GeocodeResult {
  lat: number;
  lon: number;
  rotulo: string;
}

export interface FormHooks {
  geocode(endereco: string): Promise<GeocodeResult>;
  /** estado mudou (pessoas, posições ou opções) */
  change(): void;
  submit(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

export class SearchForm {
  private notes: string[] = []; // rótulo geocodificado / erro de cada pessoa
  private busy = false;

  constructor(
    private root: HTMLFormElement,
    public state: SearchState,
    private hooks: FormHooks,
  ) {
    root.addEventListener("submit", (e) => {
      e.preventDefault();
      this.readOptions();
      const errs = validate(this.state);
      this.showErrors(errs);
      if (!errs.length && !this.busy) hooks.submit();
    });
    this.render();
  }

  setBusy(b: boolean): void {
    this.busy = b;
    const btn = this.root.querySelector<HTMLButtonElement>("button[type=submit]");
    if (btn) {
      btn.disabled = b;
      btn.textContent = b ? "Calculando…" : "Buscar ponto de encontro";
    }
  }

  /** Posição alterada fora do formulário (marcador arrastado). */
  moved(i: number, lat: number, lon: number): void {
    Object.assign(this.state.pessoas[i], { lat, lon });
    this.notes[i] = `posição ajustada no mapa (${lat.toFixed(5)}, ${lon.toFixed(5)})`;
    this.render();
    this.hooks.change();
  }

  private async locate(i: number): Promise<void> {
    const p = this.state.pessoas[i];
    delete p.lat;
    delete p.lon;
    if (!p.endereco.trim()) {
      this.notes[i] = "";
      this.render();
      this.hooks.change();
      return;
    }
    this.notes[i] = "localizando…";
    this.render();
    try {
      const g = await this.hooks.geocode(p.endereco);
      if (this.state.pessoas[i] !== p) return; // a linha mudou enquanto esperava
      Object.assign(p, { lat: g.lat, lon: g.lon });
      this.notes[i] = `📍 ${g.rotulo} — arraste o marcador para corrigir`;
    } catch (e) {
      this.notes[i] = `⚠ ${(e as Error).message}`;
    }
    this.render();
    this.hooks.change();
  }

  private readOptions(): void {
    const f = new FormData(this.root);
    const s = this.state;
    s.objetivo = f.get("objetivo") === "casa" ? "casa" : "cidade";
    s.criterio = (f.get("criterio") as SearchState["criterio"]) ?? "justo";
    s.metrica = f.get("metrica") === "distancia" ? "distancia" : "tempo";
    s.k = Number(f.get("k"));
    const lim = String(f.get("limite") ?? "").replace(",", ".").trim();
    s.limite = lim === "" ? null : Number(lim);
    s.aoVivo = f.get("ao_vivo") === "on";
  }

  private showErrors(errs: string[]): void {
    const box = this.root.querySelector(".form-errors")!;
    box.replaceChildren(...errs.map((e) => el("li", {}, e)));
  }

  render(): void {
    const s = this.state;
    const people = el("fieldset", { class: "people" });
    people.append(el("legend", {}, "Pessoas"));
    s.pessoas.forEach((p, i) => {
      const row = el("div", { class: "person" });
      row.style.setProperty("--c", personColor(i));
      const nome = el("input", { "aria-label": `Nome da pessoa ${i + 1}`, placeholder: "Nome", class: "nome", maxlength: "60" });
      nome.value = p.nome;
      nome.addEventListener("input", () => {
        p.nome = nome.value;
        this.hooks.change();
      });
      const end = el("input", { "aria-label": `Endereço de ${p.nome || `pessoa ${i + 1}`}`, placeholder: "Endereço ou lat, lon", class: "endereco", maxlength: "200" });
      end.value = p.endereco;
      end.addEventListener("input", () => (p.endereco = end.value));
      // geocodifica só ao confirmar (Enter ou sair do campo): o Nominatim proíbe autocompletar
      end.addEventListener("change", () => this.locate(i));
      end.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          end.blur();
        }
      });
      const rm = el("button", { type: "button", class: "rm", "aria-label": `Remover ${p.nome || `pessoa ${i + 1}`}` }, "×");
      rm.addEventListener("click", () => {
        s.pessoas.splice(i, 1);
        this.notes.splice(i, 1);
        this.render();
        this.hooks.change();
      });
      const sw = el("span", { class: "sw" });
      row.append(sw, nome, end, rm);
      const note = this.notes[i] ?? (p.lat !== undefined ? "📍 posição do link" : "");
      if (note) row.append(el("small", { class: note.startsWith("⚠") ? "note err" : "note" }, note));
      people.append(row);
    });
    const add = el("button", { type: "button", class: "add" }, "+ pessoa");
    add.disabled = s.pessoas.length >= MAX_PEOPLE;
    add.addEventListener("click", () => {
      s.pessoas.push({ nome: "", endereco: "" });
      this.render();
      this.root.querySelectorAll<HTMLInputElement>("input.nome")[s.pessoas.length - 1]?.focus();
    });
    people.append(add);

    const opts = el("fieldset", { class: "opts" });
    opts.append(el("legend", {}, "Opções"));
    const select = (name: string, label: string, options: [string, string][], value: string) => {
      const l = el("label", {}, label);
      const sel = el("select", { name });
      for (const [v, t] of options) {
        const o = el("option", { value: v }, t);
        if (v === value) o.selected = true;
        sel.append(o);
      }
      sel.addEventListener("change", () => {
        this.readOptions();
        this.syncLimit();
      });
      l.append(sel);
      return l;
    };
    opts.append(
      select("objetivo", "Onde", [["cidade", "Qualquer ponto da cidade"], ["casa", "Na casa de alguém"]], s.objetivo),
      select("criterio", "Critério", [
        ["justo", "Mais justo (menor maior trajeto)"],
        ["total", "Menor soma"],
        ["igualitario", "Mais igualitário"],
        ["limite", "Ninguém passa do limite"],
      ], s.criterio),
      select("metrica", "Medir por", [["tempo", "Tempo"], ["distancia", "Distância"]], s.metrica),
    );
    const k = el("label", {}, "Resultados (K)");
    const kin = el("input", { name: "k", type: "number", min: "1", max: "20", step: "1", inputmode: "numeric" });
    kin.value = String(s.k);
    k.append(kin);
    const lim = el("label", { class: "limite" });
    lim.append(el("span", { class: "limite-label" }));
    const lin = el("input", { name: "limite", type: "text", inputmode: "decimal", placeholder: "opcional" });
    lin.value = s.limite === null ? "" : String(s.limite);
    lim.append(lin);
    const live = el("label", { class: "check" });
    const lc = el("input", { name: "ao_vivo", type: "checkbox" });
    lc.checked = s.aoVivo;
    live.append(lc, document.createTextNode(" Trânsito ao vivo (TomTom, se houver chave)"));
    opts.append(k, lim, live);

    const submit = el("button", { type: "submit", class: "go" }, "Buscar ponto de encontro");
    this.root.replaceChildren(people, opts, el("ul", { class: "form-errors", role: "alert" }), submit);
    this.syncLimit();
    this.setBusy(this.busy);
  }

  private syncLimit(): void {
    const label = this.root.querySelector(".limite-label");
    const input = this.root.querySelector<HTMLInputElement>("input[name=limite]");
    if (!label || !input) return;
    const unit = this.state.metrica === "tempo" ? "min" : "km";
    const req = this.state.criterio === "limite";
    label.textContent = `Limite (${unit})${req ? "" : " — opcional"}`;
    input.placeholder = req ? "obrigatório" : "opcional";
    input.required = req;
  }
}
