const toDay = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

export function daysBetween(from, to) {
  return toDay(to) - toDay(from);
}
