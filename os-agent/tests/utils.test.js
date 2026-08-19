const { add, isString } = require('../src/utils');

test('add sums numbers', () => {
  expect(add(2,3)).toBe(5);
});

test('isString detects strings', () => {
  expect(isString('x')).toBe(true);
  expect(isString(1)).toBe(false);
});

