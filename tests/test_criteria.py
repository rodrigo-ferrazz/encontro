import numpy as np
import pytest

from encontro_sp import criteria

# 2 pessoas × 4 candidatos
COSTS = np.array(
    [
        [10.0, 20.0, 5.0, 30.0],
        [30.0, 20.0, 40.0, 31.0],
    ]
)


def best(name, costs=COSTS, **params):
    p, s = criteria.get(name).score(costs, **params)
    return list(criteria.rank(p, s))


def test_minimax_prefers_smallest_max():
    assert best("justo")[0] == 1  # max = 20


def test_total_prefers_smallest_sum():
    assert best("total")[0] == 1  # soma 40, empata com 0 (40) → desempate pelo menor max
    assert best("total")[:2] == [1, 0]


def test_equal_prefers_smallest_spread():
    assert best("igualitario")[:2] == [1, 3]  # diferença 0 e 1


def test_equal_resolution_breaks_ties_by_max():
    # Candidatos 1 (20/20) e 3 (30/31) caem na mesma faixa de 5: vence o de menor max.
    assert best("igualitario", resolution=5)[0] == 1
    far = np.array([[100.0, 20.0], [100.0, 21.0]])
    assert best("igualitario", far, resolution=5)[0] == 1
    assert best("igualitario", far)[0] == 0  # sem resolução, o ponto distante venceria


def test_equal_accepts_optional_cap():
    far = np.array([[100.0, 20.0], [100.0, 35.0]])
    assert best("igualitario", far, resolution=5)[0] == 0
    assert best("igualitario", far, resolution=5, limit=40) == [1]


def test_limit_filters_and_uses_total():
    assert best("limite", limit=31) == [1, 0, 3]
    assert best("limite", limit=25) == [1]
    assert best("limite", limit=1) == []


def test_limit_requires_value():
    with pytest.raises(ValueError):
        criteria.get("limite").score(COSTS)


def test_unreachable_is_invalid():
    costs = COSTS.copy()
    costs[0, 1] = np.inf
    assert 1 not in best("justo", costs)
    assert 1 not in best("igualitario", costs)


def test_aliases_and_unknown():
    assert criteria.get("minimax").name == "justo"
    assert criteria.get("4").name == "limite"
    with pytest.raises(KeyError):
        criteria.get("xyz")


def test_register_new_criterion():
    @criteria.register("mediana_teste", "Teste")
    def _median(costs, **_):
        return np.median(costs, axis=0), costs.sum(axis=0)

    try:
        assert best("mediana_teste")[0] in range(4)
    finally:
        criteria.REGISTRY.pop("mediana_teste")
        criteria.ALIASES.pop("mediana_teste")
