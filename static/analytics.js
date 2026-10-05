// Google Analytics только после согласия (GDPR): до нажатия «Принять» к Google не уходит ни одного запроса
// и не ставится ни одной cookie. Отдаётся через /analytics.js: сервер подставляет ID счётчика и пути без аналитики.
(function () {
  var GA_ID = __GA_ID__;
  var SKIP = new RegExp(__SKIP__);  // вход и редактирование: строгий CSP, GA там не грузим
  var KEY = 'cv_cookie_consent';     // 'granted' | 'denied'
  var VERSION = '1';                 // поменять, если изменится смысл согласия: всех спросят заново

  function read() {
    try { var v = JSON.parse(localStorage.getItem(KEY)); return v && v.v === VERSION ? v.c : null; } catch (e) { return null; }
  }
  function save(choice) {
    try { localStorage.setItem(KEY, JSON.stringify({ v: VERSION, c: choice, at: new Date().toISOString() })); } catch (e) {}
  }

  var loaded = false;
  function loadGA() {
    if (loaded || SKIP.test(location.pathname)) return;
    loaded = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { dataLayer.push(arguments); };
    gtag('consent', 'default', { analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
    gtag('js', new Date());
    gtag('config', GA_ID, { anonymize_ip: true });
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA_ID);
    document.head.appendChild(s);
  }

  function dropGACookies() {  // отозвали согласие: стираем cookie GA на этом домене и на родительском
    var host = location.hostname.replace(/^www\./, '');
    document.cookie.split(';').forEach(function (c) {
      var name = c.split('=')[0].trim();
      if (name === '_ga' || name.indexOf('_ga_') === 0 || name === '_gid') {
        ['', '; domain=' + host, '; domain=.' + host].forEach(function (d) {
          document.cookie = name + '=; Max-Age=0; path=/' + d;
        });
      }
    });
  }

  var banner = null;
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }
  function hide() { if (banner) { banner.remove(); banner = null; } }
  function show() {
    if (banner || SKIP.test(location.pathname)) return;
    banner = el('div', 'cookie-banner');
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-live', 'polite');
    banner.setAttribute('aria-label', 'Согласие на cookies');
    banner.appendChild(el('p', '', 'Мы используем cookies Google Analytics, чтобы понимать, какие страницы полезны. ' +
      'Рекламы и передачи данных для неё нет. Можно отказаться — сайт будет работать так же.'));
    var actions = el('div', 'cookie-actions');
    var no = el('button', 'btn btn-ghost', 'Отклонить');
    var yes = el('button', 'btn btn-primary', 'Принять');
    no.type = yes.type = 'button';
    no.addEventListener('click', function () {
      var was = read();
      save('denied'); hide(); dropGACookies();
      if (was === 'granted' && loaded) location.reload();  // gtag уже работает на странице — выгружаем его
    });
    yes.addEventListener('click', function () { save('granted'); hide(); loadGA(); });
    actions.appendChild(no);
    actions.appendChild(yes);
    banner.appendChild(actions);
    document.body.appendChild(banner);
    yes.focus({ preventScroll: true });
  }

  function init() {
    document.querySelectorAll('[data-cookie-settings]').forEach(function (a) {
      a.hidden = false;
      a.addEventListener('click', function (e) { e.preventDefault(); show(); });
    });
    var choice = read();
    if (choice === 'granted') loadGA();
    else if (choice !== 'denied') show();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
