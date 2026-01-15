import { Rng } from './rng';

export class PriceProcess {
  value: number;
  private rng: Rng;
  private vol: number;
  private jumpProb: number;
  private jumpSize: number;

  constructor(
    initial: number,
    rng: Rng,
    volatility: number,
    jumpProb: number,
    jumpSize: number
  ) {
    this.value = initial;
    this.rng = rng;
    this.vol = volatility;
    this.jumpProb = jumpProb;
    this.jumpSize = jumpSize;
  }

  step(): { newValue: number; jumped: boolean } {
    const diffusion = this.rng.normal(0, this.vol);
    let jumped = false;
    let jump = 0;

    if (this.rng.bool(this.jumpProb)) {
      jumped = true;
      jump = this.rng.bool() ? this.jumpSize : -this.jumpSize;
    }

    this.value = Math.max(0.01, this.value * (1 + diffusion + jump));
    return { newValue: this.value, jumped };
  }

  peek(steps = 1): number {
    const tempRng = this.rng.clone();
    let future = this.value;
    
    for (let i = 0; i < steps; i++) {
      const diff = tempRng.normal(0, this.vol);
      const jump = tempRng.bool(this.jumpProb) 
        ? (tempRng.bool() ? this.jumpSize : -this.jumpSize) 
        : 0;
      future = Math.max(0.01, future * (1 + diff + jump));
    }
    
    return future;
  }
}
