// Tiny dependency-free SVG line chart. Supports multiple series, a shared hover
// crosshair with tooltip, area fill, and dashed reference lines. Theme-aware via
// currentColor / CSS variables.
const SVGNS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}) {
  const n = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

function niceTicks(min, max, count = 5) {
  if (min === max) {
    const pad = Math.abs(min) * 0.01 || 1;
    min -= pad;
    max += pad;
  }
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const start = Math.floor(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + step * 0.5; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

// data = { series:[{name,color,dashed,points:[{t:ISOstring, v:number}]}], decimals, yLabel }
export function lineChart(container, data) {
  container.innerHTML = '';
  const W = container.clientWidth || 720;
  const H = data.height || 320;
  const m = { top: 16, right: 16, bottom: 34, left: 56 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const decimals = data.decimals ?? 4;

  const all = data.series.flatMap((s) => s.points);
  if (!all.length) {
    container.innerHTML = '<div class="chart-empty">No data in range</div>';
    return;
  }
  const xs = all.map((p) => new Date(p.t).getTime());
  const ys = all.map((p) => p.v);
  let xMin = Math.min(...xs), xMax = Math.max(...xs);
  if (xMin === xMax) { xMin -= 3600e3; xMax += 3600e3; }
  const yTicks = niceTicks(Math.min(...ys), Math.max(...ys), 5);
  const yMin = yTicks[0], yMax = yTicks[yTicks.length - 1];

  const sx = (t) => m.left + ((new Date(t).getTime() - xMin) / (xMax - xMin)) * iw;
  const sy = (v) => m.top + ih - ((v - yMin) / (yMax - yMin)) * ih;

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, class: 'linechart' });

  // y gridlines + labels
  for (const t of yTicks) {
    svg.appendChild(el('line', { x1: m.left, x2: m.left + iw, y1: sy(t), y2: sy(t), class: 'grid' }));
    const lbl = el('text', { x: m.left - 8, y: sy(t) + 4, class: 'axis-label', 'text-anchor': 'end' });
    lbl.textContent = t.toFixed(decimals);
    svg.appendChild(lbl);
  }
  // x labels (~5)
  const xLabelCount = Math.min(5, all.length);
  for (let i = 0; i < xLabelCount; i++) {
    const t = xMin + ((xMax - xMin) * i) / (xLabelCount - 1 || 1);
    const d = new Date(t);
    const lbl = el('text', { x: sx(d.toISOString()), y: H - 12, class: 'axis-label', 'text-anchor': 'middle' });
    lbl.textContent = d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
    svg.appendChild(lbl);
  }

  // series
  for (const s of data.series) {
    const pts = [...s.points].sort((a, b) => new Date(a.t) - new Date(b.t));
    if (!pts.length) continue;
    const dPath = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.t).toFixed(1)},${sy(p.v).toFixed(1)}`).join(' ');
    if (s.fill) {
      const area = `${dPath} L${sx(pts[pts.length - 1].t).toFixed(1)},${sy(yMin)} L${sx(pts[0].t).toFixed(1)},${sy(yMin)} Z`;
      svg.appendChild(el('path', { d: area, fill: s.color, 'fill-opacity': 0.08, stroke: 'none' }));
    }
    svg.appendChild(
      el('path', {
        d: dPath,
        fill: 'none',
        stroke: s.color,
        'stroke-width': s.width || 2,
        'stroke-dasharray': s.dashed ? '5 4' : '0',
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
      })
    );
    // dots for small series
    if (pts.length <= 40) for (const p of pts) svg.appendChild(el('circle', { cx: sx(p.t), cy: sy(p.v), r: 2.4, fill: s.color }));
  }

  // hover layer
  const hoverLine = el('line', { class: 'hover-line', y1: m.top, y2: m.top + ih, x1: -10, x2: -10, opacity: 0 });
  svg.appendChild(hoverLine);
  const hoverDots = data.series.map((s) => {
    const c = el('circle', { r: 4, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2, opacity: 0 });
    svg.appendChild(c);
    return c;
  });
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.style.opacity = 0;
  container.style.position = 'relative';
  container.appendChild(tip);

  const overlay = el('rect', { x: m.left, y: m.top, width: iw, height: ih, fill: 'transparent' });
  svg.appendChild(overlay);

  overlay.addEventListener('mousemove', (e) => {
    const rect = svg.getBoundingClientRect();
    const scale = W / rect.width;
    const mx = (e.clientX - rect.left) * scale;
    const tHover = xMin + ((mx - m.left) / iw) * (xMax - xMin);
    hoverLine.setAttribute('x1', mx);
    hoverLine.setAttribute('x2', mx);
    hoverLine.setAttribute('opacity', 1);
    let rows = '';
    let anyY = null;
    data.series.forEach((s, si) => {
      if (!s.points.length) { hoverDots[si].setAttribute('opacity', 0); return; }
      const pts = [...s.points].sort((a, b) => new Date(a.t) - new Date(b.t));
      let near = pts[0];
      for (const p of pts) if (Math.abs(new Date(p.t) - tHover) < Math.abs(new Date(near.t) - tHover)) near = p;
      const px = sx(near.t), py = sy(near.v);
      hoverDots[si].setAttribute('cx', px);
      hoverDots[si].setAttribute('cy', py);
      hoverDots[si].setAttribute('opacity', 1);
      anyY = anyY ?? py;
      rows += `<div class="tip-row"><span class="tip-dot" style="background:${s.color}"></span>${s.name}: <b>${near.v.toFixed(decimals)}</b></div>`;
    });
    const near0 = [...data.series[0].points].sort((a, b) => new Date(a.t) - new Date(b.t)).reduce((n, p) => (Math.abs(new Date(p.t) - tHover) < Math.abs(new Date(n.t) - tHover) ? p : n));
    const dateStr = new Date(near0.t).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    tip.innerHTML = `<div class="tip-date">${dateStr}</div>${rows}`;
    tip.style.opacity = 1;
    const tipX = Math.min(Math.max((mx / scale) + 12, 8), rect.width - 160);
    tip.style.left = `${tipX}px`;
    tip.style.top = `${(m.top / scale) + 6}px`;
  });
  overlay.addEventListener('mouseleave', () => {
    hoverLine.setAttribute('opacity', 0);
    hoverDots.forEach((d) => d.setAttribute('opacity', 0));
    tip.style.opacity = 0;
  });

  container.appendChild(svg);

  // legend
  if (data.series.length > 1 || data.legend) {
    const legend = document.createElement('div');
    legend.className = 'chart-legend';
    legend.innerHTML = data.series
      .map((s) => `<span class="lg"><span class="lg-swatch ${s.dashed ? 'dashed' : ''}" style="--c:${s.color}"></span>${s.name}</span>`)
      .join('');
    container.appendChild(legend);
  }
}

// Compact sparkline (no axes) for cards.
export function sparkline(container, points, color) {
  container.innerHTML = '';
  const W = container.clientWidth || 160;
  const H = container.clientHeight || 40;
  if (!points.length) return;
  const xs = points.map((p) => new Date(p.t).getTime());
  const ys = points.map((p) => p.v);
  const xMin = Math.min(...xs), xMax = Math.max(...xs) || xMin + 1;
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const sx = (t) => ((new Date(t).getTime() - xMin) / (xMax - xMin || 1)) * (W - 4) + 2;
  const sy = (v) => H - 3 - ((v - yMin) / (yMax - yMin || 1)) * (H - 6);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, class: 'spark' });
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.t).toFixed(1)},${sy(p.v).toFixed(1)}`).join(' ');
  svg.appendChild(el('path', { d: `${d} L${sx(points[points.length - 1].t)},${H} L${sx(points[0].t)},${H} Z`, fill: color, 'fill-opacity': 0.12, stroke: 'none' }));
  svg.appendChild(el('path', { d, fill: 'none', stroke: color, 'stroke-width': 1.75, 'stroke-linejoin': 'round' }));
  container.appendChild(svg);
}
