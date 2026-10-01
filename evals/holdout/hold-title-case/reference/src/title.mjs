export function titleCase(text) {
  return text.split(" ").map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w)).join(" ");
}
