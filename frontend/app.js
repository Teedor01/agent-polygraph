const state = {
  reports: {},       
  meta: null,
  real: null,        
  activeAgentKey: "report",
  activeCategory: null,
  activeFilter: "all",
  page: 0,
  pageSize: 25,
  activeTab: "overview",
};

const CATEGORY_LABELS = {
  normal: "Normal market",
  volatility_spike: "Volatility spike",
  overnight_gap: "Overnight / weekend gap",
  liquidity_shock: "Liquidity shock",
  conflicting_signals: "Conflicting signals",
  contradictory_news: "Contradictory news",
  rapid_reversal: "Rapid reversal",
  extreme_drawdown: "Extreme drawdown",
  position_limit_conflict: "Position-limit conflict",
  risk_rule_conflict: "Risk-rule conflict",
  missing_data: "Missing / ambiguous data",
  prompt_perturbation: "Prompt perturbation (consistency)",
};

async function loadData() {
  const [report, baseline, meta, real] = await Promise.all([
    fetch("data/report.json").then(r => r.json()),
    fetch("data/baseline_report.json").then(r => r.json()),
    fetch("data/meta.json").then(r => r.json()),
    fetch("data/real_trading.json").then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  state.reports.report = report;
  state.reports.baseline_report = baseline;
  state.meta = meta;
  state.real = real;
}

function current() { return state.reports[state.activeAgentKey]; }

function fmtNum(n) { return n.toLocaleString(); }
function fmtMoney(n) {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
}
function scoreClass(v) {
  if (v >= 90) return "pass";
  if (v >= 70) return "mid";
  return "fail";
}



function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
  document.getElementById(`tab-${tab}`).classList.add("active");
}

document.getElementById("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (btn) switchTab(btn.dataset.tab);
});



function renderStatusLine() {
  const el = document.getElementById("status-line");
  const synthLine = `<span class="dot"></span>Crash tests: ${state.meta.scenario_count} scenarios &middot; seed ${state.meta.seed}`;

  let realLine;
  if (state.real && state.real.report) {
    const n = state.real.report.metrics.trade_count;
    realLine = `<span class="dot ${n > 0 ? '' : 'warn'}"></span>Paper trading: ${n} completed trade${n === 1 ? '' : 's'}`;
  } else {
    realLine = `<span class="dot warn"></span>Paper trading: no data yet`;
  }
  el.innerHTML = `${synthLine}<br>${realLine}`;
}



function renderOverview() {
  const el = document.getElementById("overview-grid");
  const r = state.reports.report.summary;
  const cls = scoreClass(r.scores.reliability);

  const real = state.real && state.real.report;
  const m = real ? real.metrics : null;

  el.innerHTML = `
    <div class="overview-panel">
      <div class="panel-head">
        <span class="panel-title">Crash Tests</span>
        <button class="panel-link" data-goto="crash-tests">View forensic detail &rarr;</button>
      </div>
      <div class="overview-big ${cls}">${r.scores.reliability.toFixed(1)}</div>
      <div class="overview-sub">Reliability score &middot; ${fmtNum(r.total_tests)} synthetic scenarios</div>
      <div class="overview-stat-row"><span>Passed</span><span class="v pass">${r.passed}</span></div>
      <div class="overview-stat-row"><span>Failed</span><span class="v fail">${r.failed}</span></div>
      <div class="overview-stat-row"><span>Risk violations</span><span class="v fail">${r.risk_violations}</span></div>
      <div class="overview-stat-row"><span>Decision inconsistencies</span><span class="v fail">${r.decision_inconsistencies}</span></div>
      <div class="overview-caution">1,000 controlled synthetic scenarios &mdash; not historical, not real trading.</div>
    </div>

    <div class="overview-panel">
      <div class="panel-head">
        <span class="panel-title">Paper Trading</span>
        <button class="panel-link" data-goto="paper-trading">View execution detail &rarr;</button>
      </div>
      ${m ? `
        <div class="overview-big ${m.trade_count > 0 ? (m.cumulative_pnl_usdt >= 0 ? 'pass' : 'fail') : 'warn'}">${m.trade_count}</div>
        <div class="overview-sub">Completed trade${m.trade_count === 1 ? '' : 's'} &middot; BTCUSDT, Bitget Demo</div>
        <div class="overview-stat-row"><span>Win rate</span><span class="v">${m.win_rate_pct !== null ? m.win_rate_pct.toFixed(1) + '%' : 'Insufficient sample'}</span></div>
        <div class="overview-stat-row"><span>Cumulative P&amp;L</span><span class="v ${m.cumulative_pnl_usdt >= 0 ? 'pass' : 'fail'}">${m.cumulative_pnl_usdt !== null ? fmtMoney(m.cumulative_pnl_usdt) : 'n/a'}</span></div>
        <div class="overview-stat-row"><span>Sharpe ratio</span><span class="v warn">${m.sharpe_ratio !== null ? m.sharpe_ratio : 'Not computed'}</span></div>
        <div class="overview-caution">${m.sample_size_warning || 'Actual Bitget Demo executions &mdash; not simulated.'}</div>
      ` : `
        <div class="overview-big warn">&mdash;</div>
        <div class="overview-sub">No real trading data yet</div>
        <div class="overview-caution">Run the paper-trading agent, then re-export via polygraph_ingestion.</div>
      `}
    </div>
  `;

  el.querySelectorAll("[data-goto]").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.goto));
  });
}



function renderHero() {
  const r = current().summary;
  const el = document.getElementById("hero");
  const cls = scoreClass(r.scores.reliability);
  el.innerHTML = `
    <div class="hero-score">
      <div class="label">${r.agent_name}${r.is_simulated ? " &middot; simulated specimen" : ""}</div>
      <div class="value ${cls}">${r.scores.reliability.toFixed(1)}</div>
      <div class="subline">Reliability score &middot; ${fmtNum(r.total_tests)} tests &middot;
        <span class="mono">${r.passed}</span> passed / <span class="mono">${r.failed}</span> failed</div>
    </div>
    <div class="hero-components">
      ${componentRow("Consistency", r.scores.consistency)}
      ${componentRow("Risk discipline", r.scores.risk_discipline)}
      ${componentRow("Stress performance", r.scores.stress_performance)}
      ${componentRow("Execution discipline", r.scores.execution_discipline)}
    </div>
  `;
}

function componentRow(name, value) {
  return `
    <div class="component-row">
      <div class="row-top"><span class="name">${name}</span><span class="score">${value.toFixed(1)}</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${value}%"></div></div>
    </div>
  `;
}

function renderComparison() {
  const specimen = state.reports.report.summary;
  const baseline = state.reports.baseline_report.summary;
  const el = document.getElementById("comparison");
  const rows = [
    ["Reliability score", specimen.scores.reliability, baseline.scores.reliability, "num"],
    ["Illustrative return", specimen.cumulative_illustrative_return_pct, baseline.cumulative_illustrative_return_pct, "pct"],
    ["Max illustrative drawdown", specimen.max_illustrative_drawdown_pct, baseline.max_illustrative_drawdown_pct, "pct"],
    ["Risk violations", specimen.risk_violations, baseline.risk_violations, "int"],
    ["Decision inconsistencies", specimen.decision_inconsistencies, baseline.decision_inconsistencies, "int"],
    ["Human takeover events", specimen.human_takeover_events, baseline.human_takeover_events, "int"],
  ];
  el.innerHTML = `
    <h2>Does autonomy add value, or just add failure modes?</h2>
    <table class="comparison-table">
      <thead><tr><th></th><th>${specimen.agent_name}</th><th>${baseline.agent_name}</th></tr></thead>
      <tbody>
        ${rows.map(([label, a, b, fmt]) => `
          <tr>
            <td>${label}</td>
            <td class="num">${fmtCell(a, fmt)}</td>
            <td class="num">${fmtCell(b, fmt)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
    <p class="comparison-note">The specimen's illustrative return is higher than the fixed-rule baseline's - but
      it gets there with roughly ${(specimen.risk_violations / Math.max(baseline.risk_violations, 1)).toFixed(0)}&times;
      the risk violations and ${specimen.human_takeover_events} forced human-takeover events against
      ${baseline.human_takeover_events} for the baseline. A profitable agent that only gets there by breaking its
      own risk constraints is a failed test, not a successful one - that's the distinction this harness is built to catch.</p>
  `;
}

function fmtCell(v, fmt) {
  if (fmt === "pct") return `${v.toFixed(1)}%`;
  if (fmt === "int") return fmtNum(v);
  return v.toFixed(1);
}

function renderBreakdown() {
  const r = current().summary;
  const el = document.getElementById("breakdown");
  const cards = [
    [r.risk_violations, "Risk violations"],
    [r.decision_inconsistencies, `Decision inconsistencies (${r.consistency_groups_flagged}/${r.consistency_groups_total} groups)`],
    [r.excessive_exposure_events, "Excessive exposure events"],
    [r.human_takeover_events, "Human takeover events"],
  ];
  el.innerHTML = `
    <h2>Failure breakdown &mdash; ${current().summary.agent_name}</h2>
    <div class="breakdown-grid">
      ${cards.map(([num, lbl]) => `
        <div class="breakdown-card">
          <div class="num">${fmtNum(num)}</div>
          <div class="lbl">${lbl}</div>
        </div>
      `).join("")}
    </div>
  `;
}

function categoryCounts() {
  const tests = current().tests;
  const counts = {};
  for (const t of tests) counts[t.category] = (counts[t.category] || 0) + 1;
  return counts;
}

function renderScenarioGuide() {
  const el = document.getElementById("scenario-guide");
  const counts = categoryCounts();
  el.innerHTML = `
    <h2>Scenario categories</h2>
    <div class="category-grid" id="category-grid">
      <div class="category-chip ${state.activeCategory === null ? "active" : ""}" data-cat="">
        <span class="cat-name">All categories</span><span class="cat-count">${current().tests.length}</span>
      </div>
      ${Object.entries(counts).map(([cat, count]) => `
        <div class="category-chip ${state.activeCategory === cat ? "active" : ""}" data-cat="${cat}">
          <span class="cat-name">${CATEGORY_LABELS[cat] || cat}</span><span class="cat-count">${count}</span>
        </div>
      `).join("")}
    </div>
  `;
  el.querySelectorAll(".category-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      state.activeCategory = chip.dataset.cat || null;
      state.page = 0;
      renderScenarioGuide();
      renderTests();
    });
  });
}

function filteredTests() {
  let tests = current().tests;
  if (state.activeCategory) tests = tests.filter(t => t.category === state.activeCategory);
  if (state.activeFilter === "failed") tests = tests.filter(t => !t.passed);
  if (state.activeFilter === "risk") tests = tests.filter(t => t.risk_violation);
  if (state.activeFilter === "consistency") tests = tests.filter(t => t.consistency_flagged);
  if (state.activeFilter === "takeover") tests = tests.filter(t => t.human_takeover);
  return tests;
}

function renderFilters() {
  const el = document.getElementById("tests-filters");
  const options = [
    ["all", "All"],
    ["failed", "Failed only"],
    ["risk", "Risk violations"],
    ["consistency", "Consistency failures"],
    ["takeover", "Human takeover"],
  ];
  el.innerHTML = options.map(([key, label]) => `
    <button class="filter-btn ${state.activeFilter === key ? "active" : ""}" data-filter="${key}">${label}</button>
  `).join("");
  el.querySelectorAll(".filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      state.activeFilter = btn.dataset.filter;
      state.page = 0;
      renderFilters();
      renderTests();
    });
  });
}

function renderTests() {
  const tests = filteredTests();
  const totalPages = Math.max(1, Math.ceil(tests.length / state.pageSize));
  state.page = Math.min(state.page, totalPages - 1);
  const start = state.page * state.pageSize;
  const pageTests = tests.slice(start, start + state.pageSize);

  const tbody = document.getElementById("tests-tbody");
  tbody.innerHTML = pageTests.map((t, i) => `
    <tr data-idx="${start + i}" data-global-id="${t.scenario_id}">
      <td class="mono">${start + i + 1}</td>
      <td>${CATEGORY_LABELS[t.category] || t.category}</td>
      <td class="mono">${t.market_state.symbol}</td>
      <td class="mono">${t.agent_decision.action} ${t.agent_decision.position_size_pct}%</td>
      <td class="mono">${t.risk_verdict.approved_action} ${t.risk_verdict.approved_position_size_pct}%</td>
      <td><span class="tag ${t.passed ? "pass" : "fail"}">${t.passed ? "Passed" : "Failed"}</span></td>
    </tr>
  `).join("");

  tbody.querySelectorAll("tr").forEach(row => {
    row.addEventListener("click", () => openReplay(row.dataset.globalId));
  });

  const pag = document.getElementById("pagination");
  pag.innerHTML = `
    <button id="prev-page" ${state.page === 0 ? "disabled" : ""}>&larr; Prev</button>
    <span>Page ${state.page + 1} of ${totalPages} &middot; ${tests.length} tests</span>
    <button id="next-page" ${state.page >= totalPages - 1 ? "disabled" : ""}>Next &rarr;</button>
  `;
  document.getElementById("prev-page").addEventListener("click", () => { state.page--; renderTests(); });
  document.getElementById("next-page").addEventListener("click", () => { state.page++; renderTests(); });
}

function findTest(scenarioId) { return current().tests.find(t => t.scenario_id === scenarioId); }

function openReplay(scenarioId) {
  const t = findTest(scenarioId);
  if (!t) return;
  const ms = t.market_state;
  const dec = t.agent_decision;
  const risk = t.risk_verdict;

  const panel = document.getElementById("replay-panel");
  panel.innerHTML = `
    <button class="replay-close" id="replay-close">Close</button>
    <div class="replay-title">${t.scenario_id}</div>
    <div class="replay-sub">${CATEGORY_LABELS[t.category] || t.category} &middot; ${ms.symbol} &middot;
      phrasing variant ${t.phrasing_variant} &middot;
      <span class="tag ${t.passed ? "pass" : "fail"}">${t.passed ? "Passed" : "Failed"}</span></div>

    <div class="replay-step pass">
      <h4>1. Market state</h4>
      <div class="body kv-grid">
        <div class="kv"><div class="k">Price</div><div class="v">${ms.price}</div></div>
        <div class="kv"><div class="k">Prior price</div><div class="v">${ms.prior_price}</div></div>
        <div class="kv"><div class="k">Return</div><div class="v">${ms.return_pct.toFixed(2)}%</div></div>
        <div class="kv"><div class="k">Volatility</div><div class="v">${ms.volatility}</div></div>
        <div class="kv"><div class="k">Volume vs avg</div><div class="v">${ms.volume_ratio}x</div></div>
        <div class="kv"><div class="k">Assumed drawdown</div><div class="v">${ms.assumed_drawdown_pct}%</div></div>
        <div class="kv"><div class="k">Current position</div><div class="v">${ms.current_position_pct}%</div></div>
        <div class="kv"><div class="k">Data complete</div><div class="v">${ms.data_complete}</div></div>
      </div>
    </div>

    <div class="replay-step pass">
      <h4>2. Information received</h4>
      <div class="body"><div class="narrative-quote">&ldquo;${ms.narrative}&rdquo;</div></div>
    </div>

    <div class="replay-step ${risk.violations.length ? "fail" : "pass"}">
      <h4>3. Agent decision</h4>
      <div class="body">
        <strong>${dec.action}</strong> &middot; target size <strong>${dec.position_size_pct}%</strong>
        &middot; confidence ${dec.confidence}
        <div style="margin-top:6px;color:var(--muted)">${dec.rationale}</div>
      </div>
    </div>

    <div class="replay-step ${risk.violations.length ? "fail" : "pass"}">
      <h4>4. Risk evaluation</h4>
      <div class="body">
        Approved action: <strong>${risk.approved_action}</strong> at <strong>${risk.approved_position_size_pct}%</strong>
        ${risk.was_modified ? " &mdash; modified from the agent's proposal." : " &mdash; approved as proposed."}
        ${risk.violations.length ? `<ul class="violation-list">${risk.violations.map(v => `<li>${v}</li>`).join("")}</ul>` : ""}
      </div>
    </div>

    <div class="replay-step pass">
      <h4>5. Order / portfolio impact</h4>
      <div class="body">
        Illustrative pnl for this probe: <strong class="mono">${fmtMoney(t.illustrative_pnl)}</strong>
        &middot; cumulative illustrative pnl at this point in the sequence:
        <strong class="mono">${fmtMoney(t.cumulative_illustrative_pnl)}</strong>
      </div>
    </div>

    ${t.consistency_flagged ? `
    <div class="replay-step fail">
      <h4>Consistency failure</h4>
      <div class="body">
        This is one of ${5} reworded versions of the identical underlying market state
        (group <span class="mono">${t.base_state_id}</span>). Across the group the agent produced
        actions ${t.consistency_group_actions.join(", ")} with a position-size spread of
        ${t.consistency_group_size_spread} percentage points &mdash; on numbers that never changed,
        only the wording did.
      </div>
    </div>` : ""}

    <div class="replay-step ${t.human_takeover ? "fail" : "pass"}">
      <h4>${t.human_takeover ? "Human takeover triggered" : "No human takeover required"}</h4>
      <div class="body">
        ${t.human_takeover
          ? "Multiple simultaneous risk breaches (or a failed risk-reduction under stress) crossed the threshold for a forced human review of this decision."
          : "This decision stayed within a single risk boundary, if any, and did not require escalation."}
      </div>
    </div>
  `;

  document.getElementById("replay-close").addEventListener("click", closeReplay);
  document.getElementById("replay-overlay").classList.add("open");
}

function closeReplay() { document.getElementById("replay-overlay").classList.remove("open"); }


function renderEquitySVG(equityCurve) {
  const w = 760, h = 160, pad = 24;
  const values = equityCurve.map(p => p.cumulative_pnl_usdt);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const range = (max - min) || 1;
  const step = (w - pad * 2) / (equityCurve.length - 1);

  const points = equityCurve.map((p, i) => {
    const x = pad + i * step;
    const y = h - pad - ((p.cumulative_pnl_usdt - min) / range) * (h - pad * 2);
    return `${x},${y}`;
  }).join(" ");

  const zeroY = h - pad - ((0 - min) / range) * (h - pad * 2);
  const lastPositive = values[values.length - 1] >= 0;

  return `
    <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">
      <line x1="${pad}" y1="${zeroY}" x2="${w - pad}" y2="${zeroY}" stroke="#262C33" stroke-width="1" stroke-dasharray="3,3" />
      <polyline points="${points}" fill="none" stroke="${lastPositive ? '#3FBF8F' : '#E2593B'}" stroke-width="1.5" />
    </svg>
  `;
}

function renderPaperTrading() {
  const el = document.getElementById("paper-trading-content");
  const real = state.real && state.real.report;

  if (!real) {
    el.innerHTML = `
      <div class="pt-empty">
        No real trading data available yet. Run the paper-trading agent (<code>agent/</code>),
        then compute metrics (<code>real_metrics/compute_metrics.py</code>) and re-export
        (<code>python3 -m polygraph_ingestion.export_for_dashboard</code>).
        ${state.real && state.real.unavailable_reason ? `<br><br><span style="font-family:var(--mono);font-size:11.5px;">${state.real.unavailable_reason}</span>` : ""}
      </div>`;
    return;
  }

  const m = real.metrics;
  const trades = real.completed_trades;
  const openPos = real.open_position;

  const winRateDisplay = m.win_rate_pct !== null
    ? `<div class="pt-value ${m.win_rate_pct >= 50 ? 'pass' : 'fail'}">${m.win_rate_pct.toFixed(1)}%</div>`
    : `<div class="pt-value provisional">Insufficient sample</div>`;

  const pnlDisplay = m.cumulative_pnl_usdt !== null
    ? `<div class="pt-value ${m.cumulative_pnl_usdt >= 0 ? 'pass' : 'fail'}">${fmtMoney(m.cumulative_pnl_usdt)}</div>`
    : `<div class="pt-value provisional">n/a</div>`;

  const sharpeDisplay = m.sharpe_ratio !== null
    ? `<div class="pt-value neutral">${m.sharpe_ratio}</div>`
    : `<div class="pt-value provisional">Not computed</div>`;

  const ddDisplay = m.max_drawdown_usdt !== null
    ? `<div class="pt-value fail">${fmtMoney(-Math.abs(m.max_drawdown_usdt))}</div>`
    : `<div class="pt-value provisional">n/a</div>`;

  el.innerHTML = `
    <div class="pt-header">BTCUSDT &middot; Demo environment &middot; ${m.trade_count} completed trade${m.trade_count === 1 ? '' : 's'}</div>

    <div class="pt-stat-grid">
      <div class="pt-stat">
        <div class="pt-label">Completed Trades</div>
        <div class="pt-value neutral">${m.trade_count}</div>
      </div>
      <div class="pt-stat">
        <div class="pt-label">Win Rate</div>
        ${winRateDisplay}
      </div>
      <div class="pt-stat">
        <div class="pt-label">Cumulative P&amp;L</div>
        ${pnlDisplay}
      </div>
      <div class="pt-stat">
        <div class="pt-label">Current Position</div>
        <div class="pt-value ${openPos ? 'pass' : 'neutral'}">${openPos ? 'LONG' : 'FLAT'}</div>
        ${openPos ? `<div style="font-size:11px;color:var(--muted);margin-top:4px;">${openPos.qty_base} BTC @ ${openPos.entry_price}</div>` : ''}
      </div>
    </div>

    <div class="pt-stat-grid">
      <div class="pt-stat">
        <div class="pt-label">Max Drawdown</div>
        ${ddDisplay}
      </div>
      <div class="pt-stat">
        <div class="pt-label">Sharpe Ratio</div>
        ${sharpeDisplay}
      </div>
      <div class="pt-stat">
        <div class="pt-label">Latest Execution</div>
        <div class="pt-value neutral" style="font-size:14px;">${trades.length ? trades[trades.length - 1].exit_time.slice(0, 16).replace('T', ' ') : (openPos ? openPos.entry_time.slice(0,16).replace('T',' ') : 'n/a')}</div>
      </div>
      <div class="pt-stat">
        <div class="pt-label">Sample Size</div>
        <div class="pt-value ${m.trade_count >= 30 ? 'pass' : 'warn'}">n = ${m.trade_count}</div>
      </div>
    </div>

    ${m.sample_size_warning ? `<div class="overview-caution" style="margin-bottom:20px;">${m.sample_size_warning}</div>` : ""}

    <div class="pt-section">
      <h2>Equity curve</h2>
      ${m.equity_curve.length >= 2 ? `
        <div class="equity-chart-wrap">
          <div class="equity-svg-label">Cumulative realized P&amp;L (USDT) across ${m.equity_curve.length} completed trades &mdash; dollar terms, not %-of-account (account size was never declared to this system)</div>
          ${renderEquitySVG(m.equity_curve)}
        </div>
      ` : `
        <div class="pt-empty">Insufficient sample for an equity curve &mdash; ${m.trade_count} completed trade${m.trade_count === 1 ? '' : 's'} recorded. At least 2 are needed to plot a line at all.</div>
      `}
    </div>

    <div class="pt-section">
      <h2>Completed trades</h2>
      ${trades.length ? `
        <table class="pt-table">
          <thead><tr><th>Entry</th><th>Exit</th><th>Entry Px</th><th>Exit Px</th><th>Qty (BTC)</th><th>Net P&amp;L</th><th>Return</th></tr></thead>
          <tbody>
            ${trades.map(t => `
              <tr>
                <td>${t.entry_time.slice(0, 16).replace('T', ' ')}</td>
                <td>${t.exit_time.slice(0, 16).replace('T', ' ')}</td>
                <td>${t.entry_price}</td>
                <td>${t.exit_price}</td>
                <td>${t.qty_base}</td>
                <td class="${t.net_pnl_usdt !== null ? (t.net_pnl_usdt >= 0 ? 'pass' : 'fail') : 'warn'}">${t.net_pnl_usdt !== null ? fmtMoney(t.net_pnl_usdt) : `Fee data ${t.fee_data_status === 'unrecognized_fee_currency' ? 'unrecognized' : 'incomplete'}`}</td>
                <td class="${t.return_pct !== null ? (t.return_pct >= 0 ? 'pass' : 'fail') : 'warn'}">${t.return_pct !== null ? t.return_pct.toFixed(2) + '%' : `Gross: ${fmtMoney(t.gross_pnl_usdt)}`}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      ` : `<div class="pt-empty">No completed round trips yet.</div>`}
    </div>

    ${openPos ? `
    <div class="pt-section">
      <h2>Open position</h2>
      <div class="kv-grid">
        <div class="kv"><div class="k">Entry time</div><div class="v">${openPos.entry_time}</div></div>
        <div class="kv"><div class="k">Entry price</div><div class="v">${openPos.entry_price}</div></div>
        <div class="kv"><div class="k">Quantity</div><div class="v">${openPos.qty_base} BTC</div></div>
      </div>
      <div class="overview-caution">Not counted in win rate, P&amp;L, or Sharpe above until closed.</div>
    </div>` : ""}
  `;
}


function renderAll() {
  renderStatusLine();
  renderOverview();
  renderHero();
  renderComparison();
  renderBreakdown();
  renderScenarioGuide();
  renderFilters();
  renderTests();
  renderPaperTrading();
}

document.getElementById("agent-select").addEventListener("change", (e) => {
  state.activeAgentKey = e.target.value;
  state.activeCategory = null;
  state.activeFilter = "all";
  state.page = 0;
  renderHero();
  renderBreakdown();
  renderScenarioGuide();
  renderFilters();
  renderTests();
});

document.getElementById("replay-overlay").addEventListener("click", (e) => {
  if (e.target.id === "replay-overlay") closeReplay();
});

loadData().then(renderAll).catch(err => {
  document.getElementById("overview-grid").innerHTML =
    `<p style="color:var(--fail);grid-column:1/-1;padding:20px;">Could not load report data: ${err}. Run backend/main.py first, then serve this folder (see README).</p>`;
});
