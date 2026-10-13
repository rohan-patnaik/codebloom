import makeStore, { Store } from './lib/store';
const util = require('./util');

const store = makeStore();

export const run = async (items) => {
  const s = new Store();
  for (const i of items) s.add(i);
  util.sum(1, 2);
  return helper(s);
};

function helper(s) { return s; }

run([1, 2]);
