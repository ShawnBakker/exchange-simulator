import { useState, useEffect, useRef, useCallback } from 'react';
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, ReferenceLine } from 'recharts';

// Import from modular engine instead of duplicating
import { Rng } from '../engine/rng';
import { OrderBook, resetTradeSeq } from '../engine/orderbook';
import { MarketMaker, resetMMSeq } from '../agents/market-maker';
import { resetTraderSeq, INFORMED_EDGE_THRESHOLD } from '../agents/traders';

type Side = 'buy' | 'sell';
type TraderType = 'mm' | 'informed' | 'noise';

let orderSeq = 0;
function resetOrderSeq() { orderSeq = 0; }

interface SimConfig {
  seed: number;
  initialPrice: number;
  volatility: number;
  jumpProb: number;
  jumpSize: number;
  mmBaseSpread: number;
  mmSize: number;
  mmAdaptRate: number;
  mmInventorySkew: number;
  informedRatio: number;
  arrivalRate: number;
}

interface SimTrade {
  id: string;
  ts: number;
  price: number;
  qty: number;
  takerType: TraderType;
  makerType: TraderType;
  takerSide: Side;
  trueValue: number;
  makerId: string;
}

class Simulation {
  private rng: Rng;
  private book: OrderBook;
  private mm: MarketMaker;
  private trueValue: number;
  private config: SimConfig;
  private tick = 0;

  constructor(config: SimConfig) {
    this.config = config;
    resetTradeSeq(); resetMMSeq(); resetTraderSeq(); resetOrderSeq();
    this.rng = new Rng(config.seed);
    this.book = new OrderBook();
    this.trueValue = config.initialPrice;
    this.book.trueValue = this.trueValue;
    this.mm = new MarketMaker(config.mmBaseSpread, config.mmSize, config.mmAdaptRate, config.mmInventorySkew);
  }

  step() {
    const ts = this.tick * 100;
    this.mm.quote(this.book, ts).forEach(o => this.book.submit(o as any));

    const diff = this.rng.normal(0, this.config.volatility);
    const jump = this.rng.bool(this.config.jumpProb) ? (this.rng.bool() ? this.config.jumpSize : -this.config.jumpSize) : 0;
    this.trueValue = Math.max(0.01, this.trueValue * (1 + diff + jump));
    this.book.trueValue = this.trueValue;

    const isInformed = this.rng.bool(this.config.informedRatio);
    let order: any = null;

    if (this.rng.bool(this.config.arrivalRate)) {
      if (isInformed) {
        const mid = this.book.mid ?? this.trueValue;
        const edge = (this.trueValue - mid) / mid;
        if (Math.abs(edge) > INFORMED_EDGE_THRESHOLD) {
          order = { id: `inf-${++orderSeq}`, traderId: `inf-${orderSeq}`, traderType: 'informed', side: edge > 0 ? 'buy' : 'sell', type: 'market', price: 0, qty: this.rng.int(5, 20), filled: 0, ts };
        }
      } else {
        order = { id: `noise-${++orderSeq}`, traderId: `noise-${orderSeq}`, traderType: 'noise', side: this.rng.bool() ? 'buy' : 'sell', type: 'market', price: 0, qty: this.rng.int(1, 10), filled: 0, ts };
      }
    }

    let tickTrades: SimTrade[] = [];
    if (order) {
      tickTrades = this.book.submit(order).map(t => ({ id: t.id, ts: t.ts, price: t.price, qty: t.qty, takerType: t.takerType, makerType: t.makerType, takerSide: t.takerSide, trueValue: t.trueValue, makerId: t.makerId }));
    }
    tickTrades.forEach(t => this.mm.onTrade(t as any, this.trueValue));
    this.tick++;

    const stats = this.mm.stats;
    return {
      tick: this.tick, trueValue: this.trueValue, mid: this.book.mid, spread: this.book.spread,
      mmPnl: this.mm.pnl, mmInventory: this.mm.inventory, mmSpread: this.mm.quotedSpread,
      adverseRatio: this.mm.getAdverseRatio(), levels: this.book.getLevels(), trades: tickTrades,
      spreadPnl: stats.spreadPnl, inventoryPnl: stats.inventoryPnl, avgRealizedSpread: stats.avgRealizedSpread, fillCount: stats.fillCount
    };
  }

  reset(config: SimConfig) {
    this.config = config;
    resetTradeSeq(); resetMMSeq(); resetTraderSeq(); resetOrderSeq();
    this.rng = new Rng(config.seed);
    this.book = new OrderBook();
    this.trueValue = config.initialPrice;
    this.book.trueValue = this.trueValue;
    this.mm = new MarketMaker(config.mmBaseSpread, config.mmSize, config.mmAdaptRate, config.mmInventorySkew);
    this.tick = 0;
  }
}

const defaultConfig: SimConfig = {
  seed: 42, initialPrice: 100, volatility: 0.0015, jumpProb: 0.02, jumpSize: 0.015,
  mmBaseSpread: 0.12, mmSize: 100, mmAdaptRate: 0.15, mmInventorySkew: 0.0005,
  informedRatio: 0.25, arrivalRate: 0.4
};

interface DataPoint {
  tick: number; trueValue: number; mid: number | null; mmPnl: number; mmSpread: number;
  adverseRatio: number; spreadPnl: number; inventoryPnl: number; inventory: number;
}

function Stat({ label, value, color = '#e0e0e0' }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: '#555', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 14, color, fontWeight: 500 }}>{value}</div>
    </div>
  );
}

function BookRow({ side, price, qty, maxQty }: { side: 'bid' | 'ask'; price: number; qty: number; maxQty: number }) {
  const pct = (qty / maxQty) * 100;
  const color = side === 'bid' ? '#22c55e' : '#ef4444';
  return (
    <div style={{ display: 'flex', alignItems: 'center', fontSize: 11, height: 22, position: 'relative' }}>
      <div style={{ position: 'absolute', [side === 'bid' ? 'left' : 'right']: 0, top: 0, bottom: 0, width: `${pct}%`, background: color, opacity: 0.15 }} />
      <span style={{ width: 70, color }}>{price.toFixed(2)}</span>
      <span style={{ color: '#666' }}>{qty}</span>
    </div>
  );
}

export default function ExchangeSimulator() {
  const [config, setConfig] = useState(defaultConfig);
  const [running, setRunning] = useState(false);
  const [data, setData] = useState<DataPoint[]>([]);
  const [currentState, setCurrentState] = useState<ReturnType<Simulation['step']> | null>(null);
  const simRef = useRef<Simulation | null>(null);
  const intervalRef = useRef<number | null>(null);

  useEffect(() => {
    simRef.current = new Simulation(config);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []);

  const tick = useCallback(() => {
    if (!simRef.current) return;
    const state = simRef.current.step();
    setCurrentState(state);
    setData(prev => [...prev, { tick: state.tick, trueValue: state.trueValue, mid: state.mid, mmPnl: state.mmPnl, mmSpread: state.mmSpread, adverseRatio: state.adverseRatio, spreadPnl: state.spreadPnl, inventoryPnl: state.inventoryPnl, inventory: state.mmInventory }].slice(-200));
  }, []);

  const toggleRun = () => {
    if (running) { if (intervalRef.current) clearInterval(intervalRef.current); intervalRef.current = null; }
    else { intervalRef.current = window.setInterval(tick, 80); }
    setRunning(!running);
  };

  const reset = () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null; setRunning(false);
    simRef.current?.reset(config); setData([]); setCurrentState(null);
  };

  const updateConfig = (key: keyof SimConfig, value: number) => {
    const next = { ...config, [key]: value }; setConfig(next);
    if (!running) simRef.current?.reset(next);
  };

  const levels = currentState?.levels ?? { bids: [], asks: [] };
  const maxQty = Math.max(...[...levels.bids, ...levels.asks].map(l => l.qty), 1);
  const lastData = data[data.length - 1];

  return (
    <div style={{ background: '#0a0a0f', minHeight: '100vh', color: '#e0e0e0', fontFamily: "'JetBrains Mono', 'Fira Code', monospace", padding: 20 }}>
      <div style={{ maxWidth: 1400, margin: '0 auto' }}>
        <header style={{ marginBottom: 24, borderBottom: '1px solid #1a1a2e', paddingBottom: 16 }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 500, color: '#8b5cf6', letterSpacing: 1 }}>ADVERSE SELECTION SIMULATOR</h1>
          <p style={{ margin: '8px 0 0', fontSize: 12, color: '#666', maxWidth: 700 }}>Watch how informed order flow impacts market maker profitability. MM skews quotes based on inventory.</p>
        </header>

        <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 20 }}>
          <div style={{ background: '#0f0f18', borderRadius: 8, padding: 16 }}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
              <button onClick={toggleRun} style={{ flex: 1, padding: '10px 0', background: running ? '#dc2626' : '#22c55e', border: 'none', borderRadius: 4, color: '#fff', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13 }}>{running ? 'PAUSE' : 'RUN'}</button>
              <button onClick={reset} style={{ padding: '10px 16px', background: '#1a1a2e', border: '1px solid #333', borderRadius: 4, color: '#888', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13 }}>RESET</button>
            </div>

            <div style={{ fontSize: 11, color: '#666', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 1 }}>Parameters</div>
            {[
              { key: 'informedRatio', label: 'Informed Flow %', min: 0, max: 1, step: 0.05, fmt: (v: number) => `${(v * 100).toFixed(0)}%` },
              { key: 'arrivalRate', label: 'Order Arrival', min: 0.1, max: 0.8, step: 0.05, fmt: (v: number) => v.toFixed(2) },
              { key: 'mmBaseSpread', label: 'Base Spread', min: 0.02, max: 0.5, step: 0.02, fmt: (v: number) => `$${v.toFixed(2)}` },
              { key: 'mmInventorySkew', label: 'Inventory Skew', min: 0, max: 0.002, step: 0.0001, fmt: (v: number) => `${(v * 10000).toFixed(1)} bps` },
              { key: 'volatility', label: 'Volatility', min: 0.0005, max: 0.005, step: 0.0005, fmt: (v: number) => `${(v * 100).toFixed(2)}%` },
              { key: 'jumpProb', label: 'Jump Prob', min: 0, max: 0.1, step: 0.01, fmt: (v: number) => `${(v * 100).toFixed(0)}%` },
            ].map(({ key, label, min, max, step, fmt }) => (
              <div key={key} style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 11, color: '#888' }}>{label}</span>
                  <span style={{ fontSize: 11, color: '#8b5cf6' }}>{fmt(config[key as keyof SimConfig] as number)}</span>
                </div>
                <input type="range" min={min} max={max} step={step} value={config[key as keyof SimConfig] as number} onChange={e => updateConfig(key as keyof SimConfig, parseFloat(e.target.value))} style={{ width: '100%', accentColor: '#8b5cf6' }} />
              </div>
            ))}

            <div style={{ marginTop: 24, padding: 12, background: '#1a1a2e', borderRadius: 6 }}>
              <div style={{ fontSize: 10, color: '#666', marginBottom: 8, textTransform: 'uppercase' }}>Live Stats</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <Stat label="True Value" value={currentState?.trueValue?.toFixed(2) ?? '-'} />
                <Stat label="Mid" value={currentState?.mid?.toFixed(2) ?? '-'} />
                <Stat label="MM Spread" value={`$${currentState?.mmSpread?.toFixed(3) ?? '-'}`} color="#f59e0b" />
                <Stat label="Adverse %" value={`${((currentState?.adverseRatio ?? 0) * 100).toFixed(0)}%`} color={(currentState?.adverseRatio ?? 0) > 0.3 ? '#ef4444' : '#22c55e'} />
              </div>
            </div>

            <div style={{ marginTop: 16, padding: 12, background: '#1a1a2e', borderRadius: 6 }}>
              <div style={{ fontSize: 10, color: '#666', marginBottom: 8, textTransform: 'uppercase' }}>P&L Breakdown</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <Stat label="Spread P&L" value={`$${(currentState?.spreadPnl ?? 0).toFixed(2)}`} color={(currentState?.spreadPnl ?? 0) >= 0 ? '#22c55e' : '#ef4444'} />
                <Stat label="Inventory P&L" value={`$${(currentState?.inventoryPnl ?? 0).toFixed(2)}`} color={(currentState?.inventoryPnl ?? 0) >= 0 ? '#22c55e' : '#ef4444'} />
                <Stat label="Inventory" value={`${currentState?.mmInventory ?? 0}`} color={Math.abs(currentState?.mmInventory ?? 0) > 50 ? '#f59e0b' : '#888'} />
                <Stat label="Fills" value={`${currentState?.fillCount ?? 0}`} />
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ background: '#0f0f18', borderRadius: 8, padding: 16, height: 200 }}>
              <div style={{ fontSize: 11, color: '#666', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>MARKET MAKER P&L</span>
                <div style={{ display: 'flex', gap: 16, fontSize: 10 }}>
                  <span><span style={{ color: '#8b5cf6' }}>■</span> Total: <span style={{ color: (lastData?.mmPnl ?? 0) >= 0 ? '#22c55e' : '#ef4444', fontWeight: 600 }}>${(lastData?.mmPnl ?? 0).toFixed(2)}</span></span>
                  <span><span style={{ color: '#22c55e' }}>■</span> Spread: ${(lastData?.spreadPnl ?? 0).toFixed(2)}</span>
                  <span><span style={{ color: '#3b82f6' }}>■</span> Inv: ${(lastData?.inventoryPnl ?? 0).toFixed(2)}</span>
                </div>
              </div>
              <ResponsiveContainer width="100%" height="85%">
                <LineChart data={data}><XAxis dataKey="tick" hide /><YAxis domain={['auto', 'auto']} hide /><ReferenceLine y={0} stroke="#333" strokeDasharray="3 3" />
                  <Line type="monotone" dataKey="mmPnl" stroke="#8b5cf6" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="spreadPnl" stroke="#22c55e" strokeWidth={1} dot={false} strokeDasharray="4 2" />
                  <Line type="monotone" dataKey="inventoryPnl" stroke="#3b82f6" strokeWidth={1} dot={false} strokeDasharray="4 2" />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div style={{ background: '#0f0f18', borderRadius: 8, padding: 16, height: 120 }}>
              <div style={{ fontSize: 11, color: '#666', marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
                <span>INVENTORY</span><span style={{ color: Math.abs(lastData?.inventory ?? 0) > 50 ? '#f59e0b' : '#888' }}>{lastData?.inventory ?? 0} shares</span>
              </div>
              <ResponsiveContainer width="100%" height="85%">
                <LineChart data={data}><XAxis dataKey="tick" hide /><YAxis domain={['auto', 'auto']} hide /><ReferenceLine y={0} stroke="#333" strokeDasharray="3 3" />
                  <Line type="monotone" dataKey="inventory" stroke="#f59e0b" strokeWidth={1.5} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div style={{ background: '#0f0f18', borderRadius: 8, padding: 16, height: 120 }}>
              <div style={{ fontSize: 11, color: '#666', marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
                <span>QUOTED SPREAD</span><span style={{ color: '#f59e0b' }}>${(lastData?.mmSpread ?? config.mmBaseSpread).toFixed(3)}</span>
              </div>
              <ResponsiveContainer width="100%" height="85%">
                <LineChart data={data}><XAxis dataKey="tick" hide /><YAxis domain={['auto', 'auto']} hide /><ReferenceLine y={config.mmBaseSpread} stroke="#333" strokeDasharray="3 3" />
                  <Line type="monotone" dataKey="mmSpread" stroke="#f59e0b" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div style={{ background: '#0f0f18', borderRadius: 8, padding: 16, height: 120 }}>
              <div style={{ fontSize: 11, color: '#666', marginBottom: 8 }}>PRICE (true value vs mid)</div>
              <ResponsiveContainer width="100%" height="85%">
                <LineChart data={data}><XAxis dataKey="tick" hide /><YAxis domain={['auto', 'auto']} hide />
                  <Line type="monotone" dataKey="trueValue" stroke="#22c55e" strokeWidth={1.5} dot={false} />
                  <Line type="monotone" dataKey="mid" stroke="#3b82f6" strokeWidth={1.5} dot={false} strokeDasharray="4 2" />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div style={{ background: '#0f0f18', borderRadius: 8, padding: 16 }}>
              <div style={{ fontSize: 11, color: '#666', marginBottom: 12 }}>ORDER BOOK</div>
              <div style={{ display: 'flex', gap: 2, flexDirection: 'column' }}>
                {levels.asks.slice().reverse().map((level, i) => <BookRow key={`a-${i}`} side="ask" price={level.price} qty={level.qty} maxQty={maxQty} />)}
                <div style={{ height: 1, background: '#333', margin: '4px 0' }} />
                {levels.bids.map((level, i) => <BookRow key={`b-${i}`} side="bid" price={level.price} qty={level.qty} maxQty={maxQty} />)}
              </div>
            </div>
          </div>
        </div>

        <footer style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid #1a1a2e', fontSize: 11, color: '#444' }}>
          <p style={{ margin: 0 }}>Demonstrates adverse selection: when informed traders dominate, the market maker loses money and must widen spreads.</p>
          <p style={{ margin: '8px 0 0', color: '#333' }}>Edge threshold: {(INFORMED_EDGE_THRESHOLD * 10000).toFixed(0)} bps | Inventory skew shifts quotes to flatten position risk.</p>
        </footer>
      </div>
    </div>
  );
}
