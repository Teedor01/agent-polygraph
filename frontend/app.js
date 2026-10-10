/* Agent Polygraph - reliability terminal.
 * Crash Tests: every number read directly from data/report.json /
 * data/baseline_report.json - nothing invented.
 * Paper Trading: every number read directly from data/real_trading.json
 * (itself exported from real_metrics/real_report.json via
 * polygraph_ingestion). The two are never merged into one score. */

/* Trade tables show the most recent trade first (ISO timestamps sort lexically). Returns a copy. */
function newestFirst(trades) {
  return [...trades].sort((a, b) => String(b.exit_time).localeCompare(String(a.exit_time)));
}

const state = {
  reports: {},
  meta: null,
  real: null,
  activeAgentKey: "report",
  activeCategory: null,
  activeFilter: "all",
  page: 0,
  pageSize: 25,
  activePage: "overview",
  replaySelectedId: null,
  replayFilterText: "",
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

const CATEGORY_SWATCH = ["#4C8DFF","#3ED68C","#F1555C","#E8B44A","#B98CFF","#4FD1C5","#F5A3C7","#8891A5","#FF9F5A","#5AC8FA","#C4E86B","#E27DFF"];

/* Machine-readable failure taxonomy assigned by backend/evaluator.py
 * (market_state.FAILURE_CATEGORIES), from actual scenario evidence -
 * these labels are display-only, the category value itself is data. */
const FAILURE_CATEGORY_LABELS = {
  risk_violation: "Risk violation",
  decision_inconsistency: "Decision inconsistency",
  invalid_action: "Invalid action",
  malformed_output: "Malformed output",
  stale_or_missing_data: "Stale / missing data",
  execution_constraint_violation: "Execution constraint violation",
  timeout_or_provider_failure: "Timeout / provider failure",
};

/* ---------------- Data loading ---------------- */

async function loadData() {
  const [report, baseline, meta, real, realFutures, futuresCrashTests, futuresRuns] = await Promise.all([
    fetch("data/report.json").then(r => r.json()),
    fetch("data/baseline_report.json").then(r => r.json()),
    fetch("data/meta.json").then(r => r.json()),
    fetch("data/real_trading.json").then(r => r.ok ? r.json() : null).catch(() => null),
    fetch("data/real_futures_trading.json").then(r => r.ok ? r.json() : null).catch(() => null),
    fetch("data/futures_crashtest.json").then(r => r.ok ? r.json() : null).catch(() => null),
    fetch("data/runs/index.json").then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  state.reports.report = report;
  state.reports.baseline_report = baseline;
  state.meta = meta;
  state.real = real;
  state.realFutures = realFutures;
  state.futuresCrashTests = futuresCrashTests;
  state.futuresRuns = futuresRuns;
  state.spotRuns = await fetch("data/runs/spot-index.json").then(r => r.ok ? r.json() : null).catch(() => null);
  state.futuresView = null; // a report picked from history; null = the default report above
}

function current() { return state.reports[state.activeAgentKey]; }
function fmtNum(n) { return n.toLocaleString(); }
function fmtMoney(n) {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
}
function scoreClass(v) { return v >= 90 ? "pass" : v >= 70 ? "warn" : "fail"; }
function na(v, fmt) { return (v === null || v === undefined) ? '<span class="stat-value na">N/A</span>' : fmt(v); }
function shortTs(ts) { return ts ? ts.slice(0, 16).replace("T", " ") : "N/A"; }

/* Decision provenance badge. Only ever shows one of these three exact
 * labels - never a provider or model name, per the honesty scope for
 * this feature. decision_source is the sole source of truth; absence
 * of the field (older log lines) defaults to "deterministic", which is
 * accurate since that was the only mode that existed at the time. */
function provenanceBadge(source) {
  const s = source || "deterministic";
  if (s === "llm") return `<span class="badge neutral">LLM</span>`;
  if (s === "llm_fallback") return `<span class="badge warn">LLM FALLBACK</span>`;
  return `<span class="badge dim">DETERMINISTIC</span>`;
}

/* Expandable reasoning/confidence detail - only rendered when the
 * fields actually exist in the record. Nothing here is generated; it
 * is a direct, unmodified display of what was recorded in the JSONL. */
function llmDetailToggle(uid, reason, confidence) {
  if (!reason && confidence === null) return "";
  return `
    <button class="small-link llm-detail-toggle" data-detail="${uid}" style="background:none;border:none;cursor:pointer;">Reasoning &#9662;</button>
    <div class="llm-detail-panel" id="detail-${uid}" style="display:none;font-size:10.5px;color:var(--muted);margin-top:4px;max-width:260px;white-space:normal;">
      ${reason ? `&ldquo;${reason}&rdquo;` : ""}${confidence !== null && confidence !== undefined ? ` (confidence ${confidence})` : ""}
    </div>
  `;
}

function wireLlmDetailToggles(container) {
  container.querySelectorAll(".llm-detail-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      const panel = document.getElementById(`detail-${btn.dataset.detail}`);
      if (panel) panel.style.display = panel.style.display === "none" ? "block" : "none";
    });
  });
}

/* ---------------- Navigation ---------------- */

function switchPage(page) {
  state.activePage = page;
  document.querySelectorAll(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.page === page));
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.getElementById(`page-${page}`).classList.add("active");
  if (page === "failure-replay") renderFailureReplayPage();
}

document.getElementById("sidebar-nav").addEventListener("click", (e) => {
  const item = e.target.closest(".nav-item");
  if (item) switchPage(item.dataset.page);
});

function goToReplay(scenarioId) {
  state.replaySelectedId = scenarioId;
  switchPage("failure-replay");
}

/* ---------------- Top status ---------------- */

function renderTopStatus() {
  const dot = document.getElementById("status-dot");
  const val = document.getElementById("status-value");
  dot.className = "dot";
  val.textContent = "Operational";
  // A stored Spot run swaps the Spot reports on every Spot page: say so everywhere.
  let banner = document.getElementById("spot-view-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "spot-view-banner";
    banner.style.cssText = "background:var(--warn-bg);color:var(--warn);font-size:12px;padding:6px 14px;text-align:center;";
    document.body.prepend(banner);
  }
  if (state.spotView) {
    banner.innerHTML = `Spot pages are showing a STORED RUN from ${escHtml(state.spotView.generatedAt.replace("T"," ").slice(0,16))} (not the latest). <a href="#" onclick="selectSpotRun(null);return false;">Back to latest</a>`;
    banner.style.display = "block";
  } else banner.style.display = "none";
}

/* ================= OVERVIEW PAGE ================= */

function renderOverviewPage() {
  const r = state.reports.report.summary;
  const cls = scoreClass(r.scores.reliability);
  const real = state.real && state.real.report;
  const m = real ? real.metrics : null;

  const top = document.getElementById("overview-top");
  top.innerHTML = `
    <div class="panel panel-pad">
      <span class="provenance-pill synthetic">SYNTHETIC / DETERMINISTIC</span>
      <div class="panel-title">Crash Test Lab</div>
      <div class="panel-desc">${r.total_tests.toLocaleString()} deterministic scenarios. Tests reliability, risk discipline and consistency.</div>
      <div class="stat-row cols-4">
        <div class="stat-cell"><div class="stat-label">Scenarios</div><div class="stat-value">${fmtNum(r.total_tests)}</div></div>
        <div class="stat-cell"><div class="stat-label">Passed</div><div class="stat-value pass">${fmtNum(r.passed)}</div></div>
        <div class="stat-cell"><div class="stat-label">Failed</div><div class="stat-value fail">${fmtNum(r.failed)}</div></div>
        <div class="stat-cell"><div class="stat-label" title="Composite score: mean of consistency, risk discipline, stress performance and execution discipline. Not the pass rate.">Reliability score (composite)</div><div class="stat-value ${cls}">${r.scores.reliability.toFixed(1)}%</div></div>
      </div>
      <div class="section-gap">${passFailBar(r.passed, r.failed)}</div>
      <div class="stat-row cols-3 section-gap">
        <div class="stat-cell"><div class="stat-label">Risk violations</div><div class="stat-value fail">${fmtNum(r.risk_violations)}</div></div>
        <div class="stat-cell"><div class="stat-label">Inconsistencies</div><div class="stat-value fail">${fmtNum(r.decision_inconsistencies)}</div></div>
        <div class="stat-cell"><div class="stat-label">Reliability score vs baseline</div><div class="stat-value">${r.scores.reliability.toFixed(1)} <span style="color:var(--muted);font-size:11px;">vs</span> ${state.reports.baseline_report.summary.scores.reliability.toFixed(1)}</div></div>
      </div>
    </div>

    <div class="panel panel-pad">
      <span class="provenance-pill real">BITGET DEMO / REAL EXECUTION EVIDENCE</span>
      <div class="panel-title">Bitget Demo Paper Trading</div>
      <div class="panel-desc">Real market data. Real autonomous trading loop. Recorded execution evidence &mdash; simulated funds, not real capital.</div>
      <div class="stat-row cols-4">
        <div class="stat-cell"><div class="stat-label">Completed trades</div>${m ? `<div class="stat-value">${m.trade_count}</div>` : na(null, x=>x)}</div>
        <div class="stat-cell"><div class="stat-label">Net P&amp;L</div>${m && m.cumulative_pnl_usdt !== null ? `<div class="stat-value ${m.cumulative_pnl_usdt>=0?'pass':'fail'}">${fmtMoney(m.cumulative_pnl_usdt)}</div>` : na(null,x=>x)}</div>
        <div class="stat-cell"><div class="stat-label">Win rate</div>${m && m.win_rate_pct !== null ? `<div class="stat-value">${m.win_rate_pct.toFixed(1)}%</div>` : na(null,x=>x)}</div>
        <div class="stat-cell"><div class="stat-label">Sharpe</div>${m && m.sharpe_ratio !== null ? `<div class="stat-value">${m.sharpe_ratio}</div>` : `<div class="stat-value na">${m ? 'PROVISIONAL' : 'N/A'}</div>`}</div>
      </div>
      <div class="stat-row cols-4 section-gap">
        <div class="stat-cell"><div class="stat-label">Max drawdown</div>${m && m.max_drawdown_usdt !== null ? `<div class="stat-value fail">${fmtMoney(-Math.abs(m.max_drawdown_usdt))}</div>` : na(null,x=>x)}</div>
        <div class="stat-cell"><div class="stat-label">Current position</div><div class="stat-value ${real && real.open_position ? 'pass' : ''}">${real && real.open_position ? 'LONG' : (real ? 'FLAT' : 'N/A')}</div></div>
        <div class="stat-cell"><div class="stat-label">Latest execution</div><div class="stat-value" style="font-size:11.5px;">${latestExecTime(real)}</div></div>
        <div class="stat-cell"><div class="stat-label">Data freshness</div><div class="stat-value na" style="font-size:11px;">SNAPSHOT</div></div>
      </div>
      <div class="foot-note section-gap">Note: this is a Bitget Demo environment. No real capital is used.</div>
    </div>
  `;

  const execTrades = document.getElementById("overview-exec-trades");
  execTrades.innerHTML = `
    <div class="panel panel-pad">
      <div class="panel-title" style="font-size:12.5px;">Latest execution <span style="font-weight:400;color:var(--muted);font-size:10px;">SOURCE: BITGET DEMO</span></div>
      <div class="section-gap" id="latest-exec-timeline"></div>
    </div>
    <div class="panel panel-pad">
      <div class="panel-title" style="font-size:12.5px;">Recent demo trades <span style="font-weight:400;color:var(--muted);font-size:10px;">SOURCE: BITGET DEMO</span></div>
      <div class="table-scroll section-gap">
        <table class="dtable"><thead><tr><th>Exit</th><th>Entry Px</th><th>Exit Px</th><th>Qty</th><th>Decision</th><th>Net P&amp;L</th></tr></thead>
        <tbody>${real && real.completed_trades.length ? real.completed_trades.slice(-5).reverse().map(t => `
          <tr>
            <td>${shortTs(t.exit_time)}</td>
            <td>${t.entry_price}</td>
            <td>${t.exit_price}</td>
            <td>${t.qty_base}</td>
            <td>${provenanceBadge(t.exit_decision_source)}</td>
            <td class="${t.net_pnl_usdt === null ? '' : (t.net_pnl_usdt >= 0 ? 'pass' : 'fail')}" style="${t.net_pnl_usdt === null ? 'color:var(--warn)' : ''}">${t.net_pnl_usdt !== null ? fmtMoney(t.net_pnl_usdt) : 'Fee data incomplete'}</td>
          </tr>`).join("") : `<tr><td colspan="6" style="text-align:center;color:var(--muted);font-family:var(--sans);">No completed trades yet</td></tr>`}
        </tbody></table>
      </div>
    </div>
  `;
  renderExecutionTimeline("latest-exec-timeline", real);

  const failedEl = document.getElementById("overview-failed-scenarios");
  const failedTests = state.reports.report.tests.filter(t => !t.passed).slice(0, 6);
  failedEl.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:baseline;">
      <div class="panel-title" style="font-size:12.5px;">Recent failed scenarios <span class="badge neutral" style="margin-left:6px;">SYNTHETIC</span></div>
      <span class="small-link" data-goto-page="crash-tests">View all &rarr;</span>
    </div>
    <div class="table-scroll section-gap">
      <table class="dtable">
        <thead><tr><th>Scenario ID</th><th>Category</th><th>Symbol</th><th>Failure</th><th>Agent action</th><th>Risk result</th><th></th></tr></thead>
        <tbody>${failedTests.map(t => `
          <tr class="clickable" data-replay="${t.scenario_id}">
            <td>${t.scenario_id}</td>
            <td style="font-family:var(--sans);">${CATEGORY_LABELS[t.category] || t.category}</td>
            <td>${t.market_state.symbol}</td>
            <td>${failureBadge(t)}</td>
            <td>${t.agent_decision.action} ${t.agent_decision.position_size_pct}%</td>
            <td>${t.risk_verdict.approved_action} ${t.risk_verdict.approved_position_size_pct}%</td>
            <td class="small-link">Replay &rarr;</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>
  `;
  wireReplayLinks(failedEl);
  wireGotoPage(top); wireGotoPage(failedEl);
}

function failureBadge(t) {
  const cls = t.failure_category === "decision_inconsistency" ? "warn" : "fail";
  return `<span class="badge ${cls}">${failureCategoryOf(t)}</span>`;
}

function latestExecTime(real) {
  if (!real) return "N/A";
  const t = real.completed_trades.length ? real.completed_trades[real.completed_trades.length - 1].exit_time
    : (real.open_position ? real.open_position.entry_time : null);
  return t ? shortTs(t) : "N/A";
}

function passFailBar(passed, failed) {
  const total = passed + failed;
  const pPct = (passed / total * 100).toFixed(1);
  const fPct = (failed / total * 100).toFixed(1);
  return `
    <div class="bar-track-h"><div class="bar-seg-pass" style="width:${pPct}%"></div><div class="bar-seg-fail" style="width:${fPct}%"></div></div>
    <div class="bar-legend"><span><span class="sw" style="background:var(--pass)"></span>${passed} PASS (${pPct}%)</span><span><span class="sw" style="background:var(--fail)"></span>${failed} FAIL (${fPct}%)</span></div>
  `;
}

/* Real-evidence-only execution timeline. Only fields that genuinely
 * exist in the real trading log are shown; nothing is invented for
 * steps the data doesn't cover (e.g. the original decision rationale
 * isn't in real_report.json, so that step just isn't fabricated). */
function renderExecutionTimeline(containerId, real) {
  const el = document.getElementById(containerId);
  if (!real) { el.innerHTML = `<div class="hint-empty">No executions yet</div>`; return; }

  const trades = real.completed_trades;
  const openPos = real.open_position;
  const latestTrade = trades.length ? trades[trades.length - 1] : null;
  const isOpenMoreRecent = openPos && (!latestTrade || openPos.entry_time > latestTrade.exit_time);

  let steps;
  if (isOpenMoreRecent) {
    steps = [
      { time: shortTs(openPos.entry_time), label: "MARKET DATA", chip: "pass", main: "BTCUSDT", detail: `$${openPos.entry_price}` },
      { time: shortTs(openPos.entry_time), label: "DECISION", chip: "pass", main: "BUY", detail: provenanceBadge(openPos.entry_decision_source) },
      { time: shortTs(openPos.entry_time), label: "RISK", chip: "pass", main: "APPROVED", detail: "" },
      { time: shortTs(openPos.entry_time), label: "ORDER", chip: "pass", main: "SUBMITTED", detail: "" },
      { time: shortTs(openPos.entry_time), label: "FILL", chip: "pass", main: `${openPos.qty_base} BTC`, detail: `@ $${openPos.entry_price}` },
      { time: shortTs(openPos.entry_time), label: "POSITION", chip: "pass", main: "FLAT &rarr; LONG", detail: `${openPos.qty_base} BTC` },
    ];
  } else if (latestTrade) {
    steps = [
      { time: shortTs(latestTrade.exit_time), label: "MARKET DATA", chip: "pass", main: "BTCUSDT", detail: `$${latestTrade.exit_price}` },
      { time: shortTs(latestTrade.exit_time), label: "DECISION", chip: "fail", main: "SELL", detail: provenanceBadge(latestTrade.exit_decision_source) },
      { time: shortTs(latestTrade.exit_time), label: "RISK", chip: "pass", main: "APPROVED", detail: "" },
      { time: shortTs(latestTrade.exit_time), label: "ORDER", chip: "pass", main: "SUBMITTED", detail: latestTrade.exit_order_id ? latestTrade.exit_order_id.slice(0,10)+"&hellip;" : "" },
      { time: shortTs(latestTrade.exit_time), label: "FILL", chip: "pass", main: `${latestTrade.qty_base} BTC`, detail: `@ $${latestTrade.exit_price}` },
      { time: shortTs(latestTrade.exit_time), label: "POSITION", chip: "warn", main: "LONG &rarr; FLAT", detail: latestTrade.net_pnl_usdt !== null ? fmtMoney(latestTrade.net_pnl_usdt) : "fee data incomplete" },
    ];
  } else {
    el.innerHTML = `<div class="hint-empty">No executions yet</div>`; return;
  }

  el.innerHTML = `<div class="exec-timeline">${steps.map(s => `
    <div class="exec-step">
      <div class="exec-step-time">${s.time}</div>
      <div class="exec-step-label"><span class="chip ${s.chip}"></span>${s.label}</div>
      <div class="exec-step-main">${s.main}</div>
      <div class="exec-step-detail">${s.detail}</div>
    </div>
  `).join("")}</div>`;
}

function wireReplayLinks(container) {
  container.querySelectorAll("[data-replay]").forEach(row => {
    row.addEventListener("click", () => goToReplay(row.dataset.replay));
  });
}
function wireGotoPage(container) {
  container.querySelectorAll("[data-goto-page]").forEach(el => {
    el.addEventListener("click", () => switchPage(el.dataset.gotoPage));
  });
}

/* ================= CRASH TESTS PAGE ================= */

/* Swap the Spot specimen+baseline reports for a stored run (verbatim files) and re-render. */
async function selectSpotRun(runId) {
  if (!state.spotLatest) state.spotLatest = { report: state.reports.report, baseline_report: state.reports.baseline_report };
  if (runId === null) {
    state.reports.report = state.spotLatest.report; state.reports.baseline_report = state.spotLatest.baseline_report;
    state.spotView = null;
  } else {
    const spec = state.spotRuns.find(e => e.runId === runId);
    const base = state.spotRuns.find(e => e.role === "baseline" && e.generatedAt === spec.generatedAt);
    if (!spec || !spec.file || !base || !base.file) { alert("This run has no stored full report."); return; }
    try {
      const [a, b] = await Promise.all([spec.file, base.file].map(f => fetch(`data/runs/${encodeURIComponent(f)}`).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status} for ${f}`); return r.json(); })));
      state.reports.report = a; state.reports.baseline_report = b; state.spotView = spec;
    } catch (e) { alert(`Could not load stored run: ${e.message}`); return; }
  }
  state.activeCategory = null; state.activeFilter = "all";
  renderAll();
}

function renderSpotHistory() {
  const el = document.getElementById("ct-history");
  const runs = state.spotRuns;
  if (!runs || !runs.length) { el.innerHTML = `<div class="panel-title" style="font-size:12.5px;">Run history (Spot)</div><div class="hint-empty section-gap">No Spot run history yet. Run <code>python3 backend/main.py</code> or <code>python3 backend/history.py --import</code>.</div>`; return; }
  const kindLabel = { simulated_specimen: "SIMULATED SPECIMEN", deterministic: "DETERMINISTIC BASELINE", llm: "LLM" };
  el.innerHTML = `
    <div class="panel-title" style="font-size:12.5px;">Run history (Spot)</div>
    <div class="foot-note">One row per stored run; every run's full report is kept, so "view" reopens it with all scenarios (the dashboard's Spot pages then show that run until you go back). Simulated specimen, deterministic baseline and LLM rows are different things and are never averaged.</div>
    ${state.spotView ? `<div class="foot-note"><strong>Viewing a stored run from ${escHtml(state.spotView.generatedAt.replace("T"," ").slice(0,16))}.</strong> <a href="#" onclick="selectSpotRun(null);return false;">Back to the latest report</a></div>` : ""}
    <div class="table-scroll section-gap"><table class="dtable"><thead><tr><th>When</th><th>Type</th><th>Agent / model</th><th>Passed (raw)</th><th>Risk violations</th><th>Inconsistencies</th><th>Provider failures</th><th>Reliability score (composite)</th><th></th></tr></thead>
    <tbody>${runs.map(e => `<tr>
      <td style="font-family:var(--mono);font-size:10.5px;">${escHtml(e.generatedAt.replace("T"," ").slice(0,16))}</td>
      <td><span class="badge ${e.kind === "llm" ? "neutral" : "dim"}">${kindLabel[e.kind] || escHtml(e.kind)}</span>${e.imported ? ` <span class="badge dim" title="${escHtml(e.imported.note)}">IMPORTED</span>` : ""}</td>
      <td>${escHtml(e.agent)}${e.model ? `<br><span style="color:var(--muted);font-size:10px;">${escHtml(e.provider || "")} ${escHtml(e.model)}</span>` : ""}</td>
      <td>${e.passed}/${e.scenarios}</td><td>${e.riskViolations}</td><td>${e.decisionInconsistencies}</td>
      <td class="${e.providerFailures>0?"fail":""}">${e.providerFailures}</td>
      <td>${fmtPctNA(e.scores && e.scores.reliability !== undefined ? e.scores.reliability : null)}</td>
      <td>${e.role !== "specimen" ? "" : (state.spotView && state.spotView.runId === e.runId) ? `<span style="color:var(--muted);">viewing</span>` : e.file ? `<a href="#" onclick="selectSpotRun('${escHtml(e.runId)}');return false;">view</a>` : ""}</td></tr>`).join("")}
    </tbody></table></div>`;
}

function renderCrashTestsPage() {
  renderSpotHistory();
  const r = state.reports.report.summary;
  const baseline = state.reports.baseline_report.summary;

  document.getElementById("ct-summary").innerHTML = `
    <div class="panel-title" style="margin-bottom:2px;">Crash Tests</div>
    <div class="panel-desc">${r.total_tests.toLocaleString()} deterministic scenarios. Tests reliability, risk discipline and consistency.</div>
    <div class="stat-row cols-7">
      <div class="stat-cell"><div class="stat-label">Scenarios</div><div class="stat-value">${fmtNum(r.total_tests)}</div></div>
      <div class="stat-cell"><div class="stat-label">Passed</div><div class="stat-value pass">${fmtNum(r.passed)} (${(r.passed/r.total_tests*100).toFixed(1)}%)</div></div>
      <div class="stat-cell"><div class="stat-label">Failed</div><div class="stat-value fail">${fmtNum(r.failed)} (${(r.failed/r.total_tests*100).toFixed(1)}%)</div></div>
      <div class="stat-cell"><div class="stat-label" title="Composite score: mean of consistency, risk discipline, stress performance and execution discipline. Not the pass rate.">Reliability score (composite)</div><div class="stat-value ${scoreClass(r.scores.reliability)}">${r.scores.reliability.toFixed(1)}%</div></div>
      <div class="stat-cell"><div class="stat-label">Risk violations</div><div class="stat-value fail">${fmtNum(r.risk_violations)}</div></div>
      <div class="stat-cell"><div class="stat-label">Inconsistencies</div><div class="stat-value fail">${fmtNum(r.decision_inconsistencies)}</div></div>
      <div class="stat-cell"><div class="stat-label">Reliability score vs baseline</div><div class="stat-value">${r.scores.reliability.toFixed(1)} <span style="color:var(--muted);font-size:11px;">vs</span> ${baseline.scores.reliability.toFixed(1)}</div></div>
    </div>
  `;

  const counts = categoryCounts();
  const failedByCategory = {};
  state.reports.report.tests.filter(t => !t.passed).forEach(t => {
    const cat = failureCategoryOf(t);
    failedByCategory[cat] = (failedByCategory[cat] || 0) + 1;
  });

  document.getElementById("ct-panels").innerHTML = `
    <div class="panel panel-pad">
      <div class="panel-title" style="font-size:12.5px;">Pass / Fail Distribution</div>
      <div class="section-gap">${passFailBar(r.passed, r.failed)}</div>
    </div>
    <div class="panel panel-pad">
      <div class="panel-title" style="font-size:12.5px;">Reliability Comparison</div>
      <div class="section-gap">
        ${["consistency","risk_discipline","stress_performance","execution_discipline"].map(k => `
          <div class="compare-row"><span class="clabel">${k.replace(/_/g," ")}</span>
            <span class="ctrack"><span class="cfill" style="width:${r.scores[k]}%"></span></span><span class="cval">${r.scores[k].toFixed(0)}</span></div>
          <div class="compare-row"><span class="clabel" style="color:var(--muted-dim);font-size:10px;">baseline</span>
            <span class="ctrack"><span class="cfill baseline" style="width:${baseline.scores[k]}%"></span></span><span class="cval" style="color:var(--muted)">${baseline.scores[k].toFixed(0)}</span></div>
        `).join("")}
      </div>
    </div>
    <div class="panel panel-pad">
      <div class="panel-title" style="font-size:12.5px;">Failure Categories</div>
      <div class="dist-list section-gap">${Object.entries(failedByCategory).sort((a,b)=>b[1]-a[1]).map(([cat,count],i) => `
        <div class="dist-row"><span class="dname"><span class="sw" style="background:${CATEGORY_SWATCH[i%CATEGORY_SWATCH.length]}"></span>${cat}</span><span class="dval">${count}</span></div>
      `).join("")}</div>
    </div>
    <div class="panel panel-pad">
      <div class="panel-title" style="font-size:12.5px;">Scenario Distribution</div>
      <div class="dist-list section-gap">${Object.entries(counts).map(([cat,count],i) => `
        <div class="dist-row"><span class="dname"><span class="sw" style="background:${CATEGORY_SWATCH[i%CATEGORY_SWATCH.length]}"></span>${CATEGORY_LABELS[cat]||cat}</span><span class="dval">${count}</span></div>
      `).join("")}</div>
    </div>
  `;

  renderConsistencySpotlight();
  renderScenarioGuide();
  renderFilters();
  renderTests();
}

function failureCategoryOf(t) {
  // Prefer the machine-readable category backend/evaluator.py assigns
  // from actual evidence. Fall back to the old heuristic only for a
  // report.json generated before this field existed.
  if (t.failure_category) return FAILURE_CATEGORY_LABELS[t.failure_category] || t.failure_category;
  if (t.risk_violation) return "Risk violation";
  if (t.consistency_flagged) return "Inconsistency";
  if (t.human_takeover) return "Human takeover";
  return "Stress failure";
}

function categoryCounts() {
  const tests = current().tests;
  const counts = {};
  for (const t of tests) counts[t.category] = (counts[t.category] || 0) + 1;
  return counts;
}

/* The killer feature: same numbers, five wordings, does the decision change. */
function renderConsistencySpotlight() {
  const el = document.getElementById("ct-consistency");
  const groups = {};
  state.reports.report.tests.filter(t => t.category === "prompt_perturbation").forEach(t => {
    groups[t.base_state_id] = groups[t.base_state_id] || [];
    groups[t.base_state_id].push(t);
  });
  const flaggedGroupId = Object.keys(groups).find(id => groups[id][0].consistency_flagged);
  const group = flaggedGroupId ? groups[flaggedGroupId] : Object.values(groups)[0];
  if (!group) { el.innerHTML = ""; return; }
  group.sort((a,b) => a.phrasing_variant.localeCompare(b.phrasing_variant));

  el.innerHTML = `
    <div class="panel-title" style="font-size:12.5px;">Consistency spotlight <span class="badge ${flaggedGroupId ? 'fail' : 'pass'}" style="margin-left:6px;">${flaggedGroupId ? 'INCONSISTENT' : 'CONSISTENT'}</span></div>
    <div class="panel-desc">Base scenario <span class="badge dim">${group[0].base_state_id}</span> &mdash; identical underlying market state, five different phrasings.</div>
    <div class="consistency-variants">
      ${group.map(v => `
        <div class="consistency-variant ${v.consistency_flagged ? 'flagged' : ''}">
          <div class="vlabel">VARIANT ${v.phrasing_variant.toUpperCase()}</div>
          <div class="vdecision">${v.agent_decision.action} ${v.agent_decision.position_size_pct}%</div>
        </div>
      `).join("")}
    </div>
    <div class="consistency-note">${flaggedGroupId
      ? '"Same market state, semantically equivalent presentation, materially different decision."'
      : 'This group\'s decisions stayed consistent across all five phrasings.'}</div>
  `;
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

function renderScenarioGuide() {
  const el = document.getElementById("scenario-guide");
  const counts = categoryCounts();
  el.innerHTML = `
    <div class="category-grid">
      <div class="category-chip ${state.activeCategory === null ? "active" : ""}" data-cat="">
        <span>All categories</span><span class="cat-count">${current().tests.length}</span>
      </div>
      ${Object.entries(counts).map(([cat, count]) => `
        <div class="category-chip ${state.activeCategory === cat ? "active" : ""}" data-cat="${cat}">
          <span>${CATEGORY_LABELS[cat] || cat}</span><span class="cat-count">${count}</span>
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

function renderFilters() {
  const el = document.getElementById("tests-filters");
  const options = [["all","All"],["failed","Failed"],["risk","Risk"],["consistency","Inconsistent"],["takeover","Takeover"]];
  el.innerHTML = options.map(([key, label]) => `<button class="filter-btn ${state.activeFilter === key ? "active" : ""}" data-filter="${key}">${label}</button>`).join("");
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

  document.getElementById("tests-tbody").innerHTML = pageTests.map((t, i) => `
    <tr class="clickable" data-replay="${t.scenario_id}">
      <td>${start + i + 1}</td>
      <td style="font-family:var(--sans);">${CATEGORY_LABELS[t.category] || t.category}</td>
      <td>${t.market_state.symbol}</td>
      <td>${t.agent_decision.action} ${t.agent_decision.position_size_pct}%</td>
      <td>${t.risk_verdict.approved_action} ${t.risk_verdict.approved_position_size_pct}%</td>
      <td><span class="badge ${t.passed ? "pass" : "fail"}">${t.passed ? "PASS" : "FAIL"}</span></td>
    </tr>
  `).join("");
  wireReplayLinks(document.getElementById("tests-tbody"));

  const pag = document.getElementById("pagination");
  pag.innerHTML = `
    <button id="prev-page" ${state.page === 0 ? "disabled" : ""}>&larr; Prev</button>
    <span>Page ${state.page + 1} of ${totalPages} &middot; ${tests.length} tests</span>
    <button id="next-page" ${state.page >= totalPages - 1 ? "disabled" : ""}>Next &rarr;</button>
  `;
  document.getElementById("prev-page").addEventListener("click", () => { state.page--; renderTests(); });
  document.getElementById("next-page").addEventListener("click", () => { state.page++; renderTests(); });
}

/* ================= FAILURE REPLAY PAGE ================= */

function allFailedForReplay() {
  const filterText = state.replayFilterText.toLowerCase();
  return current().tests.filter(t => !t.passed).filter(t =>
    !filterText || t.scenario_id.toLowerCase().includes(filterText) || (CATEGORY_LABELS[t.category]||"").toLowerCase().includes(filterText)
  );
}

function renderFailureReplayPage() {
  const failed = allFailedForReplay();
  if (!state.replaySelectedId && failed.length) state.replaySelectedId = failed[0].scenario_id;

  const listEl = document.getElementById("replay-list");
  listEl.innerHTML = failed.map(t => `
    <div class="replay-list-item ${t.scenario_id === state.replaySelectedId ? 'active' : ''}" data-id="${t.scenario_id}">
      <div class="rid">${t.scenario_id}</div>
      <div class="rcat">${failureCategoryOf(t)}</div>
    </div>
  `).join("") || `<div class="hint-empty" style="margin:12px;">No failed scenarios match</div>`;

  listEl.querySelectorAll(".replay-list-item").forEach(item => {
    item.addEventListener("click", () => { state.replaySelectedId = item.dataset.id; renderFailureReplayPage(); });
  });

  const t = current().tests.find(x => x.scenario_id === state.replaySelectedId);
  document.getElementById("replay-detail").innerHTML = t ? buildReplayChain(t) : `<div class="hint-empty">Select a failed scenario</div>`;
}

document.getElementById("replay-search").addEventListener("input", (e) => {
  state.replayFilterText = e.target.value;
  renderFailureReplayPage();
});

function buildReplayChain(t) {
  const ms = t.market_state, dec = t.agent_decision, risk = t.risk_verdict;
  return `
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px;">
      <div>
        <div class="panel-title">${t.scenario_id}</div>
        <div class="panel-desc" style="margin-bottom:0;">${CATEGORY_LABELS[t.category]||t.category} &middot; ${ms.symbol} &middot; variant ${t.phrasing_variant}</div>
      </div>
      <span class="badge ${t.passed ? 'pass' : 'fail'}">${t.passed ? 'PASSED' : 'FAILED'}</span>
    </div>

    <div class="chain-step pass"><h4>Market state</h4><div class="body kv-grid">
      <div class="kv"><div class="k">Symbol</div><div class="v">${ms.symbol}</div></div>
      <div class="kv"><div class="k">Price</div><div class="v">${ms.price}</div></div>
      <div class="kv"><div class="k">Return</div><div class="v">${ms.return_pct.toFixed(2)}%</div></div>
      <div class="kv"><div class="k">Volatility</div><div class="v">${ms.volatility}</div></div>
      <div class="kv"><div class="k">Volume vs avg</div><div class="v">${ms.volume_ratio}x</div></div>
      <div class="kv"><div class="k">Drawdown</div><div class="v">${ms.assumed_drawdown_pct}%</div></div>
      <div class="kv"><div class="k">Liquidity/position</div><div class="v">${ms.current_position_pct}%</div></div>
      <div class="kv"><div class="k">Market status</div><div class="v">${ms.is_market_open ? 'OPEN' : 'CLOSED'}</div></div>
    </div></div>

    <div class="chain-step pass"><h4>Information received</h4><div class="body"><div class="narrative-quote">&ldquo;${ms.narrative}&rdquo;</div></div></div>

    <div class="chain-step ${risk.violations.length ? 'fail':'pass'}"><h4>Agent decision</h4><div class="body">
      Action: <strong>${dec.action}</strong> &middot; Requested position: <strong>${dec.position_size_pct}%</strong> &middot; confidence ${dec.confidence}
      <div style="margin-top:5px;color:var(--muted);font-size:11px;">${dec.rationale}</div>
    </div></div>

    <div class="chain-step ${risk.violations.length ? 'fail':'pass'}"><h4>Risk evaluation</h4><div class="body">
      Approved action: <strong>${risk.approved_action}</strong> at <strong>${risk.approved_position_size_pct}%</strong>
      &middot; Modified: <strong>${risk.was_modified ? 'YES' : 'NO'}</strong>
      ${risk.violations.length ? `<ul class="violation-list">${risk.violations.map(v=>`<li>Violation: ${v}</li>`).join("")}</ul>` : ""}
      <div style="margin-top:5px;font-size:11px;color:var(--muted);">Agent-proposed: ${dec.position_size_pct}% &rarr; Executed (risk-approved): ${risk.approved_position_size_pct}%</div>
    </div></div>

    <div class="chain-step pass"><h4>Execution / portfolio impact</h4><div class="body">
      Illustrative pnl this probe: <strong>${fmtMoney(t.illustrative_pnl)}</strong> &middot; cumulative at this point: <strong>${fmtMoney(t.cumulative_illustrative_pnl)}</strong>
      <div style="margin-top:4px;font-size:10.5px;color:var(--muted-dim);">Illustrative synthetic figure &mdash; not real trading P&amp;L.</div>
    </div></div>

    ${t.consistency_flagged ? `<div class="chain-step fail"><h4>Consistency failure</h4><div class="body">
      One of 5 reworded versions of the identical market state (group ${t.base_state_id}). Actions across the group: ${t.consistency_group_actions.join(", ")},
      position-size spread ${t.consistency_group_size_spread} pts &mdash; on numbers that never changed, only the wording did.
    </div></div>` : ""}

    <div class="chain-step ${t.human_takeover ? 'fail':'pass'}"><h4>${t.human_takeover ? 'Human takeover triggered (simulated)' : 'No human takeover required'}</h4><div class="body">
      ${t.human_takeover ? 'Multiple simultaneous risk breaches crossed the threshold for a simulated forced human review.' : 'Stayed within a single risk boundary, if any.'}
    </div></div>

    <div class="chain-step fail"><h4>Failure</h4><div class="body">${failureCategoryOf(t)}</div></div>
  `;
}

/* ================= PAPER TRADING PAGE ================= */

function renderEquitySVG(equityCurve) {
  const w = 760, h = 140, pad = 20;
  const values = equityCurve.map(p => p.cumulative_pnl_usdt);
  const min = Math.min(0, ...values), max = Math.max(0, ...values);
  const range = (max - min) || 1;
  const step = (w - pad * 2) / (equityCurve.length - 1);
  const points = equityCurve.map((p, i) => {
    const x = pad + i * step;
    const y = h - pad - ((p.cumulative_pnl_usdt - min) / range) * (h - pad * 2);
    return `${x},${y}`;
  }).join(" ");
  const zeroY = h - pad - ((0 - min) / range) * (h - pad * 2);
  const lastPositive = values[values.length - 1] >= 0;
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">
    <line x1="${pad}" y1="${zeroY}" x2="${w-pad}" y2="${zeroY}" stroke="#232B3D" stroke-width="1" stroke-dasharray="3,3" />
    <polyline points="${points}" fill="none" stroke="${lastPositive?'#3ED68C':'#F1555C'}" stroke-width="1.5" />
  </svg>`;
}

function renderPaperTradingPage() {
  const el = document.getElementById("paper-trading-content");
  const real = state.real && state.real.report;

  if (!real) {
    el.innerHTML = `<div class="hint-empty">No real trading data available yet. Run the paper-trading agent, compute metrics, and re-export via <code>polygraph_ingestion.export_for_dashboard</code>.
      ${state.real && state.real.unavailable_reason ? `<br><br><span style="font-family:var(--mono);font-size:10.5px;">${state.real.unavailable_reason}</span>` : ""}</div>`;
    return;
  }

  const m = real.metrics, trades = real.completed_trades, openPos = real.open_position;

  el.innerHTML = `
    <span class="provenance-pill real">BITGET DEMO / REAL EXECUTION EVIDENCE</span>
    <div class="panel-title">Bitget Demo Paper Trading</div>
    <div class="panel-desc">BTCUSDT &middot; Demo environment &middot; ${m.trade_count} completed trade${m.trade_count===1?'':'s'}</div>

    <div class="stat-row cols-4">
      <div class="stat-cell"><div class="stat-label">Completed trades</div><div class="stat-value">${m.trade_count}</div></div>
      <div class="stat-cell"><div class="stat-label">Net P&amp;L</div>${m.cumulative_pnl_usdt!==null?`<div class="stat-value ${m.cumulative_pnl_usdt>=0?'pass':'fail'}">${fmtMoney(m.cumulative_pnl_usdt)}</div>`:`<div class="stat-value na">INSUFFICIENT SAMPLE</div>`}</div>
      <div class="stat-cell"><div class="stat-label">Win rate</div>${m.win_rate_pct!==null?`<div class="stat-value">${m.win_rate_pct.toFixed(1)}%</div>`:`<div class="stat-value na">INSUFFICIENT SAMPLE</div>`}</div>
      <div class="stat-cell"><div class="stat-label">Current position</div><div class="stat-value ${openPos?'pass':''}">${openPos?'LONG':'FLAT'}</div></div>
    </div>
    <div class="stat-row cols-4 section-gap">
      <div class="stat-cell"><div class="stat-label">Max drawdown</div>${m.max_drawdown_usdt!==null?`<div class="stat-value fail">${fmtMoney(-Math.abs(m.max_drawdown_usdt))}</div>`:`<div class="stat-value na">N/A</div>`}</div>
      <div class="stat-cell"><div class="stat-label">Sharpe ratio</div>${m.sharpe_ratio!==null?`<div class="stat-value">${m.sharpe_ratio}</div>`:`<div class="stat-value na">NOT COMPUTED</div>`}</div>
      <div class="stat-cell"><div class="stat-label">Latest execution</div><div class="stat-value" style="font-size:12px;">${latestExecTime(real)}</div></div>
      <div class="stat-cell"><div class="stat-label">Sample size</div><div class="stat-value ${m.trade_count>=30?'pass':'warn'}">n = ${m.trade_count}</div></div>
    </div>
    ${m.sample_size_warning ? `<div class="foot-note section-gap">${m.sample_size_warning}</div>` : ""}
    ${m.fee_data_warning ? `<div class="foot-note">${m.fee_data_warning}</div>` : ""}

    <div class="panel panel-pad section-gap">
      <div class="panel-title" style="font-size:12.5px;">Agent execution timeline</div>
      <div class="section-gap" id="pt-exec-timeline"></div>
    </div>

    <div class="panel panel-pad section-gap">
      <div class="panel-title" style="font-size:12.5px;">Equity curve</div>
      ${m.equity_curve.length >= 2 ? `<div class="section-gap">${renderEquitySVG(m.equity_curve)}</div>` :
        `<div class="hint-empty section-gap">Insufficient sample for an equity curve &mdash; ${m.trade_count} completed trade${m.trade_count===1?'':'s'} recorded. At least 2 are needed.</div>`}
    </div>

    <div class="panel panel-pad section-gap">
      <div class="panel-title" style="font-size:12.5px;">Trade history</div>
      <div class="table-scroll section-gap">
        <table class="dtable"><thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Entry Px</th><th>Exit Px</th><th>Entry Decision</th><th>Exit Decision</th><th>Fees</th><th>Net P&amp;L</th><th>Return</th></tr></thead>
        <tbody>${trades.length ? newestFirst(trades).map((t, i) => `
          <tr>
            <td>${shortTs(t.exit_time)}</td>
            <td>BTCUSDT</td>
            <td><span class="badge fail">SELL</span></td>
            <td>${t.qty_base}</td>
            <td>${t.entry_price}</td>
            <td>${t.exit_price}</td>
            <td>${provenanceBadge(t.entry_decision_source)}${llmDetailToggle(`entry-${i}`, t.entry_llm_reason, t.entry_llm_confidence)}</td>
            <td>${provenanceBadge(t.exit_decision_source)}${llmDetailToggle(`exit-${i}`, t.exit_llm_reason, t.exit_llm_confidence)}</td>
            <td>${t.total_fees_usdt!==null?fmtMoney(t.total_fees_usdt):'N/A'}</td>
            <td class="${t.net_pnl_usdt===null?'':(t.net_pnl_usdt>=0?'pass':'fail')}" style="${t.net_pnl_usdt===null?'color:var(--warn)':''}">${t.net_pnl_usdt!==null?fmtMoney(t.net_pnl_usdt):'Fee data incomplete'}</td>
            <td class="${t.return_pct===null?'':(t.return_pct>=0?'pass':'fail')}">${t.return_pct!==null?t.return_pct.toFixed(2)+'%':`Gross: ${fmtMoney(t.gross_pnl_usdt)}`}</td>
          </tr>`).join("") : `<tr><td colspan="11" style="text-align:center;color:var(--muted);font-family:var(--sans);">No completed trades yet</td></tr>`}
        </tbody></table>
      </div>
    </div>

    ${openPos ? `<div class="panel panel-pad section-gap">
      <div class="panel-title" style="font-size:12.5px;">Open position</div>
      <div class="kv-grid section-gap">
        <div class="kv"><div class="k">Entry time</div><div class="v">${openPos.entry_time}</div></div>
        <div class="kv"><div class="k">Entry price</div><div class="v">${openPos.entry_price}</div></div>
        <div class="kv"><div class="k">Quantity</div><div class="v">${openPos.qty_base} BTC</div></div>
      </div>
      <div class="foot-note">Not counted in win rate, P&amp;L, or Sharpe above until closed.</div>
    </div>` : ""}
  `;
  renderExecutionTimeline("pt-exec-timeline", real);
  wireLlmDetailToggles(el);
}

/* ================= PAPER TRADING (FUTURES) ================= */
/* Deliberately separate from renderPaperTradingPage() above: different
 * data file (data/real_futures_trading.json), different position model
 * (LONG/SHORT/FLAT, leverage), and futures P&L here is explicitly
 * approximate (see pnl_basis on each trade / pnl_methodology_note) since
 * Bitget's close-positions endpoint doesn't return a confirmed fill
 * price - the UI surfaces that caveat rather than hiding it. Never
 * merged into the spot page or its numbers. */

function renderFuturesPaperTradingPage() {
  const el = document.getElementById("futures-paper-trading-content");
  const real = state.realFutures && state.realFutures.report;

  if (!real) {
    el.innerHTML = `<div class="hint-empty">No real futures trading data available yet. Run <code>npm run paper:futures</code>, compute metrics with <code>real_metrics/compute_futures_metrics.py</code>, and re-export via <code>polygraph_ingestion.export_for_dashboard</code>.
      ${state.realFutures && state.realFutures.unavailable_reason ? `<br><br><span style="font-family:var(--mono);font-size:10.5px;">${state.realFutures.unavailable_reason}</span>` : ""}</div>`;
    return;
  }

  const m = real.metrics, trades = real.completed_trades, openPos = real.open_position;

  el.innerHTML = `
    <span class="provenance-pill real">BITGET DEMO / REAL FUTURES EXECUTION EVIDENCE (APPROXIMATE P&amp;L)</span>
    <div class="panel-title">Bitget Demo Futures Paper Trading</div>
    <div class="panel-desc">BTCUSDT USDT-margined &middot; Demo environment &middot; ${m.trade_count} completed trade${m.trade_count===1?'':'s'}</div>
    <div class="foot-note">${m.pnl_methodology_note || ''}</div>

    <div class="stat-row cols-4 section-gap">
      <div class="stat-cell"><div class="stat-label">Completed trades</div><div class="stat-value">${m.trade_count}</div></div>
      <div class="stat-cell"><div class="stat-label">Approx. net P&amp;L</div>${m.cumulative_approx_pnl_usdt!==null?`<div class="stat-value ${m.cumulative_approx_pnl_usdt>=0?'pass':'fail'}">${fmtMoney(m.cumulative_approx_pnl_usdt)}</div>`:`<div class="stat-value na">INSUFFICIENT SAMPLE</div>`}</div>
      <div class="stat-cell"><div class="stat-label">Win rate</div>${m.win_rate_pct!==null?`<div class="stat-value">${m.win_rate_pct.toFixed(1)}%</div>`:`<div class="stat-value na">INSUFFICIENT SAMPLE</div>`}</div>
      <div class="stat-cell"><div class="stat-label">Current position</div><div class="stat-value ${openPos?'pass':''}">${openPos?openPos.side:'FLAT'}</div></div>
    </div>
    <div class="stat-row cols-4 section-gap">
      <div class="stat-cell"><div class="stat-label">Approx. max drawdown</div>${m.max_drawdown_approx_usdt!==undefined && m.max_drawdown_approx_usdt!==null?`<div class="stat-value fail">${fmtMoney(-Math.abs(m.max_drawdown_approx_usdt))}</div>`:`<div class="stat-value na">N/A</div>`}</div>
      <div class="stat-cell"><div class="stat-label">Sharpe ratio</div>${m.sharpe_ratio!==null?`<div class="stat-value">${m.sharpe_ratio}</div>`:`<div class="stat-value na">NOT COMPUTED</div>`}</div>
      <div class="stat-cell"><div class="stat-label">Leverage cap</div><div class="stat-value">${trades.length ? trades[0].leverage+'x' : (openPos&&openPos.leverage ? openPos.leverage+'x' : 'N/A')}</div></div>
      <div class="stat-cell"><div class="stat-label">Sample size</div><div class="stat-value ${m.trade_count>=30?'pass':'warn'}">n = ${m.trade_count}</div></div>
    </div>
    ${m.sample_size_warning ? `<div class="foot-note section-gap">${m.sample_size_warning}</div>` : ""}
    ${m.trades_with_missing_pnl ? `<div class="foot-note">${m.trades_with_missing_pnl} trade(s) excluded above - PnL data missing on the closing log line.</div>` : ""}

    <div class="panel panel-pad section-gap">
      <div class="panel-title" style="font-size:12.5px;">Equity curve (approximate)</div>
      ${m.equity_curve && m.equity_curve.length >= 2 ? `<div class="section-gap">${renderEquitySVG(m.equity_curve.map(p => ({cumulative_pnl_usdt: p.cumulative_approx_pnl_usdt})))}</div>` :
        `<div class="hint-empty section-gap">Insufficient sample for an equity curve &mdash; ${m.trade_count} completed trade${m.trade_count===1?'':'s'} recorded. At least 2 are needed.</div>`}
    </div>

    <div class="panel panel-pad section-gap">
      <div class="panel-title" style="font-size:12.5px;">Trade history</div>
      <div class="table-scroll section-gap">
        <table class="dtable"><thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Leverage</th><th>Entry Px</th><th>Approx. Exit Px</th><th>Entry Decision</th><th>Exit Decision</th><th>Approx. P&amp;L</th></tr></thead>
        <tbody>${trades.length ? newestFirst(trades).map((t, i) => `
          <tr>
            <td>${shortTs(t.exit_time)}</td>
            <td>BTCUSDT</td>
            <td><span class="badge ${t.side==='LONG'?'pass':'fail'}">${t.side}</span></td>
            <td>${t.qty_base}</td>
            <td>${t.leverage!==null?t.leverage+'x':'N/A'}</td>
            <td>${t.entry_price}</td>
            <td>${t.approx_exit_price!==null?t.approx_exit_price+' (approx.)':'N/A'}</td>
            <td>${provenanceBadge(t.entry_decision_source)}${llmDetailToggle(`fut-entry-${i}`, t.entry_llm_reason, t.entry_llm_confidence)}</td>
            <td>${provenanceBadge(t.exit_decision_source)}${llmDetailToggle(`fut-exit-${i}`, t.exit_llm_reason, t.exit_llm_confidence)}</td>
            <td class="${t.approx_realized_pnl_usdt===null?'':(t.approx_realized_pnl_usdt>=0?'pass':'fail')}" style="${t.approx_realized_pnl_usdt===null?'color:var(--warn)':''}">${t.approx_realized_pnl_usdt!==null?fmtMoney(t.approx_realized_pnl_usdt):'Missing'}</td>
          </tr>`).join("") : `<tr><td colspan="10" style="text-align:center;color:var(--muted);font-family:var(--sans);">No completed trades yet</td></tr>`}
        </tbody></table>
      </div>
    </div>

    ${openPos ? `<div class="panel panel-pad section-gap">
      <div class="panel-title" style="font-size:12.5px;">Open position</div>
      <div class="kv-grid section-gap">
        <div class="kv"><div class="k">Side</div><div class="v">${openPos.side}</div></div>
        <div class="kv"><div class="k">Entry time</div><div class="v">${openPos.entry_time}</div></div>
        <div class="kv"><div class="k">Entry price</div><div class="v">${openPos.entry_price}</div></div>
        <div class="kv"><div class="k">Quantity</div><div class="v">${openPos.qty_base} BTC</div></div>
        <div class="kv"><div class="k">Leverage</div><div class="v">${openPos.leverage!==null?openPos.leverage+'x':'N/A'}</div></div>
      </div>
      <div class="foot-note">Not counted in win rate, P&amp;L, or Sharpe above until closed.</div>
    </div>` : ""}
  `;
  wireLlmDetailToggles(el);
}

/* ================= CRASH TESTS (FUTURES / POLYGRAPH) ================= */
/* Reads data/futures_crashtest.json, produced by the TypeScript Polygraph
 * CLI (agent/src/polygraph/run.ts) via `npm run polygraph -- --out=...` -
 * entirely separate pipeline from the Python synthetic benchmark above
 * (different agent, different scenario engine, different failure
 * taxonomy), never merged into it. Pure synthetic/simulated evaluation:
 * no real Bitget order is ever placed to produce this data. */

const FUTURES_FAILURE_LABELS = {
  risk_violation: "Risk violation",
  decision_inconsistency: "Decision inconsistency",
  invalid_action: "Invalid action",
  unsafe_reversal: "Unsafe reversal",
  malformed_decision: "Malformed decision",
  evidence_conflict: "Evidence conflict",
  agent_error: "Provider error",
};

const PROVIDER_ERROR_LABELS = {
  network: "Network / DNS failure",
  timeout: "Timeout",
  rate_limited: "HTTP 429 rate limit",
  quota_exhausted: "HTTP 429 quota exhausted",
  auth: "Authentication / key",
  provider_http_error: "Provider HTTP error",
  malformed_response: "Malformed provider response",
  config_error: "Configuration error",
  unknown: "Unclassified error",
};

const RUN_KIND_LABELS = { deterministic: "DETERMINISTIC", adversarial: "ADVERSARIAL", llm: "LLM" };

function escHtml(v) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* null/undefined means "not computable or withheld" - never rendered as "null%", 0% or 100%. */
function fmtPctNA(v) { return v === null || v === undefined ? "n/a" : `${v}%`; }

/* Reports written before run metadata existed have no `run` block: infer from the agent
 * name and say so, rather than presenting a guess as fact. */
function futuresRunInfo(r) {
  if (r.run) return { kind: r.run.kind, provider: r.run.provider, model: r.run.model, inferred: false };
  // Imported legacy file: the history index recorded what could be inferred (and says which fields).
  const entry = (state.futuresRuns || []).find(e => e.runId === r.runId);
  if (entry && entry.imported) {
    return { kind: entry.kind, provider: entry.provider, model: entry.model, inferred: true,
             inferredFields: entry.imported.inferred, byKind: entry.providerErrorsByKind };
  }
  const name = r.agent || "";
  const kind = /LLM/i.test(name) ? "llm" : /Rule-Based/i.test(name) ? "deterministic"
    : /Fixed-Action|Malformed|adversarial/i.test(name) ? "adversarial" : null;
  return { kind, provider: null, model: null, inferred: true };
}

function futuresProviderErrorCounts(r) {
  const s = r.scorecard;
  if (s.providerErrorsByKind) return s.providerErrorsByKind;
  const info = futuresRunInfo(r);
  if (info.byKind && Object.keys(info.byKind).length) return info.byKind;
  return null; // legacy report: breakdown unknown, only the flat count exists
}

async function selectFuturesRun(file) {
  if (!file) { state.futuresView = null; renderFuturesCrashTestsPage(); return; }
  try {
    const res = await fetch(`data/runs/${encodeURIComponent(file)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.futuresView = { file, report: await res.json() };
  } catch (e) {
    alert(`Could not load run file ${file}: ${e.message}`);
    return;
  }
  renderFuturesCrashTestsPage();
}

function renderFuturesHistory(activeRunId) {
  const runs = state.futuresRuns;
  if (!runs || runs.length === 0) {
    return `<div class="hint-empty section-gap">No run history yet. Runs started with <code>--out</code> (or <code>--history-dir</code>) are stored in <code>data/runs/</code>; existing reports can be imported with <code>import-history</code>.</div>`;
  }
  return `<div class="table-scroll section-gap">
    <table class="dtable"><thead><tr><th>When</th><th>Type</th><th>Agent / model</th><th>Scenarios</th><th>Passed</th><th>Provider errors</th><th>Reliability</th><th>Status</th><th></th></tr></thead>
    <tbody>${runs.map(e => `
      <tr>
        <td style="font-family:var(--mono);font-size:10.5px;">${escHtml(e.generatedAt.replace("T", " ").slice(0, 16))}</td>
        <td><span class="badge ${e.kind === "llm" ? "neutral" : "dim"}">${RUN_KIND_LABELS[e.kind] || escHtml(e.kind)}</span></td>
        <td>${escHtml(e.agent)}${e.model ? `<br><span style="color:var(--muted);font-size:10px;">${escHtml(e.provider || "")} ${escHtml(e.model)}</span>` : ""}</td>
        <td>${e.scenarios}</td>
        <td>${e.passed}/${e.answeredScenarios}</td>
        <td class="${e.agentErrors > 0 ? "fail" : ""}">${e.agentErrors}</td>
        <td>${fmtPctNA(e.decisionReliabilityPct)}</td>
        <td>${e.validity === "valid" ? `<span class="badge pass">VALID</span>` : `<span class="badge warn">INVALID &mdash; PROVIDER FAILURES</span>`}${e.imported ? ` <span class="badge dim" title="${escHtml(e.imported.note)}">IMPORTED</span>` : ""}</td>
        <td>${e.runId === activeRunId ? `<span style="color:var(--muted);">viewing</span>` : `<a href="#" onclick="selectFuturesRun('${escHtml(e.file)}');return false;">view</a>`}</td>
      </tr>`).join("")}
    </tbody></table></div>`;
}

function renderFuturesCrashTestsPage() {
  const el = document.getElementById("futures-crash-tests-content");
  const r = state.futuresView ? state.futuresView.report : state.futuresCrashTests;

  if (!r) {
    el.innerHTML = `<div class="hint-empty">No futures crash-test report available yet. From <code>agent/</code>, run:<br><br>
      <code>npm run polygraph -- --out=../frontend/data/futures_crashtest.json</code><br><br>
      then reload this dashboard.</div>`;
    return;
  }

  const s = r.scorecard;
  const info = futuresRunInfo(r);
  const invalid = s.validity === "invalid_provider_failures";
  const agentErrors = s.agentErrors || 0;
  const answered = s.answeredScenarios ?? s.scenarios;
  const mutChanged = r.mutationResults.filter(m => m.decisionChanged).length;
  const mutFlagged = r.mutationResults.filter(m => m.failureCategory === "decision_inconsistency").length;
  const providerFailures = r.failures.filter(f => f.failure.category === "agent_error");
  const agentFailures = r.failures.filter(f => f.failure.category !== "agent_error");
  const errsByRegime = {};
  providerFailures.forEach(f => { errsByRegime[f.scenario.regime] = (errsByRegime[f.scenario.regime] || 0) + 1; });
  const byKind = futuresProviderErrorCounts(r);

  const kindBadge = info.kind
    ? `<span class="badge ${info.kind === "llm" ? "neutral" : "dim"}">${RUN_KIND_LABELS[info.kind]}${info.inferred ? " (inferred)" : ""}</span>`
    : `<span class="badge warn">UNKNOWN RUN TYPE</span>`;

  el.innerHTML = `
    <span class="provenance-pill synthetic">SYNTHETIC / SIMULATED EVALUATION &mdash; NO REAL BITGET ORDERS PLACED</span>
    <div class="panel-title">Agent Polygraph &mdash; Futures Crash Test ${kindBadge}</div>
    <div class="panel-desc">Agent: ${escHtml(r.agent)}${info.model ? ` &middot; Model: ${escHtml(info.provider || "?")} / ${escHtml(info.model)}${info.inferred ? " (taken from the provider's own error text; the original report did not record it)" : ""}` : ""} &middot; Seed: ${escHtml(r.seed)} &middot; Generated: ${escHtml(r.generatedAt)} &middot; ${s.scenarios} scenarios across ${r.regimeResults.length} market regimes</div>
    ${info.kind === "deterministic" ? `<div class="foot-note">Deterministic rule-based run: this is NOT an LLM result and says nothing about how an LLM agent behaves.</div>` : ""}
    ${info.kind === "adversarial" ? `<div class="foot-note">Adversarial scripted agent: it exists to prove the risk engine catches violations. It is not a trading strategy or an LLM result.</div>` : ""}
    ${state.futuresView ? `<div class="foot-note">Viewing a stored run from history. <a href="#" onclick="selectFuturesRun(null);return false;">Back to the latest report</a></div>` : ""}

    ${invalid ? `
    <div class="panel panel-pad section-gap" style="border:1px solid var(--warn);">
      <div class="panel-title" style="font-size:12.5px;color:var(--warn);">INVALID RUN &mdash; PROVIDER FAILURES</div>
      <div class="foot-note">${agentErrors} of ${s.scenarios} scenarios (${fmtPctNA(s.agentErrorRatePct)}) ended in a provider, network or API error before the agent could answer. This run measured the provider, not the agent: agent-quality percentages are withheld (n/a) and provider errors are not counted as agent failures. Do not quote anything here as agent performance.</div>
    </div>` : ""}

    <div class="stat-row cols-4 section-gap">
      <div class="stat-cell"><div class="stat-label">Scenarios</div><div class="stat-value">${s.scenarios}</div></div>
      <div class="stat-cell"><div class="stat-label">Answered by agent</div><div class="stat-value">${answered}</div></div>
      <div class="stat-cell"><div class="stat-label">Passed</div><div class="stat-value pass">${s.passed}</div></div>
      <div class="stat-cell"><div class="stat-label">Agent failures</div><div class="stat-value ${s.failed>0?'fail':''}">${s.failed}</div></div>
    </div>
    <div class="stat-row cols-4 section-gap">
      <div class="stat-cell"><div class="stat-label">Provider errors (not agent failures)</div><div class="stat-value ${agentErrors>0?'fail':''}">${agentErrors}</div></div>
      <div class="stat-cell"><div class="stat-label">Decision reliability</div><div class="stat-value">${fmtPctNA(s.decisionReliabilityPct)}</div></div>
      <div class="stat-cell"><div class="stat-label">Risk compliance</div><div class="stat-value">${fmtPctNA(s.riskCompliancePct)}</div></div>
      <div class="stat-cell"><div class="stat-label">Decision consistency</div><div class="stat-value">${fmtPctNA(s.decisionConsistencyPct)}</div></div>
    </div>
    <div class="stat-row cols-4 section-gap">
      <div class="stat-cell"><div class="stat-label">Position management</div><div class="stat-value">${fmtPctNA(s.positionManagementPct)}</div></div>
      <div class="stat-cell"><div class="stat-label">Scenario coverage</div><div class="stat-value">${fmtPctNA(s.scenarioCoveragePct)}</div></div>
    </div>

    <div class="panel panel-pad section-gap">
      <div class="panel-title" style="font-size:12.5px;">Agent failure categories</div>
      <div class="kv-grid section-gap">
        <div class="kv"><div class="k">Risk violations</div><div class="v">${s.riskViolations}</div></div>
        <div class="kv"><div class="k">Decision inconsistencies</div><div class="v">${s.consistencyFailures}</div></div>
        <div class="kv"><div class="k">Invalid actions</div><div class="v">${s.invalidActions}</div></div>
        <div class="kv"><div class="k">Unsafe reversals</div><div class="v">${s.unsafeReversals}</div></div>
        <div class="kv"><div class="k">Malformed decisions</div><div class="v">${s.malformedDecisions}</div></div>
      </div>
    </div>

    ${agentErrors > 0 ? `
    <div class="panel panel-pad section-gap">
      <div class="panel-title" style="font-size:12.5px;">Provider errors by cause</div>
      <div class="foot-note">These say nothing about the model's trading judgement. The scenario shows HOLD only because the harness records a fallback; it is flagged as an error, never scored as a model decision.</div>
      ${byKind ? `<div class="kv-grid section-gap">${Object.entries(byKind).map(([k, n]) => `<div class="kv"><div class="k">${PROVIDER_ERROR_LABELS[k] || escHtml(k)}</div><div class="v">${n}</div></div>`).join("")}</div>`
               : `<div class="hint-empty section-gap">This report predates the per-cause breakdown: ${agentErrors} provider errors in total, causes not recorded.</div>`}
    </div>` : ""}

    <div class="panel panel-pad section-gap">
      <div class="panel-title" style="font-size:12.5px;">Regime results</div>
      <div class="table-scroll section-gap">
        <table class="dtable"><thead><tr><th>Regime</th><th>Passed</th><th>Agent failures</th><th>Provider errors</th></tr></thead>
        <tbody>${r.regimeResults.map(rr => {
          const e = errsByRegime[rr.regime] || 0;
          const af = rr.failed - e;
          return `
          <tr>
            <td>${rr.regime.replace(/_/g," ")}</td>
            <td class="pass">${rr.passed}/${rr.scenarios}</td>
            <td class="${af>0?'fail':''}">${af}</td>
            <td class="${e>0?'fail':''}">${e}</td>
          </tr>`; }).join("")}
        </tbody></table>
      </div>
    </div>

    <div class="panel panel-pad section-gap">
      <div class="panel-title" style="font-size:12.5px;">Mutation testing (decision-consistency check)</div>
      ${r.mutationResults.length === 0
        ? `<div class="hint-empty section-gap">${invalid ? "Skipped: the run was invalid because the provider was failing." : "No mutation comparisons ran, so decision consistency is n/a (not 100%)."}</div>`
        : `<div class="foot-note">${r.mutationResults.length} total checks (bounded sample, not exhaustive) &mdash; one small field change at a time, holding everything else fixed. A decision change is only flagged if it's not explained by the size of the change or a real threshold being crossed.</div>
      <div class="kv-grid section-gap">
        <div class="kv"><div class="k">Decisions changed</div><div class="v">${mutChanged}/${r.mutationResults.length}</div></div>
        <div class="kv"><div class="k">Flagged as inconsistent</div><div class="v">${mutFlagged}</div></div>
      </div>`}
    </div>

    <div class="panel panel-pad section-gap">
      <div class="panel-title" style="font-size:12.5px;">Agent failures${agentFailures.length ? ` (${agentFailures.length})` : ""}</div>
      ${agentFailures.length === 0 ? `<div class="hint-empty section-gap">${invalid ? "None recorded among the scenarios the agent answered &mdash; but this run is invalid, so that is not a clean result." : `No agent failures detected in this run. This means the agent passed every scenario generated &mdash; not a general safety guarantee: coverage is limited to these ${r.regimeResults.length} regimes and the mutation sample above.`}</div>` : `
      <div class="table-scroll section-gap">
        <table class="dtable"><thead><tr><th>Regime</th><th>Category</th><th>Agent decision</th><th>Why flagged</th></tr></thead>
        <tbody>${agentFailures.slice(0, 30).map(f => `
          <tr>
            <td>${f.scenario.regime.replace(/_/g," ")}<br><span style="color:var(--muted);font-size:10px;">${escHtml(f.scenario.description)}</span></td>
            <td><span class="badge fail">${FUTURES_FAILURE_LABELS[f.failure.category] || escHtml(f.failure.category)}</span></td>
            <td>${escHtml(f.agentDecision.decision.action)} <span style="color:var(--muted);">(${escHtml(f.agentDecision.decision.confidence)})</span></td>
            <td style="font-size:11px;">${f.failure.details.map(escHtml).join("<br>")}</td>
          </tr>`).join("")}
        </tbody></table>
      </div>`}
    </div>

    ${providerFailures.length ? `
    <div class="panel panel-pad section-gap">
      <div class="panel-title" style="font-size:12.5px;">Provider errors (${providerFailures.length})</div>
      <div class="table-scroll section-gap">
        <table class="dtable"><thead><tr><th>Regime</th><th>Cause</th><th>Provider message</th></tr></thead>
        <tbody>${providerFailures.slice(0, 30).map(f => `
          <tr>
            <td>${f.scenario.regime.replace(/_/g," ")}</td>
            <td><span class="badge warn">${PROVIDER_ERROR_LABELS[f.failure.providerErrorKind] || "Provider error"}</span></td>
            <td style="font-size:10.5px;font-family:var(--mono);">${escHtml((f.agentDecision.agentError || "").slice(0, 220))}</td>
          </tr>`).join("")}
        </tbody></table>
      </div>
    </div>` : ""}

    <div class="panel panel-pad section-gap">
      <div class="panel-title" style="font-size:12.5px;">Run history (Futures)</div>
      <div class="foot-note">Every stored run, newest first. Deterministic, adversarial and LLM runs are separate rows and are never averaged together.</div>
      ${renderFuturesHistory(r.runId)}
    </div>
  `;
}

/* ================= SYSTEM / EVIDENCE PAGE ================= */

function renderSystemPage() {
  const el = document.getElementById("system-content");
  const r = state.reports.report.summary;
  const real = state.real && state.real.report;

  el.innerHTML = `
    <div class="grid-2">
      <div class="panel panel-pad">
        <div class="panel-title" style="font-size:12.5px;">Scenario Engine</div>
        <div class="kv-grid section-gap">
          <div class="kv"><div class="k">Seed</div><div class="v">${state.meta.seed}</div></div>
          <div class="kv"><div class="k">Scenario count</div><div class="v">${state.meta.scenario_count}</div></div>
          <div class="kv"><div class="k">Generation time</div><div class="v">${state.meta.elapsed_seconds}s</div></div>
          <div class="kv"><div class="k">Generated (unix)</div><div class="v">${state.meta.generated_at_unix}</div></div>
        </div>
      </div>
      <div class="panel panel-pad">
        <div class="panel-title" style="font-size:12.5px;">Synthetic Specimen</div>
        <div class="kv-grid section-gap">
          <div class="kv"><div class="k">Specimen type</div><div class="v">${r.agent_name}</div></div>
          <div class="kv"><div class="k">Simulated</div><div class="v">${r.is_simulated ? 'YES' : 'NO'}</div></div>
          <div class="kv"><div class="k">Specimen adapter</div><div class="v">${state.meta.agent_mode}</div></div>
          <div class="kv"><div class="k">Run ID</div><div class="v">seed-${state.meta.seed}</div></div>
        </div>
      </div>
    </div>

    <div class="panel panel-pad section-gap">
      <div class="panel-title" style="font-size:12.5px;">Evidence</div>
      <div class="kv-grid section-gap">
        <div class="kv"><div class="k">Paper-trading log</div><div class="v">${real && real.data_source ? real.data_source.log_path : 'N/A'}</div></div>
        <div class="kv"><div class="k">Scenario report</div><div class="v">data/report.json</div></div>
        <div class="kv"><div class="k">Baseline report</div><div class="v">data/baseline_report.json</div></div>
        <div class="kv"><div class="k">Real report generated</div><div class="v">N/A</div></div>
      </div>
    </div>

    <div class="grid-2 section-gap">
      <div class="panel panel-pad">
        <span class="provenance-pill synthetic">SYNTHETIC TEST EVIDENCE</span>
        <div class="kv-grid section-gap">
          <div class="kv"><div class="k">Status</div><div class="v" style="color:var(--pass)">LOADED</div></div>
          <div class="kv"><div class="k">Tests</div><div class="v">${r.total_tests}</div></div>
          <div class="kv"><div class="k">Reliability</div><div class="v">${r.scores.reliability.toFixed(1)}%</div></div>
        </div>
      </div>
      <div class="panel panel-pad">
        <span class="provenance-pill real">REAL PAPER-TRADING EVIDENCE</span>
        <div class="kv-grid section-gap">
          <div class="kv"><div class="k">Status</div><div class="v" style="color:${real?'var(--pass)':'var(--warn)'}">${real ? 'LOADED' : 'NOT YET AVAILABLE'}</div></div>
          <div class="kv"><div class="k">Trades</div><div class="v">${real ? real.metrics.trade_count : 'N/A'}</div></div>
          <div class="kv"><div class="k">Provenance</div><div class="v">${real && real.data_source ? real.data_source.allowed_provenance.join(', ') : 'N/A'}</div></div>
        </div>
      </div>
    </div>
  `;
}

/* ================= BOOT ================= */

function renderAll() {
  renderTopStatus();
  renderOverviewPage();
  renderCrashTestsPage();
  renderPaperTradingPage();
  renderFuturesPaperTradingPage();
  renderFuturesCrashTestsPage();
  renderSystemPage();
}

document.getElementById("agent-select").addEventListener("change", (e) => {
  state.activeAgentKey = e.target.value;
  state.activeCategory = null;
  state.activeFilter = "all";
  state.page = 0;
  renderCrashTestsPage();
});

loadData().then(renderAll).catch(err => {
  document.getElementById("overview-top").innerHTML =
    `<p style="color:var(--fail);grid-column:1/-1;padding:20px;">Could not load report data: ${err}. Run backend/main.py first, then serve this folder.</p>`;
  const dot = document.getElementById("status-dot"); dot.classList.add("fail");
  document.getElementById("status-value").textContent = "Error";
});