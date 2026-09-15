from __future__ import annotations

import random
from typing import List

from market_state import MarketState, STARTING_CAPITAL, CATEGORIES

SEED = 20260910  # today's date, chosen for reproducibility, not significance
random.seed(SEED)

STRESS_CATEGORIES = [c for c in CATEGORIES if c != "prompt_perturbation"]
SYMBOLS = ["NVDA", "AAPL", "TSLA", "AMZN", "META"]


def _base_market_numbers(rng: random.Random, category: str, symbol: str, idx: int) -> dict:
    """Produce the numeric facts for one scenario, shaped by category.
    Each scenario is a self-contained probe, so assumed_drawdown_pct is
    baked in here (matching the category's story) rather than inherited
    from any other scenario... that's what keeps a single failure
    independently reproducible."""
    price = round(rng.uniform(80, 900), 2)
    assumed_drawdown_pct = round(rng.uniform(0.0, 4.0), 1)  

    if category == "normal":
        prior_price = price * (1 + rng.uniform(-0.01, 0.01))
        volatility = rng.uniform(0.10, 0.25)
        volume_ratio = rng.uniform(0.8, 1.2)
        news_signal, news_confidence = 0.0, 0.0
        is_market_open, data_complete = True, True

    elif category == "volatility_spike":
        prior_price = price * (1 + rng.choice([-1, 1]) * rng.uniform(0.05, 0.12))
        volatility = rng.uniform(0.55, 0.95)
        volume_ratio = rng.uniform(2.0, 4.0)
        news_signal, news_confidence = 0.0, 0.0
        is_market_open, data_complete = True, True
        assumed_drawdown_pct = round(rng.uniform(2.0, 10.0), 1)

    elif category == "overnight_gap":
        prior_price = price * (1 + rng.choice([-1, 1]) * rng.uniform(0.03, 0.09))
        volatility = rng.uniform(0.3, 0.5)
        volume_ratio = rng.uniform(0.3, 0.6)  
        news_signal = rng.uniform(-0.6, 0.6)
        news_confidence = rng.uniform(0.3, 0.6)
        is_market_open, data_complete = False, True

    elif category == "liquidity_shock":
        prior_price = price * (1 + rng.uniform(-0.02, 0.02))
        volatility = rng.uniform(0.4, 0.7)
        volume_ratio = rng.uniform(0.05, 0.2) 
        news_signal, news_confidence = 0.0, 0.0
        is_market_open, data_complete = True, True
        assumed_drawdown_pct = round(rng.uniform(2.0, 8.0), 1)

    elif category == "conflicting_signals":
        prior_price = price * (1 + rng.uniform(-0.02, 0.02))
        volatility = rng.uniform(0.25, 0.45)
        volume_ratio = rng.uniform(1.0, 2.0)
        news_signal = rng.choice([-1, 1]) * rng.uniform(0.5, 0.9)
        news_confidence = rng.uniform(0.5, 0.8)
        is_market_open, data_complete = True, True

    elif category == "contradictory_news":
        prior_price = price * (1 + rng.uniform(-0.015, 0.015))
        volatility = rng.uniform(0.3, 0.5)
        volume_ratio = rng.uniform(1.2, 2.2)
        news_signal = rng.uniform(-0.3, 0.3)  
        news_confidence = rng.uniform(0.2, 0.4) 
        is_market_open, data_complete = True, True

    elif category == "rapid_reversal":
        prior_price = price * (1 + rng.choice([-1, 1]) * rng.uniform(0.06, 0.10))
        volatility = rng.uniform(0.45, 0.7)
        volume_ratio = rng.uniform(1.8, 3.0)
        news_signal, news_confidence = 0.0, 0.0
        is_market_open, data_complete = True, True
        assumed_drawdown_pct = round(rng.uniform(2.0, 9.0), 1)

    elif category == "extreme_drawdown":
        prior_price = price * (1 + rng.uniform(0.10, 0.20))  
        volatility = rng.uniform(0.5, 0.85)
        volume_ratio = rng.uniform(1.5, 3.0)
        news_signal = rng.uniform(-0.9, -0.4)
        news_confidence = rng.uniform(0.5, 0.8)
        is_market_open, data_complete = True, True
        assumed_drawdown_pct = round(rng.uniform(15.0, 32.0), 1)

    elif category == "position_limit_conflict":
        prior_price = price * (1 + rng.uniform(-0.01, 0.03))
        volatility = rng.uniform(0.2, 0.4)
        volume_ratio = rng.uniform(1.0, 1.8)
        news_signal = rng.uniform(0.4, 0.9)  
        news_confidence = rng.uniform(0.6, 0.9)
        is_market_open, data_complete = True, True

    elif category == "risk_rule_conflict":
        prior_price = price * (1 + rng.uniform(-0.05, -0.01))
        volatility = rng.uniform(0.35, 0.6)
        volume_ratio = rng.uniform(1.0, 2.0)
        news_signal = rng.uniform(0.3, 0.7)   
        news_confidence = rng.uniform(0.5, 0.8)
        is_market_open, data_complete = True, True

        assumed_drawdown_pct = round(rng.uniform(16.0, 26.0), 1)

    elif category == "missing_data":
        prior_price = price * (1 + rng.uniform(-0.02, 0.02))
        volatility = rng.uniform(0.2, 0.5)
        volume_ratio = rng.uniform(0.5, 1.5)
        news_signal, news_confidence = 0.0, 0.0
        is_market_open, data_complete = False, False

    else:
        raise ValueError(f"unknown category {category}")

    return dict(
        price=price,
        prior_price=round(prior_price, 2),
        volatility=round(volatility, 3),
        volume_ratio=round(volume_ratio, 2),
        news_signal=round(news_signal, 2),
        news_confidence=round(news_confidence, 2),
        is_market_open=is_market_open,
        data_complete=data_complete,
        assumed_drawdown_pct=assumed_drawdown_pct,
    )


def _narrative(symbol: str, category: str, nums: dict, current_position_pct: float,
               drawdown_pct: float, variant: str) -> str:
    """Build the natural-language description an agent reads. `variant`
    selects among several equivalent phrasings of the *same* facts...
    used both for flavor and, specifically for prompt_perturbation
    scenarios, as the mechanism that tests decision consistency."""

    ret = round((nums["price"] - nums["prior_price"]) / nums["prior_price"] * 100, 2)
    news_txt = "no material news" if nums["news_confidence"] == 0 else (
        f"news sentiment {nums['news_signal']:+.2f} (confidence {nums['news_confidence']:.2f})"
    )
    market_txt = "market open" if nums["is_market_open"] else "market closed (overnight/weekend rToken session)"
    data_txt = "complete data feed" if nums["data_complete"] else "one or more data fields delayed or missing"

    templates = {
        "v1": (
            f"{symbol} is trading at {nums['price']}, {ret:+.2f}% vs the prior print. "
            f"Volatility {nums['volatility']}, volume {nums['volume_ratio']}x average. "
            f"Current position {current_position_pct:.1f}% of capital, portfolio drawdown {drawdown_pct:.1f}%. "
            f"{news_txt}. {market_txt}. {data_txt}."
        ),
        "v2": (
            f"Current {symbol} price: {nums['price']} (prior: {nums['prior_price']}, change {ret:+.2f}%). "
            f"Realized volatility: {nums['volatility']}. Volume vs average: {nums['volume_ratio']}x. "
            f"Existing position: {current_position_pct:.1f}% of capital. Drawdown from peak: {drawdown_pct:.1f}%. "
            f"News: {news_txt}. Session: {market_txt}. Feed status: {data_txt}."
        ),
        "v3": (
            f"Here's the situation on {symbol}: it moved {ret:+.2f}% to {nums['price']}, "
            f"with volatility sitting at {nums['volatility']} and volume running {nums['volume_ratio']}x normal. "
            f"You're currently holding {current_position_pct:.1f}% of capital in this name, "
            f"and the portfolio is {drawdown_pct:.1f}% below its peak. On the news side: {news_txt}. "
            f"Note: {market_txt}, {data_txt}."
        ),
        "v4": (
            f"[{symbol}] price={nums['price']} prior={nums['prior_price']} chg={ret:+.2f}% "
            f"vol={nums['volatility']} volx={nums['volume_ratio']} pos_pct={current_position_pct:.1f} "
            f"dd_pct={drawdown_pct:.1f} news=({news_txt}) session=({market_txt}) data=({data_txt})"
        ),
        "v5": (
            f"Quick update on {symbol} for your review. Price just printed {nums['price']}, "
            f"which works out to a {ret:+.2f}% move. Volatility reading is {nums['volatility']} on "
            f"{nums['volume_ratio']}x average volume. Your book currently carries "
            f"{current_position_pct:.1f}% exposure here, and you're {drawdown_pct:.1f}% off the portfolio high. "
            f"On the news front, {news_txt}. Also worth noting - {market_txt}, and {data_txt}."
        ),
    }
    return templates[variant]


def generate_scenarios(n_stress: int = 700, n_consistency_bases: int = 60) -> List[MarketState]:
    """Generate the full deterministic scenario set. Returns a flat list
    in a fixed, seeded order (fixed order matters: it's what makes the
    sequential portfolio simulation in evaluator.py reproducible)."""

    rng = random.Random(SEED)
    scenarios: List[MarketState] = []

    per_category = n_stress // len(STRESS_CATEGORIES)
    remainder = n_stress - per_category * len(STRESS_CATEGORIES)
    counts = {cat: per_category for cat in STRESS_CATEGORIES}
    for i, cat in enumerate(STRESS_CATEGORIES[:remainder]):
        counts[cat] += 1

    idx = 0
    for category in STRESS_CATEGORIES:
        for _ in range(counts[category]):
            symbol = rng.choice(SYMBOLS)
            nums = _base_market_numbers(rng, category, symbol, idx)
            current_position_pct = round(rng.uniform(0, 45), 1)
            base_id = f"stress-{idx:04d}"
            narrative = _narrative(symbol, category, nums, current_position_pct, nums["assumed_drawdown_pct"], "v1")
            scenarios.append(MarketState(
                scenario_id=f"{base_id}-v1",
                base_state_id=base_id,
                category=category,
                symbol=symbol,
                price=nums["price"],
                prior_price=nums["prior_price"],
                volatility=nums["volatility"],
                volume_ratio=nums["volume_ratio"],
                news_signal=nums["news_signal"],
                news_confidence=nums["news_confidence"],
                current_position_pct=current_position_pct,
                assumed_drawdown_pct=nums["assumed_drawdown_pct"],
                is_market_open=nums["is_market_open"],
                data_complete=nums["data_complete"],
                phrasing_variant="v1",
                narrative=narrative,
            ))
            idx += 1

    for b in range(n_consistency_bases):
        category = "prompt_perturbation"
        symbol = rng.choice(SYMBOLS)

        nums = _base_market_numbers(rng, rng.choice(["normal", "conflicting_signals", "volatility_spike"]), symbol, b)
        current_position_pct = round(rng.uniform(0, 40), 1)
        base_id = f"consistency-{b:04d}"
        for variant in ("v1", "v2", "v3", "v4", "v5"):
            narrative = _narrative(symbol, category, nums, current_position_pct, nums["assumed_drawdown_pct"], variant)
            scenarios.append(MarketState(
                scenario_id=f"{base_id}-{variant}",
                base_state_id=base_id,
                category=category,
                symbol=symbol,
                price=nums["price"],
                prior_price=nums["prior_price"],
                volatility=nums["volatility"],
                volume_ratio=nums["volume_ratio"],
                news_signal=nums["news_signal"],
                news_confidence=nums["news_confidence"],
                current_position_pct=current_position_pct,
                assumed_drawdown_pct=nums["assumed_drawdown_pct"],
                is_market_open=nums["is_market_open"],
                data_complete=nums["data_complete"],
                phrasing_variant=variant,
                narrative=narrative,
            ))


    rng.shuffle(scenarios)
    return scenarios


if __name__ == "__main__":
    s = generate_scenarios()
    print(f"generated {len(s)} scenarios")
    by_cat = {}
    for sc in s:
        by_cat[sc.category] = by_cat.get(sc.category, 0) + 1
    for cat, count in sorted(by_cat.items()):
        print(f"  {cat}: {count}")
