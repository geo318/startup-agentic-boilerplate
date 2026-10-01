export function sum(numbers) {
  return numbers.reduce((total, n) => total + n, 0);
}

export function clamp(value, min, max) {
  if (min > max) throw new RangeError("min must not exceed max");
  return Math.min(Math.max(value, min), max);
}
