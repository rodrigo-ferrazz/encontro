// FE-08: o que a animação representa. A tela nunca pode sugerir trânsito ao vivo sem ser.
import type { Flood } from "./binary";

export interface FloodLegend {
  text: string;
  detail: string;
  live: boolean;
}

export function floodLegend(h: Flood["header"], names: string[]): FloodLegend {
  if (h.unidade === "m") {
    return {
      text: "Inundação por distância",
      detail: "Mostra a distância pelas ruas (grafo do OpenStreetMap); o trânsito não muda distância.",
      live: false,
    };
  }
  if (h.fonte === "calibrada_ao_vivo" && h.fatores) {
    const parts = h.fatores.map((f, i) => `${names[i] ?? `pessoa ${i + 1}`} ×${f.toFixed(2).replace(".", ",")}`);
    return {
      text: "Aproximação do trânsito ao vivo",
      detail:
        "A inundação usa o grafo local, sem trânsito, com a velocidade de cada pessoa ajustada pelo " +
        `trânsito ao vivo medido nos resultados (${parts.join(", ")}). O ranking usa os tempos ao vivo.`,
      live: true,
    };
  }
  return {
    text: "Estimativa sem trânsito",
    detail: "A inundação e os tempos vêm do grafo local (OpenStreetMap), sem trânsito ao vivo.",
    live: false,
  };
}
