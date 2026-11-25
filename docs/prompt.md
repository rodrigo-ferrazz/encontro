Quero construir uma ferramenta em Python que calcula o melhor ponto de encontro entre
N pessoas em São Paulo, de carro, considerando o trânsito em tempo real ("vamos sair agora").

Contexto: me inspirei num vídeo que mostra amigos em pontos diferentes de SP, com o caminho
mínimo "inundando" as ruas a partir de cada um até achar o ponto ideal. Não preciso da
animação, só do cálculo.

RESTRIÇÃO: usar apenas serviços gratuitos (free tier). Sem chave de API, a ferramenta deve
funcionar em modo degradado, só com o grafo local.

ENTRADA
- N pessoas, cada uma com nome e endereço (N variável).
- Objetivo:
  1. Encontrar na casa de alguém (candidatos = os N endereços)
  2. Encontrar em qualquer ponto da cidade (candidatos = nós do grafo)
- Critério (operando sobre um custo genérico, em tempo por padrão e distância opcional):
  1. Mais justo para todos: minimizar o maior deslocamento
  2. Menor custo total somado do grupo
  3. Mais igualitário: minimizar a diferença entre o maior e o menor deslocamento
  4. Limite máximo: ninguém passa de X; entre os válidos vence o de menor total
- K: quantidade de resultados a devolver.

ARQUITETURA PROPOSTA (critique e ajuste se necessário)
- Malha: OpenStreetMap via OSMnx (network_type="drive", respeitando mão única), com o grafo
  cacheado em disco. Pesos locais = tempo estimado a partir de maxspeed e tipo de via.
- Pipeline em dois estágios:
  1. Pré-filtro local: N Dijkstras (scipy.sparse.csgraph ou igraph) a partir de cada pessoa,
     aplicando o critério para obter os top-M candidatos (ex.: M=30). No objetivo 1, pular
     este estágio.
  2. Refinamento com trânsito ao vivo: uma matriz N×M na TomTom Matrix Routing (free tier,
     traffic=live, saída = agora), reaplicando o critério para gerar o top-K final.
- Abstrações:
  - CostProvider (LocalOSM, TomTom, HERE como alternativa) que devolve uma matriz de custos
    pessoas × candidatos (tempo e distância).
  - Criterion (strategy/registry) para adicionar critérios novos sem mexer no resto.
  - Geocoder (TomTom Search como principal, Nominatim como fallback respeitando 1 req/s),
    com cache em disco.
- Controle de cota: contar as chamadas à API, cachear respostas por um curto período e
  avisar quando estiver perto do limite diário.

SAÍDA
- Top K pontos ranqueados, com coordenadas (ou o nome da pessoa anfitriã, no objetivo 1),
  tempo e distância de cada pessoa até lá, indicação de se o valor veio com trânsito ao vivo
  ou de estimativa local, e link do Google Maps (rota de cada pessoa até o ponto).

PONTOS A CONSIDERAR
- Performance: o grafo de SP é grande (cache, maior componente fortemente conexo,
  bibliotecas rápidas).
- Snap de endereços a nós do grafo: cuidado com nós em vias expressas/marginais, que são
  inacessíveis como ponto de encontro (talvez filtrar por tipo de via no objetivo 2).
- Tratamento de falhas da API: timeout ou cota estourada → cair para o resultado local.