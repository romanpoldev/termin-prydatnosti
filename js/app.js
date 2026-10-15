/* Сторінка приймання товару: вхід за PIN, сесія поставки, сканування, фото дати, черга без інтернету. */
(function () {
  'use strict';

  var APP_VERSION = '3.0.0';
  // Сервер за замовчуванням (Supabase). Інший можна задати в налаштуваннях або посиланням ?api=
  var DEFAULT_API = 'https://zsxwxaosspbjltmvdtpc.supabase.co/functions/v1/api';
  var API_RE = /^https:\/\/([a-z0-9-]+\.supabase\.co\/functions\/v1\/|script\.google(usercontent)?\.com\/).+/;
  var $ = function (id) { return document.getElementById(id); };

  // ---------------------------------------------------------------------------
  // Локальне сховище
  // ---------------------------------------------------------------------------
  var LS = {
    get: function (k, d) {
      try { var v = localStorage.getItem('tp_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set: function (k, v) { try { localStorage.setItem('tp_' + k, JSON.stringify(v)); } catch (e) { /* повне сховище */ } },
    del: function (k) { try { localStorage.removeItem('tp_' + k); } catch (e) { /* ignore */ } }
  };

  // Адресу сервера можна передати посиланням: index.html?api=https://script.google.com/...
  (function readApiParam() {
    var p = new URLSearchParams(location.search).get('api');
    if (p && API_RE.test(p)) {
      LS.set('api', p);
      history.replaceState(null, '', location.pathname);
    }
  })();

  var state = {
    api: (function () {
      var saved = LS.get('api', '');
      // Перехід з Apps Script на Supabase: стара адреса замінюється автоматично.
      if (!saved || /script\.google/.test(saved)) { LS.set('api', DEFAULT_API); return DEFAULT_API; }
      return saved;
    })(),
    user: LS.get('user', null),           // { name, pin }
    data: LS.get('data', { suppliers: [], categories: [], products: {} }),
    session: LS.get('session', null),     // { id, supplier, startedAt, items: [] }
    item: null,                           // товар, який зараз приймаємо
    scanner: null,
    scanning: false,
    pendingPhoto: null,
    lastCode: { code: '', at: 0 },
    flushing: false,
    serverVersion: ''
  };

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var toastTimer;
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 2500);
  }

  // ---------------------------------------------------------------------------
  // Черга запитів без інтернету (IndexedDB)
  // ---------------------------------------------------------------------------
  var dbPromise = null;
  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open('termin-prydatnosti', 1);
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains('queue')) d.createObjectStore('queue', { keyPath: 'key', autoIncrement: true });
        if (!d.objectStoreNames.contains('failed')) d.createObjectStore('failed', { keyPath: 'key', autoIncrement: true });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }
  function store(name, mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(name, mode);
        var out = fn(tx.objectStore(name));
        tx.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }
  var queue = {
    add: function (item) { return store('queue', 'readwrite', function (s) { return s.add(item); }); },
    all: function () { return store('queue', 'readonly', function (s) { return s.getAll(); }); },
    remove: function (key) { return store('queue', 'readwrite', function (s) { return s.delete(key); }); },
    count: function () { return store('queue', 'readonly', function (s) { return s.count(); }); },
    fail: function (item) { return store('failed', 'readwrite', function (s) { delete item.key; return s.add(item); }); }
  };

  // ---------------------------------------------------------------------------
  // Звʼязок із сервером
  // ---------------------------------------------------------------------------
  function NetworkError(msg) { this.message = msg; this.network = true; }

  function api(action, payload, timeoutMs) {
    if (!state.api) return Promise.reject(new Error('Не вказано адресу сервера'));
    var body = Object.assign({ action: action, pin: state.user ? state.user.pin : '' }, payload || {});
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs || 30000) : null;
    // text/plain — без попереднього CORS-запиту, який Apps Script не підтримує.
    return fetch(state.api, {
      method: 'POST',
      body: JSON.stringify(body),
      redirect: 'follow',
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) {
      return r.text().then(function (txt) {
        var j;
        try { j = JSON.parse(txt); } catch (e) {
          throw new Error('Сервер відповів не так, як очікувалось. Перевірте адресу й доступ «Будь-хто».');
        }
        if (!j.ok) throw new Error(j.error || 'Помилка сервера');
        return j;
      });
    }, function () {
      throw new NetworkError('Немає звʼязку з сервером');
    }).finally(function () { if (timer) clearTimeout(timer); });
  }

  /** Надіслати одразу або поставити в чергу, якщо немає звʼязку (порядок зберігається). */
  function sendOrQueue(action, payload) {
    return queue.count().then(function (n) {
      if (n > 0 || !navigator.onLine) {
        return queue.add({ action: action, payload: payload, at: Date.now() }).then(function () {
          updateNet(); flushQueue(); return { queued: true };
        });
      }
      return api(action, payload, 60000).then(function (r) { return { queued: false, result: r }; }, function (err) {
        if (err.network) {
          return queue.add({ action: action, payload: payload, at: Date.now() }).then(function () {
            updateNet(); return { queued: true };
          });
        }
        throw err;
      });
    });
  }

  function flushQueue() {
    if (state.flushing || !navigator.onLine || !state.user) return Promise.resolve();
    state.flushing = true;
    return queue.all().then(function (items) {
      var chain = Promise.resolve(true);
      items.forEach(function (it) {
        chain = chain.then(function (go) {
          if (!go) return false;
          return api(it.action, it.payload, 60000).then(function () {
            markSent(it);
            return queue.remove(it.key).then(function () { return true; });
          }, function (err) {
            if (err.network) return false;
            // Помилка даних: відкладаємо запис окремо, щоб не блокувати решту черги.
            it.error = err.message;
            toast('Не вдалося зберегти запис: ' + err.message, 5000);
            return queue.fail(it).then(function () { return queue.remove(it.key); }).then(function () { return true; });
          });
        });
      });
      return chain;
    }).catch(function () { /* ignore */ }).then(function () {
      state.flushing = false;
      updateNet();
    });
  }

  function markSent(it) {
    if (it.action !== 'saveItem' || !state.session) return;
    state.session.items.forEach(function (x) { if (x.id === it.payload.clientId) x.status = 'sent'; });
    saveSession();
    renderSessionItems();
  }

  function updateNet() {
    var online = navigator.onLine;
    $('netBadge').classList.toggle('off', !online);
    queue.count().then(function (n) {
      $('netBadge').title = (online ? 'Є звʼязок' : 'Немає звʼязку') + (n ? ', у черзі: ' + n : '');
      $('queueCard').hidden = !n;
      $('queueText').textContent = n ? 'Очікують відправки: ' + n : '';
    }).catch(function () { /* ignore */ });
  }

  // ---------------------------------------------------------------------------
  // Навігація
  // ---------------------------------------------------------------------------
  var SCREENS = ['scrSetup', 'scrLogin', 'scrHome', 'scrSession', 'scrScan', 'scrSettings', 'scrCalendar', 'scrMonth',
    'scrInvoices', 'scrInvoice'];
  var current = '';

  function show(id, title) {
    if (current === 'scrScan' && id !== 'scrScan') stopScanner();
    SCREENS.forEach(function (s) { $(s).hidden = s !== id; });
    current = id;
    $('title').textContent = title || 'Термін придатності';
    var loggedIn = !!state.user;
    $('btnSettings').hidden = !loggedIn || id === 'scrSettings' || id === 'scrSetup';
    $('btnBack').hidden = ['scrSession', 'scrScan', 'scrSettings', 'scrCalendar', 'scrMonth', 'scrInvoices', 'scrInvoice'].indexOf(id) === -1 ||
      (id === 'scrSettings' && !loggedIn);
    window.scrollTo(0, 0);
  }

  function goHome() {
    if (!state.api) return showSetup();
    if (!state.user) return showLogin();
    $('hello').textContent = 'Вітаю, ' + state.user.name + '!';
    $('btnContinue').hidden = !state.session;
    $('btnStart').hidden = !!state.session;
    if (state.session) {
      $('btnContinue').textContent = '↩ Продовжити приймання (' + (state.session.supplier || 'без постачальника') +
        ', позицій: ' + state.session.items.length + ')';
    }
    updateNet();
    show('scrHome');
  }

  function showSetup() {
    $('setupUrl').value = state.api || '';
    $('setupMsg').textContent = '';
    show('scrSetup', 'Підключення');
  }

  function showLogin() {
    $('pin').value = '';
    $('loginMsg').textContent = '';
    show('scrLogin', 'Вхід');
    setTimeout(function () { $('pin').focus(); }, 100);
  }

  // ---------------------------------------------------------------------------
  // Підключення та вхід
  // ---------------------------------------------------------------------------
  $('btnSetupSave').onclick = function () {
    var url = $('setupUrl').value.trim();
    if (!url) url = DEFAULT_API;
    if (!API_RE.test(url)) {
      $('setupMsg').textContent = 'Адреса має бути сервером Supabase (…supabase.co/functions/v1/…) або Apps Script.';
      return;
    }
    state.api = url;
    LS.set('api', url);
    goHome();
  };

  $('btnLogin').onclick = login;
  $('pin').addEventListener('keydown', function (e) { if (e.key === 'Enter') login(); });

  function login() {
    var pin = $('pin').value.trim();
    if (!pin) return;
    $('btnLogin').disabled = true;
    $('loginMsg').textContent = '';
    state.user = { name: '', pin: pin };
    api('bootstrap').then(function (r) {
      state.user.name = r.name;
      LS.set('user', state.user);
      applyBootstrap(r);
      goHome();
    }, function (err) {
      state.user = null;
      $('loginMsg').textContent = err.message;
    }).finally(function () { $('btnLogin').disabled = false; });
  }

  function applyBootstrap(r) {
    var products = {};
    (r.products || []).forEach(function (p) { if (p.b) products[p.b] = { n: p.n, c: p.c }; });
    state.data = { suppliers: r.suppliers || [], categories: r.categories || [], products: products };
    state.serverVersion = r.version || '';
    LS.set('data', state.data);
  }

  function refreshData(silent) {
    if (!state.user || !navigator.onLine) return Promise.resolve();
    return api('bootstrap').then(function (r) {
      applyBootstrap(r);
      if (!silent) toast('Довідники оновлено');
    }, function (err) {
      if (!silent) toast(err.message, 4000);
      if (/PIN/.test(err.message)) { logout(true); }
    });
  }

  // ---------------------------------------------------------------------------
  // Сесія приймання
  // ---------------------------------------------------------------------------
  function saveSession() { if (state.session) LS.set('session', state.session); else LS.del('session'); }

  var chosenSupplier = '';
  $('btnStart').onclick = function () {
    chosenSupplier = '';
    $('supplierInput').value = '';
    renderSuppliers();
    show('scrSession', 'Нова поставка');
  };

  function renderSuppliers() {
    var box = $('supplierList');
    box.innerHTML = '';
    state.data.suppliers.forEach(function (s) {
      var b = document.createElement('button');
      b.className = 'chip' + (s === chosenSupplier ? ' active' : '');
      b.textContent = s;
      b.onclick = function () { chosenSupplier = s; $('supplierInput').value = ''; renderSuppliers(); };
      box.appendChild(b);
    });
    if (!state.data.suppliers.length) box.innerHTML = '<p class="hint">Список постачальників порожній — впишіть назву нижче.</p>';
  }
  $('supplierInput').addEventListener('input', function () { chosenSupplier = ''; renderSuppliers(); });

  $('btnSessionGo').onclick = function () {
    var supplier = $('supplierInput').value.trim() || chosenSupplier;
    if (!supplier) { toast('Оберіть або впишіть постачальника'); return; }
    state.session = { id: uuid(), supplier: supplier, startedAt: new Date().toISOString(), items: [] };
    saveSession();
    if (state.data.suppliers.indexOf(supplier) === -1) {
      state.data.suppliers.push(supplier);
      LS.set('data', state.data);
    }
    sendOrQueue('startSession', { sessionId: state.session.id, supplier: supplier, startedAt: state.session.startedAt })
      .catch(function (err) { toast(err.message, 4000); });
    openScan();
  };

  $('btnContinue').onclick = openScan;

  function openScan() {
    $('sessionInfo').textContent = state.session.supplier;
    renderSessionItems();
    closeItem();
    show('scrScan', 'Приймання');
  }

  $('btnFinish').onclick = function () {
    if (state.item && !confirm('Поточний товар не збережено. Все одно завершити?')) return;
    var n = state.session.items.length;
    if (!confirm('Завершити приймання? Позицій: ' + n)) return;
    var id = state.session.id;
    sendOrQueue('closeSession', { sessionId: id, closedAt: new Date().toISOString() })
      .catch(function (err) { toast(err.message, 4000); });
    var supplier = state.session.supplier;
    state.session = null;
    state.item = null;
    saveSession();
    // Одразу пропонуємо сфотографувати накладну цієї поставки (D-12); «‹» — на головну.
    openInvoice(id, { from: 'finish', supplier: supplier, items: n });
  };

  function renderSessionItems() {
    var ul = $('sessionItems');
    var items = state.session ? state.session.items : [];
    $('listTitle').hidden = !items.length;
    ul.innerHTML = items.slice().reverse().map(function (it) {
      var dates = it.entries.map(function (e) { return e.qty + ' шт до ' + Dates.format(e.date); }).join(' · ');
      return '<li><div><div>' + esc(it.name) + '</div><div class="dates">' + esc(dates) + '</div></div>' +
        '<span class="st" title="' + (it.status === 'sent' ? 'Збережено' : 'Чекає звʼязку') + '">' +
        (it.status === 'sent' ? '✓' : '⏳') + '</span></li>';
    }).join('');
  }

  // ---------------------------------------------------------------------------
  // Сканер штрих-кодів
  // ---------------------------------------------------------------------------
  function startScanner() {
    $('cameraMsg').textContent = '';
    if (state.scanning) return;
    if (!window.Html5Qrcode) {
      $('cameraMsg').textContent = 'Сканер не завантажився (немає інтернету?). Введіть штрих-код вручну.';
      return;
    }
    var F = window.Html5QrcodeSupportedFormats;
    if (!state.scanner) {
      state.scanner = new Html5Qrcode('reader', {
        formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.ITF, F.QR_CODE],
        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
        verbose: false
      });
    }
    state.scanning = true;
    state.scanner.start(
      { facingMode: 'environment' },
      {
        fps: 10,
        qrbox: function (w, h) {
          var bw = Math.max(120, Math.floor(w * 0.85));
          var bh = Math.max(80, Math.floor(Math.min(h * 0.55, w * 0.5)));
          return { width: bw, height: bh };
        }
      },
      onCode,
      function () { /* кадр без коду — норма */ }
    ).catch(function (err) {
      state.scanning = false;
      var msg = String(err && err.message || err);
      $('cameraMsg').textContent = /Permission|NotAllowed/i.test(msg)
        ? 'Немає доступу до камери. Дозвольте камеру в налаштуваннях браузера або введіть код вручну.'
        : 'Камера недоступна: ' + msg;
    });
  }

  function stopScanner() {
    if (!state.scanner || !state.scanning) return Promise.resolve();
    state.scanning = false;
    return state.scanner.stop().catch(function () { /* вже зупинено */ });
  }

  function onCode(text) {
    var code = String(text || '').trim();
    var now = Date.now();
    if (!code || (code === state.lastCode.code && now - state.lastCode.at < 2500)) return;
    state.lastCode = { code: code, at: now };
    if (navigator.vibrate) navigator.vibrate(80);
    stopScanner().then(function () { openItem(code); });
  }

  $('btnManualCode').onclick = function () {
    var code = $('manualCode').value.replace(/\s+/g, '');
    if (!code) return;
    $('manualCode').value = '';
    stopScanner().then(function () { openItem(code); });
  };
  $('manualCode').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('btnManualCode').click(); });

  // ---------------------------------------------------------------------------
  // Картка товару
  // ---------------------------------------------------------------------------
  function newEntry() {
    return {
      id: uuid(), qty: '', photo: 'none', dateAi: null, confidence: '', raw: '', note: '', computed: false,
      photoUrl: '', photoB64: '', confirmed: false, dateManual: null, editing: false, error: ''
    };
  }

  function openItem(barcode) {
    var known = state.data.products[barcode];
    state.item = {
      id: uuid(), barcode: barcode, known: !!known,
      name: known ? known.n : '', nameSuggested: '', nameSource: known ? 'existing' : '',
      category: known ? known.c : '', productPhotoUrl: '',
      entries: [newEntry()]
    };
    $('scanBox').hidden = true;
    $('itemCard').hidden = false;
    $('itemMsg').textContent = '';
    $('itemCode').textContent = barcode;
    renderItemHead();

    var already = state.session.items.filter(function (x) { return x.barcode === barcode; });
    if (already.length) toast('Цей товар уже є в поставці — буде додано ще одну позицію', 3500);

    if (!known) {
      $('newProduct').hidden = false;
      $('nameInput').value = '';
      $('nameStatus').hidden = true;
      $('newProductHint').textContent = 'Новий товар. Сфотографуйте лицьову сторону — назву сформує ШІ.';
      renderCategories('');
      if (navigator.onLine) {
        $('newProductHint').innerHTML = '<span class="spinner"></span>Шукаю товар…';
        api('getProduct', { barcode: barcode }).then(function (r) {
          if (!state.item || state.item.barcode !== barcode) return;
          if (r.found) {
            state.data.products[barcode] = { n: r.product.n, c: r.product.c };
            LS.set('data', state.data);
            state.item.known = true;
            state.item.name = r.product.n;
            state.item.nameSource = 'existing';
            $('newProduct').hidden = true;
            renderItemHead();
          } else if (r.off && r.off.name) {
            setSuggestedName(r.off.name, 'off');
            $('newProductHint').textContent = 'Знайдено у відкритій базі Open Food Facts. Перевірте назву або сфотографуйте товар.';
          } else {
            $('newProductHint').textContent = 'Новий товар. Сфотографуйте лицьову сторону — назву сформує ШІ.';
          }
          updateSaveButton();
        }, function () {
          $('newProductHint').textContent = 'Новий товар. Сфотографуйте лицьову сторону або впишіть назву.';
        });
      } else {
        $('newProductHint').textContent = 'Немає звʼязку. Впишіть назву товару вручну.';
      }
    } else {
      $('newProduct').hidden = true;
    }
    renderEntries();
  }

  function renderItemHead() {
    var it = state.item;
    $('itemNameView').textContent = it.known ? it.name : 'Новий товар';
  }

  function renderCategories(selected) {
    var sel = $('categorySelect');
    var cats = state.data.categories.length ? state.data.categories : ['Інше'];
    sel.innerHTML = '<option value="">— оберіть —</option>' + cats.map(function (c) {
      return '<option' + (c === selected ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
  }

  function setSuggestedName(name, source) {
    state.item.name = name;
    state.item.nameSuggested = name;
    state.item.suggestedSource = source;
    state.item.nameSource = source;
    $('nameInput').value = name;
  }

  $('nameInput').addEventListener('input', function () {
    var v = $('nameInput').value;
    state.item.name = v.trim();
    state.item.nameSource = (state.item.nameSuggested && v.trim() === state.item.nameSuggested)
      ? state.item.suggestedSource : 'manual';
    updateSaveButton();
  });
  $('categorySelect').addEventListener('change', function () {
    state.item.category = $('categorySelect').value;
  });

  $('btnCancelItem').onclick = function () {
    var dirty = state.item && state.item.entries.some(function (e) { return e.photo !== 'none' || e.qty || e.dateManual; });
    if (dirty && !confirm('Скасувати цей товар? Введені дані не збережуться.')) return;
    closeItem();
  };

  function closeItem() {
    state.item = null;
    $('itemCard').hidden = true;
    $('scanBox').hidden = false;
    $('manualCode').value = '';
    if (current === 'scrScan' || !current) setTimeout(startScanner, 50);
    else startScannerWhenVisible();
  }
  function startScannerWhenVisible() {
    // викликається, коли екран приймання показано
    setTimeout(function () { if (current === 'scrScan' && !state.item) startScanner(); }, 50);
  }

  // Фото товару → назва від ШІ
  $('btnNamePhoto').onclick = function () { takePhoto({ kind: 'name' }); };

  function recognizeName(b64) {
    var it = state.item;
    var st = $('nameStatus');
    st.hidden = false;
    st.className = 'status wait';
    st.innerHTML = '<span class="spinner"></span>Розпізнаю назву…';
    api('recognizeName', { image: b64, barcode: it.barcode }, 60000).then(function (r) {
      if (state.item !== it) return;
      it.productPhotoB64 = b64;
      if (r.name) {
        setSuggestedName(r.name, 'ai');
        st.className = 'status ' + (r.confidence === 'high' ? 'ok' : 'warn');
        st.textContent = r.confidence === 'high' ? 'Назву розпізнано. Можна виправити в полі нижче.' : 'Перевірте назву — ШІ не впевнений.';
      } else {
        st.className = 'status bad';
        st.textContent = 'Не вдалося прочитати назву. Впишіть вручну.';
      }
      if (r.category) { it.category = r.category; renderCategories(r.category); }
      updateSaveButton();
    }, function (err) {
      if (state.item !== it) return;
      st.className = 'status bad';
      st.textContent = (err.network ? 'Немає звʼязку. ' : err.message + '. ') + 'Впишіть назву вручну.';
    });
  }

  // ---------------------------------------------------------------------------
  // Дати
  // ---------------------------------------------------------------------------
  $('btnAddEntry').onclick = function () {
    state.item.entries.push(newEntry());
    renderEntries();
    updateSaveButton();
  };

  function finalDate(e) {
    if (e.dateManual) return e.dateManual;
    if (e.confirmed && e.dateAi) return e.dateAi;
    return null;
  }

  function renderEntries() {
    var it = state.item;
    var box = $('entries');
    box.innerHTML = '';
    it.entries.forEach(function (e, idx) { box.appendChild(renderEntry(e, idx, it.entries.length)); });
    updateSaveButton();
  }

  function renderEntry(e, idx, total) {
    var el = document.createElement('div');
    el.className = 'entry';
    var html = '<div class="entry-head"><span>Дата ' + (idx + 1) + '</span>' +
      (total > 1 ? '<button class="icon-btn" data-act="remove" aria-label="Прибрати">✕</button>' : '') + '</div>';

    var fd = finalDate(e);
    if (fd && !e.editing) {
      html += '<div class="status ok">✅ Термін до <span class="big-date">' + Dates.format(fd) + '</span>' +
        (Dates.warning(fd) ? '<span class="raw">⚠ ' + esc(Dates.warning(fd)) + '</span>' : '') + '</div>' +
        '<button class="btn small" data-act="edit">✏️ Змінити дату</button>';
    } else if (e.photo === 'loading') {
      html += '<div class="status wait"><span class="spinner"></span>Розпізнаю дату…</div>';
    } else if (e.photo === 'done' && e.dateAi && !e.editing) {
      var cls = e.confidence === 'high' ? 'ok' : (e.confidence === 'medium' ? 'warn' : 'bad');
      var label = e.confidence === 'high' ? 'Розпізнано' : 'Перевірте уважно';
      html += '<div class="status ' + cls + '">' + label + ':<span class="big-date">' + Dates.format(e.dateAi) + '</span>' +
        (e.raw ? '<span class="raw">На упаковці: «' + esc(e.raw) + '»</span><br>' : '') +
        (e.computed ? '<span class="raw">Дату обчислено з дати виготовлення та терміну.</span><br>' : '') +
        (e.note ? '<span class="raw">' + esc(e.note) + '</span><br>' : '') +
        (Dates.warning(e.dateAi) ? '<span class="raw">⚠ ' + esc(Dates.warning(e.dateAi)) + '</span>' : '') +
        '</div>' +
        '<div class="two"><button class="btn ok" data-act="confirm">✅ Вірно</button>' +
        '<button class="btn" data-act="edit">✏️ Виправити</button></div>';
    } else {
      if (e.error) html += '<div class="status bad">' + esc(e.error) + '</div>';
      if (e.editing || e.photo === 'done' || e.error) {
        html += '<label class="field">Дата вручну (напр. 201026 = 20.10.2026)' +
          '<input type="text" inputmode="numeric" data-act="manual" placeholder="ДДММРР" autocomplete="off" value="' +
          esc(e.dateManual ? Dates.format(e.dateManual) : '') + '"></label>' +
          '<div class="hint" data-role="preview"></div>' +
          '<div class="two"><button class="btn primary" data-act="manualOk">Готово</button>' +
          '<button class="btn" data-act="photo">📷 Фото ще раз</button></div>';
      } else {
        html += '<button class="btn primary" data-act="photo">📷 Фото дати</button>' +
          '<button class="btn small" data-act="edit">або ввести вручну</button>';
      }
    }

    html += '<label class="field">Кількість, шт' +
      '<input type="number" inputmode="numeric" min="1" step="1" data-act="qty" value="' + esc(e.qty) + '"></label>';
    el.innerHTML = html;

    el.addEventListener('click', function (ev) {
      var act = ev.target.getAttribute && ev.target.getAttribute('data-act');
      if (!act) return;
      if (act === 'remove') { state.item.entries = state.item.entries.filter(function (x) { return x !== e; }); renderEntries(); }
      if (act === 'photo') takePhoto({ kind: 'date', entryId: e.id });
      if (act === 'confirm') { e.confirmed = true; e.dateManual = null; e.editing = false; renderEntries(); focusQty(e); }
      if (act === 'edit') { e.editing = true; renderEntries(); focusManual(e); }
      if (act === 'manualOk') {
        var inp = el.querySelector('[data-act="manual"]');
        var iso = Dates.parse(inp.value);
        if (!iso) { el.querySelector('[data-role="preview"]').textContent = 'Не розумію дату. Приклад: 201026'; return; }
        e.dateManual = iso; e.editing = false; e.error = '';
        renderEntries(); focusQty(e);
      }
    });
    el.addEventListener('input', function (ev) {
      var act = ev.target.getAttribute('data-act');
      if (act === 'qty') { e.qty = ev.target.value; updateSaveButton(); }
      if (act === 'manual') {
        var iso = Dates.parse(ev.target.value);
        var pv = el.querySelector('[data-role="preview"]');
        pv.textContent = iso ? '→ ' + Dates.format(iso) + (Dates.warning(iso) ? ' · ⚠ ' + Dates.warning(iso) : '') : '';
      }
    });
    el.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && ev.target.getAttribute('data-act') === 'manual') {
        el.querySelector('[data-act="manualOk"]').click();
      }
    });
    el.dataset.entry = e.id;
    return el;
  }

  function focusQty(e) {
    setTimeout(function () {
      var el = document.querySelector('[data-entry="' + e.id + '"] [data-act="qty"]');
      if (el && !el.value) el.focus();
    }, 50);
  }
  function focusManual(e) {
    setTimeout(function () {
      var el = document.querySelector('[data-entry="' + e.id + '"] [data-act="manual"]');
      if (el) el.focus();
    }, 50);
  }

  function recognizeDate(entryId, b64) {
    var it = state.item;
    var e = it.entries.filter(function (x) { return x.id === entryId; })[0];
    if (!e) return;
    e.photo = 'loading'; e.error = ''; e.confirmed = false; e.dateManual = null; e.editing = false;
    e.photoB64 = b64; e.photoUrl = '';
    renderEntries();
    api('recognizeDate', { image: b64, barcode: it.barcode }, 60000).then(function (r) {
      if (state.item !== it) return;
      e.photo = 'done';
      e.photoUrl = r.photoUrl || '';
      if (e.photoUrl) e.photoB64 = '';
      e.dateAi = r.date; e.confidence = r.confidence; e.raw = r.raw; e.note = r.note; e.computed = r.computed;
      if (!r.date) { e.error = 'Не вдалося прочитати дату' + (r.note ? ': ' + r.note : '') + '. Введіть вручну або сфотографуйте ближче.'; e.editing = true; }
      renderEntries();
      if (!r.date) focusManual(e);
    }, function (err) {
      if (state.item !== it) return;
      e.photo = 'error';
      e.editing = true;
      e.error = err.network
        ? 'Немає звʼязку. Введіть дату вручну — фото збережеться і відправиться пізніше.'
        : err.message + '. Введіть дату вручну.';
      renderEntries();
      focusManual(e);
    });
  }

  function updateSaveButton() {
    var it = state.item;
    if (!it) return;
    var nameOk = it.known || !!(it.name && it.name.trim());
    var entriesOk = it.entries.length > 0 && it.entries.every(function (e) {
      return finalDate(e) && Number(e.qty) > 0 && Number.isInteger(Number(e.qty));
    });
    $('btnSaveItem').disabled = !(nameOk && entriesOk);
  }

  $('btnSaveItem').onclick = function () {
    var it = state.item;
    if (!it) return;
    if (!it.known && !it.category) {
      if (!confirm('Категорію не обрано — нагадування буде за стандартним порогом. Зберегти?')) return;
    }
    var now = new Date().toISOString();
    var payload = {
      clientId: it.id,
      sessionId: state.session.id,
      barcode: it.barcode,
      name: it.known ? '' : it.name.trim(),
      nameSource: it.known ? 'existing' : (it.nameSource || 'manual'),
      category: it.category || '',
      productPhotoBase64: it.known ? '' : (it.productPhotoB64 || ''),
      entries: it.entries.map(function (e) {
        return {
          entryId: e.id,
          qty: Number(e.qty),
          date: finalDate(e),
          dateAi: e.dateAi || '',
          dateManual: e.dateManual || '',
          confidence: e.dateManual ? 'manual' : e.confidence,
          raw: e.raw || '',
          photoUrl: e.photoUrl || '',
          photoBase64: e.photoUrl ? '' : (e.photoB64 || ''),
          savedAt: now
        };
      })
    };
    var displayName = it.known ? it.name : it.name.trim();
    var rec = {
      id: it.id, barcode: it.barcode, name: displayName, status: 'queued',
      entries: payload.entries.map(function (e) { return { qty: e.qty, date: e.date }; })
    };
    state.session.items.push(rec);
    saveSession();
    if (!it.known) {
      state.data.products[it.barcode] = { n: displayName, c: it.category || '' };
      LS.set('data', state.data);
    }
    $('btnSaveItem').disabled = true;
    sendOrQueue('saveItem', payload).then(function (res) {
      rec.status = res.queued ? 'queued' : 'sent';
      saveSession();
      renderSessionItems();
      toast(res.queued ? 'Збережено в телефоні — відправиться, коли зʼявиться звʼязок' : 'Збережено ✓');
    }, function (err) {
      state.session.items = state.session.items.filter(function (x) { return x !== rec; });
      saveSession();
      renderSessionItems();
      $('itemMsg').textContent = err.message;
      $('btnSaveItem').disabled = false;
      throw err;
    }).then(function () {
      closeItem();
    }, function () { /* залишаємо картку відкритою */ });
    renderSessionItems();
  };

  // ---------------------------------------------------------------------------
  // Фото: стиснення перед відправкою
  // ---------------------------------------------------------------------------
  function takePhoto(target) {
    state.pendingPhoto = target;
    var inp = $('fileInput');
    inp.value = '';
    inp.click();
  }

  $('fileInput').addEventListener('change', function () {
    var file = this.files && this.files[0];
    var target = state.pendingPhoto;
    state.pendingPhoto = null;
    if (!file || !target || (target.kind !== 'compare' && target.kind !== 'invoice' && !state.item)) return;
    // Накладна — дрібний текст у таблиці, тому більша роздільність.
    var big = target.kind === 'invoice';
    resizeImage(file, big ? 2200 : 1280, big ? 0.82 : 0.85).then(function (b64) {
      if (target.kind === 'invoice') uploadInvoicePage(target, b64);
      else if (target.kind === 'compare') compareModels(b64);
      else if (target.kind === 'name') recognizeName(b64);
      else recognizeDate(target.entryId, b64);
    }, function () { toast('Не вдалося обробити фото', 3000); });
  });

  function resizeImage(file, maxSide, quality) {
    var load = window.createImageBitmap
      ? createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () { return loadImg(file); })
      : loadImg(file);
    return load.then(function (img) {
      var w = img.width, h = img.height;
      var k = Math.min(1, maxSide / Math.max(w, h));
      var c = document.createElement('canvas');
      c.width = Math.round(w * k); c.height = Math.round(h * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', quality).split(',')[1];
    });
  }
  function loadImg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = reject;
      img.src = url;
    });
  }

  // ---------------------------------------------------------------------------
  // Календар термінів (перегляд): місяці → товари місяця за датою
  // ---------------------------------------------------------------------------
  var MONTHS = ['Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень',
    'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень'];
  var MONTHS_SHORT = ['Січ', 'Лют', 'Бер', 'Кві', 'Тра', 'Чер', 'Лип', 'Сер', 'Вер', 'Жов', 'Лис', 'Гру'];
  var WEEKDAYS = ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  var cal = { data: LS.get('calendar', null), loading: false, key: '' };

  function plural(n, one, few, many) {
    var a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b === 1) return one;
    if (b >= 2 && b <= 4) return few;
    return many;
  }
  function nBatches(n) { return n + ' ' + plural(n, 'партія', 'партії', 'партій'); }
  function daysLabel(days) {
    if (days < 0) return 'прострочено ' + (-days) + ' ' + plural(-days, 'день', 'дні', 'днів');
    if (days === 0) return 'сьогодні';
    if (days === 1) return 'завтра';
    return 'через ' + days + ' ' + plural(days, 'день', 'дні', 'днів');
  }
  /** Колір партії: прострочено — червоний, у межах порогу категорії — жовтий. */
  function level(b) {
    var days = Dates.daysFromToday(b.d);
    return days < 0 ? 'bad' : (days <= b.r ? 'warn' : '');
  }
  function monthKey(y, m) { return y + '-' + String(m).padStart(2, '0'); }
  function stamp(ms) {
    var d = new Date(ms), p = function (n) { return String(n).padStart(2, '0'); };
    return p(d.getDate()) + '.' + p(d.getMonth() + 1) + ' о ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  $('btnCalendar').onclick = function () { showCalendar(true); };
  $('btnCalRefresh').onclick = function () { loadCalendar(true); };

  function showCalendar(reload) {
    show('scrCalendar', 'Календар термінів');
    renderCalendar();
    if (reload) loadCalendar(false);
  }

  function loadCalendar(manual) {
    if (cal.loading) return;
    if (!navigator.onLine) {
      $('calMsg').textContent = cal.data
        ? 'Немає звʼязку — показано дані, збережені в телефоні.'
        : 'Немає звʼязку. Календар зʼявиться, коли телефон підключиться до інтернету.';
      return;
    }
    cal.loading = true;
    $('btnCalRefresh').disabled = true;
    $('calMsg').innerHTML = cal.data ? '' : '<span class="spinner"></span>Завантажую…';
    api('calendar').then(function (r) {
      cal.data = { batches: r.batches || [], at: Date.now() };
      LS.set('calendar', cal.data);
      $('calMsg').textContent = '';
      renderCalendar();
      if (current === 'scrMonth') renderMonth();
      if (manual) toast('Календар оновлено');
    }, function (err) {
      $('calMsg').textContent = (err.network ? 'Немає звʼязку з сервером.' : err.message) +
        (cal.data ? ' Показано дані, збережені в телефоні.' : '');
      if (/PIN/.test(err.message)) logout(true);
    }).finally(function () {
      cal.loading = false;
      $('btnCalRefresh').disabled = false;
    });
  }

  function renderCalendar() {
    var d = cal.data;
    $('calStamp').textContent = d ? 'Оновлено ' + stamp(d.at) : '';
    if (!d) { $('calAlerts').innerHTML = ''; $('calMonths').innerHTML = ''; return; }

    var today = Dates.todayIso();
    var y0 = +today.slice(0, 4), m0 = +today.slice(5, 7);
    var stats = {}, overdue = { n: 0, q: 0 }, soon = { n: 0, q: 0 };
    d.batches.forEach(function (b) {
      var k = b.d.slice(0, 7);
      var s = stats[k] || (stats[k] = { n: 0, q: 0, warn: false, bad: false });
      s.n++; s.q += b.q;
      var lv = level(b);
      if (lv === 'bad') { s.bad = true; overdue.n++; overdue.q += b.q; }
      if (lv === 'warn') { s.warn = true; soon.n++; soon.q += b.q; }
    });

    // Швидкі списки: прострочені та ті, що підходять до порогу категорії.
    var alerts = '';
    if (overdue.n) {
      alerts += '<button class="cal-alert bad" data-key="overdue"><b>⚠ Прострочено: ' + nBatches(overdue.n) + '</b>' +
        '<span>' + overdue.q + ' шт — перевірте й приберіть з полиць</span></button>';
    }
    if (soon.n) {
      alerts += '<button class="cal-alert warn" data-key="soon"><b>⏰ Термін наближається: ' + nBatches(soon.n) + '</b>' +
        '<span>' + soon.q + ' шт — за порогом нагадування категорії</span></button>';
    }
    if (!d.batches.length) alerts = '<div class="card muted">Партій із залишком поки немає.</div>';
    $('calAlerts').innerHTML = alerts;

    // Місяці: 12 найближчих завжди, далі — лише ті, де є партії.
    var keys = [];
    for (var i = 0; i < 12; i++) {
      var mm = (m0 - 1 + i) % 12 + 1, yy = y0 + Math.floor((m0 - 1 + i) / 12);
      keys.push(monthKey(yy, mm));
    }
    Object.keys(stats).sort().forEach(function (k) { if (k > keys[11]) keys.push(k); });

    var html = '', year = '';
    keys.forEach(function (k) {
      var y = k.slice(0, 4), m = +k.slice(5, 7);
      if (y !== year) {
        if (year) html += '</div>';
        html += '<h2 class="list-title">' + y + '</h2><div class="month-grid">';
        year = y;
      }
      var s = stats[k];
      var cls = 'month-tile' + (k === keys[0] ? ' current' : '') + (!s ? ' empty' : '') +
        (s && s.bad ? ' bad' : (s && s.warn ? ' warn' : ''));
      html += '<button class="' + cls + '" data-key="' + k + '"' + (s ? '' : ' disabled') + '>' +
        '<span class="m-name">' + MONTHS_SHORT[m - 1] + '</span>' +
        '<span class="m-count">' + (s ? s.n : '—') + '</span>' +
        '<span class="m-sub">' + (s ? plural(s.n, 'партія', 'партії', 'партій') + ' · ' + s.q + ' шт' : '') + '</span>' +
        '</button>';
    });
    if (year) html += '</div>';
    $('calMonths').innerHTML = html;
  }

  function onCalClick(ev) {
    var btn = ev.target.closest && ev.target.closest('[data-key]');
    if (!btn || btn.disabled) return;
    cal.key = btn.getAttribute('data-key');
    renderMonth();
    var k = cal.key;
    show('scrMonth', k === 'overdue' ? 'Прострочено' : k === 'soon' ? 'Термін наближається'
      : MONTHS[+k.slice(5, 7) - 1] + ' ' + k.slice(0, 4));
  }
  $('calAlerts').addEventListener('click', onCalClick);
  $('calMonths').addEventListener('click', onCalClick);

  function renderMonth() {
    var k = cal.key;
    var list = (cal.data ? cal.data.batches : []).filter(function (b) {
      if (k === 'overdue') return level(b) === 'bad';
      if (k === 'soon') return level(b) === 'warn';
      return b.d.slice(0, 7) === k;
    }).sort(function (a, b) { return a.d < b.d ? -1 : a.d > b.d ? 1 : a.n.localeCompare(b.n, 'uk'); });

    var total = list.reduce(function (s, b) { return s + b.q; }, 0);
    $('monthSummary').textContent = list.length ? nBatches(list.length) + ' · ' + total + ' шт' : '';
    if (!list.length) { $('monthList').innerHTML = '<div class="card muted">Тут партій немає.</div>'; return; }

    var html = '', day = '';
    list.forEach(function (b) {
      if (b.d !== day) {
        if (day) html += '</ul>';
        day = b.d;
        var p = b.d.split('-');
        var wd = WEEKDAYS[new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay()];
        var days = Dates.daysFromToday(b.d);
        html += '<div class="day-head' + (days < 0 ? ' bad' : '') + '"><b>' + Dates.format(b.d) + '</b>, ' + wd +
          ' · ' + daysLabel(days) + '</div><ul class="items">';
      }
      var lv = level(b);
      html += '<li class="' + lv + '"><div><div>' + esc(b.n) + '</div>' +
        '<div class="dates">' + esc(b.b) + (b.c ? ' · ' + esc(b.c) : '') +
        (lv === 'warn' ? ' · нагадування за ' + b.r + ' ' + plural(b.r, 'день', 'дні', 'днів') : '') + '</div></div>' +
        '<span class="qty">' + b.q + ' шт</span></li>';
    });
    html += '</ul>';
    $('monthList').innerHTML = html;
  }

  // ---------------------------------------------------------------------------
  // Накладні (етап 3, D-12): фото сторінок → ШІ читає рядки → звірка з прийнятим
  // ---------------------------------------------------------------------------
  var inv = { sessionId: '', from: '', data: null, busy: false, list: null, checked: {} };

  function dt(iso) {
    if (!iso) return '';
    var d = new Date(iso), p = function (n) { return String(n).padStart(2, '0'); };
    return p(d.getDate()) + '.' + p(d.getMonth() + 1) + ' о ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function qtyText(q, unit) {
    if (q == null) return '—';
    return String(q).replace('.', ',') + ' ' + (unit || 'шт');
  }
  function nLines(n) { return n + ' ' + plural(n, 'рядок', 'рядки', 'рядків'); }

  $('btnInvoices').onclick = function () { showInvoices(true); };
  $('btnInvListRefresh').onclick = function () { loadInvoiceList(); };

  function showInvoices(reload) {
    show('scrInvoices', 'Накладні');
    renderInvoiceList();
    if (reload || !inv.list) loadInvoiceList();
  }

  function loadInvoiceList() {
    if (!navigator.onLine) { $('invListMsg').textContent = 'Немає звʼязку. Накладні потребують інтернету.'; return; }
    $('btnInvListRefresh').disabled = true;
    $('invListMsg').innerHTML = inv.list ? '' : '<span class="spinner"></span>Завантажую поставки…';
    // Спершу відправляємо чергу, щоб на сервері були останні поставки.
    flushQueue().then(function () { return api('recentSessions'); }).then(function (r) {
      inv.list = r;
      $('invListMsg').textContent = '';
      renderInvoiceList();
    }, function (err) {
      $('invListMsg').textContent = err.network ? 'Немає звʼязку з сервером.' : err.message;
      if (/PIN/.test(err.message)) logout(true);
    }).finally(function () { $('btnInvListRefresh').disabled = false; });
  }

  function sessionBadge(x) {
    if (!x.pages) return '<span class="badge">без накладної</span>';
    if (x.pending) return '<span class="badge warn">не звірено</span>';
    return '<span class="badge ok">звірено · ' + nLines(x.lines) + '</span>';
  }

  function renderInvoiceList() {
    var l = inv.list;
    $('invListSub').textContent = l ? 'Поставки за ' + l.days + ' ' + plural(l.days, 'день', 'дні', 'днів') : '';
    if (!l) { $('invList').innerHTML = ''; return; }
    if (!l.sessions.length) { $('invList').innerHTML = '<div class="card muted">Поставок за цей час немає.</div>'; return; }
    $('invList').innerHTML = l.sessions.map(function (x) {
      return '<button class="sess-btn" data-id="' + esc(x.id) + '"><span class="s-main">' +
        '<div class="s-name">' + esc(x.supplier || 'Без постачальника') + '</div>' +
        '<div class="small-text">' + esc(dt(x.openedAt)) + ' · позицій: ' + esc(x.items) +
        (x.status === 'open' ? ' · ще приймається' : '') + '</div></span>' + sessionBadge(x) + '</button>';
    }).join('');
  }
  $('invList').addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('[data-id]');
    if (b) openInvoice(b.getAttribute('data-id'), { from: 'list' });
  });

  function openInvoice(sessionId, opts) {
    opts = opts || {};
    inv.sessionId = sessionId;
    inv.from = opts.from || 'list';
    inv.data = null;
    inv.checked = {};
    $('invDone').hidden = inv.from !== 'finish';
    if (inv.from === 'finish') {
      $('invDone').textContent = '✅ Приймання завершено. Позицій: ' + opts.items +
        '. Якщо є паперова накладна — сфотографуйте її для звірки. Або натисніть «‹», щоб повернутися.';
    }
    $('invTitle').textContent = opts.supplier || 'Поставка';
    $('invSub').textContent = '';
    $('invPages').innerHTML = '';
    $('invRecon').innerHTML = '';
    $('btnInvCheck').hidden = true;
    setInvStatus('', '');
    show('scrInvoice', 'Накладна');
    renderInvoice();
    loadInvoice(false);
  }

  function setInvStatus(cls, html) {
    var st = $('invStatus');
    st.hidden = !html;
    st.className = 'status ' + cls;
    st.innerHTML = html;
  }

  /** Перед роботою з накладною прийняте має бути на сервері: відправляємо чергу. */
  function ensureSent() {
    if (!navigator.onLine) return Promise.reject(new NetworkError('Немає звʼязку'));
    return flushQueue().then(function () { return queue.count(); }).then(function (n) {
      if (n) throw new Error('Ще не відправлено записів: ' + n + '. Дочекайтесь звʼязку й спробуйте ще раз.');
    });
  }

  function loadInvoice(match) {
    if (inv.busy) return Promise.resolve();
    inv.busy = true;
    renderInvoice();
    if (match) setInvStatus('wait', '<span class="spinner"></span>Звіряю накладну з прийнятим…');
    else if (!inv.data) setInvStatus('wait', '<span class="spinner"></span>Завантажую…');
    var sid = inv.sessionId;
    return ensureSent().then(function () {
      return api('invoice', { sessionId: sid, match: !!match }, 120000);
    }).then(function (r) {
      if (inv.sessionId !== sid) return;
      inv.data = r;
      setInvStatus('', '');
      // Нові результати звірки: позначки за замовчуванням.
      inv.checked = {};
      if (r.recon) r.recon.rows.forEach(function (x) { if (x.rename) inv.checked[x.id] = x.preselect; });
      // Є нові рядки без звірки — звіряємо автоматично.
      if (!match && r.pending && r.pages.length) { inv.busy = false; return loadInvoice(true); }
    }, function (err) {
      if (inv.sessionId !== sid) return;
      setInvStatus('bad', esc(err.network
        ? 'Немає звʼязку. Накладну можна додати пізніше: головна → «🧾 Накладні».'
        : err.message));
      if (/PIN/.test(err.message)) logout(true);
    }).finally(function () {
      if (inv.sessionId !== sid) return;
      inv.busy = false;
      renderInvoice();
    });
  }

  function nextPageNo() {
    var pages = inv.data ? inv.data.pages : [];
    return pages.reduce(function (m, p) { return Math.max(m, p.page); }, 0) + 1;
  }

  $('btnInvPhoto').onclick = function () {
    if (inv.busy) return;
    takePhoto({ kind: 'invoice', sessionId: inv.sessionId, pageNo: nextPageNo() });
  };
  $('btnInvCheck').onclick = function () { loadInvoice(true); };

  $('invPages').addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('[data-page]');
    if (!b || inv.busy) return;
    var n = +b.getAttribute('data-page');
    if (!confirm('Перезняти сторінку ' + n + '? Її рядки буде замінено.')) return;
    takePhoto({ kind: 'invoice', sessionId: inv.sessionId, pageNo: n });
  });

  function uploadInvoicePage(target, b64) {
    if (target.sessionId !== inv.sessionId || inv.busy) return;
    inv.busy = true;
    renderInvoice();
    setInvStatus('wait', '<span class="spinner"></span>Читаю сторінку ' + target.pageNo + '… Це може тривати до хвилини.');
    var sid = inv.sessionId;
    ensureSent().then(function () {
      return api('invoicePage', { sessionId: sid, pageNo: target.pageNo, image: b64 }, 150000);
    }).then(function (r) {
      inv.busy = false;
      toast('Сторінка ' + r.page + ': ' + nLines(r.lines) + (r.uncertain ? ', з правками: ' + r.uncertain : ''), 3500);
      return loadInvoice(true);
    }, function (err) {
      inv.busy = false;
      setInvStatus('bad', esc(err.network ? 'Немає звʼязку з сервером. Спробуйте ще раз.' : err.message));
      if (/PIN/.test(err.message)) logout(true);
      renderInvoice();
    });
  }

  function renderInvoice() {
    var d = inv.data;
    if (d) {
      var s = d.session;
      $('invTitle').textContent = s.supplier || 'Без постачальника';
      $('invSub').textContent = 'Прийнято ' + dt(s.openedAt) + ' · позицій: ' + s.items + ' · ' + s.worker;
      $('invPages').innerHTML = d.pages.map(function (p) {
        var info = [nLines(p.lines)];
        if (p.docNumber) info.push('№ ' + p.docNumber);
        if (p.docDate) info.push('від ' + Dates.format(p.docDate));
        return '<div class="page-row"><div><b>Сторінка ' + p.page + '</b>' +
          '<div class="small-text">' + esc(info.join(' · ')) + '</div>' +
          (p.note ? '<div class="small-text warn-text">⚠ ' + esc(p.note) + '</div>' : '') + '</div>' +
          '<button class="btn small" data-page="' + p.page + '"' + (inv.busy ? ' disabled' : '') + '>📷 Перезняти</button></div>';
      }).join('');
    }
    var pages = d ? d.pages.length : 0;
    if (pages) $('invDone').hidden = true;
    $('btnInvPhoto').textContent = pages ? '📷 Додати сторінку ' + (pages + 1) : '📷 Сфотографувати накладну';
    $('btnInvPhoto').disabled = inv.busy || !d;
    $('invPhotoHint').hidden = pages > 0;
    $('btnInvCheck').hidden = !d || inv.busy || !d.pending || !pages;
    renderRecon();
  }

  function li(cls, main, sub, right) {
    return '<li' + (cls ? ' class="' + cls + '"' : '') + '><div><div class="inv-name">' + main + '</div>' +
      (sub ? '<div class="dates">' + sub + '</div>' : '') + '</div>' + (right || '') + '</li>';
  }
  function lineSub(x) {
    var parts = ['стор. ' + x.page + ', рядок ' + x.line];
    if (x.code) parts.push('код ' + esc(x.code));
    return parts.join(' · ') + (x.uncertain ? '<div class="note">✍ рукописна правка або нечітко — перевірте</div>' : '');
  }

  function renderRecon() {
    var box = $('invRecon');
    var r = inv.data && inv.data.recon;
    if (!r) { box.innerHTML = ''; return; }
    var s = r.summary, rows = r.rows, h = '';
    var badges = [];
    badges.push('<span class="badge">у накладній ' + nLines(s.lines) + '</span>');
    badges.push('<span class="badge">прийнято товарів: ' + s.scanned + '</span>');
    if (s.ok) badges.push('<span class="badge ok">збіг: ' + s.ok + '</span>');
    if (s.qty) badges.push('<span class="badge warn">кількість: ' + s.qty + '</span>');
    if (s.missing) badges.push('<span class="badge bad">не відскановано: ' + s.missing + '</span>');
    if (s.extra) badges.push('<span class="badge warn">нема в накладній: ' + s.extra + '</span>');
    h += '<h2 class="list-title">Звірка накладної</h2><div class="recon-sum">' + badges.join('') + '</div>';
    if (!s.qty && !s.missing && !s.extra) h += '<div class="status ok">✅ Усе збігається з прийнятим.</div>';

    var missing = rows.filter(function (x) { return x.status === 'missing'; });
    if (missing.length) {
      h += '<div class="recon-group"><h3 class="bad">❗ Є в накладній, але не відскановано (' + missing.length + ')</h3><ul class="items">' +
        missing.map(function (x) {
          return li('bad', esc(x.name), lineSub(x), '<span class="qty">' + esc(qtyText(x.qty, x.unit)) + '</span>');
        }).join('') + '</ul><p class="hint">Перевірте, чи товар приїхав. Якщо так — прийміть його звичайним скануванням.</p></div>';
    }

    var diff = rows.filter(function (x) { return x.status === 'qty' || x.status === 'unit'; });
    if (diff.length) {
      h += '<div class="recon-group"><h3 class="warn">⚠ Кількість не збігається (' + diff.length + ')</h3><ul class="items">' +
        diff.map(function (x) {
          var sub = 'накладна: <b>' + esc(qtyText(x.qty, x.unit)) + '</b> · прийнято: <b>' + esc(x.scannedQty) + ' шт</b>' +
            (x.status === 'unit' ? '<div class="note">Інша одиниця («' + esc(x.unit) + '») — порахуйте, скільки штук в упаковці.</div>' : '') +
            '<div>' + esc(x.productName) + '</div>' + lineSub(x);
          return li('warn', esc(x.name), sub);
        }).join('') + '</ul><p class="hint">Кількість у базі не змінюється — це лише для перевірки.</p></div>';
    }

    if (r.extra.length) {
      h += '<div class="recon-group"><h3 class="warn">⚠ Відскановано, але немає в накладній (' + r.extra.length + ')</h3><ul class="items">' +
        r.extra.map(function (x) {
          return li('warn', esc(x.productName), esc(x.barcode), '<span class="qty">' + esc(x.scannedQty) + ' шт</span>');
        }).join('') + '</ul></div>';
    }

    var ren = rows.filter(function (x) { return x.rename; });
    if (ren.length) {
      var n = ren.filter(function (x) { return inv.checked[x.id]; }).length;
      h += '<div class="recon-group"><h3>✏️ Назви з накладної (' + ren.length + ')</h3>' +
        '<p class="hint">Позначені назви замінять назви товарів у довіднику. Ручні назви не змінюються.</p><ul class="items">' +
        ren.map(function (x) {
          var warn = [];
          if (x.conf === 'medium' || x.conf === 'low') warn.push('ШІ не впевнений, що це той самий товар');
          if (x.uncertain) warn.push('рукописна правка');
          return '<li><label class="check-row">' +
            '<input type="checkbox" data-line="' + esc(x.id) + '"' + (inv.checked[x.id] ? ' checked' : '') + '>' +
            '<span class="c-body"><span class="inv-name">' + esc(x.name) + '</span>' +
            '<span class="was">' + esc(x.productName) + '</span>' +
            (warn.length ? '<span class="note">⚠ ' + esc(warn.join('; ')) + '</span>' : '') +
            '</span></label></li>';
        }).join('') + '</ul>' +
        '<button class="btn primary" id="btnInvApply"' + (n && !inv.busy ? '' : ' disabled') + '>Застосувати назви (' + n + ')</button></div>';
    }

    var ok = rows.filter(function (x) { return x.status === 'ok'; });
    if (ok.length) {
      h += '<details class="recon-ok"><summary>✅ Збігається (' + ok.length + ')</summary><ul class="items">' +
        ok.map(function (x) {
          var notes = [];
          if (x.applied) notes.push('назву з накладної застосовано');
          if (x.manual) notes.push('ручна назва — не змінюється');
          if (x.conf === 'medium' || x.conf === 'low') notes.push('пару підібрав ШІ — перевірте');
          return li('', esc(x.productName), 'накладна: ' + esc(x.name) + ' · ' + lineSub(x) +
            (notes.length ? '<div class="note">' + esc(notes.join('; ')) + '</div>' : ''),
            '<span class="qty">' + esc(qtyText(x.qty, x.unit)) + '</span>');
        }).join('') + '</ul></details>';
    }
    box.innerHTML = h;
  }

  $('invRecon').addEventListener('change', function (ev) {
    var id = ev.target.getAttribute && ev.target.getAttribute('data-line');
    if (!id) return;
    inv.checked[id] = ev.target.checked;
    var n = Object.keys(inv.checked).filter(function (k) { return inv.checked[k]; }).length;
    var b = $('btnInvApply');
    if (b) { b.textContent = 'Застосувати назви (' + n + ')'; b.disabled = !n || inv.busy; }
  });

  $('invRecon').addEventListener('click', function (ev) {
    if (!ev.target || ev.target.id !== 'btnInvApply' || inv.busy) return;
    var ids = Object.keys(inv.checked).filter(function (k) { return inv.checked[k]; });
    if (!ids.length) return;
    if (!confirm('Замінити назви товарів (' + ids.length + ') на назви з накладної?')) return;
    inv.busy = true;
    renderInvoice();
    var sid = inv.sessionId;
    api('applyInvoice', { sessionId: sid, lineIds: ids }).then(function (r) {
      (r.updated || []).forEach(function (u) {
        var p = state.data.products[u.barcode];
        if (p) p.n = u.name;
      });
      LS.set('data', state.data);
      toast('Назви оновлено: ' + (r.updated || []).length);
      inv.busy = false;
      return loadInvoice(false);
    }, function (err) {
      inv.busy = false;
      setInvStatus('bad', esc(err.network ? 'Немає звʼязку з сервером. Спробуйте ще раз.' : err.message));
      renderInvoice();
    });
  });

  // ---------------------------------------------------------------------------
  // Налаштування та службові кнопки
  // ---------------------------------------------------------------------------
  $('btnSettings').onclick = function () {
    $('setUser').textContent = state.user ? state.user.name : '';
    $('setUrl').textContent = state.api;
    $('setVersion').textContent = 'сторінка ' + APP_VERSION + (state.serverVersion ? ', сервер ' + state.serverVersion : '');
    show('scrSettings', 'Налаштування');
  };
  $('btnBack').onclick = function () {
    if (current === 'scrScan' && state.item) {
      if (!confirm('Поточний товар не збережено. Вийти?')) return;
      state.item = null;
    }
    if (current === 'scrMonth') { showCalendar(); return; }
    if (current === 'scrInvoice' && inv.from === 'list') { showInvoices(false); return; }
    goHome();
  };
  $('btnChangeUrl').onclick = showSetup;
  $('btnCompare').onclick = function () { takePhoto({ kind: 'compare' }); };

  function compareModels(b64) {
    var out = $('compareOut');
    out.innerHTML = '<div class="status wait"><span class="spinner"></span>Надсилаю в усі моделі…</div>';
    $('btnCompare').disabled = true;
    api('compareModels', { image: b64 }, 120000).then(function (r) {
      var rows = (r.results || []).slice().sort(function (a, b) { return (a.seconds || 99) - (b.seconds || 99); });
      out.innerHTML = '<table class="cmp"><thead><tr><th>Модель</th><th>Дата</th><th>с</th><th>$ за 1000 фото</th></tr></thead><tbody>' +
        rows.map(function (x) {
          if (!x.ok) {
            return '<tr><td>' + esc(x.model) + '</td><td colspan="3" class="error">' + esc(x.error) + '</td></tr>';
          }
          var cls = x.date ? (x.confidence === 'high' ? 'ok' : 'warn') : 'bad';
          return '<tr><td>' + esc(x.model) + '<div class="small-text">' + esc((x.inTokens || 0) + ' / ' + (x.outTokens || 0) + ' ток.') + '</div></td>' +
            '<td class="' + cls + '">' + (x.date ? esc(Dates.format(x.date)) : '—') +
            (x.raw ? '<div class="small-text">' + esc(x.raw) + '</div>' : '') + '</td>' +
            '<td>' + esc(x.seconds) + '</td>' +
            '<td>' + (x.cost == null ? '—' : esc((x.cost * 1000).toFixed(2))) + '</td></tr>';
        }).join('') + '</tbody></table>' +
        '<p class="hint">Вартість — якби модель працювала на платному тарифі. На безкоштовному — 0.</p>';
    }, function (err) {
      out.innerHTML = '<div class="status bad">' + esc(err.message) + '</div>';
    }).finally(function () { $('btnCompare').disabled = false; });
  }
  $('btnRefresh').onclick = function () { refreshData(false); };
  $('btnLogout').onclick = function () { logout(false); };
  $('btnFlush').onclick = function () { flushQueue(); };

  function logout(force) {
    queue.count().then(function (n) {
      if (!force && (n || state.session) &&
          !confirm('Є незавершене приймання або невідправлені дані. Вони залишаться в телефоні. Вийти?')) return;
      state.user = null;
      LS.del('user');
      LS.del('calendar');
      cal.data = null;
      goHome();
    });
  }

  // Повернення до екрана приймання запускає сканер.
  var origShow = show;
  show = function (id, title) {
    origShow(id, title);
    if (id === 'scrScan' && !state.item) startScannerWhenVisible();
  };

  window.addEventListener('online', function () { updateNet(); flushQueue(); });
  window.addEventListener('offline', updateNet);
  setInterval(function () { flushQueue(); }, 30000);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopScanner();
    else if (current === 'scrScan' && !state.item) startScanner();
  });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(function () { /* без офлайн-кешу */ });
  }

  // Старт
  goHome();
  flushQueue();
  refreshData(true);
})();
