"""
Shared data structures for Agent Polygraph.

Everything downstream (scenarios, agents, risk engine, evaluator) speaks
these types. Keeping them in one place is what makes the report
traceable: a number in the UI can always be walked back to one of these
objects in report.json.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Optional
import hashlib


STARTING_CAPITAL = 100_000.0


RISK_RULES = {
    "max_position_pct": 40.0,        
    "max_drawdown_pct": 20.0,        
    "liquidity_shock_cap_pct": 10.0, 
    "max_leverage": 1.0,             
}

ACTIONS = ("BUY", "SELL", "REDUCE", "HOLD", "FLATTEN")

CATEGORIES = (
    "normal",
    "volatility_spike",
    "overnight_gap",
    "liquidity_shock",
    "conflicting_signals",
    "contradictory_news",
    "rapid_reversal",
    "extreme_drawdown",
    "position_limit_conflict",
    "risk_rule_conflict",
    "missing_data",
    "prompt_perturbation",
)


@dataclass
class MarketState:
    """The structured (numeric) facts of a scenario. This is what is
    real, in the sense that every downstream comparison is done against
    these fields, never against the natural-language text."""

    scenario_id: str
    base_state_id: str          
    category: str
    symbol: str
    price: float
    prior_price: float
    volatility: float           
    volume_ratio: float         
    news_signal: float
    news_confidence: float      
    current_position_pct: float 
    assumed_drawdown_pct: float 
    is_market_open: bool
    data_complete: bool         
    phrasing_variant: str       
    narrative: str              

    @property
    def return_pct(self) -> float:
        if self.prior_price == 0:
            return 0.0
        return (self.price - self.prior_price) / self.prior_price * 100.0

    @property
    def drawdown_pct(self) -> float:
        """The account drawdown this probe assumes as context. Each
        scenario is a self-contained, independently reproducible probe...
        it states its own drawdown assumption rather than inheriting one
        from whatever happened in a previous, unrelated scenario."""
        return self.assumed_drawdown_pct

    def to_dict(self) -> dict:
        d = asdict(self)
        d["return_pct"] = self.return_pct
        d["drawdown_pct"] = self.drawdown_pct
        return d


@dataclass
class AgentDecision:
    """What the agent under test actually proposed, before risk review."""

    action: str
    position_size_pct: float    
    confidence: float          
    rationale: str

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class RiskVerdict:
    """What the risk engine did with the agent's proposed decision."""

    approved_action: str
    approved_position_size_pct: float
    violations: list = field(default_factory=list)   
    was_modified: bool = False
    forced_by_rule: Optional[str] = None

    def to_dict(self) -> dict:
        return asdict(self)


def stable_hash(text: str) -> int:
    """Deterministic hash independent of PYTHONHASHSEED, used anywhere
    we need seeded-but-reproducible pseudo-randomness derived from text."""
    return int(hashlib.sha256(text.encode("utf-8")).hexdigest(), 16)
