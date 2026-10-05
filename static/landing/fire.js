(() => {
  if (!document.body.hasAttribute('data-landing')) return; // фишка только для лендинга
  const button = document.querySelector('.btn-ghost');
  if (!button || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'fire-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');
  let active = false, particles = [], frame = 0, previous = 0;
  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize(); addEventListener('resize', resize);
  function draw(now) {
    const dt = Math.min((now - previous) / 16.67 || 1, 2); previous = now;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    if (active) {
      const r = button.getBoundingClientRect();
      for (let i = 0; i < 12; i++) {
        const spark = Math.random() < .1;
        particles.push({ x: r.left + Math.random() * r.width, y: r.bottom - 6,
          vx: (Math.random() - .5) * 5, vy: -1 - Math.random() * 3,
          size: spark ? 1.5 : 12 + Math.random() * 20, life: 1,
          decay: spark ? .012 : .016 + Math.random() * .012, phase: Math.random() * 6.28, spark });
      }
    }
    ctx.globalCompositeOperation = 'lighter';
    for (const p of particles) {
      p.life -= p.decay * dt; p.x += (p.vx + Math.sin(now / 180 + p.phase) * 1.2) * dt;
      p.y += p.vy * dt; p.vy -= .025 * dt;
      if (p.life <= 0) continue;
      const radius = p.size * Math.sqrt(p.life);
      const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
      gradient.addColorStop(0, `rgba(255,${Math.round(120 + 120 * p.life)},${Math.round(80 * p.life)},${p.life * .55})`);
      gradient.addColorStop(.35, `rgba(255,95,5,${p.life * .35})`);
      gradient.addColorStop(1, 'rgba(180,20,0,0)');
      ctx.fillStyle = gradient; ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    particles = particles.filter(p => p.life > 0);
    if (active || particles.length) frame = requestAnimationFrame(draw); else frame = 0;
  }
  function start() { active = true; if (!frame) { previous = performance.now(); frame = requestAnimationFrame(draw); } }
  function stop() { active = false; }
  button.addEventListener('pointerenter', start); button.addEventListener('pointerleave', stop);
  button.addEventListener('focus', start); button.addEventListener('blur', stop);
})();
