import { readFileSync } from 'fs';

export class Cart {
  private items: string[] = [];

  add(item: string): void {
    this.items.push(item);
    log(`added ${item}`);
  }

  total(): number {
    return this.items.length;
  }
}

export function log(msg: string) {
  console.log(msg);
}

export function checkout(cart: Cart) {
  cart.add('receipt');
  return cart.total();
}

export const config = readFileSync;
