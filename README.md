# encontro-sp

Calcula o melhor ponto de encontro entre N pessoas em São Paulo, de carro, considerando o
trânsito em tempo real ("vamos sair agora").

Usa só serviços gratuitos: OpenStreetMap (malha viária), Nominatim (geocodificação) e, se
houver chave, o free tier da TomTom (trânsito ao vivo + geocodificação). Sem chave, roda em
modo degradado, só com o grafo local. Detalhes de projeto em
[docs/ARQUITETURA.md](docs/ARQUITETURA.md).

## Instalação

```bash
uv sync                      # Python 3.12 + dependências
cp .env.example .env         # opcional: coloque sua TOMTOM_API_KEY
uv run encontro baixar-grafo # baixa a malha de SP uma vez (~7 min, ~7 MB em cache/)
```

A chave gratuita da TomTom é criada em <https://developer.tomtom.com>.

## Uso

```bash
uv run encontro buscar exemplo.yaml                       # cidade, mais justo, top 5
uv run encontro buscar exemplo.yaml -o casa -c total -k 3 # na casa de alguém, menor total
uv run encontro buscar exemplo.yaml -c limite -l 30       # ninguém passa de 30 min
uv run encontro buscar -p "Ana=Av. Paulista, 1578" -p "Beto=-23.6,-46.7" --metrica distancia
uv run encontro buscar exemplo.yaml --json                # saída em JSON
uv run encontro cota                                      # uso da cota TomTom hoje
uv run encontro criterios                                 # lista os critérios
```

Formato do arquivo (endereço livre ou `lat, lon`):

```yaml
pessoas:
  - nome: Ana
    endereco: Avenida Paulista, 1578
  - nome: Bruno
    endereco: Rua Augusta, 2690
```

| Opção | Valores |
|---|---|
| `-o/--objetivo` | `cidade` (qualquer ponto, padrão) · `casa` (casa de alguém) |
| `-c/--criterio` | `justo` (minimiza o maior) · `total` (menor soma) · `igualitario` (menor diferença) · `limite` (ninguém passa de X, vence o menor total) |
| `-l/--limite` | minutos (tempo) ou km (distância). Obrigatório em `limite`; teto opcional em `igualitario` |
| `--metrica` | `tempo` (padrão) · `distancia` |
| `-k` | quantos resultados |
| `--m` | candidatos do pré-filtro enviados à TomTom (padrão: o que cabe em 1 requisição, até 30) |
| `--offline` | ignora a TomTom |

Cada resultado mostra coordenadas (ou o anfitrião), tempo e distância de cada pessoa, se o
valor veio do trânsito ao vivo ou da estimativa local, e links do Google Maps.

## Testes

```bash
uv run pytest
```

Os testes usam um grafo sintético e clientes HTTP simulados, sem acesso à rede.
