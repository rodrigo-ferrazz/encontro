// Estado da busca: formulário ⇄ query string (para compartilhar por link) ⇄ corpo do POST.

export interface PersonInput {
  nome: string;
  endereco: string; // o que a pessoa digitou (referência mostrada no rótulo)
  lat?: number; // posição confirmada (geocodificada ou arrastada)
  lon?: number;
}

export interface SearchState {
  pessoas: PersonInput[];
  objetivo: "cidade" | "casa";
  criterio: "justo" | "total" | "igualitario" | "limite";
  metrica: "tempo" | "distancia";
  k: number;
  limite: number | null; // minutos (tempo) ou km (distância), como na CLI
  aoVivo: boolean;
}

export const CRITERIOS = ["justo", "total", "igualitario", "limite"] as const;
export const MAX_PEOPLE = 12; // igual ao limite da API

export function defaultState(): SearchState {
  return { pessoas: [], objetivo: "cidade", criterio: "justo", metrica: "tempo", k: 5, limite: null, aoVivo: true };
}

const num = (s: string | null): number | null => {
  if (s === null || s.trim() === "") return null;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

/** `p=Nome|endereço` ou `p=Nome|endereço|lat,lon` (repetível) + opções. */
export function parseQuery(q: URLSearchParams): SearchState {
  const s = defaultState();
  for (const raw of q.getAll("p")) {
    const [nome = "", endereco = "", pos = ""] = raw.split("|");
    const p: PersonInput = { nome: nome.trim(), endereco: endereco.trim() };
    const m = pos.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) {
      p.lat = Number(m[1]);
      p.lon = Number(m[2]);
    }
    if (p.nome || p.endereco) s.pessoas.push(p);
  }
  const o = q.get("objetivo");
  if (o === "casa" || o === "cidade") s.objetivo = o;
  const c = q.get("criterio");
  if (c && (CRITERIOS as readonly string[]).includes(c)) s.criterio = c as SearchState["criterio"];
  const m = q.get("metrica");
  if (m === "tempo" || m === "distancia") s.metrica = m;
  const k = num(q.get("k"));
  if (k !== null) s.k = Math.round(k);
  s.limite = num(q.get("limite"));
  if (q.get("ao_vivo") === "0") s.aoVivo = false;
  return s;
}

export function toQuery(s: SearchState): URLSearchParams {
  const q = new URLSearchParams();
  for (const p of s.pessoas) {
    const pos = p.lat !== undefined && p.lon !== undefined ? `|${p.lat.toFixed(6)},${p.lon.toFixed(6)}` : "";
    q.append("p", `${p.nome.replace(/\|/g, "/")}|${p.endereco.replace(/\|/g, "/")}${pos}`);
  }
  const d = defaultState();
  if (s.objetivo !== d.objetivo) q.set("objetivo", s.objetivo);
  if (s.criterio !== d.criterio) q.set("criterio", s.criterio);
  if (s.metrica !== d.metrica) q.set("metrica", s.metrica);
  if (s.k !== d.k) q.set("k", String(s.k));
  if (s.limite !== null) q.set("limite", String(s.limite));
  if (!s.aoVivo) q.set("ao_vivo", "0");
  return q;
}

/** Mesmas regras da CLI/API. Devolve as mensagens de erro (vazio = válido). */
export function validate(s: SearchState): string[] {
  const errs: string[] = [];
  const filled = s.pessoas.filter((p) => p.nome.trim() || p.endereco.trim());
  if (filled.length < 2) errs.push("Informe pelo menos 2 pessoas.");
  if (filled.length > MAX_PEOPLE) errs.push(`No máximo ${MAX_PEOPLE} pessoas.`);
  filled.forEach((p, i) => {
    if (!p.nome.trim()) errs.push(`Pessoa ${i + 1}: falta o nome.`);
    if (!p.endereco.trim() && p.lat === undefined) errs.push(`${p.nome || `Pessoa ${i + 1}`}: falta o endereço.`);
  });
  if (!Number.isInteger(s.k) || s.k < 1 || s.k > 20) errs.push("K deve ser um inteiro entre 1 e 20.");
  if (s.limite !== null && !(s.limite > 0)) errs.push("O limite deve ser maior que zero.");
  if (s.criterio === "limite" && s.limite === null) errs.push("O critério limite exige um limite.");
  return errs;
}

/** Corpo do POST /buscar. Com a posição confirmada, manda "lat, lon" (não geocodifica de novo). */
export function requestBody(s: SearchState): Record<string, unknown> {
  return {
    pessoas: s.pessoas
      .filter((p) => p.nome.trim() || p.endereco.trim())
      .map((p) => ({
        nome: p.nome.trim(),
        endereco: p.lat !== undefined && p.lon !== undefined ? `${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}` : p.endereco.trim(),
      })),
    objetivo: s.objetivo,
    criterio: s.criterio,
    metrica: s.metrica,
    k: s.k,
    limite: s.limite,
    ao_vivo: s.aoVivo,
  };
}
