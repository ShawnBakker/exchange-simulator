import { Order, OrderId, Trade, Level, BookSnapshot } from '../types';

let tradeSeq = 0;

/** Reset trade sequence (call on simulation reset) */
export function resetTradeSeq() {
  tradeSeq = 0;
}

export class OrderBook {
  private bids: Map<number, Order[]> = new Map();
  private asks: Map<number, Order[]> = new Map();
  private orderIndex: Map<OrderId, Order> = new Map();
  private _trueValue = 100;

  set trueValue(v: number) { this._trueValue = v; }
  get trueValue() { return this._trueValue; }

  get bestBid(): number | null {
    const prices = [...this.bids.keys()].filter(p => this.bids.get(p)!.length > 0);
    return prices.length ? Math.max(...prices) : null;
  }

  get bestAsk(): number | null {
    const prices = [...this.asks.keys()].filter(p => this.asks.get(p)!.length > 0);
    return prices.length ? Math.min(...prices) : null;
  }

  get spread(): number | null {
    const bb = this.bestBid, ba = this.bestAsk;
    return (bb !== null && ba !== null) ? ba - bb : null;
  }

  get mid(): number | null {
    const bb = this.bestBid, ba = this.bestAsk;
    return (bb !== null && ba !== null) ? (bb + ba) / 2 : null;
  }

  submit(order: Order): Trade[] {
    const trades: Trade[] = [];
    const book = order.side === 'buy' ? this.asks : this.bids;
    const isBuy = order.side === 'buy';

    const prices = [...book.keys()].sort((a, b) => isBuy ? a - b : b - a);

    for (const price of prices) {
      if (order.qty <= order.filled) break;

      const canMatch = order.type === 'market' ||
        (isBuy ? price <= order.price : price >= order.price);
      if (!canMatch) break;

      const queue = book.get(price)!;
      while (queue.length > 0 && order.filled < order.qty) {
        const maker = queue[0];
        const makerRemaining = maker.qty - maker.filled;
        const takerRemaining = order.qty - order.filled;
        const fillQty = Math.min(makerRemaining, takerRemaining);

        maker.filled += fillQty;
        order.filled += fillQty;

        trades.push({
          id: `t${++tradeSeq}`,
          ts: order.ts,
          price,
          qty: fillQty,
          takerOrderId: order.id,
          takerId: order.traderId,
          takerSide: order.side,
          takerType: order.traderType,
          makerOrderId: maker.id,
          makerId: maker.traderId,
          makerType: maker.traderType,
          trueValue: this._trueValue
        });

        if (maker.filled >= maker.qty) {
          queue.shift();
          this.orderIndex.delete(maker.id);
        }
      }

      if (queue.length === 0) book.delete(price);
    }

    if (order.type === 'limit' && order.filled < order.qty) {
      this.addToBook(order);
    }

    this.orderIndex.set(order.id, order);
    return trades;
  }

  private addToBook(order: Order) {
    const book = order.side === 'buy' ? this.bids : this.asks;
    if (!book.has(order.price)) {
      book.set(order.price, []);
    }
    book.get(order.price)!.push(order);
  }

  cancel(orderId: OrderId): boolean {
    const order = this.orderIndex.get(orderId);
    if (!order) return false;

    const book = order.side === 'buy' ? this.bids : this.asks;
    const queue = book.get(order.price);
    if (queue) {
      const idx = queue.findIndex(o => o.id === orderId);
      if (idx >= 0) queue.splice(idx, 1);
      if (queue.length === 0) book.delete(order.price);
    }

    this.orderIndex.delete(orderId);
    return true;
  }

  cancelAll(traderId: string) {
    const toCancel = [...this.orderIndex.values()]
      .filter(o => o.traderId === traderId)
      .map(o => o.id);
    toCancel.forEach(id => this.cancel(id));
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

  snapshot(ts: number): BookSnapshot {
    const toLevels = (book: Map<number, Order[]>, desc: boolean): Level[] => {
      return [...book.entries()]
        .filter(([_, orders]) => orders.length > 0)
        .map(([price, orders]) => ({ price, orders: [...orders] }))
        .sort((a, b) => desc ? b.price - a.price : a.price - b.price);
    };

    return {
      ts,
      bids: toLevels(this.bids, true),
      asks: toLevels(this.asks, false),
      bestBid: this.bestBid,
      bestAsk: this.bestAsk
    };
  }
}
