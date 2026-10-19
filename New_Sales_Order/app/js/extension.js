/* Zoho Books – New Sales Order widget
 * Uses ZFAPPS.extension.init(), ZFAPPS.get('organization'), ZFAPPS.request() and ZFAPPS.closeModal().
 * No tokens or credentials live in this file: every call goes through the Zoho connection below.
 */
console.log('%c[SOWidget] file loaded', 'color:#1d8a4e;font-weight:bold');

(function () {
  'use strict';

  /* ================= CONFIG ================= */
  var CONFIG = {
    debug: true,
    connectionLinkName: 'bookconnectionwigdet',
    apiRootOverride: '',
    modalWidth: '',
    modalHeight: '',
    searchDebounceMs: 300,
    searchPageSize: 25,
    maxQtyDecimals: 4,
    autoCloseMs: 2500,
    customerCacheTtlMs: 24 * 60 * 60 * 1000, // IndexedDB customer list is re-synced in the background after this age
    gstMode: 'auto',        // 'auto' (India org detection) | 'on' | 'off' - controls GST fields in New Customer / New Item
    phoneWithCode: true,    // send phone numbers as "+91 9999999999"; false sends the number only
    customFieldOverrides: []
  };

  /* ================= STATE ================= */
  var S = {
    root: '', orgId: '',
    currencies: [], baseCurrency: null, currency: null,
    taxes: [], taxMap: {},
    locations: [], salespersons: [], pricebooks: [], pricebook: null,
    tags: [], cfDefs: [],
    customer: null, contact: null,
    rows: [], nextRowId: 1,
    touched: { payTerms: false, priceList: false },
    addrDirty: { b: false, s: false },
    org: null,
    cust: { list: [], state: 'idle', count: 0, error: '', refreshing: false, syncedAt: 0 },
    submitting: false, submitted: false, uncertain: false,
    lastPayload: null, lastTotal: 0, closeTimer: null
  };

  var ADDR_FIELDS = [
    ['attention', 'Attention'], ['address', 'Street 1'], ['street2', 'Street 2'],
    ['city', 'City'], ['state', 'State'], ['zip', 'ZIP / PIN code'], ['country', 'Country']
  ];
  /* Names of the "special" custom fields shown inline in Order Details.
   They are matched by their Zoho Books custom-field label and sent via custom_fields[]. */
var NAMED_CF = [
  { slot: 'saleName',     label: 'Sale Name' },
  { slot: 'saleCode',     label: 'Sale Code' },
  { slot: 'salePhone',    label: 'Sale Phone' },
  { slot: 'taskOrder',    label: 'Task Order' },
  { slot: 'clientPO',     label: 'Client PO Number' },
  { slot: 'contractSig',  label: 'Contract Signature Status' },
  { slot: 'origDelivery', label: 'Original Client Delivery Date' }
];

function _normLabel(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function cfDefByLabel(label) {
  var L = _normLabel(label);
  for (var i = 0; i < S.cfDefs.length; i++) {
    if (_normLabel(S.cfDefs[i].label) === L) return S.cfDefs[i];
  }
  return null;
}

  /* ================= SMALL HELPERS ================= */
  function $(id) { return document.getElementById(id); }

  function mk(tag, props, parent) {
    var e = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        if (k === 'text') e.textContent = props[k];
        else if (k === 'class') e.className = props[k];
        else e[k] = props[k];
      });
    }
    if (parent) parent.appendChild(e);
    return e;
  }

  function round(v, p) {
    var f = Math.pow(10, p);
    return Math.round((Number(v) + Number.EPSILON) * f) / f;
  }

  function decimals(str) {
    var i = String(str).indexOf('.');
    return i < 0 ? 0 : String(str).length - i - 1;
  }

  function toNum(s) {
    s = String(s == null ? '' : s).trim();
    if (s === '' || !/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return NaN;
    return parseFloat(s);
  }

  function precision() {
    return (S.currency && S.currency.price_precision != null) ? Number(S.currency.price_precision) : 2;
  }

  function money(v) { return Number(v || 0).toFixed(precision()); }

  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }

  function validISODate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var d = new Date(s + 'T00:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }

  function tryParse(s) {
    if (s && typeof s === 'object') return s;
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  function errText(e) {
    if (!e) return 'Unknown error';
    if (typeof e === 'string') return e;
    return e.message || (e.data && typeof e.data.body === 'string' ? e.data.body : '') || 'Request failed';
  }

  function mkErr(kind, msg, uncertain, json) {
    var e = new Error(msg);
    e.kind = kind;
    e.uncertain = !!uncertain;
    e.json = json || null;
    return e;
  }

  /* ================= PURE CALCULATIONS ================= */
  function parseDiscount(str, base) {
    var s = String(str == null ? '' : str).trim();
    if (s === '') return { ok: true, amount: 0, isPct: false, value: 0, text: '' };
    var m = /^(\d+(?:\.\d+)?)\s*(%?)$/.exec(s);
    if (!m) return { ok: false, msg: 'Enter a number or a percentage, e.g. 10 or 10%' };
    var v = parseFloat(m[1]);
    if (m[2] === '%') {
      if (v > 100) return { ok: false, msg: 'Percentage cannot exceed 100%' };
      return { ok: true, amount: (base || 0) * v / 100, isPct: true, value: v, text: v + '%' };
    }
    if (v > (base || 0) + 1e-9) return { ok: false, msg: 'Discount cannot exceed the amount it applies to' };
    return { ok: true, amount: v, isPct: false, value: v, text: String(v) };
  }

  function discRate(base, discText, dp) {
    var d = parseDiscount(discText, base);
    return d.ok && d.isPct ? round(base - d.amount, dp) : base;
  }

  function priceListRate(item, qty, pb, dp) {
    var base = Number(item.rate);
    if (!pb) return base;
    var dpp = pb.decimal_place != null ? Number(pb.decimal_place) : dp;

    if (pb.pricebook_type === 'per_item') {
      var pi = (pb.pricebook_items || []).filter(function (x) { return String(x.item_id) === String(item.item_id); })[0];
      if (!pi) return base;
      if (pi.pricing_scheme === 'volume' && pi.price_brackets && pi.price_brackets.length) {
        var br = pi.price_brackets.filter(function (b) {
          return qty >= Number(b.start_quantity) && (!Number(b.end_quantity) || qty <= Number(b.end_quantity));
        })[0];
        if (!br) return base;
        if (br.pricebook_rate != null && br.pricebook_rate !== '') return round(Number(br.pricebook_rate), dpp);
        return discRate(base, br.pricebook_discount, dpp);
      }
      if (pi.pricebook_rate != null && pi.pricebook_rate !== '') return round(Number(pi.pricebook_rate), dpp);
      return discRate(base, pi.pricebook_discount, dpp);
    }

    if (pb.pricebook_type === 'fixed_percentage' && pb.percentage != null) {
      var pct = Number(pb.percentage);
      return round(base * (pb.is_increase ? 1 + pct / 100 : 1 - pct / 100), dpp);
    }
    return base;
  }

  function computeTotals(lines, c) {
    var p = c.precision;
    var out = { lines: [], subTotal: 0, discountTotal: 0, taxes: {}, taxTotal: 0, total: 0 };
    var nets = [], bases = [];

    lines.forEach(function (l) {
      if (!(l.qty > 0) || !isFinite(l.rate)) {
        out.lines.push({ amount: 0 });
        nets.push(0);
        bases.push({ base: 0, pct: 0, id: l.taxId });
        return;
      }
      var gross = l.qty * l.rate;
      var d = c.level === 'item_level' ? parseDiscount(l.discount, gross) : { ok: true, amount: 0 };
      var itemDisc = d.ok ? d.amount : 0;
      var net = gross - itemDisc;
      var pct = l.taxPct || 0;
      var base = c.inclusive ? net / (1 + pct / 100) : net;
      out.lines.push({ amount: round(net, p) });
      nets.push(net);
      bases.push({ base: base, pct: pct, id: l.taxId });
      out.discountTotal += itemDisc;
    });

    var subTotal = nets.reduce(function (a, b) { return a + b; }, 0);
    var entD = 0;
    if (c.level === 'entity_level') {
      var d2 = parseDiscount(c.entityDiscount, subTotal);
      entD = d2.ok ? d2.amount : 0;
    }
    var ratio = (c.beforeTax && subTotal > 0) ? entD / subTotal : 0;
    var sumBase = 0, taxTotal = 0;

    bases.forEach(function (b) {
      var rb = b.base * (1 - ratio);
      var t = rb * b.pct / 100;
      sumBase += rb;
      taxTotal += t;
      if (b.id && t) out.taxes[b.id] = (out.taxes[b.id] || 0) + t;
    });

    out.discountTotal += entD;
    var total = sumBase + taxTotal - (c.beforeTax ? 0 : entD) + (c.shipping || 0) + (c.adjustment || 0);
    out.subTotal = round(subTotal, p);
    out.discountTotal = round(out.discountTotal, p);
    out.taxTotal = round(taxTotal, p);
    Object.keys(out.taxes).forEach(function (k) { out.taxes[k] = round(out.taxes[k], p); });
    out.total = round(total, p);
    return out;
  }

  /* ================= ZOHO API LAYER ================= */
  function api(method, path, query, body) {
    var q = [{ key: 'organization_id', value: S.orgId }];
    Object.keys(query || {}).forEach(function (k) {
      if (query[k] !== undefined && query[k] !== null && query[k] !== '') q.push({ key: k, value: String(query[k]) });
    });
    var opts = {
      url: S.root + path, method: method, url_query: q,
      connection_link_name: CONFIG.connectionLinkName
    };
    if (body) {
      opts.header = [{ key: 'Content-Type', value: 'application/json' }];
      opts.body = { mode: 'raw', raw: JSON.stringify(body) };
    }

    var label = method + ' ' + path;
    var t0 = Date.now();
    if (CONFIG.debug) {
      console.groupCollapsed('%c[API →] ' + label, 'color:#2a62d6');
      console.log('URL:', opts.url);
      console.log('Query:', q);
      if (body) console.log('Request body:', body);
      console.groupEnd();
    }

    return ZFAPPS.request(opts).then(function (v) {
      var raw = v && v.data && v.data.body;
      var json = tryParse(raw);
      if (CONFIG.debug) {
        console.groupCollapsed('%c[API ←] ' + label + ' (' + (Date.now() - t0) + ' ms)', 'color:#1d8a4e');
        console.log('Full SDK response:', v);
        console.log('Parsed JSON body:', json);
        if (!json) console.log('Raw body (unparsed):', raw);
        console.groupEnd();
      }
      if (!json) throw mkErr('unreadable', 'Zoho Books returned an unreadable or empty response.', true);
      if (json.code !== undefined && Number(json.code) !== 0) {
        throw mkErr('api', json.message || ('Zoho Books error code ' + json.code), false, json);
      }
      return json;
    }, function (err) {
      if (CONFIG.debug) {
        console.groupCollapsed('%c[API ✖] ' + label + ' (' + (Date.now() - t0) + ' ms)', 'color:#c0352b');
        console.log('Error object:', err);
        console.log('Error body:', err && err.data && err.data.body);
        console.groupEnd();
      }
      var j = tryParse(err && err.data && err.data.body);
      if (j && j.code !== undefined && Number(j.code) !== 0) {
        throw mkErr('api', j.message || ('Zoho Books error code ' + j.code), false, j);
      }
      throw mkErr('network', errText(err), true);
    });
  }

  function deriveRoot(org) {
    var root = CONFIG.apiRootOverride || (org && org.api_root_endpoint) || '';
    if (root) {
      root = String(root).replace(/\/+$/, '');
      return /\/books\/v3$/.test(root) ? root : root + '/books/v3';
    }
    var hosts = [];
    try {
      if (window.location.ancestorOrigins) {
        for (var i = 0; i < window.location.ancestorOrigins.length; i++) {
          hosts.push(new URL(window.location.ancestorOrigins[i]).hostname);
        }
      }
    } catch (e) { /* ignore */ }
    try { if (document.referrer) hosts.push(new URL(document.referrer).hostname); } catch (e2) { /* ignore */ }
    for (var j = 0; j < hosts.length; j++) {
      var m = /(?:^|\.)zoho\.([a-z.]+)$/.exec(hosts[j]);
      if (m) return 'https://www.zohoapis.' + m[1] + '/books/v3';
    }
    return '';
  }

  function firstArray(json, key) {
    return Array.isArray(json[key]) ? json[key] : [];
  }

  /* ================= REFERENCE DATA ================= */
  function loadCurrencies() {
    return api('GET', '/settings/currencies').then(function (j) {
      S.currencies = firstArray(j, 'currencies');
      S.baseCurrency = S.currencies.filter(function (c) { return c.is_base_currency; })[0] || S.currencies[0] || null;
      S.currency = S.baseCurrency;
      if (!S.currency) throw mkErr('data', 'No currencies were returned by Zoho Books.');
    });
  }

  function loadTaxes() {
    return api('GET', '/settings/taxes').then(function (j) {
      S.taxes = firstArray(j, 'taxes').filter(function (t) { return t.status !== 'inactive' && t.is_inactive !== true; });
      S.taxMap = {};
      S.taxes.forEach(function (t) { S.taxMap[String(t.tax_id)] = t; });
    });
  }

  function loadLocations() {
    return api('GET', '/locations').then(function (j) {
      S.locations = firstArray(j, 'locations').filter(function (l) { return l.status !== 'inactive' && l.is_active !== false; });
    });
  }

  function loadPricebooks() {
    return api('GET', '/pricebooks', { filter_by: 'SalesOrPurchaseType.Sales', per_page: 200 }).then(function (j) {
      S.pricebooks = firstArray(j, 'pricebooks').filter(function (p) {
        return (p.status || 'active') === 'active' && (!p.sales_or_purchase_type || p.sales_or_purchase_type === 'sales');
      });
    });
  }

  function loadSalespersons() {
    return api('GET', '/salespersons', { per_page: 200 }).then(function (j) {
      S.salespersons = firstArray(j, 'salespersons');
    });
  }

  function loadTags() {
    return api('GET', '/reportingtags').then(function (j) {
      var tags = firstArray(j, 'reporting_tags').filter(function (t) { return t.is_active !== false && !t.is_draft; });
      return Promise.all(tags.map(function (t) {
        return api('GET', '/reportingtags/' + t.tag_id + '/options/all').then(function (r) {
          var opts = null;
          Object.keys(r).forEach(function (k) {
            if (!opts && Array.isArray(r[k]) && r[k].length && r[k][0] && r[k][0].tag_option_id !== undefined) opts = r[k];
          });
          t.options = (opts || []).filter(function (o) { return o.is_active !== false; });
        }).catch(function () { t.options = []; });
      })).then(function () {
        S.tags = tags.filter(function (t) { return t.options.length; });
      });
    });
  }

  // Zoho has no custom-field definitions endpoint, so definitions are read from the newest sales order.
  function loadCustomFieldDefs() {
    var defs = {};
    CONFIG.customFieldOverrides.forEach(function (d) { defs[String(d.customfield_id)] = d; });
    return api('GET', '/salesorders', { per_page: 1, sort_column: 'created_time', sort_order: 'D' }).then(function (j) {
      var first = firstArray(j, 'salesorders')[0];
      if (!first) return;
      return api('GET', '/salesorders/' + first.salesorder_id).then(function (r) {
        ((r.salesorder && r.salesorder.custom_fields) || []).forEach(function (cf) {
          if (cf.customfield_id === undefined) return;
          var id = String(cf.customfield_id);
          defs[id] = Object.assign({ customfield_id: id, label: cf.label, data_type: cf.data_type }, defs[id] || {});
        });
      });
    }).catch(function () { /* optional */ }).then(function () {
      S.cfDefs = Object.keys(defs).map(function (k) { return defs[k]; });
    });
  }

  /* ================= GENERIC LOOKUP COMBO (item search) ================= */
  var comboEl, comboOwner = null;

  function hideCombo() {
    comboEl.hidden = true;
    comboOwner = null;
  }

  function attachCombo(input, o) {
    var timer = null, token = 0, active = -1, items = [];

    function position() {
      var r = input.getBoundingClientRect();
      var minW = Math.max(r.width, 300);
      var left = r.left;
      if (left + minW > window.innerWidth - 8) left = Math.max(8, window.innerWidth - minW - 8);
      comboEl.style.left = left + 'px';
      comboEl.style.top = (r.bottom + 2) + 'px';
      comboEl.style.minWidth = minW + 'px';
    }

    function paintActive() {
      Array.prototype.forEach.call(comboEl.querySelectorAll('.opt'), function (n, i) {
        n.classList.toggle('active', i === active);
      });
    }

    function renderFooter() {
      if (!o.newLabel || !o.onNew) return;
      var footer = mk('div', { class: 'combo-new' }, comboEl);
      var btn = mk('button', { type: 'button', class: 'combo-new-btn' }, footer);
      mk('span', { class: 'plus', text: '+' }, btn);
      mk('span', { text: o.newLabel.replace(/^\+\s*/, '') }, btn);
      btn.addEventListener('mousedown', function (ev) {
        ev.preventDefault();
        hideCombo();
        o.onNew();
      });
    }

    function show(msg) {
      comboOwner = input;
      position();
      comboEl.innerHTML = '';
      comboEl.hidden = false;
      if (msg) {
        mk('div', { class: 'msg', text: msg }, comboEl);
        renderFooter();
        return;
      }
      items.forEach(function (it, i) {
        var d = mk('div', { class: 'opt' }, comboEl);
        d.setAttribute('role', 'option');
        mk('span', { text: o.label(it) }, d);
        var sub = o.sub ? o.sub(it) : '';
        if (sub) mk('small', { text: sub }, d);
        d.addEventListener('mousedown', function (ev) { ev.preventDefault(); choose(i); });
      });
      renderFooter();
    }

    function choose(i) {
      var it = items[i];
      if (!it) return;
      input.value = o.label(it);
      hideCombo();
      o.onSelect(it);
    }

    function run() {
      var my = ++token;
      show('Searching…');
      o.fetch(input.value.trim()).then(function (list) {
        if (my !== token || comboOwner !== input) return;
        items = list || [];
        active = items.length ? 0 : -1;
        if (!items.length) show('No matches found');
        else { show(); paintActive(); }
      }, function (e) {
        if (my !== token || comboOwner !== input) return;
        show('Could not load results: ' + errText(e));
      });
    }

    input.addEventListener('input', function () {
      if (o.onEdit) o.onEdit();
      clearTimeout(timer);
      timer = setTimeout(run, CONFIG.searchDebounceMs);
    });
    input.addEventListener('focus', function () { if (!o.isSelected()) run(); });
    input.addEventListener('keydown', function (ev) {
      if (comboEl.hidden || comboOwner !== input) return;
      if (ev.key === 'ArrowDown') { ev.preventDefault(); active = Math.min(items.length - 1, active + 1); paintActive(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); active = Math.max(0, active - 1); paintActive(); }
      else if (ev.key === 'Enter') { ev.preventDefault(); if (active >= 0) choose(active); }
      else if (ev.key === 'Escape' || ev.key === 'Tab') hideCombo();
    });
  }

  /* ================= FIELD VALIDATION UI ================= */
  function mark(el, msg) {
    if (!el) return;
    el.classList.toggle('invalid', !!msg);
    var holder = el.closest('.field, .nc-c, .nc-a') || el.parentNode;
    var fe = holder.querySelector(':scope > .fe');
    if (msg) {
      if (!fe) { fe = mk('div', { class: 'fe' }); holder.appendChild(fe); }
      fe.textContent = msg;
    } else if (fe) {
      fe.remove();
    }
  }

  var FV = {
    customer: function () {
      if (!S.customer || !S.contact) return 'Select a customer from the list';
      if (S.contact.status && S.contact.status !== 'active') return 'This customer is inactive';
      return '';
    },
    location: function () {
      if (!S.locations.length) return '';
      var v = $('location').value;
      return S.locations.some(function (l) { return String(l.location_id) === v; }) ? '' : 'Select a location';
    },
    soDate: function () {
      var v = $('soDate').value;
      if (!v) return 'Sales order date is required';
      return validISODate(v) ? '' : 'Enter a valid date';
    },
    shipDate: function () {
      var v = $('shipDate').value;
      if (!v) return '';
      if (!validISODate(v)) return 'Enter a valid date';
      var d = $('soDate').value;
      return (validISODate(d) && v < d) ? 'Shipment date cannot be before the order date' : '';
    },
    payTerms: function () {
      var s = $('payTerms').value.trim();
      if (s === '') return '';
      if (!/^-?\d+$/.test(s)) return 'Enter whole days, e.g. 30';
      var n = parseInt(s, 10);
      if (n < 0 && !(S.contact && Number(S.contact.payment_terms) === n)) return 'Days cannot be negative';
      return '';
    },
    exchRate: function () {
      if ($('exchWrap').hidden) return '';
      var n = toNum($('exchRate').value);
      return (isFinite(n) && n > 0) ? '' : 'Enter an exchange rate greater than 0';
    },
    shipping: function () {
      var s = $('shipping').value.trim();
      if (s === '') return '';
      var n = toNum(s);
      if (!isFinite(n) || n < 0) return 'Enter 0 or a positive amount';
      return decimals(s) > precision() ? 'Maximum ' + precision() + ' decimal places' : '';
    },
    adjustment: function () {
      var s = $('adjustment').value.trim();
      if (s === '') return '';
      var n = toNum(s);
      if (!isFinite(n)) return 'Enter a number';
      return decimals(s) > precision() ? 'Maximum ' + precision() + ' decimal places' : '';
    },
    entityDisc: function () {
      if ($('discLevel').value !== 'entity_level') return '';
      var sub = currentTotals().subTotal;
      var d = parseDiscount($('entityDisc').value, sub);
      return d.ok ? '' : d.msg;
    }
  };

  var FV_EL = {
    customer: 'customer', location: 'location', soDate: 'soDate', shipDate: 'shipDate', payTerms: 'payTerms',
    exchRate: 'exchRate', shipping: 'shipping', adjustment: 'adjustment', entityDisc: 'entityDisc'
  };

  function checkField(key) {
    var m = FV[key]();
    mark($(FV_EL[key]), m);
    return m;
  }

  function updateSourceHint() {
    var h = $('sourceHint');
    if (!h) return;
    var sel = $('location');
    if (!sel) return;
    var loc = S.locations.filter(function (l) { return String(l.location_id) === sel.value; })[0];
    h.textContent = (loc && (loc.state || loc.state_code))
      ? 'Source of Supply: ' + (loc.state || loc.state_code)
      : '';
  }

  /* ================= ITEM ROWS ================= */
  function taxOptions(sel, selected) {
    sel.innerHTML = '';
    mk('option', { value: '', text: 'No tax' }, sel);
    S.taxes.forEach(function (t) {
      mk('option', { value: String(t.tax_id), text: t.tax_name + ' [' + t.tax_percentage + '%]' }, sel);
    });
    sel.value = selected || '';
  }

  function isPristine(r) {
    return !r.item && !r.refs.item.value.trim() && !r.refs.desc.value.trim() && !r.refs.rate.value.trim() &&
      !r.refs.disc.value.trim() && r.refs.qty.value.trim() === '1';
  }

  function addRow() {
    var row = { id: S.nextRowId++, item: null, rateTouched: false, refs: {}, tags: {} };
    var tb = mk('tbody', { class: 'row' });
    var tr = mk('tr', { class: 'item-row' }, tb);
    var R = row.refs;
  
    /* 1. Drag handle (holds hidden row number) */
    var tdDrag = mk('td', { class: 'c-drag' }, tr);
    R.n = mk('span', { class: 'row-n', text: '' }, tdDrag);
  
    /* 2. Image placeholder */
    var tdImg = mk('td', { class: 'c-img' }, tr);
    mk('span', { class: 'item-img' }, tdImg);
  
    /* 3. Item details */
    var tdI = mk('td', { class: 'c-item' }, tr);
    R.item = mk('input', {
      type: 'text', placeholder: 'Type or click to select an item.',
      autocomplete: 'off', class: 'item-inp'
    }, tdI);
    R.desc = mk('textarea', { placeholder: 'Description (optional)', rows: 1 }, tdI);
    R.err = mk('div', { class: 'row-err' }, tdI);
  
    /* 4. Brand chip (Sub-brand removed from UI, stub kept hidden) */
    var tdB = mk('td', { class: 'c-brand' }, tr);
    var chipB = mk('div', { class: 'chip', 'data-empty': '1' }, tdB);
    R.brand = mk('span', { class: 'chip-t' }, chipB);
    mk('button', { type: 'button', class: 'chip-x', tabindex: '-1', innerHTML: '&times;' }, chipB);
    mk('span', { class: 'chip-chev' }, tdB);
    R.sub = mk('span', { hidden: true });   // stub – no longer in table
  
    /* 5. Quantity */
    var tdQ = mk('td', { class: 'c-num' }, tr);
    R.qty = mk('input', { type: 'text', inputMode: 'decimal', value: '1', class: 'cell-inp' }, tdQ);
  
    /* 6. Rate */
    var tdR = mk('td', { class: 'c-num' }, tr);
    R.rate = mk('input', { type: 'text', inputMode: 'decimal', placeholder: '0.00', class: 'cell-inp' }, tdR);
  
    /* 7. Discount (input + % suffix) */
    var tdD = mk('td', { class: 'c-disc' }, tr);
    var discW = mk('div', { class: 'disc-w' }, tdD);
    R.disc = mk('input', { type: 'text', inputMode: 'decimal', placeholder: '0', class: 'disc-inp' }, discW);
    var pct = mk('span', { class: 'disc-pct', title: 'Amount or percentage' }, discW);
    mk('span', { class: 'pct-t', text: '%' }, pct);
    mk('span', { class: 'pct-c', text: '▾' }, pct);
  
    /* 8. Tax select */
    var tdT = mk('td', { class: 'c-tax' }, tr);
    R.tax = mk('select', { class: 'cell-sel' }, tdT);
    taxOptions(R.tax, '');
  
    /* 9. Amount */
    R.amt = mk('td', { class: 'c-amt', text: money(0) }, tr);
  
    /* 10. Delete */
    var tdX = mk('td', { class: 'c-x' }, tr);
    R.del = mk('button', { type: 'button', class: 'row-del', title: 'Remove row', innerHTML: '&times;' }, tdX);
  
    /* Reporting tags subrow — colspan now 10 */
    if (S.tags.length) {
      var sr = mk('tr', { class: 'subrow' }, tb);
      var sc = mk('td', { colSpan: 10 }, sr);
      var wrap = mk('div', { class: 'tags' }, sc);
      S.tags.forEach(function (t) {
        var lab = mk('label', { text: t.tag_name }, wrap);
        var sel = mk('select', {}, lab);
        mk('option', { value: '', text: '— none —' }, sel);
        t.options.forEach(function (op) {
          mk('option', { value: String(op.tag_option_id), text: op.tag_option_name || op.option_name || op.tag_option_id }, sel);
        });
        sel.addEventListener('change', function () { row.tags[t.tag_id] = sel.value; });
      });
    }
  
    row.el = tb;
    S.rows.push(row);
    $('items').appendChild(tb);
    renumber();
  
    attachCombo(R.item, {
      fetch: function (q) {
        return api('GET', '/items', { search_text: q, filter_by: 'Status.Active', per_page: CONFIG.searchPageSize })
          .then(function (j) { return firstArray(j, 'items'); });
      },
      label: function (it) { return it.name; },
      sub: function (it) {
        var sym = (S.currency && S.currency.currency_symbol) || '';
        return [it.sku ? 'SKU ' + it.sku : '', 'Rate: ' + sym + Number(it.rate || 0).toFixed(precision())].filter(Boolean).join(' · ');
      },
      newLabel: 'Add New Item',
      onNew: function () { openItemModal(row); },
      isSelected: function () { return !!row.item; },
      onEdit: function () {
        if (row.item) {
          row.item = null;
          R.brand.textContent = '';
          R.brand.parentNode.dataset.empty = '1';
        }
      },
      onSelect: function (it) { selectItem(row, it); }
    });
  
    R.qty.addEventListener('input', function () { refreshRate(row); onRowChange(row); });
    R.rate.addEventListener('input', function () { row.rateTouched = true; onRowChange(row); });
    R.disc.addEventListener('input', function () { onRowChange(row); });
    R.tax.addEventListener('change', function () { onRowChange(row); });
    R.desc.addEventListener('input', function () { clearRowErr(row); });
    [R.qty, R.rate, R.disc, R.tax, R.item].forEach(function (e) {
      e.addEventListener('blur', function () { validateRow(row); });
    });
    R.del.addEventListener('click', function () { removeRow(row); });
    return row;
  }
  function renumber() {
    S.rows.forEach(function (r, i) { r.refs.n.textContent = String(i + 1); });
    S.rows.forEach(function (r) { r.refs.del.disabled = S.rows.length === 1; });
  }

  function removeRow(row) {
    if (S.rows.length === 1) return;
    S.rows = S.rows.filter(function (r) { return r !== row; });
    row.el.remove();
    renumber();
    recalc();
  }

  function clearRowErr(row) { row.refs.err.textContent = ''; }

  function selectItem(row, it) {
    var R = row.refs;
    R.item.disabled = true;
    R.err.textContent = 'Loading item…';
    api('GET', '/items/' + it.item_id).then(function (j) {
      var item = j.item || it;
      if (item.status && item.status !== 'active') throw mkErr('data', 'This item is inactive.');
      row.item = item;
      R.item.value = item.name;
      if (!R.desc.value.trim()) R.desc.value = item.description || '';

      var brand = item.brand || '';
      (item.custom_fields || []).forEach(function (cf) {
        var label = String(cf.label || cf.placeholder || '').toLowerCase();
        if (!brand && /^brand$|^item[\s_-]*brand/.test(label)) brand = cf.value || '';
      });
      R.brand.textContent = brand || '';
      R.brand.parentNode.dataset.empty = brand ? '0' : '1';


      var taxId = item.tax_id != null ? String(item.tax_id) : '';
      if (taxId && !S.taxMap[taxId]) {
        taxId = '';
        R.err.textContent = 'The item\'s default tax is not available – choose a tax.';
      } else {
        R.err.textContent = '';
      }
      R.tax.value = taxId;
      row.rateTouched = false;
      refreshRate(row, true);
      onRowChange(row);
    }).catch(function (e) {
      row.item = null;
      R.item.value = '';
      R.err.textContent = 'Could not load item: ' + errText(e);
    }).then(function () { R.item.disabled = false; });
  }

  function refreshRate(row, force) {
    if (!row.item || (row.rateTouched && !force)) return;
    var qty = toNum(row.refs.qty.value);
    var r = priceListRate(row.item, isFinite(qty) && qty > 0 ? qty : 1, S.pricebook, precision());
    if (isFinite(r)) row.refs.rate.value = String(r);
  }

  function onRowChange(row) {
    clearRowErr(row);
    [row.refs.qty, row.refs.rate, row.refs.disc, row.refs.item, row.refs.tax].forEach(function (e) { e.classList.remove('invalid'); });
    recalc();
  }

  function validateRow(row, strict) {
    var R = row.refs, msgs = [];
    var idx = S.rows.indexOf(row) + 1;
    if (isPristine(row)) return msgs;

    var errs = [];
    var bad = function (el, m) { el.classList.add('invalid'); errs.push(m); };
    ['item', 'qty', 'rate', 'disc', 'tax'].forEach(function (k) { R[k].classList.remove('invalid'); });

    if (!row.item) bad(R.item, 'select an item from the list');

    var q = toNum(R.qty.value);
    if (!isFinite(q) || q <= 0) bad(R.qty, 'quantity must be greater than 0');
    else if (decimals(R.qty.value.trim()) > CONFIG.maxQtyDecimals) bad(R.qty, 'quantity allows at most ' + CONFIG.maxQtyDecimals + ' decimals');

    var r = toNum(R.rate.value);
    if (!isFinite(r) || r < 0) bad(R.rate, 'enter a valid rate (0 or more)');
    else if (decimals(R.rate.value.trim()) > precision()) bad(R.rate, 'rate allows at most ' + precision() + ' decimals');

    if (S.currency && R.tax.value && !S.taxMap[R.tax.value]) bad(R.tax, 'tax is not available');

    if (isFinite(q) && q > 0 && isFinite(r) && r >= 0 && $('discLevel').value === 'item_level') {
      var d = parseDiscount(R.disc.value, q * r);
      if (!d.ok) bad(R.disc, d.msg);
    }

    if (errs.length) {
      R.err.textContent = 'Row ' + idx + ': ' + errs.join('; ');
      msgs = errs.map(function (m) { return 'Row ' + idx + ': ' + m; });
    } else if (!/^Could not|not available/.test(R.err.textContent)) {
      R.err.textContent = '';
    }
    return msgs;
  }

  /* ================= TOTALS ================= */
  function currentLines() {
    return S.rows.map(function (row) {
      var R = row.refs, t = S.taxMap[R.tax.value];
      return {
        qty: toNum(R.qty.value), rate: toNum(R.rate.value), discount: R.disc.value,
        taxId: R.tax.value, taxPct: t ? Number(t.tax_percentage) : 0, row: row
      };
    }).filter(function (l) { return !isPristine(l.row); });
  }

  function currentTotals() {
    var ship = toNum($('shipping').value), adj = toNum($('adjustment').value);
    return computeTotals(currentLines(), {
      precision: precision(), level: $('discLevel').value, entityDiscount: $('entityDisc').value,
      beforeTax: $('beforeTax').checked, inclusive: $('inclusive').checked,
      shipping: isFinite(ship) ? ship : 0, adjustment: isFinite(adj) ? adj : 0
    });
  }

  function recalc() {
    var t = currentTotals();
    var idx = 0;
    S.rows.forEach(function (row) {
      row.refs.amt.textContent = isPristine(row) ? money(0) : money(t.lines[idx++].amount);
    });
    $('tSub').textContent = money(t.subTotal);
    $('tDiscRow').hidden = !(t.discountTotal > 0);
    $('tDisc').textContent = '-' + money(t.discountTotal);

    var box = $('tTaxes');
    box.innerHTML = '';
    Object.keys(t.taxes).forEach(function (id) {
      var tx = S.taxMap[id];
      var r = mk('div', { class: 't-row' }, box);
      mk('span', { text: tx ? tx.tax_name + ' (' + tx.tax_percentage + '%)' : 'Tax' }, r);
      mk('b', { text: money(t.taxes[id]) }, r);
    });
    $('tTotal').textContent = money(t.total);
    $('tCur').textContent = S.currency ? S.currency.currency_code : '';
    S.lastTotal = t.total;
  }

  /* ================= CUSTOMER / DEPENDENT FIELDS ================= */
  function setCurrency(cur) {
    var changed = S.currency && cur && String(S.currency.currency_id) !== String(cur.currency_id);
    S.currency = cur || S.baseCurrency;
    $('currencyText').value = S.currency
      ? S.currency.currency_code + (S.currency.currency_symbol ? ' (' + S.currency.currency_symbol + ')' : '')
      : '';
    var foreign = S.currency && S.baseCurrency && String(S.currency.currency_id) !== String(S.baseCurrency.currency_id);
    $('exchWrap').hidden = !foreign;
    if (foreign) $('exchRate').value = S.currency.exchange_rate != null ? String(S.currency.exchange_rate) : '';
    return changed;
  }

  function fillAddress(prefix, a) {
    ADDR_FIELDS.forEach(function (f) { $(prefix + '_' + f[0]).value = (a && a[f[0]]) || ''; });
  }

  function applyCustomer(contact) {
    S.contact = contact;
    var cur = S.currencies.filter(function (c) { return String(c.currency_id) === String(contact.currency_id); })[0];
    var changed = setCurrency(cur || S.baseCurrency);
    $('rowNotice').textContent = (changed && S.rows.some(function (r) { return !isPristine(r); }))
      ? 'Currency changed to ' + S.currency.currency_code + '. Review the item rates.' : '';

    if (!S.touched.payTerms) {
      soFillTerms(contact.payment_terms != null && contact.payment_terms !== '' ? contact.payment_terms : '');
    }
    if (!S.addrDirty.b) fillAddress('b', contact.billing_address);
    if (!S.addrDirty.s) fillAddress('s', contact.shipping_address);

    if (!S.touched.priceList && contact.pricebook_id) {
      var pb = S.pricebooks.filter(function (p) { return String(p.pricebook_id) === String(contact.pricebook_id); })[0];
      if (pb) { $('priceList').value = String(pb.pricebook_id); S.pricebook = pb; }
    }

    $('customerHint').textContent = contact.company_name && contact.company_name !== contact.contact_name ? contact.company_name : '';
    S.rows.forEach(function (r) { refreshRate(r); r.refs.rate.classList.remove('invalid'); });
    renderRowsPrecision();
    recalc();
    checkField('customer');
  }

  function renderRowsPrecision() {
    $('tCur').textContent = S.currency ? S.currency.currency_code : '';
  }

  function selectCustomer(c) {
    S.customer = c;
    S.contact = null;
    $('customer').value = c.contact_name || $('customer').value;
    $('customerClear').hidden = false;
    $('customerHint').textContent = 'Loading customer…';
    api('GET', '/contacts/' + c.contact_id).then(function (j) {
      if (!S.customer || String(S.customer.contact_id) !== String(c.contact_id)) return;
      if (!j.contact) throw mkErr('data', 'Customer details were not returned.');
      applyCustomer(j.contact);
    }).catch(function (e) {
      S.customer = null;
      S.contact = null;
      $('customer').value = '';
      $('customerClear').hidden = true;
      $('customerHint').textContent = '';
      mark($('customer'), 'Could not load customer: ' + errText(e));
    });
  }

  function clearCustomer() {
    S.customer = null;
    S.contact = null;
    $('customer').value = '';
    $('customerClear').hidden = true;
    $('customerHint').textContent = '';
    setCurrency(S.baseCurrency);
  }

  /* ================= CUSTOMER CACHE (IndexedDB) ================= */
  var IDB = {
    db: null,
    open: function (name) {
      return new Promise(function (resolve) {
        if (!window.indexedDB) { resolve(null); return; }
        try {
          var rq = indexedDB.open(name, 1);
          rq.onupgradeneeded = function () {
            var d = rq.result;
            if (!d.objectStoreNames.contains('customers')) d.createObjectStore('customers', { keyPath: 'contact_id' });
            if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
          };
          rq.onsuccess = function () { IDB.db = rq.result; resolve(IDB.db); };
          rq.onerror = rq.onblocked = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
    },
    tx: function (store, mode, fn) {
      return new Promise(function (resolve) {
        if (!IDB.db) { resolve(undefined); return; }
        try {
          var t = IDB.db.transaction(store, mode);
          var out = fn(t.objectStore(store));
          t.oncomplete = function () { resolve(out && typeof out === 'object' && 'result' in out ? out.result : undefined); };
          t.onerror = t.onabort = function () { resolve(undefined); };
        } catch (e) { resolve(undefined); }
      });
    },
    getAll: function (store) {
      return IDB.tx(store, 'readonly', function (st) { return st.getAll(); }).then(function (r) { return r || []; });
    },
    get: function (store, key) {
      return IDB.tx(store, 'readonly', function (st) { return st.get(key); });
    },
    put: function (store, rows) {
      return IDB.tx(store, 'readwrite', function (st) { rows.forEach(function (r) { st.put(r); }); });
    },
    replaceAll: function (store, rows) {
      return IDB.tx(store, 'readwrite', function (st) { st.clear(); rows.forEach(function (r) { st.put(r); }); });
    }
  };

  function slimCustomer(c) {
    var name = c.contact_name || '', comp = c.company_name || '', email = c.email || '', ph = c.phone || c.mobile || '';
    return {
      contact_id: String(c.contact_id), contact_name: name, company_name: comp, email: email, phone: ph,
      status: c.status || 'active', currency_id: c.currency_id || '',
      _k: (name + ' ' + comp + ' ' + email + ' ' + ph).toLowerCase()
    };
  }

  function sortCustomers() {
    S.cust.list.sort(function (a, b) {
      return a.contact_name.toLowerCase().localeCompare(b.contact_name.toLowerCase());
    });
  }

  function mergeCustomers(rows) {
    var C = S.cust, byId = {}, fresh = [];
    C.list.forEach(function (c) { byId[c.contact_id] = c; });
    rows.forEach(function (r) {
      if (!r || r.contact_id === undefined) return;
      var s = slimCustomer(r);
      if (s.status && s.status !== 'active') return;
      if (!byId[s.contact_id]) C.list.push(s);
      else Object.assign(byId[s.contact_id], s);
      fresh.push(s);
    });
    sortCustomers();
    C.count = C.list.length;
    return IDB.put('customers', fresh);
  }

  function fetchAllCustomers(onProgress) {
    var all = [], page = 1;
    function next() {
      return api('GET', '/contacts', {
        contact_type: 'customer', filter_by: 'Status.Active', per_page: 200, page: page, sort_column: 'contact_name'
      }).then(function (j) {
        var list = firstArray(j, 'contacts');
        list.forEach(function (c) { if (!c.status || c.status === 'active') all.push(slimCustomer(c)); });
        if (onProgress) onProgress(all.length);
        var more = j.page_context && j.page_context.has_more_page;
        if (more && list.length && page < 500) { page++; return next(); }
        return all;
      });
    }
    return next();
  }

  function refreshCustomers(background) {
    var C = S.cust;
    if (C.refreshing) return Promise.resolve();
    C.refreshing = true;
    C.error = '';
    if (!background || !C.list.length) C.state = 'loading';
    repaintCust();

    return fetchAllCustomers(function (n) {
      C.count = n;
      if (!C.list.length) repaintCust();
    }).then(function (list) {
      C.list = list;
      sortCustomers();
      C.count = C.list.length;
      C.state = 'ready';
      C.syncedAt = Date.now();
      return IDB.replaceAll('customers', C.list).then(function () {
        return IDB.put('meta', [{ key: 'customersSyncedAt', value: C.syncedAt }]);
      });
    }).catch(function (e) {
      C.error = errText(e);
      C.state = C.list.length ? 'ready' : 'error';
      if (CONFIG.debug) console.warn('[SOWidget] customer refresh failed', e);
    }).then(function () {
      C.refreshing = false;
      repaintCust();
    });
  }

  // Flow: IndexedDB first -> if empty (or older than the TTL) load from the Zoho Books API and store.
  function initCustomerCache() {
    var C = S.cust;
    if (C.state !== 'idle') return Promise.resolve();
    C.state = 'loading';
    return IDB.open('so_widget_' + S.orgId).then(function () {
      return IDB.getAll('customers');
    }).then(function (rows) {
      return IDB.get('meta', 'customersSyncedAt').then(function (meta) {
        var ts = meta && meta.value ? Number(meta.value) : 0;
        if (rows.length) {
          C.list = rows;
          sortCustomers();
          C.count = rows.length;
          C.state = 'ready';
          C.syncedAt = ts;
          if (CONFIG.debug) console.log('[SOWidget] customers from IndexedDB:', rows.length);
          repaintCust();
          if (!ts || Date.now() - ts > CONFIG.customerCacheTtlMs) return refreshCustomers(true);
          return;
        }
        return refreshCustomers(false);
      });
    });
  }

  /* ================= CUSTOMER PICKER ================= */
  var CP = { open: false, items: [], active: 0, shown: 0, query: '', remote: '', timer: null, wasOpened: false };

  function filterCust(q) {
    var toks = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!toks.length) return S.cust.list;
    var phrase = toks.join(' ');
    var hits = S.cust.list.filter(function (c) {
      return toks.every(function (t) { return c._k.indexOf(t) > -1; });
    });
    function rank(c) {
      var n = c.contact_name.toLowerCase();
      return n.indexOf(phrase) === 0 ? 0 : (n.indexOf(phrase) > -1 ? 1 : 2);
    }
    // best matches first (name starts with the text, then contains it, then token matches); list order is kept within a rank
    return hits.map(function (c, i) { return { c: c, r: rank(c), i: i }; })
      .sort(function (a, b) { return a.r - b.r || a.i - b.i; })
      .map(function (x) { return x.c; });
  }

  function custMsg(text, retry) {
    var box = $('custList');
    box.innerHTML = '';
    var d = mk('div', { class: 'cust-msg', text: text }, box);
    if (retry) {
      var b = mk('button', { type: 'button', class: 'btn', text: 'Retry' }, d);
      b.addEventListener('mousedown', function (ev) {
        ev.preventDefault();
        if (S.cust.state === 'error') refreshCustomers(false);
      });
    }
  }

  function custItemEl(c, i) {
    var d = mk('div', {
      class: 'cust-item' + (i === CP.active ? ' active' : '') + (S.customer && S.customer.contact_id === c.contact_id ? ' chosen' : '')
    });
    d.setAttribute('role', 'option');
    d.dataset.i = String(i);
    mk('span', { class: 'av', text: (c.contact_name.trim().charAt(0) || '?') }, d);
    var tx = mk('div', { class: 'tx' }, d);
    mk('span', { class: 'nm', text: c.contact_name }, tx);
    if (c.email) mk('span', { class: 'em', text: '✉ ' + c.email }, tx);
    d.addEventListener('mousedown', function (ev) { ev.preventDefault(); chooseCust(i); });
    d.addEventListener('mouseenter', function () { setCustActive(i, false); });
    return d;
  }

  function renderMoreCust() {
    var box = $('custList'), end = Math.min(CP.items.length, CP.shown + 60);
    for (var i = CP.shown; i < end; i++) box.appendChild(custItemEl(CP.items[i], i));
    CP.shown = end;
  }

  function paintCust() {
    var C = S.cust;
    if (C.state === 'loading' && !C.list.length) { custMsg('Loading customers… ' + (C.count ? C.count + ' loaded' : '')); return; }
    if (C.state === 'error' && !C.list.length) { custMsg('Could not load customers: ' + C.error, true); return; }
    CP.items = filterCust(CP.query);
    if (!CP.items.length) { custMsg(CP.remote === 'searching' ? 'Searching Zoho Books…' : 'No customers found'); return; }
    if (CP.active >= CP.items.length) CP.active = 0;
    $('custList').innerHTML = '';
    CP.shown = 0;
    renderMoreCust();
  }

  function repaintCust() { if (CP.open) paintCust(); }

  function setCustActive(i, scroll) {
    var nodes = $('custList').querySelectorAll('.cust-item');
    if (!nodes.length) return;
    CP.active = Math.max(0, Math.min(CP.items.length - 1, i));
    while (CP.active >= CP.shown && CP.shown < CP.items.length) renderMoreCust();
    nodes = $('custList').querySelectorAll('.cust-item');
    Array.prototype.forEach.call(nodes, function (n) { n.classList.toggle('active', Number(n.dataset.i) === CP.active); });
    if (scroll) {
      var el = $('custList').querySelector('.cust-item.active');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    }
  }

  function chooseCust(i) {
    var c = CP.items[i];
    if (!c) return;
    closeCustPanel(true);
    $('customer').value = c.contact_name;
    mark($('customer'), '');
    selectCustomer(c);
  }

  function openCustPanel() {
    if (CP.open) return;
    CP.open = true;
    CP.wasOpened = true;
    CP.query = '';
    CP.active = 0;
    CP.remote = '';
    $('custPanel').hidden = false;
    $('custSelect').classList.add('open');
    $('custSearch').value = '';
    if (S.cust.state === 'idle') initCustomerCache();
    paintCust();
    setTimeout(function () { $('custSearch').focus(); }, 0);
  }

  function closeCustPanel(picked) {
    if (!CP.open) return;
    CP.open = false;
    clearTimeout(CP.timer);
    $('custPanel').hidden = true;
    $('custSelect').classList.remove('open');
    if (!picked && !S.customer) checkField('customer');
  }

  function remoteCustSearch(q) {
    CP.remote = 'searching';
    paintCust();
    api('GET', '/contacts', { contact_type: 'customer', filter_by: 'Status.Active', search_text: q, per_page: 50 }).then(function (j) {
      return mergeCustomers(firstArray(j, 'contacts'));
    }).catch(function () { /* keep "not found" */ }).then(function () {
      CP.remote = '';
      if (CP.open && CP.query === q) { CP.active = 0; paintCust(); }
    });
  }

  function wireCustomerPicker() {
    var sel = $('custSelect'), inp = $('customer'), search = $('custSearch');

    sel.addEventListener('click', function (ev) {
      if (ev.target === $('customerClear')) return;
      if (CP.open) closeCustPanel(false);
      else openCustPanel();
    });
    $('custGo').addEventListener('click', function () { openCustPanel(); search.focus(); });
    inp.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === 'ArrowDown' || ev.key === ' ') { ev.preventDefault(); openCustPanel(); }
    });

    search.addEventListener('input', function () {
      CP.query = search.value.trim();
      CP.active = 0;
      clearTimeout(CP.timer);
      paintCust();
      if (CP.query.length >= 2 && !CP.items.length && S.cust.state === 'ready') {
        var q = CP.query;
        CP.timer = setTimeout(function () { remoteCustSearch(q); }, 450);
      }
    });
    search.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); setCustActive(CP.active + 1, true); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); setCustActive(CP.active - 1, true); }
      else if (ev.key === 'Enter') { ev.preventDefault(); chooseCust(CP.active); }
      else if (ev.key === 'Escape') { ev.preventDefault(); closeCustPanel(false); inp.focus(); }
      else if (ev.key === 'Tab') closeCustPanel(false);
    });

    $('custList').addEventListener('scroll', function () {
      var l = $('custList');
      if (CP.shown < CP.items.length && l.scrollTop + l.clientHeight > l.scrollHeight - 80) renderMoreCust();
    });
    $('custNew').addEventListener('mousedown', function (ev) {
      ev.preventDefault();
      closeCustPanel(true);
      openNewCustomerModal();
    });
    $('custRefresh').addEventListener('mousedown', function (ev) { ev.preventDefault(); refreshCustomers(false); });
    document.addEventListener('mousedown', function (ev) {
      if (CP.open && !$('custWrap').contains(ev.target)) closeCustPanel(false);
    });
    $('customerClear').addEventListener('click', function (ev) {
      ev.stopPropagation();
      clearCustomer();
      openCustPanel();
    });
  }

  /* ================= NEW CUSTOMER MODAL ================= */
  // Static reference data (GST / dialling codes are statutory or standard, not business data).
  var STATES_IN = [
    ['AN', 'Andaman and Nicobar Islands'], ['AP', 'Andhra Pradesh'], ['AR', 'Arunachal Pradesh'], ['AS', 'Assam'], ['BR', 'Bihar'],
    ['CH', 'Chandigarh'], ['CG', 'Chhattisgarh'], ['DN', 'Dadra and Nagar Haveli and Daman and Diu'], ['DL', 'Delhi'], ['GA', 'Goa'], ['GJ', 'Gujarat'],
    ['HR', 'Haryana'], ['HP', 'Himachal Pradesh'], ['JK', 'Jammu and Kashmir'], ['JH', 'Jharkhand'], ['KA', 'Karnataka'], ['KL', 'Kerala'], ['LA', 'Ladakh'],
    ['LD', 'Lakshadweep'], ['MP', 'Madhya Pradesh'], ['MH', 'Maharashtra'], ['MN', 'Manipur'], ['ML', 'Meghalaya'], ['MZ', 'Mizoram'], ['NL', 'Nagaland'],
    ['OD', 'Odisha'], ['PY', 'Puducherry'], ['PB', 'Punjab'], ['RJ', 'Rajasthan'], ['SK', 'Sikkim'], ['TN', 'Tamil Nadu'], ['TS', 'Telangana'],
    ['TR', 'Tripura'], ['UP', 'Uttar Pradesh'], ['UK', 'Uttarakhand'], ['WB', 'West Bengal']
  ];

  // GST treatments (labels/descriptions as shown in Zoho Books). reg = show GSTIN + legal/trade name,
  // pos = show Place of Supply, req = GSTIN mandatory, api = value sent to the API.
  // Zoho documents only business_gst / business_none / overseas / consumer; the other values are best guesses - edit `api` here if Zoho rejects one.
  var GST_TREATMENTS = [
    { value: 'business_gst', label: 'Registered Business - Regular', desc: 'Business that is registered under GST', api: 'business_gst', reg: 1, pos: 1, req: 1 },
    { value: 'business_composition', label: 'Registered Business - Composition', desc: 'Business that is registered under the Composition Scheme in GST', api: 'business_composition', reg: 1, pos: 1, req: 1 },
    { value: 'business_none', label: 'Unregistered Business', desc: 'Business that has not been registered under GST', api: 'business_none', reg: 0, pos: 1, req: 0 },
    { value: 'consumer', label: 'Consumer', desc: 'A customer who is a regular consumer', api: 'consumer', reg: 0, pos: 1, req: 0 },
    { value: 'overseas', label: 'Overseas', desc: 'Persons with whom you do import or export of supplies outside India', api: 'overseas', reg: 0, pos: 0, req: 0 },
    { value: 'special_economic_zone', label: 'Special Economic Zone', desc: 'Business (Unit) that is located in a Special Economic Zone (SEZ) of India or a SEZ Developer', api: 'special_economic_zone', reg: 1, pos: 1, req: 1 },
    { value: 'deemed_export', label: 'Deemed Export', desc: 'Supply of goods to an Export Oriented Unit or against Advanced Authorization/Export Promotion Capital Goods.', api: 'deemed_export', reg: 1, pos: 1, req: 1 },
    { value: 'tax_deductor', label: 'Tax Deductor', desc: 'Departments of the State/Central government, governmental agencies or local authorities', api: 'tax_deductor', reg: 1, pos: 1, req: 0 },
    { value: 'sez_developer', label: 'SEZ Developer', desc: 'A person/organisation who owns at least 26% of the equity in creating business units in a Special Economic Zone (SEZ)', api: 'sez_developer', reg: 1, pos: 1, req: 1 },
    { value: 'input_service_distributor', label: 'Input Service Distributor', desc: 'Input Service Distributor (ISD) is an office that receives tax invoices for services used by the company in different states under the same PAN.', api: 'input_service_distributor', reg: 1, pos: 1, req: 1 }
  ];
  var GST_BY = {};
  GST_TREATMENTS.forEach(function (t) { GST_BY[t.value] = t; });

  var DIAL_CODES = ['+91', '+1', '+44', '+971', '+966', '+65', '+61', '+49', '+33', '+81', '+86', '+92', '+880', '+94', '+977', '+974', '+968', '+60', '+27'];
  var LANGS = [['en', 'English'], ['hi', 'Hindi'], ['fr', 'French'], ['de', 'German'], ['es', 'Spanish'], ['pt', 'Portuguese'], ['it', 'Italian'], ['nl', 'Dutch'], ['ar', 'Arabic'], ['ja', 'Japanese'], ['zh', 'Chinese']];
  var TERMS = [[0, 'Due on Receipt'], [15, 'Net 15'], [30, 'Net 30'], [45, 'Net 45'], [60, 'Net 60']];
  var COUNTRIES = ['India', 'United States', 'United Kingdom', 'United Arab Emirates', 'Saudi Arabia', 'Singapore', 'Australia', 'Canada', 'Germany', 'France',
    'Japan', 'China', 'Bangladesh', 'Sri Lanka', 'Nepal', 'Qatar', 'Oman', 'Malaysia', 'South Africa'];
  var ADDR_KEYS = [
    ['attention', 'Attention'], ['country', 'Country/Region'], ['address', 'Address'], ['street2', ''],
    ['city', 'City'], ['state', 'State'], ['zip', 'Pin Code'], ['phone', 'Phone'], ['fax', 'Fax Number']
  ];

  // First two digits of a GSTIN = GST state code -> Zoho place-of-supply code (the codes used in STATES_IN)
  var GST_STATE_NUM = {
    '01': 'JK', '02': 'HP', '03': 'PB', '04': 'CH', '05': 'UK', '06': 'HR', '07': 'DL', '08': 'RJ', '09': 'UP', '10': 'BR', '11': 'SK',
    '12': 'AR', '13': 'NL', '14': 'MN', '15': 'MZ', '16': 'TR', '17': 'ML', '18': 'AS', '19': 'WB', '20': 'JH', '21': 'OD', '22': 'CG', '23': 'MP', '24': 'GJ',
    '25': 'DN', '26': 'DN', '27': 'MH', '28': 'AP', '29': 'KA', '30': 'GA', '31': 'LD', '32': 'KL', '33': 'TN', '34': 'PY', '35': 'AN', '36': 'TS', '37': 'AP', '38': 'LA'
  };
  var GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

  var NC = {
    saving: false, wired: false, gstOn: false, cfDefs: [], exemptions: [], accounts: [],
    refsLoaded: false, terms: [], localTerms: []
  };

  function nv(id) {
    var el = $(id);
    return el ? String(el.value).trim() : '';
  }

  function ncType() { return document.querySelector('input[name="nc_type"]:checked').value; }
  function ncTax() { return document.querySelector('input[name="nc_tax"]:checked').value; }

  function detectGst() {
    if (CONFIG.gstMode === 'on') return true;
    if (CONFIG.gstMode === 'off') return false;
    var o = S.org || {};
    return o.country_code === 'IN' || /india/i.test(String(o.country || '')) || o.is_gst_enabled === true ||
      !!(S.baseCurrency && S.baseCurrency.currency_code === 'INR');
  }

  function fillOptions(sel, pairs, blank) {
    sel.innerHTML = '';
    if (blank !== null && blank !== undefined) mk('option', { value: '', text: blank }, sel);
    pairs.forEach(function (p) { mk('option', { value: String(p[0]), text: p[1] }, sel); });
  }

  // Optional reference data for the popups – every call is allowed to fail.
  function loadNcRefs() {
    if (NC.refsLoaded) return Promise.resolve();
    NC.refsLoaded = true;
    var jobs = [];

    jobs.push(api('GET', '/chartofaccounts', { filter_by: 'AccountType.AccountsReceivable' }).then(function (j) {
      NC.accounts = firstArray(j, 'chartofaccounts');
    }).catch(function () { NC.accounts = []; }));

    jobs.push(api('GET', '/settings/taxexemptions').then(function (j) {
      NC.exemptions = firstArray(j, 'tax_exemptions');
    }).catch(function () { NC.exemptions = []; }));

    // Customer custom fields: Zoho has no definitions endpoint, so read them from the newest existing customer.
    jobs.push(api('GET', '/contacts', { contact_type: 'customer', per_page: 1, sort_column: 'created_time', sort_order: 'D' }).then(function (j) {
      var first = firstArray(j, 'contacts')[0];
      if (!first) return;
      return api('GET', '/contacts/' + first.contact_id).then(function (r) {
        NC.cfDefs = ((r.contact && r.contact.custom_fields) || [])
          .filter(function (cf) { return cf.customfield_id !== undefined; })
          .map(function (cf) {
            return {
              customfield_id: String(cf.customfield_id),
              label: cf.label || ('Custom field ' + cf.customfield_id),
              data_type: String(cf.data_type || '').toLowerCase()
            };
          });
      });
    }).catch(function () { NC.cfDefs = []; }));

    jobs.push(ncLoadTerms());
    return Promise.all(jobs);
  }

  function ncBuildAddress(prefix, boxId) {
    var box = $(boxId);
    box.innerHTML = '';
    ADDR_KEYS.forEach(function (k) {
      var row = mk('div', { class: 'nc-a' }, box);
      mk('span', { text: k[1] }, row);
      var id = prefix + '_' + k[0], el;
      if (k[0] === 'address' || k[0] === 'street2') {
        el = mk('textarea', { id: id, rows: 2, placeholder: k[0] === 'address' ? 'Street 1' : 'Street 2' }, row);
      } else if (k[0] === 'country') {
        el = mk('input', { type: 'text', id: id, placeholder: 'Select', autocomplete: 'off' }, row);
        el.setAttribute('list', 'ncCountries');
      } else if (k[0] === 'state') {
        el = mk('input', { type: 'text', id: id, placeholder: 'Select or type to add', autocomplete: 'off' }, row);
        el.setAttribute('list', 'ncStates');
      } else {
        el = mk('input', { type: 'text', id: id }, row);
      }
    });
  }

  function ncSwitchTab(name) {
    Array.prototype.forEach.call(document.querySelectorAll('.nc-tab'), function (t) {
      t.classList.toggle('active', t.dataset.pane === name);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.nc-pane'), function (p) {
      p.hidden = p.dataset.pane !== name;
    });
  }

  function ncUpdateDisplayOptions() {
    var sal = nv('nc_salutation'), f = nv('nc_firstName'), l = nv('nc_lastName'), comp = nv('nc_companyName');
    var opts = [];
    function add(x) {
      x = x.replace(/\s+/g, ' ').trim();
      if (x && opts.indexOf(x) < 0) opts.push(x);
    }
    add(comp); add([sal, f, l].join(' ')); add([f, l].join(' ')); add([l, f].join(' ')); add(l); add(f);

    var dl = $('ncDisplayList');
    dl.innerHTML = '';
    opts.forEach(function (o) { mk('option', { value: o }, dl); });

    var d = $('nc_displayName');
    if (d.dataset.userEdited !== '1') {
      var person = [f, l].join(' ').replace(/\s+/g, ' ').trim();
      d.value = ncType() === 'business' ? (comp || person) : (person || comp);
    }
  }

  function gstRule() { return GST_BY[$('nc_gstTreatment').value] || null; }

  // Show/hide whole rows (label, input, required star, error text) for the selected GST treatment.
  function ncUpdateGstUi() {
    var on = NC.gstOn, r = gstRule();
    Array.prototype.forEach.call(document.querySelectorAll('#newCustModal .gst-only'), function (row) {
      var hide = !on;
      if (!hide && row.classList.contains('gst-reg')) hide = !(r && r.reg);
      row.hidden = hide;
    });

    var posRow = $('nc_pos').closest('.nc-row');
    if (on && r && !r.pos) posRow.hidden = true;

    var lbl = $('ncGstinLbl'), need = !!(r && r.req);
    lbl.textContent = need ? 'GSTIN / UIN*' : 'GSTIN / UIN';
    lbl.classList.toggle('req', need);

    // hidden rows must not keep stale validation errors
    Array.prototype.forEach.call(document.querySelectorAll('#newCustModal .nc-row[hidden]'), function (row) {
      Array.prototype.forEach.call(row.querySelectorAll('.invalid'), function (e) { e.classList.remove('invalid'); });
      Array.prototype.forEach.call(row.querySelectorAll('.fe'), function (e) { e.remove(); });
    });
  }

  var RS = {};

  function richSelect(o) {
    var box = $(o.box), txt = $(o.text), hid = $(o.hidden), panel = $(o.panel), search = $(o.search), list = $(o.list);
    var st = { open: false, active: 0, items: [] };

    function scrollActive() {
      var a = list.querySelector('.rs-item.active');
      if (a && a.scrollIntoView) a.scrollIntoView({ block: 'nearest' });
    }

    function paintActive() {
      Array.prototype.forEach.call(list.querySelectorAll('.rs-item'), function (n) {
        n.classList.toggle('active', Number(n.dataset.i) === st.active);
      });
    }

    function paint() {
      var q = search.value.trim().toLowerCase();
      st.items = o.options.filter(function (x) { return !q || (x.label + ' ' + x.desc).toLowerCase().indexOf(q) > -1; });
      list.innerHTML = '';
      if (!st.items.length) { mk('div', { class: 'cust-msg', text: 'No matches' }, list); return; }
      if (st.active >= st.items.length) st.active = 0;
      st.items.forEach(function (x, i) {
        var d = mk('div', { class: 'rs-item' + (i === st.active ? ' active' : '') + (hid.value === x.value ? ' chosen' : '') }, list);
        d.setAttribute('role', 'option');
        d.dataset.i = String(i);
        mk('div', { class: 't', text: x.label }, d);
        if (x.desc) mk('div', { class: 'd', text: x.desc }, d);
        d.addEventListener('mousedown', function (ev) { ev.preventDefault(); choose(i); });
        d.addEventListener('mouseenter', function () { st.active = i; paintActive(); });
      });
    }

    function open() {
      if (st.open) return;
      st.open = true;
      panel.hidden = false;
      box.classList.add('open');
      search.value = '';
      st.active = Math.max(0, o.options.map(function (x) { return x.value; }).indexOf(hid.value));
      paint();
      scrollActive();
      setTimeout(function () { search.focus(); }, 0);
    }

    function close() {
      if (!st.open) return;
      st.open = false;
      panel.hidden = true;
      box.classList.remove('open');
    }

    function set(v, silent) {
      var opt = o.options.filter(function (x) { return x.value === v; })[0];
      hid.value = opt ? opt.value : '';
      txt.value = opt ? opt.label : '';
      txt.classList.remove('invalid');
      var fe = txt.closest('.nc-c');
      fe = fe && fe.querySelector(':scope > .fe');
      if (fe) fe.remove();
      if (!silent && o.onChange) o.onChange(hid.value);
    }

    function choose(i) {
      var x = st.items[i];
      if (!x) return;
      set(x.value);
      close();
      txt.focus();
    }

    box.addEventListener('click', function () { if (st.open) close(); else open(); });
    txt.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === 'ArrowDown' || ev.key === ' ') { ev.preventDefault(); open(); }
    });
    search.addEventListener('input', function () { st.active = 0; paint(); });
    search.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); st.active = Math.min(st.items.length - 1, st.active + 1); paintActive(); scrollActive(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); st.active = Math.max(0, st.active - 1); paintActive(); scrollActive(); }
      else if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); choose(st.active); }
      else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); txt.focus(); }
      else if (ev.key === 'Tab') close();
    });
    document.addEventListener('mousedown', function (ev) {
      if (st.open && !panel.contains(ev.target) && !box.contains(ev.target)) close();
    });

    return { set: set, close: close, isOpen: function () { return st.open; } };
  }

  function exemptionPairs() {
    return NC.exemptions.map(function (x) {
      return [
        x.tax_exemption_id,
        x.tax_exemption_code ? x.tax_exemption_code + (x.description ? ' - ' + x.description : '') : (x.description || x.tax_exemption_id)
      ];
    });
  }

  function ncUpdateTaxUi() {
    var ex = ncTax() === 'exempt';
    $('ncExemptRow').hidden = !ex;
    var sel = $('nc_exemption');
    if (ex) {
      if (NC.exemptions.length) {
        fillOptions(sel, exemptionPairs(), 'Select an exemption');
      } else {
        sel.innerHTML = '';
        mk('option', { value: '', text: 'Exemption reasons could not be loaded' }, sel);
      }
    }
  }

  function ncUpdateCurrencyUi() {
    var cur = S.currencies.filter(function (c) { return String(c.currency_id) === $('nc_currency').value; })[0];
    var code = cur ? cur.currency_code : '';
    $('nc_obCur').textContent = code;
    $('nc_crCur').textContent = code;
  }

  function openNewCustomerModal() {
    var modal = $('newCustModal');
    if (!modal) return;
    ncWire();
    NC.gstOn = detectGst();

    // reset every input
    Array.prototype.forEach.call(modal.querySelectorAll('input[type=text], textarea'), function (el) {
      el.value = '';
      el.classList.remove('invalid');
    });
    Array.prototype.forEach.call(modal.querySelectorAll('select.invalid'), function (s) { s.classList.remove('invalid'); });
    Array.prototype.forEach.call(modal.querySelectorAll('.fe'), function (e) { e.remove(); });
    Array.prototype.forEach.call(modal.querySelectorAll('.nc-tab'), function (t) { t.classList.remove('has-err'); });
    $('nc_portal').checked = false;
    document.querySelector('input[name="nc_type"][value="business"]').checked = true;
    document.querySelector('input[name="nc_tax"][value="taxable"]').checked = true;
    $('nc_displayName').dataset.userEdited = '';
    $('nc_pan').dataset.auto = '';
    $('nc_salutation').value = '';

    // selects
    fillOptions($('nc_workCode'), DIAL_CODES.map(function (c) { return [c, c]; }), null);
    fillOptions($('nc_mobCode'), DIAL_CODES.map(function (c) { return [c, c]; }), null);
    fillOptions($('nc_language'), LANGS, null);
    RS.gst.close();
    RS.gst.set('', true);
    fillOptions($('nc_pos'), STATES_IN.map(function (s) { return [s[0], '[' + s[0] + '] - ' + s[1]]; }), '');
    fillOptions($('nc_currency'), S.currencies.map(function (c) { return [c.currency_id, c.currency_code + '- ' + c.currency_name]; }), null);
    if (S.baseCurrency) $('nc_currency').value = String(S.baseCurrency.currency_id);

    $('ncArRow').hidden = !NC.accounts.length;
    if (NC.accounts.length) {
      fillOptions($('nc_receivable'), NC.accounts.map(function (a) { return [a.account_id, a.account_name]; }), 'Select an account');
    }

    var ol = $('nc_obLoc');
    ol.hidden = !S.locations.length;
    if (S.locations.length) {
      fillOptions(ol, S.locations.map(function (l) { return [l.location_id, l.location_name]; }), null);
      var pr = S.locations.filter(function (l) { return l.is_primary; })[0] || S.locations[0];
      ol.value = String(pr.location_id);
    }

    ncFillTerms();
    fillOptions($('nc_priceList'), S.pricebooks.map(function (p) { return [p.pricebook_id, p.name]; }), '');
    ncUpdateCurrencyUi();
    ncUpdateGstUi();
    ncUpdateTaxUi();

    // datalists
    var cl = $('ncCountries');
    if (!cl) {
      cl = mk('datalist', { id: 'ncCountries' }, modal);
      COUNTRIES.forEach(function (c) { mk('option', { value: c }, cl); });
    }
    var sl = $('ncStates');
    if (!sl) {
      sl = mk('datalist', { id: 'ncStates' }, modal);
      STATES_IN.forEach(function (s) { mk('option', { value: s[1] }, sl); });
    }
    ncBuildAddress('nb', 'ncBilling');
    ncBuildAddress('ns', 'ncShipping');
    $('nb_country').value = '';
    $('ns_country').value = '';

    // custom fields
    var cf = $('ncCf');
    cf.innerHTML = '';
    NC.cfDefs.forEach(function (d) {
      var row = mk('div', { class: 'nc-cfrow' }, cf);
      mk('label', { htmlFor: 'ncf_' + d.customfield_id, text: d.label }, row);
      var c = mk('div', { class: 'nc-c' }, row), inp;
      if (d.data_type === 'date') {
        mk('input', { type: 'date', id: 'ncf_' + d.customfield_id, class: 'w-main' }, c);
      } else if (/check/.test(d.data_type)) {
        mk('input', { type: 'checkbox', id: 'ncf_' + d.customfield_id }, c);
      } else if (/percent/.test(d.data_type)) {
        var ad = mk('div', { class: 'addon w-main' }, c);
        mk('input', { type: 'text', id: 'ncf_' + d.customfield_id, inputMode: 'decimal' }, ad);
        mk('span', { class: 'addon-t', text: '%' }, ad);
      } else {
        inp = mk('input', { type: 'text', id: 'ncf_' + d.customfield_id, class: 'w-main' }, c);
        if (/number|decimal|amount|integer/.test(d.data_type)) inp.inputMode = 'decimal';
      }
    });
    $('ncCfHint').textContent = NC.cfDefs.length
      ? 'Custom fields are read from your most recent customer. Dropdown and date-time fields are entered as plain text.'
      : 'No customer custom fields were found.';

    // reporting tags
    var tg = $('ncTags');
    tg.innerHTML = '';
    if (!S.tags.length) mk('div', { class: 'hint', text: 'No reporting tags are configured.' }, tg);
    S.tags.forEach(function (t) {
      var row = mk('div', { class: 'nc-tagrow' }, tg);
      mk('label', { htmlFor: 'nct_' + t.tag_id, text: t.tag_name }, row);
      var c = mk('div', { class: 'nc-c' }, row);
      var sel = mk('select', { id: 'nct_' + t.tag_id, class: 'w-main' }, c);
      fillOptions(sel, t.options.map(function (o) { return [o.tag_option_id, o.tag_option_name || o.option_name || o.tag_option_id]; }), '');
    });

    $('ncMore').hidden = true;
    $('ncMoreLink').textContent = 'Add more details';
    lookupEnhanceAll();
    ncSwitchTab('other');
    $('newCustStatus').textContent = '';
    NC.saving = false;
    $('newCustSave').disabled = false;
    modal.hidden = false;
    setTimeout(function () { var f = $('nc_firstName'); if (f) f.focus(); }, 30);
  }

  function closeNewCustomerModal() {
    if (NC.saving) return;
    $('newCustModal').hidden = true;
  }

  function ncWire() {
    if (NC.wired) return;
    NC.wired = true;

    Array.prototype.forEach.call(document.querySelectorAll('.nc-tab'), function (t) {
      t.addEventListener('click', function () { ncSwitchTab(t.dataset.pane); });
    });
    ['nc_salutation', 'nc_firstName', 'nc_lastName', 'nc_companyName'].forEach(function (id) {
      $(id).addEventListener('input', ncUpdateDisplayOptions);
      $(id).addEventListener('change', ncUpdateDisplayOptions);
    });
    $('nc_displayName').addEventListener('input', function () {
      $('nc_displayName').dataset.userEdited = $('nc_displayName').value ? '1' : '';
    });
    Array.prototype.forEach.call(document.querySelectorAll('input[name="nc_type"]'), function (r) {
      r.addEventListener('change', function () {
        $('nc_displayName').dataset.userEdited = '';
        ncUpdateDisplayOptions();
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('input[name="nc_tax"]'), function (r) {
      r.addEventListener('change', ncUpdateTaxUi);
    });

    RS.gst = richSelect({
      box: 'rsGstBox', text: 'nc_gstTreatmentText', hidden: 'nc_gstTreatment', panel: 'rsGstPanel', search: 'rsGstSearch', list: 'rsGstList',
      options: GST_TREATMENTS.map(function (t) { return { value: t.value, label: t.label, desc: t.desc }; }),
      onChange: ncUpdateGstUi
    });

    $('nc_currency').addEventListener('change', ncUpdateCurrencyUi);
    $('ncMoreLink').addEventListener('click', function () {
      var m = $('ncMore');
      m.hidden = !m.hidden;
      $('ncMoreLink').textContent = m.hidden ? 'Add more details' : 'Show fewer details';
    });
    $('ncCopyBilling').addEventListener('click', function () {
      ADDR_KEYS.forEach(function (k) { $('ns_' + k[0]).value = $('nb_' + k[0]).value; });
    });
    $('nc_pan').addEventListener('input', function () {
      this.value = this.value.toUpperCase();
      this.dataset.auto = '';
    });
    $('nc_gstin').addEventListener('input', function () {
      this.value = this.value.toUpperCase();
      if (GSTIN_RE.test(this.value)) {
        var pan = $('nc_pan'), pos = $('nc_pos');
        // PAN = characters 3-12 of the GSTIN; keep overwriting it only while it was auto-filled (never a PAN the user typed)
        if (!pan.value.trim() || pan.dataset.auto === '1') {
          pan.value = this.value.slice(2, 12);
          pan.dataset.auto = '1';
          mark(pan, '');
        }
        // Place of supply = state of the first two digits of the GSTIN
        var sc = GST_STATE_NUM[this.value.slice(0, 2)];
        if (sc && Array.prototype.some.call(pos.options, function (o) { return o.value === sc; })) {
          pos.value = sc;
          mark(pos, '');
        }
      }
    });
    $('newCustClose').addEventListener('click', closeNewCustomerModal);
    $('newCustCancel').addEventListener('click', closeNewCustomerModal);
    $('newCustSave').addEventListener('click', saveNewCustomer);
    $('newCustModal').addEventListener('mousedown', function (ev) {
      if (ev.target === $('newCustModal')) closeNewCustomerModal();
    });
  }

  /* ================= PAYMENT TERMS: data + "New Payment Term" popup ================= */
  function ncNormTerm(t) {
    var days = Number(t.payment_terms);
    if (!isFinite(days)) days = 0;
    return {
      id: String(t.payment_terms_id || ('x_' + t.payment_terms_label)),
      days: days,
      label: t.payment_terms_label || (days === 0 ? 'Due on Receipt' : 'Net ' + days),
      isDefault: !!t.is_default
    };
  }

  function ncLoadTerms() {
    return api('GET', '/settings/paymentterms').then(function (j) {
      var list = (j.data && j.data.payment_terms) || j.payment_terms || [];
      NC.terms = list.map(ncNormTerm);
    }).catch(function () { /* keeps the built-in list */ });
  }

  function ncTermsList() {
    var base = NC.terms.length ? NC.terms : TERMS.map(function (t) {
      return { id: 'local_' + t[0], days: t[0], label: t[1], isDefault: t[0] === 0 };
    });
    return base.concat(NC.localTerms);
  }

  function ncTermById(id) {
    return ncTermsList().filter(function (t) { return t.id === String(id); })[0] || null;
  }

  function ncFillTerms(selectedId) {
    var list = ncTermsList(), sel = $('nc_terms');
    fillOptions(sel, list.map(function (t) { return [t.id, t.label]; }), null);
    var pick = list.filter(function (t) { return t.id === selectedId; })[0] ||
      list.filter(function (t) { return t.isDefault; })[0] ||
      list.filter(function (t) { return /due on receipt/i.test(t.label); })[0] || list[0];
    if (pick) sel.value = pick.id;
  }

  var PT = { saving: false, wired: false, from: '' };

  // from === 'so' -> opened from the Sales Order form; otherwise from the New Customer modal.
  function openPaymentTermModal(from) {
    PT.from = from === 'so' ? 'so' : '';
    ptWire();
    ['pt_name', 'pt_days'].forEach(function (id) { $(id).value = ''; mark($(id), ''); });
    $('ptStatus').textContent = '';
    PT.saving = false;
    $('ptSave').disabled = false;
    $('ptModal').hidden = false;
    setTimeout(function () { $('pt_name').focus(); }, 30);
  }

  function closePaymentTermModal() {
    if (PT.saving) return;
    $('ptModal').hidden = true;
  }

  function ptValidate() {
    var ok = true, name = nv('pt_name'), raw = nv('pt_days');
    mark($('pt_name'), '');
    mark($('pt_days'), '');

    if (!name) {
      mark($('pt_name'), 'Term name is required');
      ok = false;
    } else if (ncTermsList().some(function (t) { return t.label.toLowerCase() === name.toLowerCase(); })) {
      mark($('pt_name'), 'A payment term with this name already exists');
      ok = false;
    }

    if (!raw) {
      mark($('pt_days'), 'Due after is required');
      ok = false;
    } else if (!/^\d+$/.test(raw) || parseInt(raw, 10) < 1 || parseInt(raw, 10) > 999) {
      mark($('pt_days'), 'Enter whole days between 1 and 999');
      ok = false;
    }

    if (!ok) {
      var bad = document.querySelector('#ptModal .invalid');
      if (bad) bad.focus();
    }
    return ok;
  }

  function ptSave() {
    if (PT.saving || !ptValidate()) return;
    var label = nv('pt_name'), days = parseInt(nv('pt_days'), 10);
    PT.saving = true;
    $('ptSave').disabled = true;
    $('ptStatus').textContent = 'Saving…';

    function finish(term, note) {
      PT.saving = false;
      $('ptSave').disabled = false;
      ncFillTerms(term.id);
      $('ptModal').hidden = true;
      if (PT.from === 'so') {
        soFillTerms(term.days);
        S.touched.payTerms = true;
        return;
      }
      $('newCustStatus').textContent = note || '';
      var lk = $('nc_terms')._lk;
      if (lk) lk.text.focus();
    }

    function find() {
      return ncTermsList().filter(function (t) { return t.label.toLowerCase() === label.toLowerCase(); })[0] || null;
    }

    function addLocal() {
      var t = { id: 'local_' + Date.now(), days: days, label: label, isDefault: false };
      NC.localTerms.push(t);
      return t;
    }

    api('POST', '/settings/paymentterms', {}, { payment_terms: days, payment_terms_label: label })
      .then(function () { return ncLoadTerms(); })
      .then(function () {
        var t = find();
        if (t) finish(t, '');
        else finish(addLocal(), 'Payment term applied to this customer only (not found in Zoho Books settings).');
      })
      .catch(function (e) {
        if (CONFIG.debug) console.warn('[SOWidget] create payment term failed', e, e && e.json);
        // uncertain = no confirmation from the server: re-read the list before assuming it failed
        return (e && e.uncertain ? ncLoadTerms() : Promise.resolve()).then(function () {
          var t = find();
          if (t) { finish(t, ''); return; }
          finish(addLocal(), 'Zoho Books did not save "' + label + '" as a reusable payment term (' + errText(e) + '). It is applied to this customer only.');
        });
      });
  }

  function ptWire() {
    if (PT.wired) return;
    PT.wired = true;
    $('ptSave').addEventListener('click', ptSave);
    $('ptCancel').addEventListener('click', closePaymentTermModal);
    $('ptClose').addEventListener('click', closePaymentTermModal);
    $('ptModal').addEventListener('keydown', function (ev) {
      ev.stopPropagation();   // keeps Enter / Esc away from the New Customer modal shortcuts
      if (ev.key === 'Escape') { ev.preventDefault(); closePaymentTermModal(); }
      else if (ev.key === 'Enter' && ev.target.tagName === 'INPUT') { ev.preventDefault(); ptSave(); }
    });
  }

  /* ================= LOOKUP: searchable dropdown that replaces a native <select> ================= */
  var LK_VALUE = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  var LK_OPEN = null;

  function lookupEnhance(sel, opt) {
    if (!sel || sel._lk) return;
    opt = opt || {};

    var widths = String(sel.className).split(/\s+/).filter(function (c) { return /^w-/.test(c); }).join(' ');
    var wrap = mk('div', { class: 'lk ' + widths });
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.classList.add('lk-native');

    var box = mk('div', { class: 'lk-box' }, wrap);
    var text = mk('input', { type: 'text', class: 'lk-text', readOnly: true, autocomplete: 'off' }, box);
    mk('span', { class: 'cust-chev' }, box);

    var panel = mk('div', { class: 'lk-panel', hidden: true }, wrap);
    var sbox = mk('div', { class: 'cust-search' }, panel);
    sbox.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8a94a6" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
    var search = mk('input', { type: 'text', placeholder: 'Search', autocomplete: 'off' }, sbox);
    var list = mk('div', { class: 'lk-list' }, panel);

    var st = { open: false, active: 0, items: [] };
    var h = { sel: sel, wrap: wrap, text: text, panel: panel, close: close };

    if (opt.onNew) {
      var foot = mk('div', { class: 'lk-foot' }, panel);
      var nb = mk('button', { type: 'button', class: 'combo-new-btn' }, foot);
      mk('span', { class: 'plus', text: '+' }, nb);
      mk('span', { text: opt.newLabel || 'New' }, nb);
      nb.addEventListener('mousedown', function (ev) {
        ev.preventDefault();
        close();
        opt.onNew();
      });
    }

    function sync() {
      var o = sel.options[sel.selectedIndex];
      var blank = sel.options.length && sel.options[0].value === '' ? sel.options[0].text : '';
      text.placeholder = blank || 'Select';
      text.value = (o && o.value !== '') ? o.text : '';
      wrap.hidden = sel.hidden;
      box.style.opacity = sel.disabled ? '0.6' : '';
    }

    function keep() {
      var a = list.querySelector('.lk-item.active');
      if (!a) return;
      var t = a.offsetTop, b = t + a.offsetHeight;
      if (t < list.scrollTop) list.scrollTop = t;
      else if (b > list.scrollTop + list.clientHeight) list.scrollTop = b - list.clientHeight;
    }

    function paintActive() {
      Array.prototype.forEach.call(list.children, function (n, i) { n.classList.toggle('active', i === st.active); });
    }

    function paint() {
      var q = search.value.trim().toLowerCase(), cur = LK_VALUE.get.call(sel);
      st.items = Array.prototype.filter.call(sel.options, function (o) { return !q || o.text.toLowerCase().indexOf(q) > -1; });
      list.innerHTML = '';
      if (!st.items.length) { mk('div', { class: 'cust-msg', text: 'No matches found' }, list); return; }
      if (st.active >= st.items.length) st.active = 0;
      st.items.forEach(function (o, i) {
        var d = mk('div', {
          class: 'lk-item' + (i === st.active ? ' active' : '') + (o.value === cur ? ' chosen' : ''),
          text: o.text || '— None —'
        }, list);
        d.addEventListener('mousedown', function (ev) { ev.preventDefault(); choose(i); });
        d.addEventListener('mouseenter', function () { st.active = i; paintActive(); });
      });
    }

    function place() {
      var r = box.getBoundingClientRect(), vh = window.innerHeight, vw = window.innerWidth;
      var w = Math.max(r.width, opt.minWidth || 240);
      var below = vh - r.bottom - 12, above = r.top - 12, down = below >= 200 || below >= above;
      panel.style.width = w + 'px';
      panel.style.left = Math.max(8, Math.min(r.left, vw - w - 8)) + 'px';
      panel.style.maxHeight = Math.max(160, Math.min(380, down ? below : above)) + 'px';
      if (down) { panel.style.top = (r.bottom + 4) + 'px'; panel.style.bottom = 'auto'; }
      else { panel.style.bottom = (vh - r.top + 4) + 'px'; panel.style.top = 'auto'; }
    }

    function open() {
      if (st.open || sel.disabled) return;
      if (LK_OPEN && LK_OPEN !== h) LK_OPEN.close();
      st.open = true;
      LK_OPEN = h;
      panel.hidden = false;
      box.classList.add('open');
      search.value = '';
      var cur = LK_VALUE.get.call(sel);
      st.active = 0;
      Array.prototype.some.call(sel.options, function (o, i) {
        if (o.value === cur) { st.active = i; return true; }
        return false;
      });
      paint();
      place();
      keep();
      setTimeout(function () { search.focus(); }, 0);
    }

    function close() {
      if (!st.open) return;
      st.open = false;
      panel.hidden = true;
      box.classList.remove('open');
      if (LK_OPEN === h) LK_OPEN = null;
    }

    function choose(i) {
      var o = st.items[i];
      if (!o) return;
      LK_VALUE.set.call(sel, o.value);
      sync();
      close();
      text.focus();
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }

    box.addEventListener('click', function () { if (st.open) close(); else open(); });
    text.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === 'ArrowDown' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); open(); }
    });
    search.addEventListener('input', function () { st.active = 0; paint(); });
    search.addEventListener('keydown', function (ev) {
      ev.stopPropagation();   // Enter / Esc must not reach the modal shortcuts
      if (ev.key === 'ArrowDown') { ev.preventDefault(); st.active = Math.min(st.items.length - 1, st.active + 1); paintActive(); keep(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); st.active = Math.max(0, st.active - 1); paintActive(); keep(); }
      else if (ev.key === 'Enter') { ev.preventDefault(); choose(st.active); }
      else if (ev.key === 'Escape') { ev.preventDefault(); close(); text.focus(); }
      else if (ev.key === 'Tab') close();
    });

    // code elsewhere keeps working: sel.value = x, fillOptions(sel, ...), sel.hidden, sel.focus(), mark(sel, ...)
    Object.defineProperty(sel, 'value', {
      configurable: true,
      get: function () { return LK_VALUE.get.call(sel); },
      set: function (v) { LK_VALUE.set.call(sel, v); sync(); }
    });
    sel.focus = function () { text.focus(); };
    sel.scrollIntoView = function (a) { wrap.scrollIntoView(a); };
    new MutationObserver(function () { sync(); }).observe(sel, {
      childList: true, attributes: true, attributeFilter: ['hidden', 'disabled']
    });
    sel._lk = h;
    sync();
  }

  function lookupEnhanceAll() {
    Array.prototype.forEach.call(document.querySelectorAll('#newCustModal select, #itemModal select'), function (s) {
      lookupEnhance(s, s.id === 'nc_terms' ? { newLabel: 'New Payment Term', onNew: openPaymentTermModal } : null);
    });
  }

  document.addEventListener('mousedown', function (ev) {
    if (LK_OPEN && !LK_OPEN.wrap.contains(ev.target)) LK_OPEN.close();
  });
  document.addEventListener('scroll', function (ev) {
    if (LK_OPEN && !LK_OPEN.panel.contains(ev.target)) LK_OPEN.close();
  }, true);
  window.addEventListener('resize', function () { if (LK_OPEN) LK_OPEN.close(); });

  /* ---- New Customer: validation ---- */
  function ncCurrency() {
    return S.currencies.filter(function (c) { return String(c.currency_id) === $('nc_currency').value; })[0] || S.baseCurrency;
  }

  function ncValidate() {
    var errs = [];
    function bad(id, msg) {
      var el = $(id);
      mark(el, msg);
      if (msg) errs.push({ el: el, msg: msg });
    }
    function clear(id) { mark($(id), ''); }
    var prec = (ncCurrency() && ncCurrency().price_precision != null) ? Number(ncCurrency().price_precision) : 2;

    ['nc_displayName', 'nc_email', 'nc_workPhone', 'nc_mobile', 'nc_gstTreatmentText', 'nc_gstin', 'nc_legalName', 'nc_tradeName',
      'nc_pos', 'nc_pan', 'nc_exemption', 'nc_credit', 'nc_obAmt', 'nc_portal'].forEach(clear);

    if (!nv('nc_displayName')) bad('nc_displayName', 'Display name is required');
    else if (nv('nc_displayName').length > 200) bad('nc_displayName', 'Display name is too long (max 200)');

    var em = nv('nc_email');
    if (em && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) bad('nc_email', 'Enter a valid email address');

    [['nc_workPhone', 'work phone'], ['nc_mobile', 'mobile number']].forEach(function (p) {
      var v = nv(p[0]);
      if (!v) return;
      var digits = v.replace(/\D/g, '');
      if (!/^[0-9 ()+\-]+$/.test(v) || digits.length < 6 || digits.length > 15) bad(p[0], 'Enter a valid ' + p[1]);
    });

    if ($('nc_portal').checked && !em) bad('nc_portal', 'An email address is required to enable portal access');

    if (NC.gstOn) {
      var r = gstRule();
      if (!r) {
        bad('nc_gstTreatmentText', 'Select a GST treatment');
      } else {
        var g = nv('nc_gstin');
        if (r.reg) {   // GSTIN / legal / trade name are only validated while their rows are visible
          if (!g) { if (r.req) bad('nc_gstin', 'GSTIN is required for this GST treatment'); }
          else if (!GSTIN_RE.test(g)) bad('nc_gstin', 'Enter a valid 15-character GSTIN');
        }
        if (r.pos && !$('nc_pos').value) bad('nc_pos', 'Select the place of supply');
        var pan = nv('nc_pan');
        if (pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) bad('nc_pan', 'Enter a valid 10-character PAN');
        else if (pan && r.reg && GSTIN_RE.test(g) && g.slice(2, 12) !== pan) bad('nc_pan', 'PAN does not match the GSTIN');
      }
    }

    if (ncTax() === 'exempt' && NC.exemptions.length && !$('nc_exemption').value) bad('nc_exemption', 'Select an exemption reason');

    [['nc_credit', 'Credit limit'], ['nc_obAmt', 'Opening balance']].forEach(function (p) {
      var v = nv(p[0]);
      if (!v) return;
      var n = toNum(v);
      if (!isFinite(n)) bad(p[0], p[1] + ' must be a number');
      else if (n < 0) bad(p[0], p[1] + ' cannot be negative');
      else if (decimals(v) > prec) bad(p[0], 'Maximum ' + prec + ' decimal places');
    });

    NC.cfDefs.forEach(function (d) {
      var el = $('ncf_' + d.customfield_id);
      if (!el || el.type === 'checkbox') return;
      var v = el.value.trim();
      mark(el, '');
      if (v === '') return;
      if (/number|decimal|amount|percent|integer/.test(d.data_type) && !isFinite(toNum(v))) bad(el.id, d.label + ' must be a number');
      else if (d.data_type === 'date' && !validISODate(v)) bad(el.id, d.label + ' must be a valid date');
    });

    ['nb', 'ns'].forEach(function (p) {
      var z = $(p + '_zip');
      mark(z, '');
      if (z && z.value.trim().length > 20) bad(z.id, 'Pin code is too long');
    });
    return errs;
  }

  function ncShowFirstError(errs) {
    Array.prototype.forEach.call(document.querySelectorAll('.nc-tab'), function (t) { t.classList.remove('has-err'); });
    errs.forEach(function (e) {
      var pane = e.el.closest('.nc-pane');
      if (pane) {
        var tab = document.querySelector('.nc-tab[data-pane="' + pane.dataset.pane + '"]');
        if (tab) tab.classList.add('has-err');
      }
    });
    var f = errs[0], pane = f.el.closest('.nc-pane');
    if (pane) ncSwitchTab(pane.dataset.pane);
    if (f.el.scrollIntoView) f.el.scrollIntoView({ block: 'center' });
    if (f.el.focus) f.el.focus();
    $('newCustStatus').textContent = errs.length + ' field(s) need attention: ' + f.msg;
  }

  /* ---- New Customer: payload ---- */
  function ncPhone(codeId, numId) {
    var n = nv(numId);
    if (!n) return '';
    return CONFIG.phoneWithCode ? ($(codeId).value + ' ' + n) : n;
  }

  function ncAddress(prefix) {
    var o = {}, any = false;
    ADDR_KEYS.forEach(function (k) {
      var v = $(prefix + '_' + k[0]).value.trim();
      if (v) { o[k[0]] = v; any = true; }
    });
    if (o.state && /^india$/i.test(o.country || '')) {
      var st = STATES_IN.filter(function (s) { return s[1].toLowerCase() === o.state.toLowerCase(); })[0];
      if (st) o.state_code = st[0];
    }
    return any ? o : null;
  }

  function ncPayload() {
    var cur = ncCurrency();
    var p = {
      contact_type: 'customer',
      customer_sub_type: ncType(),
      contact_name: nv('nc_displayName')
    };
    if (nv('nc_companyName')) p.company_name = nv('nc_companyName');
    if (nv('nc_website')) p.website = nv('nc_website');
    if (nv('nc_facebook')) p.facebook = nv('nc_facebook');
    if (nv('nc_twitter')) p.twitter = nv('nc_twitter');
    if ($('nc_language').value) p.language_code = $('nc_language').value;

    if (cur) {
      p.currency_id = String(cur.currency_id);
      if (S.baseCurrency && String(cur.currency_id) !== String(S.baseCurrency.currency_id) && cur.exchange_rate != null) {
        p.exchange_rate = Number(cur.exchange_rate);
      }
    }

    var term = ncTermById($('nc_terms').value);
    if (term) { p.payment_terms = term.days; p.payment_terms_label = term.label; }
    if (nv('nc_credit')) p.credit_limit = toNum(nv('nc_credit'));
    if ($('nc_priceList').value) p.pricebook_id = $('nc_priceList').value;
    if ($('nc_receivable') && !$('ncArRow').hidden && $('nc_receivable').value) p.receivable_account_id = $('nc_receivable').value;
    if (nv('nc_obAmt')) {
      if (S.locations.length) p.opening_balances = [{ location_id: String($('nc_obLoc').value), opening_balance_amount: toNum(nv('nc_obAmt')) }];
      else p.opening_balance_amount = toNum(nv('nc_obAmt'));
    }

    // tax
    p.is_taxable = ncTax() === 'taxable';
    if (!p.is_taxable && $('nc_exemption').value) p.tax_exemption_id = $('nc_exemption').value;
    if (NC.gstOn) {
      var r = gstRule();
      p.gst_treatment = r.api;
      if (r.reg) {
        if (nv('nc_gstin')) p.gst_no = nv('nc_gstin');
        if (nv('nc_legalName')) p.legal_name = nv('nc_legalName');
        if (nv('nc_tradeName')) p.trade_name = nv('nc_tradeName');
      }
      if (r.pos && $('nc_pos').value) p.place_of_contact = $('nc_pos').value;
      if (nv('nc_pan')) p.pan_no = nv('nc_pan');
    }

    // primary contact person
    var cp = {}, any = false;
    [
      ['salutation', nv('nc_salutation')], ['first_name', nv('nc_firstName')], ['last_name', nv('nc_lastName')], ['email', nv('nc_email')],
      ['phone', ncPhone('nc_workCode', 'nc_workPhone')], ['mobile', ncPhone('nc_mobCode', 'nc_mobile')],
      ['designation', nv('nc_desig')], ['department', nv('nc_dept')], ['skype', nv('nc_skype')]
    ].forEach(function (x) {
      if (x[1]) { cp[x[0]] = x[1]; any = true; }
    });
    if ($('nc_portal').checked) { cp.enable_portal = true; any = true; }
    if (any) { cp.is_primary_contact = true; p.contact_persons = [cp]; }

    var b = ncAddress('nb'), s = ncAddress('ns');
    if (b) p.billing_address = b;
    if (s) p.shipping_address = s;

    var cfs = [];
    NC.cfDefs.forEach(function (d) {
      var el = $('ncf_' + d.customfield_id);
      if (!el) return;
      var v = el.type === 'checkbox' ? (el.checked ? 'true' : '') : el.value.trim();
      if (v !== '') cfs.push({ customfield_id: d.customfield_id, value: v });
    });
    if (cfs.length) p.custom_fields = cfs;

    var tags = [];
    S.tags.forEach(function (t) {
      var el = $('nct_' + t.tag_id);
      if (el && el.value) tags.push({ tag_id: String(t.tag_id), tag_option_id: el.value });
    });
    if (tags.length) p.tags = tags;

    if (nv('nc_remarks')) p.notes = nv('nc_remarks');
    return p;
  }

  /* ---- New Customer: save ---- */
  function ncDone(c) {
    NC.saving = false;
    $('newCustSave').disabled = false;
    mergeCustomers([c]);
    $('newCustModal').hidden = true;
    $('customer').value = c.contact_name || '';
    mark($('customer'), '');
    selectCustomer(c);
  }

  function ncVerifyAfterUncertain(name) {
    $('newCustStatus').textContent = 'No confirmation received – checking Zoho Books…';
    return api('GET', '/contacts', { contact_name_contains: name, contact_type: 'customer', per_page: 10 }).then(function (j) {
      var hit = firstArray(j, 'contacts').filter(function (c) {
        return String(c.contact_name || '').toLowerCase() === name.toLowerCase();
      })[0];
      if (hit) { ncDone(hit); return; }
      NC.saving = false;
      $('newCustSave').disabled = false;
      $('newCustStatus').textContent = 'Zoho Books did not confirm the customer was created. Check the Customers list before saving again.';
    }, function () {
      NC.saving = false;
      $('newCustSave').disabled = false;
      $('newCustStatus').textContent = 'Could not confirm whether the customer was created. Check the Customers list before saving again.';
    });
  }

  function saveNewCustomer() {
    if (NC.saving) return;
    var errs = ncValidate();
    if (errs.length) { ncShowFirstError(errs); return; }

    NC.saving = true;   // synchronous lock: blocks double clicks / Enter repeats
    $('newCustSave').disabled = true;
    Array.prototype.forEach.call(document.querySelectorAll('.nc-tab'), function (t) { t.classList.remove('has-err'); });
    $('newCustStatus').textContent = 'Creating customer…';
    var payload = ncPayload();
    if (CONFIG.debug) console.log('%c[Create customer payload]', 'color:#7a3db8', payload);

    api('POST', '/contacts', {}, payload).then(function (res) {
      var c = res && res.contact;
      if (!c || !c.contact_id) throw mkErr('unconfirmed', 'Zoho Books did not return the created customer.', true);
      ncDone(c);
    }).catch(function (e) {
      if (CONFIG.debug) console.warn('[SOWidget] create customer failed', e, e && e.json);
      if (e && e.uncertain) { ncVerifyAfterUncertain(payload.contact_name); return; }
      NC.saving = false;
      $('newCustSave').disabled = false;
      $('newCustStatus').textContent = 'Save failed: ' + errText(e);
    });
  }

  /* ================= SALES ORDER: payment terms + warehouse list ================= */
  // Options = same list as the customer form (ncTermsList); value = days.
  function soFillTerms(days) {
    var sel = $('payTerms'), cur = days != null ? String(days) : sel.value, seen = {}, pairs = [];
    ncTermsList().forEach(function (t) {
      if (!seen[t.days]) { seen[t.days] = 1; pairs.push([String(t.days), t.label]); }
    });
    if (cur !== '' && !seen[cur]) pairs.push([cur, Number(cur) === 0 ? 'Due on Receipt' : 'Net ' + cur]);
    fillOptions(sel, pairs, 'Select payment terms');
    sel.value = cur;
  }

  // Child warehouses are listed under their parent, if the API returns parent_location_id.
  // Zoho native look: primary location has no bullet, all others are prefixed
  // with "• " and suffixed with " (Warehouse)".
  function soLocList() {
    return S.locations.map(function (l) {
      var primary = !!l.is_primary; 
      return {
        location_id: l.location_id,
        location_name: (primary ? '' : '\u2022 ') + l.location_name + (primary ? '' : ' (Warehouse)'),
        is_primary: primary,
        parent_location_id: l.parent_location_id
      };
    });
  }

  /* ================= NEW ITEM MODAL ================= */
  var NI = { built: false, saving: false, row: null, accounts: [], vendors: [], cfDefs: [], loading: null };
  var UNITS = ['box', 'cm', 'dz', 'ft', 'g', 'in', 'kg', 'km', 'lb', 'm', 'mg', 'ml', 'pcs'];

  function niRow(label, id, ctl, req) {
    return '<div class="nc-row"><label class="nc-l' + (req ? ' req' : '') + '" for="' + id + '">' + label + (req ? '*' : '') +
      '</label><div class="nc-c">' + ctl + '</div></div>';
  }
  function niInp(id, x) { return '<input type="text" id="' + id + '" class="w-main" autocomplete="off" ' + (x || '') + '>'; }
  function niSel(id, cls) { return '<select id="' + id + '" class="' + (cls || 'w-main') + '"></select>'; }
  function niCur(id) {
    return '<div class="addon w-main"><span class="addon-t ni-cur"></span><input type="text" id="' + id + '" inputmode="decimal"></div>';
  }
  function niRadios(name, opts) {
    return '<div class="nc-line">' + opts.map(function (o) {
      return '<label class="radio"><input type="radio" name="' + name + '" value="' + o[0] + '"' + (o[2] ? ' checked' : '') + '> ' + o[1] + '</label>';
    }).join('') + '</div>';
  }
  function niVal(name) {
    var r = document.querySelector('input[name="' + name + '"]:checked');
    return r ? r.value : '';
  }
  function niSetRadio(name, v) {
    var r = document.querySelector('input[name="' + name + '"][value="' + v + '"]');
    if (r) r.checked = true;
  }

  function niBuild() {
    var gst = detectGst(), h = '';

    h += '<div class="ni-top"><div>' +
      niRow('Name', 'ni_name', niInp('ni_name'), 1) +
      niRow('Type', '', niRadios('ni_type', [['goods', 'Goods', 1], ['service', 'Service']])) +
      niRow('Category', 'ni_cat', '<input type="text" id="ni_cat" class="w-main" disabled placeholder="Not available via API">') +
      niRow('Brand', 'ni_brand', niInp('ni_brand', 'placeholder="Brand"')) +
      niRow('Manufacturer', 'ni_mfr', niInp('ni_mfr')) +
      (gst ? niRow('HSN Code', 'ni_hsn', niInp('ni_hsn', 'maxlength="10"')) : '') +
      niRow('Tax Preference', 'ni_tax', niSel('ni_tax'), 1) +
      '<div class="nc-row" id="niExRow" hidden><label class="nc-l req" for="ni_exempt">Exemption Reason*</label><div class="nc-c">' + niSel('ni_exempt') + '</div></div>' +
      '</div><div class="ni-img"><div class="ni-ph">Front / rear / other images<br><small>Image upload is not available from this widget. Add images in Zoho Books after saving.</small></div></div></div>';

    h += '<div class="ni-sec"><h4>Item Details</h4>' +
      niRow('Item Type', '', '<div class="nc-line"><span class="ni-chip">Single Item</span><span class="ni-chip off" title="Variants are not supported by this widget">Contains Variants</span></div>') +
      '<div class="ni-2">' + niRow('Unit', 'ni_unit', niInp('ni_unit', 'list="niUnits"'), 1) + niRow('SKU', 'ni_sku', niInp('ni_sku')) + '</div>' +
      '<datalist id="niUnits">' + UNITS.map(function (u) { return '<option value="' + u + '">'; }).join('') + '</datalist>' +
      niRow('Description', 'ni_desc', '<textarea id="ni_desc" rows="2" class="w-main"></textarea>') + '</div>';

    h += '<div class="ni-sec"><h4><label class="radio"><input type="checkbox" id="ni_sell" checked> Sales Information</label></h4><div id="niSellBox">' +
      '<div class="ni-2">' + niRow('Selling Price', 'ni_rate', niCur('ni_rate'), 1) + niRow('Account', 'ni_sellAcc', niSel('ni_sellAcc'), 1) + '</div>' +
      niRow('Description', 'ni_sellDesc', '<textarea id="ni_sellDesc" rows="2" class="w-main"></textarea>') + '</div></div>';

    h += '<div class="ni-sec"><h4><label class="radio"><input type="checkbox" id="ni_buy" checked> Purchase Information</label></h4><div id="niBuyBox">' +
      '<div class="ni-2">' + niRow('Cost Price', 'ni_cost', niCur('ni_cost'), 1) + niRow('Account', 'ni_buyAcc', niSel('ni_buyAcc'), 1) + '</div>' +
      '<div class="ni-2">' + niRow('Description', 'ni_buyDesc', '<textarea id="ni_buyDesc" rows="2" class="w-main"></textarea>') +
      niRow('Preferred Vendor', 'ni_vendor', niSel('ni_vendor')) + '</div></div></div>';

    h += '<div class="ni-sec"><h4>Default Tax Rates</h4>' + (gst
      ? '<div class="ni-2">' + niRow('Intra State Tax Rate', 'ni_taxIntra', niSel('ni_taxIntra')) + niRow('Inter State Tax Rate', 'ni_taxInter', niSel('ni_taxInter')) + '</div>'
      : niRow('Tax', 'ni_taxId', niSel('ni_taxId'))) + '</div>';

    h += '<div class="ni-sec" id="niInvWrap"><h4><label class="radio"><input type="checkbox" id="ni_track"> Track Inventory for this item</label></h4><div id="niInvBox" hidden>' +
      niRow('Inventory Tracking', '', niRadios('ni_trk', [['none', 'None', 1], ['serial', 'Serial'], ['batch', 'Batch']])) +
      '<div class="ni-2">' + niRow('Inventory Account', 'ni_invAcc', niSel('ni_invAcc'), 1) +
      niRow('Reorder Point', 'ni_reorder', niInp('ni_reorder', 'inputmode="decimal"')) + '</div></div></div>';

    h += '<div class="ni-sec" id="niRet"><h4>Cancellation and Returns</h4>' +
      niRow('Returnable Item', '', niRadios('ni_ret', [['1', 'Yes', 1], ['0', 'No']])) + '</div>';

    h += '<div class="ni-sec" id="niFul"><h4>Fulfilment Details</h4><div class="ni-2">' +
      niRow('Dimensions', 'ni_len', '<div class="nc-line"><input type="text" id="ni_len" class="ni-dim" placeholder="L" inputmode="decimal"><input type="text" id="ni_wid" class="ni-dim" placeholder="W" inputmode="decimal"><input type="text" id="ni_hgt" class="ni-dim" placeholder="H" inputmode="decimal">' + niSel('ni_dimU', 'w-code') + '</div><div class="hint">(Length X Width X Height)</div>') +
      niRow('Weight', 'ni_wt', '<div class="nc-line"><input type="text" id="ni_wt" class="ni-dim" inputmode="decimal">' + niSel('ni_wtU', 'w-code') + '</div>') +
      '</div></div>';

    h += '<div class="ni-sec"><h4>Additional Information</h4><div id="niCf" class="ni-2"></div></div>' +
      '<div class="ni-sec"><h4>Associated Tags</h4><div id="niTags" class="ni-2"></div></div>';

    $('niBody').innerHTML = h;
  }

  function niSync() {
    var svc = niVal('ni_type') === 'service', track = !svc && $('ni_track').checked;
    if (track) { $('ni_sell').checked = true; $('ni_buy').checked = true; }
    $('ni_sell').disabled = $('ni_buy').disabled = track;
    $('niSellBox').hidden = !$('ni_sell').checked;
    $('niBuyBox').hidden = !$('ni_buy').checked;
    $('niInvWrap').hidden = svc;
    $('niInvBox').hidden = !track;
    $('niRet').hidden = svc;
    $('niFul').hidden = svc;
    $('niExRow').hidden = $('ni_tax').value !== 'exempt';
  }

  // All lookups are optional; every call may fail.
  function niLoad() {
    if (NI.loading) return NI.loading;
    var jobs = [];

    jobs.push(api('GET', '/chartofaccounts', { filter_by: 'AccountType.Active', per_page: 200 }).then(function (j) {
      NI.accounts = firstArray(j, 'chartofaccounts');
    }).catch(function () {}));

    jobs.push(api('GET', '/contacts', { contact_type: 'vendor', filter_by: 'Status.Active', per_page: 200, sort_column: 'contact_name' }).then(function (j) {
      NI.vendors = firstArray(j, 'contacts');
    }).catch(function () {}));

    // custom-field definitions come from the newest item
    jobs.push(api('GET', '/items', { per_page: 1, sort_column: 'created_time', sort_order: 'D' }).then(function (j) {
      var f = firstArray(j, 'items')[0];
      if (!f) return;
      return api('GET', '/items/' + f.item_id).then(function (r) {
        NI.cfDefs = ((r.item && r.item.custom_fields) || [])
          .filter(function (cf) { return cf.customfield_id !== undefined; })
          .map(function (cf) {
            return {
              customfield_id: String(cf.customfield_id),
              label: cf.label || ('Custom field ' + cf.customfield_id),
              data_type: String(cf.data_type || '').toLowerCase()
            };
          });
      });
    }).catch(function () {}));

    jobs.push(Promise.resolve(loadNcRefs()));   // tax exemptions
    NI.loading = Promise.all(jobs);
    return NI.loading;
  }

  function niPopulate() {
    var code = S.baseCurrency ? S.baseCurrency.currency_code : '';
    Array.prototype.forEach.call(document.querySelectorAll('#itemModal .ni-cur'), function (e) { e.textContent = code; });

    function acc(types) {
      return NI.accounts.filter(function (a) { return types.indexOf(a.account_type) > -1; })
        .map(function (a) { return [a.account_id, a.account_name]; });
    }
    function pick(id, pairs, name) {
      fillOptions($(id), pairs, 'Select an account');
      var m = pairs.filter(function (p) { return p[1].toLowerCase() === name; })[0];
      if (m) $(id).value = String(m[0]);
    }

    pick('ni_sellAcc', acc(['income', 'other_income']), 'sales');
    pick('ni_buyAcc', acc(['cost_of_goods_sold', 'expense', 'other_expense']), 'cost of goods sold');
    pick('ni_invAcc', acc(['stock']), '');
    fillOptions($('ni_vendor'), NI.vendors.map(function (v) { return [v.contact_id, v.contact_name]; }), '');

    var tx = S.taxes.map(function (t) { return [t.tax_id, t.tax_name + ' (' + t.tax_percentage + '%)']; });
    ['ni_taxIntra', 'ni_taxInter', 'ni_taxId'].forEach(function (id) {
      if ($(id)) fillOptions($(id), tx, 'Select a tax');
    });
    fillOptions($('ni_tax'), [['taxable', 'Taxable'], ['exempt', 'Non-Taxable']], null);
    fillOptions($('ni_exempt'), exemptionPairs(), 'Select an exemption');
    fillOptions($('ni_dimU'), [['cm', 'cm'], ['in', 'in']], null);
    fillOptions($('ni_wtU'), [['kg', 'kg'], ['g', 'g'], ['lb', 'lb'], ['oz', 'oz']], null);

    var cf = $('niCf');
    cf.innerHTML = '';
    NI.cfDefs.forEach(function (d) {
      var chk = /check/.test(d.data_type), row = mk('div', { class: 'nc-row' }, cf);
      mk('label', { class: 'nc-l', htmlFor: 'nif_' + d.customfield_id, text: d.label }, row);
      var c = mk('div', { class: 'nc-c' }, row);
      mk('input', {
        type: chk ? 'checkbox' : (d.data_type === 'date' ? 'date' : 'text'),
        id: 'nif_' + d.customfield_id,
        class: chk ? '' : 'w-main'
      }, c);
    });
    if (!NI.cfDefs.length) mk('div', { class: 'hint', text: 'No item custom fields found (they are read from your newest item).' }, cf);

    var tg = $('niTags');
    tg.innerHTML = '';
    if (!S.tags.length) mk('div', { class: 'hint', text: 'No reporting tags are configured.' }, tg);
    S.tags.forEach(function (t) {
      var row = mk('div', { class: 'nc-row' }, tg);
      mk('label', { class: 'nc-l', htmlFor: 'nit_' + t.tag_id, text: t.tag_name }, row);
      var sel = mk('select', { id: 'nit_' + t.tag_id, class: 'w-main' }, mk('div', { class: 'nc-c' }, row));
      fillOptions(sel, t.options.map(function (o) { return [o.tag_option_id, o.tag_option_name || o.option_name || o.tag_option_id]; }), 'None');
      lookupEnhance(sel);
    });
    niSync();
  }

  function niWire() {
    if (NI.built) return;
    NI.built = true;
    niBuild();
    lookupEnhanceAll();
    $('niBody').addEventListener('change', niSync);
    $('niSave').addEventListener('click', niSave);
    $('niCancel').addEventListener('click', closeItemModal);
    $('niClose').addEventListener('click', closeItemModal);
    $('itemModal').addEventListener('mousedown', function (ev) { if (ev.target === $('itemModal')) closeItemModal(); });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !$('itemModal').hidden && !LK_OPEN) closeItemModal();
    });
  }

  function closeItemModal() {
    if (!NI.saving) $('itemModal').hidden = true;
  }

  function openItemModal(row) {
    niWire();
    NI.row = row || null;
    var m = $('itemModal');
    Array.prototype.forEach.call(m.querySelectorAll('input[type=text], input[type=date], textarea'), function (el) {
      if (!el.disabled) el.value = '';
      el.classList.remove('invalid');
    });
    Array.prototype.forEach.call(m.querySelectorAll('.fe'), function (e) { e.remove(); });
    niSetRadio('ni_type', 'goods');
    niSetRadio('ni_trk', 'none');
    niSetRadio('ni_ret', '1');
    $('ni_sell').checked = true;
    $('ni_buy').checked = true;
    $('ni_track').checked = false;
    niSync();
    m.hidden = false;
    NI.saving = false;
    $('niSave').disabled = true;
    $('niStatus').textContent = 'Loading…';
    niLoad().then(function () {
      niPopulate();
      $('niSave').disabled = false;
      $('niStatus').textContent = '';
      $('ni_name').focus();
    });
  }

  function niValidate() {
    var errs = [], prec = precision();
    function bad(id, msg) {
      var el = $(id);
      mark(el, msg);
      errs.push({ el: el, msg: msg });
    }
    Array.prototype.forEach.call(document.querySelectorAll('#itemModal input, #itemModal select, #itemModal textarea'), function (el) {
      if (el.classList.contains('invalid')) mark(el, '');
    });
    function num(id, label, req) {
      var v = nv(id);
      if (v === '') { if (req) bad(id, label + ' is required'); return; }
      var n = toNum(v);
      if (!isFinite(n) || n < 0) bad(id, label + ' must be 0 or more');
      else if (decimals(v) > prec && req) bad(id, 'Maximum ' + prec + ' decimal places');
    }

    var goods = niVal('ni_type') === 'goods', sell = $('ni_sell').checked, buy = $('ni_buy').checked;
    if (!nv('ni_name')) bad('ni_name', 'Name is required');
    if (!nv('ni_unit')) bad('ni_unit', 'Unit is required');
    if (!sell && !buy) bad('ni_sell', 'Select sales and/or purchase information');
    if (sell) {
      num('ni_rate', 'Selling price', true);
      if (!$('ni_sellAcc').value) bad('ni_sellAcc', 'Select an account');
    }
    if (buy) {
      num('ni_cost', 'Cost price', true);
      if (!$('ni_buyAcc').value) bad('ni_buyAcc', 'Select an account');
    }
    if ($('ni_tax').value === 'exempt' && NC.exemptions.length && !$('ni_exempt').value) bad('ni_exempt', 'Select an exemption reason');
    if (goods && $('ni_track').checked && !$('ni_invAcc').value) bad('ni_invAcc', 'Select an inventory account');
    if (goods) ['ni_reorder', 'ni_len', 'ni_wid', 'ni_hgt', 'ni_wt'].forEach(function (id) { num(id, 'Value', false); });

    NI.cfDefs.forEach(function (d) {
      var el = $('nif_' + d.customfield_id);
      if (!el || el.type === 'checkbox') return;
      var v = el.value.trim();
      if (v === '') return;
      if (/number|decimal|amount|percent|integer/.test(d.data_type) && !isFinite(toNum(v))) bad(el.id, d.label + ' must be a number');
      else if (d.data_type === 'date' && !validISODate(v)) bad(el.id, d.label + ' must be a valid date');
    });
    return errs;
  }

  function niPayload() {
    var goods = niVal('ni_type') === 'goods', sell = $('ni_sell').checked, buy = $('ni_buy').checked, track = goods && $('ni_track').checked;
    var p = { name: nv('ni_name'), product_type: niVal('ni_type'), unit: nv('ni_unit') };
    p.item_type = track ? 'inventory' : (sell && buy ? 'sales_and_purchases' : (sell ? 'sales' : 'purchases'));

    ['sku:ni_sku', 'hsn_or_sac:ni_hsn', 'brand:ni_brand', 'manufacturer:ni_mfr'].forEach(function (x) {
      var k = x.split(':'), el = $(k[1]);
      if (el && el.value.trim()) p[k[0]] = el.value.trim();
    });

    var d = nv('ni_sellDesc') || nv('ni_desc');
    if (d) p.description = d;
    if (sell) { p.rate = toNum(nv('ni_rate')); p.account_id = $('ni_sellAcc').value; }
    if (buy) {
      p.purchase_rate = toNum(nv('ni_cost'));
      p.purchase_account_id = $('ni_buyAcc').value;
      if (nv('ni_buyDesc')) p.purchase_description = nv('ni_buyDesc');
      if ($('ni_vendor').value) p.vendor_id = $('ni_vendor').value;
    }

    p.is_taxable = $('ni_tax').value !== 'exempt';
    if (!p.is_taxable && $('ni_exempt').value) p.tax_exemption_id = $('ni_exempt').value;
    if ($('ni_taxId') && $('ni_taxId').value) p.tax_id = $('ni_taxId').value;

    var pref = [];
    if ($('ni_taxIntra') && $('ni_taxIntra').value) pref.push({ tax_id: $('ni_taxIntra').value, tax_specification: 'intra' });
    if ($('ni_taxInter') && $('ni_taxInter').value) pref.push({ tax_id: $('ni_taxInter').value, tax_specification: 'inter' });
    if (pref.length) p.item_tax_preferences = pref;

    if (track) {
      p.inventory_account_id = $('ni_invAcc').value;
      if (nv('ni_reorder')) p.reorder_level = toNum(nv('ni_reorder'));
      if (niVal('ni_trk') === 'serial') p.track_serial_number = true;
      if (niVal('ni_trk') === 'batch') p.track_batch_number = true;
    }

    if (goods) {
      p.is_returnable = niVal('ni_ret') === '1';
      var L = nv('ni_len'), W = nv('ni_wid'), H = nv('ni_hgt'), wt = nv('ni_wt');
      if (L || W || H || wt) {
        var pk = {};
        if (L) pk.length = toNum(L);
        if (W) pk.width = toNum(W);
        if (H) pk.height = toNum(H);
        if (L || W || H) pk.dimension_unit = $('ni_dimU').value;
        if (wt) { pk.weight = toNum(wt); pk.weight_unit = $('ni_wtU').value; }
        p.package_details = pk;
      }
    }

    var cfs = [];
    NI.cfDefs.forEach(function (c) {
      var el = $('nif_' + c.customfield_id);
      if (!el) return;
      var v = el.type === 'checkbox' ? (el.checked ? 'true' : '') : el.value.trim();
      if (v !== '') cfs.push({ customfield_id: c.customfield_id, value: v });
    });
    if (cfs.length) p.custom_fields = cfs;

    var tags = [];
    S.tags.forEach(function (t) {
      var el = $('nit_' + t.tag_id);
      if (el && el.value) tags.push({ tag_id: String(t.tag_id), tag_option_id: el.value });
    });
    if (tags.length) p.tags = tags;
    return p;
  }

  function niDone(it) {
    NI.saving = false;
    $('niSave').disabled = false;
    $('itemModal').hidden = true;
    if (NI.row) selectItem(NI.row, it);   // fills the row exactly like picking from the dropdown
  }

  function niFail(msg) {
    NI.saving = false;
    $('niSave').disabled = false;
    $('niStatus').textContent = msg;
  }

  function niSave() {
    if (NI.saving) return;
    var errs = niValidate();
    if (errs.length) {
      $('niStatus').textContent = errs.length + ' field(s) need attention: ' + errs[0].msg;
      var el = errs[0].el;
      if (el.scrollIntoView) el.scrollIntoView({ block: 'center' });
      if (el.focus) el.focus();
      return;
    }

    NI.saving = true;
    $('niSave').disabled = true;
    $('niStatus').textContent = 'Creating item…';
    var p = niPayload();
    if (CONFIG.debug) console.log('%c[Create item payload]', 'color:#7a3db8', p);

    api('POST', '/items', {}, p).then(function (res) {
      var it = res && res.item;
      if (!it || !it.item_id) throw mkErr('unconfirmed', 'Zoho Books did not return the created item.', true);
      niDone(it);
    }).catch(function (e) {
      if (e && e.uncertain) {   // same "don't double-create" pattern as customers
        $('niStatus').textContent = 'No confirmation received – checking Zoho Books…';
        return api('GET', '/items', { name_contains: p.name, per_page: 10 }).then(function (j) {
          var hit = firstArray(j, 'items').filter(function (i) {
            return String(i.name || '').toLowerCase() === p.name.toLowerCase();
          })[0];
          if (hit) niDone(hit);
          else niFail('Zoho Books did not confirm the item was created. Check Items before saving again.');
        }, function () {
          niFail('Could not confirm whether the item was created. Check Items before saving again.');
        });
      }
      niFail('Save failed: ' + errText(e));
    });
  }

  /* ================= FORM-WIDE VALIDATION ================= */
  function validateAll() {
    var errs = [], firstBad = null;

    Object.keys(FV).forEach(function (k) {
      var m = checkField(k);
      if (m) { errs.push(m); if (!firstBad) firstBad = $(FV_EL[k]); }
    });

    S.cfDefs.forEach(function (d) {
      var el = $('cf_' + d.customfield_id);
      if (!el) return;
      var v = el.type === 'checkbox' ? '' : el.value.trim(), m = '';
      var type = String(d.data_type || '').toLowerCase();
      if (d.required && el.type !== 'checkbox' && v === '') m = d.label + ' is required';
      else if (v !== '' && /number|decimal|amount|percent|integer/.test(type) && !isFinite(toNum(v))) m = d.label + ' must be a number';
      else if (v !== '' && type === 'date' && !validISODate(v)) m = d.label + ' must be a valid date';
      mark(el, m);
      if (m) { errs.push(m); if (!firstBad) firstBad = el; }
    });

    var live = S.rows.filter(function (r) { return !isPristine(r); });
    if (!live.length) {
      errs.push('Add at least one item');
      if (!firstBad) firstBad = S.rows[0].refs.item;
    }
    S.rows.forEach(function (r) {
      var m = validateRow(r, true);
      if (m.length) { errs = errs.concat(m); if (!firstBad) firstBad = r.refs.item; }
    });
    return { errs: errs, first: firstBad };
  }

  /* ================= PAYLOAD ================= */
  function addrPayload(prefix) {
    var o = {}, any = false;
    ADDR_FIELDS.forEach(function (f) {
      var v = $(prefix + '_' + f[0]).value.trim();
      if (v) { o[f[0]] = v; any = true; }
    });
    return any ? o : null;
  }

  function buildPayload() {
    var p = {
      customer_id: String(S.customer.contact_id),
      date: $('soDate').value,
      currency_id: String(S.currency.currency_id),
      discount_type: $('discLevel').value,
      is_inclusive_tax: $('inclusive').checked
    };
    var v;
    if ((v = $('shipDate').value)) p.shipment_date = v;
    if ((v = $('refNumber').value.trim())) p.reference_number = v;
    if ((v = $('soNumber').value.trim())) p.salesorder_number = v;
    if (!$('exchWrap').hidden) p.exchange_rate = toNum($('exchRate').value);
    if (S.locations.length) p.location_id = String($('location').value);

    if ($('payTerms').value.trim() !== '') {
      var days = parseInt($('payTerms').value, 10);
      p.payment_terms = days;
      var po = $('payTerms').options[$('payTerms').selectedIndex];
      p.payment_terms_label = po ? po.text : (days === 0 ? 'Due on Receipt' : 'Net ' + days);
    }

    if ((v = $('delivery').value.trim())) p.delivery_method = v;
    if (!$('spWrap').hidden && (v = $('salesperson').value)) p.salesperson_id = v;
    if (S.pricebook) p.pricebook_id = String(S.pricebook.pricebook_id);

    if (p.discount_type === 'entity_level') {
      var ed = parseDiscount($('entityDisc').value, currentTotals().subTotal);
      if (ed.text) { p.discount = ed.text; p.is_discount_before_tax = $('beforeTax').checked; }
    }

    var ship = toNum($('shipping').value);
    if (isFinite(ship) && ship !== 0) p.shipping_charge = ship;
    var adj = toNum($('adjustment').value);
    if (isFinite(adj) && adj !== 0) {
      p.adjustment = adj;
      if ($('adjDesc').value.trim()) p.adjustment_description = $('adjDesc').value.trim();
    }
    if ($('notes').value.trim()) p.notes = $('notes').value.trim();
    if ($('terms').value.trim()) p.terms = $('terms').value.trim();

    var cfs = [];

    // "Additional Fields" card — excludes the named inline fields
    S.cfDefs.forEach(function (d) {
      if (NAMED_CF.some(function (n) { return _normLabel(n.label) === _normLabel(d.label); })) return;
      var el = $('cf_' + d.customfield_id);
      if (!el) return;
      var val = el.type === 'checkbox' ? (el.checked ? 'true' : '') : el.value.trim();
      if (val !== '') cfs.push({ customfield_id: String(d.customfield_id), value: val });
    });

    // Named custom fields shown inline in Order Details
    NAMED_CF.forEach(function (n) {
      var el = $(n.slot);
      if (!el) return;
      var val = String(el.value || '').trim();
      if (val === '') return;
      var def = cfDefByLabel(n.label);
      if (!def) {
        if (CONFIG.debug) console.warn('[SOWidget] named custom field has no matching definition in Zoho:', n.label);
        return;
      }
      cfs.push({ customfield_id: String(def.customfield_id), value: val });
    });

    if (cfs.length) p.custom_fields = cfs;
    if (S.addrDirty.b) { var b = addrPayload('b'); if (b) p.billing_address = b; }
    if (S.addrDirty.s) { var s = addrPayload('s'); if (s) p.shipping_address = s; }

    var order = 0;
    p.line_items = S.rows.filter(function (r) { return !isPristine(r); }).map(function (r) {
      var R = r.refs, li = {
        item_order: ++order,
        item_id: String(r.item.item_id),
        name: r.item.name,
        quantity: toNum(R.qty.value),
        rate: toNum(R.rate.value)
      };
      if (R.desc.value.trim()) li.description = R.desc.value.trim();
      if (r.item.unit) li.unit = r.item.unit;
      if (R.tax.value) li.tax_id = R.tax.value;
      if (p.discount_type === 'item_level') {
        var d = parseDiscount(R.disc.value, li.quantity * li.rate);
        if (d.text && d.value > 0) li.discount = d.text;
      }
      if (S.locations.length) li.location_id = String($('location').value);
      var tags = [];
      Object.keys(r.tags).forEach(function (tid) {
        if (r.tags[tid]) tags.push({ tag_id: String(tid), tag_option_id: String(r.tags[tid]) });
      });
      if (tags.length) li.tags = tags;
      return li;
    });
    return p;
  }

  /* ================= SUBMIT ================= */
  function setBusy(on, msg) {
    $('btnSubmit').disabled = on || S.uncertain || S.submitted;
    $('btnCancel').disabled = on;
    $('status').textContent = msg || '';
  }

  function showBanner(msg) {
    var b = $('banner');
    b.textContent = msg;
    b.hidden = !msg;
    if (msg) b.scrollIntoView({ block: 'nearest' });
  }

  function showSummary(errs) {
    var s = $('summary');
    s.innerHTML = '';
    mk('strong', { text: 'Please fix the following before submitting:' }, s);
    var ul = mk('ul', {}, s);
    errs.slice(0, 12).forEach(function (m) { mk('li', { text: m }, ul); });
    if (errs.length > 12) mk('li', { text: '…and ' + (errs.length - 12) + ' more' }, ul);
    s.hidden = false;
  }

  function serverRevalidate() {
    var ids = {};
    S.rows.filter(function (r) { return !isPristine(r); }).forEach(function (r) { ids[r.item.item_id] = r.item.name; });

    var jobs = [api('GET', '/contacts/' + S.customer.contact_id).then(function (j) {
      if (!j.contact || (j.contact.status && j.contact.status !== 'active')) {
        throw mkErr('data', 'The customer is no longer active in Zoho Books.');
      }
    })];
    Object.keys(ids).forEach(function (id) {
      jobs.push(api('GET', '/items/' + id).then(function (j) {
        if (!j.item || (j.item.status && j.item.status !== 'active')) {
          throw mkErr('data', 'Item "' + ids[id] + '" is no longer active.');
        }
      }));
    });
    return Promise.all(jobs);
  }

  function submit() {
    if (S.submitting || S.submitted || S.uncertain) return;
    S.submitting = true;
    $('btnSubmit').disabled = true;
    showBanner('');
    $('summary').hidden = true;

    var v = validateAll();
    if (v.errs.length) {
      S.submitting = false;
      setBusy(false);
      showSummary(v.errs);
      if (CONFIG.debug) console.log('%c[Validation errors]', 'color:#c0352b', v.errs);
      if (v.first && v.first.focus) { v.first.scrollIntoView({ block: 'center' }); v.first.focus(); }
      return;
    }

    setBusy(true, 'Checking customer and items…');
    serverRevalidate().then(function () {
      var payload = buildPayload();
      S.lastPayload = payload;
      if (CONFIG.debug) console.log('%c[Sales order payload]', 'color:#7a3db8', payload);
      setBusy(true, 'Creating sales order…');
      var q = payload.salesorder_number ? { ignore_auto_number_generation: 'true' } : {};
      return api('POST', '/salesorders', q, payload);
    }).then(function (res) {
      var so = res && res.salesorder;
      if (CONFIG.debug) console.log('%c[Sales order created]', 'color:#1d8a4e', so);
      if (!so || !so.salesorder_id) {
        throw mkErr('unconfirmed', 'Zoho Books replied without the created order.', true);
      }
      onSuccess(so);
    }).catch(function (e) {
      if (CONFIG.debug) console.log('%c[Submit failed]', 'color:#c0352b', e, e && e.json);
      if (e.uncertain && S.lastPayload && e.kind !== 'data') {
        S.uncertain = true;
        S.submitting = false;
        setBusy(false);
        $('uncertain').hidden = false;
        $('uncertain').scrollIntoView({ block: 'nearest' });
        return;
      }
      S.submitting = false;
      setBusy(false);
      showBanner(errText(e));
    });
  }

  function onSuccess(so) {
    S.submitted = true;
    S.submitting = false;
    $('app').hidden = true;
    $('success').hidden = false;

    var cur = so.currency_code || (S.currency && S.currency.currency_code) || '';
    $('okTitle').textContent = 'Sales order ' + (so.salesorder_number || '') + ' created';

    var parts = [];
    if (so.customer_name) parts.push(so.customer_name);
    if (so.total != null) parts.push('Total ' + cur + ' ' + Number(so.total).toFixed(precision()));
    $('okDetail').textContent = parts.join(' · ');

    $('okNote').textContent = (so.total != null && Math.abs(Number(so.total) - S.lastTotal) > 0.005)
      ? 'Zoho Books calculated ' + cur + ' ' + Number(so.total).toFixed(precision()) + ' (estimate on this form: ' + money(S.lastTotal) + '). The Zoho Books total is final.'
      : 'Order ID ' + so.salesorder_id;

    if (CONFIG.autoCloseMs > 0) S.closeTimer = setTimeout(closeWidget, CONFIG.autoCloseMs);
  }

  function closeWidget() {
    clearTimeout(S.closeTimer);
    try {
      var r = ZFAPPS.closeModal();
      if (r && r.catch) r.catch(function () { $('okNote').textContent = 'You can now close this window.'; });
    } catch (e) {
      $('okNote').textContent = 'You can now close this window.';
    }
  }

  function checkRecent() {
    var box = $('recent');
    box.textContent = 'Checking…';
    api('GET', '/salesorders', { customer_id: S.customer.contact_id, sort_column: 'created_time', sort_order: 'D', per_page: 5 })
      .then(function (j) {
        var list = firstArray(j, 'salesorders');
        box.innerHTML = '';
        if (!list.length) { box.textContent = 'No sales orders found for this customer.'; return; }

        var t = mk('table', {}, box), h = mk('tr', {}, mk('thead', {}, t));
        ['Number', 'Date', 'Reference', 'Total', 'Created'].forEach(function (x) { mk('th', { text: x }, h); });
        var tb = mk('tbody', {}, t);
        list.forEach(function (o) {
          var tr = mk('tr', {}, tb);
          [
            o.salesorder_number, o.date, o.reference_number || '',
            (o.currency_code || '') + ' ' + (o.total != null ? o.total : ''), o.created_time || ''
          ].forEach(function (x) { mk('td', { text: String(x) }, tr); });
        });
        mk('p', {
          class: 'hint',
          text: 'This order\'s total was ' + money(S.lastTotal) + ' dated ' + (S.lastPayload ? S.lastPayload.date : '') + '.'
        }, box);
      }, function (e) { box.textContent = 'Could not check: ' + errText(e); });
  }

  /* ================= STATIC UI BUILDERS ================= */
  function buildAddressFields() {
    [['b', 'fsBilling'], ['s', 'fsShipping']].forEach(function (p) {
      var fs = $(p[1]);
      if (!fs) return;
      ADDR_FIELDS.forEach(function (f) {
        var lab = mk('label', { text: f[1] }, fs);
        var inp = mk('input', { type: 'text', id: p[0] + '_' + f[0] }, lab);
        inp.addEventListener('input', function () { S.addrDirty[p[0]] = true; });
      });
    });
  }

  function buildCustomFields() {
    var grid = $('cfGrid');
    if (!grid) return;
    grid.innerHTML = '';
  
    // Exclude the named custom fields (they render inside Order Details)
    var skip = {};
    NAMED_CF.forEach(function (n) { skip[_normLabel(n.label)] = 1; });
    var remaining = S.cfDefs.filter(function (d) {
      return !skip[_normLabel(d.label)];
    });
  
    $('cfCard').hidden = !remaining.length;
    remaining.forEach(function (d) {
      var f = mk('div', { class: 'field' }, grid);
      var type = String(d.data_type || '').toLowerCase();
      var lab = mk('label', { htmlFor: 'cf_' + d.customfield_id, text: d.label || ('Custom field ' + d.customfield_id) }, f);
      if (d.required) mk('span', { class: 'req', text: ' *' }, lab);
      var inp;
      if (type === 'date') inp = mk('input', { type: 'date', id: 'cf_' + d.customfield_id }, f);
      else if (/check/.test(type)) inp = mk('input', { type: 'checkbox', id: 'cf_' + d.customfield_id }, f);
      else inp = mk('input', { type: 'text', id: 'cf_' + d.customfield_id }, f);
      if (/number|decimal|amount|percent|integer/.test(type)) inp.inputMode = 'decimal';
    });
  }

  function fillSelect(sel, list, valKey, labelKey, blankText, selectedVal) {
    sel.innerHTML = '';
    if (blankText !== null) mk('option', { value: '', text: blankText }, sel);
    list.forEach(function (o) { mk('option', { value: String(o[valKey]), text: o[labelKey] }, sel); });
    if (selectedVal !== undefined) sel.value = selectedVal;
  }

  function buildReferenceUI() {
    if (S.salespersons.length) {
      $('spWrap').hidden = false;
      fillSelect($('salesperson'), S.salespersons, 'salesperson_id', 'salesperson_name', '— none —', '');
    }

    if (S.locations.length) {
      $('locWrap').hidden = false;
      var primary = S.locations.filter(function (l) { return l.is_primary; })[0] || S.locations[0];
      fillSelect($('location'), soLocList(), 'location_id', 'location_name', null, String(primary.location_id));
    }

    if (S.pricebooks.length) {
      $('plWrap').hidden = false;
      fillSelect($('priceList'), S.pricebooks.map(function (p) {
        var t = p.pricebook_type === 'fixed_percentage' && p.percentage != null
          ? ' [' + p.percentage + '% ' + (p.is_increase ? 'Markup' : 'Markdown') + ']' : '';
        return { pricebook_id: p.pricebook_id, name: p.name + t };
      }), 'pricebook_id', 'name', 'Select Price List', '');
    }

    buildCustomFields();
    NAMED_CF.forEach(function (n) {
      var def = cfDefByLabel(n.label);
      if (!def && CONFIG.debug) console.warn('[SOWidget] No custom field named "' + n.label + '" found in this Zoho Books org.');
    });
    setCurrency(S.baseCurrency);
    soFillTerms('');
    ['location', 'payTerms', 'salesperson', 'priceList'].forEach(function (id) {
      lookupEnhance($(id), id === 'payTerms'
        ? { newLabel: 'New Payment Term', onNew: function () { openPaymentTermModal('so'); } }
        : null);
    });

    // $('location').addEventListener('change', function () {
    //   var loc = S.locations.filter(function (l) { return String(l.location_id) === $('location').value; })[0];
    //   var h = $('sourceHint');
    //   if (h) h.textContent = loc && (loc.state || loc.state_code) ? 'Source of Supply: ' + (loc.state || loc.state_code) : '';
    // });
    $('location').addEventListener('change', updateSourceHint);
    updateSourceHint();   // fill on initial load
  }

  /* ================= INIT ================= */
  function resizeModal() {
    var MAX_W = 1280, MAX_H = 940, MIN_W = 760, MIN_H = 640;

    var winW = window.innerWidth || window.outerWidth || window.screen.availWidth || 1400;
    var winH = window.innerHeight || window.outerHeight || window.screen.availHeight || 900;

    var pxW = Math.min(MAX_W, Math.max(MIN_W, Math.floor(winW * 0.92)));
    var pxH = Math.min(MAX_H, Math.max(MIN_H, Math.floor(winH * 0.94)));

    var w = CONFIG.modalWidth || (pxW + 'px');
    var h = CONFIG.modalHeight || (pxH + 'px');

    console.log('[SOWidget] RESIZE →', w, h, '(viewport', winW + '×' + winH + ')');

    function retryAsNumbers() {
      try { ZFAPPS.invoke('RESIZE', { width: pxW, height: pxH }); }
      catch (e2) { console.warn('[SOWidget] RESIZE retry threw', e2); }
    }

    try {
      var p = ZFAPPS.invoke('RESIZE', { width: w, height: h });
      if (p && p.then) {
        p.then(
          function () { console.log('%c[SOWidget] RESIZE ok', 'color:#1d8a4e', w, h); },
          function (e) {
            console.warn('[SOWidget] RESIZE rejected, retrying as plain numbers', e);
            retryAsNumbers();
          }
        );
      }
    } catch (e) {
      console.warn('[SOWidget] RESIZE threw', e);
      retryAsNumbers();
    }
  }

  function loadAll() {
    if (typeof ZFAPPS === 'undefined' || !ZFAPPS.extension || typeof ZFAPPS.extension.init !== 'function') {
      console.error('[SOWidget] ZFAPPS SDK not available. Check that zf_sdk.js loaded.');
      var lt = $('loadingText'); if (lt) lt.textContent = 'Zoho SDK not loaded.';
      var rb = $('btnRetry'); if (rb) rb.hidden = false;
      return;
    }

    var loading = $('loading'), app = $('app');
    if (loading) loading.hidden = false;
    if (app) app.hidden = true;
    var retry = $('btnRetry'); if (retry) retry.hidden = true;
    var lt1 = $('loadingText'); if (lt1) lt1.textContent = 'Loading Zoho Books data…';
    var sp = loading && loading.querySelector('.spinner'); if (sp) sp.hidden = false;

    console.log('[SOWidget] init: calling ZFAPPS.extension.init()');

    return ZFAPPS.extension.init().then(function () {
      console.log('[SOWidget] SDK init resolved. Calling RESIZE + get(organization).');
      resizeModal();
      return ZFAPPS.get('organization');
    }).then(function (r) {
      var org = r && r.organization;
      if (CONFIG.debug) console.log('%c[SOWidget] Organization', 'color:#7a3db8', org);
      if (!org || !org.organization_id) throw mkErr('data', 'Could not read the Zoho Books organization.');
      S.orgId = String(org.organization_id);
      S.org = org;
      S.root = deriveRoot(org);
      if (CONFIG.debug) console.log('[SOWidget] API root:', S.root, '| org id:', S.orgId);
      if (!S.root) throw mkErr('data', 'Could not determine the Zoho Books API endpoint. Set CONFIG.apiRootOverride.');
      return Promise.all([loadCurrencies(), loadTaxes()]);
    }).then(function () {
      return Promise.all([
        loadLocations().catch(function () { S.locations = []; }),
        loadPricebooks().catch(function () { S.pricebooks = []; }),
        loadSalespersons().catch(function () { S.salespersons = []; }),
        loadTags().catch(function () { S.tags = []; }),
        loadCustomFieldDefs()
      ]);
    }).then(function () {
      if (CONFIG.debug) {
        console.log('%c[SOWidget] Reference data loaded', 'color:#7a3db8', {
          currencies: S.currencies, taxes: S.taxes, locations: S.locations,
          pricebooks: S.pricebooks, salespersons: S.salespersons, tags: S.tags, customFields: S.cfDefs
        });
      }
      buildReferenceUI();
      initCustomerCache();   // IndexedDB first, Zoho Books API only when nothing is stored
      Promise.resolve(loadNcRefs()).then(function () { soFillTerms(); });
      if (!S.rows.length) addRow();
      recalc();
      if (loading) loading.hidden = true;
      if (app) app.hidden = false;
      var c = $('customer'); if (c) c.focus();   // Enter / click opens the customer list
    }).catch(function (e) {
      console.error('[SOWidget] Startup failed', e);
      var lt2 = $('loadingText'); if (lt2) lt2.textContent = 'Could not start the widget: ' + errText(e);
      var rb2 = $('btnRetry'); if (rb2) rb2.hidden = false;
      var sp2 = document.querySelector('#loading .spinner'); if (sp2) sp2.hidden = true;
    });
  }

  function wire() {
    comboEl = $('combo');
    document.addEventListener('mousedown', function (ev) {
      if (!comboEl) return;
      if (!comboEl.hidden && !comboEl.contains(ev.target) && ev.target !== comboOwner) hideCombo();
    });
    window.addEventListener('resize', hideCombo);

    $('soDate').value = todayISO();
    buildAddressFields();

    wireCustomerPicker();
    $('body').addEventListener('scroll', function () { if (!comboEl.hidden) hideCombo(); });

    ['location', 'soDate', 'shipDate', 'payTerms', 'exchRate', 'shipping', 'adjustment', 'entityDisc'].forEach(function (id) {
      $(id).addEventListener('blur', function () { checkField(id); });
    });
    $('soDate').addEventListener('change', function () { checkField('soDate'); checkField('shipDate'); });
    $('payTerms').addEventListener('change', function () { S.touched.payTerms = true; });
    ['shipping', 'adjustment', 'entityDisc'].forEach(function (id) { $(id).addEventListener('input', recalc); });
    $('beforeTax').addEventListener('change', recalc);
    $('inclusive').addEventListener('change', recalc);

    $('location').addEventListener('change', function () { checkField('location'); });

    $('priceList').addEventListener('change', function () {
      S.touched.priceList = true;
      S.pricebook = S.pricebooks.filter(function (p) { return String(p.pricebook_id) === $('priceList').value; })[0] || null;
      var kept = 0;
      S.rows.forEach(function (r) {
        if (r.rateTouched && r.item) kept++;
        else refreshRate(r);
      });
      $('rowNotice').textContent = kept ? kept + ' row(s) keep the rate you entered manually.' : '';
      recalc();
    });

    $('discLevel').addEventListener('change', function () {
      var entity = $('discLevel').value === 'entity_level';
      $('entityDiscRow').hidden = !entity;
      Array.prototype.forEach.call(document.querySelectorAll('.item-row .c-disc input'), function (i) { i.disabled = entity; });
      $('thDisc').textContent = entity ? '' : 'Discount';
      recalc();
    });

    $('btnAddRow').addEventListener('click', function () {
      var r = addRow();
      r.refs.item.focus();
    });
    $('btnSubmit').addEventListener('click', submit);
    $('soForm').addEventListener('submit', function (e) { e.preventDefault(); });
    $('btnCancel').addEventListener('click', function () { closeWidget(); });
    $('btnClose').addEventListener('click', closeWidget);
    $('btnRetry').addEventListener('click', function () { loadAll(); });
    $('btnCheck').addEventListener('click', checkRecent);
    $('btnUnlock').addEventListener('click', function () {
      S.uncertain = false;
      $('uncertain').hidden = true;
      $('recent').innerHTML = '';
      setBusy(false);
    });

    /* ---- New Customer modal: Esc closes, Enter saves (inputs only) ---- */
    document.addEventListener('keydown', function (ev) {
      var ov = $('newCustModal');
      if (!ov || ov.hidden) return;
      if (ev.key === 'Escape') { closeNewCustomerModal(); return; }
      if (ev.key === 'Enter' && ev.target && ev.target.tagName === 'INPUT' && ev.target.type !== 'radio' && ev.target.type !== 'checkbox') {
        ev.preventDefault();
        saveNewCustomer();
      }
    });
  }

  window.SOWidget = { computeTotals: computeTotals, parseDiscount: parseDiscount, priceListRate: priceListRate };

  function boot() {
    console.log('[SOWidget] boot()');
    try { wire(); } catch (e) { console.error('[SOWidget] wire() failed', e); }
    loadAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();