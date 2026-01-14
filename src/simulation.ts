import { Rng } from './engine/rng';
import { OrderBook } from './engine/orderbook';
import { PriceProcess } from './engine/price-process';
import { MarketMaker } from './agents/market-maker';
import { NoiseTrader, InformedTrader } from './agents/traders';
import { Config, Trade, Metrics, BookSnapshot } from './types';

export interface SimState {
  tick: number;
  metrics: Metrics;
  book: BookSnapshot;
  trades: Trade[];
}

export type SimCallback = (state: SimState) => void;

export class Simulation {
  private config: Config;
  private rng: Rng;
  private book: OrderBook;
  private priceProcess: PriceProcess;
  private mm: MarketMaker;
  private noiseTrader: NoiseTrader;
  private informedTrader: InformedTrader;

  private tick = 0;
  private allTrades: Trade[] = [];
  private running = false;
  private callback: SimCallback | null = null;

  constructor(config: Config) {
    this.config = config;
    this.rng = new Rng(config.seed);
    this.book = new OrderBook();
    
    this.priceProcess = new PriceProcess(
      config.initialPrice,
      this.rng,
      config.volatility,
      config.jumpProb,
      config.jumpSize
    );

    this.mm = new MarketMaker(
      config.mmBaseSpread,
      config.mmSize,
      config.mmAdaptRate
    );

    this.noiseTrader = new NoiseTrader(this.rng);
    this.informedTrader = new InformedTrader(this.rng);

    this.book.trueValue = this.priceProcess.value;
  }

  onTick(cb: SimCallback) {
    this.callback = cb;
  }

  private runTick(): Trade[] {
    const ts = this.tick * this.config.tickMs;
    const tickTrades: Trade[] = [];

    // mm quotes
    const quotes = this.mm.quote(this.book, ts);
    quotes.forEach(o => this.book.submit(o));

    // incoming order flow
    const isInformed = this.rng.bool(this.config.informedRatio);
    
    let order;
    if (isInformed) {
      order = this.informedTrader.maybeOrder(
        ts,
        this.config.arrivalRate,
        this.book.mid ?? this.priceProcess.value,
        this.priceProcess.value
      );
    } else {
      order = this.noiseTrader.maybeOrder(ts, this.config.arrivalRate);
    }

    if (order) {
      const trades = this.book.submit(order);
      tickTrades.push(...trades);
    }

    // move true value
    const { newValue } = this.priceProcess.step();
    this.book.trueValue = newValue;

    // update mm state
    tickTrades.forEach(t => this.mm.onTrade(t, newValue));
    
    this.allTrades.push(...tickTrades);
    return tickTrades;
  }

  private getMetrics(): Metrics {
    const ts = this.tick * this.config.tickMs;
    const informedCount = this.allTrades.filter(t => t.takerType === 'informed').length;
    const adverseCount = this.allTrades.filter(t => 
      t.makerType === 'mm' && t.takerType === 'informed'
    ).length;

    return {
      ts,
      trueValue: this.priceProcess.value,
      mid: this.book.mid,
      spread: this.book.spread,
      mmPnl: this.mm.pnl,
      mmInventory: this.mm.inventory,
      mmSpread: this.mm.quotedSpread,
      tradeCount: this.allTrades.length,
      informedCount,
      adverseCount
    };
  }

  step(): SimState {
    const trades = this.runTick();
    const state: SimState = {
      tick: this.tick,
      metrics: this.getMetrics(),
      book: this.book.snapshot(this.tick * this.config.tickMs),
      trades
    };
    this.tick++;
    return state;
  }

  async run(realtime = false) {
    this.running = true;
    
    while (this.running && this.tick < this.config.ticks) {
      const state = this.step();
      
      if (this.callback) {
        this.callback(state);
      }

      if (realtime) {
        await new Promise(r => setTimeout(r, this.config.tickMs));
      }
    }
  }

  stop() {
    this.running = false;
  }

  getTrades(): Trade[] {
    return this.allTrades;
  }

  getCurrentState(): SimState {
    return {
      tick: this.tick,
      metrics: this.getMetrics(),
      book: this.book.snapshot(this.tick * this.config.tickMs),
      trades: []
    };
  }
}

export const defaultConfig: Config = {
  seed: 42,
  initialPrice: 100,
  volatility: 0.001,
  jumpProb: 0.02,
  jumpSize: 0.01,
  mmBaseSpread: 0.10,
  mmSize: 100,
  mmAdaptRate: 0.1,
  informedRatio: 0.2,
  arrivalRate: 0.3,
  tickMs: 100,
  ticks: 1000
};
