// Редактор мероприятия: стикеры (теги), карточки цифр/программы/спикеров, drag & drop фото, поиск даты в Google Calendar.
// DOM — источник правды: при отправке всё собирается в JSON в поле payload; фото уходят файлами photo_<id спикера>.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'value') n.value = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    n.append(...kids.flat().filter(Boolean));
    return n;
  };
  const initial = JSON.parse($('#initial').textContent);
  const newId = () => (Math.random().toString(16) + '00000000').slice(2, 10);
  const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'], MAX_PHOTO = 5 * 1024 * 1024;
  
  // ---- общие кнопки карточки: ↑ ↓ ×
  const tools = (card, { move = true } = {}) => el('div', { class: 'card-tools' },
    move && el('button', { type: 'button', 'aria-label': 'Выше', text: '↑', onclick: () => card.previousElementSibling && card.parentNode.insertBefore(card, card.previousElementSibling) }),
    move && el('button', { type: 'button', 'aria-label': 'Ниже', text: '↓', onclick: () => card.nextElementSibling && card.parentNode.insertBefore(card.nextElementSibling, card) }),
    el('button', { type: 'button', class: 'x', 'aria-label': 'Удалить', text: '×', onclick: () => card.remove() }));

  // ---- «Для кого»: стикеры из текста (Enter добавляет, Backspace в пустом поле снимает последний)
  const audience = $('#audience');
  const chip = (text, id) => {
    const c = el('span', { class: 'chip', 'data-value': text, 'data-id': id || newId() }, el('span', { text }),
      el('button', { type: 'button', 'aria-label': 'Удалить', text: '×', onclick: () => c.remove() }));
    return c;
  };
  const audienceInput = el('input', { type: 'text', maxlength: 200, placeholder: 'Например: предприниматели и CEO', 'aria-label': 'Для кого' });
  const addAudience = () => { const t = audienceInput.value.trim(); if (t) { audienceInput.before(chip(t)); audienceInput.value = ''; } };
  initial.audience.forEach((a) => audience.append(chip(a.text, a.id)));
  audience.append(audienceInput);
  audienceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addAudience(); }
    else if (e.key === 'Backspace' && !audienceInput.value && audienceInput.previousElementSibling) audienceInput.previousElementSibling.remove();
  });
  audienceInput.addEventListener('blur', addAudience);
  audience.addEventListener('click', (e) => { if (e.target === audience) audienceInput.focus(); });

  // ---- соавторы: стикеры с email (блок есть только у владельца)
  const coRoot = $('#coauthors');
  let getCoauthors = () => [];
  if (coRoot) {
    const EMAIL = /^[^@\s,;<>]{1,64}@[^@\s,;<>]{1,190}\.[^@\s,;<>]{2,}$/;
    const coChip = (mail) => {
      const c = el('span', { class: 'chip', 'data-value': mail }, el('span', { text: mail }),
        el('button', { type: 'button', 'aria-label': 'Удалить', text: '×', onclick: () => c.remove() }));
      return c;
    };
    const coInput = el('input', { type: 'text', inputmode: 'email', maxlength: 254, placeholder: 'name@gmail.com', 'aria-label': 'Email соавтора' });
    const coErr = el('small', { class: 'ed-err' });
    const addCo = () => {
      const mail = coInput.value.trim().toLowerCase();
      if (!mail) return true;
      if (!EMAIL.test(mail)) { coErr.textContent = 'Это не похоже на email'; return false; }
      coErr.textContent = '';
      if (![...coRoot.querySelectorAll('.chip')].some((c) => c.dataset.value === mail)) coInput.before(coChip(mail));
      coInput.value = '';
      return true;
    };
    initial.coauthors.forEach((m) => coRoot.append(coChip(m)));
    coRoot.append(coInput);
    coRoot.after(coErr);
    coInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',' || e.key === ' ') { e.preventDefault(); addCo(); }
      else if (e.key === 'Backspace' && !coInput.value && coInput.previousElementSibling) coInput.previousElementSibling.remove();
    });
    coInput.addEventListener('blur', addCo);
    coRoot.addEventListener('click', (e) => { if (e.target === coRoot) coInput.focus(); });
    getCoauthors = () => { addCo(); return [...coRoot.querySelectorAll('.chip')].map((c) => c.dataset.value); };
  }

  // ---- ссылки: стикер «название + хост», название подбирается по адресу
  const GUESS = [[/t\.me|telegram/i, 'Telegram'], [/youtu/i, 'YouTube'], [/instagram/i, 'Instagram'], [/linkedin/i, 'LinkedIn'],
    [/github/i, 'GitHub'], [/vk\.com/i, 'VK'], [/x\.com|twitter/i, 'X'], [/habr/i, 'Хабр'], [/notion/i, 'Notion']];
  const guessLabel = (u) => { for (const [re, l] of GUESS) if (re.test(u)) return l; try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

  function linksEditor(root, items) {
    const limit = root.id === 'links' ? 12 : 8;
    const list = el('div', { class: 'link-list' });
    const label = el('input', { type: 'text', maxlength: 40, placeholder: 'Подберём автоматически', 'aria-label': 'Название ссылки' });
    const url = el('input', { type: 'text', inputmode: 'url', placeholder: 'Вставьте https://… или t.me/…', 'aria-label': 'Ссылка' });
    const err = el('small', { class: 'ed-err', role: 'status' });
    const feedback = el('div', { class: 'stat-status', role: 'status' });
    let editing = null, removed = null;
    const normalize = value => {
      let u = value.trim(); if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
      const parsed = new URL(u);
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname.includes('.') || parsed.username || parsed.password) throw new Error();
      return parsed.href;
    };
    const count = el('span', { class: 'link-count' });
    const update = () => { count.textContent = `${list.children.length}/${limit}`; };
    const make = ({ label: l, url: u }) => {
      const card = el('div', { class: 'link-card', 'data-label': l, 'data-url': u });
      const info = el('div', { class: 'link-info' }, el('b', { text: l }), el('span', { text: u }));
      card.append(el('span', { class: 'link-emblem', text: u.includes('t.me/') ? '↗' : '◎', 'aria-hidden': 'true' }), info,
        el('div', { class: 'link-tools' },
          el('button', { type: 'button', text: '↑', 'aria-label': 'Ссылка выше', onclick: () => { if (card.previousElementSibling) list.insertBefore(card, card.previousElementSibling); } }),
          el('button', { type: 'button', text: '↓', 'aria-label': 'Ссылка ниже', onclick: () => { if (card.nextElementSibling) list.insertBefore(card.nextElementSibling, card); } }),
          el('button', { type: 'button', text: 'Править', onclick: () => { editing = card; url.value = card.dataset.url; label.value = card.dataset.label; action.textContent = 'Обновить ссылку'; cancel.hidden = false; url.focus(); } }),
          el('button', { type: 'button', text: '×', 'aria-label': 'Удалить ссылку ' + l, onclick: () => {
            if (editing === card) reset(); removed = { card, next: card.nextElementSibling }; card.remove(); update();
            feedback.replaceChildren('Ссылка удалена ', el('button', { type: 'button', text: 'Отменить', onclick: () => { if (removed && list.children.length < limit) { list.insertBefore(removed.card, removed.next?.parentNode === list ? removed.next : null); removed = null; feedback.replaceChildren(); update(); } } }));
          } })));
      return card;
    };
    const reset = () => { editing = null; url.value = ''; label.value = ''; url.setCustomValidity(''); err.textContent = ''; action.textContent = 'Добавить ссылку'; cancel.hidden = true; };
    const add = () => {
      if (!url.value.trim()) return true;
      let u; try { u = normalize(url.value); } catch { err.textContent = 'Введите корректную ссылку сайта'; url.setCustomValidity(err.textContent); url.reportValidity(); return false; }
      if ([...list.children].some(c => c !== editing && c.dataset.url.replace(/\/$/, '') === u.replace(/\/$/, ''))) { err.textContent = 'Эта ссылка уже добавлена'; return false; }
      if (!editing && list.children.length >= limit) { err.textContent = `Можно добавить до ${limit} ссылок`; return false; }
      const card = make({ label: label.value.trim() || guessLabel(u), url: u });
      if (editing) editing.replaceWith(card); else list.append(card);
      reset(); update(); url.focus(); return true;
    };
    const action = el('button', { type: 'button', class: 'btn-mini', text: 'Добавить ссылку', onclick: add });
    const cancel = el('button', { type: 'button', class: 'btn-mini', text: 'Отмена', hidden: '', onclick: reset });
    items.forEach(i => list.append(make(i)));
    root.append(el('div', { class: 'link-heading' }, el('span', { text: 'Ссылки на странице' }), count), list, feedback,
      el('div', { class: 'link-compose' }, el('label', { class: 'stat-field' }, el('span', { text: 'Ссылка' }), url), el('label', { class: 'stat-field' }, el('span', { text: 'Название кнопки · необязательно' }), label), el('div', { class: 'link-actions' }, action, cancel)), err);
    url.addEventListener('input', () => { url.setCustomValidity(''); err.textContent = ''; try { label.placeholder = guessLabel(normalize(url.value)); } catch { label.placeholder = 'Подберём автоматически'; } });
    [label, url].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }));
    document.querySelector('#event-form').addEventListener('submit', e => { if (!add()) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
    update();
    return () => [...list.children].map(c => ({ label: c.dataset.label, url: c.dataset.url }));
  }
  const getLinks = linksEditor($('#links'), initial.links);

  // ---- цифры
  const stats = $('#stats');
  let removedStat = null;
  const statStatus = document.createElement('div'); statStatus.className = 'stat-status'; statStatus.setAttribute('role', 'status'); stats.after(statStatus);
  const statCard = (s = { value: '', label: '' }) => {
    const value = el('input', { class: 'sc-value', type: 'text', maxlength: 20, value: s.value, placeholder: 'Например: 138 или $200', 'aria-label': 'Значение' });
    const label = el('textarea', { class: 'sc-label', rows: 2, maxlength: 80, placeholder: 'Что означает эта цифра?', 'aria-label': 'Подпись' }, s.label);
    const previewValue = el('b', { text: s.value || '—' }), previewLabel = el('span', { text: s.label || 'Подпись к цифре' });
    const c = el('div', { class: 'stat-card' });
    const control = el('div', { class: 'stat-controls' }, el('span', { class: 'stat-number', text: 'Карточка' }),
      el('button', { type: 'button', 'aria-label': 'Переместить цифру выше', text: '↑', onclick: () => { if (c.previousElementSibling) stats.insertBefore(c, c.previousElementSibling); } }),
      el('button', { type: 'button', 'aria-label': 'Переместить цифру ниже', text: '↓', onclick: () => { if (c.nextElementSibling) stats.insertBefore(c.nextElementSibling, c); } }),
      el('button', { type: 'button', class: 'stat-delete', 'aria-label': 'Удалить цифру', text: '×', onclick: () => {
        removedStat = { card: c, next: c.nextElementSibling }; c.remove();
        const undo = el('button', { type: 'button', text: 'Отменить', onclick: () => { if (removedStat) { stats.insertBefore(removedStat.card, removedStat.next?.parentNode === stats ? removedStat.next : null); removedStat = null; statStatus.replaceChildren(); } } });
        statStatus.replaceChildren('Карточка удалена ', undo);
      } }));
    c.append(control, el('div', { class: 'stat-preview', 'aria-hidden': 'true' }, previewValue, previewLabel),
      el('label', { class: 'stat-field' }, el('span', { text: 'Значение' }), value),
      el('label', { class: 'stat-field' }, el('span', { text: 'Подпись' }), label));
    c.addEventListener('input', () => { previewValue.textContent = value.value || '—'; previewLabel.textContent = label.value || 'Подпись к цифре'; });
    return c;
  };
  const updateStats = () => {
    [...stats.children].forEach((card, i) => { card.querySelector('.stat-number').textContent = `Карточка ${i + 1}`; const buttons = card.querySelectorAll('.stat-controls button'); buttons[0].disabled = i === 0; buttons[1].disabled = i === stats.children.length - 1; });
    const add = document.querySelector('[data-add="stat"]'); add.disabled = stats.children.length >= 8; add.textContent = `+ Добавить цифру · ${stats.children.length}/8`;
  };
  new MutationObserver(updateStats).observe(stats, { childList: true });
  initial.stats.forEach((s) => stats.append(statCard(s)));
  updateStats();

  // ---- программа
  const agenda = $('#agenda');
  let removedAgenda = null;
  const agendaStatus = el('div', { class: 'stat-status', role: 'status' }); agenda.after(agendaStatus);
  const agendaCard = (a = { title: '', text: '' }) => {
    const c = el('div', { class: 'agenda-card', 'data-id': a.id || newId() });
    const controls = el('div', { class: 'stat-controls' }, el('span', { class: 'agenda-number' }),
      el('button', { type: 'button', 'aria-label': 'Переместить пункт выше', text: '↑', onclick: () => { if (c.previousElementSibling) agenda.insertBefore(c, c.previousElementSibling); } }),
      el('button', { type: 'button', 'aria-label': 'Переместить пункт ниже', text: '↓', onclick: () => { if (c.nextElementSibling) agenda.insertBefore(c.nextElementSibling, c); } }),
      el('button', { type: 'button', class: 'stat-delete', 'aria-label': 'Удалить пункт программы', text: '×', onclick: () => {
        removedAgenda = { card: c, next: c.nextElementSibling }; c.remove();
        agendaStatus.replaceChildren('Пункт удалён ', el('button', { type: 'button', text: 'Отменить', onclick: () => {
          if (removedAgenda) { agenda.insertBefore(removedAgenda.card, removedAgenda.next?.parentNode === agenda ? removedAgenda.next : null); removedAgenda = null; agendaStatus.replaceChildren(); }
        } }));
      } }));
    c.append(controls,
      el('label', { class: 'stat-field' }, el('span', { text: 'Тема' }), el('input', { class: 'ag-title', type: 'text', maxlength: 120, value: a.title, placeholder: 'Например: Живое демо', 'aria-label': 'Заголовок' })),
      el('label', { class: 'stat-field' }, el('span', { text: 'Что разберём' }), el('textarea', { class: 'ag-text', rows: 2, maxlength: 500, placeholder: 'Кратко опишите содержание пункта', 'aria-label': 'Описание' }, a.text)));
    return c;
  };
  const updateAgenda = () => {
    [...agenda.children].forEach((card, i) => { card.querySelector('.agenda-number').textContent = `Пункт ${String(i + 1).padStart(2, '0')}`; const buttons = card.querySelectorAll('.stat-controls button'); buttons[0].disabled = i === 0; buttons[1].disabled = i === agenda.children.length - 1; });
    const add = document.querySelector('[data-add="agenda"]'); add.disabled = agenda.children.length >= 12; add.textContent = `+ Добавить пункт · ${agenda.children.length}/12`;
  };
  new MutationObserver(updateAgenda).observe(agenda, { childList: true });
  initial.agenda.forEach((a) => agenda.append(agendaCard(a)));
  updateAgenda();

  // ---- спикеры
  const speakers = $('#speakers');
  const speakerStatus = el('div', { class: 'stat-status', role: 'status' }); speakers.after(speakerStatus);
  const speakerCard = (sp = {}) => {
    const id = sp.id || newId();
    const file = el('input', { type: 'file', name: 'photo_' + id, accept: PHOTO_TYPES.join(','), class: 'sr-only' });
    const img = el('img', { alt: '', hidden: '' });
    const drop = el('label', { class: 'dropzone' }, file, img, el('span', { class: 'dz-hint', text: 'Перетащите фото сюда или нажмите' }));
    const msg = el('span', { class: 'dz-msg', role: 'status' });
    const replace = el('button', { type: 'button', class: 'photo-replace', text: 'Загрузить фото', onclick: () => file.click() });
    const clear = el('button', { type: 'button', text: 'Убрать фото', hidden: '' });
    const card = el('div', { class: 'speaker-card', 'data-id': id, 'data-remove-photo': '' });

    const show = (src) => { img.src = src; img.hidden = false; drop.classList.add('has-img'); clear.hidden = false; replace.textContent = 'Заменить фото'; card.dataset.removePhoto = ''; };
    const accept = (f) => {
      if (!PHOTO_TYPES.includes(f.type)) { msg.textContent = 'Нужен JPG, PNG или WebP'; return false; }
      if (f.size > MAX_PHOTO) { msg.textContent = 'Файл больше 5 МБ'; return false; }
      msg.textContent = ''; return true;
    };
    if (sp.photo_url) show(sp.photo_url);
    file.addEventListener('change', () => { const f = file.files[0]; if (f && accept(f)) show(URL.createObjectURL(f)); else file.value = ''; });
    ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => {
      const f = e.dataTransfer.files[0];
      if (!f || !accept(f)) return;
      const dt = new DataTransfer(); dt.items.add(f); file.files = dt.files; show(URL.createObjectURL(f));
    });
    clear.addEventListener('click', () => { file.value = ''; img.hidden = true; img.removeAttribute('src'); drop.classList.remove('has-img'); clear.hidden = true; replace.textContent = 'Загрузить фото'; msg.textContent = ''; card.dataset.removePhoto = '1'; });

    const linksRoot = el('div', { class: 'sp-links' });
    const controls = el('div', { class: 'stat-controls' }, el('span', { class: 'speaker-number' }),
      el('button', { type: 'button', text: '↑', 'aria-label': 'Переместить спикера выше', onclick: () => { if (card.previousElementSibling) speakers.insertBefore(card, card.previousElementSibling); } }),
      el('button', { type: 'button', text: '↓', 'aria-label': 'Переместить спикера ниже', onclick: () => { if (card.nextElementSibling) speakers.insertBefore(card.nextElementSibling, card); } }),
      el('button', { type: 'button', class: 'stat-delete', text: '×', 'aria-label': 'Удалить спикера', onclick: () => {
        const next = card.nextElementSibling; card.remove();
        speakerStatus.replaceChildren('Спикер удалён ', el('button', { type: 'button', text: 'Отменить', onclick: () => { speakers.insertBefore(card, next?.parentNode === speakers ? next : null); speakerStatus.replaceChildren(); } }));
      } }));
    const field = (text, input) => el('label', { class: 'stat-field' }, el('span', { text }), input);
    card.append(controls,
      el('div', { class: 'sp-grid' },
        el('div', { class: 'sp-photo' }, el('span', { text: 'Фото спикера' }), drop,
          el('div', { class: 'dz-actions' }, replace, clear), el('small', { text: 'JPG, PNG или WebP · до 5 МБ' }), msg),
        el('div', { class: 'sp-fields' },
          field('Имя и фамилия', el('input', { class: 'sp-name', type: 'text', maxlength: 120, value: sp.name || '', placeholder: 'Например: Владислав Попов' })),
          field('Роль и специализация', el('input', { class: 'sp-role', type: 'text', maxlength: 160, value: sp.role || '', placeholder: 'Должность или профессиональная роль' })),
          field('О спикере', el('textarea', { class: 'sp-bio', rows: 5, maxlength: 1200, placeholder: 'Опыт, проекты и достижения' }, sp.bio || '')))),
      el('div', { class: 'sp-social' }, el('h3', { text: 'Ссылки спикера' }), linksRoot));
    card.getLinks = linksEditor(linksRoot, sp.links || []);
    return card;
  };
  const updateSpeakers = () => {
    [...speakers.children].forEach((card, i) => {
      card.querySelector('.speaker-number').textContent = `Спикер ${String(i + 1).padStart(2, '0')}`;
      const buttons = card.querySelectorAll('.stat-controls button'); buttons[0].disabled = i === 0; buttons[1].disabled = i === speakers.children.length - 1;
    });
  };
  new MutationObserver(updateSpeakers).observe(speakers, { childList: true });
  initial.speakers.forEach((sp) => speakers.append(speakerCard(sp)));
  updateSpeakers();

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-add]');
    if (!t) return;
    const map = { stat: [stats, statCard], agenda: [agenda, agendaCard], speaker: [speakers, speakerCard] };
    const [root, make] = map[t.dataset.add];
    if (t.dataset.add === 'agenda' && agenda.children.length >= 12) return;
    if (t.dataset.add === 'stat' && stats.children.length >= 8) return;
    const card = make(); root.append(card); (card.querySelector('.sp-name') || card.querySelector('input') || card).focus();
  });

  // ---- отправка
  $('#event-form').addEventListener('submit', () => {
    addAudience();
    const val = (c, s) => c.querySelector(s).value.trim();
    $('#payload').value = JSON.stringify({
      coauthors: getCoauthors(),
      audience: [...audience.querySelectorAll('.chip')].map((c) => ({ id: c.dataset.id, text: c.dataset.value })),
      links: getLinks(),
      stats: [...stats.children].map((c) => ({ value: val(c, '.sc-value'), label: val(c, '.sc-label') })),
      agenda: [...agenda.children].map((c) => ({ id: c.dataset.id, title: val(c, '.ag-title'), text: val(c, '.ag-text') })),
      speakers: [...speakers.children].map((c) => ({
        id: c.dataset.id, name: val(c, '.sp-name'), role: val(c, '.sp-role'), bio: val(c, '.sp-bio'),
        links: c.getLinks(), remove_photo: c.dataset.removePhoto === '1',
      })),
    });
  });

  // ---- «Подтянуть дату из Google Calendar»
  const btn = $('#meet-lookup'), status = $('#meet-status');
  if (!btn) return;
  const say = (text, cls = '', ...extra) => { status.className = cls; status.replaceChildren(text, ...extra); };
  async function lookup() {
    const meet = document.querySelector('[name=meet_url]').value.trim();
    if (!meet) return say('Сначала вставьте ссылку на звонок', 'bad');
    say('Ищу встречу в календаре…');
    let d;
    try {
      d = await (await fetch('/api/meet-lookup?' + new URLSearchParams({ url: meet, tz: document.querySelector('[name=timezone]').value }))).json();
    } catch { return say('Не получилось связаться с сервером', 'bad'); }

    if (d.needs_auth) {
      const allow = el('button', { type: 'button', class: 'btn-mini', text: 'Разрешить чтение календаря', onclick: () => {
        const w = window.open('/auth/calendar', 'gcal', 'width=520,height=700');
        if (!w) return say('Браузер заблокировал окно: разрешите всплывающие окна для этого сайта', 'bad');
        // postMessage из окна Google может не дойти (Google обрывает связь с opener), поэтому ждём закрытия окна и повторяем поиск
        const timer = setInterval(() => { if (w.closed) { clearInterval(timer); lookup(); } }, 600);
      } });
      return say('Нужно один раз разрешить чтение вашего календаря (только чтение). ', '', allow);
    }
    if (d.found) {
      for (const k of ['start', 'end', 'timezone']) document.querySelector(`[name=${k}]`).value = d[k];
      const title = document.querySelector('[name=title]');
      if (!title.value.trim() && d.title) title.value = d.title;
      return say(`Нашёл «${d.title || 'встречу'}»: дата и время подставлены. Проверьте их.`, 'ok');
    }
    const errors = { bad_link: 'Это не похоже на ссылку Google Meet (нужна вида meet.google.com/abc-defg-hij)',
      api_disabled: 'В проекте Google Cloud не включён Google Calendar API. Включите его и повторите',
      failed: 'Google Calendar не ответил, попробуйте ещё раз' };
    say(d.error ? errors[d.error] : 'Не нашёл встречу с этой ссылкой в ваших календарях. Дату можно указать вручную', 'bad');
  }
  btn.addEventListener('click', lookup);
})();

(() => {
  const copy = document.querySelector('[data-copy-address]');
  if (copy) copy.addEventListener('click', async () => {
    const code = document.querySelector('[data-event-path]');
    const status = document.querySelector('[data-copy-status]');
    try { await navigator.clipboard.writeText(new URL(code.dataset.eventPath, location.origin).href); copy.textContent = '✓ Скопировано'; status.textContent = 'Полная ссылка в буфере'; }
    catch { status.textContent = 'Выделите ссылку и скопируйте вручную'; }
  });
  const root = document.querySelector('#event-tags');
  if (!root) return;
  const hidden = document.querySelector('[name="hashtag"]'), input = document.querySelector('#tag-input'), status = document.querySelector('#tag-status');
  let tags = hidden.value.split(',').filter(Boolean);
  function render() {
    root.replaceChildren(); hidden.value = tags.join(',');
    tags.forEach(tag => {
      const chip = document.createElement('span'); chip.className = 'event-sticker';
      const text = document.createElement('span'); text.textContent = '#' + tag;
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', 'Удалить стикер ' + tag);
      remove.onclick = () => { tags = tags.filter(t => t !== tag); render(); input.focus(); };
      chip.append(text, remove); root.append(chip);
    });
  }
  function add(value) {
    const tag = value.trim().replace(/^#/, '');
    if (!tag) return;
    if (!/^[\p{L}\p{N}_-]{1,30}$/u.test(tag)) { status.textContent = 'Используйте буквы, цифры, дефис или подчёркивание'; return; }
    if (!tags.includes(tag)) {
      if ([...tags, tag].join(',').length > 40) { status.textContent = 'Общая длина стикеров — до 40 символов'; return; }
      tags.push(tag);
    }
    input.value = ''; status.textContent = 'Стикеры показываются над заголовком'; render(); input.focus();
  }
  document.querySelector('#tag-add').onclick = () => add(input.value);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(input.value); } });
  document.querySelectorAll('[data-tag]').forEach(button => button.onclick = () => add(button.dataset.tag));
  document.querySelector('#event-form').addEventListener('submit', e => { if (input.value.trim()) { add(input.value); if (input.value.trim()) e.preventDefault(); } });
  render();
})();

(() => {
  const root = document.querySelector('.ed-schedule'); if (!root) return;
  const start = root.querySelector('[name="start"]'), end = root.querySelector('[name="end"]'), zone = root.querySelector('[name="timezone"]');
  zone.setAttribute('list', 'timezone-options');
  const summary = root.querySelector('#schedule-summary');
  function update() {
    const a = new Date(start.value), b = new Date(end.value);
    const duration = Math.round((b - a) / 60000);
    end.setCustomValidity(duration <= 0 ? 'Конец должен быть позже начала' : '');
    let validZone = true; try { new Intl.DateTimeFormat('ru', { timeZone: zone.value }); } catch { validZone = false; }
    zone.setCustomValidity(validZone ? '' : 'Выберите существующий часовой пояс');
    summary.textContent = !start.value || !end.value ? 'Выберите дату и время встречи' : duration <= 0 ? 'Укажите конец позже начала' : `${a.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })} · ${start.value.slice(11)}–${end.value.slice(11)} · ${duration} мин · ${zone.value}`;
    summary.classList.toggle('invalid', duration <= 0 || !validZone);
    root.querySelectorAll('[data-duration]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.duration) === duration)));
  }
  root.querySelectorAll('[data-duration]').forEach(button => button.onclick = () => {
    if (!start.value) { start.focus(); return; }
    const date = new Date(start.value); date.setMinutes(date.getMinutes() + Number(button.dataset.duration));
    const pad = n => String(n).padStart(2, '0');
    end.value = `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    end.dispatchEvent(new Event('input', { bubbles: true })); update();
  });
  root.addEventListener('input', update); root.addEventListener('change', update);
  root.querySelector('.copy-meet').onclick = async () => {
    const status = root.querySelector('#meet-copy-status');
    const value = root.querySelector('[name="meet_url"]').value.trim();
    if (!value) { status.textContent = 'Сначала добавьте ссылку'; return; }
    try { await navigator.clipboard.writeText(value); status.textContent = '✓ Ссылка скопирована'; } catch { status.textContent = 'Выделите ссылку и скопируйте вручную'; }
  };
  update();
})();
