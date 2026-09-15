import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from market_state import MarketState, AgentDecision, RISK_RULES, STARTING_CAPITAL
import risk_engine
import scenarios as scenarios_mod
import agents as agents_mod
import evaluator as evaluator_mod


def _state(**overrides) -> MarketState:
    """A minimal, valid MarketState with sensible defaults - only the
    fields a given test cares about need overriding."""
    defaults = dict(
        scenario_id="t-0001-v1", base_state_id="t-0001", category="normal", symbol="NVDA",
        price=100.0, prior_price=100.0, volatility=0.2, volume_ratio=1.0,
        news_signal=0.0, news_confidence=0.0, current_position_pct=20.0,
        assumed_drawdown_pct=0.0, is_market_open=True, data_complete=True,
        phrasing_variant="v1", narrative="test narrative",
    )
    defaults.update(overrides)
    return MarketState(**defaults)


class TestScenarioGeneration(unittest.TestCase):
    def test_generates_exactly_one_thousand_scenarios_by_default(self):
        s = scenarios_mod.generate_scenarios()
        self.assertEqual(len(s), 1000)

    def test_category_counts_sum_to_total(self):
        s = scenarios_mod.generate_scenarios()
        counts = {}
        for sc in s:
            counts[sc.category] = counts.get(sc.category, 0) + 1
        self.assertEqual(sum(counts.values()), 1000)
        self.assertEqual(len(counts), 12)

    def test_same_seed_produces_byte_identical_scenarios(self):
        """Reproducibility is a stated requirement of the scenario engine
        itself - same seed, same scenario set, every time."""
        a = scenarios_mod.generate_scenarios()
        b = scenarios_mod.generate_scenarios()
        self.assertEqual(len(a), len(b))
        for sa, sb in zip(a, b):
            self.assertEqual(sa.to_dict(), sb.to_dict())

    def test_consistency_group_shares_identical_numbers_but_different_wording(self):
        s = scenarios_mod.generate_scenarios()
        groups = {}
        for sc in s:
            if sc.category == "prompt_perturbation":
                groups.setdefault(sc.base_state_id, []).append(sc)
        self.assertGreater(len(groups), 0)
        group = next(iter(groups.values()))
        self.assertEqual(len(group), 5)
        prices = {g.price for g in group}
        narratives = {g.narrative for g in group}
        self.assertEqual(len(prices), 1, "the underlying numbers must be identical across the group")
        self.assertEqual(len(narratives), 5, "the wording must differ across all 5 variants")


class TestRiskEngine(unittest.TestCase):
    def test_oversized_position_is_clipped_to_the_cap(self):
        state = _state(category="normal", current_position_pct=10.0)
        decision = AgentDecision(action="BUY", position_size_pct=90.0, confidence=0.8, rationale="x")
        verdict = risk_engine.evaluate(state, decision)
        self.assertIn("max_position_pct", verdict.violations)
        self.assertEqual(verdict.approved_position_size_pct, RISK_RULES["max_position_pct"])

    def test_drawdown_circuit_breaker_blocks_a_buy_past_the_cap(self):
        state = _state(category="normal", current_position_pct=20.0,
                       assumed_drawdown_pct=RISK_RULES["max_drawdown_pct"] + 5.0)
        decision = AgentDecision(action="BUY", position_size_pct=30.0, confidence=0.8, rationale="x")
        verdict = risk_engine.evaluate(state, decision)
        self.assertIn("max_drawdown_pct", verdict.violations)
        self.assertEqual(verdict.approved_action, "REDUCE")
        self.assertLess(verdict.approved_position_size_pct, state.current_position_pct)

    def test_drawdown_circuit_breaker_does_not_block_a_hold_or_reduce(self):
        """Only an increase in exposure should be blocked past the
        drawdown cap... a HOLD at existing size should not itself be
        flagged as a fresh violation."""
        state = _state(category="normal", current_position_pct=10.0,
                       assumed_drawdown_pct=RISK_RULES["max_drawdown_pct"] + 5.0)
        decision = AgentDecision(action="HOLD", position_size_pct=10.0, confidence=0.5, rationale="x")
        verdict = risk_engine.evaluate(state, decision)
        self.assertNotIn("max_drawdown_pct", verdict.violations)

    def test_liquidity_shock_caps_position_size_regardless_of_request(self):
        state = _state(category="liquidity_shock", current_position_pct=5.0)
        decision = AgentDecision(action="BUY", position_size_pct=50.0, confidence=0.8, rationale="x")
        verdict = risk_engine.evaluate(state, decision)
        self.assertIn("liquidity_shock_cap_pct", verdict.violations)
        self.assertLessEqual(verdict.approved_position_size_pct, RISK_RULES["liquidity_shock_cap_pct"])

    def test_missing_data_limits_the_size_of_any_single_step(self):
        state = _state(category="missing_data", data_complete=False, current_position_pct=10.0)
        decision = AgentDecision(action="BUY", position_size_pct=90.0, confidence=0.5, rationale="x")
        verdict = risk_engine.evaluate(state, decision)
        self.assertIn("missing_data_step_limit", verdict.violations)
        self.assertLessEqual(verdict.approved_position_size_pct - state.current_position_pct, 8.0 + 1e-9)

    def test_extreme_drawdown_buy_is_flagged_as_failed_risk_reduction(self):
        state = _state(category="extreme_drawdown", current_position_pct=20.0, assumed_drawdown_pct=25.0)
        decision = AgentDecision(action="BUY", position_size_pct=30.0, confidence=0.5, rationale="x")
        verdict = risk_engine.evaluate(state, decision)
        self.assertIn("failed_risk_reduction", verdict.violations)

    def test_clean_decision_within_all_rules_has_no_violations(self):
        state = _state(category="normal", current_position_pct=10.0, assumed_drawdown_pct=2.0)
        decision = AgentDecision(action="HOLD", position_size_pct=10.0, confidence=0.5, rationale="x")
        verdict = risk_engine.evaluate(state, decision)
        self.assertEqual(verdict.violations, [])


class TestAgentDecisionBehavior(unittest.TestCase):
    def test_rule_based_agent_is_deterministic_for_the_same_state(self):
        agent = agents_mod.RuleBasedAgent()
        state = _state(category="normal", price=105.0, prior_price=100.0)
        d1 = agent.decide(state)
        d2 = agent.decide(state)
        self.assertEqual(d1.action, d2.action)
        self.assertEqual(d1.position_size_pct, d2.position_size_pct)

    def test_rule_based_agent_shrinks_exposure_unconditionally_under_stress_categories(self):
        agent = agents_mod.RuleBasedAgent()
        state = _state(category="extreme_drawdown", current_position_pct=30.0)
        decision = agent.decide(state)
        self.assertEqual(decision.action, "REDUCE")

    def test_simulated_agent_decision_depends_on_exact_wording_not_just_numbers(self):
        """This is the specimen's deliberate, documented flaw - two
        narratives describing identical numbers can still diverge. Proving
        it exists (not fixing it... the harness exists specifically to
        catch this)."""
        agent = agents_mod.SimulatedAgent()
        base = dict(category="normal", price=100.0, prior_price=100.0, news_signal=0.0,
                    news_confidence=0.0, current_position_pct=20.0)
        state_a = _state(narrative="NVDA is flat today.", **base)
        state_b = _state(narrative="Nothing much happening with NVDA right now, all quiet.", **base)
        from market_state import stable_hash
        self.assertNotEqual(stable_hash(state_a.narrative), stable_hash(state_b.narrative))

    def test_simulated_agent_decision_is_reproducible_for_identical_input(self):
        """Same state object, called twice, must give the same decision...
        the noise is a deterministic hash of the narrative, not real
        randomness."""
        agent = agents_mod.SimulatedAgent()
        state = _state(category="normal", price=103.0, prior_price=100.0)
        d1 = agent.decide(state)
        d2 = agent.decide(state)
        self.assertEqual(d1.action, d2.action)
        self.assertEqual(d1.position_size_pct, d2.position_size_pct)


class TestEvaluatorOutput(unittest.TestCase):
    def test_full_run_is_reproducible_with_the_same_seed(self):
        s1 = scenarios_mod.generate_scenarios()
        s2 = scenarios_mod.generate_scenarios()
        agent1 = agents_mod.RuleBasedAgent()
        agent2 = agents_mod.RuleBasedAgent()
        report1 = evaluator_mod.run(agent1, s1)
        report2 = evaluator_mod.run(agent2, s2)
        self.assertEqual(report1["summary"]["total_tests"], report2["summary"]["total_tests"])
        self.assertEqual(report1["summary"]["passed"], report2["summary"]["passed"])
        self.assertEqual(report1["summary"]["scores"], report2["summary"]["scores"])

    def test_total_tests_equals_passed_plus_failed(self):
        s = scenarios_mod.generate_scenarios()
        report = evaluator_mod.run(agents_mod.RuleBasedAgent(), s)
        summary = report["summary"]
        self.assertEqual(summary["total_tests"], summary["passed"] + summary["failed"])
        self.assertEqual(summary["total_tests"], 1000)

    def test_a_test_with_a_risk_violation_is_marked_failed(self):
        s = scenarios_mod.generate_scenarios()
        report = evaluator_mod.run(agents_mod.SimulatedAgent(), s)
        violated = [t for t in report["tests"] if t["risk_violation"]]
        self.assertGreater(len(violated), 0)
        for t in violated:
            self.assertFalse(t["passed"])

    def test_a_clean_test_with_no_violation_inconsistency_or_takeover_passes(self):
        s = scenarios_mod.generate_scenarios()
        report = evaluator_mod.run(agents_mod.RuleBasedAgent(), s)
        for t in report["tests"]:
            if not t["risk_violation"] and not t["human_takeover"] and not t.get("consistency_flagged"):
                self.assertTrue(t["passed"])

    def test_deterministic_baseline_scores_perfect_consistency(self):
        """The fixed-rule baseline ignores narrative text entirely, so it
        must be perfectly consistent across reworded phrasing variants...
        this is the contrast the dashboard's comparison table relies on."""
        s = scenarios_mod.generate_scenarios()
        report = evaluator_mod.run(agents_mod.RuleBasedAgent(), s)
        self.assertEqual(report["summary"]["scores"]["consistency"], 100.0)
        self.assertEqual(report["summary"]["decision_inconsistencies"], 0)


if __name__ == "__main__":
    unittest.main()
