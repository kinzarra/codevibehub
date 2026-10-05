// Code Vibe: рисование и нож — только для лендинга (без <body data-landing> модуль ничего не делает).
//   зажал мышь на пустом месте и ведёшь — неоновый след, который медленно гаснет
//   Shift + ведёшь — нож: буквы, через которые прошёл разрез, распадаются на куски
//   двойной клик/тап по букве или куску — разрезать его пополам в этом месте
//   кусок можно утащить куда угодно — он живёт отдельно от буквы
//   Esc — склеить буквы и стереть след
// Куски буквы — копии её текста с clip-path; данные о раскладке (magnets.js) это не меняет.
// Связь с live.js — через события на document: свои штрихи и разрезы уходят наружу
// (landing:point, landing:cut), чужие приходят (landing:remote-stroke, landing:remote-cut).
(() => {
  if (!document.body.hasAttribute('data-landing')) return;
  const root = document.documentElement;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const LIFE = { paint: 2600, knife: 450 };
  const MAX_PIECES = 12; // на одну букву
  const HEAL_AFTER = 45000; // буква сама срастается, если её давно не резали (= CUT_TTL в live.py)
  const GAP = 5; // на сколько px расходятся куски после разреза ножом
  const SPLIT_GAP = 12; // …и после двойного клика — заметнее, чтобы было за что хватать
  const DOUBLE_TAP = 350; // мс между тапами

  // ---- холст поверх страницы ----
  const canvas = document.createElement('canvas');
  canvas.className = 'paint-layer';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');
  function resize() {
    const dpr = devicePixelRatio || 1;
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  addEventListener('resize', resize);

  const rgb = (name) => {
    const hex = getComputedStyle(root).getPropertyValue(name).trim().replace('#', '');
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) || 255);
  };

  let strokes = [];
  let raf = 0;
  function draw() {
    const now = performance.now();
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const a = rgb('--a');
    const b = rgb('--b');
    for (const s of strokes) {
      const life = LIFE[s.kind];
      s.pts = s.pts.filter((p) => now - p.t < life);
      for (let i = 1; i < s.pts.length; i++) {
        const p = s.pts[i - 1];
        const q = s.pts[i];
        const alpha = 1 - (now - q.t) / life;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
        if (s.kind === 'knife') {
          ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
          ctx.shadowColor = `rgba(255,255,255,${alpha})`;
          ctx.shadowBlur = 12;
          ctx.lineWidth = 2;
        } else {
          const k = (Math.sin(q.n / 14) + 1) / 2; // переливается от --a к --b вдоль следа
          const c = (s.color || a.map((v, j) => Math.round(v + (b[j] - v) * k))).join(',');
          ctx.strokeStyle = `rgba(${c},${alpha})`;
          ctx.shadowColor = `rgba(${c},${alpha * 0.8})`;
          ctx.shadowBlur = 18;
          ctx.lineWidth = 6;
        }
        ctx.stroke();
      }
    }
    strokes = strokes.filter((s) => s.pts.length > 1 || s === active?.stroke || now - s.born < 1000);
    raf = strokes.length ? requestAnimationFrame(draw) : 0;
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(draw); };

  // ---- геометрия разреза ----
  const cross = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);

  // Отсекает многоугольник прямой a→b, оставляя сторону sign (Сазерленд — Ходжмен).
  function clip(poly, a, b, sign) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const sp = cross(a, b, p) * sign;
      const sq = cross(a, b, q) * sign;
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
    return out;
  }
  const area = (poly) => Math.abs(poly.reduce((s, p, i) => {
    const q = poly[(i + 1) % poly.length];
    return s + p[0] * q[1] - q[0] * p[1];
  }, 0)) / 2;

  // Пересечение отрезка p→q с прямоугольником (Лян — Барски): [t0, t1] или null.
  function hit(p, q, r) {
    let t0 = 0;
    let t1 = 1;
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const edges = [[-dx, p.x - r.left], [dx, r.right - p.x], [-dy, p.y - r.top], [dy, r.bottom - p.y]];
    for (const [pp, qq] of edges) {
      if (pp === 0) { if (qq < 0) return null; continue; }
      const t = qq / pp;
      if (pp < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
      if (t0 > t1) return null;
    }
    return [t0, t1];
  }

  // ---- куски букв ----
  const pieces = new WeakMap(); // tile -> [{ poly, dx, dy, el }]

  function render(piece) {
    piece.el.style.clipPath = `polygon(${piece.poly.map(([x, y]) => `${x.toFixed(1)}px ${y.toFixed(1)}px`).join(',')})`;
    piece.el.style.transform = `translate(${piece.dx}px, ${piece.dy}px)`;
  }

  function addPiece(tile, poly, dx, dy) {
    const el = document.createElement('span');
    el.className = 'piece';
    el.setAttribute('aria-hidden', 'true');
    el.textContent = tile.dataset.ch;
    tile.append(el);
    return { poly, dx, dy, el };
  }

  function ensurePieces(tile) {
    if (pieces.has(tile)) return pieces.get(tile);
    const { width: w, height: h } = tile.getBoundingClientRect();
    // «призрак» держит размер плитки, куски лежат поверх. Запас 20% — чтобы не обрезать выносные элементы глифа.
    tile.textContent = '';
    const ghost = document.createElement('span');
    ghost.className = 'ghost';
    ghost.textContent = tile.dataset.ch;
    tile.append(ghost);
    tile.classList.add('sliced');
    const list = [addPiece(tile, [[-w * 0.2, -h * 0.2], [w * 1.2, -h * 0.2], [w * 1.2, h * 1.2], [-w * 0.2, h * 1.2]], 0, 0)];
    render(list[0]);
    pieces.set(tile, list);
    return list;
  }

  const healTimers = new WeakMap();

  // only — резать только этот кусок (двойной клик), иначе все, через которые прошла линия.
  function cut(tile, from, to, { remote = false, only = null, gap = GAP } = {}) {
    if (Math.hypot(to.x - from.x, to.y - from.y) < 8) return;
    const list = ensurePieces(tile);
    // буква, куски которой посетитель уже разложил сам, не срастается по таймеру
    clearTimeout(healTimers.get(tile));
    if (!tile.dataset.kept) healTimers.set(tile, setTimeout(() => healTile(tile), HEAL_AFTER));
    if (list.length >= MAX_PIECES) return;
    const r = tile.getBoundingClientRect();
    if (!remote) {
      const rel = (p) => [(p.x - r.left) / r.width, (p.y - r.top) / r.height];
      document.dispatchEvent(new CustomEvent('landing:cut', { detail: { i: +tile.dataset.id, a: rel(from), b: rel(to) } }));
    }
    const len = Math.hypot(to.x - from.x, to.y - from.y);
    const n = [-(to.y - from.y) / len, (to.x - from.x) / len]; // нормаль к разрезу
    const next = [];
    for (const pc of list) {
      // разрез в координатах куска
      const a = [from.x - r.left - pc.dx, from.y - r.top - pc.dy];
      const b = [to.x - r.left - pc.dx, to.y - r.top - pc.dy];
      const plus = only && pc !== only ? [] : clip(pc.poly, a, b, 1);
      const minus = only && pc !== only ? [] : clip(pc.poly, a, b, -1);
      if (plus.length < 3 || minus.length < 3 || area(plus) < 40 || area(minus) < 40) {
        next.push(pc);
        continue;
      }
      pc.el.remove();
      const shift = reduceMotion ? 0 : gap;
      next.push(addPiece(tile, plus, pc.dx + n[0] * shift, pc.dy + n[1] * shift));
      next.push(addPiece(tile, minus, pc.dx - n[0] * shift, pc.dy - n[1] * shift));
    }
    pieces.set(tile, next);
    for (const pc of next) render(pc);
  }

  function healTile(tile) {
    tile.textContent = tile.dataset.ch;
    tile.classList.remove('sliced');
    delete tile.dataset.kept;
    pieces.delete(tile);
  }

  // Разрез пополам через точку p под случайным углом (почти вертикально — так кусок видно).
  function split(tile, p, only) {
    const a = ((Math.random() * 70 - 35) * Math.PI) / 180;
    const d = [Math.sin(a) * 400, Math.cos(a) * 400];
    cut(tile, { x: p.x - d[0], y: p.y - d[1] }, { x: p.x + d[0], y: p.y + d[1] }, { only, gap: SPLIT_GAP });
  }

  const pieceOf = (el) => {
    const tile = el.closest('.tile');
    return { tile, pc: pieces.get(tile)?.find((x) => x.el === el) };
  };

  function heal() {
    document.querySelectorAll('.tile.sliced').forEach(healTile);
    strokes = [];
    kick();
  }

  // ---- жесты ----
  let active = null; // { kind, stroke, last, entries: Map(tile -> точка входа) }
  let grab = null; // перетаскиваемый кусок: { tile, pc, x0, y0, from, moved }
  let down = null; // где начался жест — для двойного тапа
  let lastTap = null;
  let zPiece = 1;
  let suppressClick = false;

  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    down = { x: e.clientX, y: e.clientY, target: e.target };
    const pieceEl = e.target.closest('.piece');
    if (pieceEl && !e.shiftKey) {
      const { tile, pc } = pieceOf(pieceEl);
      if (!pc) return;
      e.preventDefault();
      grab = { tile, pc, x0: e.clientX, y0: e.clientY, from: [pc.dx, pc.dy], moved: false };
      return;
    }
    if (e.pointerType === 'touch') return; // пальцем по пустому месту — прокрутка, не рисование
    const knife = e.shiftKey;
    // без Shift рисуем везде, кроме букв и кнопок — их таскают магниты
    if (!knife && e.target.closest('[data-swap], a, button')) return;
    e.preventDefault();
    const p = { x: e.clientX, y: e.clientY, t: performance.now(), n: 0 };
    emit(knife ? 'k' : 'p', p, true);
    active = { kind: knife ? 'knife' : 'paint', stroke: { kind: knife ? 'knife' : 'paint', pts: [p] }, last: p, entries: new Map(), moved: false };
    strokes.push(active.stroke);
    root.classList.add(knife ? 'is-cutting' : 'is-painting');
  });

  document.addEventListener('pointermove', (e) => {
    if (grab) {
      const dx = e.clientX - grab.x0;
      const dy = e.clientY - grab.y0;
      if (!grab.moved) {
        if (Math.hypot(dx, dy) < 6) return;
        grab.moved = true;
        grab.pc.el.setPointerCapture?.(e.pointerId);
        grab.pc.el.classList.add('dragging');
        grab.pc.el.style.zIndex = ++zPiece;
        grab.tile.style.zIndex = 1000 + zPiece; // и над соседними буквами
        grab.tile.dataset.kept = '1';
        clearTimeout(healTimers.get(grab.tile));
        root.classList.add('is-dragging');
      }
      e.preventDefault();
      grab.pc.dx = grab.from[0] + dx;
      grab.pc.dy = grab.from[1] + dy;
      render(grab.pc);
      return;
    }
    if (!active) return;
    const p = { x: e.clientX, y: e.clientY, t: performance.now(), n: active.last.n + 1 };
    if (Math.hypot(p.x - active.last.x, p.y - active.last.y) < 2) return;
    active.moved = true;
    active.stroke.pts.push(p);
    emit(active.kind === 'knife' ? 'k' : 'p', p, false);
    if (active.kind === 'knife') slash(active.last, p);
    active.last = p;
    kick();
  });

  // Буква режется, когда нож вошёл в неё и вышел: линия разреза — от входа до выхода.
  function slash(p, q) {
    for (const tile of document.querySelectorAll('.tile')) {
      const t = hit(p, q, tile.getBoundingClientRect());
      if (!t) continue;
      const at = (k) => ({ x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k });
      if (!active.entries.has(tile)) active.entries.set(tile, at(t[0]));
      if (t[1] < 1) {
        cut(tile, active.entries.get(tile), at(t[1]));
        active.entries.delete(tile);
      }
    }
  }

  function end(e) {
    if (grab) {
      if (grab.moved) {
        grab.pc.el.classList.remove('dragging');
        root.classList.remove('is-dragging');
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 0);
      }
      grab = null;
    }
    tap(e);
    if (!active) return;
    // нож отпустили внутри буквы — режем до точки, где остановились
    for (const [tile, from] of active.entries) cut(tile, from, active.last);
    if (active.moved) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
    }
    root.classList.remove('is-cutting', 'is-painting');
    active = null;
    kick();
  }
  // Двойной тап/клик без движения по букве или куску — разрезать в этой точке.
  function tap(e) {
    const start = down;
    down = null;
    if (e.type !== 'pointerup' || !start || e.shiftKey) return;
    const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6;
    const tile = start.target.closest?.('.tile');
    if (moved || !tile) { lastTap = null; return; }
    const now = performance.now();
    const p = { x: e.clientX, y: e.clientY };
    if (lastTap && lastTap.tile === tile && now - lastTap.t < DOUBLE_TAP && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) {
      lastTap = null;
      const pieceEl = start.target.closest('.piece');
      split(tile, p, pieceEl ? pieceOf(pieceEl).pc : null);
      return;
    }
    lastTap = { tile, t: now, ...p };
  }

  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
  // на window, чтобы сработать раньше клика по букве в magnets.js (там смена цвета)
  addEventListener('click', (e) => {
    if (suppressClick) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') heal();
  });

  // ---- живой слой (live.js) ----
  function emit(k, p, start) {
    document.dispatchEvent(new CustomEvent('landing:point', { detail: { k, x: p.x, y: p.y, start } }));
  }

  // чужой штрих: точки уже в координатах окна; для одного штриха событие приходит кусками
  const remote = new Map(); // ключ автор:штрих -> stroke
  document.addEventListener('landing:remote-stroke', (e) => {
    const { key, k, color, pts } = e.detail;
    let s = remote.get(key);
    if (!s || !strokes.includes(s)) {
      s = { kind: k === 'k' ? 'knife' : 'paint', color, pts: [], born: performance.now() };
      remote.set(key, s);
      strokes.push(s);
    }
    for (const [x, y] of pts) {
      const last = s.pts.at(-1);
      s.pts.push({ x, y, t: performance.now(), n: (last?.n ?? 0) + 1 });
    }
    if (remote.size > 200) remote.delete(remote.keys().next().value);
    kick();
  });

  // чужой разрез: та же буква (по data-id), где бы она ни стояла в моей раскладке
  document.addEventListener('landing:remote-cut', (e) => {
    const { i, a, b } = e.detail;
    const tile = document.querySelector(`.tile[data-id="${i}"]`);
    if (!tile) return;
    const r = tile.getBoundingClientRect();
    const abs = (p) => ({ x: r.left + p[0] * r.width, y: r.top + p[1] * r.height });
    cut(tile, abs(a), abs(b), { remote: true });
  });
})();
