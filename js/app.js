/* Сторінка: вхід за PIN, приймання поставки, календар термінів, накладні, інвентаризація, черга без інтернету. */
(function () {
  'use strict';

  var APP_VERSION = '4.1.0';
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
    inventory: LS.get('inventory', null), // інвентаризація на цьому телефоні: { id, mode, startedAt, items: [] }
    openInventories: LS.get('openInv', []),  // відкриті інвентаризації на сервері (з bootstrap)
    inventoryReady: LS.get('invReady', true),
    noArticle: null,
    weakPin: LS.get('weakPin', false),
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
    // Старі браузери (iOS до 15.4) і сторінка без https: UUID v4 вручну — сервер приймає лише справжні UUID.
    var b = new Uint8Array(16);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(b);
    else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
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
    if (it.action === 'inventoryCount' && state.inventory) {
      state.inventory.items.forEach(function (x) { if (x.id === it.payload.groupId) x.status = 'sent'; });
      saveInventory();
      renderSessionItems();
      return;
    }
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
    'scrInvoices', 'scrInvoice', 'scrInventory', 'scrInvReport'];
  var current = '';

  function show(id, title) {
    if (current === 'scrScan' && id !== 'scrScan') stopScanner();
    SCREENS.forEach(function (s) { $(s).hidden = s !== id; });
    current = id;
    $('title').textContent = title || 'Термін придатності';
    var loggedIn = !!state.user;
    $('btnSettings').hidden = !loggedIn || id === 'scrSettings' || id === 'scrSetup';
    $('btnBack').hidden = ['scrSession', 'scrScan', 'scrSettings', 'scrCalendar', 'scrMonth', 'scrInvoices', 'scrInvoice',
      'scrInventory', 'scrInvReport'].indexOf(id) === -1 ||
      (id === 'scrSettings' && !loggedIn);
    window.scrollTo(0, 0);
  }

  function goHome() {
    if (!state.api) return showSetup();
    if (!state.user) return showLogin();
    $('hello').textContent = 'Вітаю, ' + state.user.name + '!';
    $('btnContinue').hidden = !state.session;
    $('btnStart').hidden = !!state.session;
    $('btnStart').disabled = !!state.inventory;
    if (state.session) {
      $('btnContinue').textContent = '↩ Продовжити приймання (' + (state.session.supplier || 'без постачальника') +
        ', позицій: ' + state.session.items.length + ')';
    }
    renderHomeInventory();
    $('weakPinNote').hidden = !state.weakPin;
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
    state.openInventories = r.openInventories || [];
    state.inventoryReady = r.inventoryReady !== false;
    state.noArticle = r.noArticle == null ? null : r.noArticle;
    state.weakPin = !!r.weakPin;
    LS.set('weakPin', state.weakPin);
    LS.set('data', state.data);
    LS.set('openInv', state.openInventories);
    LS.set('invReady', state.inventoryReady);
    if (current === 'scrHome') renderHomeInventory();
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
    if (state.inventory) { toast('Триває інвентаризація — приймання вимкнено', 3500); return; }
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
    var inv = state.inventory;
    $('sessionInfo').textContent = inv ? 'Інвентаризація · ' + modeLabel(inv.mode) : state.session.supplier;
    $('listTitle').textContent = inv ? 'Пораховано на цьому телефоні' : 'Прийнято в цій поставці';
    renderSessionItems();
    closeItem();
    show('scrScan', inv ? 'Інвентаризація' : 'Приймання');
  }

  $('btnFinish').onclick = function () {
    if (state.item && !confirm('Поточний товар не збережено. Все одно завершити?')) return;
    if (state.inventory) {
      // Інвентаризація: спершу звіт (не відскановано / нові), завершення — там.
      state.item = null;
      openInvReport(state.inventory.id, 'scan');
      return;
    }
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
    if (state.inventory) {
      var its = state.inventory.items;
      $('listTitle').hidden = !its.length;
      ul.innerHTML = its.slice().reverse().map(function (it) {
        var det = it.dates && it.dates.length
          ? it.dates.map(function (e) { return e.qty + ' шт до ' + Dates.format(e.date); }).join(' · ')
          : it.qty + ' шт';
        if (it.op === 'replace') det += ' · замінено попереднє';
        return '<li><div><div>' + esc(it.name) + '</div><div class="dates">' + esc(det) + '</div></div>' +
          '<span class="st" title="' + (it.status === 'sent' ? 'Збережено' : 'Чекає звʼязку') + '">' +
          (it.status === 'sent' ? '✓' : '⏳') + '</span></li>';
      }).join('');
      return;
    }
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
    var inv = state.inventory;
    state.item = {
      id: uuid(), barcode: barcode, known: !!known,
      name: known ? known.n : '', nameSuggested: '', nameSource: known ? 'existing' : '',
      category: known ? known.c : '', productPhotoUrl: '',
      entries: inv ? [] : [newEntry()],
      inv: !!inv, mode: inv ? inv.mode : '', op: 'add', qty: '', article: '', articleOrig: '',
      batchRows: [], counted: null, ctxLoading: !!inv && navigator.onLine
    };
    var item = state.item;
    $('scanBox').hidden = true;
    $('itemCard').hidden = false;
    $('itemMsg').textContent = '';
    $('itemCode').textContent = barcode;
    $('invQty').value = '';
    $('articleInput').value = '';
    renderItemHead();

    if (!inv) {
      var already = state.session.items.filter(function (x) { return x.barcode === barcode; });
      if (already.length) toast('Цей товар уже є в поставці — буде додано ще одну позицію', 3500);
    } else {
      if (!navigator.onLine) applyInvContext(item, null);
      if (known && navigator.onLine) {
        api('getProduct', { barcode: barcode, inventoryId: inv.id }).then(function (r) {
          if (state.item !== item) return;
          if (r.found) { item.name = r.product.n; item.article = item.articleOrig = r.product.a || ''; $('articleInput').value = item.article; }
          renderItemHead();
          applyInvContext(item, r);
        }, function () { if (state.item === item) applyInvContext(item, null); });
      }
    }

    if (!known) {
      $('newProduct').hidden = false;
      $('nameInput').value = '';
      $('nameStatus').hidden = true;
      $('newProductHint').textContent = 'Новий товар. Сфотографуйте лицьову сторону — назву сформує ШІ.';
      renderCategories('');
      if (navigator.onLine) {
        $('newProductHint').innerHTML = '<span class="spinner"></span>Шукаю товар…';
        api('getProduct', inv ? { barcode: barcode, inventoryId: inv.id } : { barcode: barcode }).then(function (r) {
          if (!state.item || state.item.barcode !== barcode) return;
          if (inv) {
            if (r.found) { item.article = item.articleOrig = r.product.a || ''; $('articleInput').value = item.article; }
            applyInvContext(item, r);
          }
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
          if (inv && state.item === item) applyInvContext(item, null);
        });
      } else {
        $('newProductHint').textContent = 'Немає звʼязку. Впишіть назву товару вручну.';
      }
    } else {
      $('newProduct').hidden = true;
    }
    renderInvParts();
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
    var html = '<div class="entry-head"><span>' + (state.item.inv ? 'Інша дата ' : 'Дата ') + (idx + 1) + '</span>' +
      (total > 1 || state.item.inv ? '<button class="icon-btn" data-act="remove" aria-label="Прибрати">✕</button>' : '') + '</div>';

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
    if (it.inv) { $('btnSaveItem').disabled = !invItemValid(it); return; }
    var nameOk = it.known || !!(it.name && it.name.trim());
    var entriesOk = it.entries.length > 0 && it.entries.every(function (e) {
      return finalDate(e) && Number(e.qty) > 0 && Number.isInteger(Number(e.qty));
    });
    $('btnSaveItem').disabled = !(nameOk && entriesOk);
  }

  $('btnSaveItem').onclick = function () {
    var it = state.item;
    if (!it) return;
    if (it.inv) { saveInvItem(it); return; }
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
    if (target.kind === 'date' && state.item && !state.item.entries.some(function (x) { return x.id === target.entryId; })) return;
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
  // Інвентаризація (етап 4, D-10): підрахунок на екрані сканування, звіт, файл для бухгалтерії
  // ---------------------------------------------------------------------------
  function saveInventory() { if (state.inventory) LS.set('inventory', state.inventory); else LS.del('inventory'); }
  function modeLabel(m) { return m === 'dates' ? 'кількість + дати' : 'тільки кількість'; }
  function isInt(v, min) { return v !== '' && v != null && Number.isInteger(Number(v)) && Number(v) >= min; }

  function renderHomeInventory() {
    var my = state.inventory;
    var note = '';
    if (my) {
      var n = my.items.length;
      $('btnInventory').textContent = '↩ Продовжити інвентаризацію (' + modeLabel(my.mode) + ', записів: ' + n + ')';
      note = '📋 Триває інвентаризація — приймання на цьому телефоні вимкнено.';
    } else {
      $('btnInventory').textContent = '📋 Інвентаризація';
      var other = state.openInventories[0];
      if (other) {
        note = '📋 Триває інвентаризація (почав(ла) ' + (other.worker || '—') + ', ' + dt(other.startedAt) +
          '). Приєднатися — кнопка «📋 Інвентаризація».';
      }
    }
    $('homeInvNote').hidden = !note;
    $('homeInvNote').textContent = note;
    var na = state.noArticle;
    $('noArticleNote').hidden = !na;
    $('noArticleNote').textContent = na ? 'Товарів без артикулу: ' + na + '. Артикул можна вписати під час інвентаризації або імпортувати довідник (⚙).' : '';
  }

  $('btnInventory').onclick = function () {
    if (state.inventory) { openScan(); return; }
    showInventory(true);
  };

  var invh = { list: null, loading: false };

  function showInventory(reload) {
    show('scrInventory', 'Інвентаризація');
    renderInventoryHome();
    if (reload || !invh.list) loadInventoryList();
  }

  function loadInventoryList() {
    if (!navigator.onLine) { $('invHistMsg').textContent = 'Немає звʼязку — список інвентаризацій недоступний.'; return; }
    if (invh.loading) return;
    invh.loading = true;
    $('btnInvHistRefresh').disabled = true;
    $('invHistMsg').innerHTML = invh.list ? '' : '<span class="spinner"></span>Завантажую…';
    flushQueue().then(function () { return api('inventories'); }).then(function (r) {
      invh.list = r.inventories || [];
      state.openInventories = invh.list.filter(function (x) { return x.status === 'open'; });
      LS.set('openInv', state.openInventories);
      // Цю інвентаризацію завершили з іншого телефона.
      if (state.inventory && invh.list.some(function (x) { return x.id === state.inventory.id && x.status === 'closed'; })) {
        toast('Інвентаризацію вже завершено', 4000);
        state.inventory = null;
        saveInventory();
      }
      $('invHistMsg').textContent = '';
      renderInventoryHome();
    }, function (err) {
      $('invHistMsg').textContent = err.network ? 'Немає звʼязку з сервером.' : err.message;
      if (/PIN/.test(err.message)) logout(true);
    }).finally(function () { invh.loading = false; $('btnInvHistRefresh').disabled = false; });
  }
  $('btnInvHistRefresh').onclick = loadInventoryList;

  function renderInventoryHome() {
    var my = state.inventory;
    $('btnInvContinue').hidden = !my;
    if (my) $('btnInvContinue').textContent = '↩ Продовжити підрахунок (' + modeLabel(my.mode) + ')';
    $('invNewCard').hidden = !!my;
    var blocked = !!state.session;
    Array.prototype.forEach.call(document.querySelectorAll('.mode-btn'), function (b) { b.disabled = blocked || !state.inventoryReady; });
    $('invNewHint').textContent = !state.inventoryReady
      ? 'Інвентаризація ще не ввімкнена на сервері (потрібне оновлення бази). Повідомте адміністратора.'
      : blocked ? 'Спершу завершіть приймання поставки — під час інвентаризації товар не приймаємо.'
        : 'Оберіть, що рахуємо. Поки триває інвентаризація, приймання на цьому телефоні вимкнено.';

    // Відкриті інвентаризації інших працівників — приєднатися.
    var open = (invh.list ? invh.list.filter(function (x) { return x.status === 'open'; }) : state.openInventories)
      .filter(function (x) { return !my || x.id !== my.id; });
    $('invOpenOther').innerHTML = open.map(function (x) {
      return '<div class="card"><div><b>Триває інвентаризація</b> · ' + esc(modeLabel(x.mode)) + '</div>' +
        '<div class="small-text">Почав(ла) ' + esc(x.worker || '—') + ', ' + esc(dt(x.startedAt)) +
        (x.products != null ? ' · товарів: ' + esc(x.products) + ', ' + esc(x.totalQty) + ' шт' : '') + '</div>' +
        '<div class="two"><button class="btn primary" data-join="' + esc(x.id) + '"' + (my || blocked ? ' disabled' : '') + '>Приєднатися</button>' +
        '<button class="btn" data-report="' + esc(x.id) + '">Звіт</button></div></div>';
    }).join('');

    var l = invh.list;
    if (!l) { $('invHist').innerHTML = ''; return; }
    if (!l.length) { $('invHist').innerHTML = '<div class="card muted">Інвентаризацій ще не було.</div>'; return; }
    $('invHist').innerHTML = l.map(function (x) {
      var badge = x.status === 'open' ? '<span class="badge warn">триває</span>'
        : '<span class="badge ok">' + esc(x.products) + ' тов. · ' + esc(x.totalQty) + ' шт</span>';
      return '<button class="sess-btn" data-report="' + esc(x.id) + '"><span class="s-main">' +
        '<div class="s-name">' + esc(dt(x.finishedAt || x.startedAt)) + ' · ' + esc(modeLabel(x.mode)) + '</div>' +
        '<div class="small-text">' + esc(x.finishedBy || x.worker || '') +
        (x.status === 'closed' && x.missing ? ' · не відскановано: ' + esc(x.missing) : '') + '</div></span>' + badge + '</button>';
    }).join('');
  }

  function onInvHomeClick(ev) {
    var b = ev.target.closest && ev.target.closest('[data-join],[data-report]');
    if (!b || b.disabled) return;
    var id = b.getAttribute('data-join');
    if (id) {
      var x = (invh.list || state.openInventories).filter(function (y) { return y.id === id; })[0];
      if (!x) return;
      startInventoryLocal({ id: x.id, mode: x.mode, startedAt: x.startedAt, items: [], joined: true });
      return;
    }
    openInvReport(b.getAttribute('data-report'), 'list');
  }
  $('invOpenOther').addEventListener('click', onInvHomeClick);
  $('invHist').addEventListener('click', onInvHomeClick);
  $('btnInvContinue').onclick = function () { openScan(); };

  Array.prototype.forEach.call(document.querySelectorAll('.mode-btn'), function (b) {
    b.onclick = function () {
      if (state.session) { toast('Спершу завершіть приймання поставки', 3500); return; }
      var mode = b.getAttribute('data-mode');
      var open = (invh.list ? invh.list.filter(function (x) { return x.status === 'open'; }) : state.openInventories);
      if (open.length && !confirm('Вже триває інвентаризація (' + (open[0].worker || '—') + '). Краще приєднатися до неї. ' +
        'Все одно почати нову?')) return;
      if (!confirm('Почати інвентаризацію: ' + modeLabel(mode) + '?')) return;
      var invState = { id: uuid(), mode: mode, startedAt: new Date().toISOString(), items: [] };
      sendOrQueue('startInventory', { inventoryId: invState.id, mode: mode, startedAt: invState.startedAt })
        .catch(function (err) { toast(err.message, 4000); });
      startInventoryLocal(invState);
    };
  });

  function startInventoryLocal(invState) {
    state.inventory = invState;
    saveInventory();
    openScan();
  }

  /** Скільки вже пораховано цього товару: сервер (якщо відповів) + невідправлене з телефона, з урахуванням «Замінити». */
  function localCounted(barcode, serverTotal) {
    var items = state.inventory ? state.inventory.items.filter(function (x) { return x.barcode === barcode; }) : [];
    var total = 0;
    items.forEach(function (x) {
      if (serverTotal != null && x.status === 'sent') return;
      if (x.op === 'replace') total = x.qty; else total += x.qty;
    });
    if (serverTotal == null) return total;
    var hasReplace = items.some(function (x) { return x.status !== 'sent' && x.op === 'replace'; });
    return hasReplace ? total : serverTotal + total;
  }

  /** Контекст товару для інвентаризації: партії з бази й уже пораховане. r = null — без звʼязку. */
  function applyInvContext(item, r) {
    item.ctxLoading = false;
    var batches = r && r.batches ? r.batches
      : (cal.data ? cal.data.batches.filter(function (b) { return b.b === item.barcode; }).map(function (b) { return { d: b.d, q: b.q }; }) : []);
    var counted = r && r.counted ? r.counted : { total: null, dates: [] };
    item.counted = { total: localCounted(item.barcode, counted.total), dates: counted.dates || [], offline: !r };
    if (item.mode === 'dates') {
      var rows = batches.map(function (b) { return { d: b.d, base: b.q, fact: '', done: 0 }; });
      (counted.dates || []).forEach(function (c) {
        var row = rows.filter(function (x) { return x.d === c.d; })[0];
        if (row) row.done = c.q; else rows.push({ d: c.d, base: 0, fact: '', done: c.q });
      });
      rows.sort(function (a, b) { return a.d < b.d ? -1 : a.d > b.d ? 1 : 0; });
      item.batchRows = rows;
      if (!rows.length && !item.entries.length) item.entries.push(newEntry());
    }
    renderInvParts();
    renderEntries();
    if (item.mode === 'qty' && state.item === item) setTimeout(function () { if (!$('invQty').value) $('invQty').focus(); }, 50);
  }

  function renderInvParts() {
    var it = state.item;
    var inv = !!(it && it.inv);
    $('articleField').hidden = !inv;
    $('invQtyField').hidden = !inv || it.mode !== 'qty';
    $('invBatches').hidden = !inv || it.mode !== 'dates';
    $('invCounted').hidden = !inv || it.ctxLoading || !(it.counted && it.counted.total > 0);
    $('btnAddEntry').hidden = inv && it.mode !== 'dates';
    $('btnAddEntry').textContent = inv ? '➕ Інша дата (якої немає в списку)' : '➕ Ще одна дата цього товару';
    if (!inv) return;

    if (it.counted && it.counted.total > 0) {
      $('invCounted').innerHTML = '<div class="status warn">Вже пораховано: <b>' + it.counted.total + ' шт</b>' +
        (it.counted.offline ? ' (на цьому телефоні; без звʼязку інші телефони не видно)' : '') +
        '. Додати чи замінити?</div>' +
        '<div class="two"><button class="btn' + (it.op === 'add' ? ' primary' : '') + '" data-op="add">➕ Додати</button>' +
        '<button class="btn' + (it.op === 'replace' ? ' primary' : '') + '" data-op="replace">↺ Замінити</button></div>' +
        '<p class="hint">' + (it.op === 'add' ? 'Нова кількість додасться до вже порахованої (напр., полиця + холодильник).'
          : 'Попередній підрахунок цього товару буде скасовано.') + '</p>';
    }

    if (it.mode === 'dates') {
      var h = '';
      if (it.ctxLoading) h = '<div class="status wait"><span class="spinner"></span>Завантажую партії з бази…</div>';
      else if (it.batchRows.length) {
        h = '<div class="small-text">Партії в базі — впишіть, скільки фактично є:</div>' +
          it.batchRows.map(function (r, i) {
            var info = (r.base ? 'у базі ' + r.base + ' шт' : 'немає в базі') + (r.done ? ' · вже пораховано ' + r.done : '');
            return '<div class="batch-row"><div><b>до ' + Dates.format(r.d) + '</b><div class="small-text">' + esc(info) + '</div></div>' +
              '<input type="number" inputmode="numeric" min="0" step="1" placeholder="шт" data-batch="' + i + '" value="' + esc(r.fact) + '"></div>';
          }).join('');
      } else {
        h = '<div class="small-text">Партій цього товару в базі немає — додайте дату нижче.</div>';
      }
      $('invBatches').innerHTML = h;
    }
    updateSaveButton();
  }

  $('invCounted').addEventListener('click', function (ev) {
    var op = ev.target.getAttribute && ev.target.getAttribute('data-op');
    if (!op || !state.item) return;
    state.item.op = op;
    renderInvParts();
  });
  $('invBatches').addEventListener('input', function (ev) {
    var i = ev.target.getAttribute('data-batch');
    if (i == null || !state.item) return;
    state.item.batchRows[+i].fact = ev.target.value;
    updateSaveButton();
  });
  $('invQty').addEventListener('input', function () { if (state.item) { state.item.qty = $('invQty').value; updateSaveButton(); } });
  $('articleInput').addEventListener('input', function () { if (state.item) state.item.article = $('articleInput').value.trim(); });

  function invItemValid(it) {
    if (it.ctxLoading) return false;
    if (!(it.known || (it.name && it.name.trim()))) return false;
    if (it.mode === 'qty') return isInt(it.qty, 0);
    var badRow = it.batchRows.some(function (r) { return r.fact !== '' && !isInt(r.fact, 0); });
    var entriesOk = it.entries.every(function (e) { return finalDate(e) && isInt(e.qty, 1); });
    var any = it.batchRows.some(function (r) { return r.fact !== ''; }) || it.entries.length > 0 || it.batchRows.length > 0;
    return !badRow && entriesOk && any;
  }

  function saveInvItem(it) {
    if (!invItemValid(it)) return;
    var first = !(it.counted && it.counted.total > 0) || it.op === 'replace';
    var entries = [];
    if (it.mode === 'qty') {
      entries.push({ id: uuid(), date: '', qty: Number(it.qty) });
    } else {
      var empty = it.batchRows.filter(function (r) { return r.fact === ''; });
      if (first && empty.length && !confirm('Для ' + empty.length + ' ' + plural(empty.length, 'партії', 'партій', 'партій') +
        ' кількість не введено — вважати, що їх немає (0 шт)?')) return;
      it.batchRows.forEach(function (r) {
        if (r.fact !== '') entries.push({ id: uuid(), date: r.d, qty: Number(r.fact) });
        else if (first) entries.push({ id: uuid(), date: r.d, qty: 0 });
      });
      it.entries.forEach(function (e) { entries.push({ id: e.id, date: finalDate(e), qty: Number(e.qty) }); });
      // Дві однакові дати — складаємо.
      var byDate = {};
      entries = entries.filter(function (e) {
        if (byDate[e.date]) { byDate[e.date].qty += e.qty; return false; }
        byDate[e.date] = e; return true;
      });
      if (!entries.length) { $('itemMsg').textContent = 'Введіть кількість хоча б для однієї дати.'; return; }
    }
    if (!it.known && !it.category &&
        !confirm('Категорію не обрано — нагадування буде за стандартним порогом. Зберегти?')) return;
    var payload = {
      inventoryId: state.inventory.id,
      groupId: it.id,
      barcode: it.barcode,
      op: it.counted && it.counted.total > 0 ? it.op : 'add',
      name: it.known ? '' : it.name.trim(),
      nameSource: it.known ? 'existing' : (it.nameSource || 'manual'),
      category: it.category || '',
      article: it.article !== it.articleOrig ? it.article : '',
      productPhotoBase64: it.known ? '' : (it.productPhotoB64 || ''),
      countedAt: new Date().toISOString(),
      entries: entries
    };
    var displayName = it.known ? it.name : it.name.trim();
    var rec = {
      id: it.id, barcode: it.barcode, name: displayName, status: 'queued', op: payload.op,
      qty: entries.reduce(function (s, e) { return s + e.qty; }, 0),
      dates: it.mode === 'dates' ? entries.map(function (e) { return { date: e.date, qty: e.qty }; }) : null
    };
    state.inventory.items.push(rec);
    saveInventory();
    if (!it.known) {
      state.data.products[it.barcode] = { n: displayName, c: it.category || '' };
      LS.set('data', state.data);
    }
    $('btnSaveItem').disabled = true;
    sendOrQueue('inventoryCount', payload).then(function (res) {
      rec.status = res.queued ? 'queued' : 'sent';
      saveInventory();
      renderSessionItems();
      toast(res.queued ? 'Збережено в телефоні — відправиться, коли зʼявиться звʼязок'
        : 'Збережено ✓ Усього цього товару: ' + res.result.counted + ' шт');
      closeItem();
    }, function (err) {
      state.inventory.items = state.inventory.items.filter(function (x) { return x !== rec; });
      saveInventory();
      renderSessionItems();
      $('itemMsg').textContent = err.message;
      $('btnSaveItem').disabled = false;
    });
    renderSessionItems();
  }

  // --- Звіт інвентаризації ---------------------------------------------------
  var ir = { id: '', from: '', data: null, busy: false, files: {} };

  function openInvReport(id, from) {
    ir.id = id; ir.from = from; ir.data = null; ir.files = {};
    $('irTitle').textContent = 'Інвентаризація';
    $('irSub').textContent = '';
    $('irBadges').innerHTML = '';
    $('irActions').innerHTML = '';
    $('irFiles').innerHTML = '';
    $('irLists').innerHTML = '';
    show('scrInvReport', 'Звіт інвентаризації');
    loadInvReport();
  }

  function setIrStatus(cls, html) {
    var st = $('irStatus');
    st.hidden = !html;
    st.className = 'status ' + cls;
    st.innerHTML = html;
  }

  function sentBefore() {
    if (!navigator.onLine) return Promise.reject(new NetworkError('Немає звʼязку'));
    return flushQueue().then(function () { return queue.count(); }).then(function (n) {
      if (n) throw new Error('Ще не відправлено записів: ' + n + '. Дочекайтесь звʼязку й спробуйте ще раз.');
    });
  }

  function loadInvReport() {
    var id = ir.id;
    ir.busy = true;
    setIrStatus('wait', '<span class="spinner"></span>Завантажую звіт…');
    sentBefore().then(function () { return api('inventory', { inventoryId: id }, 60000); }).then(function (r) {
      if (ir.id !== id) return;
      ir.data = r;
      if (r.inventory.status === 'closed' && state.inventory && state.inventory.id === id) {
        state.inventory = null;
        saveInventory();
      }
      setIrStatus('', '');
    }, function (err) {
      if (ir.id !== id) return;
      setIrStatus('bad', esc(err.network ? 'Немає звʼязку. Звіт потребує інтернету — спробуйте пізніше.' : err.message));
      if (/PIN/.test(err.message)) logout(true);
    }).finally(function () {
      if (ir.id !== id) return;
      ir.busy = false;
      renderInvReport();
    });
  }

  function renderInvReport() {
    var d = ir.data;
    if (!d) {
      $('irActions').innerHTML = ir.from === 'scan' ? '<button class="btn" id="btnIrBack">↩ Повернутися до підрахунку</button>' : '';
      return;
    }
    var inv = d.inventory, lines = d.lines || [];
    var closed = inv.status === 'closed';
    var counted = lines.filter(function (l) { return l.counted; });
    var missing = lines.filter(function (l) { return !l.counted; });
    var fresh = counted.filter(function (l) { return l.new || !l.base; });
    var total = counted.reduce(function (s, l) { return s + l.q; }, 0);
    $('irTitle').textContent = (closed ? 'Інвентаризація від ' : 'Інвентаризація (триває) · ') + dt(inv.finishedAt || inv.startedAt);
    $('irSub').textContent = modeLabel(inv.mode) + ' · рахували: ' + (d.workers || inv.worker || '—') +
      (closed ? ' · завершив(ла) ' + (inv.finishedBy || '—') : '');
    var badges = ['<span class="badge">товарів: ' + counted.length + '</span>', '<span class="badge">усього: ' + total + ' шт</span>'];
    if (fresh.length) badges.push('<span class="badge warn">не було в базі: ' + fresh.length + '</span>');
    badges.push(missing.length ? '<span class="badge bad">не відскановано: ' + missing.length + '</span>'
      : '<span class="badge ok">усе з бази відскановано</span>');
    $('irBadges').innerHTML = badges.join('');

    var a = '';
    if (!closed) {
      var mine = state.inventory && state.inventory.id === inv.id;
      if (mine) a += '<button class="btn" id="btnIrBack">↩ Повернутися до підрахунку</button>';
      a += '<button class="btn primary" id="btnIrFinish"' + (ir.busy ? ' disabled' : '') + '>✅ Завершити інвентаризацію</button>' +
        '<p class="hint">' + (inv.mode === 'dates'
          ? 'Після завершення залишки порахованих товарів у календарі стануть фактичними: пораховані дати — порахована кількість, інші партії цих товарів — 0. Товари, яких не відскановано, не змінюються.'
          : 'Режим «тільки кількість»: залишки в базі не змінюються, буде лише файл для бухгалтерії.') +
        ' Поки не завершено, рахувати можна з кількох телефонів.</p>';
    } else {
      a += '<div class="two"><button class="btn primary" data-file="pdf"' + (ir.busy ? ' disabled' : '') + '>📄 PDF</button>' +
        '<button class="btn primary" data-file="xlsx"' + (ir.busy ? ' disabled' : '') + '>📊 Excel</button></div>' +
        '<p class="hint">Файл для бухгалтерії: № · штрих-код · номер · артикул · назва · кількість. Штрих-коди можна «пропікати» сканером.</p>';
    }
    $('irActions').innerHTML = a;
    renderIrFiles();

    var h = '';
    if (missing.length) {
      h += '<div class="recon-group"><h3 class="bad">❗ Був залишок у базі, але не відскановано (' + missing.length + ')</h3><ul class="items">' +
        missing.map(function (l) {
          return '<li class="bad"><div><div class="inv-name">' + esc(l.n) + '</div><div class="dates">' + esc(l.b) +
            (l.a ? ' · арт. ' + esc(l.a) : '') + '</div></div><span class="qty">у базі ' + l.base + '</span></li>';
        }).join('') + '</ul>' + (closed ? '' : '<p class="hint">Перевірте полиці й склад. Якщо товару немає — нічого не робіть; якщо є — відскануйте.</p>') + '</div>';
    }
    if (fresh.length) {
      h += '<div class="recon-group"><h3 class="warn">⚠ Відскановано, але не було в базі (' + fresh.length + ')</h3><ul class="items">' +
        fresh.map(function (l) {
          return '<li class="warn"><div><div class="inv-name">' + esc(l.n) + '</div><div class="dates">' + esc(l.b) +
            (l.new ? ' · новий товар' : ' · залишку в базі не було') + '</div></div><span class="qty">' + l.q + ' шт</span></li>';
        }).join('') + '</ul></div>';
    }
    if (counted.length) {
      h += '<details class="recon-ok"' + (counted.length <= 30 ? ' open' : '') + '><summary>📋 Пораховано (' + counted.length + ')</summary><ul class="items">' +
        counted.map(function (l) {
          var sub = esc(l.b) + (l.a ? ' · арт. ' + esc(l.a) : '') + ' · у базі було ' + l.base;
          if (l.dates && l.dates.length) {
            sub += '<div>' + l.dates.map(function (x) {
              return esc(Dates.format(x.d)) + ': ' + x.q + (x.q !== x.base ? ' <span class="muted-text">(у базі ' + x.base + ')</span>' : '');
            }).join(' · ') + '</div>';
          }
          return '<li><div><div class="inv-name">' + esc(l.n) + '</div><div class="dates">' + sub + '</div></div>' +
            '<span class="qty">' + l.q + ' шт</span></li>';
        }).join('') + '</ul></details>';
    } else {
      h += '<div class="card muted">Ще нічого не пораховано.</div>';
    }
    $('irLists').innerHTML = h;
  }

  $('irActions').addEventListener('click', function (ev) {
    var t = ev.target.closest && ev.target.closest('button');
    if (!t || t.disabled) return;
    if (t.id === 'btnIrBack') { openScan(); return; }
    if (t.id === 'btnIrFinish') { finishInventory(); return; }
    var f = t.getAttribute('data-file');
    if (f) exportInventory(f);
  });

  function finishInventory() {
    var d = ir.data;
    if (!d || ir.busy) return;
    var missing = (d.lines || []).filter(function (l) { return !l.counted; }).length;
    var msg = 'Завершити інвентаризацію?' + (missing ? '\nНе відскановано товарів із залишком: ' + missing + '.' : '') +
      (d.inventory.mode === 'dates' ? '\nЗалишки порахованих товарів у базі буде замінено фактичними.' : '') +
      '\nПісля завершення рахувати вже не можна.';
    if (!confirm(msg)) return;
    var id = ir.id;
    ir.busy = true;
    renderInvReport();
    setIrStatus('wait', '<span class="spinner"></span>Завершую…');
    sentBefore().then(function () { return api('finishInventory', { inventoryId: id }, 120000); }).then(function (r) {
      ir.data = r;
      if (state.inventory && state.inventory.id === id) { state.inventory = null; saveInventory(); }
      // Залишки в календарі змінились — перезавантажимо при наступному відкритті.
      cal.data = null; LS.del('calendar');
      invh.list = null;
      setIrStatus('ok', '✅ Інвентаризацію завершено. Завантажте файл для бухгалтерії.');
      refreshData(true);
    }, function (err) {
      setIrStatus('bad', esc(err.network ? 'Немає звʼязку з сервером. Спробуйте ще раз.' : err.message));
    }).finally(function () {
      ir.busy = false;
      renderInvReport();
    });
  }

  function b64ToBlob(b64, mime) {
    var bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  function exportInventory(format) {
    if (ir.busy) return;
    var id = ir.id;
    ir.busy = true;
    renderInvReport();
    setIrStatus('wait', '<span class="spinner"></span>Готую ' + (format === 'pdf' ? 'PDF' : 'Excel') + '…');
    api('inventoryExport', { inventoryId: id, format: format }, 120000).then(function (r) {
      if (ir.id !== id) return;
      var old = ir.files[format];
      if (old) URL.revokeObjectURL(old.url);
      var blob = b64ToBlob(r.base64, r.mime);
      ir.files[format] = { name: r.filename, url: URL.createObjectURL(blob), blob: blob, mime: r.mime };
      setIrStatus('', '');
    }, function (err) {
      setIrStatus('bad', esc(err.network ? 'Немає звʼязку з сервером. Спробуйте ще раз.' : err.message));
    }).finally(function () {
      if (ir.id !== id) return;
      ir.busy = false;
      renderInvReport();
    });
  }

  function renderIrFiles() {
    var keys = Object.keys(ir.files);
    $('irFiles').innerHTML = keys.map(function (k) {
      var f = ir.files[k];
      var canShare = false;
      try { canShare = !!(navigator.canShare && navigator.canShare({ files: [new File([f.blob], f.name, { type: f.mime })] })); } catch (e) { /* ні */ }
      return '<div class="card"><div><b>' + (k === 'pdf' ? '📄 ' : '📊 ') + esc(f.name) + '</b> · ' + Math.max(1, Math.round(f.blob.size / 1024)) + ' КБ</div>' +
        '<div class="' + (canShare ? 'two' : '') + '"><a class="btn" href="' + f.url + '" download="' + esc(f.name) + '">⬇ Завантажити</a>' +
        (canShare ? '<button class="btn" data-share="' + k + '">📤 Надіслати</button>' : '') + '</div></div>';
    }).join('');
  }
  $('irFiles').addEventListener('click', function (ev) {
    var k = ev.target.getAttribute && ev.target.getAttribute('data-share');
    if (!k || !ir.files[k]) return;
    var f = ir.files[k];
    navigator.share({ files: [new File([f.blob], f.name, { type: f.mime })], title: f.name }).catch(function () { /* скасовано */ });
  });

  // ---------------------------------------------------------------------------
  // Імпорт довідника з офісу (етап 4, D-14): Excel / CSV → перевірка → застосувати
  // ---------------------------------------------------------------------------
  var catImp = { table: null, file: '', header: true, map: { b: -1, a: -1, n: -1 }, report: null, busy: false };
  var SHEETJS = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';

  $('btnCatFile').onclick = function () { $('catFileInput').value = ''; $('catFileInput').click(); };
  $('catFileInput').addEventListener('change', function () {
    var file = this.files && this.files[0];
    if (!file) return;
    catImp.file = file.name;
    catImp.report = null;
    $('catOut').innerHTML = '<div class="status wait"><span class="spinner"></span>Читаю файл…</div>';
    readTable(file).then(function (table) {
      table = table.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
      if (!table.length) throw new Error('Файл порожній');
      catImp.table = table;
      guessColumns();
      renderCatalog();
    }).catch(function (err) {
      $('catOut').innerHTML = '<div class="status bad">' + esc(err.message || 'Не вдалося прочитати файл') + '</div>';
    });
  });

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.onload = resolve;
      s.onerror = function () { reject(new Error('Не вдалося завантажити модуль читання Excel. Перевірте інтернет або збережіть файл як CSV.')); };
      document.head.appendChild(s);
    });
  }

  function cellText(v) {
    if (v == null) return '';
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
    return String(v).trim();
  }

  function readTable(file) {
    if (/\.csv$/i.test(file.name) || file.type === 'text/csv') {
      return file.text().then(parseCsv);
    }
    var load = window.XLSX ? Promise.resolve() : loadScript(SHEETJS);
    return load.then(function () { return file.arrayBuffer(); }).then(function (buf) {
      var wb = window.XLSX.read(buf, { type: 'array' });
      var ws = wb.Sheets[wb.SheetNames[0]];
      return window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }).map(function (r) { return r.map(cellText); });
    });
  }

  function parseCsv(text) {
    text = text.replace(/^﻿/, '');
    var first = text.split(/\r?\n/)[0] || '';
    var delim = [';', '\t', ','].sort(function (a, b) { return first.split(b).length - first.split(a).length; })[0];
    var rows = [], row = [], cur = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cur.trim()); cur = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cur.trim()); rows.push(row); row = []; cur = '';
      } else cur += ch;
    }
    if (cur || row.length) { row.push(cur.trim()); rows.push(row); }
    return rows;
  }

  function guessColumns() {
    var t = catImp.table, head = t[0].map(function (c) { return String(c).toLowerCase(); });
    var find = function (re) { for (var i = 0; i < head.length; i++) if (re.test(head[i])) return i; return -1; };
    var m = { b: find(/штрих|barcode|ean|шк\b|bar code/), a: find(/артикул|article|sku|код товару|^код$/), n: find(/назва|найменування|name|товар/) };
    catImp.header = m.b >= 0 || m.n >= 0;
    if (m.b < 0) {
      // За вмістом: колонка, де найбільше 8–14-значних чисел.
      var best = -1, bestN = 0, cols = Math.max.apply(null, t.map(function (r) { return r.length; }));
      for (var c = 0; c < cols; c++) {
        var n = t.slice(0, 50).filter(function (r) { return /^\d{8,14}$/.test(String(r[c] || '').replace(/\s/g, '')); }).length;
        if (n > bestN) { bestN = n; best = c; }
      }
      m.b = best;
    }
    if (m.n === m.b) m.n = -1;
    if (m.a === m.b) m.a = -1;
    catImp.map = m;
  }

  function catRows() {
    var t = catImp.table, m = catImp.map;
    return t.slice(catImp.header ? 1 : 0).map(function (r) {
      return { barcode: String(r[m.b] || '').replace(/\s/g, ''), article: m.a >= 0 ? r[m.a] : '', name: m.n >= 0 ? r[m.n] : '' };
    }).filter(function (r) { return r.barcode; });
  }

  function renderCatalog() {
    var t = catImp.table;
    if (!t) { $('catOut').innerHTML = ''; return; }
    var cols = Math.max.apply(null, t.map(function (r) { return r.length; }));
    var labels = [];
    for (var c = 0; c < cols; c++) {
      var name = catImp.header ? String(t[0][c] || '').trim() : '';
      labels.push((c + 1) + (name ? ' — ' + name : '') + (catImp.header ? '' : ' (' + String((t[0] || [])[c] || '').slice(0, 20) + ')'));
    }
    var sel = function (key, label, optional) {
      return '<label class="field">' + label + '<select data-map="' + key + '">' +
        (optional ? '<option value="-1">— немає —</option>' : '<option value="-1">— оберіть —</option>') +
        labels.map(function (l, i) { return '<option value="' + i + '"' + (catImp.map[key] === i ? ' selected' : '') + '>' + esc(l) + '</option>'; }).join('') +
        '</select></label>';
    };
    var rows = catImp.map.b >= 0 ? catRows() : [];
    var sci = rows.filter(function (r) { return /e\+/i.test(r.barcode); }).length;
    var h = '<div class="small-text">' + esc(catImp.file) + ' · рядків: ' + (t.length - (catImp.header ? 1 : 0)) + '</div>' +
      '<label class="check-row"><input type="checkbox" id="catHeader"' + (catImp.header ? ' checked' : '') + '><span class="c-body">Перший рядок — заголовки</span></label>' +
      sel('b', 'Колонка зі штрих-кодом', false) + sel('a', 'Колонка з артикулом', true) + sel('n', 'Колонка з назвою', true);
    if (sci) h += '<div class="status bad">У ' + sci + ' штрих-кодах Excel зіпсував число (вигляд 4,82E+12). Відформатуйте колонку як текст і збережіть файл ще раз.</div>';
    h += '<button class="btn primary" id="btnCatCheck"' + (catImp.map.b < 0 || !rows.length || catImp.busy ? ' disabled' : '') + '>🔍 Перевірити (' + rows.length + ')</button>';

    var r = catImp.report;
    if (r) {
      var li = function (items, fn) { return items.length ? '<ul class="items">' + items.map(fn).join('') + '</ul>' : ''; };
      h += '<div class="recon-sum"><span class="badge">у файлі: ' + r.rows + '</span><span class="badge ok">знайдено в базі: ' + r.matched + '</span>' +
        '<span class="badge' + (r.unknown ? ' warn' : '') + '">немає в базі: ' + r.unknown + '</span></div>';
      if (r.applied) {
        h += '<div class="status ok">✅ Застосовано: артикулів ' + r.applied.articles + ', назв ' + r.applied.names + ', нових товарів ' + r.applied.added + '.</div>';
      } else {
        h += '<div class="recon-group"><h3>Артикули: нових ' + r.articleNew + ', змінено ' + r.articleChanged + '</h3>' +
          li(r.samples.articles, function (x) {
            return '<li><div><div class="inv-name">' + esc(x.name) + '</div><div class="dates">' + esc(x.barcode) + ' · ' +
              (x.from ? esc(x.from) + ' → ' : '') + '<b>' + esc(x.to) + '</b></div></div></li>';
          }) + '</div>';
        h += '<label class="check-row"><input type="checkbox" id="catNames"' + (r.nameDiff ? ' checked' : ' disabled') + '><span class="c-body">' +
          '<span class="inv-name">Записати назви з довідника (' + r.nameDiff + ')</span>' +
          '<span class="small-text">Назва з довідника важливіша за накладну й ШІ; ручні назви (' + r.nameManual + ') не змінюються.</span></span></label>' +
          li(r.samples.names, function (x) {
            return '<li><div><div class="inv-name">' + esc(x.to) + '</div><div class="dates"><span class="was">' + esc(x.from) + '</span>' +
              (x.manual ? ' · ручна назва — залишиться' : '') + '</div></div></li>';
          });
        h += '<label class="check-row"><input type="checkbox" id="catNew"' + (r.unknownNamed ? '' : ' disabled') + '><span class="c-body">' +
          '<span class="inv-name">Додати в базу товари, яких ще немає (' + r.unknownNamed + ')</span>' +
          '<span class="small-text">Тоді під час приймання й інвентаризації їх назва буде відома одразу.</span></span></label>' +
          li(r.samples.unknown.slice(0, 5), function (x) {
            return '<li><div><div class="inv-name">' + esc(x.name || '(без назви)') + '</div><div class="dates">' + esc(x.barcode) + '</div></div></li>';
          });
        h += '<button class="btn primary" id="btnCatApply"' + (catImp.busy ? ' disabled' : '') + '>Застосувати</button>';
      }
    }
    $('catOut').innerHTML = h;
  }

  $('catOut').addEventListener('change', function (ev) {
    var k = ev.target.getAttribute && ev.target.getAttribute('data-map');
    if (k) { catImp.map[k] = +ev.target.value; catImp.report = null; renderCatalog(); return; }
    if (ev.target.id === 'catHeader') { catImp.header = ev.target.checked; catImp.report = null; renderCatalog(); }
  });
  $('catOut').addEventListener('click', function (ev) {
    var id = ev.target && ev.target.id;
    if (id !== 'btnCatCheck' && id !== 'btnCatApply') return;
    if (catImp.busy) return;
    var apply = id === 'btnCatApply';
    var names = apply && $('catNames') && $('catNames').checked;
    var addNew = apply && $('catNew') && $('catNew').checked;
    if (apply && !confirm('Застосувати довідник: артикули' + (names ? ', назви' : '') + (addNew ? ', нові товари' : '') + '?')) return;
    catImp.busy = true;
    renderCatalog();
    api('importCatalog', { rows: catRows(), apply: apply, names: names, addNew: addNew }, 120000).then(function (r) {
      catImp.report = r.report;
      if (apply) { toast('Довідник застосовано'); refreshData(true); }
    }, function (err) {
      toast(err.network ? 'Немає звʼязку з сервером' : err.message, 5000);
    }).finally(function () { catImp.busy = false; renderCatalog(); });
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
    if (current === 'scrInvReport') {
      if (ir.from === 'scan' && state.inventory && state.inventory.id === ir.id) { openScan(); return; }
      showInventory(false); return;
    }
    if (current === 'scrScan' && state.inventory) { showInventory(false); return; }
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

  $('btnChangePin').onclick = function () {
    var a = $('newPin').value.trim(), b = $('newPin2').value.trim();
    var msg = $('pinMsg');
    msg.className = 'hint error';
    if (a.length < 6) { msg.textContent = 'PIN має бути від 6 символів.'; return; }
    if (a !== b) { msg.textContent = 'PIN-и не збігаються.'; return; }
    if (a === state.user.pin) { msg.textContent = 'Це ваш поточний PIN.'; return; }
    $('btnChangePin').disabled = true;
    msg.className = 'hint';
    msg.innerHTML = '<span class="spinner"></span>Змінюю…';
    // Спершу відправляємо чергу: вона піде зі старим PIN-ом.
    flushQueue().then(function () { return api('changePin', { newPin: a }); }).then(function () {
      state.user.pin = a;
      LS.set('user', state.user);
      state.weakPin = false;
      LS.set('weakPin', false);
      $('newPin').value = ''; $('newPin2').value = '';
      msg.className = 'hint';
      msg.textContent = '✅ PIN змінено. Наступного разу входьте з новим PIN-ом.';
    }, function (err) {
      msg.className = 'hint error';
      msg.textContent = err.network ? 'Немає звʼязку з сервером.' : err.message;
    }).finally(function () { $('btnChangePin').disabled = false; });
  };
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
