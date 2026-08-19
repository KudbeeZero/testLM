const os = require('os');

test('platform returns a non-empty string', () => {
  const platform = os.platform();
  expect(typeof platform).toBe('string');
  expect(platform.length).toBeGreaterThan(0);
});
