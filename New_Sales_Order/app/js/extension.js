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
    newCustomer: { saving: false },
    submitting: false, submitted: false, uncertain: false,
    lastPayload: null, lastTotal: 0, closeTimer: null
  };

  var ADDR_FIELDS = [
    ['attention', 'Attention'], ['address', 'Street 1'], ['street2', 'Street 2'],
    ['city', 'City'], ['state', 'State'], ['zip', 'ZIP / PIN code'], ['country', 'Country']
  ];

  /* ================= SMALL HELPERS ================= */
  function $(id) { return document.getElementById(id); }
  function mk(tag, props, parent) {
    var e = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      if (k === 'text') e.textContent = props[k];
      else if (k === 'class') e.className = props[k];
      else e[k] = props[k];
    });
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
  function precision() { return (S.currency && S.currency.price_precision != null) ? Number(S.currency.price_precision) : 2; }
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
    var e = new Error(msg); e.kind = kind; e.uncertain = !!uncertain; e.json = json || null; return e;
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
        out.lines.push({ amount: 0 }); nets.push(0); bases.push({ base: 0, pct: 0, id: l.taxId }); return;
      }
      var gross = l.qty * l.rate;
      var d = c.level === 'item_level' ? parseDiscount(l.discount, gross) : { ok: true, amount: 0 };
      var itemDisc = d.ok ? d.amount : 0;
      var net = gross - itemDisc;
      var pct = l.taxPct || 0;
      var base = c.inclusive ? net / (1 + pct / 100) : net;
      out.lines.push({ amount: round(net, p) });
      nets.push(net); bases.push({ base: base, pct: pct, id: l.taxId });
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
      sumBase += rb; taxTotal += t;
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
        for (var i = 0; i < window.location.ancestorOrigins.length; i++) hosts.push(new URL(window.location.ancestorOrigins[i]).hostname);
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
    if (Array.isArray(json[key])) return json[key];
    return [];
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

  /* ================= GENERIC LOOKUP COMBO ================= */
  var comboEl, comboOwner = null;
  function hideCombo() { comboEl.hidden = true; comboOwner = null; }

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
      comboOwner = input; position(); comboEl.innerHTML = ''; comboEl.hidden = false;
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
      var it = items[i]; if (!it) return;
      input.value = o.label(it);
      hideCombo();
      o.onSelect(it);
    }
    function run() {
      var my = ++token;
      show('Searching…');
      o.fetch(input.value.trim()).then(function (list) {
        if (my !== token || comboOwner !== input) return;
        items = list || []; active = items.length ? 0 : -1;
        if (!items.length) show('No matches found'); else { show(); paintActive(); }
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
    var holder = el.closest('.field') || el.parentNode;
    var fe = holder.querySelector(':scope > .fe');
    if (msg) {
      if (!fe) { fe = mk('div', { class: 'fe' }); holder.appendChild(fe); }
      fe.textContent = msg;
    } else if (fe) { fe.remove(); }
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
      var v = $('shipDate').value; if (!v) return '';
      if (!validISODate(v)) return 'Enter a valid date';
      var d = $('soDate').value;
      return (validISODate(d) && v < d) ? 'Shipment date cannot be before the order date' : '';
    },
    payTerms: function () {
      var s = $('payTerms').value.trim(); if (s === '') return '';
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
      var s = $('shipping').value.trim(); if (s === '') return '';
      var n = toNum(s);
      if (!isFinite(n) || n < 0) return 'Enter 0 or a positive amount';
      return decimals(s) > precision() ? 'Maximum ' + precision() + ' decimal places' : '';
    },
    adjustment: function () {
      var s = $('adjustment').value.trim(); if (s === '') return '';
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
  function checkField(key) { var m = FV[key](); mark($(FV_EL[key]), m); return m; }

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
    R.n = mk('td', { class: 'c-n' }, tr);

    var tdI = mk('td', { class: 'c-item' }, tr);
    R.item = mk('input', { type: 'text', placeholder: 'Type to search items…', autocomplete: 'off' }, tdI);
    R.desc = mk('textarea', { placeholder: 'Description (optional)', rows: 1 }, tdI);
    R.err = mk('div', { class: 'row-err' }, tdI);

    var tdB = mk('td', { class: 'c-brand' }, tr); R.brand = mk('span', { class: 'ro', text: '—' }, tdB);
    var tdS = mk('td', { class: 'c-brand' }, tr); R.sub = mk('span', { class: 'ro', text: '—' }, tdS);

    R.qty = mk('input', { type: 'text', inputMode: 'decimal', value: '1' }, mk('td', { class: 'c-num' }, tr));
    R.rate = mk('input', { type: 'text', inputMode: 'decimal', placeholder: '0.00' }, mk('td', { class: 'c-num' }, tr));
    R.disc = mk('input', { type: 'text', inputMode: 'decimal', placeholder: '0 or 0%' }, mk('td', { class: 'c-disc' }, tr));
    R.disc.disabled = $('discLevel').value === 'entity_level';
    R.tax = mk('select', {}, mk('td', { class: 'c-tax' }, tr)); taxOptions(R.tax, '');
    R.amt = mk('td', { class: 'c-amt', text: money(0) }, tr);
    var tdX = mk('td', { class: 'c-x' }, tr);
    R.del = mk('button', { type: 'button', class: 'icon-btn', title: 'Remove row', innerHTML: '&times;' }, tdX);

    if (S.tags.length) {
      var sr = mk('tr', { class: 'subrow' }, tb);
      var sc = mk('td', { colSpan: 10 }, sr);
      var wrap = mk('div', { class: 'tags' }, sc);
      S.tags.forEach(function (t) {
        var lab = mk('label', { text: t.tag_name }, wrap);
        var sel = mk('select', {}, lab);
        mk('option', { value: '', text: '— none —' }, sel);
        t.options.forEach(function (op) { mk('option', { value: String(op.tag_option_id), text: op.tag_option_name || op.option_name || op.tag_option_id }, sel); });
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
        return [it.sku ? 'SKU ' + it.sku : '', it.rate != null ? 'Rate ' + it.rate : ''].filter(Boolean).join(' · ');
      },
      isSelected: function () { return !!row.item; },
      onEdit: function () { if (row.item) { row.item = null; R.brand.textContent = '—'; R.sub.textContent = '—'; } },
      onSelect: function (it) { selectItem(row, it); }
    });

    R.qty.addEventListener('input', function () { refreshRate(row); onRowChange(row); });
    R.rate.addEventListener('input', function () { row.rateTouched = true; onRowChange(row); });
    R.disc.addEventListener('input', function () { onRowChange(row); });
    R.tax.addEventListener('change', function () { onRowChange(row); });
    R.desc.addEventListener('input', function () { clearRowErr(row); });
    [R.qty, R.rate, R.disc, R.tax, R.item].forEach(function (e) { e.addEventListener('blur', function () { validateRow(row); }); });
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
    row.el.remove(); renumber(); recalc();
  }
  function clearRowErr(row) { row.refs.err.textContent = ''; }

  function selectItem(row, it) {
    var R = row.refs;
    R.item.disabled = true; R.err.textContent = 'Loading item…';
    api('GET', '/items/' + it.item_id).then(function (j) {
      var item = j.item || it;
      if (item.status && item.status !== 'active') throw mkErr('data', 'This item is inactive.');
      row.item = item;
      R.item.value = item.name;
      if (!R.desc.value.trim()) R.desc.value = item.description || '';
      var brand = item.brand || '';
      var subBrand = '';
      (item.custom_fields || []).forEach(function (cf) {
        var label = String(cf.label || cf.placeholder || '').toLowerCase();
        if (/sub[\s_-]*brand/.test(label)) subBrand = cf.value || '';
        else if (!brand && /brand/.test(label)) brand = cf.value || '';
      });
      R.brand.textContent = brand || '—'; R.sub.textContent = subBrand || '—';
      var taxId = item.tax_id != null ? String(item.tax_id) : '';
      if (taxId && !S.taxMap[taxId]) { taxId = ''; R.err.textContent = 'The item\'s default tax is not available – choose a tax.'; }
      else R.err.textContent = '';
      R.tax.value = taxId;
      row.rateTouched = false;
      refreshRate(row, true);
      onRowChange(row);
    }).catch(function (e) {
      row.item = null; R.item.value = '';
      R.err.textContent = 'Could not load item: ' + errText(e);
    }).then(function () { R.item.disabled = false; });
  }

  function refreshRate(row, force) {
    if (!row.item || (row.rateTouched && !force)) return;
    var qty = toNum(row.refs.qty.value);
    var r = priceListRate(row.item, isFinite(qty) && qty > 0 ? qty : 1, S.pricebook, precision());
    if (isFinite(r)) row.refs.rate.value = String(r);
  }

  function onRowChange(row) { clearRowErr(row); [row.refs.qty, row.refs.rate, row.refs.disc, row.refs.item, row.refs.tax].forEach(function (e) { e.classList.remove('invalid'); }); recalc(); }

  function validateRow(row, strict) {
    var R = row.refs, msgs = [];
    var idx = S.rows.indexOf(row) + 1;
    if (!strict && isPristine(row)) return msgs;
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
    } else if (!/^Could not|not available/.test(R.err.textContent)) R.err.textContent = '';
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
    var box = $('tTaxes'); box.innerHTML = '';
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
    $('currencyText').value = S.currency ? S.currency.currency_code + (S.currency.currency_symbol ? ' (' + S.currency.currency_symbol + ')' : '') : '';
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
    if (!S.touched.payTerms) $('payTerms').value = contact.payment_terms != null && contact.payment_terms !== '' ? String(contact.payment_terms) : '';
    if (!S.addrDirty.b) fillAddress('b', contact.billing_address);
    if (!S.addrDirty.s) fillAddress('s', contact.shipping_address);
    if (!S.touched.priceList && contact.pricebook_id) {
      var pb = S.pricebooks.filter(function (p) { return String(p.pricebook_id) === String(contact.pricebook_id); })[0];
      if (pb) { $('priceList').value = String(pb.pricebook_id); S.pricebook = pb; }
    }
    $('customerHint').textContent = contact.company_name && contact.company_name !== contact.contact_name ? contact.company_name : '';
    S.rows.forEach(function (r) { refreshRate(r); r.refs.rate.classList.remove('invalid'); });
    renderRowsPrecision(); recalc();
    checkField('customer');
  }
  function renderRowsPrecision() { $('tCur').textContent = S.currency ? S.currency.currency_code : ''; }

  function selectCustomer(c) {
    S.customer = c; S.contact = null;
    $('customerClear').hidden = false;
    $('customerHint').textContent = 'Loading customer…';
    api('GET', '/contacts/' + c.contact_id).then(function (j) {
      if (!S.customer || String(S.customer.contact_id) !== String(c.contact_id)) return;
      if (!j.contact) throw mkErr('data', 'Customer details were not returned.');
      applyCustomer(j.contact);
    }).catch(function (e) {
      S.customer = null; S.contact = null;
      $('customerHint').textContent = '';
      mark($('customer'), 'Could not load customer: ' + errText(e));
    });
  }
  function clearCustomer() {
    S.customer = null; S.contact = null;
    $('customer').value = ''; $('customerClear').hidden = true; $('customerHint').textContent = '';
    setCurrency(S.baseCurrency);
  }

  /* ================= NEW CUSTOMER MODAL ================= */
  function openNewCustomerModal() {
    if (!$('newCustModal')) return;
    // Reset
    var bizRadio = document.querySelector('input[name="nc_type"][value="business"]');
    if (bizRadio) bizRadio.checked = true;
    ['nc_salutation', 'nc_firstName', 'nc_lastName', 'nc_companyName', 'nc_displayName',
     'nc_email', 'nc_workPhone', 'nc_mobile', 'nc_paymentTerms'].forEach(function (id) {
      var el = $(id); if (el) el.value = '';
    });
    updateNewCustomerRequiredFlags();

    // Currency select
    var curSel = $('nc_currency');
    if (curSel) {
      curSel.innerHTML = '';
      S.currencies.forEach(function (c) {
        mk('option', { value: String(c.currency_id), text: c.currency_code + ' - ' + c.currency_name }, curSel);
      });
      if (S.baseCurrency) curSel.value = String(S.baseCurrency.currency_id);
    }

    // Price list select
    var plSel = $('nc_priceList');
    if (plSel) {
      plSel.innerHTML = '';
      mk('option', { value: '', text: '— none —' }, plSel);
      S.pricebooks.forEach(function (p) {
        mk('option', { value: String(p.pricebook_id), text: p.name }, plSel);
      });
    }

    $('newCustStatus').textContent = '';
    S.newCustomer.saving = false;
    $('newCustSave').disabled = false;

    // Auto-suggest display name when company / last name typed
    var companyIn = $('nc_companyName');
    var lastIn = $('nc_lastName');
    var displayIn = $('nc_displayName');
    var syncDisplay = function () {
      var type = document.querySelector('input[name="nc_type"]:checked').value;
      if (displayIn.dataset.userEdited === '1') return;
      if (type === 'business') displayIn.value = companyIn.value.trim();
      else displayIn.value = [($('nc_firstName').value.trim()), lastIn.value.trim()].filter(Boolean).join(' ');
    };
    if (!companyIn.dataset.syncWired) {
      companyIn.addEventListener('input', syncDisplay);
      lastIn.addEventListener('input', syncDisplay);
      $('nc_firstName').addEventListener('input', syncDisplay);
      displayIn.addEventListener('input', function () { displayIn.dataset.userEdited = '1'; });
      companyIn.dataset.syncWired = '1';
    }
    displayIn.dataset.userEdited = '';

    // Type radios
    Array.prototype.forEach.call(document.querySelectorAll('input[name="nc_type"]'), function (r) {
      if (!r.dataset.wired) {
        r.addEventListener('change', function () {
          updateNewCustomerRequiredFlags();
          displayIn.dataset.userEdited = '';
          syncDisplay();
        });
        r.dataset.wired = '1';
      }
    });

    $('newCustModal').hidden = false;
    setTimeout(function () {
      var firstFocus = document.querySelector('input[name="nc_type"]:checked').value === 'business' ? companyIn : $('nc_firstName');
      if (firstFocus) firstFocus.focus();
    }, 30);
  }

  function updateNewCustomerRequiredFlags() {
    var type = document.querySelector('input[name="nc_type"]:checked').value;
    var compReq = $('nc_companyNameReq');
    var lastReq = $('nc_lastNameReq');
    if (compReq) compReq.hidden = (type !== 'business');
    if (lastReq) lastReq.hidden = (type !== 'individual');
  }

  function closeNewCustomerModal() {
    if (S.newCustomer.saving) return;
    $('newCustModal').hidden = true;
  }

  function saveNewCustomer() {
    if (S.newCustomer.saving) return;

    var type = document.querySelector('input[name="nc_type"]:checked').value;
    var salutation = $('nc_salutation').value;
    var firstName = $('nc_firstName').value.trim();
    var lastName = $('nc_lastName').value.trim();
    var companyName = $('nc_companyName').value.trim();
    var displayName = $('nc_displayName').value.trim();
    var email = $('nc_email').value.trim();
    var work = $('nc_workPhone').value.trim();
    var mobile = $('nc_mobile').value.trim();
    var curId = $('nc_currency').value;
    var terms = $('nc_paymentTerms').value.trim();
    var pl = $('nc_priceList').value;

    // Required
    var contactName = displayName || (type === 'business' ? companyName : [firstName, lastName].filter(Boolean).join(' '));
    if (!contactName) {
      $('newCustStatus').textContent = type === 'business' ? 'Company name is required.' : 'Last name is required.';
      if (type === 'business') $('nc_companyName').focus(); else $('nc_lastName').focus();
      return;
    }

    var payload = {
      contact_type: 'customer',
      contact_name: contactName,
      customer_sub_type: (type === 'business' ? 'business' : 'individual')
    };
    if (salutation) payload.salutation = salutation;
    if (firstName) payload.first_name = firstName;
    if (lastName) payload.last_name = lastName;
    if (companyName) payload.company_name = companyName;
    if (email) payload.email = email;
    if (work) payload.phone = work;
    if (mobile) payload.mobile = mobile;
    if (curId) payload.currency_id = curId;
    if (terms !== '' && /^-?\d+$/.test(terms)) payload.payment_terms = parseInt(terms, 10);
    if (pl) payload.pricebook_id = pl;

    S.newCustomer.saving = true;
    $('newCustSave').disabled = true;
    $('newCustStatus').textContent = 'Creating customer…';

    if (CONFIG.debug) console.log('%c[Create customer payload]', 'color:#7a3db8', payload);

    api('POST', '/contacts', {}, payload).then(function (res) {
      var c = res && res.contact;
      if (!c || !c.contact_id) throw mkErr('data', 'Zoho Books did not return the created customer.');
      S.newCustomer.saving = false;
      $('newCustSave').disabled = false;

      // Close modal, then select the new customer in the form
      $('newCustModal').hidden = true;
      $('customer').value = c.contact_name || contactName;
      $('customerHint').textContent = 'Loading customer…';
      selectCustomer(c);
    }).catch(function (e) {
      S.newCustomer.saving = false;
      $('newCustSave').disabled = false;
      $('newCustStatus').textContent = 'Save failed: ' + errText(e);
      if (CONFIG.debug) console.warn('[SOWidget] create customer failed', e, e && e.json);
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
      var el = $('cf_' + d.customfield_id); if (!el) return;
      var v = el.type === 'checkbox' ? '' : el.value.trim(), m = '';
      var type = String(d.data_type || '').toLowerCase();
      if (d.required && el.type !== 'checkbox' && v === '') m = d.label + ' is required';
      else if (v !== '' && /number|decimal|amount|percent|integer/.test(type) && !isFinite(toNum(v))) m = d.label + ' must be a number';
      else if (v !== '' && type === 'date' && !validISODate(v)) m = d.label + ' must be a valid date';
      mark(el, m);
      if (m) { errs.push(m); if (!firstBad) firstBad = el; }
    });
    var live = S.rows.filter(function (r) { return !isPristine(r); });
    if (!live.length) { errs.push('Add at least one item'); if (!firstBad) firstBad = S.rows[0].refs.item; }
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
      var v = $(prefix + '_' + f[0]).value.trim(); if (v) { o[f[0]] = v; any = true; }
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
    if (($('payTerms').value).trim() !== '') {
      var days = parseInt($('payTerms').value, 10);
      p.payment_terms = days;
      p.payment_terms_label = (S.contact && Number(S.contact.payment_terms) === days && S.contact.payment_terms_label)
        ? S.contact.payment_terms_label : (days === 0 ? 'Due on Receipt' : 'Net ' + days);
    }
    if ((v = $('delivery').value.trim())) p.delivery_method = v;
    if (!$('spWrap').hidden && (v = $('salesperson').value)) p.salesperson_id = v;
    if (S.pricebook) p.pricebook_id = String(S.pricebook.pricebook_id);
    if (p.discount_type === 'entity_level') {
      var ed = parseDiscount($('entityDisc').value, currentTotals().subTotal);
      if (ed.text) { p.discount = ed.text; p.is_discount_before_tax = $('beforeTax').checked; }
    }
    var ship = toNum($('shipping').value); if (isFinite(ship) && ship !== 0) p.shipping_charge = ship;
    var adj = toNum($('adjustment').value);
    if (isFinite(adj) && adj !== 0) { p.adjustment = adj; if (($('adjDesc').value).trim()) p.adjustment_description = $('adjDesc').value.trim(); }
    if (($('notes').value).trim()) p.notes = $('notes').value.trim();
    if (($('terms').value).trim()) p.terms = $('terms').value.trim();

    var cfs = [];
    S.cfDefs.forEach(function (d) {
      var el = $('cf_' + d.customfield_id); if (!el) return;
      var val = el.type === 'checkbox' ? (el.checked ? 'true' : '') : el.value.trim();
      if (val !== '') cfs.push({ customfield_id: String(d.customfield_id), value: val });
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
      Object.keys(r.tags).forEach(function (tid) { if (r.tags[tid]) tags.push({ tag_id: String(tid), tag_option_id: String(r.tags[tid]) }); });
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
    var b = $('banner'); b.textContent = msg; b.hidden = !msg;
    if (msg) b.scrollIntoView({ block: 'nearest' });
  }
  function showSummary(errs) {
    var s = $('summary'); s.innerHTML = '';
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
      if (!j.contact || (j.contact.status && j.contact.status !== 'active')) throw mkErr('data', 'The customer is no longer active in Zoho Books.');
    })];
    Object.keys(ids).forEach(function (id) {
      jobs.push(api('GET', '/items/' + id).then(function (j) {
        if (!j.item || (j.item.status && j.item.status !== 'active')) throw mkErr('data', 'Item "' + ids[id] + '" is no longer active.');
      }));
    });
    return Promise.all(jobs);
  }

  function submit() {
    if (S.submitting || S.submitted || S.uncertain) return;
    S.submitting = true;
    $('btnSubmit').disabled = true;
    showBanner(''); $('summary').hidden = true;

    var v = validateAll();
    if (v.errs.length) {
      S.submitting = false; setBusy(false);
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
        S.uncertain = true; S.submitting = false; setBusy(false);
        $('uncertain').hidden = false; $('uncertain').scrollIntoView({ block: 'nearest' });
        return;
      }
      S.submitting = false; setBusy(false);
      showBanner(errText(e));
    });
  }

  function onSuccess(so) {
    S.submitted = true; S.submitting = false;
    $('app').hidden = true; $('success').hidden = false;
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
    } catch (e) { $('okNote').textContent = 'You can now close this window.'; }
  }

  function checkRecent() {
    var box = $('recent'); box.textContent = 'Checking…';
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
          [o.salesorder_number, o.date, o.reference_number || '', (o.currency_code || '') + ' ' + (o.total != null ? o.total : ''), o.created_time || ''].forEach(function (x) { mk('td', { text: String(x) }, tr); });
        });
        mk('p', { class: 'hint', text: 'This order\'s total was ' + money(S.lastTotal) + ' dated ' + (S.lastPayload ? S.lastPayload.date : '') + '.' }, box);
      }, function (e) { box.textContent = 'Could not check: ' + errText(e); });
  }

  /* ================= STATIC UI BUILDERS ================= */
  function buildAddressFields() {
    [['b', 'fsBilling'], ['s', 'fsShipping']].forEach(function (p) {
      var fs = $(p[1]); if (!fs) return;
      ADDR_FIELDS.forEach(function (f) {
        var lab = mk('label', { text: f[1] }, fs);
        var inp = mk('input', { type: 'text', id: p[0] + '_' + f[0] }, lab);
        inp.addEventListener('input', function () { S.addrDirty[p[0]] = true; });
      });
    });
  }

  function buildCustomFields() {
    var grid = $('cfGrid'); if (!grid) return;
    grid.innerHTML = '';
    $('cfCard').hidden = !S.cfDefs.length;
    S.cfDefs.forEach(function (d) {
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
    if (S.locations.length) {
      $('locWrap').hidden = false;
      var primary = S.locations.filter(function (l) { return l.is_primary; })[0] || S.locations[0];
      fillSelect($('location'), S.locations, 'location_id', 'location_name', null, String(primary.location_id));
    }
    if (S.salespersons.length) {
      $('spWrap').hidden = false;
      fillSelect($('salesperson'), S.salespersons, 'salesperson_id', 'salesperson_name', '— none —', '');
    }
    if (S.pricebooks.length) {
      $('plWrap').hidden = false;
      fillSelect($('priceList'), S.pricebooks, 'pricebook_id', 'name', '— none —', '');
    }
    buildCustomFields();
    setCurrency(S.baseCurrency);
  }

  /* ================= INIT ================= */
  function resizeModal() {
    var MAX_W = 1280;
    var MAX_H = 940;
    var MIN_W = 760;
    var MIN_H = 640;

    var winW = window.innerWidth  || window.outerWidth  || window.screen.availWidth  || 1400;
    var winH = window.innerHeight || window.outerHeight || window.screen.availHeight || 900;

    var pxW = Math.min(MAX_W, Math.max(MIN_W, Math.floor(winW * 0.92)));
    var pxH = Math.min(MAX_H, Math.max(MIN_H, Math.floor(winH * 0.94)));

    var w = CONFIG.modalWidth  || (pxW + 'px');
    var h = CONFIG.modalHeight || (pxH + 'px');

    console.log('[SOWidget] RESIZE →', w, h, '(viewport', winW + '×' + winH + ')');

    try {
      var p = ZFAPPS.invoke('RESIZE', { width: w, height: h });
      if (p && p.then) {
        p.then(
          function () { console.log('%c[SOWidget] RESIZE ok', 'color:#1d8a4e', w, h); },
          function (e) {
            console.warn('[SOWidget] RESIZE rejected, retrying as plain numbers', e);
            try { ZFAPPS.invoke('RESIZE', { width: pxW, height: pxH }); } catch (e2) { console.warn('[SOWidget] RESIZE retry threw', e2); }
          }
        );
      }
    } catch (e) {
      console.warn('[SOWidget] RESIZE threw', e);
      try { ZFAPPS.invoke('RESIZE', { width: pxW, height: pxH }); } catch (e2) { console.warn('[SOWidget] RESIZE retry threw', e2); }
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
    var lt = $('loadingText'); if (lt) lt.textContent = 'Loading Zoho Books data…';
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
      if (CONFIG.debug) console.log('%c[SOWidget] Reference data loaded', 'color:#7a3db8', {
        currencies: S.currencies, taxes: S.taxes, locations: S.locations,
        pricebooks: S.pricebooks, salespersons: S.salespersons, tags: S.tags, customFields: S.cfDefs
      });
      buildReferenceUI();
      if (!S.rows.length) addRow();
      recalc();
      if (loading) loading.hidden = true;
      if (app) app.hidden = false;
      var c = $('customer'); if (c) c.focus();
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

    attachCombo($('customer'), {
      fetch: function (q) {
        return api('GET', '/contacts', { contact_type: 'customer', status: 'active', search_text: q, per_page: CONFIG.searchPageSize })
          .then(function (j) { return firstArray(j, 'contacts'); });
      },
      label: function (c) { return c.contact_name; },
      sub: function (c) { return [c.company_name !== c.contact_name ? c.company_name : '', c.email].filter(Boolean).join(' · '); },
      isSelected: function () { return !!S.customer; },
      onEdit: function () { if (S.customer) { S.customer = null; S.contact = null; $('customerHint').textContent = ''; } },
      onSelect: selectCustomer,
      newLabel: '+ New Customer',
      onNew: openNewCustomerModal
    });
    $('customerClear').addEventListener('click', function () { clearCustomer(); $('customer').focus(); });

    $('customer').addEventListener('blur', function () { setTimeout(function () { if (comboEl.hidden) checkField('customer'); }, 150); });
    ['location', 'soDate', 'shipDate', 'payTerms', 'exchRate', 'shipping', 'adjustment', 'entityDisc'].forEach(function (id) {
      $(id).addEventListener('blur', function () { checkField(id); });
    });
    $('soDate').addEventListener('change', function () { checkField('soDate'); checkField('shipDate'); });
    $('payTerms').addEventListener('input', function () { S.touched.payTerms = true; });
    ['shipping', 'adjustment', 'entityDisc'].forEach(function (id) { $(id).addEventListener('input', recalc); });
    $('beforeTax').addEventListener('change', recalc);
    $('inclusive').addEventListener('change', recalc);

    $('location').addEventListener('change', function () { checkField('location'); });

    $('priceList').addEventListener('change', function () {
      S.touched.priceList = true;
      S.pricebook = S.pricebooks.filter(function (p) { return String(p.pricebook_id) === $('priceList').value; })[0] || null;
      var kept = 0;
      S.rows.forEach(function (r) { if (r.rateTouched && r.item) kept++; else refreshRate(r); });
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

    $('btnAddRow').addEventListener('click', function () { var r = addRow(); r.refs.item.focus(); });
    $('btnSubmit').addEventListener('click', submit);
    $('soForm').addEventListener('submit', function (e) { e.preventDefault(); });
    $('btnCancel').addEventListener('click', function () { closeWidget(); });
    $('btnClose').addEventListener('click', closeWidget);
    $('btnRetry').addEventListener('click', function () { loadAll(); });
    $('btnCheck').addEventListener('click', checkRecent);
    $('btnUnlock').addEventListener('click', function () {
      S.uncertain = false; $('uncertain').hidden = true; $('recent').innerHTML = ''; setBusy(false);
    });

    /* ---- New Customer modal wiring ---- */
    var ncClose = $('newCustClose'); if (ncClose) ncClose.addEventListener('click', closeNewCustomerModal);
    var ncCancel = $('newCustCancel'); if (ncCancel) ncCancel.addEventListener('click', closeNewCustomerModal);
    var ncSave = $('newCustSave'); if (ncSave) ncSave.addEventListener('click', saveNewCustomer);
    var ncOverlay = $('newCustModal');
    if (ncOverlay) ncOverlay.addEventListener('mousedown', function (ev) { if (ev.target === ncOverlay) closeNewCustomerModal(); });

    document.addEventListener('keydown', function (ev) {
      if (!ncOverlay || ncOverlay.hidden) return;
      if (ev.key === 'Escape') { closeNewCustomerModal(); return; }
      if (ev.key === 'Enter' && ev.target && ev.target.tagName !== 'TEXTAREA' && ev.target.tagName !== 'BUTTON') {
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
  window.addEventListener('load', function () {
    if (!$('app') || $('app').hidden === undefined) return;
    if ($('loading') && !$('loading').hidden && $('app') && $('app').hidden) { /* noop */ }
  });
})();