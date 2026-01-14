import { useState, useEffect, useRef, useCallback } from 'react';
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, ReferenceLine } from 'recharts';

class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0; }
  next() {
    this.s = (1664525 * this.s + 1013904223) >>> 0;
    return this.s / 0x100000000;
  }
  int(min: number, max: number) { return Math.floor(this.next() * (max - min + 1)) + min; }
  bool(p = 0.5) { return this.next() < p; }
  normal(mean = 0, std = 1) {
    const u1 = this.next(), u2 = this.next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * std + mean;
  }
}

type Side = 'buy' | 'sell';
type TraderType = 'mm' | 'informed' | 'noise';

interface Order {
  id: string;
  traderId: string;
  traderType: TraderType;
  side: Side;
  type: 'limit' | 'market';
  price: number;
  qty: number;
  filled: number;
  ts: number;
}

interface Trade {
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

let orderSeq = 0;
let tradeSeq = 0;

class OrderBook {
  private bids = new Map<number, Order[]>();
  private asks = new Map<number, Order[]>();
  private orderIndex = new Map<string, Order>();
  trueValue = 100;

  get bestBid() {
    const prices = [...this.bids.keys()].filter(p => (this.bids.get(p)?.length ?? 0) > 0);
    return prices.length ? Math.max(...prices) : null;
  }
  get bestAsk() {
    const prices = [...this.asks.keys()].filter(p => (this.asks.get(p)?.length ?? 0) > 0);
    return prices.length ? Math.min(...prices) : null;
  }
  get mid() {
    const bb = this.bestBid, ba = this.bestAsk;
    return bb !== null && ba !== null ? (bb + ba) / 2 : null;
  }
  get spread() {
    const bb = this.bestBid, ba = this.bestAsk;
    return bb !== null && ba !== null ? ba - bb : null;
  }

  submit(order: Order): Trade[] {
    const trades: Trade[] = [];
    const book = order.side === 'buy' ? this.asks : this.bids;
    const isBuy = order.side === 'buy';
    const prices = [...book.keys()].sort((a, b) => isBuy ? a - b : b - a);

    for (const price of prices) {
      if (order.filled >= order.qty) break;
      const canMatch = order.type === 'market' || (isBuy ? price <= order.price : price >= order.price);
      if (!canMatch) break;

      const queue = book.get(price)!;
      while (queue.length > 0 && order.filled < order.qty) {
        const maker = queue[0];
        const fillQty = Math.min(maker.qty - maker.filled, order.qty - order.filled);
        maker.filled += fillQty;
        order.filled += fillQty;

        trades.push({
          id: `t${++tradeSeq}`,
          ts: order.ts,
          price,
          qty: fillQty,
          takerType: order.traderType,
          makerType: maker.traderType,
          takerSide: order.side,
          trueValue: this.trueValue,
          makerId: maker.traderId
        });

        if (maker.filled >= maker.qty) {
          queue.shift();
          this.orderIndex.delete(maker.id);
        }
      }
      if (queue.length === 0) book.delete(price);
    }

    if (order.type === 'limit' && order.filled < order.qty) {
      const targetBook = order.side === 'buy' ? this.bids : this.asks;
      if (!targetBook.has(order.price)) targetBook.set(order.price, []);
      targetBook.get(order.price)!.push(order);
    }
    this.orderIndex.set(order.id, order);
    return trades;
  }

  cancelAll(traderId: string) {
    for (const [id, order] of this.orderIndex) {
      if (order.traderId !== traderId) continue;
      const book = order.side === 'buy' ? this.bids : this.asks;
      const queue = book.get(order.price);
      if (queue) {
        const idx = queue.findIndex(o => o.id === id);
        if (idx >= 0) queue.splice(idx, 1);
        if (queue.length === 0) book.delete(order.price);
      }
      this.orderIndex.delete(id);
    }
  }

  getLevels() {
    const bids = [...this.bids.entries()]
      .filter(([_, o]) => o.length > 0)
      .map(([p, o]) => ({ price: p, qty: o.reduce((s, x) => s + x.qty - x.filled, 0) }))
      .sort((a, b) => b.price - a.price)
      .slice(0, 5);
    const asks = [...this.asks.entries()]
      .filter(([_, o]) => o.length > 0)
      .map(([p, o]) => ({ price: p, qty: o.reduce((s, x) => s + x.qty - x.filled, 0) }))
      .sort((a, b) => a.price - b.price)
      .slice(0, 5);
    return { bids, asks };
  }
}

class MarketMaker {
  readonly id = 'mm';
  private baseSpread: number;
  private currentSpread: number;
  private size: number;
  private adaptRate: number;
  pnl = 0;
  inventory = 0;
  private recentTrades: boolean[] = [];

  constructor(baseSpread: number, size: number, adaptRate: number) {
    this.baseSpread = baseSpread;
    this.currentSpread = baseSpread;
    this.size = size;
    this.adaptRate = adaptRate;
  }

  get quotedSpread() { return this.currentSpread; }

  onTrade(trade: Trade, trueValueAfter: number) {
    if (trade.makerId !== this.id) return;
    const wasAdverse = trade.takerType === 'informed';

    if (trade.takerSide === 'buy') {
      this.pnl += trade.price * trade.qty;
      this.inventory -= trade.qty;
    } else {
      this.pnl -= trade.price * trade.qty;
      this.inventory += trade.qty;
    }

    const slippage = (trueValueAfter - trade.trueValue) * (trade.takerSide === 'buy' ? -1 : 1) * trade.qty;
    this.pnl += slippage;

    this.recentTrades.push(wasAdverse);
    if (this.recentTrades.length > 20) this.recentTrades.shift();

    if (this.recentTrades.length >= 5) {
      const adverseRatio = this.recentTrades.filter(Boolean).length / this.recentTrades.length;
      const target = this.baseSpread * (1 + adverseRatio * 3);
      this.currentSpread += (target - this.currentSpread) * this.adaptRate;
      this.currentSpread = Math.max(this.baseSpread * 0.5, this.currentSpread);
    }
  }

  quote(book: OrderBook, ts: number): Order[] {
    book.cancelAll(this.id);
    const mid = book.mid ?? book.trueValue;
    const half = this.currentSpread / 2;
    return [
      { id: `mm-b-${++orderSeq}`, traderId: this.id, traderType: 'mm', side: 'buy', type: 'limit', price: Math.round((mid - half) * 100) / 100, qty: this.size, filled: 0, ts },
      { id: `mm-a-${++orderSeq}`, traderId: this.id, traderType: 'mm', side: 'sell', type: 'limit', price: Math.round((mid + half) * 100) / 100, qty: this.size, filled: 0, ts }
    ];
  }

  getAdverseRatio() {
    return this.recentTrades.length ? this.recentTrades.filter(Boolean).length / this.recentTrades.length : 0;
  }
}

interface SimConfig {
  seed: number;
  initialPrice: number;
  volatility: number;
  jumpProb: number;
  jumpSize: number;
  mmBaseSpread: number;
  mmSize: number;
  mmAdaptRate: number;
  informedRatio: number;
  arrivalRate: number;
}

class Simulation {
  private rng: Rng;
  private book: OrderBook;
  private mm: MarketMaker;
  private trueValue: number;
  private config: SimConfig;
  private tick = 0;
  private allTrades: Trade[] = [];

  constructor(config: SimConfig) {
    this.config = config;
    this.rng = new Rng(config.seed);
    this.book = new OrderBook();
    this.trueValue = config.initialPrice;
    this.book.trueValue = this.trueValue;
    this.mm = new MarketMaker(config.mmBaseSpread, config.mmSize, config.mmAdaptRate);
  }

  step() {
    const ts = this.tick * 100;

    // mm quotes
    this.mm.quote(this.book, ts).forEach(o => this.book.submit(o));

    // order flow
    const isInformed = this.rng.bool(this.config.informedRatio);
    let order: Order | null = null;

    if (this.rng.bool(this.config.arrivalRate)) {
      if (isInformed) {
        const mid = this.book.mid ?? this.trueValue;
        const edge = (this.trueValue - mid) / mid;
        if (Math.abs(edge) > 0.001) {
          order = {
            id: `inf-${++orderSeq}`, traderId: `inf-${orderSeq}`, traderType: 'informed',
            side: edge > 0 ? 'buy' : 'sell', type: 'market', price: 0,
            qty: this.rng.int(5, 20), filled: 0, ts
          };
        }
      } else {
        order = {
          id: `noise-${++orderSeq}`, traderId: `noise-${orderSeq}`, traderType: 'noise',
          side: this.rng.bool() ? 'buy' : 'sell', type: 'market', price: 0,
          qty: this.rng.int(1, 10), filled: 0, ts
        };
      }
    }

    let tickTrades: Trade[] = [];
    if (order) tickTrades = this.book.submit(order);

    // move price
    const diff = this.rng.normal(0, this.config.volatility);
    const jump = this.rng.bool(this.config.jumpProb) ? (this.rng.bool() ? this.config.jumpSize : -this.config.jumpSize) : 0;
    this.trueValue = Math.max(0.01, this.trueValue * (1 + diff + jump));
    this.book.trueValue = this.trueValue;

    tickTrades.forEach(t => this.mm.onTrade(t, this.trueValue));
    this.allTrades.push(...tickTrades);
    this.tick++;

    return {
      tick: this.tick,
      trueValue: this.trueValue,
      mid: this.book.mid,
      spread: this.book.spread,
      mmPnl: this.mm.pnl,
      mmInventory: this.mm.inventory,
      mmSpread: this.mm.quotedSpread,
      adverseRatio: this.mm.getAdverseRatio(),
      levels: this.book.getLevels(),
      trades: tickTrades
    };
  }

  reset(config: SimConfig) {
    this.config = config;
    this.rng = new Rng(config.seed);
    this.book = new OrderBook();
    this.trueValue = config.initialPrice;
    this.book.trueValue = this.trueValue;
    this.mm = new MarketMaker(config.mmBaseSpread, config.mmSize, config.mmAdaptRate);
    this.tick = 0;
    this.allTrades = [];
  }
}

// ============ REACT UI ============

const defaultConfig: SimConfig = {
  seed: 42,
  initialPrice: 100,
  volatility: 0.0015,
  jumpProb: 0.02,
  jumpSize: 0.015,
  mmBaseSpread: 0.12,
  mmSize: 100,
  mmAdaptRate: 0.15,
  informedRatio: 0.25,
  arrivalRate: 0.4
};

interface DataPoint {
  tick: number;
  trueValue: number;
  mid: number | null;
  spread: number | null;
  mmPnl: number;
  mmSpread: number;
  adverseRatio: number;
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
    setData(prev => {
      const next = [...prev, {
        tick: state.tick,
        trueValue: state.trueValue,
        mid: state.mid,
        spread: state.spread,
        mmPnl: state.mmPnl,
        mmSpread: state.mmSpread,
        adverseRatio: state.adverseRatio
      }];
      return next.slice(-200);
    });
  }, []);

  const toggleRun = () => {
    if (running) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
    } else {
      intervalRef.current = window.setInterval(tick, 80);
    }
    setRunning(!running);
  };

  const reset = () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
    setRunning(false);
    simRef.current?.reset(config);
    setData([]);
    setCurrentState(null);
  };

  const updateConfig = (key: keyof SimConfig, value: number) => {
    const next = { ...config, [key]: value };
    setConfig(next);
    if (!running) simRef.current?.reset(next);
  };

  const levels = currentState?.levels ?? { bids: [], asks: [] };
  const maxQty = Math.max(...[...levels.bids, ...levels.asks].map(l => l.qty), 1);

  return (
    <div style={{ 
      background: '#0a0a0f', 
      minHeight: '100vh', 
      color: '#e0e0e0', 
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      padding: '20px'
    }}>
      <div style={{ maxWidth: 1200, margin: '0 auto' }}>
        <header style={{ marginBottom: 24, borderBottom: '1px solid #1a1a2e', paddingBottom: 16 }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 500, color: '#8b5cf6', letterSpacing: 1 }}>
            ADVERSE SELECTION SIMULATOR
          </h1>
          <p style={{ margin: '8px 0 0', fontSize: 12, color: '#666', maxWidth: 600 }}>
            informed order flow (toxic flow) impacts market maker profitability and forces spread widening.
          </p>
        </header>

        <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 20 }}>
          {/* Controls */}
          <div style={{ background: '#0f0f18', borderRadius: 8, padding: 16 }}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
              <button onClick={toggleRun} style={{
                flex: 1, padding: '10px 0', background: running ? '#dc2626' : '#22c55e',
                border: 'none', borderRadius: 4, color: '#fff', fontWeight: 600, cursor: 'pointer',
                fontFamily: 'inherit', fontSize: 13
              }}>
                {running ? 'PAUSE' : 'RUN'}
              </button>
              <button onClick={reset} style={{
                padding: '10px 16px', background: '#1a1a2e', border: '1px solid #333',
                borderRadius: 4, color: '#888', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13
              }}>
                RESET
              </button>
            </div>

            <div style={{ fontSize: 11, color: '#666', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 1 }}>
              Parameters
            </div>

            {[
              { key: 'informedRatio', label: 'Informed Flow %', min: 0, max: 1, step: 0.05, fmt: (v: number) => `${(v * 100).toFixed(0)}%` },
              { key: 'arrivalRate', label: 'Order Arrival', min: 0.1, max: 0.8, step: 0.05, fmt: (v: number) => v.toFixed(2) },
              { key: 'mmBaseSpread', label: 'Base Spread', min: 0.02, max: 0.5, step: 0.02, fmt: (v: number) => `$${v.toFixed(2)}` },
              { key: 'volatility', label: 'Volatility', min: 0.0005, max: 0.005, step: 0.0005, fmt: (v: number) => `${(v * 100).toFixed(2)}%` },
              { key: 'jumpProb', label: 'Jump Prob', min: 0, max: 0.1, step: 0.01, fmt: (v: number) => `${(v * 100).toFixed(0)}%` },
            ].map(({ key, label, min, max, step, fmt }) => (
              <div key={key} style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 11, color: '#888' }}>{label}</span>
                  <span style={{ fontSize: 11, color: '#8b5cf6' }}>{fmt(config[key as keyof SimConfig] as number)}</span>
                </div>
                <input
                  type="range" min={min} max={max} step={step}
                  value={config[key as keyof SimConfig] as number}
                  onChange={e => updateConfig(key as keyof SimConfig, parseFloat(e.target.value))}
                  style={{ width: '100%', accentColor: '#8b5cf6' }}
                />
              </div>
            ))}

            <div style={{ marginTop: 24, padding: 12, background: '#1a1a2e', borderRadius: 6 }}>
              <div style={{ fontSize: 10, color: '#666', marginBottom: 8, textTransform: 'uppercase' }}>Live Stats</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <Stat label="True Value" value={currentState?.trueValue?.toFixed(2) ?? '-'} />
                <Stat label="Mid" value={currentState?.mid?.toFixed(2) ?? '-'} />
                <Stat label="MM Spread" value={`$${currentState?.mmSpread?.toFixed(3) ?? '-'}`} color="#f59e0b" />
                <Stat label="Adverse %" value={`${((currentState?.adverseRatio ?? 0) * 100).toFixed(0)}%`} color={currentState?.adverseRatio && currentState.adverseRatio > 0.3 ? '#ef4444' : '#22c55e'} />
              </div>
            </div>
          </div>

          {/* Charts */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* PnL Chart */}
            <div style={{ background: '#0f0f18', borderRadius: 8, padding: 16, height: 180 }}>
              <div style={{ fontSize: 11, color: '#666', marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
                <span>MARKET MAKER P&L</span>
                <span style={{ color: (data[data.length - 1]?.mmPnl ?? 0) >= 0 ? '#22c55e' : '#ef4444', fontWeight: 600 }}>
                  ${(data[data.length - 1]?.mmPnl ?? 0).toFixed(2)}
                </span>
              </div>
              <ResponsiveContainer width="100%" height="85%">
                <LineChart data={data}>
                  <XAxis dataKey="tick" hide />
                  <YAxis domain={['auto', 'auto']} hide />
                  <ReferenceLine y={0} stroke="#333" strokeDasharray="3 3" />
                  <Line type="monotone" dataKey="mmPnl" stroke="#8b5cf6" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Spread Chart */}
            <div style={{ background: '#0f0f18', borderRadius: 8, padding: 16, height: 140 }}>
              <div style={{ fontSize: 11, color: '#666', marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
                <span>QUOTED SPREAD (adaptive)</span>
                <span style={{ color: '#f59e0b' }}>${(data[data.length - 1]?.mmSpread ?? config.mmBaseSpread).toFixed(3)}</span>
              </div>
              <ResponsiveContainer width="100%" height="85%">
                <LineChart data={data}>
                  <XAxis dataKey="tick" hide />
                  <YAxis domain={['auto', 'auto']} hide />
                  <ReferenceLine y={config.mmBaseSpread} stroke="#333" strokeDasharray="3 3" />
                  <Line type="monotone" dataKey="mmSpread" stroke="#f59e0b" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Price Chart */}
            <div style={{ background: '#0f0f18', borderRadius: 8, padding: 16, height: 140 }}>
              <div style={{ fontSize: 11, color: '#666', marginBottom: 8 }}>PRICE (true value vs mid)</div>
              <ResponsiveContainer width="100%" height="85%">
                <LineChart data={data}>
                  <XAxis dataKey="tick" hide />
                  <YAxis domain={['auto', 'auto']} hide />
                  <Line type="monotone" dataKey="trueValue" stroke="#22c55e" strokeWidth={1.5} dot={false} />
                  <Line type="monotone" dataKey="mid" stroke="#3b82f6" strokeWidth={1.5} dot={false} strokeDasharray="4 2" />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Order Book */}
            <div style={{ background: '#0f0f18', borderRadius: 8, padding: 16 }}>
              <div style={{ fontSize: 11, color: '#666', marginBottom: 12 }}>ORDER BOOK</div>
              <div style={{ display: 'flex', gap: 2, flexDirection: 'column' }}>
                {levels.asks.slice().reverse().map((level, i) => (
                  <BookRow key={`a-${i}`} side="ask" price={level.price} qty={level.qty} maxQty={maxQty} />
                ))}
                <div style={{ height: 1, background: '#333', margin: '4px 0' }} />
                {levels.bids.map((level, i) => (
                  <BookRow key={`b-${i}`} side="bid" price={level.price} qty={level.qty} maxQty={maxQty} />
                ))}
              </div>
            </div>
          </div>
        </div>

        <footer style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid #1a1a2e', fontSize: 11, color: '#444' }}>
          adverse selection: when informed traders dominate, the market maker loses money and needs to widen spread.
        </footer>
      </div>
    </div>
  );
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
      <div style={{
        position: 'absolute',
        [side === 'bid' ? 'left' : 'right']: 0,
        top: 0, bottom: 0,
        width: `${pct}%`,
        background: color,
        opacity: 0.15
      }} />
      <span style={{ width: 70, color }}>{price.toFixed(2)}</span>
      <span style={{ color: '#666' }}>{qty}</span>
    </div>
  );
}
