// Painel de resultados (cartões) — só DOM; o conteúdo vem de results.resultCards.
import { personColor } from "./flood";
import type { ResultCard } from "./results";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function link(href: string, text: string, cls?: string): HTMLAnchorElement {
  const a = el("a", cls, text);
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  a.addEventListener("click", (e) => e.stopPropagation());
  return a;
}

export class ResultsPanel {
  private cards: HTMLElement[] = [];
  constructor(private body: HTMLElement) {}

  render(cards: ResultCard[], warnings: string[], onSelect: (i: number) => void): void {
    this.body.replaceChildren();
    this.cards = cards.map((c, i) => {
      const card = el("article", "card");
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", `Resultado ${c.rank}: ${c.title}. Mostrar rotas`);
      const h = el("h3");
      h.append(el("span", "rank", `#${c.rank}`), el("span", "title", c.title), el("span", "score", c.score));
      card.append(h, link(c.map, "abrir no Google Maps", "maplink"));
      const table = el("table", "trips");
      for (const t of c.trips) {
        const tr = el("tr");
        const name = el("td", "name");
        const sw = el("span", "sw");
        sw.style.setProperty("--c", personColor(t.person));
        name.append(sw, link(t.route, t.name));
        const badge = el("span", t.live ? "badge live" : "badge", t.live ? "ao vivo" : "estimativa");
        const tdBadge = el("td");
        tdBadge.append(badge);
        tr.append(name, el("td", undefined, t.time), el("td", undefined, t.dist), tdBadge);
        table.append(tr);
      }
      card.append(table);
      card.addEventListener("click", () => onSelect(i));
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(i);
        }
      });
      this.body.append(card);
      return card;
    });
    if (warnings.length) {
      const ul = el("ul", "warnings");
      for (const w of warnings) ul.append(el("li", undefined, `⚠ ${w}`));
      this.body.append(ul);
    }
    if (!cards.length) this.body.prepend(el("p", undefined, "Nenhum resultado."));
  }

  select(i: number | null): void {
    this.cards.forEach((c, k) => c.classList.toggle("sel", k === i));
    if (i !== null) this.cards[i]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}
