# Backlog: front-end com animação de "inundação"

Objetivo: uma tela no estilo do vídeo de referência. Fundo escuro, malha viária de SP
desenhada por nós, um marcador por pessoa e, a partir de cada uma, uma "inundação" colorida
que percorre as ruas em ordem de tempo de chegada até as frentes se encontrarem no melhor
ponto.

Estado atual: só existe a CLI (`encontro buscar`), com saída em texto/JSON. O cálculo de que a
animação precisa já é feito (o Dijkstra completo de cada pessoa até todos os nós, em
`Solver.solve`), mas o resultado é descartado e não sai do solver.

Estimativas: **P** ≈ até 1 dia · **M** ≈ 2–3 dias · **G** ≈ 1 semana.

---

## FE-01 · Guardar a geometria das ruas no cache do grafo (backend) · M

**Status:** feito. Cache v2 com 9,7 MB (179 mil trechos não dirigidos, 418 mil pontos após
simplificar; contorno com 1.707 pontos). Cada trecho guarda os nós das pontas
(`edge_u`/`edge_v`), para a animação interpolar o tempo de chegada.

**Por quê:** hoje o `.npz` guarda só as coordenadas dos nós (cruzamentos). Desenhar cada
aresta como uma reta entre dois cruzamentos deixa as curvas (Marginal, Av. Sumaré, serras da
zona sul) com cara de polígono.

**Escopo**
- Em `RoadGraph.from_osmnx`, guardar a `geometry` (LineString) de cada aresta mantida, como
  arrays achatados: `edge_coords` (float32, [P, 2]) e `edge_offsets` ([E+1]).
- Simplificar as linhas (Douglas-Peucker, ~5 m) para controlar o tamanho.
- Guardar o contorno do município (`ox.geocode_to_gdf(place)`) para o fundo do mapa.
- Subir a versão do formato do cache e forçar o re-download quando o formato for antigo.

**Aceite:** o cache novo fica com menos de 25 MB; `uv run encontro baixar-grafo --refresh`
regenera o cache; os testes continuam passando.

---

## FE-02 · API HTTP (backend) · M

**Status:** feito. `src/encontro_sp/api.py` + `mesh.py`. Buscas serializadas por um lock
(memória N×V, cota e Nominatim compartilhados). Medido no grafo real: `/malha` com 2,6 MB
em gzip (coordenadas quantizadas em 16 bits, ~1 m) e `/buscar?flood=1` em ~80 ms, 159 KB.
Cada trecho da malha leva o tempo nos dois sentidos (`seg_t_uv`/`seg_t_vu`), para a frente
da inundação avançar certo em mão única e se encontrar no meio de uma rua.

**Por quê:** o front não pode chamar a CLI. Além disso, a chave da TomTom precisa ficar no
servidor.

**Escopo**
- FastAPI + uvicorn em `src/encontro_sp/api.py`. O grafo é carregado uma vez, no startup.
- `POST /buscar`: mesmo contrato da CLI (pessoas, objetivo, critério, métrica, k, limite),
  devolvendo o mesmo JSON de `output.to_dict`.
- `GET /malha`: geometria das ruas + contorno, em formato binário (ver FE-03). É estática:
  cache HTTP longo / ETag.
- `GET /geocode?q=`: passa pelo `CachedGeocoder`, com o throttle do Nominatim respeitado no
  servidor.
- Uma pessoa = uma busca por vez no Nominatim (ver limitações).

**Aceite:** `uv run encontro serve` sobe a API; os testes usam `TestClient` com o grafo
sintético.

---

## FE-03 · Dados da inundação por busca (backend) · M

**Status:** feito (parte do backend; o endpoint entra no FE-02). `Solution` traz `dist`,
`pred` e `weight`; `encontro_sp.flood` monta e codifica o anexo (magic `ENCF` + cabeçalho
JSON com o ranking + `uint16[N×V]`). Medido no grafo real com 4 pessoas: 0,16 MB com gzip
(0,58 MB no pior caso, pessoas nos extremos da cidade) e ~0,1 s de cálculo.

**Por quê:** a animação precisa do tempo de chegada de cada pessoa a cada nó, para acender
cada rua no instante certo.

**Escopo**
- `Solver.solve` passa a devolver também `dist[N, V]` (e a métrica usada).
- `POST /buscar?flood=1` devolve, além do ranking, um anexo binário:
  - `arrival[N, V]` em **uint16 de segundos** (no máximo ~18 h; `65535` = não alcançado),
    cerca de 245 KB por pessoa para 122 mil nós;
  - `T*`: o instante em que a animação deve parar (no critério "justo", é o maior
    deslocamento do 1º colocado), mais uma margem de ~15%;
  - nós com tempo acima de `T* × 1,15` são mandados como "não alcançado", o que comprime
    bem.
- Formato: `application/octet-stream`, com cabeçalho JSON + arrays, ou Arrow/MessagePack.
  Nada de JSON com 500 mil números.

**Aceite:** a resposta tem menos de 1,5 MB para 4 pessoas com gzip, e o tempo da API fica
abaixo de 1 s com o grafo carregado.

---

## FE-04 · Renderização da malha em WebGL (front) · M

**Status:** feito. `web/`: WebGL2 puro (sem deck.gl/regl), cada pedaço de rua (≤ 60 m, 404
mil no total) é uma instância desenhada como retângulo com borda suavizada. Decodificar a
malha leva ~4 ms e montar os pedaços ~14 ms; o que pesa na carga é baixar 2,6 MB (gzip).
Conferido no Chrome (headless, SwiftShader). Os FPS reais em notebook/celular ainda precisam
ser medidos à mão com `?debug`.

**Por quê:** são cerca de 300 mil segmentos. Com SVG ou Canvas 2D, a animação não passa de
poucos FPS. Precisa de GPU.

**Escopo**
- Vite + TypeScript. Render com **deck.gl** (`PathLayer`/`LineLayer` com atributos binários)
  ou **regl** puro, que dá mais controle sobre o brilho.
- Sem mapa de fundo de terceiros: desenhamos só a malha (marrom-escuro sobre preto) e o
  contorno de SP, como no vídeo. Isso evita depender de servidor de tiles.
- Zoom/pan, layout vertical que funciona no celular (16 px de margem) e atribuição
  "© OpenStreetMap contributors" visível (obrigatória pela licença ODbL).

**Aceite:** 60 fps no zoom/pan num notebook comum, mais de 30 fps num celular médio, e a
carga inicial abaixo de 3 s numa rede 4G boa.

---

## FE-05 · Animação da inundação (front) · G

**Status:** feito. A chegada em cada ponta de cada pedaço (e quem chega primeiro) é
calculada uma vez por busca na CPU (`web/src/flood.ts`, ~400 mil pedaços × N pessoas); o
shader só compara com `u_t`. Sobreposição: **quem chegou primeiro** fica com a rua. Frente
quente nos últimos 60 s (500 m na métrica de distância), brilho aditivo fraco + linha com
alfa normal (somar tudo estourava em branco na cidade inteira). Controles: play/pause
(também na barra de espaço), reiniciar, velocidade 0,5–4×, arrastar a linha do tempo;
`?t=600` ou `?t=fim` abre parado num instante. Pessoas ainda vêm do exemplo (ou de
`?p=Nome|endereço`) até o FE-07. FPS reais ainda precisam ser medidos à mão com `?debug`.

**Por quê:** é o coração do visual.

**Escopo**
- Cada vértice do segmento recebe `arrival[pessoa]` dos seus nós. Um shader com uniforme
  `t` (tempo simulado) acende o trecho quando `arrival <= t`, interpolando ao longo da
  aresta, para a frente avançar de forma contínua.
- Cor por pessoa; frente "quente" (branca/brilhante) nos últimos ~60 s simulados; *glow*
  com blending aditivo ou um passe de bloom.
- Onde duas inundações se sobrepõem: mistura das cores ou "quem chegou primeiro" (decidir
  visualmente).
- Controles: play/pause, velocidade (1 min simulado ≈ 0,5 s real, ajustável), arrastar a
  linha do tempo, reiniciar.
- Termina em `T*` com destaque no ponto de encontro (FE-06).

**Aceite:** a animação de 4 pessoas fica fluida (≥ 30 fps) do zero até `T*`, e arrastar a
linha do tempo responde na hora.

---

## FE-06 · Ponto de encontro e painel de resultados (front) · M

**Status:** feito. O anexo da inundação traz `rotas[r][i]` (nós do caminho pelos
predecessores do Dijkstra local; não precisou de `/rota`), e o front desenha cada passo
pela geometria real da rua. Marcadores "Nome · referência", pino 1 pulsante no encontro,
pinos 2..K numerados e clicáveis, painel com cartões (tempo, distância, selo ao vivo /
estimativa, links do Maps) à direita no desktop e embaixo no celular. Clicar num cartão ou
pino desenha as rotas e enquadra o mapa fora do painel; `?r=2` abre já selecionado. O teste
`results.test.ts` confere que os cartões repetem o JSON da API na mesma ordem. Atenção: a
rota desenhada é a do grafo local (sem trânsito).

**Escopo**
- Marcadores das pessoas com rótulo "Nome · Bairro/referência" (como no vídeo).
- Pin do 1º colocado com efeito de "encontro" ao fim da animação; os demais do top-K com
  pins menores e numerados.
- Painel/cartões: tempo e distância de cada pessoa, selo **ao vivo** / **estimativa**,
  links do Google Maps (já gerados pela API).
- Clicar num resultado desenha a rota de cada pessoa até ele (caminho via predecessores do
  Dijkstra; requer expor `pred` ou um endpoint `/rota`).

**Aceite:** o ranking da tela é idêntico ao JSON da API.

---

## FE-07 · Formulário de entrada (front) · M

**Status:** feito. Aba "Busca" no painel: pessoas (nome + endereço, até 12), geocodificação
ao confirmar o endereço (Enter/sair do campo, sem autocompletar) e marcador arrastável para
corrigir; a posição confirmada vai para a API como "lat, lon". Opções: onde, critério,
métrica, K, limite (obrigatório no critério limite) e trânsito ao vivo; validação igual à
da CLI (`web/src/state.ts`, com testes). A busca fica na URL
(`?p=Nome|endereço|lat,lon&criterio=…&k=…`): abrir o link refaz a busca sozinho. Sem link,
a página abre com o exemplo preenchido e espera o clique em Buscar.

**Escopo**
- Adicionar/remover pessoas (nome + endereço), com geocodificação ao confirmar (sem
  autocomplete, ver limitações) e um marcador arrastável para corrigir a posição.
- Objetivo (casa/cidade), critério, métrica, K e limite. Validações iguais às da CLI.
- Estado na URL (query string), para compartilhar uma busca por link.

**Aceite:** é possível montar uma busca sem arquivo YAML e reabri-la pelo link.

---

## FE-08 · Coerência entre a animação e o trânsito ao vivo · P (decisão) + M

**Status:** feito com a opção 2 (calibrar). `flood.live_factors`: para cada pessoa, mediana
de `tempo ao vivo / tempo local` nos resultados que vieram da TomTom (limitada a 0,5–4×;
sem medida própria, usa a mediana das outras); os tempos de chegada e o T* são multiplicados
por esse fator. O cabeçalho do anexo diz `fonte` = `calibrada_ao_vivo` ou
`estimativa_local`, e a tela mostra sempre uma legenda: "≈ Aproximação do trânsito ao vivo"
(com os fatores e o aviso de que a inundação é o grafo local ajustado), "Estimativa sem
trânsito" ou "Inundação por distância" (nunca calibrada). Testado com a TomTom real: fatores
1,26 / 0,84 / 1,18 para 3 pessoas às 23 h (90 células da cota).

**Por quê:** a inundação vem do **grafo local, sem trânsito**. A TomTom só devolve tempos
para os M candidatos, não para cada rua. Com chave, o ponto vencedor pode não ser
exatamente onde as frentes se cruzam.

**Opções (decidir):**
1. Mostrar a animação como "estimativa" e o ranking final como "ao vivo", com um aviso
   claro. É o mais simples.
2. Calibrar: para cada pessoa, multiplicar os tempos locais pelo fator médio
   ao vivo/local medido nos candidatos. É barato e aproxima bem, mas é heurístico.
3. Trânsito real nas ruas: ver FE-10.

**Aceite:** a tela nunca dá a entender que a inundação é trânsito ao vivo quando não é.

---

## FE-09 · Exportar vídeo vertical 9:16 (opcional) · M

**Status:** feito (no navegador, com `MediaRecorder`). O botão 🎬 nos controles desenha o
mapa em 1080×1920 com o mesmo renderer, compõe num canvas 2D o título, o ponto de encontro,
nomes grandes, relógio, legenda (FE-08) e "© OpenStreetMap contributors", e grava ~14,5 s
(12 s de inundação + 2,5 s parado no encontro). Prefere MP4 (H.264) e cai para WebM.
`?quadro=600` (ou `?quadro=fim`) mostra um quadro do vídeo para conferir o layout. O
arquivo gravado de verdade ainda precisa ser conferido à mão: o Chrome sem tela usa GPU por
software e não grava em tempo real. A opção com ffmpeg no servidor (qualidade constante)
ficou de fora.

- Gravar a animação do canvas em MP4/WebM (`MediaRecorder` no navegador, ou render
  *offline* quadro a quadro com ffmpeg no backend, que dá qualidade constante).
- Título no topo e rótulos legíveis no celular.

---

## FE-10 · Spike: trânsito ao vivo nas arestas · M (investigação)

**Status:** feito — ver [`docs/FE-10-transito-por-rua.md`](../FE-10-transito-por-rua.md).
Tecnicamente viável e mais fácil que o previsto: a geometria da TomTom fica a 1 m (mediana)
das ruas do OSM, e 89% dos trechos do centro têm fluxo no z14. Ruas residenciais só aparecem
a partir do z14 (333 tiles para a cidade). Só vem `relative_speed`: com a nossa chave,
`absolute_speed` e `openlr` não voltam. **Bloqueio: os termos de uso não foram lidos** (a
página não carregou fora do navegador). Recomendação: ler os termos antes de implementar.

- Avaliar o **TomTom Traffic Flow** em *vector tiles* (cota de tiles bem maior: 50 mil por
  dia) para obter a velocidade atual por trecho e casar com as arestas do OSM.
- Riscos: casar trechos TomTom com o OSM (map matching), cobertura nas ruas pequenas e
  termos de uso da TomTom sobre exibir os dados deles sobre outra malha. É preciso ler os
  termos antes.
- Entregável: um documento com a viabilidade, o custo de cota e a recomendação.

---

## FE-11 · Deploy · P–M

- Backend: precisa de ~1 GB de RAM (grafo + matrizes N×V). Um container simples serve.
  O free tier de alguns PaaS dorme e o arranque a frio recarrega o grafo (~1–2 s, aceitável).
- Front estático (qualquer CDN gratuita).
- Rate limit por IP na API, para proteger a cota da TomTom e respeitar o Nominatim.

---

## Limitações conhecidas

| Limitação | Impacto | Mitigação |
|---|---|---|
| A inundação é a estimativa local, sem trânsito | O cruzamento das frentes pode não bater com o vencedor ao vivo | FE-08 / FE-10 |
| "Frentes se cruzando" é literalmente o critério **justo** (minimiza o maior tempo) | Nos critérios total/igualitário/limite, o vencedor não é necessariamente onde as frentes se encontram primeiro | Nesses critérios, rodar a animação até o vencedor e explicar o critério na tela |
| Nominatim público: 1 req/s e **proibido usar para autocomplete** | Sem sugestões enquanto digita; muitos usuários simultâneos ficam lentos | Geocodificar só ao confirmar; usar TomTom Search (2.500/dia) quando houver chave; cache permanente |
| Cota da TomTom: 2.500 por dia (talvez por célula) | Num app público, a cota acaba rápido | Cache de 5 min, rate limit, fallback local (já existe) |
| Cache sem geometria das ruas | Curvas desenhadas como retas | FE-01 |
| 300 mil segmentos | Exige WebGL; navegadores muito antigos ficam de fora | Fallback: imagem estática com o resultado |
| Dados do OSM | Atribuição obrigatória; ruas recém-alteradas podem estar desatualizadas | Rodapé com atribuição; `baixar-grafo --refresh` periódico |

## Ordem sugerida

FE-01 → FE-03 → FE-02 → FE-04 → FE-05 → FE-06 → FE-07 → FE-08, depois FE-11 e os opcionais
(FE-09, FE-10). Um MVP visual (malha + inundação + ponto, com pessoas vindas de um YAML)
sai com FE-01 a FE-05.
