import { Order, Side } from '../types';
import { Rng } from '../engine/rng';

let orderSeq = 0;

export function resetTraderSeq() {
  orderSeq = 0;
}

export class NoiseTrader {
  constructor(private rng: Rng) {}

  maybeOrder(ts: number, arrivalProb: number): Order | null {
    if (!this.rng.bool(arrivalProb)) return null;

    const side: Side = this.rng.bool() ? 'buy' : 'sell';
    const qty = this.rng.int(1, 10);

    return {
      id: `noise-${++orderSeq}`,
      traderId: `noise-${orderSeq}`,
      traderType: 'noise',
      side,
      type: 'market',
      price: 0,
      qty,
      filled: 0,
      ts
    };
  }
}

/** Minimum edge (in %) required for informed trader to act */
export const INFORMED_EDGE_THRESHOLD = 0.001; // 10 bps

export class InformedTrader {
  constructor(private rng: Rng) {}

  maybeOrder(
    ts: number,
    arrivalProb: number,
    currentPrice: number,
    trueValue: number
  ): Order | null {
    if (!this.rng.bool(arrivalProb)) return null;

    const edge = (trueValue - currentPrice) / currentPrice;

    if (Math.abs(edge) < INFORMED_EDGE_THRESHOLD) return null;

    const side: Side = edge > 0 ? 'buy' : 'sell';
    const qty = this.rng.int(5, 20); // informed trade larger

    return {
      id: `inf-${++orderSeq}`,
      traderId: `informed-${orderSeq}`,
      traderType: 'informed',
      side,
      type: 'market',
      price: 0,
      qty,
      filled: 0,
      ts
    };
  }
}
