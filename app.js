/* =====================================================================
   Student ID Card System - Dembi Dollo Education Office
   Application logic (vanilla JavaScript, no framework)

   Sections
     1. Constants and helpers
     2. Storage layer (IndexedDB with localStorage fallback)
     3. Code 128 barcode generator
     4. Image and date utilities
     5. Authentication
     6. Navigation and shared UI (toast, modal, busy)
     7. Dashboard
     8. Students (list, form, delete)
     9. Excel / CSV import and export
    10. ID card builder, print and PDF export
    11. Settings, backup, SQL export
    12. Start-up
   ===================================================================== */
(function () {
  'use strict';

  /* ===================================================================
     1. CONSTANTS AND HELPERS
     =================================================================== */
  var APP_TITLE = 'Dembi Dollo Education Office';
  var ADMIN_USER = 'admin';
  var DEFAULT_PASSWORD = '2291';
  var DB_NAME = 'dd_student_id_system';
  var STORE_NAME = 'kv';
  var LS_PREFIX = 'ddsid_';
  var PAGE_SIZE = 20;
  var MAX_LOGIN_TRIES = 5;
  var LOCK_SECONDS = 30;
  var GRADES = ['9', '10', '11', '12'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var IMPORT_HEADERS = [
    'Student ID', 'Full Name', 'Gender', 'Date of Birth', 'Grade', 'Section',
    'Academic Year', 'Parent/Guardian Name', 'Parent Phone', 'Address'
  ];

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 9); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function pad4(n) { return ('0000' + n).slice(-4); }
  function trim(v) { return String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim(); }
  function chunk(arr, n) {
    var out = [];
    for (var i = 0; i < arr.length; i += n) { out.push(arr.slice(i, i + n)); }
    return out;
  }
  function currentAcademicYear() {
    var y = new Date().getFullYear();
    return y + '/' + (y + 1);
  }
  function hashPw(pw) {
    var s = 'dd-id|' + pw + '|v1';
    var h1 = 0x811c9dc5, h2 = 0x1b873593;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 ^= c; h1 = Math.imul(h1, 16777619) >>> 0;
      h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
      h2 = ((h2 << 13) | (h2 >>> 19)) >>> 0;
    }
    return h1.toString(16) + '-' + h2.toString(16);
  }
  function shade(hex, percent) {
    var m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) { return '#103b6a'; }
    var n = parseInt(m[1], 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    var f = function (x) { return Math.max(0, Math.min(255, Math.round(x + (percent / 100) * 255))); };
    return '#' + [f(r), f(g), f(b)].map(function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }
  function downloadBlob(name, data, mime) {
    var blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 800);
  }
  function stamp() {
    var d = new Date();
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
  }

  var PLACEHOLDER_PHOTO = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 100"><rect width="80" height="100" fill="#e6ecf3"/>' +
    '<circle cx="40" cy="38" r="16" fill="#9fb1c6"/><path d="M8 100 C8 70 24 60 40 60 C56 60 72 70 72 100 Z" fill="#9fb1c6"/></svg>');

  /* ===================================================================
     2. STORAGE LAYER
     =================================================================== */
  var Store = {
    db: null,
    ls: false,
    open: function () {
      var self = this;
      return new Promise(function (resolve) {
        try {
          if (!window.indexedDB) { self.ls = true; resolve(); return; }
          var rq = window.indexedDB.open(DB_NAME, 1);
          rq.onupgradeneeded = function () { rq.result.createObjectStore(STORE_NAME); };
          rq.onsuccess = function () { self.db = rq.result; resolve(); };
          rq.onerror = function () { self.ls = true; resolve(); };
          rq.onblocked = function () { self.ls = true; resolve(); };
        } catch (e) { self.ls = true; resolve(); }
      });
    },
    get: function (key) {
      var self = this;
      return new Promise(function (resolve, reject) {
        if (self.ls) {
          try { var v = localStorage.getItem(LS_PREFIX + key); resolve(v ? JSON.parse(v) : undefined); }
          catch (e) { resolve(undefined); }
          return;
        }
        try {
          var rq = self.db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
          rq.onsuccess = function () { resolve(rq.result); };
          rq.onerror = function () { reject(rq.error); };
        } catch (e) { reject(e); }
      });
    },
    set: function (key, value) {
      var self = this;
      return new Promise(function (resolve, reject) {
        if (self.ls) {
          try { localStorage.setItem(LS_PREFIX + key, JSON.stringify(value)); resolve(); }
          catch (e) { reject(e); }
          return;
        }
        try {
          var tx = self.db.transaction(STORE_NAME, 'readwrite');
          tx.objectStore(STORE_NAME).put(value, key);
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { reject(tx.error || new Error('Storage error')); };
          tx.onabort = function () { reject(tx.error || new Error('Storage was blocked or is full')); };
        } catch (e) { reject(e); }
      });
    }
  };

  var state = { students: [], settings: {} };

  function defaultSettings() {
    return {
      schoolName: 'Your School Name',
      academicYear: currentAcademicYear(),
      directorName: '',
      cardColor: '#17508f',
      backNotice: 'This card is the property of the school. If found, please return it to the school office.',
      logo: '', stamp: '', signature: '',
      passHash: ''
    };
  }
  function getPassHash() { return state.settings.passHash || hashPw(DEFAULT_PASSWORD); }

  function loadState() {
    return Promise.all([Store.get('students'), Store.get('settings')]).then(function (res) {
      var students = Array.isArray(res[0]) ? res[0] : [];
      var settings = res[1] && typeof res[1] === 'object' ? res[1] : {};
      state.students = students.map(sanitizeStudent).filter(Boolean);
      state.settings = Object.assign(defaultSettings(), settings);
    });
  }
  function persist() {
    return Store.set('students', state.students).then(function () {
      return Store.set('settings', state.settings);
    });
  }
  function persistOrRollback(snapshot) {
    return persist().catch(function (err) {
      if (snapshot) { state.students = snapshot; }
      toast('Could not save data: ' + (err && err.message ? err.message : 'storage is full or blocked') + '. Nothing was changed.', 'error');
      throw err;
    });
  }

  function sanitizeStudent(raw) {
    if (!raw || typeof raw !== 'object') { return null; }
    var name = trim(raw.fullName);
    var sid = trim(raw.studentId).toUpperCase();
    if (!name || !sid) { return null; }
    return {
      id: raw.id ? String(raw.id) : uid(),
      studentId: sid,
      fullName: name,
      gender: /^f/i.test(raw.gender) ? 'Female' : 'Male',
      dob: trim(raw.dob),
      grade: trim(raw.grade),
      section: trim(raw.section),
      academicYear: trim(raw.academicYear),
      parentName: trim(raw.parentName),
      phone: trim(raw.phone),
      address: trim(raw.address),
      photo: typeof raw.photo === 'string' ? raw.photo : '',
      createdAt: raw.createdAt || new Date().toISOString(),
      updatedAt: raw.updatedAt || raw.createdAt || new Date().toISOString()
    };
  }

  /* ---------- student ID helpers ---------- */
  var ID_PATTERN = /^STU-[A-Z0-9][A-Z0-9\-\/._]{0,22}$/;
  function normalizeStudentId(v) { return trim(v).toUpperCase().replace(/\s+/g, ''); }
  function isValidStudentId(v) { return ID_PATTERN.test(v); }
  function nextStudentId(used) {
    var year = new Date().getFullYear();
    var re = /^STU-\d{4}-(\d+)$/;
    var max = 0;
    state.students.forEach(function (s) {
      var m = re.exec(s.studentId);
      if (m) { max = Math.max(max, parseInt(m[1], 10)); }
    });
    if (used) {
      used.forEach(function (id) {
        var m = re.exec(id);
        if (m) { max = Math.max(max, parseInt(m[1], 10)); }
      });
    }
    var id;
    do { max += 1; id = 'STU-' + year + '-' + pad4(max); }
    while (idExists(id) || (used && used.has(id)));
    return id;
  }
  function idExists(studentId, exceptInternalId) {
    return state.students.some(function (s) { return s.studentId === studentId && s.id !== exceptInternalId; });
  }

  /* ===================================================================
     3. CODE 128 BARCODE (subset B) - generated locally, no library
     =================================================================== */
  var C128 = [
    '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
    '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
    '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
    '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
    '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
    '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
    '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
    '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
    '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
    '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
    '114131', '311141', '411131', '211412', '211214', '211232', '2331112'
  ];
  function code128Pattern(text) {
    var values = [104], i, c;
    for (i = 0; i < text.length; i++) {
      c = text.charCodeAt(i);
      if (c < 32 || c > 126) { throw new Error('Character not supported in barcode: ' + text.charAt(i)); }
      values.push(c - 32);
    }
    var sum = 104;
    for (i = 1; i < values.length; i++) { sum += values[i] * i; }
    values.push(sum % 103);
    values.push(106);
    return values.map(function (v) { return C128[v]; }).join('');
  }
  function barcodeSvg(text) {
    var pattern = code128Pattern(text), quiet = 10, x = quiet, bar = true, rects = '', height = 40;
    for (var i = 0; i < pattern.length; i++) {
      var w = parseInt(pattern.charAt(i), 10);
      if (bar) { rects += '<rect x="' + x + '" y="0" width="' + w + '" height="' + height + '"/>'; }
      x += w; bar = !bar;
    }
    var total = x + quiet;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + total + ' ' + height +
      '" preserveAspectRatio="none" shape-rendering="crispEdges"><rect width="' + total + '" height="' + height +
      '" fill="#fff"/><g fill="#000">' + rects + '</g></svg>';
  }
  /* The barcode is drawn once as a PNG bitmap (6 px per module, no stretching), so the preview,
     the print and the PDF export all show exactly the same barcode. */
  var barcodeCache = {};
  function barcodeBitmap(text) {
    if (barcodeCache[text]) { return barcodeCache[text]; }
    var pattern = code128Pattern(text), quiet = 10, k = 6, h = 160, total = quiet * 2, i;
    for (i = 0; i < pattern.length; i++) { total += parseInt(pattern.charAt(i), 10); }
    var canvas = document.createElement('canvas');
    canvas.width = total * k; canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000000';
    var x = quiet, bar = true;
    for (i = 0; i < pattern.length; i++) {
      var w = parseInt(pattern.charAt(i), 10);
      if (bar) { ctx.fillRect(x * k, 0, w * k, h); }
      x += w; bar = !bar;
    }
    barcodeCache[text] = { uri: canvas.toDataURL('image/png'), aspect: canvas.width / canvas.height };
    return barcodeCache[text];
  }
  /* Returns an <img> with a fixed size in mm (8 mm high, width in proportion, max 86 mm). */
  function barcodeImgHtml(text) {
    try {
      var bc = barcodeBitmap(text);
      var wmm = Math.min(86, bc.aspect * 8);
      return '<img alt="Barcode ' + esc(text) + '" src="' + bc.uri + '" style="width:' + wmm.toFixed(2) + 'mm;height:8mm">';
    } catch (e) { return ''; }
  }

  /* ===================================================================
     4. IMAGE AND DATE UTILITIES
     =================================================================== */
  /* opts: { cover: {w,h}, quality } -> JPEG crop;  { max: px, png: true } -> keep transparency */
  function readImage(file, opts) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type)) { reject(new Error('Please choose an image file (PNG or JPG).')); return; }
      if (file.size > 8 * 1024 * 1024) { reject(new Error('The image is larger than 8 MB.')); return; }
      var fr = new FileReader();
      fr.onerror = function () { reject(new Error('The image could not be read.')); };
      fr.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error('This image format is not supported.')); };
        img.onload = function () {
          try {
            var canvas = document.createElement('canvas');
            var ctx = canvas.getContext('2d');
            var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
            if (opts.cover) {
              canvas.width = opts.cover.w; canvas.height = opts.cover.h;
              ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
              var sc = Math.max(canvas.width / iw, canvas.height / ih);
              var dw = iw * sc, dh = ih * sc;
              ctx.drawImage(img, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
              resolve(canvas.toDataURL('image/jpeg', opts.quality || 0.85));
            } else {
              var s = Math.min(1, opts.max / iw, opts.max / ih);
              canvas.width = Math.max(1, Math.round(iw * s)); canvas.height = Math.max(1, Math.round(ih * s));
              ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
              resolve(canvas.toDataURL('image/png'));
            }
          } catch (e) { reject(e); }
        };
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }

  function isRealDate(y, m, d) {
    var dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }
  function ymd(y, m, d) { return y + '-' + pad2(m) + '-' + pad2(d); }
  /* Accepts Excel serial numbers, Date objects, YYYY-MM-DD, DD/MM/YYYY. Returns {value, error} */
  function normalizeDate(v) {
    var out = { value: '' };
    if (v === '' || v === null || v === undefined) { return out; }
    var y, m, d, mt;
    if (v instanceof Date && !isNaN(v.getTime())) {
      var dd = new Date(v.getTime() + 12 * 3600 * 1000);
      out.value = ymd(dd.getFullYear(), dd.getMonth() + 1, dd.getDate());
    } else if (typeof v === 'number' && isFinite(v)) {
      if (v < 1 || v > 100000) { out.error = 'Invalid date'; return out; }
      var u = new Date(Math.floor(v - 25569) * 86400000);
      out.value = ymd(u.getUTCFullYear(), u.getUTCMonth() + 1, u.getUTCDate());
    } else {
      var s = trim(v);
      if ((mt = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/.exec(s))) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
      else if ((mt = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/.exec(s))) { d = +mt[1]; m = +mt[2]; y = +mt[3]; }
      else { out.error = 'Date "' + s + '" not understood (use YYYY-MM-DD)'; return out; }
      if (!isRealDate(y, m, d)) { out.error = 'Date "' + s + '" does not exist'; return out; }
      out.value = ymd(y, m, d);
    }
    var yy = parseInt(out.value.slice(0, 4), 10);
    if (yy < 1980 || out.value > ymd(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate())) {
      out.error = 'Date of birth ' + out.value + ' is not realistic';
    }
    return out;
  }
  function displayDate(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
    if (!m) { return v || ''; }
    return parseInt(m[3], 10) + ' ' + MONTHS[parseInt(m[2], 10) - 1] + ' ' + m[1];
  }

  /* ===================================================================
     5. AUTHENTICATION
     =================================================================== */
  var failedLogins = 0, lockedUntil = 0;

  function isLoggedIn() { try { return sessionStorage.getItem('dd_auth') === '1'; } catch (e) { return false; } }
  function setLoggedIn(v) { try { if (v) { sessionStorage.setItem('dd_auth', '1'); } else { sessionStorage.removeItem('dd_auth'); } } catch (e) { /* ignore */ } }

  function showLogin() {
    $('#app').hidden = true;
    $('#loginScreen').hidden = false;
    $('#loginPass').value = '';
    $('#loginError').hidden = true;
    setTimeout(function () { $('#loginUser').focus(); }, 50);
  }
  function showApp() {
    $('#loginScreen').hidden = true;
    $('#app').hidden = false;
    renderAll();
    go('dashboard');
  }
  function loginError(msg) { var el = $('#loginError'); el.textContent = msg; el.hidden = false; }

  function handleLogin(e) {
    e.preventDefault();
    var now = Date.now();
    if (now < lockedUntil) {
      loginError('Too many wrong attempts. Try again in ' + Math.ceil((lockedUntil - now) / 1000) + ' seconds.');
      return;
    }
    var user = trim($('#loginUser').value).toLowerCase();
    var pass = $('#loginPass').value;
    if (!user || !pass) { loginError('Enter the username and the password.'); return; }
    if (user === ADMIN_USER && hashPw(pass) === getPassHash()) {
      failedLogins = 0; setLoggedIn(true); showApp();
    } else {
      failedLogins += 1;
      if (failedLogins >= MAX_LOGIN_TRIES) {
        lockedUntil = Date.now() + LOCK_SECONDS * 1000; failedLogins = 0;
        loginError('Too many wrong attempts. Sign-in is locked for ' + LOCK_SECONDS + ' seconds.');
      } else {
        loginError('Wrong username or password.');
      }
      $('#loginPass').select();
    }
  }
  function logout() { setLoggedIn(false); selected.clear(); showLogin(); }

  /* ===================================================================
     6. NAVIGATION AND SHARED UI
     =================================================================== */
  var currentView = 'dashboard';
  var selected = new Set();

  function go(view) {
    currentView = view;
    $$('.view').forEach(function (v) { v.classList.toggle('active', v.id === 'view-' + view); });
    $$('.nav-item[data-view]').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-view') === view); });
    $('#sidebar').classList.remove('open');
    if (view === 'cards') { renderCardsView(); }
    if (view === 'students') { renderStudents(); }
    if (view === 'dashboard') { renderDashboard(); }
    if (view === 'settings') { renderSettings(); }
    window.scrollTo(0, 0);
  }

  function toast(msg, type) {
    var el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = msg;
    $('#toastRoot').appendChild(el);
    setTimeout(function () { el.remove(); }, type === 'error' ? 7000 : 4000);
  }
  function busy(on, text) {
    $('#busy').hidden = !on;
    if (text) { $('#busyText').textContent = text; }
  }

  var onDismiss = null;
  function openModal(html, cls) {
    var root = $('#modalRoot');
    root.innerHTML = '<div class="modal-backdrop" data-backdrop="1"><div class="modal ' + (cls || '') +
      '" role="dialog" aria-modal="true">' + html + '</div></div>';
    document.body.classList.add('modal-open');
    var first = root.querySelector('input:not([type=hidden]):not([type=file]), select, textarea');
    if (first) { setTimeout(function () { first.focus(); }, 40); }
    return root.firstChild;
  }
  function closeModal(silent) {
    var cb = onDismiss; onDismiss = null;
    $('#modalRoot').innerHTML = '';
    document.body.classList.remove('modal-open');
    if (cb && !silent) { cb(); }
  }
  function confirmBox(title, message, okLabel, danger) {
    return new Promise(function (resolve) {
      openModal('<div class="modal-head"><h2>' + esc(title) + '</h2><button class="modal-x" data-close aria-label="Close">&times;</button></div>' +
        '<div class="modal-body"><p>' + esc(message) + '</p></div>' +
        '<div class="modal-foot"><button class="btn" data-close>Cancel</button>' +
        '<button class="btn ' + (danger ? 'btn-danger solid' : 'btn-primary') + '" id="confirmOk">' + esc(okLabel || 'OK') + '</button></div>');
      onDismiss = function () { resolve(false); };
      $('#confirmOk').addEventListener('click', function () { onDismiss = null; closeModal(true); resolve(true); });
    });
  }
  function passwordBox(title, message) {
    return new Promise(function (resolve) {
      openModal('<div class="modal-head"><h2>' + esc(title) + '</h2><button class="modal-x" data-close aria-label="Close">&times;</button></div>' +
        '<form id="pwBoxForm"><div class="modal-body"><p>' + esc(message) + '</p>' +
        '<label for="pwBoxInput">Admin password</label><input id="pwBoxInput" type="password" autocomplete="current-password">' +
        '<div class="form-error" id="pwBoxErr" hidden></div></div>' +
        '<div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button>' +
        '<button type="submit" class="btn btn-danger solid">Confirm</button></div></form>');
      onDismiss = function () { resolve(false); };
      $('#pwBoxForm').addEventListener('submit', function (e) {
        e.preventDefault();
        if (hashPw($('#pwBoxInput').value) === getPassHash()) { onDismiss = null; closeModal(true); resolve(true); }
        else { var el = $('#pwBoxErr'); el.textContent = 'Wrong password.'; el.hidden = false; }
      });
    });
  }

  function renderAll() {
    renderBrand();
    renderDashboard();
    renderStudents();
    renderCardsView();
    renderSettings();
    $('#navCount').textContent = state.students.length;
  }
  function renderBrand() {
    $('#topSchool').textContent = state.settings.schoolName || 'School';
    $('#topYear').textContent = state.settings.academicYear ? 'Academic year ' + state.settings.academicYear : '';
    var mark = $('#brandMark');
    mark.innerHTML = state.settings.logo ? '<img alt="" src="' + state.settings.logo + '">' : 'ID';
  }

  /* ===================================================================
     7. DASHBOARD
     =================================================================== */
  function renderDashboard() {
    var list = state.students;
    var male = list.filter(function (s) { return s.gender === 'Male'; }).length;
    var female = list.length - male;
    var noPhoto = list.filter(function (s) { return !s.photo; }).length;
    $('#dashStats').innerHTML =
      '<div class="stat"><b>' + list.length + '</b><span>Total students</span></div>' +
      '<div class="stat green"><b>' + male + '</b><span>Male</span></div>' +
      '<div class="stat gold"><b>' + female + '</b><span>Female</span></div>' +
      '<div class="stat red"><b>' + noPhoto + '</b><span>Without a photo</span></div>';

    var max = 1, counts = {};
    GRADES.forEach(function (g) {
      var m = list.filter(function (s) { return s.grade === g && s.gender === 'Male'; }).length;
      var f = list.filter(function (s) { return s.grade === g && s.gender === 'Female'; }).length;
      counts[g] = { m: m, f: f };
      max = Math.max(max, m + f);
    });
    var html = GRADES.map(function (g) {
      var c = counts[g], t = c.m + c.f;
      return '<div class="bar-row"><span>Grade ' + g + '</span><div class="bar-track">' +
        '<div class="bar-male" style="width:' + (c.m / max * 100) + '%"></div>' +
        '<div class="bar-female" style="width:' + (c.f / max * 100) + '%"></div></div><b>' + t + '</b></div>';
    }).join('');
    html += '<div class="legend"><span><i style="background:var(--primary)"></i>Male</span><span><i style="background:var(--green)"></i>Female</span></div>';
    $('#gradeChart').innerHTML = html;

    var recent = list.slice().sort(function (a, b) { return (b.createdAt || '').localeCompare(a.createdAt || ''); }).slice(0, 6);
    $('#recentList').innerHTML = recent.length ? recent.map(function (s) {
      return '<li><img class="thumb" alt="" src="' + (s.photo || PLACEHOLDER_PHOTO) + '"><div><strong>' + esc(s.fullName) +
        '</strong><small>' + esc(s.studentId) + ' &middot; Grade ' + esc(s.grade) + esc(s.section ? ' ' + s.section : '') + '</small></div></li>';
    }).join('') : '<li class="muted empty">No students yet. Add one or import an Excel file.</li>';
  }

  /* ===================================================================
     8. STUDENTS
     =================================================================== */
  var stPage = 1;

  function matches(s, q, grade, gender) {
    if (grade && s.grade !== grade) { return false; }
    if (gender && s.gender !== gender) { return false; }
    if (q) {
      var hay = (s.fullName + ' ' + s.studentId + ' ' + s.phone + ' ' + s.section + ' ' + s.parentName).toLowerCase();
      if (hay.indexOf(q) === -1) { return false; }
    }
    return true;
  }
  function filteredStudents() {
    var q = trim($('#stSearch').value).toLowerCase();
    var grade = $('#stGrade').value, gender = $('#stGender').value, sort = $('#stSort').value;
    var list = state.students.filter(function (s) { return matches(s, q, grade, gender); });
    var cmpName = function (a, b) { return a.fullName.localeCompare(b.fullName); };
    list.sort(function (a, b) {
      if (sort === 'newest') { return (b.createdAt || '').localeCompare(a.createdAt || ''); }
      if (sort === 'id') { return a.studentId.localeCompare(b.studentId, undefined, { numeric: true }); }
      if (sort === 'grade') {
        var g = (parseInt(a.grade, 10) || 0) - (parseInt(b.grade, 10) || 0);
        if (g) { return g; }
        var sc = a.section.localeCompare(b.section);
        return sc || cmpName(a, b);
      }
      return cmpName(a, b);
    });
    return list;
  }

  function renderStudents() {
    var list = filteredStudents();
    var pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    if (stPage > pages) { stPage = pages; }
    var slice = list.slice((stPage - 1) * PAGE_SIZE, stPage * PAGE_SIZE);

    $('#stBody').innerHTML = slice.length ? slice.map(function (s) {
      return '<tr>' +
        '<td><input type="checkbox" class="row-check" data-id="' + esc(s.id) + '"' + (selected.has(s.id) ? ' checked' : '') + ' aria-label="Select ' + esc(s.fullName) + '"></td>' +
        '<td><img class="thumb" alt="" src="' + (s.photo || PLACEHOLDER_PHOTO) + '"></td>' +
        '<td class="mono">' + esc(s.studentId) + '</td>' +
        '<td><strong>' + esc(s.fullName) + '</strong><small>' + esc(s.parentName) + '</small></td>' +
        '<td>' + esc(s.gender) + '</td>' +
        '<td>' + esc(s.grade) + (s.section ? ' - ' + esc(s.section) : '') + '</td>' +
        '<td>' + esc(s.phone) + '</td>' +
        '<td><div class="row-actions">' +
        '<button class="link-btn" data-action="edit" data-id="' + esc(s.id) + '">Edit</button>' +
        '<button class="link-btn" data-action="card" data-id="' + esc(s.id) + '">ID card</button>' +
        '<button class="link-btn danger" data-action="delete" data-id="' + esc(s.id) + '">Delete</button></div></td></tr>';
    }).join('') : '<tr><td colspan="8" class="muted empty">' +
      (state.students.length ? 'No students match your search.' : 'No students yet. Click "Add student" or import an Excel file.') + '</td></tr>';

    var allChecked = list.length > 0 && list.every(function (s) { return selected.has(s.id); });
    $('#stCheckAll').checked = allChecked;
    $('#stSelInfo').textContent = selected.size ? selected.size + ' selected' : '';
    $('#navCount').textContent = state.students.length;

    $('#stPager').innerHTML = '<span>' + list.length + ' student' + (list.length === 1 ? '' : 's') + ' shown, ' + state.students.length + ' in total</span>' +
      '<div class="btn-row"><button class="btn btn-sm" data-page="prev"' + (stPage <= 1 ? ' disabled' : '') + '>Previous</button>' +
      '<span>Page ' + stPage + ' of ' + pages + '</span>' +
      '<button class="btn btn-sm" data-page="next"' + (stPage >= pages ? ' disabled' : '') + '>Next</button></div>';
  }

  var formPhoto = '';
  function studentFormHtml(s) {
    var isNew = !s;
    s = s || {
      studentId: '', fullName: '', gender: '', dob: '', grade: '', section: '',
      academicYear: state.settings.academicYear || '', parentName: '', phone: '', address: '', photo: ''
    };
    formPhoto = s.photo || '';
    var gradeOpts = '<option value="">Select grade</option>' + GRADES.map(function (g) {
      return '<option value="' + g + '"' + (s.grade === g ? ' selected' : '') + '>Grade ' + g + '</option>';
    }).join('');
    return '<div class="modal-head"><h2>' + (isNew ? 'Add student' : 'Edit student') + '</h2><button class="modal-x" data-close aria-label="Close">&times;</button></div>' +
      '<form id="studentForm" novalidate data-edit-id="' + (isNew ? '' : esc(s.id)) + '"><div class="modal-body"><div class="form-grid">' +
      '<div><label for="fId">Student ID</label><input id="fId" type="text" value="' + esc(s.studentId) + '" maxlength="24" placeholder="STU-2026-0001"><div class="field-error" data-err="studentId"></div></div>' +
      '<div><label for="fName">Full name</label><input id="fName" type="text" value="' + esc(s.fullName) + '" maxlength="80"><div class="field-error" data-err="fullName"></div></div>' +
      '<div><label for="fGender">Gender</label><select id="fGender"><option value="">Select gender</option><option' + (s.gender === 'Male' ? ' selected' : '') + '>Male</option><option' + (s.gender === 'Female' ? ' selected' : '') + '>Female</option></select><div class="field-error" data-err="gender"></div></div>' +
      '<div><label for="fDob">Date of birth</label><input id="fDob" type="date" value="' + esc(s.dob) + '"><div class="field-error" data-err="dob"></div></div>' +
      '<div><label for="fGrade">Grade</label><select id="fGrade">' + gradeOpts + '</select><div class="field-error" data-err="grade"></div></div>' +
      '<div><label for="fSection">Section</label><input id="fSection" type="text" value="' + esc(s.section) + '" maxlength="10" placeholder="A"></div>' +
      '<div><label for="fYear">Academic year</label><input id="fYear" type="text" value="' + esc(s.academicYear) + '" maxlength="20"></div>' +
      '<div><label for="fPhone">Parent phone</label><input id="fPhone" type="tel" value="' + esc(s.phone) + '" maxlength="20" placeholder="0911000000"><div class="field-error" data-err="phone"></div></div>' +
      '<div class="full"><label for="fParent">Parent / guardian name</label><input id="fParent" type="text" value="' + esc(s.parentName) + '" maxlength="80"></div>' +
      '<div class="full"><label for="fAddress">Address</label><input id="fAddress" type="text" value="' + esc(s.address) + '" maxlength="100" placeholder="Town, kebele"></div>' +
      '<div class="full"><label>Photo</label><div class="photo-field"><img id="fPhotoPrev" alt="Student photo preview" src="' + (s.photo || PLACEHOLDER_PHOTO) + '">' +
      '<div class="btn-row"><label class="btn btn-sm">Choose photo<input type="file" id="fPhotoFile" accept="image/*" hidden></label>' +
      '<button type="button" class="btn btn-sm" id="fPhotoClear">Remove</button></div></div><div class="field-error" data-err="photo"></div></div>' +
      '</div></div><div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button>' +
      '<button type="submit" class="btn btn-primary">' + (isNew ? 'Save student' : 'Save changes') + '</button></div></form>';
  }
  function openStudentForm(internalId) {
    var s = null;
    if (internalId) { s = state.students.filter(function (x) { return x.id === internalId; })[0] || null; }
    openModal(studentFormHtml(s), 'wide');
  }
  function setFieldError(name, msg) {
    var el = $('[data-err="' + name + '"]');
    if (el) { el.textContent = msg || ''; }
  }

  function handleStudentSubmit(form) {
    var editId = form.getAttribute('data-edit-id');
    $$('[data-err]', form).forEach(function (el) { el.textContent = ''; });
    var rec = {
      studentId: normalizeStudentId($('#fId').value),
      fullName: trim($('#fName').value),
      gender: $('#fGender').value,
      dob: $('#fDob').value,
      grade: $('#fGrade').value,
      section: trim($('#fSection').value).toUpperCase(),
      academicYear: trim($('#fYear').value),
      parentName: trim($('#fParent').value),
      phone: trim($('#fPhone').value),
      address: trim($('#fAddress').value),
      photo: formPhoto
    };
    var ok = true;
    if (!rec.studentId) { setFieldError('studentId', 'Enter the Student ID (it must start with STU-).'); ok = false; }
    else if (!isValidStudentId(rec.studentId)) { setFieldError('studentId', 'Must start with STU- (example STU-2026-0001).'); ok = false; }
    else if (idExists(rec.studentId, editId)) { setFieldError('studentId', 'This Student ID is already used.'); ok = false; }
    if (rec.fullName.length < 3) { setFieldError('fullName', 'Enter the full name.'); ok = false; }
    if (!rec.gender) { setFieldError('gender', 'Select the gender.'); ok = false; }
    if (!rec.grade) { setFieldError('grade', 'Select the grade.'); ok = false; }
    if (rec.dob) {
      var nd = normalizeDate(rec.dob);
      if (nd.error) { setFieldError('dob', nd.error); ok = false; }
    }
    if (rec.phone && !/^[0-9+\-\s()]{7,20}$/.test(rec.phone)) { setFieldError('phone', 'Use digits only, for example 0911000000.'); ok = false; }
    if (!ok) { return; }

    var snapshot = state.students.slice();
    var now = new Date().toISOString();
    if (editId) {
      var idx = -1;
      state.students.forEach(function (x, i) { if (x.id === editId) { idx = i; } });
      if (idx < 0) { toast('This student no longer exists.', 'error'); closeModal(); return; }
      state.students[idx] = Object.assign({}, state.students[idx], rec, { updatedAt: now });
    } else {
      state.students.push(Object.assign({ id: uid(), createdAt: now, updatedAt: now }, rec));
    }
    persistOrRollback(snapshot).then(function () {
      closeModal(true);
      toast(editId ? 'Changes saved.' : 'Student saved.', 'success');
      renderAll();
    }).catch(function () { /* message already shown */ });
  }

  function deleteStudents(ids) {
    if (!ids.length) { return; }
    var label = ids.length === 1 ? 'this student' : ids.length + ' students';
    confirmBox('Delete ' + label + '?', 'The record' + (ids.length === 1 ? '' : 's') + ' will be removed permanently. This cannot be undone.', 'Delete', true).then(function (yes) {
      if (!yes) { return; }
      var snapshot = state.students.slice();
      var set = new Set(ids);
      state.students = state.students.filter(function (s) { return !set.has(s.id); });
      persistOrRollback(snapshot).then(function () {
        ids.forEach(function (id) { selected.delete(id); });
        toast('Deleted.', 'success');
        renderAll();
      }).catch(function () { /* shown */ });
    });
  }

  /* ===================================================================
     9. EXCEL / CSV IMPORT AND EXPORT
     =================================================================== */
  var importRows = [];

  function hasXlsx() { return typeof window.XLSX !== 'undefined'; }

  function parseCSV(text) {
    text = text.replace(/^\uFEFF/, '');
    var first = text.split(/\r?\n/)[0] || '';
    var delim = [',', ';', '\t'].map(function (d) { return [d, first.split(d).length]; })
      .sort(function (a, b) { return b[1] - a[1]; })[0][0];
    var rows = [], row = [], cur = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var c = text.charAt(i);
      if (q) {
        if (c === '"') { if (text.charAt(i + 1) === '"') { cur += '"'; i++; } else { q = false; } }
        else { cur += c; }
      } else if (c === '"') { q = true; }
      else if (c === delim) { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text.charAt(i + 1) === '\n') { i++; }
        row.push(cur); cur = ''; rows.push(row); row = [];
      } else { cur += c; }
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }
  function csvEscape(v) {
    var s = String(v === null || v === undefined ? '' : v);
    return /[",\r\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  var HEADER_ALIASES = {
    studentId: ['studentid', 'id', 'idno', 'idnumber', 'studentidnumber', 'studentno'],
    fullName: ['fullname', 'name', 'studentname', 'studentfullname'],
    gender: ['gender', 'sex'],
    dob: ['dateofbirth', 'dob', 'birthdate', 'birthday', 'dateofbirthyyyymmdd'],
    grade: ['grade', 'class', 'gradelevel', 'level'],
    section: ['section', 'sec', 'classsection'],
    academicYear: ['academicyear', 'schoolyear', 'year'],
    parentName: ['parentguardianname', 'parentname', 'guardianname', 'guardian', 'parent', 'parentguardian'],
    phone: ['parentphone', 'phone', 'phonenumber', 'mobile', 'guardianphone', 'telephone'],
    address: ['address', 'residence', 'location']
  };
  function headerKey(h) {
    var n = String(h === null || h === undefined ? '' : h).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!n) { return null; }
    for (var key in HEADER_ALIASES) {
      if (HEADER_ALIASES.hasOwnProperty(key) && HEADER_ALIASES[key].indexOf(n) !== -1) { return key; }
    }
    return null;
  }

  function cellText(v) {
    if (v === null || v === undefined) { return ''; }
    if (typeof v === 'number') { return String(v); }
    return trim(v);
  }

  function processRows(table) {
    var headerIdx = -1, map = {}, i, j;
    for (i = 0; i < Math.min(table.length, 10); i++) {
      var m = {}, found = 0;
      for (j = 0; j < table[i].length; j++) {
        var k = headerKey(table[i][j]);
        if (k && m[k] === undefined) { m[k] = j; found++; }
      }
      if (m.fullName !== undefined && found >= 2) { headerIdx = i; map = m; break; }
    }
    if (headerIdx < 0) {
      throw new Error('The file has no "Full Name" column. Please use the Excel template and keep its column titles.');
    }
    var missing = ['gender', 'grade'].filter(function (k) { return map[k] === undefined; });
    if (missing.length) { throw new Error('Missing column: ' + missing.join(', ') + '. Please use the Excel template.'); }

    var seenIds = new Set();
    var rows = [];
    for (i = headerIdx + 1; i < table.length; i++) {
      var line = table[i];
      var blank = line.every(function (c) { return cellText(c) === ''; });
      if (blank) { continue; }
      var get = function (key) { return map[key] === undefined ? '' : line[map[key]]; };
      var errors = [], notes = [];
      var rec = {
        studentId: normalizeStudentId(cellText(get('studentId'))),
        fullName: trim(cellText(get('fullName'))),
        gender: '', dob: '', grade: '',
        section: trim(cellText(get('section'))).toUpperCase(),
        academicYear: trim(cellText(get('academicYear'))),
        parentName: trim(cellText(get('parentName'))),
        phone: trim(cellText(get('phone'))),
        address: trim(cellText(get('address')))
      };
      if (rec.fullName.length < 3) { errors.push('Full name is missing'); }
      var g = cellText(get('gender')).toLowerCase();
      if (/^(m|male|man|boy|ወንድ)$/.test(g)) { rec.gender = 'Male'; }
      else if (/^(f|female|woman|girl|ሴት)$/.test(g)) { rec.gender = 'Female'; }
      else { errors.push(g ? 'Gender "' + g + '" must be Male or Female' : 'Gender is missing'); }
      var gm = /(\d{1,2})/.exec(cellText(get('grade')));
      if (gm && GRADES.indexOf(String(parseInt(gm[1], 10))) !== -1) { rec.grade = String(parseInt(gm[1], 10)); }
      else { errors.push('Grade must be 9, 10, 11 or 12'); }
      var nd = normalizeDate(get('dob'));
      if (nd.error) { errors.push(nd.error); } else { rec.dob = nd.value; }
      if (!rec.dob && !nd.error) { notes.push('No date of birth'); }
      if (rec.phone && !/^[0-9+\-\s()]{7,20}$/.test(rec.phone)) {
        // Excel often drops the leading zero of a phone number; repair the common case
        if (/^9\d{8}$/.test(rec.phone)) { rec.phone = '0' + rec.phone; }
        else { notes.push('Phone number looks unusual'); }
      } else if (/^9\d{8}$/.test(rec.phone)) { rec.phone = '0' + rec.phone; }
      if (!rec.studentId) { errors.push('Student ID is missing'); }
      else {
        if (!isValidStudentId(rec.studentId)) { errors.push('Student ID must start with STU-'); }
        else if (seenIds.has(rec.studentId)) { errors.push('Student ID appears twice in the file'); }
        else { seenIds.add(rec.studentId); }
      }
      rows.push({ rowNum: i + 1, rec: rec, errors: errors, notes: notes, status: errors.length ? 'error' : 'new' });
    }
    return rows;
  }

  function classifyImportRows() {
    var allowUpdate = $('#importUpdate').checked;
    importRows.forEach(function (r) {
      if (r.errors.length) { r.status = 'error'; return; }
      if (idExists(r.rec.studentId)) { r.status = allowUpdate ? 'update' : 'skip'; }
      else { r.status = 'new'; }
    });
  }
  function renderImportPreview() {
    classifyImportRows();
    var count = function (s) { return importRows.filter(function (r) { return r.status === s; }).length; };
    $('#importChips').innerHTML =
      '<span class="chip">' + importRows.length + ' rows read</span>' +
      '<span class="chip ok">' + count('new') + ' new</span>' +
      '<span class="chip">' + count('update') + ' to update</span>' +
      '<span class="chip warn">' + count('skip') + ' skipped (already exist)</span>' +
      '<span class="chip err">' + count('error') + ' with errors</span>';
    var label = { 'new': 'New', update: 'Update', skip: 'Skip', error: 'Error' };
    $('#importBody').innerHTML = importRows.map(function (r) {
      var notes = r.errors.concat(r.notes).join('; ');
      return '<tr><td>' + r.rowNum + '</td><td><span class="status ' + r.status + '">' + label[r.status] + '</span></td>' +
        '<td class="mono">' + esc(r.rec.studentId) + '</td><td>' + esc(r.rec.fullName) + '</td><td>' + esc(r.rec.gender) + '</td>' +
        '<td>' + esc(r.rec.grade) + '</td><td>' + esc(r.rec.section) + '</td><td>' + esc(r.rec.dob) + '</td><td>' + esc(notes) + '</td></tr>';
    }).join('');
    var importable = count('new') + count('update');
    $('#importCommitBtn').disabled = importable === 0;
    $('#importCommitBtn').textContent = importable ? 'Import ' + importable + ' valid row' + (importable === 1 ? '' : 's') : 'No valid rows to import';
  }

  function handleImportFile(file) {
    if (!file) { return; }
    var name = file.name || '';
    var isCsv = /\.csv$/i.test(name);
    if (!isCsv && !hasXlsx()) {
      toast('The Excel reader could not be loaded (no internet?). Save the sheet as CSV and import that file instead.', 'error');
      return;
    }
    busy(true, 'Reading file');
    var fr = new FileReader();
    fr.onerror = function () { busy(false); toast('The file could not be read.', 'error'); };
    fr.onload = function () {
      try {
        var table;
        if (isCsv) { table = parseCSV(String(fr.result)); }
        else {
          var wb = window.XLSX.read(new Uint8Array(fr.result), { type: 'array' });
          var ws = wb.Sheets[wb.SheetNames[0]];
          table = window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', blankrows: false });
        }
        importRows = processRows(table);
        if (!importRows.length) { throw new Error('The file has no student rows below the column titles.'); }
        $('#importPreviewPanel').hidden = false;
        renderImportPreview();
        toast('File read. Check the list, then import.', 'success');
      } catch (err) {
        importRows = [];
        $('#importPreviewPanel').hidden = true;
        toast(err.message || 'The file could not be understood.', 'error');
      } finally { busy(false); $('#importFile').value = ''; }
    };
    if (isCsv) { fr.readAsText(file); } else { fr.readAsArrayBuffer(file); }
  }

  function commitImport() {
    classifyImportRows();
    var todo = importRows.filter(function (r) { return r.status === 'new' || r.status === 'update'; });
    if (!todo.length) { toast('There are no valid rows to import.', 'warn'); return; }
    var snapshot = state.students.slice();
    var used = new Set();
    var added = 0, updated = 0, now = new Date().toISOString();

    todo.forEach(function (r) {
      var rec = r.rec;
      if (r.status === 'update') {
        state.students = state.students.map(function (s) {
          if (s.studentId !== rec.studentId) { return s; }
          var merged = Object.assign({}, s, { updatedAt: now });
          ['fullName', 'gender', 'dob', 'grade', 'section', 'academicYear', 'parentName', 'phone', 'address'].forEach(function (k) {
            if (rec[k]) { merged[k] = rec[k]; }
          });
          return merged;
        });
        updated++;
      } else {
        var sid = rec.studentId;
        used.add(sid);
        state.students.push({
          id: uid(), studentId: sid, fullName: rec.fullName, gender: rec.gender, dob: rec.dob, grade: rec.grade,
          section: rec.section, academicYear: rec.academicYear || state.settings.academicYear || '',
          parentName: rec.parentName, phone: rec.phone, address: rec.address, photo: '', createdAt: now, updatedAt: now
        });
        added++;
      }
    });

    persistOrRollback(snapshot).then(function () {
      var skipped = importRows.filter(function (r) { return r.status === 'skip'; }).length;
      var failed = importRows.filter(function (r) { return r.status === 'error'; }).length;
      importRows = [];
      $('#importPreviewPanel').hidden = true;
      renderAll();
      openModal('<div class="modal-head"><h2>Import finished</h2><button class="modal-x" data-close aria-label="Close">&times;</button></div>' +
        '<div class="modal-body"><div class="chips"><span class="chip ok">' + added + ' added</span><span class="chip">' + updated + ' updated</span>' +
        '<span class="chip warn">' + skipped + ' skipped</span><span class="chip err">' + failed + ' with errors (not imported)</span></div>' +
        '<p>All imported students are saved. You can now add photos from the Students page and generate the ID cards.</p></div>' +
        '<div class="modal-foot"><button class="btn" data-close>Close</button><button class="btn btn-primary" data-go="students">View students</button></div>');
    }).catch(function () { /* message already shown */ });
  }

  function downloadTemplate() {
    var sample = [
      ['STU-2026-0001', 'Abebe Kebede Tadesse', 'Male', '2009-04-15', '9', 'A', currentAcademicYear(), 'Kebede Tadesse', '0911000000', 'Dembi Dollo, Kebele 01'],
      ['STU-2026-0002', 'Almaz Bekele Gudata', 'Female', '2008-11-02', '10', 'B', currentAcademicYear(), 'Bekele Gudata', '0922000000', 'Dembi Dollo, Kebele 02']
    ];
    var notes = [
      ['How to fill this template'],
      ['1. Use the "Students" sheet. Keep the column titles in row 1 unchanged.'],
      ['2. Student ID is required and must start with STU- (example STU-2026-0100). Each ID must be different.'],
      ['3. Student ID, Full Name, Gender and Grade are required.'],
      ['4. Gender: Male or Female.   Grade: 9, 10, 11 or 12.'],
      ['5. Date of Birth: write as YYYY-MM-DD (example 2009-04-15). Excel dates also work.'],
      ['6. Delete the two sample rows before you add real students.'],
      ['7. Photos are added later from the Students page.']
    ];
    if (hasXlsx()) {
      var X = window.XLSX;
      var wb = X.utils.book_new();
      var ws = X.utils.aoa_to_sheet([IMPORT_HEADERS].concat(sample));
      ws['!cols'] = IMPORT_HEADERS.map(function (h) { return { wch: Math.max(14, h.length + 4) }; });
      X.utils.book_append_sheet(wb, ws, 'Students');
      var ws2 = X.utils.aoa_to_sheet(notes);
      ws2['!cols'] = [{ wch: 110 }];
      X.utils.book_append_sheet(wb, ws2, 'Instructions');
      X.writeFile(wb, 'Student_Import_Template.xlsx');
    } else {
      var csv = [IMPORT_HEADERS].concat(sample).map(function (r) { return r.map(csvEscape).join(','); }).join('\r\n');
      downloadBlob('Student_Import_Template.csv', '\uFEFF' + csv, 'text/csv;charset=utf-8');
      toast('The Excel library is not available, so a CSV template was downloaded. It opens in Excel.', 'warn');
    }
  }

  function exportStudents() {
    var list = filteredStudents();
    if (!list.length) { toast('There are no students to export.', 'warn'); return; }
    var rows = list.map(function (s) {
      return [s.studentId, s.fullName, s.gender, s.dob, s.grade, s.section, s.academicYear, s.parentName, s.phone, s.address];
    });
    if (hasXlsx()) {
      var X = window.XLSX, wb = X.utils.book_new();
      var ws = X.utils.aoa_to_sheet([IMPORT_HEADERS].concat(rows));
      ws['!cols'] = IMPORT_HEADERS.map(function (h) { return { wch: Math.max(14, h.length + 4) }; });
      X.utils.book_append_sheet(wb, ws, 'Students');
      X.writeFile(wb, 'Students_' + stamp() + '.xlsx');
    } else {
      var csv = [IMPORT_HEADERS].concat(rows).map(function (r) { return r.map(csvEscape).join(','); }).join('\r\n');
      downloadBlob('Students_' + stamp() + '.csv', '\uFEFF' + csv, 'text/csv;charset=utf-8');
    }
  }

  /* ===================================================================
     10. ID CARD BUILDER, PRINT AND PDF
     =================================================================== */
  function cardModeValue() {
    var el = $('input[name="cdMode"]:checked');
    return el ? el.value : 'both';
  }
  function cardTheme() {
    var c = state.settings.cardColor || '#17508f';
    return '--c1:' + c + ';--c2:' + shade(c, -22) + ';';
  }
  function cardHeadHtml() {
    var st = state.settings;
    var logo = st.logo ? '<img class="idc-logo" alt="" src="' + st.logo + '">' : '<div class="idc-logo-ph">LOGO</div>';
    return '<div class="idc-head">' + logo + '<div class="idc-titles"><div class="idc-title">' + esc(APP_TITLE) +
      '</div><div class="idc-school">' + esc(st.schoolName) + '</div></div></div>' +
      '<div class="idc-flag"><i></i><i></i><i></i></div>';
  }
  function line(label, value) {
    return '<div class="idc-line"><dt>' + esc(label) + '</dt><dd>' + esc(value || '-') + '</dd></div>';
  }
  function cardFront(s) {
    var st = state.settings;
    return '<div class="idcard" style="' + cardTheme() + '">' + cardHeadHtml() +
      '<div class="idc-body"><div class="idc-row">' +
      '<div class="idc-photo-wrap"><img class="idc-photo" alt="" src="' + (s.photo || PLACEHOLDER_PHOTO) + '">' +
      (st.stamp ? '<img class="idc-stamp" alt="" src="' + st.stamp + '">' : '') + '</div>' +
      '<div class="idc-info"><div class="idc-name">' + esc(s.fullName) + '</div><dl>' +
      line('Student ID', s.studentId) +
      line('Gender', s.gender) +
      line('Date of birth', displayDate(s.dob)) +
      line('Grade', s.grade + (s.section ? ' - ' + s.section : '')) +
      line('Academic year', s.academicYear || st.academicYear) +
      '</dl></div></div>' +
      '<div class="idc-foot"><div class="idc-bar">' + barcodeImgHtml(s.studentId) +
      '<div class="idc-barnum">' + esc(s.studentId) + '</div></div></div>' +
      '</div></div>';
  }
  function cardBack(s) {
    var st = state.settings;
    return '<div class="idcard back" style="' + cardTheme() + '">' +
      '<div class="idc-head"><div class="idc-titles"><div class="idc-title">' + esc(APP_TITLE) + '</div></div></div>' +
      '<div class="idc-flag"><i></i><i></i><i></i></div>' +
      '<div class="idc-back-body"><dl class="idc-back-fields">' +
      line('Student', s.fullName) +
      line('Parent / guardian', s.parentName) +
      line('Parent phone', s.phone) +
      line('Address', s.address) +
      line('School', st.schoolName) +
      line('Valid for', s.academicYear || st.academicYear) +
      '</dl><div class="idc-sign">' + (st.signature ? '<img class="idc-sig" alt="" src="' + st.signature + '">' : '<div class="idc-sig"></div>') +
      '<div class="idc-sign-line">' + (st.directorName ? esc(st.directorName) + '<br>' : '') + 'School Director</div></div>' +
      '<div class="idc-notice">' + esc(st.backNotice) + '</div></div></div>';
  }
  /* Returns the sheets as HTML. preview=true wraps every sheet so it can be scaled on screen. */
  function sheetsHtml(list, mode, preview) {
    var pages = [], groups = chunk(list, 8);
    groups.forEach(function (g, gi) {
      var base = 'Sheet ' + (gi + 1) + ' of ' + groups.length;
      if (mode === 'front' || mode === 'both') {
        pages.push({ cells: g.map(cardFront), label: base + ' - front' });
      }
      if (mode === 'back' || mode === 'both') {
        var backs = g.map(cardBack);
        if (mode === 'both') {
          while (backs.length < 8) { backs.push('<div class="idcard-empty"></div>'); }
          var mirrored = [];
          for (var i = 0; i < 8; i += 2) { mirrored.push(backs[i + 1], backs[i]); }
          backs = mirrored;
        }
        pages.push({ cells: backs, label: base + ' - back' });
      }
    });
    return pages.map(function (p) {
      var sheet = '<div class="sheet"><div class="sheet-grid">' + p.cells.join('') + '</div><div class="sheet-label">' + esc(p.label) + '</div></div>';
      return preview ? '<div class="sheet-wrap">' + sheet + '</div>' : sheet;
    }).join('');
  }

  function cardsFilter() {
    var q = trim($('#cdSearch').value).toLowerCase(), grade = $('#cdGrade').value;
    return state.students.filter(function (s) { return matches(s, q, grade, ''); })
      .sort(function (a, b) { return a.fullName.localeCompare(b.fullName); });
  }
  function selectedStudents() {
    return state.students.filter(function (s) { return selected.has(s.id); })
      .sort(function (a, b) {
        var g = (parseInt(a.grade, 10) || 0) - (parseInt(b.grade, 10) || 0);
        return g || a.section.localeCompare(b.section) || a.fullName.localeCompare(b.fullName);
      });
  }
  function renderCardsView() {
    var list = cardsFilter();
    $('#cdList').innerHTML = list.length ? list.map(function (s) {
      return '<label class="pick-item"><input type="checkbox" data-pick="' + esc(s.id) + '"' + (selected.has(s.id) ? ' checked' : '') + '>' +
        '<span>' + esc(s.fullName) + '<small>' + esc(s.studentId) + ' &middot; Grade ' + esc(s.grade) + esc(s.section ? ' ' + s.section : '') + '</small></span></label>';
    }).join('') : '<p class="muted empty">No students to show.</p>';
    renderCardsPreview();
  }
  function renderCardsPreview() {
    var sel = selectedStudents();
    var mode = cardModeValue();
    var sheets = Math.ceil(sel.length / 8) * (mode === 'both' ? 2 : 1);
    $('#cdSummary').textContent = sel.length
      ? sel.length + ' student' + (sel.length === 1 ? '' : 's') + ' selected - ' + sheets + ' A4 sheet' + (sheets === 1 ? '' : 's') + ' (8 cards per sheet)'
      : 'No students selected.';
    $('#cdPrint').disabled = !sel.length;
    $('#cdPdf').disabled = !sel.length;
    var box = $('#cardPreview');
    if (!sel.length) {
      box.innerHTML = '<p class="muted empty">Select one or more students to see the ID cards here.</p>';
      return;
    }
    if (sel.length > 60) {
      box.innerHTML = '<p class="muted empty">Preview shows the first 60 students. All ' + sel.length + ' selected students are included when you print or export.</p>' +
        sheetsHtml(sel.slice(0, 60), mode, true);
    } else {
      box.innerHTML = sheetsHtml(sel, mode, true);
    }
    fitPreview();
  }
  function fitPreview() {
    var box = $('#cardPreview');
    if (!box || !box.clientWidth) { return; }
    var z = Math.min(1, (box.clientWidth - 24) / (210 * 96 / 25.4));
    box.style.setProperty('--z', z.toFixed(4));
  }

  function printCards() {
    var sel = selectedStudents();
    if (!sel.length) { toast('Select at least one student.', 'warn'); return; }
    $('#printArea').innerHTML = sheetsHtml(sel, cardModeValue(), false);
    setTimeout(function () { window.print(); }, 250);
  }
  window.addEventListener('afterprint', function () { $('#printArea').innerHTML = ''; });

  function exportPdf() {
    var sel = selectedStudents();
    if (!sel.length) { toast('Select at least one student.', 'warn'); return; }
    if (!(window.jspdf && window.jspdf.jsPDF && window.html2canvas)) {
      toast('The PDF library could not be loaded (no internet?). The print window will open - choose "Save as PDF" as the printer.', 'warn');
      printCards();
      return;
    }
    busy(true, 'Creating PDF');
    var stage = $('#exportStage');
    stage.innerHTML = sheetsHtml(sel, cardModeValue(), false);
    var sheets = $$('.sheet', stage);
    var pdf = new window.jspdf.jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
    var i = 0;
    function next() {
      if (i >= sheets.length) {
        pdf.save('Student_ID_Cards_' + stamp() + '.pdf');
        finish();
        toast('PDF created.', 'success');
        return;
      }
      $('#busyText').textContent = 'Creating PDF - sheet ' + (i + 1) + ' of ' + sheets.length;
      window.html2canvas(sheets[i], { scale: 3, useCORS: true, backgroundColor: '#ffffff', logging: false }).then(function (canvas) {
        if (i > 0) { pdf.addPage(); }
        pdf.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, 210, 297, undefined, 'FAST');
        i++;
        setTimeout(next, 20);
      }).catch(function (err) {
        finish();
        toast('PDF could not be created: ' + (err && err.message ? err.message : 'unknown error') + '. Use Print and choose "Save as PDF".', 'error');
      });
    }
    function finish() { stage.innerHTML = ''; busy(false); }
    setTimeout(next, 150);
  }

  /* ===================================================================
     11. SETTINGS, BACKUP, SQL
     =================================================================== */
  function renderSettings() {
    var st = state.settings;
    $('#setSchool').value = st.schoolName || '';
    $('#setYear').value = st.academicYear || '';
    $('#setDirector').value = st.directorName || '';
    $('#setColor').value = st.cardColor || '#17508f';
    $('#setNotice').value = st.backNotice || '';
    [['logo', '#prevLogo'], ['stamp', '#prevStamp'], ['signature', '#prevSignature']].forEach(function (p) {
      var img = $(p[1]), box = img.parentNode;
      if (st[p[0]]) { img.src = st[p[0]]; box.classList.add('has'); } else { img.removeAttribute('src'); box.classList.remove('has'); }
    });
    $('#storageInfo').textContent = Store.ls
      ? 'Storage mode: browser local storage (limited size). Make regular backups.'
      : 'Storage mode: browser database (IndexedDB).';
  }
  function saveSettings() {
    var school = trim($('#setSchool').value);
    if (!school) { toast('Enter the school name.', 'error'); return; }
    var before = Object.assign({}, state.settings);
    state.settings.schoolName = school;
    state.settings.academicYear = trim($('#setYear').value);
    state.settings.directorName = trim($('#setDirector').value);
    state.settings.cardColor = $('#setColor').value || '#17508f';
    state.settings.backNotice = trim($('#setNotice').value);
    persist().then(function () {
      toast('Settings saved.', 'success'); renderBrand(); renderCardsPreview();
    }).catch(function (err) {
      state.settings = before;
      toast('Could not save settings: ' + (err && err.message ? err.message : 'storage error'), 'error');
    });
  }
  function setAsset(kind, file) {
    var opts = kind === 'logo' ? { max: 400 } : kind === 'stamp' ? { max: 500 } : { max: 600 };
    readImage(file, opts).then(function (data) {
      var old = state.settings[kind];
      state.settings[kind] = data;
      return persist().catch(function (err) { state.settings[kind] = old; throw err; });
    }).then(function () {
      toast('Saved.', 'success'); renderSettings(); renderBrand(); renderCardsPreview();
    }).catch(function (err) { toast(err.message || 'Could not save the image.', 'error'); });
  }
  function clearAsset(kind) {
    var old = state.settings[kind];
    state.settings[kind] = '';
    persist().then(function () { renderSettings(); renderBrand(); renderCardsPreview(); toast('Removed.', 'success'); })
      .catch(function () { state.settings[kind] = old; toast('Could not save the change.', 'error'); });
  }
  function changePassword() {
    var cur = $('#pwCurrent').value, nw = $('#pwNew').value, cf = $('#pwConfirm').value;
    if (hashPw(cur) !== getPassHash()) { toast('The current password is wrong.', 'error'); return; }
    if (nw.length < 4) { toast('The new password must have at least 4 characters.', 'error'); return; }
    if (nw !== cf) { toast('The new passwords do not match.', 'error'); return; }
    var old = state.settings.passHash;
    state.settings.passHash = hashPw(nw);
    persist().then(function () {
      $('#pwCurrent').value = ''; $('#pwNew').value = ''; $('#pwConfirm').value = '';
      toast('Password changed.', 'success');
    }).catch(function () { state.settings.passHash = old; toast('Could not save the new password.', 'error'); });
  }

  function backupData() {
    var settings = Object.assign({}, state.settings); delete settings.passHash;
    var payload = { app: 'dembi-dollo-student-id', version: 1, exportedAt: new Date().toISOString(), settings: settings, students: state.students };
    downloadBlob('student_id_backup_' + stamp() + '.json', JSON.stringify(payload), 'application/json');
    toast('Backup downloaded. Keep the file in a safe place.', 'success');
  }
  function restoreData(file) {
    if (!file) { return; }
    var fr = new FileReader();
    fr.onerror = function () { toast('The backup file could not be read.', 'error'); };
    fr.onload = function () {
      var data;
      try { data = JSON.parse(String(fr.result)); } catch (e) { toast('This is not a valid backup file.', 'error'); return; }
      if (!data || data.app !== 'dembi-dollo-student-id' || !Array.isArray(data.students)) { toast('This file is not a backup from this system.', 'error'); return; }
      var students = data.students.map(sanitizeStudent).filter(Boolean);
      confirmBox('Restore this backup?', 'It contains ' + students.length + ' students. Your current students and settings will be replaced.', 'Restore', true).then(function (yes) {
        if (!yes) { return; }
        var oldS = state.students, oldSet = state.settings;
        state.students = students;
        state.settings = Object.assign(defaultSettings(), data.settings || {}, { passHash: oldSet.passHash });
        persist().then(function () { selected.clear(); renderAll(); toast('Backup restored.', 'success'); })
          .catch(function (err) {
            state.students = oldS; state.settings = oldSet;
            toast('Restore failed: ' + (err && err.message ? err.message : 'storage error'), 'error');
          });
      });
    };
    fr.readAsText(file);
  }

  function exportSql() {
    var q = function (v) { return v === '' || v === null || v === undefined ? 'NULL' : "'" + String(v).replace(/'/g, "''") + "'"; };
    var out = '-- Dembi Dollo Education Office - Student ID System\n-- Export created ' + new Date().toISOString() + '\n\n' +
      'CREATE TABLE IF NOT EXISTS students (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  student_id TEXT NOT NULL UNIQUE CHECK (student_id LIKE \'STU-%\'),\n' +
      '  full_name TEXT NOT NULL,\n  gender TEXT NOT NULL CHECK (gender IN (\'Male\',\'Female\')),\n  date_of_birth TEXT,\n  grade INTEGER NOT NULL CHECK (grade BETWEEN 9 AND 12),\n' +
      '  section TEXT,\n  academic_year TEXT,\n  parent_name TEXT,\n  parent_phone TEXT,\n  address TEXT,\n  photo TEXT,\n  created_at TEXT,\n  updated_at TEXT\n);\n\nBEGIN TRANSACTION;\n';
    state.students.forEach(function (s) {
      out += 'INSERT INTO students (student_id, full_name, gender, date_of_birth, grade, section, academic_year, parent_name, parent_phone, address, photo, created_at, updated_at) VALUES (' +
        [q(s.studentId), q(s.fullName), q(s.gender), q(s.dob), parseInt(s.grade, 10) || 9, q(s.section), q(s.academicYear), q(s.parentName), q(s.phone), q(s.address), q(s.photo), q(s.createdAt), q(s.updatedAt)].join(', ') + ');\n';
    });
    out += 'COMMIT;\n';
    downloadBlob('students_export_' + stamp() + '.sql', out, 'text/plain;charset=utf-8');
    toast('SQL file downloaded.', 'success');
  }

  function deleteAllStudents() {
    passwordBox('Delete all students', 'This permanently removes all ' + state.students.length + ' student records. Type the admin password to continue.').then(function (ok) {
      if (!ok) { return; }
      var snapshot = state.students.slice();
      state.students = [];
      persistOrRollback(snapshot).then(function () { selected.clear(); renderAll(); toast('All students were deleted.', 'success'); }).catch(function () { /* shown */ });
    });
  }
  function eraseEverything() {
    passwordBox('Erase everything', 'This removes all students and resets all school settings, logo, stamp and signature. Type the admin password to continue.').then(function (ok) {
      if (!ok) { return; }
      var oldS = state.students, oldSet = state.settings;
      state.students = [];
      state.settings = Object.assign(defaultSettings(), { passHash: oldSet.passHash });
      persist().then(function () { selected.clear(); renderAll(); toast('Everything was erased.', 'success'); })
        .catch(function () { state.students = oldS; state.settings = oldSet; toast('Could not erase the data.', 'error'); });
    });
  }

  /* ===================================================================
     12. EVENTS AND START-UP
     =================================================================== */
  function bindEvents() {
    $('#loginForm').addEventListener('submit', handleLogin);
    $('#pwToggle').addEventListener('click', function () {
      var inp = $('#loginPass'), show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      this.textContent = show ? 'Hide' : 'Show';
    });
    $('#logoutBtn').addEventListener('click', logout);
    $('#menuBtn').addEventListener('click', function () { $('#sidebar').classList.toggle('open'); });

    document.addEventListener('click', function (e) {
      var t = e.target;
      if (t.hasAttribute && t.hasAttribute('data-backdrop') && t === e.target) { closeModal(); return; }
      var closer = t.closest ? t.closest('[data-close]') : null;
      if (closer) { closeModal(); return; }

      var nav = t.closest ? t.closest('.nav-item[data-view]') : null;
      if (nav) { go(nav.getAttribute('data-view')); return; }

      var goBtn = t.closest ? t.closest('[data-go]') : null;
      if (goBtn) {
        var wasModal = $('#modalRoot').innerHTML !== '';
        if (wasModal) { closeModal(true); }
        go(goBtn.getAttribute('data-go'));
        if (goBtn.getAttribute('data-new')) { openStudentForm(null); }
        return;
      }

      var act = t.closest ? t.closest('[data-action]') : null;
      if (act) {
        var id = act.getAttribute('data-id'), a = act.getAttribute('data-action');
        if (a === 'edit') { openStudentForm(id); }
        else if (a === 'delete') { deleteStudents([id]); }
        else if (a === 'card') { selected = new Set([id]); go('cards'); }
        return;
      }

      var pg = t.closest ? t.closest('[data-page]') : null;
      if (pg && !pg.disabled) { stPage += pg.getAttribute('data-page') === 'next' ? 1 : -1; renderStudents(); return; }

      var clr = t.closest ? t.closest('[data-asset-clear]') : null;
      if (clr) { clearAsset(clr.getAttribute('data-asset-clear')); return; }

      if (t.id === 'fPhotoClear') { formPhoto = ''; $('#fPhotoPrev').src = PLACEHOLDER_PHOTO; }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && $('#modalRoot').innerHTML !== '') { closeModal(); }
    });

    document.addEventListener('submit', function (e) {
      if (e.target && e.target.id === 'studentForm') { e.preventDefault(); handleStudentSubmit(e.target); }
    });

    document.addEventListener('change', function (e) {
      var t = e.target;
      if (t.id === 'fPhotoFile') {
        readImage(t.files[0], { cover: { w: 300, h: 375 }, quality: 0.85 }).then(function (data) {
          formPhoto = data; $('#fPhotoPrev').src = data; setFieldError('photo', '');
        }).catch(function (err) { setFieldError('photo', err.message); });
        t.value = '';
      }
      if (t.hasAttribute && t.hasAttribute('data-asset-input')) {
        setAsset(t.getAttribute('data-asset-input'), t.files[0]); t.value = '';
      }
    });

    /* Students page */
    ['#stSearch', '#stGrade', '#stGender', '#stSort'].forEach(function (sel) {
      $(sel).addEventListener(sel === '#stSearch' ? 'input' : 'change', function () { stPage = 1; renderStudents(); });
    });
    $('#addStudentBtn').addEventListener('click', function () { openStudentForm(null); });
    $('#stBody').addEventListener('change', function (e) {
      if (e.target.classList.contains('row-check')) {
        var id = e.target.getAttribute('data-id');
        if (e.target.checked) { selected.add(id); } else { selected.delete(id); }
        renderStudents();
      }
    });
    $('#stCheckAll').addEventListener('change', function () {
      var on = this.checked;
      filteredStudents().forEach(function (s) { if (on) { selected.add(s.id); } else { selected.delete(s.id); } });
      renderStudents();
    });
    $('#stDeleteSelBtn').addEventListener('click', function () {
      if (!selected.size) { toast('Select the students you want to delete first.', 'warn'); return; }
      deleteStudents(Array.from(selected));
    });
    $('#stCardsBtn').addEventListener('click', function () {
      if (!selected.size) { toast('Select the students first, or use the ID card link in a row.', 'warn'); return; }
      go('cards');
    });
    $('#stExportBtn').addEventListener('click', exportStudents);

    /* Import page */
    $('#tplBtn').addEventListener('click', downloadTemplate);
    $('#importFile').addEventListener('change', function () { handleImportFile(this.files[0]); });
    var dz = $('#dropzone');
    ['dragenter', 'dragover'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('drag'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('drag'); }); });
    dz.addEventListener('drop', function (e) { handleImportFile(e.dataTransfer && e.dataTransfer.files[0]); });
    $('#importUpdate').addEventListener('change', renderImportPreview);
    $('#importCommitBtn').addEventListener('click', commitImport);
    $('#importCancelBtn').addEventListener('click', function () { importRows = []; $('#importPreviewPanel').hidden = true; });

    /* ID cards page */
    $('#cdSearch').addEventListener('input', renderCardsView);
    $('#cdGrade').addEventListener('change', renderCardsView);
    $('#cdList').addEventListener('change', function (e) {
      var id = e.target.getAttribute('data-pick');
      if (!id) { return; }
      if (e.target.checked) { selected.add(id); } else { selected.delete(id); }
      renderCardsPreview();
    });
    $('#cdSelectAll').addEventListener('click', function () { cardsFilter().forEach(function (s) { selected.add(s.id); }); renderCardsView(); });
    $('#cdClear').addEventListener('click', function () { selected.clear(); renderCardsView(); });
    $$('input[name="cdMode"]').forEach(function (r) { r.addEventListener('change', renderCardsPreview); });
    $('#cdPrint').addEventListener('click', printCards);
    $('#cdPdf').addEventListener('click', exportPdf);
    window.addEventListener('resize', fitPreview);

    /* Settings page */
    $('#saveSettingsBtn').addEventListener('click', saveSettings);
    $('#changePwBtn').addEventListener('click', changePassword);
    $('#backupBtn').addEventListener('click', backupData);
    $('#restoreFile').addEventListener('change', function () { restoreData(this.files[0]); this.value = ''; });
    $('#sqlBtn').addEventListener('click', exportSql);
    $('#delAllStudentsBtn').addEventListener('click', deleteAllStudents);
    $('#resetAllBtn').addEventListener('click', eraseEverything);
  }

  function init() {
    bindEvents();
    Store.open().then(loadState).then(function () {
      if (navigator.storage && navigator.storage.persist) { navigator.storage.persist().catch(function () { /* ignore */ }); }
      if (isLoggedIn()) { showApp(); } else { showLogin(); }
    }).catch(function (err) {
      showLogin();
      loginError('The local database could not be opened: ' + (err && err.message ? err.message : 'unknown error') + '. Try another browser.');
    });
  }

  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }
})();
