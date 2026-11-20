const counters = new WeakMap();

export function showAmount(node, money, empty = '') {
  if (!money) {
    if (counters.delete(node) || node.textContent !== empty) node.textContent = empty;
    return;
  }
  const value = money.earned.toFixed(5);
  const label = money.currency + value;
  let counter = counters.get(node);
  if (!counter || counter.currency !== money.currency || counter.value.length !== value.length ||
      counter.value.indexOf('.') !== value.indexOf('.')) {
    const readable = document.createElement('span');
    readable.className = 'counter-readable';
    const reel = document.createElement('span');
    reel.setAttribute('aria-hidden', 'true');
    reel.append(money.currency);
    const cells = Array.from(value, char => {
      const cell = document.createElement('span');
      if (/[0-9]/.test(char)) cell.className = 'counter-digit';
      reel.append(cell);
      return cell;
    });
    node.replaceChildren(readable, reel);
    counter = { currency: money.currency, value: '', readable, cells };
    counters.set(node, counter);
  }
  if (counter.value === value) return;
  const delta = money.earned - Number(counter.value);
  const decimal = value.indexOf('.');
  const animate = counter.value && decimal >= 0 && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  counter.readable.textContent = label;
  counter.cells.forEach((cell, i) => {
    if (counter.value[i] === value[i]) return;
    const power = i < decimal ? decimal - 1 - i : decimal - i;
    const previous = counter.value[i];
    const next = value[i];
    cell.textContent = next;
    if (!animate || !cell.animate || !cell.className || Math.abs(delta) > 1.01 * 10 ** power ||
        (Number(previous) + (delta >= 0 ? 1 : 9)) % 10 !== Number(next)) return;
    const strip = document.createElement('span');
    strip.className = 'counter-strip';
    const from = document.createElement('span');
    const to = document.createElement('span');
    from.textContent = previous;
    to.textContent = next;
    strip.append(...(delta >= 0 ? [from, to] : [to, from]));
    cell.replaceChildren(strip);
    const down = 'translateY(-50%)';
    const up = 'translateY(0)';
    const roll = strip.animate({ transform: delta >= 0 ? [up, down] : [down, up] },
      { duration: 170, easing: 'ease-in-out', fill: 'forwards' });
    roll.onfinish = () => { if (strip.parentNode === cell) cell.textContent = next; };
  });
  counter.value = value;
}
