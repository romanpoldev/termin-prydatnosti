/* Розбір і форматування дат. Працює і в браузері (window.Dates), і в Node (тести). */
(function (root) {
  function pad(n) { return String(n).padStart(2, '0'); }

  function lastDay(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

  function makeIso(y, m, d) {
    if (y < 100) y += 2000;
    if (!(y >= 2000 && y <= 2100 && m >= 1 && m <= 12)) return null;
    if (d === 'last') d = lastDay(y, m);
    if (!(d >= 1 && d <= lastDay(y, m))) return null;
    return y + '-' + pad(m) + '-' + pad(d);
  }

  /**
   * Перетворює введення працівника на YYYY-MM-DD.
   * Підтримує: 201026, 20102026, 20.10.26, 20.10.2026, 20/10/26, 2026-10-20,
   * а також місяць+рік: 1026, 10.26, 10.2026 → останній день місяця.
   */
  function parse(input) {
    var s = String(input || '').trim();
    if (!s) return null;
    var iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    if (iso) return makeIso(+iso[1], +iso[2], +iso[3]);

    if (/^\d+$/.test(s)) {
      if (s.length === 6) return makeIso(+s.slice(4, 6), +s.slice(2, 4), +s.slice(0, 2));
      if (s.length === 8) return makeIso(+s.slice(4, 8), +s.slice(2, 4), +s.slice(0, 2));
      if (s.length === 4) return makeIso(+s.slice(2, 4), +s.slice(0, 2), 'last');
      return null;
    }

    var parts = s.split(/[.\/\-\s,]+/).filter(Boolean);
    if (parts.some(function (p) { return !/^\d+$/.test(p); })) return null;
    if (parts.length === 3) return makeIso(+parts[2], +parts[1], +parts[0]);
    if (parts.length === 2) return makeIso(+parts[1], +parts[0], 'last');
    return null;
  }

  /** YYYY-MM-DD → ДД.ММ.РРРР */
  function format(iso) {
    if (!iso) return '';
    var p = iso.split('-');
    return p[2] + '.' + p[1] + '.' + p[0];
  }

  function todayIso() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  /** Скільки днів від сьогодні до дати (відʼємне — прострочено). */
  function daysFromToday(iso) {
    var a = todayIso().split('-'), b = iso.split('-');
    var t1 = Date.UTC(+a[0], +a[1] - 1, +a[2]);
    var t2 = Date.UTC(+b[0], +b[1] - 1, +b[2]);
    return Math.round((t2 - t1) / 86400000);
  }

  /** Попередження для сумнівної дати або порожній рядок. */
  function warning(iso) {
    if (!iso) return '';
    var days = daysFromToday(iso);
    if (days < 0) return 'Ця дата вже минула';
    if (days === 0) return 'Термін спливає сьогодні';
    if (days > 365 * 5) return 'Дата більш ніж через 5 років — перевірте';
    return '';
  }

  var api = { parse: parse, format: format, todayIso: todayIso, daysFromToday: daysFromToday, warning: warning };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Dates = api;
})(this);
