import { paperLayout, stripSVG, PAGE, VARIANTS } from './paper.js';

const sel = document.getElementById('variant');
for (const v of Object.values(VARIANTS)) sel.add(new Option(v.label, v.id));
const params = new URLSearchParams(location.search);
sel.value = VARIANTS[params.get('size')] ? params.get('size') : 'full';

function render() {
  const L = paperLayout(sel.value);
  const strip = stripSVG(L);
  const host = document.getElementById('sheets');
  host.textContent = '';
  const offY = (PAGE.h - L.height) / 2 + 4;
  L.pages.forEach((p, i) => {
    const n = L.pages.length;
    let extra = '';
    // grey overlap zone at the left of every sheet after the first
    if (i > 0) {
      extra += `<rect x="${p.x0}" y="0" width="${PAGE.overlap}" height="${L.height}" fill="#000" fill-opacity="0.18"/>`;
      extra += `<text x="${p.x0 + PAGE.overlap / 2}" y="${L.height / 2}" font-size="4" fill="#333" text-anchor="middle" transform="rotate(-90 ${p.x0 + PAGE.overlap / 2} ${L.height / 2})" font-family="sans-serif">OVERLAP – sheet ${i} goes on top here, tape</text>`;
    }
    if (i < n - 1) {
      extra += `<line x1="${p.x1}" y1="-8" x2="${p.x1}" y2="${L.height + 4}" stroke="#000" stroke-width="0.4" stroke-dasharray="3 2"/>`;
      extra += `<text x="${p.x1 - 2}" y="-3" font-size="4" text-anchor="end" font-family="sans-serif">✂ cut here, then tape over sheet ${i + 2} →</text>`;
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PAGE.w} ${PAGE.h}">
      <g transform="translate(${PAGE.margin - p.x0} ${offY})">
        <clipPath id="c${i}"><rect x="${p.x0}" y="-20" width="${p.x1 - p.x0}" height="${L.height + 40}"/></clipPath>
        <g clip-path="url(#c${i})">${strip}${extra}</g>
      </g>
      <text x="${PAGE.margin}" y="${PAGE.h - 4}" font-size="4" font-family="sans-serif" fill="#444">Desk Piano – ${L.variant.label} – sheet ${i + 1} of ${n} – camera goes on THIS side (far side from you); you sit on the side with the note names.</text>
      ${i === 0 ? `<g transform="translate(${PAGE.margin + 40} 8)"><rect width="100" height="2" fill="#000"/><text x="50" y="-1.5" font-size="3.5" text-anchor="middle" font-family="sans-serif">this bar should measure exactly 10 cm</text></g>` : ''}
    </svg>`;
    const div = document.createElement('div');
    div.className = 'sheet';
    div.innerHTML = svg;
    host.appendChild(div);
  });
}
sel.addEventListener('change', () => {
  try { history.replaceState(null, '', `?size=${sel.value}`); } catch { /* ignore */ }
  render();
});
document.getElementById('print').addEventListener('click', () => window.print());
render();
