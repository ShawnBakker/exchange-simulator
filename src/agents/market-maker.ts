import { Order, Trade } from '../types';
import { OrderBook } from '../engine/orderbook';

let orderSeq = 0;

export class MarketMaker {
  readonly id = 'mm';
  private baseSpread: number;
  private currentSpread: number;
  private size: number;
  private adaptRate: number;

  pnl = 0;
  inventory = 0;
  private recentTrades: { adverse: boolean; ts: number }[] = [];
  private readonly windowSize = 20;

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
    
    // pnl from the trade itself
    if (trade.takerSide === 'buy') {
      // we sold
      this.pnl += trade.price * trade.qty;
      this.inventory -= trade.qty;
    } else {
      // we bought
      this.pnl -= trade.price * trade.qty;
      this.inventory += trade.qty;
    }

    const midAtTrade = trade.trueValue;
    const slippage = (trueValueAfter - midAtTrade) * 
      (trade.takerSide === 'buy' ? -1 : 1) * trade.qty;
    
    this.pnl += slippage;

    this.recentTrades.push({ adverse: wasAdverse, ts: trade.ts });
    if (this.recentTrades.length > this.windowSize) {
      this.recentTrades.shift();
    }

    this.adaptSpread();
  }

  private adaptSpread() {
    if (this.recentTrades.length < 5) return;

    const adverseRatio = this.recentTrades.filter(t => t.adverse).length / 
                         this.recentTrades.length;

    const target = this.baseSpread * (1 + adverseRatio * 3);
    this.currentSpread += (target - this.currentSpread) * this.adaptRate;

    this.currentSpread = Math.max(this.baseSpread * 0.5, this.currentSpread);
  }

  quote(book: OrderBook, ts: number): Order[] {
    book.cancelAll(this.id);

    const mid = book.mid ?? book.trueValue;
    const halfSpread = this.currentSpread / 2;

    const bid: Order = {
      id: `mm-b-${++orderSeq}`,
      traderId: this.id,
      traderType: 'mm',
      side: 'buy',
      type: 'limit',
      price: Math.round((mid - halfSpread) * 100) / 100,
      qty: this.size,
      filled: 0,
      ts
    };

    const ask: Order = {
      id: `mm-a-${++orderSeq}`,
      traderId: this.id,
      traderType: 'mm',
      side: 'sell',
      type: 'limit',
      price: Math.round((mid + halfSpread) * 100) / 100,
      qty: this.size,
      filled: 0,
      ts
    };

    return [bid, ask];
  }

  getAdverseRatio(): number {
    if (this.recentTrades.length === 0) return 0;
    return this.recentTrades.filter(t => t.adverse).length / this.recentTrades.length;
  }
}
