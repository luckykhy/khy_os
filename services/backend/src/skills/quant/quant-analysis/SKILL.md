---
name: quant-analysis
version: 1.0.0
description: AI-powered stock analysis with technical indicators, trend detection, and trading signal generation. Triggered when user asks to analyze a stock, check market conditions, or evaluate trading signals.
layer: domain
lifecycle: operations
tags: [quant, analysis, stock, technical-indicators, trading]
platforms: [khy-quant, claude-code]
maintainers:
  - khy-qqb
---

# Quantitative Analysis Skill

Analyze stocks and generate trading signals using technical indicators.

## When to Activate

- User asks to analyze a specific stock (e.g., "analyze 000001", "分析贵州茅台")
- User asks about market trends or conditions
- User requests trading signal evaluation
- User mentions technical indicators (MA, RSI, MACD, KDJ, BOLL)

## Analysis Pipeline

### Step 1: Data Retrieval
Fetch recent K-line data (daily, 60min) via the data service.
Required fields: open, high, low, close, volume, turnover.

### Step 2: Technical Indicator Calculation
Calculate the following indicators:
- **MA**: 5, 10, 20, 60 day moving averages
- **RSI**: 6, 12, 24 period relative strength index
- **MACD**: DIF, DEA, histogram
- **KDJ**: K, D, J values
- **BOLL**: upper, middle, lower bands
- **Volume**: volume MA comparison, volume-price divergence

### Step 3: Signal Generation
Based on indicator values, generate:
- Trend direction (bullish / bearish / neutral)
- Signal strength (strong / moderate / weak)
- Key support and resistance levels
- Risk assessment

### Step 4: Output Format
Present results as a structured analysis report:
1. Current price and trend summary
2. Key indicator readings
3. Trading signal with confidence level
4. Risk warnings

## Constraints

- Never provide specific buy/sell advice or price targets
- Always include risk disclaimers
- Data delay acknowledgment for real-time analysis
- Chinese market hours: 09:30-15:00 CST
