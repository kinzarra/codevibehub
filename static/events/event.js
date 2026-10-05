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
