/** A tiny store. */
export class Store {
  #items = [];
  constructor() { this.log = new Logger(); }
  add(x) { this.#items.push(x); this.log.write(x); return this; }
}
class Logger { write(m) { console.log(m); } }
export default function makeStore() { return new Store(); }
