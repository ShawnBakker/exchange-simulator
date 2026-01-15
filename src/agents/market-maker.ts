import { Order, Trade } from '../types';
import { OrderBook } from '../engine/orderbook';

let orderSeq = 0;

/** Reset order sequence (call on simulation reset) */
export function resetMMSeq() {
  orderSeq = 0;
}

export interface MMStats {
  spreadPnl: number;
  inventoryPnl: number;
  totalSpreadCaptured: number;
  fillCount: number;
  avgRealizedSpread: number;
}

export class MarketMaker {
  readonly id = 'mm';
  private baseSpread: number;
  private currentSpread: number;
  private size: number;
  private adaptRate: number;
  
  private inventorySkewFactor: number;

  pnl = 0;
  inventory = 0;
  private recentTrades: { adverse: boolean; ts: number }[] = [];
  private readonly windowSize = 20;

  private _spreadPnl = 0;
  private _inventoryPnl = 0;
  private _totalSpreadCaptured = 0;
  private _fillCount = 0;

  constructor(
    baseSpread: number, 
    size: number, 
    adaptRate: number,
    inventorySkewFactor = 0.0005 // 0.5 bps per unit
  ) {
    this.baseSpread = baseSpread;
    this.currentSpread = baseSpread;
    this.size = size;
    this.adaptRate = adaptRate;
    this.inventorySkewFactor = inventorySkewFactor;
  }

  get quotedSpread() { return this.currentSpread; }

  get stats(): MMStats {
    return {
      spreadPnl: this._spreadPnl,
      inventoryPnl: this._inventoryPnl,
      totalSpreadCaptured: this._totalSpreadCaptured,
      fillCount: this._fillCount,
      avgRealizedSpread: this._fillCount > 0 
        ? this._totalSpreadCaptured / this._fillCount 
        : 0
    };
  }

  onTrade(trade: Trade, trueValueAfter: number) {
    if (trade.makerId !== this.id) return;

    const wasAdverse = trade.takerType === 'informed';
    const prevInventory = this.inventory;
    
    const spreadCaptured = trade.takerSide === 'buy'
      ? (trade.price - trade.trueValue) * trade.qty  // sold above true value
      : (trade.trueValue - trade.price) * trade.qty; // bought below true value
    
    this._spreadPnl += spreadCaptured;
    this._totalSpreadCaptured += Math.abs(spreadCaptured);
    this._fillCount++;

    // Update inventory and track average entry
    if (trade.takerSide === 'buy') {
      this.inventory -= trade.qty;
    } else {
      this.inventory += trade.qty;
    }

    const priceMove = trueValueAfter - trade.trueValue;
    const inventoryMtm = prevInventory * priceMove;
    this._inventoryPnl += inventoryMtm;

    this.pnl = this._spreadPnl + this._inventoryPnl;

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

    // Inventory skew for shift quotes to encourage inventory-reducing trades
    const skew = this.inventory * this.inventorySkewFactor;

    const bidPrice = Math.round((mid - halfSpread - skew) * 100) / 100;
    const askPrice = Math.round((mid + halfSpread - skew) * 100) / 100;

    const bid: Order = {
      id: `mm-b-${++orderSeq}`,
      traderId: this.id,
      traderType: 'mm',
      side: 'buy',
      type: 'limit',
      price: bidPrice,
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
      price: askPrice,
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

  /** Reset state for new simulation run */
  reset(baseSpread: number, size: number, adaptRate: number) {
    this.baseSpread = baseSpread;
    this.currentSpread = baseSpread;
    this.size = size;
    this.adaptRate = adaptRate;
    this.pnl = 0;
    this.inventory = 0;
    this.recentTrades = [];
    this._spreadPnl = 0;
    this._inventoryPnl = 0;
    this._totalSpreadCaptured = 0;
    this._fillCount = 0;
  }
}
