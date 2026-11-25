# Arquitetura

## Stack

| Item | Escolha | Motivo |
|---|---|---|
| Python | 3.12 (via `uv`) | O Python do sistema é 3.9; OSMnx 2.x e as dependências atuais rodam melhor em versões novas |
| Download do grafo | OSMnx | Baixa a malha `drive` e já trata `oneway` |
| Caminho mínimo | `scipy.sparse.csgraph.dijkstra` sobre uma CSR | Usa C por baixo, roda N fontes de uma vez e não precisa de dependência extra; igraph fica como plano B |
| HTTP | `httpx` | Timeout e retry simples |
| CLI | `typer` | Entrada por arquivo YAML/JSON ou argumentos |
| Testes | `pytest` | Com grafo sintético pequeno, sem rede |

## Fluxo

```
endereços ──► Geocoder ──► (lat, lon) ──► snap no nó mais próximo (filtrando vias expressas)
                                              │
                         ┌────────────────────┴───────────────────┐
              objetivo 2 │                                         │ objetivo 1
                         ▼                                         │
   Estágio 1: LocalOSMProvider                                     │
   N Dijkstras → matriz N × |V| (tempo estimado)                   │
   Criterion.score → top-M candidatos (M≈30)                       │
                         │                                         │
                         └──────────────► candidatos ◄─────────────┘
                                              │
   Estágio 2: TomTomProvider (traffic=live, sair agora)
   matriz N × M → Criterion.score → top-K
   (falha ou cota estourada → usa a matriz local, marcada como "estimativa")
                                              │
                                              ▼
                              Formatter (tabela + links Google Maps)
```

## Módulos

```
src/encontro_sp/
  graph.py        # download, limpeza (maior SCC), pesos, CSR, geometria das ruas/contorno, cache .npz versionado
  geocode.py      # Geocoder: TomTomGeocoder, NominatimGeocoder (1 req/s), cache em disco
  providers/
    base.py       # CostProvider.matrix(origins, candidates) -> CostMatrix(time_s, dist_m, source)
    local.py      # Dijkstra no grafo
    tomtom.py     # Matrix Routing com traffic=live
  criteria.py     # Criterion + registry
  solver.py       # orquestra estágio 1 → estágio 2 → fallback
  quota.py        # contador diário de chamadas (arquivo local)
  output.py       # ranking, links do Maps
  cli.py
```

## Decisões principais

1. **Pesos locais.** O tempo vem do comprimento da via dividido pela velocidade. A velocidade é
   o `maxspeed` do OSM ou, na falta dele, um padrão por `highway` (via `ox.add_edge_speeds`),
   multiplicado por um fator urbano (~0.6) para não superestimar a velocidade. Esse valor só
   serve para o pré-filtro, porque o número final vem da TomTom.
2. **Direção do Dijkstra.** Cada pessoa vai até o ponto, então o cálculo parte de cada pessoa
   no grafo original. A mão única é respeitada naturalmente.
3. **Grafo.** Fica só o maior componente fortemente conexo, para garantir que todo candidato
   seja alcançável por todos. O cache é a CSR em `.npz` mais as coordenadas dos nós. O
   download do OSM acontece uma vez só, com refresh manual.
4. **Candidatos no objetivo 2.** Ficam fora os nós em `motorway`, `trunk` e respectivos
   `_link`, para o ponto não cair na Marginal.
5. **Critérios como estratégia.** Cada critério implementa
   `score(costs: ndarray[N, C]) -> ndarray[C]`, onde menor é melhor e `inf` é inválido, e se
   registra com `@register("minimax")`. Isso é vetorizado em NumPy e roda sobre centenas de
   milhares de candidatos sem custo perceptível. O critério 4 recebe `limit` e devolve `inf`
   quando alguém passa do limite.
6. **Critério 4 no pré-filtro.** Como o tempo local é só estimativa, o pré-filtro aplica o
   limite com folga (ex.: 1.3×X) para não descartar candidatos que o trânsito real tornaria
   válidos, e o filtro exato acontece no estágio 2.
7. **Diversidade no top-M.** Os 30 melhores nós tendem a estar no mesmo quarteirão. Por isso,
   aplicar uma supressão espacial que mantém só candidatos a pelo menos ~400 m uns dos outros.
   Sem isso, o top-K vira 5 esquinas vizinhas.
8. **Cota.** Cada busca faz ~1 a 2 chamadas de matriz (N×M ≤ limite síncrono da TomTom, que
   precisa ser confirmado). As chamadas ficam registradas por dia em `cache/quota.json`, com
   aviso a 80% do limite. O geocoding usa cache permanente.
9. **Configuração.** `TOMTOM_API_KEY` vem do `.env`. Sem a chave, a ferramenta fica só local e
   avisa isso na saída.

## Fora do escopo (por enquanto)

- Animação ou visualização.
- Trânsito previsto para horários futuros.
- Transporte público e outros modos.

## Ajustes feitos na implementação

1. **Limite de 200 células.** No plano Freemium, a Matrix Routing v2 síncrona aceita 200
   células por requisição (2.500 só na assíncrona). Por isso o M padrão é
   `min(30, 200 // N)`, e com isso uma busca cabe numa requisição só. Se `--m` pedir mais,
   o provider divide a matriz em blocos de até 200 células.
2. **Contagem da cota.** A documentação não deixa claro se a cota diária de 2.500 conta
   requisições ou células. Por padrão, cada célula conta como uma unidade
   (`TOMTOM_COUNT_CELLS=1`), o que dá cerca de 12 buscas de 4 pessoas por dia no pior caso.
   Se o painel da TomTom mostrar que conta por requisição, basta usar `0`. A cota é
   verificada **antes** da chamada, e as respostas ficam em cache por 5 minutos.
3. **Critério igualitário.** A diferença pura escolhe pontos longe de todo mundo (no teste
   real, todos a 23 min contra 17 min do critério justo), porque existem pontos
   "equidistantes" em toda a mediatriz. Para reduzir isso, a diferença é discretizada em
   faixas (2 min / 1 km), o desempate é pelo maior deslocamento, e `--limite` funciona como
   teto opcional.
4. **Folga do limite.** A folga de 1,3× no pré-filtro só vale quando a TomTom vai
   recalcular os tempos. Offline, ela fazia todos os candidatos serem descartados no filtro
   final.
5. **Distância local.** O Dijkstra otimiza a métrica escolhida, e a outra métrica é somada
   ao longo do mesmo caminho (a distância do caminho mais rápido).
6. **Objetivo casa.** O destino enviado à TomTom e ao Google Maps é o endereço geocodificado
   do anfitrião, e não o nó do grafo.
7. **Falhas parciais.** Células sem rota na TomTom recebem a estimativa local e ficam
   marcadas como `estimativa` na saída. Timeout, 403/429 ou cota insuficiente fazem a busca
   inteira cair para o resultado local, com aviso.
8. **Entrada.** A entrada aceita arquivo YAML e também `--pessoa NOME=ENDEREÇO`. O endereço
   pode ser `lat, lon`, e nesse caso não há geocodificação.
9. **HERE.** Não foi implementado. A interface `CostProvider.matrix(origins, candidates)`
   permite adicioná-lo sem mexer no solver.

## Números reais (MacBook, SP inteira)

- Grafo: 122.420 nós, 302.585 arestas e 120.998 candidatos (fora de vias expressas).
  O download leva cerca de 7 min, uma vez só. O cache `.npz` tem 7 MB.
- Busca com 4 pessoas no objetivo cidade: cerca de 0,4 s com o grafo e o geocoding em cache.

## Pendências conhecidas

- O cliente TomTom foi testado só com respostas simuladas, porque ainda não há chave.
  Na primeira execução real, confirmar o formato da resposta de `/routing/matrix/2` e se as
  opções `departAt=now` e `traffic=live` são aceitas.
- Alguns nós de acesso a pontes ou viadutos ainda podem ser candidatos (eles têm uma aresta
  `primary`). Se isso incomodar, filtrar também por grau do nó ou exigir uma via
  `residential`, `tertiary` ou `secondary`.
