// Обратный отсчёт и время в часовом поясе посетителя. Без JS страница остаётся полной.
(() => {
  const root = document.querySelector('.ev[data-start]');
  if (!root) return;
  const start = new Date(root.dataset.start), end = new Date(root.dataset.end);
  const out = root.querySelector('.ev-countdown');
  const pad = (n) => String(n).padStart(2, '0');

  const local = root.querySelector('.ev-local');
  if (local) {
    local.querySelector('time').textContent =
      start.toLocaleString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    local.hidden = false;
  }

  const tick = () => {
    const now = Date.now(), left = start - now;
    if (now > end) { out.textContent = 'Эфир завершён'; return false; }
    if (left <= 0) { out.textContent = 'Эфир идёт'; out.classList.add('live'); return true; }
    const d = Math.floor(left / 864e5), h = Math.floor(left / 36e5) % 24;
    const m = Math.floor(left / 6e4) % 60, s = Math.floor(left / 1e3) % 60;
    if (!out.querySelector('.count-unit')) {
      out.innerHTML = ['дней', 'часов', 'минут', 'секунд'].map(label =>
        `<span class="count-unit"><b>00</b><small>${label}</small></span>`).join('');
    }
    [d, h, m, s].forEach((value, index) => {
      const digit = out.children[index].querySelector('b');
      const text = pad(value);
      if (digit.textContent !== text) {
        digit.textContent = text;
        digit.classList.remove('tick'); void digit.offsetWidth; digit.classList.add('tick');
      }
    });
    return true;
  };
  if (tick()) { const t = setInterval(() => { if (!tick()) clearInterval(t); }, 1000); }
})();

// «Я пойду»: переключатель, состояние хранится на сервере (Postgres), по cookie посетителя.
(() => {
  const btn = document.querySelector('[data-rsvp]');
  if (!btn) return;
  const line = document.querySelector('.going'), num = document.querySelector('[data-going-count]');
  const word = document.querySelector('[data-going-word]');
  const plural = (n) => { const a = n % 10, b = n % 100;
    return a === 1 && b !== 11 ? 'человек идёт' : (a >= 2 && a <= 4 && (b < 12 || b > 14)) ? 'человека идут' : 'человек идут'; };
  const render = (count) => {
    if (!line) return;
    const changed = Number(num.textContent) !== count;
    line.hidden = count < 1; num.textContent = count; word.textContent = plural(count);
    if (changed) {
      num.classList.remove('count-pop'); void num.offsetWidth; num.classList.add('count-pop');
    }
  };
  if (num) render(Number(num.textContent));
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const r = await fetch(btn.dataset.rsvp, { method: 'POST' });
      if (!r.ok) throw new Error(r.status);
      const { going, count } = await r.json();
      btn.setAttribute('aria-pressed', going); render(count);
    } catch { btn.classList.add('err'); setTimeout(() => btn.classList.remove('err'), 1500); }
    btn.disabled = false;
  });
})();

// «Для кого: это я» и лайки программы. Нужен вход через Google: без него отправляем на /login и возвращаем обратно.
(() => {
  const root = document.querySelector('.ev[data-login]');
  if (!root) return;
  const slug = location.pathname.replace(/\/$/, '').split('/').pop();
  const authed = root.dataset.authed === '1';
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.pill-btn, .like');
    if (!btn) return;
    if (!authed) { location.href = root.dataset.login; return; }
    if (btn.disabled) return;
    btn.disabled = true;
    const was = btn.getAttribute('aria-pressed') === 'true';
    btn.setAttribute('aria-pressed', String(!was)); btn.classList.toggle('on', !was);   // сразу, не ждём сервер
    try {
      const r = await fetch(`/api/events/${slug}/${btn.dataset.kind}/${btn.dataset.id}`, { method: 'POST', headers: { 'X-CSRF': root.dataset.csrf } });
      if (r.status === 401) { location.href = root.dataset.login; return; }
      if (!r.ok) throw new Error(r.status);
      const { on, count } = await r.json();
      btn.setAttribute('aria-pressed', String(on)); btn.classList.toggle('on', on);
      const n = btn.querySelector('.pb-count, .like-n');
      if (n) { n.textContent = count || ''; n.hidden = !count; }
    } catch {
      btn.setAttribute('aria-pressed', String(was)); btn.classList.toggle('on', was);   // откат
      btn.classList.add('err'); setTimeout(() => btn.classList.remove('err'), 1200);
    } finally { btn.disabled = false; }
  });
})();

// Интенсивность карточек отражает количество голосов; одинаковые значения равноправны.
(() => {
  const cards = [...document.querySelectorAll('.agenda li')];
  if (!cards.length) return;
  const update = () => {
    const counts = cards.map(card => Math.max(0, Number(card.querySelector('.like-n')?.textContent) || 0));
    const max = Math.max(...counts);
    cards.forEach((card, i) => {
      const count = counts[i];
      const strength = count ? Math.min(1, Math.log2(count + 1) / 4) : 0;
      card.style.setProperty('--vote-tint', (strength * .3).toFixed(3));
      card.style.setProperty('--vote-border', (.1 + strength * .55).toFixed(3));
      card.style.setProperty('--vote-width', `${max ? count / max * 100 : 0}%`);
      card.classList.toggle('has-votes', count > 0);
      // Метка лидера появляется лишь при различающихся результатах и хотя бы двух голосах.
      const leader = count >= 2 && count === max && counts.some(n => n < max);
      card.classList.toggle('vote-leader', leader);
      let badge = card.querySelector('.vote-badge');
      if (leader && !badge) {
        badge = document.createElement('span'); badge.className = 'vote-badge';
        badge.textContent = 'В топе'; card.append(badge);
      }
      if (badge) badge.hidden = !leader;
    });
  };
  const observer = new MutationObserver(update);
  cards.forEach(card => { const count = card.querySelector('.like-n'); if (count) observer.observe(count, { childList: true, characterData: true, subtree: true }); });
  update();
})();

// Видео: лента карточек и полноэкранный просмотр «как в Shorts» — листаем вверх-вниз, плеер YouTube грузится
// только на видимом ролике. Без JS карточки — обычные ссылки на YouTube.
(() => {
  const cards = [...document.querySelectorAll('[data-reel]')];
  if (!cards.length) return;
  const rail = document.querySelector('.vids-rail');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const h = (tag, cls, attrs = {}) => { const n = document.createElement(tag); if (cls) n.className = cls; for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
  const icon = (d, size = 22) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
  const YT = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M23 7.2a3 3 0 0 0-2.1-2.1C19 4.6 12 4.6 12 4.6s-7 0-8.9.5A3 3 0 0 0 1 7.2 31 31 0 0 0 .5 12 31 31 0 0 0 1 16.8a3 3 0 0 0 2.1 2.1c1.9.5 8.9.5 8.9.5s7 0 8.9-.5a3 3 0 0 0 2.1-2.1 31 31 0 0 0 .5-4.8 31 31 0 0 0-.5-4.8ZM9.8 15.1V8.9l5.8 3.1-5.8 3.1Z"/></svg>';
  const videos = cards.map((c) => ({ id: c.dataset.id, short: c.dataset.short === '1', title: c.dataset.title, url: c.href }));

  // Превью: hqdefault — 480×360 с полями (для Shorts это мыло), поэтому сначала берём большие варианты.
  // Отсутствующий вариант YouTube отдаёт 404 с заглушкой 120×90 — тогда переходим к следующему.
  const ytImg = (id, name) => `https://i.ytimg.com/vi/${id}/${name}.jpg`;
  const thumbSources = (v) => (v.short ? ['oar2', 'maxresdefault', 'hqdefault'] : ['maxresdefault', 'sddefault', 'hqdefault']).map((n) => ytImg(v.id, n));
  const bad = (img) => img.complete && img.naturalWidth > 0 && img.naturalWidth <= 120;
  function applyThumb(img, v, onReady) {
    const list = thumbSources(v);
    let i = Math.max(0, list.indexOf(img.currentSrc || img.src));
    const next = () => { if (i < list.length - 1) img.src = list[++i]; else onReady?.(); };
    img.addEventListener('error', next);
    img.addEventListener('load', () => { if (bad(img)) next(); else onReady?.(); });
    if (img.getAttribute('src') !== list[i]) img.src = list[i];
    else if (img.complete) { if (img.naturalWidth === 0 || bad(img)) next(); else onReady?.(); }
  }
  rail.classList.add('has-js');
  cards.forEach((c, i) => applyThumb(c.querySelector('img'), videos[i], () => c.classList.add('is-loaded')));

  // ---- лента на странице: стрелки на десктопе
  const arrows = [...document.querySelectorAll('[data-vids-scroll]')];
  const syncArrows = () => {
    const max = rail.scrollWidth - rail.clientWidth - 2;
    arrows[0].disabled = rail.scrollLeft <= 2; arrows[1].disabled = rail.scrollLeft >= max;
    arrows.forEach((a) => { a.hidden = max <= 0; });
    rail.classList.toggle('at-start', rail.scrollLeft <= 2); rail.classList.toggle('at-end', rail.scrollLeft >= max);
  };
  arrows.forEach((a) => a.addEventListener('click', () => rail.scrollBy({ left: Number(a.dataset.vidsScroll) * rail.clientWidth * 0.8, behavior: reduced ? 'auto' : 'smooth' })));
  rail.addEventListener('scroll', syncArrows, { passive: true });
  addEventListener('resize', syncArrows);
  syncArrows();
  const all = document.querySelector('[data-reel-all]');
  all.hidden = false;

  // ---- полноэкранный просмотр
  const dlg = h('dialog', 'reel', { 'aria-label': 'Просмотр видео' });
  const progress = h('div', 'reel-progress', { 'aria-hidden': 'true' });
  videos.forEach(() => progress.append(h('i')));
  const counter = h('span', 'reel-counter', { 'aria-live': 'polite' });
  const closeBtn = h('button', 'reel-btn reel-close', { type: 'button', 'aria-label': 'Закрыть' }); closeBtn.innerHTML = icon('M6 6l12 12M18 6L6 18');
  const top = h('div', 'reel-top'); top.append(counter, closeBtn);
  const track = h('div', 'reel-track');
  const up = h('button', 'reel-btn', { type: 'button', 'aria-label': 'Предыдущее видео' }); up.innerHTML = icon('M6 15l6-6 6 6');
  const down = h('button', 'reel-btn', { type: 'button', 'aria-label': 'Следующее видео' }); down.innerHTML = icon('M6 9l6 6 6-6');
  const side = h('div', 'reel-side'); side.append(up, down);
  const hint = h('div', 'reel-hint', { 'aria-hidden': 'true' }); hint.innerHTML = `${icon('M12 4v16M8 8l4-4 4 4M8 16l4 4 4-4', 16)}<span>Листайте вверх-вниз</span>`;

  const slides = videos.map((v, i) => {
    const s = h('section', 'reel-slide' + (v.short ? ' is-short' : ''), { 'data-i': i, 'aria-label': `Видео ${i + 1} из ${videos.length}` });
    s.style.setProperty('--thumb', `url("${ytImg(v.id, 'default')}")`);  // под blur качество не нужно
    const frame = h('div', 'reel-frame');
    const poster = h('img', 'reel-poster', { alt: '', loading: 'lazy', decoding: 'async' });
    applyThumb(poster, v);
    const play = h('button', 'reel-start', { type: 'button', 'aria-label': 'Смотреть: ' + (v.title || 'видео') });
    play.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5.6v12.8a1 1 0 0 0 1.52.85l10.4-6.4a1 1 0 0 0 0-1.7L9.52 4.75A1 1 0 0 0 8 5.6Z"/></svg>';
    play.addEventListener('click', () => activate(i, true));
    frame.append(poster, play);
    const cap = h('div', 'reel-caption');
    const title = h('b'); title.textContent = v.title || 'Видео ' + (i + 1);
    const yt = h('a', 'reel-yt', { href: v.url, target: '_blank', rel: 'noopener' }); yt.innerHTML = `${YT}<span>Открыть в YouTube</span>`;
    yt.addEventListener('click', () => deactivate(i));  // не играем два раза: здесь ставим на паузу
    cap.append(title, yt);
    s.append(frame, cap);
    track.append(s);
    return s;
  });
  const end = h('section', 'reel-slide reel-end', { 'data-i': videos.length });
  end.innerHTML = `<div class="reel-end-card"><span class="reel-end-mark">✦</span><h3>Это все видео</h3><p>${videos.length} ${videos.length % 10 === 1 && videos.length % 100 !== 11 ? 'ролик' : [2, 3, 4].includes(videos.length % 10) && ![12, 13, 14].includes(videos.length % 100) ? 'ролика' : 'роликов'} с этого мероприятия</p><div class="reel-end-actions"><button type="button" class="btn btn-primary" data-again><span>Смотреть сначала</span></button><button type="button" class="btn btn-ghost" data-back><span>К мероприятию</span></button></div></div>`;
  end.querySelector('[data-again]').addEventListener('click', () => go(0));
  end.querySelector('[data-back]').addEventListener('click', () => close());
  track.append(end);
  dlg.append(progress, top, track, side, hint);
  document.body.append(dlg);

  let current = -1, timer = 0, lastFocus = null;
  const here = location.pathname + location.search;
  const slideAll = [...slides, end];
  const src = (v) => `https://www.youtube-nocookie.com/embed/${v.id}?` + new URLSearchParams({
    autoplay: 1, playsinline: 1, rel: 0, modestbranding: 1, ...(v.short ? { loop: 1, playlist: v.id } : {}) });

  function activate(i, force = false) {
    const s = slides[i];
    if (!s || (s.querySelector('iframe') && !force)) return;
    const frame = s.querySelector('.reel-frame');
    frame.querySelector('iframe')?.remove();
    const f = h('iframe', '', { src: src(videos[i]), title: videos[i].title || 'Видео YouTube', allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen; web-share',
      allowfullscreen: '', referrerpolicy: 'strict-origin-when-cross-origin' });
    f.addEventListener('load', () => frame.classList.add('is-loaded'), { once: true });
    frame.classList.add('is-playing');
    frame.append(f);
  }
  function deactivate(i) {
    const frame = slides[i]?.querySelector('.reel-frame');
    if (!frame) return;
    frame.querySelector('iframe')?.remove();
    frame.classList.remove('is-playing', 'is-loaded');
  }
  function setCurrent(i) {
    if (i === current) return;
    if (current >= 0) hint.classList.add('gone');
    slides.forEach((_, j) => { if (j !== i) deactivate(j); });
    current = i;
    slideAll.forEach((s, j) => s.classList.toggle('is-near', Math.abs(j - i) <= 1));  // тяжёлый фон — только рядом
    const isEnd = i >= videos.length;
    counter.innerHTML = isEnd ? 'Конец' : `<b>${String(i + 1).padStart(2, '0')}</b> / ${String(videos.length).padStart(2, '0')}`;
    [...progress.children].forEach((bar, j) => { bar.className = j < i ? 'done' : j === i ? 'on' : ''; });
    up.disabled = i <= 0; down.disabled = isEnd;
    if (!isEnd) history.replaceState({ reel: true }, '', here + '#video-' + videos[i].id);
    clearTimeout(timer);
    if (!isEnd) timer = setTimeout(() => activate(i), 250);  // не грузим плееры, пока ролики пролистывают
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) setCurrent(Number(e.target.dataset.i));
  }, { root: track, threshold: 0.6 });
  slideAll.forEach((s) => io.observe(s));

  const go = (i) => slideAll[Math.max(0, Math.min(slideAll.length - 1, i))].scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' });
  up.addEventListener('click', () => go(current - 1));
  down.addEventListener('click', () => go(current + 1));

  function open(i, push = true) {
    lastFocus = document.activeElement;
    current = -1;
    let seen = false;
    try { seen = localStorage.getItem('reel-hint-seen') === '1'; localStorage.setItem('reel-hint-seen', '1'); } catch {}
    hint.classList.toggle('gone', seen);
    if (push) history.pushState({ reel: true }, '', here + '#video-' + videos[i].id);
    dlg.showModal();
    slides[i].scrollIntoView({ behavior: 'instant' });
    setCurrent(i);
    clearTimeout(timer); activate(i);  // открыли касанием — сразу запускаем
    closeBtn.focus({ preventScroll: true });
  }
  function shut() {
    if (!dlg.open) return;
    const last = Math.min(current, videos.length - 1);
    clearTimeout(timer);
    slides.forEach((_, j) => deactivate(j));
    dlg.close();
    const card = cards[last];
    card.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'instant' });
    (lastFocus === all ? all : card).focus({ preventScroll: true });
  }
  // «Назад» в браузере и жест «назад» на телефоне закрывают просмотр, а не уводят со страницы
  const close = () => { if (history.state?.reel) history.back(); else shut(); };
  addEventListener('popstate', () => { if (!history.state?.reel) shut(); });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dlg.addEventListener('close', () => { if (history.state?.reel) history.back(); });
  closeBtn.addEventListener('click', close);
  dlg.addEventListener('keydown', (e) => {
    if (e.target.closest('a, button') && (e.key === ' ' || e.key === 'Enter')) return;
    if (['ArrowDown', 'PageDown', 'j'].includes(e.key)) { e.preventDefault(); go(current + 1); }
    else if (['ArrowUp', 'PageUp', 'k'].includes(e.key)) { e.preventDefault(); go(current - 1); }
  });

  cards.forEach((c, i) => c.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;  // открыть в новой вкладке — как обычную ссылку
    e.preventDefault(); open(i);
  }));
  all.addEventListener('click', () => open(0));

  // Прямая ссылка на ролик: /events/<slug>#video-<id>
  const fromHash = videos.findIndex((v) => location.hash === '#video-' + v.id);
  if (fromHash >= 0) {
    history.replaceState(null, '', here);
    open(fromHash);
  }
})();
