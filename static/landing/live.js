// Code Vibe: живой слой — курсоры, следы и разрезы других посетителей в реальном времени.
// Сервер — WebSocket /ws/live (live.py). Своя раскладка у каждого остаётся своей:
// по сети ходят только курсор, штрихи и разрезы. Нет соединения — лендинг работает как обычно.
// Фишка только для лендинга: без <body data-landing> модуль ничего не делает.
(() => {
  if (!document.body.hasAttribute('data-landing') || !('WebSocket' in window)) return;

  const CURSOR_EVERY = 50; // мс между отправками курсора
  const FLUSH_EVERY = 50; // мс между пачками точек штриха
  const IDLE_AFTER = 6000; // мс без движения — курсор гаснет

  const online = document.querySelector('[data-online]');
  const layer = document.createElement('div');
  layer.className = 'live-layer';
  layer.setAttribute('aria-hidden', 'true');
  document.body.append(layer);

  const peers = new Map(); // u -> { name, color, rgb, el, timer }
  let ws = null;
  let retry = 1000;

  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const send = (msg) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };

  function updateOnline() {
    if (!online) return;
    const connected = ws?.readyState === WebSocket.OPEN;
    online.hidden = !connected;
    online.textContent = `· ${peers.size + 1} онлайн`;
  }

  function addPeer({ u, name, color }) {
    if (peers.has(u)) return;
    const el = document.createElement('div');
    el.className = 'live-cursor idle';
    el.style.setProperty('--c', color);
    el.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24"><path d="M4 3l7 18 2.5-7.5L21 11z" fill="currentColor" stroke="#07070A" stroke-width="1.5" stroke-linejoin="round"/></svg><span></span>';
    el.querySelector('span').textContent = name;
    layer.append(el);
    peers.set(u, { name, color, rgb: rgb(color), el, timer: 0 });
    updateOnline();
  }

  function removePeer(u) {
    peers.get(u)?.el.remove();
    peers.delete(u);
    updateOnline();
  }

  function moveCursor(peer, x, y) {
    peer.el.style.transform = `translate(${x * innerWidth}px, ${y}px)`;
    peer.el.classList.remove('idle');
    clearTimeout(peer.timer);
    peer.timer = setTimeout(() => peer.el.classList.add('idle'), IDLE_AFTER);
  }

  function onMessage(msg) {
    if (msg.t === 'hello') {
      peers.forEach((_, u) => removePeer(u));
      msg.peers.forEach(addPeer);
      // новичок сразу видит буквы, которые порезали до него
      for (const c of msg.cuts) document.dispatchEvent(new CustomEvent('landing:remote-cut', { detail: c }));
      updateOnline();
      return;
    }
    if (msg.t === 'join') return addPeer(msg);
    if (msg.t === 'leave') return removePeer(msg.u);
    const peer = peers.get(msg.u);
    if (!peer) return;
    if (msg.t === 'c') moveCursor(peer, msg.x, msg.y);
    else if (msg.t === 'x') document.dispatchEvent(new CustomEvent('landing:remote-cut', { detail: msg }));
    else if (msg.t === 's') {
      const pts = msg.p.map(([x, y]) => [x * innerWidth, y - scrollY]);
      document.dispatchEvent(new CustomEvent('landing:remote-stroke', {
        detail: { key: `${msg.u}:${msg.s}`, k: msg.k, color: peer.rgb, pts },
      }));
      const [x, y] = msg.p.at(-1);
      moveCursor(peer, x, y);
    }
  }

  function connect() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/live`);
    ws.onopen = () => { retry = 1000; updateOnline(); };
    ws.onmessage = (e) => {
      try { onMessage(JSON.parse(e.data)); } catch {}
    };
    ws.onclose = () => {
      peers.forEach((_, u) => removePeer(u));
      updateOnline();
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 15000);
    };
  }
  connect();

  // ---- свои события наружу ----
  const page = (x, y) => [+(x / innerWidth).toFixed(4), Math.round(y + scrollY)];

  let lastCursor = 0;
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    const now = performance.now();
    if (now - lastCursor < CURSOR_EVERY) return;
    lastCursor = now;
    const [x, y] = page(e.clientX, e.clientY);
    send({ t: 'c', x, y });
  });

  let strokeId = 0;
  let stroke = null; // { k, pts }
  function flush() {
    if (stroke?.pts.length) send({ t: 's', s: strokeId, k: stroke.k, p: stroke.pts.splice(0) });
  }
  setInterval(flush, FLUSH_EVERY);

  document.addEventListener('landing:point', (e) => {
    const { k, x, y, start } = e.detail;
    if (start || !stroke) {
      flush();
      strokeId = (strokeId + 1) % 1000000;
      stroke = { k, pts: [] };
    }
    stroke.pts.push(page(x, y));
    if (stroke.pts.length >= 60) flush();
  });

  document.addEventListener('landing:cut', (e) => {
    const r4 = (p) => p.map((v) => +v.toFixed(4));
    send({ t: 'x', i: e.detail.i, a: r4(e.detail.a), b: r4(e.detail.b) });
  });
})();
