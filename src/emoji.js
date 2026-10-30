// Le 4 valutazioni. Ordine = dalla più prudente alla più tranquilla.
// In caso di pareggio vince quella con il numero più basso.
export const EMOJI = {
  1: { label: 'Assolutamente no', color: '#e5484d' },
  2: { label: 'Meglio di no', color: '#f5a524' },
  3: { label: 'Sì, ma attenzione', color: '#5b9cf5' },
  4: { label: 'Vai chill', color: '#30c464' },
}

const FLAG_SVG = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect x="12" y="6" width="5" height="54" rx="2.5" fill="#8a6a4a"/>
  <rect x="12" y="6" width="2" height="54" rx="1" fill="#a8845f"/>
  <circle cx="14.5" cy="6.5" r="4" fill="#d9b25b"/>
  <path d="M17 10 C27 5 34 15 44 10 C49 7.5 53 8 56 9 L56 35 C53 34 49 33.5 44 36 C34 41 27 31 17 36 Z" fill="#2fbf5f"/>
  <path d="M17 10 C27 5 34 15 44 10 C49 7.5 53 8 56 9 L56 16 C53 15 49 14.5 44 17 C34 22 27 12 17 17 Z" fill="#5ad883"/>
  <path d="M17 10 C27 5 34 15 44 10 C49 7.5 53 8 56 9 L56 35 C53 34 49 33.5 44 36 C34 41 27 31 17 36 Z" fill="none" stroke="#1d8a42" stroke-width="2" stroke-linejoin="round"/>
</svg>`

const CHARS = { 1: '💀', 2: '⚠️', 3: '👀' }

/** HTML dell'emoji n (1-4). La bandiera verde è disegnata perché non esiste come emoji. */
export function emojiHTML(n, size = 24) {
  if (n === 4) return `<span class="emo" style="width:${size}px;height:${size}px">${FLAG_SVG}</span>`
  return `<span class="emo" style="font-size:${Math.round(size * 0.9)}px;width:${size}px;height:${size}px">${CHARS[n]}</span>`
}

/** Vincitore: più voti; a parità, il più prudente. */
export function winnerOf(counts) {
  let best = null
  for (const n of [1, 2, 3, 4]) {
    const c = counts[n] || 0
    if (c > 0 && (best === null || c > (counts[best] || 0))) best = n
  }
  return best
}
