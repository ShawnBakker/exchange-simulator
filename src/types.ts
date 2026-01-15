export type OrderId = string;
export type TraderId = string;

export type Side = 'buy' | 'sell';
export type OrderType = 'limit' | 'market';
export type TraderType = 'mm' | 'informed' | 'noise';

export interface Order {
  id: OrderId;
  traderId: TraderId;
  traderType: TraderType;
  side: Side;
  type: OrderType;
  price: number;
  qty: number;
  filled: number;
  ts: number;
}

export interface Trade {
  id: string;
  ts: number;
  price: number;
  qty: number;
  takerOrderId: OrderId;
  takerId: TraderId;
  takerSide: Side;
  takerType: TraderType;
  makerOrderId: OrderId;
  makerId: TraderId;
  makerType: TraderType;
  trueValue: number;
}

export interface Level {
  price: number;
  orders: Order[];
}

export interface BookSnapshot {
  ts: number;
  bids: Level[];
  asks: Level[];
  bestBid: number | null;
  bestAsk: number | null;
}

export interface Metrics {
  ts: number;
  trueValue: number;
  mid: number | null;
  spread: number | null;
  mmPnl: number;
  mmInventory: number;
  mmSpread: number;
  tradeCount: number;
  informedCount: number;
  adverseCount: number;
  spreadPnl: number;
  inventoryPnl: number;
  avgRealizedSpread: number;
  fillCount: number;
}

export interface Config {
  seed: number;
  initialPrice: number;
  volatility: number;
  jumpProb: number;
  jumpSize: number;
  mmBaseSpread: number;
  mmSize: number;
  mmAdaptRate: number;
  /** Inventory skew factor for MM quotes */
  mmInventorySkew: number;
  informedRatio: number;
  arrivalRate: number;
  tickMs: number;
  ticks: number;
}
