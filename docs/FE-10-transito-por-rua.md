# FE-10 · Spike: trânsito ao vivo nas arestas

Pergunta: dá para trocar a inundação "grafo local calibrado" (FE-08) por velocidade real em
cada rua, usando o **TomTom Traffic Flow em vector tiles**?

Resumo: **tecnicamente, sim, e bem mais fácil do que o backlog previa**. O casamento com o
OSM é quase trivial e a cobertura nas ruas pequenas é boa. Os bloqueios são outros: **os termos
de uso não foram verificados** e a API só devolve velocidade *relativa*. Recomendação no fim.

Medições feitas em 24/11/2026, por volta das 23 h, com a chave Freemium do projeto (~15
requisições de tile; scripts descartáveis, fora do repositório).

## 1. A API

| | Orbis v2 (recomendada pela TomTom) | Legado v1 |
|---|---|---|
| URL | `GET /maps/orbis/traffic/flow/vector/tile/{z}/{x}/{y}?apiVersion=2` | `GET /traffic/map/4/tile/flow/{absolute\|relative}/{z}/{x}/{y}.pbf` |
| Chave | header `TomTom-Api-Key` (ou `key=`) | `key=` |
| Formato | Mapbox Vector Tile, camada `Traffic flow`, LineStrings, extent 4096 | idem (protobuf) |
| Zoom | 0–22 (0–4 vêm vazios) | idem |
| Tags padrão | `road_category`, `road_subcategory`, `relative_speed` (0–1, atual ÷ fluxo livre), `road_closure`, `display_class` | `traffic_level` (km/h ou relativo) |
| Tags sob demanda | `absolute_speed`, `part_of_two_way_road`, `openlr` | `road_category`, `road_subcategory` |
| Validade | `Cache-Control: max-age=60` | — |

Medido: **as tags sob demanda não voltam com a nossa chave** (pedidas por nome ou com `*`).
Só vem `relative_speed`. Não descobri se é limitação do plano Freemium ou se falta algum
parâmetro. A consequência prática é que não sabemos a velocidade de fluxo livre da TomTom,
só a razão atual/livre.

## 2. Cobertura por zoom (tiles sobre a Av. Paulista)

| Zoom | Tamanho | Feições | Categorias |
|---|---|---|---|
| 10 | 103 KB | 252 | só motorway/trunk/primary/secondary |
| 12 | 64 KB | 252 | + tertiary e `_link` (sem ruas residenciais) |
| 14 | 12 KB | 88 | + `street/residential`, `unclassified`, `service` |
| 16 | 1 KB | 10 | idem z14, recortado |

**Ruas residenciais só aparecem a partir do z14.** No z12 vêm só as vias principais.

## 3. Casamento com o OSM (map matching)

Comparei a geometria de 4 tiles z14 (centro expandido) com a malha do nosso cache (FE-01):

- **Distância de cada ponto TomTom até a rua OSM mais próxima: mediana de 1,0 m**, e 100%
  dos pontos a até 10 m, em todas as categorias (residenciais: mediana de 0,9 m).
  O TomTom Orbis é feito em boa parte sobre dados do OSM/Overture, e isso aparece aqui: as
  geometrias praticamente coincidem.
- **Cobertura: 89% dos 3.393 trechos OSM da área têm fluxo TomTom a até 8 m** do ponto médio.
  O que falta é sobretudo `service`, ruas de acesso e trechos sem dados de sonda.

Então o "map matching" que o backlog via como risco vira um vizinho mais próximo por
pontos amostrados, com checagem de direção. A tag `openlr` permitiria casar com exatidão,
mas não vem na nossa chave.

Ressalvas: a amostra é de uma região central, num horário de pouco trânsito. Mediana de 1 m
de distância não prova que cada ponto caiu na rua certa: em vias paralelas coladas (pista
local × expressa da Marginal) ainda é preciso comparar a direção. Na periferia, a
cobertura deve ser menor.

## 4. Custo de cota (Freemium: 50 mil tiles/dia, contados à parte das 2.500 requisições "non-tile")

Tiles com ruas do município (contados sobre o nosso cache):

| Zoom | Tiles | A cidade inteira a cada 60 s | Com 50 mil/dia |
|---|---|---|---|
| 12 | 34 | 49 mil/dia | ~1 varredura por minuto (só vias principais) |
| 13 | 102 | 147 mil/dia | 1 a cada ~3 min |
| 14 | 333 | 480 mil/dia | 1 a cada ~10 min |

Por busca, baixando só o retângulo das pessoas: 4 pessoas espalhadas por ~15 km precisam de
~7×7 = 49 tiles z14 (~0,6 MB). Isso dá ~1.000 buscas/dia sem cache, e muito mais com o cache
de 60 s compartilhado entre buscas próximas.

O ponto de partida é bom: tiles não gastam a cota de 2.500 que a Matrix Routing usa hoje.

## 5. Termos de uso — **não verificados**

Não consegui ler os termos do Developer Portal: `developer.tomtom.com/terms-and-conditions`
redireciona para `docs.tomtom.com/legal/terms-and-conditions`, que carrega o texto no
navegador e não chegou pela busca automática. As perguntas continuam abertas:

1. Pode extrair a velocidade dos tiles e aplicá-la a outra malha (OSM), sem exibir o tile da
   TomTom? (No nosso caso, a TomTom nunca aparece como mapa: ela só alteraria os pesos e a
   animação.)
2. Por quanto tempo pode guardar no servidor? Um EULA de terceiros de 2019 limitava os
   dados de Traffic a **24 h** em servidor. Pode estar desatualizado.
3. Pode combinar com dados de outro provedor (OSM)?
4. Que atribuição é exigida ("© TomTom")?

**Isso precisa ser lido por uma pessoa, logada no portal, antes de qualquer código.**

## 6. Como ficaria (se os termos permitirem)

1. Backend, a cada busca: tiles z14 do retângulo das pessoas + margem de 20%, com cache em
   memória de 60 s (respeitando `max-age`) e nunca guardados por mais de 24 h.
2. Casamento: índice de pontos amostrados das ruas OSM (já temos a geometria do FE-01) →
   para cada trecho TomTom, os trechos OSM a ≤ 8 m com direção parecida (±30°); fica a
   média do `relative_speed` ponderada pelo comprimento.
3. Peso ao vivo da aresta: `tempo_ao_vivo = tempo_livre_osm / relative_speed`, onde
   `tempo_livre_osm` é o tempo sem o fator urbano de 0,6. Sem dados, a aresta mantém o
   peso local atual. Fica a heurística de que o fluxo livre do OSM (`maxspeed`) ≈ o da
   TomTom. Com `absolute_speed`, ela some.
4. Dijkstra de novo com esses pesos: a inundação passa a ser trânsito por rua de verdade.
   O pré-filtro de candidatos também melhora, e a Matrix Routing pode ficar só para
   confirmar o top-K. O selo da animação (FE-08) passa a ser "trânsito ao vivo por rua
   (TomTom)".
5. Custo extra de CPU: casamento incremental só nos tiles novos, mais um Dijkstra (≈ 0,1 s).

Estimativa: **M** (2–3 dias), mais o tempo de calibrar a heurística do item 3 contra a
Matrix Routing.

## 7. Recomendação

- **Não implementar ainda.** Primeiro, ler os termos (item 5). Se eles proibirem usar o
  fluxo fora de um mapa TomTom, ou guardá-lo, o FE-08 (calibração por pessoa) continua
  sendo a solução.
- Se os termos permitirem, **vale a pena**: o casamento é fácil (1 m de mediana), a cobertura é
  boa (89% no centro), e a cota de tiles é separada e folgada para uso pessoal.
- Antes de começar, gastar ~20 tiles para medir a cobertura na periferia (Parelheiros, Cidade
  Tiradentes, Perus) e no horário de pico, e confirmar com o suporte da TomTom se
  `absolute_speed`/`openlr` exigem outro plano.

### Fontes

- [Vector Flow Tiles — Orbis v2](https://docs.tomtom.com/traffic-api/documentation/tomtom-orbis-maps/v2/traffic-flow/vector-flow-tiles)
- [Vector Flow Tiles — legado v1](https://docs.tomtom.com/traffic-api/documentation/tomtom-maps/v1/traffic-flow/vector-flow-tiles)
- [Migração para o Orbis](https://docs.tomtom.com/traffic-api/documentation/tomtom-orbis-maps/v2/product-information/migration-guide)
- [Planos e cotas (Freemium: 50 mil tiles + 2.500 non-tile por dia)](https://developer.tomtom.com/store/maps-api)
- [FAQ da plataforma](https://developer.tomtom.com/platform/documentation/faqs)
- [Termos do Developer Portal (não lidos, ver item 5)](https://developer.tomtom.com/terms-and-conditions)
- [EULA de terceiros TomTom, 2019 (limite de 24 h)](https://download.tomtom.com/open/banners/third-party-product-terms-eula-2019-09.pdf)
