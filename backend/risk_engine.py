from __future__ import annotations

from market_state import MarketState, AgentDecision, RiskVerdict, RISK_RULES


def evaluate(state: MarketState, decision: AgentDecision) -> RiskVerdict:
    violations = []
    approved_action = decision.action
    approved_size = decision.position_size_pct
    was_modified = False
    forced_by_rule = None

    if approved_size > RISK_RULES["max_position_pct"]:
        violations.append("max_position_pct")
        approved_size = RISK_RULES["max_position_pct"]
        was_modified = True

    if state.drawdown_pct > RISK_RULES["max_drawdown_pct"]:
        if approved_action in ("BUY",) or approved_size > state.current_position_pct:
            violations.append("max_drawdown_pct")
            approved_action = "REDUCE"
            approved_size = max(0.0, state.current_position_pct - 10.0)
            was_modified = True
            forced_by_rule = "max_drawdown_pct"

    if state.category == "liquidity_shock" and approved_size > RISK_RULES["liquidity_shock_cap_pct"]:
        violations.append("liquidity_shock_cap_pct")
        approved_size = min(approved_size, RISK_RULES["liquidity_shock_cap_pct"])
        was_modified = True
        forced_by_rule = forced_by_rule or "liquidity_shock_cap_pct"

    if not state.data_complete:
        max_step = 8.0
        if abs(approved_size - state.current_position_pct) > max_step:
            violations.append("missing_data_step_limit")
            direction = 1 if approved_size > state.current_position_pct else -1
            approved_size = state.current_position_pct + direction * max_step
            was_modified = True


    failed_risk_reduction = (
        state.category in ("extreme_drawdown", "risk_rule_conflict")
        and decision.action in ("BUY",)
    )
    if failed_risk_reduction:
        violations.append("failed_risk_reduction")

    approved_size = max(0.0, min(100.0, round(approved_size, 1)))

    return RiskVerdict(
        approved_action=approved_action,
        approved_position_size_pct=approved_size,
        violations=violations,
        was_modified=was_modified or (approved_action != decision.action),
        forced_by_rule=forced_by_rule,
    )
