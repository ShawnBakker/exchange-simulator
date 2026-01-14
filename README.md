# Adverse Selection Simulator

A real-time exchange simulator demonstrating how informed order flow impacts market maker profitability and forces spread widening.

![screenshot](screenshot.png)

## What is this?

Market makers provide liquidity by posting bid/ask quotes. They profit from the spread—buying low, selling high. But when *informed traders* (those with better information about the asset's true value) show up, they systematically pick off the market maker's quotes right before prices move. This is **adverse selection**.

This simulator lets you see it happen in real-time:

- See how the market maker's P&L crash when informed flow dominates
- Spreads automatically widen as the MM adapts to protect itself
- You'll be able to compare outcomes under different toxicity levels

## Local Run

```bash
npm install
npm run dev
```

Open http://localhost:5173

## Arch / Repo Structure

```
src/
├── types.ts           # Core data types
├── engine/
│   ├── rng.ts         # Seeded PRNG for reproducibility
│   ├── orderbook.ts   # Price-time priority matching
│   └── price-process.ts  # True value random walk
├── agents/
│   ├── market-maker.ts   # Adaptive quoting logic
│   └── traders.ts        # Informed + noise traders
├── simulation.ts      # Main loop tying it together
└── ui/
    └── App.tsx        # React visualization
```

## Parameters you can tweak

| Parameter | What it does |
|-----------|--------------|
| Informed Flow % | Fraction of orders from informed traders |
| Order Arrival | How frequently orders come in |
| Base Spread | MM's starting spread (before adaptation) |
| Volatility | How much the true value moves per tick |
| Jump Prob | Chance of a large price jump each tick |

## Things to try

1. **Baseline**: Informed flow to 0%. MM should steadily profit.
2. **Toxic flow**: You can set informed to 60%+. Watch P&L tank and spread blow out.
3. **High volatility + high toxicity**: The worst case, leads to spread going crazy.

## References

- Glosten & Milgrom (1985) - "Bid, Ask, and Transaction Prices"
- Kyle (1985) - "Continuous Auctions and Insider Trading"
- VPIN (Volume-Synchronized Probability of Informed Trading)

