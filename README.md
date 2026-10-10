# Agent Polygraph

**Crash-test autonomous trading agents before they trade real capital.**

Agent Polygraph is built around one principle: **test an agent's reliability before trusting it with capital.**

The project has three components that work together while remaining deliberately separate:

1. **Synthetic Polygraph** (`backend/`)  
   A Python crash-test harness that runs a trading agent through 1,000 controlled synthetic scenarios and evaluates reliability, not profitability.

2. **Bitget Demo Trading Agent** (`agent/`)  
   A real Node/TypeScript trading agent connected to Bitget's Demo Trading environment. It uses real market data, real risk gating, and real Demo fills. It uses simulated funds only. Nothing in this project touches a live account.

3. **Ingestion / Evidence Boundary** (`polygraph_ingestion/`)  
   The layer that allows the dashboard to display synthetic and real trading evidence side by side without ever combining them into a single score.

> **Important:** Synthetic scores and real trading metrics answer different questions and are never directly comparable.
>
> The synthetic side asks: **"Does this agent behave reliably under controlled stress?"**
>
> The real-trading side asks: **"What actually happened when this agent traded in Bitget's Demo environment?"**
>
> Neither replaces the other.

---

## Component 1: Synthetic Polygraph

Located in `backend/`.

The Synthetic Polygraph runs an agent through **1,000 deterministic and reproducible scenarios**. Given the same seed, the same scenarios are produced every time.

The scenarios cover **11 stress categories**, plus a dedicated decision-consistency test containing **60 market states**, with each state reworded five different ways while keeping the underlying numbers identical.

The harness measures:

- Pass/fail for every scenario, with a complete replay of market state → decision → risk evaluation → outcome
- Risk violations where the agent's proposed action breaks a defined hard rule
- Decision inconsistencies where the market numbers remain unchanged but the agent changes its decision because the wording changes
- Reliability
- Consistency
- Risk discipline
- Stress performance
- Execution discipline
- Performance relative to a deterministic fixed-rule baseline

The baseline answers an important question:

**Does autonomy actually add useful decision-making, or does it simply introduce additional failure modes?**

These are **synthetic crash-test results**.

They are **not** real trading performance, a backtest, or historical market data. The dashboard and generated reports explicitly identify them as synthetic evidence.

Run the tests with:

```bash
python3 -m unittest discover -s backend/tests -v
```

---

## Component 2: Bitget Demo Trading Agent

Located in `agent/`.

This is the project's real trading component. It uses Bitget's official `@bitget-ai/bitget-agent-sdk` and follows a complete market-data-to-fill chain:

```text
Real Bitget market data
        ↓
Market tool: "tickers"
        ↓
Deterministic trading decision
        ↓
Position-aware risk gate
        ↓
Bitget Demo order
        ↓
Demo fill
        ↓
Persistent trade log
```

The current decision logic is deliberately simple:

```text
Flat position
    → Buy

Already in position
    → Sell at ±0.5% from entry

Otherwise
    → Hold
```

Before an order is sent, the risk gate checks the current position state.

It refuses to buy when the agent is already in a position, caps a sell to the quantity actually held, and refuses to trade when the current price is unknown.

Orders are sent through Bitget's Demo Trading environment using the SDK's `paperTrading: true` configuration. This routes the request to the Demo environment through the appropriate request header rather than using a separate trading endpoint.

**This is Demo Trading. It does not use real capital. No order in this project has touched a live Bitget account.**

### State and safety controls

Position state is stored in:

```text
logs/position.<environment>.json
```

The state is checked before every decision so the agent cannot blindly buy while already holding a position or sell more than it actually owns.

A lock file prevents multiple instances from modifying the same trading state simultaneously:

```text
logs/agent.<environment>.lock
```

The agent also fails closed when state cannot be trusted.

If the position file exists but cannot be parsed, the agent does **not** assume the account is flat. It refuses to trade for that cycle instead.

That's intentional. Unknown state is a reason to stop, not a reason to guess.

### Running the agent

```bash
cd agent
npm install

npm run mock       # Bitget's official mock server, no credentials required
npm run paper      # Real Bitget Demo Trading, credentials required
npm run paper -- --once
```

The last command runs a single trading cycle instead of continuously polling.

See `agent/README.md` for the complete Demo API setup and credential requirements.

---

## Component 3: Ingestion / Evidence Boundary

Located in `polygraph_ingestion/`.

This layer keeps synthetic evidence and real trading evidence separate.

It contains two read-only adapters:

```text
synthetic_adapter.py
    ↓
frontend/data/report.json
    ↓
Synthetic evidence


real_trading_adapter.py
    ↓
real_metrics/real_report.json
    ↓
Real Bitget Demo evidence
```

The synthetic adapter loads the synthetic report without modifying it.

The real-trading adapter independently verifies the provenance declared by the real report before accepting it. It rejects any report containing mock-sourced records, even though the upstream metrics calculator is already expected to filter those records.

That gives the real-data path two independent provenance checks instead of relying on a single filter.

The boundary exposes the data through:

```python
get_polygraph_view()
```

which returns:

```json
{
  "synthetic": {},
  "real": {}
}
```

The two datasets remain separate all the way to the dashboard.

There is no combined Polygraph score that mixes synthetic reliability with real trading performance.

Run the ingestion tests with:

```bash
python3 -m unittest discover -s polygraph_ingestion/tests -v
```

---

## Real Trading Metrics

Located in `real_metrics/`.

`compute_metrics.py` reads the agent's persistent trade log and calculates:

- Sharpe ratio
- Maximum drawdown
- Win rate
- Cumulative P&L
- Equity curve

Only **confirmed Bitget Demo fills** tagged:

```text
source: "bitget_paper"
```

are included.

Mock-sourced records are excluded completely.

### Net P&L

`net_pnl_usdt` is calculated after fees.

Each leg's fee is converted to USDT using the actual execution price recorded for that fill.

If fee information is missing, or the fee currency is not supported by the calculator, the trade's:

```text
net_pnl_usdt
```

is set to `None`.

The corresponding:

```text
gross_pnl_usdt
```

is still reported.

The system never silently assumes that missing fee data means zero fees.

### Small sample sizes

The metrics layer also refuses to manufacture statistical certainty from tiny datasets.

With fewer than two completed trades:

```text
Sharpe = None
```

with an explanation.

With fewer than 30 completed trades, statistical metrics carry a:

```text
sample_size_warning
```

Zero completed trades produces:

```text
metric = None
```

not:

```text
metric = 0
```

There is a difference between **zero performance** and **no observations**. The report keeps that distinction intact.

Run the tests with:

```bash
python3 -m unittest discover -s real_metrics/tests -v
```

---

# Running the Project

The synthetic system and the real Demo trading loop are intentionally separate.

There is no single command that silently runs the real Bitget Demo agent end to end.

That's deliberate.

Real Demo trading requires credentials and real elapsed time. A script should not pretend that a few seconds of execution is equivalent to observing an agent over an actual trading period.

## Synthetic harness + dashboard

No credentials are required.

```bash
./run_demo.sh
```

This:

1. Generates the synthetic crash-test report
2. Loads whatever real trading evidence currently exists
3. Produces an honest "no data yet" result when no real evidence exists
4. Starts the dashboard at:

```text
http://localhost:8000
```

The dashboard clearly separates synthetic evidence from real Demo Trading evidence.

## Real Bitget Demo Trading

Run the agent separately:

```bash
cd agent
npm install
npm run paper
```

This requires:

```text
BITGET_API_KEY
BITGET_SECRET_KEY
BITGET_PASSPHRASE
```

After the agent has generated new Demo Trading history, update the metrics:

```bash
cd real_metrics

python3 compute_metrics.py \
  ../agent/logs/trades.paper.jsonl \
  --out real_report.json

cd ..

python3 -m polygraph_ingestion.export_for_dashboard
```

The dashboard can then be refreshed with the latest exported evidence.

---

# Running All Tests

```bash
python3 -m unittest discover -s backend/tests -v

python3 -m unittest discover -s real_metrics/tests -v

python3 -m unittest discover -s polygraph_ingestion/tests -v

cd agent
npm run build
npm run mock -- --once
```

The mock run uses Bitget's official mock environment and does not require trading credentials.

---

# About the Shipped Data

The following files are **exported snapshots**, not live data:

```text
frontend/data/real_trading.json
real_metrics/real_report.json
```

If they exist, they represent the trading log and metrics available at the time the export commands were last run.

They do **not** necessarily represent the current state of the Demo account.

Before treating the dashboard as current, regenerate the reports from the latest trade log.

---

# The Core Design Principle

Agent Polygraph does not try to answer one giant question called **"Is this trading agent good?"**

It separates the evidence.

**Synthetic Polygraph:**  
Can the agent survive controlled adversarial conditions without behaving unpredictably?

**Bitget Demo Trading:**  
What did the agent actually do when connected to a real exchange environment?

**Evidence Boundary:**  
Can both forms of evidence be presented without contaminating one with the other?

That separation is the point.

A good synthetic score does not prove profitable trading.

A profitable Demo run does not prove robust behavior.

**Agent Polygraph is built to make those distinctions visible before real capital is ever involved.**