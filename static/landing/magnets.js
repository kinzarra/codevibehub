// Code Vibe: буквы CODE VIBE и кнопки — «магниты», которые посетитель тащит в любую точку экрана.
// Элемент остаётся в разметке, а сдвиг хранится в CSS-свойстве translate — оно складывается
// с transform, так что hover-анимации кнопок продолжают работать.
// Раскладка кодируется в #v=… — каждая версия сайта уникальна и ей можно поделиться.
// Без JS страница остаётся обычным HTML (это и видят поисковики).
// Фишка только для лендинга: без <body data-landing> модуль ничего не делает.
//   тащи букву/кнопку — она остаётся там, где отпустил
//   R — разбросать буквы по экрану, Esc — всё домой, стрелки — подвинуть выбранное
(() => {
  if (!document.body.hasAttribute('data-landing')) return;
  const root = document.documentElement;
  const title = document.querySelector('.title');
  const toastEl = document.querySelector('.toast');
  const glow = document.querySelector('.glow');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const GROUPS = { letters: 'l', buttons: 'b' }; // группа -> префикс id в ссылке
  const STORE_KEY = 'cv-layout';
  const HINT_KEY = 'cv-hint-seen';
  const LIMIT = 20000; // px — дальше этого сдвиг из ссылки не принимаем
  // Пасхалки: проверяются по тексту заголовка, прочитанному слева направо, сверху вниз.
  const SECRETS = [
    { test: (w) => w === 'VIBECODE', pal: 'sunset', msg: 'секрет 1/2 · VIBE CODE — сначала вайб, потом код' },
    { test: (w) => w.includes('DICE'), pal: 'acid', msg: 'секрет 2/2 · DICE — вайб-кодинг это всегда немного рулетка' },
  ];

  // ---- превращаем текст заголовка в плитки ----
  for (const line of title.querySelectorAll('.line')) {
    const text = line.textContent.trim();
    line.textContent = '';
    for (const ch of text) {
      const t = document.createElement('span');
      t.className = 'tile';
      t.textContent = ch;
      t.dataset.ch = ch; // разрезанная буква (paint.js) хранит несколько копий текста — берём отсюда
      t.dataset.swap = 'letters';
      t.tabIndex = 0;
      t.setAttribute('aria-roledescription', 'буква-магнит');
      line.append(t);
    }
  }

  const items = (group) => [...document.querySelectorAll(`[data-swap="${group}"]`)];
  const all = () => Object.keys(GROUPS).flatMap(items);
  for (const g of Object.keys(GROUPS)) items(g).forEach((el, i) => { el.dataset.id = i; el.draggable = false; });
  const tiles = () => items('letters');
  const key = (el) => GROUPS[el.dataset.swap] + el.dataset.id;

  // ---- сдвиги ----
  const offset = new Map(); // el -> [dx, dy]
  const getOffset = (el) => offset.get(el) || [0, 0];
  function place(el, dx, dy) {
    if (dx || dy) offset.set(el, [dx, dy]); else offset.delete(el);
    el.style.translate = dx || dy ? `${dx}px ${dy}px` : '';
  }

  // Последний тронутый — сверху. Шапка и main — отдельные слои, поднимаем и контейнер.
  let z = 10;
  function bringToFront(el) {
    el.style.zIndex = ++z;
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    const layer = el.closest('header, main');
    for (const l of document.querySelectorAll('body > header, body > main')) l.style.zIndex = l === layer ? 4 : 3;
  }

  // Текст заголовка, как его видно сейчас: строки сверху вниз, в строке — слева направо.
  function word() {
    const boxes = tiles().map((t) => ({ ch: t.dataset.ch, r: t.getBoundingClientRect() }))
      .sort((a, b) => a.r.top - b.r.top);
    const rows = [];
    for (const b of boxes) {
      const row = rows.find((r) => Math.abs(r.y - (b.r.top + b.r.height / 2)) < b.r.height / 2);
      if (row) row.items.push(b); else rows.push({ y: b.r.top + b.r.height / 2, items: [b] });
    }
    return rows.map((r) => r.items.sort((a, b) => a.r.left - b.r.left).map((b) => b.ch).join('')).join('');
  }

  // ---- состояние <-> строка: «2.l0_120_-40~b1_30_5» (только сдвинутые элементы) ----
  function serialize() {
    const parts = all().filter((el) => offset.has(el)).map((el) => [key(el), ...getOffset(el).map(Math.round)].join('_'));
    return parts.length ? '2.' + parts.join('~') : '';
  }

  function apply(state) {
    const [ver, body = ''] = String(state).split('.');
    if (ver !== '2') return false;
    const byKey = new Map(all().map((el) => [key(el), el]));
    const next = new Map();
    for (const part of body.split('~').filter(Boolean)) {
      const [k, dx, dy] = part.split('_');
      const el = byKey.get(k);
      if (!el || !/^-?\d+$/.test(dx) || !/^-?\d+$/.test(dy) || Math.abs(dx) > LIMIT || Math.abs(dy) > LIMIT) return false;
      next.set(el, [+dx, +dy]);
    }
    for (const el of all()) place(el, ...(next.get(el) || [0, 0]));
    return true;
  }

  let lastSecret = null;
  function sync(announce) {
    const state = serialize();
    title.setAttribute('aria-label', word().replace(/^(.{4})/, '$1 '));
    history.replaceState(null, '', state ? '#v=' + state : location.pathname + location.search);
    try { localStorage.setItem(STORE_KEY, state); } catch {}

    const w = word();
    const secret = SECRETS.find((s) => s.test(w)) || null;
    if (secret) root.dataset.pal = secret.pal; else delete root.dataset.pal;
    if (announce && secret && secret !== lastSecret) {
      toast(secret.msg);
      title.classList.remove('win');
      void title.offsetWidth;
      tiles().forEach((t, i) => t.style.setProperty('--i', i));
      title.classList.add('win');
    }
    lastSecret = secret;
  }

  let toastTimer;
  function toast(msg, ms = 3200) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
  }

  // Плавный переезд в новые сдвиги (R, Esc, стрелки).
  function glide(moves) {
    for (const [el, [dx, dy]] of moves) {
      if (!reduceMotion) {
        el.style.transition = 'translate .55s cubic-bezier(.2,.8,.2,1)';
        setTimeout(() => { el.style.transition = ''; }, 600);
      }
      place(el, dx, dy);
    }
    sync(true);
  }

  // ---- drag: тащим за любую точку, кусок разрезанной буквы — это уже paint.js ----
  let drag = null;
  let suppressClick = false;

  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest?.('[data-swap]');
    if (!el || e.button !== 0 || e.shiftKey || e.target.closest('.piece')) return; // Shift + жест — нож (paint.js)
    // гасим нативное перетаскивание ссылок и выделение текста — иначе браузер перехватит жест
    if (e.pointerType === 'mouse') e.preventDefault();
    drag = { el, x0: e.clientX, y0: e.clientY, from: getOffset(el), active: false };
  });

  document.addEventListener('pointermove', (e) => {
    if (glow && !reduceMotion) glow.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
    if (!drag) return;
    const { el } = drag;
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;
    if (!drag.active) {
      if (Math.hypot(dx, dy) < 6) return;
      drag.active = true;
      el.setPointerCapture(e.pointerId);
      el.classList.add('lifted');
      root.classList.add('is-dragging');
      bringToFront(el);
    }
    e.preventDefault();
    place(el, drag.from[0] + dx, drag.from[1] + dy);
  });

  function drop() {
    if (!drag) return;
    const { el, active } = drag;
    drag = null;
    if (!active) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    root.classList.remove('is-dragging');
    el.classList.remove('lifted', 'landed');
    void el.offsetWidth;
    el.classList.add('landed');
    sync(true);
  }
  document.addEventListener('pointerup', drop);
  document.addEventListener('pointercancel', drop);
  document.addEventListener('dragstart', (e) => { if (e.target.closest?.('[data-swap]')) e.preventDefault(); });

  // после перетаскивания ссылка не срабатывает
  document.addEventListener('click', (e) => {
    if (suppressClick) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  // ---- клавиши ----
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const k = e.key.toLowerCase();
    // R — разбросать буквы по видимой части экрана
    if (k === 'r' || k === 'к') {
      glide(tiles().map((t) => {
        const r = t.getBoundingClientRect();
        const [dx, dy] = getOffset(t);
        const x = Math.random() * Math.max(0, innerWidth - r.width);
        const y = 80 + Math.random() * Math.max(0, innerHeight - r.height - 80);
        return [t, [Math.round(dx + x - r.left), Math.round(dy + y - r.top)]];
      }));
      return;
    }
    // Esc — всё на свои места (куски букв склеивает paint.js)
    if (e.key === 'Escape') {
      glide([...offset.keys()].map((el) => [el, [0, 0]]));
      return;
    }
    // стрелки — подвинуть букву/кнопку в фокусе
    const el = e.target.closest?.('[data-swap]');
    const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!el || !dir) return;
    e.preventDefault();
    const [dx, dy] = getOffset(el);
    const step = e.shiftKey ? 64 : 16;
    bringToFront(el);
    glide([[el, [dx + dir[0] * step, dy + dir[1] * step]]]);
  });

  // ---- старт: ссылка от друга важнее сохранённой версии ----
  const fromHash = location.hash.startsWith('#v=') && apply(decodeURIComponent(location.hash.slice(3)));
  if (fromHash) toast('это чья-то версия сайта — пересобери её по-своему');
  else {
    try { apply(localStorage.getItem(STORE_KEY) || ''); } catch {}
  }
  sync(false);

  // первый визит — короткая подсказка, что здесь всё двигается
  try {
    if (!fromHash && !localStorage.getItem(HINT_KEY)) {
      localStorage.setItem(HINT_KEY, '1');
      setTimeout(() => toast('тащи буквы и кнопки куда угодно · двойной клик — разрезать', 5000), 800);
    }
  } catch {}
})();
