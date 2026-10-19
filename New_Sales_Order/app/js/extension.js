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
    customFieldOverrides: [],
    shipGstFields: null,
    uiApiRoot: 'https://books.zoho.com/api/v3'
  };

  /* ================= STATE ================= */
  var S = {
    root: '', orgId: '',
    currencies: [], baseCurrency: null, currency: null,
    taxes: [], taxMap: {}, tdsTaxes: [], tcsTaxes: [], taxesLoaded: false,
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
      if (b.id) out.taxes[b.id] = (out.taxes[b.id] || 0) + t;    });

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
    // var opts = {
    //   // url: S.root + path, method: method, url_query: q,
    //   url: /^https?:/.test(path) ? path : S.root + path,
    //   connection_link_name: CONFIG.connectionLinkName
    // };

    var opts = {
      url: /^https?:/.test(path) ? path : S.root + path,
      method: method,
      url_query: q,
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

  function txClassify(t) {
    if (t.is_tds === true) return 'tds';
    if (t.is_tcs === true) return 'tcs';
    var re = /(^|_)(tds|tcs)($|_)/, kind = 'tax';
    [t.tax_type, t.tax_specific_type].forEach(function (v) {
      var m = re.exec(String(v || '').toLowerCase());
      if (m && kind === 'tax') kind = m[2];
    });
    return kind;
  }

  function txActive(t) {
    return t.status !== 'inactive' && t.is_inactive !== true;
  }

  function txPickList(j, key) {
    if (key && Array.isArray(j[key])) return j[key];
    var out = null;
    Object.keys(j || {}).forEach(function (k) {
      if (!out && Array.isArray(j[k]) && j[k].length && j[k][0] && j[k][0].tax_id !== undefined) out = j[k];
    });
    return out || [];
  }

  function txFetchAll(path, extra, key) {
    var all = [], page = 1;
    function next() {
      var q = { per_page: 200, page: page };
      Object.keys(extra || {}).forEach(function (k) { q[k] = extra[k]; });
      return api('GET', path, q).then(function (j) {
        var list = txPickList(j, key);
        all = all.concat(list);
        if (j.page_context && j.page_context.has_more_page) {
          if (!list.length) throw mkErr('data', 'Tax list pagination reported more results but returned an empty page.');
          page++;
          return next();
        }
        return all;
      });
    }
    return next();
  }

  function txDebugTaxes(rows) {
    var kinds = {};
    rows.forEach(function (t) {
      var k = (t.tax_type || '-') + ' | ' + (t.tax_specific_type || '-');
      kinds[k] = (kinds[k] || 0) + 1;
    });
    console.log('%c[SOWidget] /settings/taxes: ' + rows.length + ' rows. "tax_type | tax_specific_type" counts:', 'color:#7a3db8', kinds);
    console.log('[SOWidget] classified -> regular:', S.taxes.length, 'TDS:', S.tdsTaxes.length, 'TCS:', S.tcsTaxes.length);
    if (rows[0]) console.log('[SOWidget] first raw tax row (check the field names):', rows[0]);
  }

  // TDS / TCS rates come from the same /settings/taxes endpoint, but only when the
  // is_tds_request / is_tcs_request flag is sent (same as the Deluge test calls).
  function txLoadWithholding(kind) {
    var extra = { filter_by: 'Taxes.All', usestate: 'false', per_page: 100 };
    extra[kind === 'tds' ? 'is_tds_request' : 'is_tcs_request'] = 'true';
    return txFetchAll('/settings/taxes', extra, '').then(function (list) {
      list = list.filter(txActive);
      if (CONFIG.debug) {
        console.log('%c[SOWidget] ' + kind.toUpperCase() + ' rates loaded: ' + list.length, 'color:#7a3db8', list);
      }
      return list;
    }).catch(function (e) {
      console.warn('[SOWidget] ' + kind.toUpperCase() + ' list failed:', e);
      return [];
    });
  }

  function txMerge(target, list) {
    list.forEach(function (t) {
      var dup = target.some(function (x) { return String(x.tax_id) === String(t.tax_id); });
      if (!dup) target.push(t);
    });
  }

  function loadTaxes(force) {
    if (S.taxesLoaded && !force) return Promise.resolve();
    return Promise.all([
      txFetchAll('/settings/taxes', {}, 'taxes'),
      txLoadWithholding('tds'),
      txLoadWithholding('tcs')
    ]).then(function (res) {
      var rows = res[0];
      S.taxes = [];
      S.tdsTaxes = [];
      S.tcsTaxes = [];

      // regular list: anything the plain call marks as TDS/TCS is routed to the right list
      rows.filter(txActive).forEach(function (t) {
        var kind = txClassify(t);
        if (kind === 'tds') txMerge(S.tdsTaxes, [t]);
        else if (kind === 'tcs') txMerge(S.tcsTaxes, [t]);
        else S.taxes.push(t);
      });

      // dedicated TDS / TCS calls
      txMerge(S.tdsTaxes, res[1]);
      txMerge(S.tcsTaxes, res[2]);

      S.taxMap = {};
      S.taxes.forEach(function (t) { S.taxMap[String(t.tax_id)] = t; });
      S.taxesLoaded = true;
      if (CONFIG.debug) txDebugTaxes(rows);
    });
  }

  function loadLocations() {
    return api('GET', '/locations', { is_hierarchical_response: 'true' }).then(function (j) {
      S.locations = firstArray(j, 'locations')
        .filter(function (l) { return !l.parent_location_id && (l.depth || 0) === 0; })       // parents only
        .filter(function (l) { return l.is_location_active !== false && l.status !== 'inactive'; })
        .map(function (l) {
          l.is_primary = !!l.is_primary_location;
          l.children = (l.child_locations || []).filter(function (c) { return c.is_location_active !== false; });
          return l;
        });
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
    var h = $('sourceHint'), sel = $('location');
    if (!h || !sel) return;
    var loc = S.locations.filter(function (l) { return String(l.location_id) === sel.value; })[0];
    h.textContent = (loc && locState(loc)) ? 'Source of Supply: ' + locState(loc) : '';
  }

  /* ================= ITEM ROWS ================= */
  function taxIsGroup(t) {
    return t.tax_type === 'tax_group' || /^gst\d/i.test(String(t.tax_name || ''));
  }
  var TAX_EX = [
    { key: 'nontaxable', label: 'Non-Taxable', re: /non[\s-]?taxable/i, desc: '' },
    { key: 'outofscope', label: 'Out of Scope', re: /out\s*of\s*scope/i,
      desc: "Supplies on which you don't charge any GST or include them in the returns." },
    { key: 'nongst', label: 'Non-GST Supply', re: /non[\s-]?gst/i,
      desc: 'Supplies which do not come under GST such as petroleum products and liquor.' }
  ];

  // real Zoho exemption id for one of the three options (null if the org has no match)
  function exemptionFor(key) {
    var def = TAX_EX.filter(function (x) { return x.key === key; })[0];
    if (!def) return null;
    var hit = (NC.exemptions || []).filter(function (e) {
      return def.re.test(String(e.tax_exemption_code || '') + ' ' + String(e.description || ''));
    })[0];
    return hit ? String(hit.tax_exemption_id) : null;
  }

  function taxIsGroup(t) {
    return t.tax_type === 'tax_group' || /^gst\d/i.test(String(t.tax_name || ''));
  }

  function taxOptions(sel, selected) {
    sel.innerHTML = '';
    if (detectGst()) {
      TAX_EX.forEach(function (x) {
        var o = mk('option', { value: 'ex:' + x.key, text: x.label }, sel);
        if (x.desc) o.dataset.desc = x.desc;
      });
    } else {
      mk('option', { value: '', text: 'No tax' }, sel);
    }
    function add(list, group) {
      list.forEach(function (t) {
        var o = mk('option', { value: String(t.tax_id), text: t.tax_name + ' [' + t.tax_percentage + '%]' }, sel);
        o.dataset.group = group;
      });
    }
    add(S.taxes.filter(taxIsGroup), 'Tax Group');
    add(S.taxes.filter(function (t) { return !taxIsGroup(t); }), 'Tax');
    sel.value = selected || (detectGst() ? 'ex:nontaxable' : '');
  }

  function refreshTaxSelects() {
    S.rows.forEach(function (r) { taxOptions(r.refs.tax, r.refs.tax.value); });
  }

  function refreshTaxSelects() {
    S.rows.forEach(function (r) { taxOptions(r.refs.tax, r.refs.tax.value); });
  }

  function isPristine(r) {
    return !r.item && !r.refs.item.value.trim() && !r.refs.desc.value.trim() && !r.refs.rate.value.trim() &&
      !r.refs.disc.value.trim() && r.refs.qty.value.trim() === '1';
  }

  function addRow() {
    // var row = { id: S.nextRowId++, item: null, rateTouched: false, refs: {}, tags: {} };
    var row = { id: S.nextRowId++, item: null, rateTouched: false, refs: {}, tags: {}, loc: '', pb: null };
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

    /* NEW: X (clear item), three-dot menu, GOODS/SERVICE badge + HSN/SAC + Update */
    R.itemX = mk('button', { type: 'button', class: 'item-x', title: 'Remove item', innerHTML: '&times;', hidden: true }, tdI);
    R.itemMenu = mk('button', { type: 'button', class: 'item-dots', title: 'More', innerHTML: '&#8943;', hidden: true }, tdI);
    R.meta = mk('div', { class: 'item-meta', hidden: true }, tdI);
    R.badge = mk('span', { class: 'type-badge' }, R.meta);
    R.hsnWrap = mk('span', {}, R.meta);
    R.hsnTxt = mk('span', {}, R.hsnWrap);
    R.hsnBtn = mk('button', { type: 'button', class: 'linkbtn', text: ' ✎ Update' }, R.hsnWrap);

    /* 4. Brand chip (Sub-brand removed from UI, stub kept hidden) */
    /* Brand removed from UI; hidden stub keeps old references working */
    R.brand = mk('span', {}, mk('span', { hidden: true }));
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
    R.discMode = mk('select', { class: 'disc-mode', title: 'Percentage or amount' }, discW);
    mk('option', { value: 'pct', text: '%' }, R.discMode);
    R.discSym = mk('option', { value: 'amt', text: curSym() }, R.discMode);
    R.discMode.addEventListener('change', function () { onRowChange(row); });

    /* 8. Tax select */
    var tdT = mk('td', { class: 'c-tax' }, tr);
    R.tax = mk('select', { class: 'cell-sel' }, tdT);
    taxOptions(R.tax, '');
    lookupEnhance(R.tax, { newLabel: 'New Tax', minWidth: 260, onNew: function () { openNewTaxModal(row); } });

    /* 9. Amount */
    R.amt = mk('td', { class: 'c-amt', text: money(0) }, tr);

    /* 10. Delete */
    var tdX = mk('td', { class: 'c-x' }, tr);
    R.del = mk('button', { type: 'button', class: 'row-del', title: 'Remove row', innerHTML: '&times;' }, tdX);

    /* Reporting tags subrow — colspan 10 */
    if (S.tags.length) {
      var sr = mk('tr', { class: 'subrow' }, tb);
      var sc = mk('td', { colSpan: 9 }, sr);
      R.tagBtn = mk('button', { type: 'button', class: 'tag-toggle', innerHTML: '🏷 Reporting Tags <span class="tg-n"></span> ▾' }, sc);
      R.tagBtn.addEventListener('click', function () { openTagModal(row); });
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
          showMeta(row);
        }
      },
      onSelect: function (it) { selectItem(row, it); }
    });
    /* Warehouse in Quantity column */
    /* Warehouse in Quantity column */
    if (S.locations.length) {
      R.loc = mk('select', { class: 'row-sel' }, tdQ);
      fillWh(R.loc, whList($('location').value), $('itemLocation').value);
      row.loc = R.loc.value;
            lookupEnhance(R.loc);
      R.loc.addEventListener('change', function () { row.loc = R.loc.value; });
    }
/* Price list in Rate column */
if (S.pricebooks.length) {
  R.pl = mk('select', { class: 'row-sel' }, tdR);
  fillSelect(R.pl, S.pricebooks.map(pbOpt), 'pricebook_id', 'name', 'Apply Price List',
    S.pricebook ? String(S.pricebook.pricebook_id) : '');
  row.pb = S.pricebook;
  lookupEnhance(R.pl);
  R.pl.addEventListener('change', function () {
    row.pb = S.pricebooks.filter(function (p) { return String(p.pricebook_id) === R.pl.value; })[0] || null;
    if (row.item) { row.rateTouched = false; refreshRate(row, true); }   // rate only, discount untouched
    onRowChange(row);
  });
}

    R.qty.addEventListener('input', function () { refreshRate(row); onRowChange(row); });
    R.rate.addEventListener('input', function () { row.rateTouched = true; onRowChange(row); });
    R.disc.addEventListener('input', function () { onRowChange(row); });
    R.tax.addEventListener('change', function () { onRowChange(row); });
    R.desc.addEventListener('input', function () { clearRowErr(row); });
    [R.qty, R.rate, R.disc, R.tax, R.item].forEach(function (e) {
      e.addEventListener('blur', function () { validateRow(row); });
    });
    R.del.addEventListener('click', function () { removeRow(row); });
    R.itemX.addEventListener('click', function () { clearItem(row); });
    R.itemMenu.addEventListener('click', function () { openRowMenu(row, R.itemMenu); });
    R.hsnBtn.addEventListener('click', function () { openHsnModal(row); });
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

  function selectItem(row, it, qty) {
    var R = row.refs;
    R.item.disabled = true;
    R.err.textContent = 'Loading item…';
    return api('GET', '/items/' + it.item_id).then(function (j) {
      var item = j.item || it;
      if (item.status && item.status !== 'active') throw mkErr('data', 'This item is inactive.');
      row.item = item;
      showMeta(row);
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
      R.tax.value = taxId || (detectGst() ? 'ex:nontaxable' : '');
            if (qty) R.qty.value = String(qty);
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
    var r = priceListRate(row.item, isFinite(qty) && qty > 0 ? qty : 1, row.pb, precision());
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
    else if (detectGst() && !String(row.item.hsn_or_sac || '').trim()) {
      bad(R.item, (row.item.product_type === 'service' ? 'SAC' : 'HSN') + ' code is missing – click "Update" under the item and add it');
    }
    var q = toNum(R.qty.value);
    if (!isFinite(q) || q <= 0) bad(R.qty, 'quantity must be greater than 0');
    else if (decimals(R.qty.value.trim()) > CONFIG.maxQtyDecimals) bad(R.qty, 'quantity allows at most ' + CONFIG.maxQtyDecimals + ' decimals');

    var r = toNum(R.rate.value);
    if (!isFinite(r) || r < 0) bad(R.rate, 'enter a valid rate (0 or more)');
    else if (decimals(R.rate.value.trim()) > precision()) bad(R.rate, 'rate allows at most ' + precision() + ' decimals');

    if (S.currency && R.tax.value && R.tax.value.indexOf('ex:') !== 0 && !S.taxMap[R.tax.value]) bad(R.tax, 'tax is not available');
    if (isFinite(q) && q > 0 && isFinite(r) && r >= 0 && $('discLevel').value === 'item_level') {
      var d = parseDiscount(discText(row), q * r);
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



  /* ---- shared helpers for warehouse / price list / discount ---- */
function askConfirm(msg) {
  return new Promise(function (resolve) {
    $('cfmMsg').textContent = msg;
    $('cfmModal').hidden = false;
    function done(v) {
      $('cfmModal').hidden = true;
      $('cfmYes').onclick = $('cfmNo').onclick = null;
      resolve(v);
    }
    $('cfmYes').onclick = function () { done(true); };
    $('cfmNo').onclick = function () { done(false); };
  });
}
function curSym() { return (S.currency && S.currency.currency_symbol) || '₹'; }
function discText(row) {            // text fed to parseDiscount: "10%" or "10"
  var v = row.refs.disc.value.trim();
  if (v === '' || /%$/.test(v)) return v;
  return row.refs.discMode.value === 'pct' ? v + '%' : v;
}
function pbOpt(p) {
  var t = p.pricebook_type === 'fixed_percentage' && p.percentage != null
    ? ' [' + p.percentage + '% ' + (p.is_increase ? 'Markup' : 'Markdown') + ']' : '';
  return { pricebook_id: p.pricebook_id, name: p.name + t };
}
function setRowLoc(row, v) { row.loc = v; if (row.refs.loc) row.refs.loc.value = v; }
function setRowPb(row, pb) {
  row.pb = pb || null;
  if (row.refs.pl) row.refs.pl.value = pb ? String(pb.pricebook_id) : '';
}
  /* ================= ROW EXTRAS: meta, menu, HSN, tags ================= */
function showMeta(row) {
  var R = row.refs, it = row.item, on = !!it;
  R.itemX.hidden = R.itemMenu.hidden = R.meta.hidden = !on;
  if (!on) return;
  var svc = it.product_type === 'service';
  R.badge.textContent = svc ? 'SERVICE' : 'GOODS';
  R.hsnWrap.hidden = !detectGst();
  var miss = detectGst() && !String(it.hsn_or_sac || '').trim();
  R.hsnWrap.classList.toggle('hsn-missing', miss);
  R.hsnTxt.textContent = (svc ? 'SAC Code: ' : 'HSN Code: ') + (miss ? 'Not added (required)' : it.hsn_or_sac);
}

function clearItem(row) {
  var R = row.refs;
  row.item = null; row.rateTouched = false;
  R.item.value = ''; R.desc.value = ''; R.rate.value = ''; R.tax.value = '';
  R.brand.textContent = ''; R.brand.parentNode.dataset.empty = '1';
  showMeta(row); clearRowErr(row); recalc();
  R.item.focus();               // focus re-opens the item dropdown
}

var MENU = null;
function closeRowMenu() { if (MENU) { MENU.remove(); MENU = null; } }
function openRowMenu(row, btn) {
  closeRowMenu();
  var m = mk('div', { class: 'row-menu' }, document.body), r = btn.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 200)) + 'px';
  m.style.top = (r.bottom + 4) + 'px';
  [['✎  Edit Item', 'edit'], ['🧺  View Item Details', 'view']].forEach(function (x) {
    var b = mk('button', { type: 'button', text: x[0] }, m);
    b.addEventListener('mousedown', function (ev) { ev.preventDefault(); closeRowMenu(); openItemModal(row, x[1]); });
  });
  MENU = m;
}
document.addEventListener('mousedown', function (ev) { if (MENU && !MENU.contains(ev.target)) closeRowMenu(); });

/* ---- HSN / SAC update ---- */
/* ---- HSN / SAC search ---- */
var HS = { row: null, saving: false, wired: false, t: null, items: [], active: -1, token: 0 };

// codes already used on loaded items (fallback / extra suggestions)
function hsnLocal(q) {
  var seen = {}, out = [], svc = HS.row && HS.row.item && HS.row.item.product_type === 'service';
  var pool = [].concat(BK.all || [], S.rows.map(function (r) { return r.item; }).filter(Boolean));
  pool.forEach(function (it) {
    var c = String(it.hsn_or_sac || '').trim();
    if (!c || seen[c]) return;
    if ((it.product_type === 'service') !== !!svc) return;
    if (c.indexOf(q) > -1 || String(it.name || '').toLowerCase().indexOf(q.toLowerCase()) > -1) {
      seen[c] = 1;
      out.push({ code: c, desc: 'Used on item: ' + it.name });
    }
  });
  return out;
}

function hsnSearch(q) {
  var svc = HS.row && HS.row.item && HS.row.item.product_type === 'service';
  return api('GET', '/meta/hsncodes', { search_text: q, country: 'India', is_service_item: svc ? 'true' : 'false' })
    .then(function (j) {
      var arr = null;
      Object.keys(j).forEach(function (k) { if (!arr && Array.isArray(j[k])) arr = j[k]; });
      return (arr || []).map(function (x) {
        return { code: String(x.hsn_or_sac || x.hsn_code || x.code || x.value || ''), desc: x.description || x.name || x.label || '' };
      }).filter(function (x) { return x.code; });
    }, function (e) {
      if (CONFIG.debug) console.warn('[SOWidget] HSN API search failed, using local codes only', e);
      return [];
    })
    .then(function (list) {
      var have = {};
      list.forEach(function (x) { have[x.code] = 1; });
      hsnLocal(q).forEach(function (x) { if (!have[x.code]) list.push(x); });
      return list.slice(0, 50);
    });
}

function hsnDdHide() { $('hsnDd').hidden = true; HS.active = -1; }

function hsnDdPaint(msg) {
  var dd = $('hsnDd');
  dd.innerHTML = '';
  dd.hidden = false;
  if (msg) { mk('div', { class: 'hsn-msg', text: msg }, dd); return; }
  HS.items.forEach(function (x, i) {
    var d = mk('div', { class: 'hsn-opt' + (i === HS.active ? ' active' : '') }, dd);
    d.setAttribute('role', 'option');
    mk('b', { text: x.code }, d);
    if (x.desc) mk('span', { text: x.desc }, d);
    d.addEventListener('mousedown', function (ev) { ev.preventDefault(); hsnPick(i); });
    d.addEventListener('mouseenter', function () { HS.active = i; hsnDdActive(); });
  });
}

function hsnDdActive() {
  Array.prototype.forEach.call($('hsnDd').querySelectorAll('.hsn-opt'), function (n, i) {
    n.classList.toggle('active', i === HS.active);
    if (i === HS.active && n.scrollIntoView) n.scrollIntoView({ block: 'nearest' });
  });
}

function hsnPick(i) {
  var x = HS.items[i];
  if (!x) return;
  $('hsnInput').value = x.code;
  mark($('hsnInput'), '');
  $('hsnStatus').textContent = '';
  hsnDdHide();
  $('hsnInput').focus();
}

function hsnWire() {
  if (HS.wired) return;
  HS.wired = true;
  var inp = $('hsnInput');

  inp.addEventListener('input', function () {
    clearTimeout(HS.t);
    var q = inp.value.trim(), my = ++HS.token;
    mark(inp, '');
    if (q.length < 3) { HS.items = []; hsnDdHide(); $('hsnStatus').textContent = 'Type at least 3 characters to search'; return; }
    $('hsnStatus').textContent = '';
    hsnDdPaint('Searching…');
    HS.t = setTimeout(function () {
      hsnSearch(q).then(function (list) {
        if (my !== HS.token) return;                 // stale result
        HS.items = list;
        HS.active = list.length ? 0 : -1;
        if (list.length) hsnDdPaint(); else hsnDdPaint('No matching HSN/SAC codes found');
      });
    }, 300);
  });

  inp.addEventListener('keydown', function (ev) {
    var open = !$('hsnDd').hidden && HS.items.length;
    if (ev.key === 'ArrowDown' && open) { ev.preventDefault(); HS.active = Math.min(HS.items.length - 1, HS.active + 1); hsnDdActive(); }
    else if (ev.key === 'ArrowUp' && open) { ev.preventDefault(); HS.active = Math.max(0, HS.active - 1); hsnDdActive(); }
    else if (ev.key === 'Enter' && open && HS.active >= 0) { ev.preventDefault(); hsnPick(HS.active); }
    else if (ev.key === 'Escape' && !$('hsnDd').hidden) { ev.preventDefault(); ev.stopPropagation(); hsnDdHide(); }
  });

  inp.addEventListener('blur', function () { setTimeout(hsnDdHide, 150); });
}

function openHsnModal(row) {
  if (!row.item) return;
  HS.row = row;
  hsnWire();
  HS.items = [];
  HS.token++;
  $('hsnLbl').textContent = row.item.product_type === 'service' ? 'SAC Code' : 'HSN Code';
  $('hsnInput').value = row.item.hsn_or_sac || '';
  hsnDdHide();
  $('hsnStatus').textContent = 'Type at least 3 characters to search';
  mark($('hsnInput'), '');
  $('hsnModal').hidden = false;
  $('hsnInput').focus();
}
function hsnSave() {
  if (HS.saving) return;
  var row = HS.row, it = row.item, v = $('hsnInput').value.trim(), svc = it.product_type === 'service';
  if (!v) { mark($('hsnInput'), (svc ? 'SAC' : 'HSN') + ' code is required'); return; }
  if (!(svc ? /^\d{6}$/.test(v) : /^(\d{4}|\d{6}|\d{8})$/.test(v))) {
    mark($('hsnInput'), svc ? 'SAC must be 6 digits' : 'HSN must be 4, 6 or 8 digits'); return;
  }
  mark($('hsnInput'), '');
  HS.saving = true; $('hsnSave').disabled = true; $('hsnStatus').textContent = 'Saving…';

  api('PUT', '/items/' + it.item_id, {}, { name: it.name, rate: Number(it.rate), hsn_or_sac: v }).then(function (res) {
    var saved = String((res && res.item && res.item.hsn_or_sac) || v);
    // update every row that uses the same item, not just this one
    S.rows.forEach(function (r) {
      if (r.item && String(r.item.item_id) === String(it.item_id)) {
        r.item.hsn_or_sac = saved;
        showMeta(r);
        r.refs.item.classList.remove('invalid');
        if (/code is missing/.test(r.refs.err.textContent)) r.refs.err.textContent = '';
      }
    });
    $('hsnModal').hidden = true;
  }).catch(function (e) {
    $('hsnStatus').textContent = 'Update failed: ' + errText(e);
  }).then(function () { HS.saving = false; $('hsnSave').disabled = false; });
}

/* ---- Per-row Reporting Tags popup ---- */
var TG = { row: null };
function updateTagCount(row) {
  var n = Object.keys(row.tags).filter(function (k) { return row.tags[k]; }).length;
  if (row.refs.tagBtn) row.refs.tagBtn.querySelector('.tg-n').textContent = n ? '(' + n + ')' : '';
}
function openTagModal(row) {
  TG.row = row;
  var grid = $('tagGrid'); grid.innerHTML = '';
  if (!S.tags.length) mk('div', { class: 'hint', text: 'No reporting tags with options were found.' }, grid);
  S.tags.forEach(function (t) {
    var f = mk('div', { class: 'tg-f' }, grid);
    mk('label', { text: t.tag_name + (t.is_mandatory ? ' *' : '') }, f);
    var sel = mk('select', { id: 'rt_' + t.tag_id }, f);
    fillOptions(sel, t.options.map(function (o) {
      return [o.tag_option_id, o.tag_option_name || o.option_name || o.tag_option_id];
    }), '— none —');
    sel.value = row.tags[t.tag_id] || '';
    lookupEnhance(sel);
  });
  $('tagStatus').textContent = ''; $('tagModal').hidden = false;
}
function tagSave() {
  var row = TG.row, missing = '';
  S.tags.forEach(function (t) {
    var el = $('rt_' + t.tag_id);
    if (el && t.is_mandatory && !el.value && !missing) missing = t.tag_name;
  });
  if (missing) { $('tagStatus').textContent = missing + ' is required'; return; }
  S.tags.forEach(function (t) { var el = $('rt_' + t.tag_id); if (el) row.tags[t.tag_id] = el.value; });
  updateTagCount(row);
  $('tagModal').hidden = true;
}

/* ================= TDS / TCS ================= */
var TX = { saving: false, wired: false, sections: {} };
function txMode() { return document.querySelector('input[name="tds_tcs"]:checked').value; }
function txList(m) {
  return (m || txMode()) === 'tds' ? S.tdsTaxes : S.tcsTaxes;
}
function txFill(selectedId) {
  var sel = $('tdsTax');
  if (!sel) return;
  var list = txList();
  if (!list.length) {
    sel.innerHTML = '';
    sel.value = '';
    txLabels();
    return;
  }
  fillOptions(sel, list.map(function (t) {
    return [t.tax_id, t.tax_name + ' [' + t.tax_percentage + '%]'];
  }), 'Select a Tax');
  sel.value = selectedId ? String(selectedId) : '';
  txLabels();
}

function txLabels() {
  var sel = $('tdsTax'), lk = sel && sel._lk;
  if (!lk) return;
  var U = txMode().toUpperCase(), panel = lk.panel;
  var btnSpan = panel.querySelector('.lk-foot .combo-new-btn span:last-child');
  if (btnSpan) btnSpan.textContent = 'New ' + U + ' Tax';

  var group = panel.querySelector('.lk-group');
  if (!group) {
    group = mk('div', { class: 'lk-group' });
    panel.insertBefore(group, panel.querySelector('.lk-list'));
  }
  group.textContent = U;

  var note = panel.querySelector('.lk-note');
  if (!note) note = mk('div', { class: 'lk-note' }, panel);
  note.innerHTML = '<b>Note:</b> To view or manage ' + U +
    ', go to <b>Settings &gt; Direct Taxes &gt; ' + U + ' Rates.</b>';
  panel.appendChild(note);
}

function txHint(show) {
  var hint = $('txApiHint');
  if (!hint) {
    var row = $('tdsTax') && $('tdsTax').closest('.t-row');
    if (!row || !row.parentNode) return;
    hint = mk('div', {
      id: 'txApiHint',
      class: 'hint tx-api-hint',
      text: 'TDS/TCS changes the total shown here, but this widget does not save it on the sales order because the documented API has no applicable order-level field.'
    });
    row.parentNode.insertBefore(hint, row.nextSibling);
  }
  hint.hidden = !show;
}

function withholding(t) {
  var m = txMode(), id = $('tdsTax').value;
  var tax = txList(m).filter(function (x) { return String(x.tax_id) === id; })[0] || null;
  txHint(!!tax);
  if (!tax) return { type: m, tax: null, amount: 0, signed: 0 };
  var pct = Number(tax.tax_percentage);
  if (!isFinite(pct)) pct = 0;
  var base = m === 'tds' ? t.subTotal : t.subTotal + t.taxTotal;
  var amt = round(base * pct / 100, precision());
  return { type: m, tax: tax, amount: amt, signed: m === 'tds' ? -amt : amt };
}

// function txSections(mode) {
//   mode = mode === 'tcs' ? 'tcs' : 'tds';
//   if (TX.sections[mode]) return Promise.resolve(TX.sections[mode]);
//   return api('GET', CONFIG.uiApiRoot + '/autocomplete/taxspecifictype', { search_text: '', tax_type: mode, version: 2 })
//     .then(function (j) {
//       TX.sections[mode] = (j.results || []).filter(function (x) { return x.value; }).map(function (x) {
//         return { value: x.value, label: x.section_no || x.value, desc: x.description || '', old: x.old_section_no || '' };
//       });
//       return TX.sections[mode];
      
//     });
// }

// function txFillSections(list, blank) {
//   var sel = $('tx_section');
//   if (!sel) return;
//   if (blank === undefined || blank === null) {
//     blank = txMode() === 'tcs' ? 'Select a Nature of Collection' : 'Select a Section';
//   }
//   sel.innerHTML = '';
//   mk('option', { value: '', text: blank }, sel);
//   (list || []).forEach(function (x) {
//     var o = mk('option', { value: x.value, text: x.label }, sel);
//     o.dataset.desc = x.desc;
//     o.dataset.old = x.old;
//   });
//   sel.value = '';
// }

// function fyStart() {
//   var d = new Date(), y = d.getMonth() < 3 ? d.getFullYear() - 1 : d.getFullYear();
//   return y + '-04-01';
// }

/* ================= REPLACED openTaxModal =================
   The public API cannot create TDS/TCS taxes.
   Show an instruction modal instead of a form.
   ======================================================== */
// function openTaxModal() {
//   var U = txMode().toUpperCase();

//   // Build a simple message modal (reuse the existing #txModal shell)
//   var modal = $('txModal');
//   var body  = modal.querySelector('.modal-body');
//   var foot  = modal.querySelector('.modal-foot');
//   var title = $('txTitle');

//   title.textContent = 'Create ' + U + ' in Zoho Books';
//   body.innerHTML =
//     '<p style="margin:0 0 12px">Zoho Books does not allow creating ' + U +
//     ' rates through the public API.</p>' +
//     '<p style="margin:0 0 12px">Please create the rate manually:</p>' +
//     '<ol style="margin:0 0 12px 18px;padding:0">' +
//       '<li>Go to <b>Settings → Direct Taxes → ' + U + ' Rates</b>.</li>' +
//       '<li>Click <b>+ New ' + U + ' Rate</b>.</li>' +
//       '<li>Enter the name, rate, and section/nature of collection.</li>' +
//       '<li>Save, then return here and click <b>Refresh</b>.</li>' +
//     '</ol>' +
//     '<p class="hint">The newly created rate will appear in the dropdown after refreshing.</p>';

//   foot.innerHTML =
//     '<button type="button" class="btn primary" id="txRefreshBtn">Refresh list</button>' +
//     '<button type="button" class="btn" id="txCancelBtn">Close</button>';

//   // wire buttons
//   $('txRefreshBtn').addEventListener('click', function () {
//     $('txRefreshBtn').disabled = true;
//     $('txCancelBtn').disabled = true;
//     var keep = $('tdsTax').value;
//     loadTaxes(true).then(function () {
//       txFill(keep);
//       recalc();
//       if (txList().length) modal.hidden = true;
//       else body.appendChild(mk('div', {
//         class: 'hint',
//         text: 'No ' + U + ' rates were returned by the API. Check the console for the raw tax response and verify the rate-list endpoint.'
//       }));
//     }).catch(function (e) {
//       // keep the modal open and show an error
//       var err = mk('div', { class: 'banner', text: 'Could not refresh: ' + errText(e) });
//       body.appendChild(err);
//     }).then(function () {
//       $('txRefreshBtn').disabled = false;
//       $('txCancelBtn').disabled = false;
//     });
//   });
//   $('txCancelBtn').addEventListener('click', function () { modal.hidden = true; });

//   modal.hidden = false;
// }
// function txClose() { if (!TX.saving) $('txModal').hidden = true; }

// function txValidate() { return false; }
// function txPayload() { return null; }
// function txSave() { openTaxModal(); }

/* ================= NEW TDS / TCS TAX (POST /settings/taxes) ================= */
var TXM = { wired: false, saving: false, accounts: null, sec: {} };

function fyStart() {
  var d = new Date(), y = d.getMonth() < 3 ? d.getFullYear() - 1 : d.getFullYear();
  return y + '-04-01';
}

function txLoadAccounts() {
  if (TXM.accounts) return Promise.resolve(TXM.accounts);
  return api('GET', '/chartofaccounts', { filter_by: 'AccountType.Active', per_page: 200 }).then(function (j) {
    TXM.accounts = firstArray(j, 'chartofaccounts');
    return TXM.accounts;
  }).catch(function () { TXM.accounts = []; return TXM.accounts; });
}

// Sections depend on the Income Tax Act version (2 = New Income Tax Act 2025, 1 = old Act)
function txSectionList(mode, ver) {
  var key = mode + '_' + ver;
  if (TXM.sec[key]) return Promise.resolve(TXM.sec[key]);
  return api('GET', CONFIG.uiApiRoot + '/autocomplete/taxspecifictype', { search_text: '', tax_type: mode, version: ver })
    .then(function (j) {
      TXM.sec[key] = (j.results || []).filter(function (x) { return x.value; }).map(function (x) {
        return { value: x.value, label: x.section_no || x.value, desc: x.description || '', old: x.old_section_no || '' };
      });
      return TXM.sec[key];
    });
}

function txFillSections(list) {
  var sel = $('tx_section');
  if (!sel) return;
  var U = txMode();
  sel.innerHTML = '';
  mk('option', { value: '', text: U === 'tcs' ? 'Select a Nature of Collection' : 'Select a Section' }, sel);
  (list || []).forEach(function (x) {
    var o = mk('option', { value: x.value, text: x.label }, sel);
    o.dataset.desc = x.desc;
    o.dataset.old = x.old;
  });
  sel.value = '';
}

function txRow(label, id, el, req, hidden) {
  var row = mk('div', { class: 'nc-row' });
  if (hidden) row.hidden = true;
  mk('label', { class: 'nc-l' + (req ? ' req' : ''), htmlFor: id, text: label + (req ? '*' : '') }, row);
  var c = mk('div', { class: 'nc-c' }, row);
  c.appendChild(el);
  return row;
}

function txClose() { if (!TXM.saving) $('txModal').hidden = true; }

function openTaxModal() {
  var mode = txMode(), U = mode.toUpperCase(), modal = $('txModal');
  var body = $('txModalBody'), foot = modal.querySelector('.modal-foot');

  if (!TXM.wired) {
    TXM.wired = true;
    $('txClose').addEventListener('click', txClose);
    modal.addEventListener('mousedown', function (ev) { if (ev.target === modal) txClose(); });
  }

  $('txTitle').textContent = 'New ' + U;
  body.innerHTML = '';
  foot.innerHTML = '';

  /* ---- fields ---- */
  var fName = mk('input', { type: 'text', id: 'tx_name', class: 'w-main', maxLength: 100, autocomplete: 'off' });
  var fRate = mk('input', { type: 'text', id: 'tx_rate', class: 'w-main', inputMode: 'decimal', autocomplete: 'off' });

  var fAct = mk('select', { id: 'tx_act', class: 'w-main' });
  mk('option', { value: '2', text: 'New Income Tax Act 2025' }, fAct);
  mk('option', { value: '1', text: 'Income Tax Act 1961' }, fAct);

  var fSec = mk('select', { id: 'tx_section', class: 'w-main' });
  var fPay = mk('select', { id: 'tx_payable', class: 'w-main' });
  var fRec = mk('select', { id: 'tx_receivable', class: 'w-main' });

  var fHigh = mk('input', { type: 'checkbox', id: 'tx_high' });
  var highWrap = mk('label', { class: 'radio' });
  highWrap.appendChild(fHigh);
  mk('span', { text: ' This is a Higher ' + U + ' Rate' }, highWrap);

  var fWhy = mk('select', { id: 'tx_why', class: 'w-main' });
  mk('option', { value: '', text: 'Select a reason' }, fWhy);
  // "tds_non_pan" is confirmed from your API response; the second value is a guess - edit it if Zoho rejects it
  mk('option', { value: 'tds_non_pan', text: 'Non-furnishing of PAN' }, fWhy);
  mk('option', { value: 'tds_non_filer', text: 'Non-filing of income tax return' }, fWhy);

  var fStart = mk('input', { type: 'date', id: 'tx_start', class: 'w-main', value: fyStart() });
  var fEnd = mk('input', { type: 'date', id: 'tx_end', class: 'w-main' });

  body.appendChild(txRow('Tax Name', 'tx_name', fName, true));
  body.appendChild(txRow('Rate (%)', 'tx_rate', fRate, true));
  body.appendChild(txRow('Applicable Income Tax Act', 'tx_act', fAct, false));
  body.appendChild(txRow(mode === 'tcs' ? 'Nature of Collection' : 'Section', 'tx_section', fSec, true));
  if (mode === 'tds') {
    body.appendChild(txRow('TDS Payable Account', 'tx_payable', fPay, false));
    body.appendChild(txRow('TDS Receivable Account', 'tx_receivable', fRec, false));
  } else {
    body.appendChild(txRow('TCS Payable Account', 'tx_payable', fPay, true));   // one account, must be Other Current Liability
  }
  var highRow = txRow('', 'tx_high', highWrap, false);
  highRow.hidden = mode !== 'tds';
  body.appendChild(highRow);
  var whyRow = txRow('Reason for Higher ' + U + ' Rate', 'tx_why', fWhy, true, true);
  body.appendChild(whyRow);
  mk('h4', { text: 'Applicable Period', style: 'margin:14px 0 6px' }, body);
  body.appendChild(txRow('Start Date', 'tx_start', fStart, false));
  body.appendChild(txRow('End Date', 'tx_end', fEnd, false));

  fHigh.addEventListener('change', function () { whyRow.hidden = !fHigh.checked; });

  /* ---- footer ---- */
  var save = mk('button', { type: 'button', class: 'btn primary', id: 'txSaveBtn', text: 'Save' }, foot);
  var cancel = mk('button', { type: 'button', class: 'btn', id: 'txCancelBtn', text: 'Cancel' }, foot);
  var status = mk('span', { class: 'status', id: 'txStatus' }, foot);
  cancel.addEventListener('click', txClose);
  save.addEventListener('click', txSave);

  /* ---- data ---- */
  save.disabled = true;
  status.textContent = 'Loading…';
  TXM.saving = false;
  (mode === 'tds' ? [fAct, fSec, fPay, fRec, fWhy] : [fAct, fSec, fPay, fWhy]).forEach(function (s) { lookupEnhance(s); });  modal.hidden = false;

  function loadSections() {
    status.textContent = 'Loading sections…';
    return txSectionList(mode, fAct.value).then(function (list) {
      txFillSections(list);
      status.textContent = '';
    }).catch(function (e) {
      txFillSections([]);
      status.textContent = 'Could not load sections: ' + errText(e);
    });
  }
  fAct.addEventListener('change', loadSections);

  Promise.all([txLoadAccounts(), loadSections()]).then(function (res) {
    var all = res[0];
    var acc = all.map(function (a) { return [a.account_id, a.account_name]; });
    if (mode === 'tds') {
      fillOptions(fPay, acc, 'Select an account');
      fillOptions(fRec, acc, 'Select an account');
      var adv = all.filter(function (a) { return /^advance tax$/i.test(a.account_name); })[0];
      if (adv) fRec.value = String(adv.account_id);
    } else {
      var liab = all.filter(function (a) { return a.account_type === 'other_current_liability'; })
        .map(function (a) { return [a.account_id, a.account_name]; });
      fillOptions(fPay, liab.length ? liab : acc, 'Select an account');
    }
    save.disabled = false;
    fName.focus();
  });
}

function txValidate() {
  var errs = [], mode = txMode();
  function bad(id, msg) { mark($(id), msg); errs.push({ el: $(id), msg: msg }); }
  ['tx_name', 'tx_rate', 'tx_section', 'tx_why', 'tx_start', 'tx_end'].forEach(function (id) { mark($(id), ''); });

  var name = nv('tx_name');
  if (!name) bad('tx_name', 'Tax name is required');
  else if (name.length > 100) bad('tx_name', 'Tax name is too long');

  var r = nv('tx_rate'), n = toNum(r);
  if (!r) bad('tx_rate', 'Rate is required');
  else if (!isFinite(n) || n < 0 || n > 100) bad('tx_rate', 'Enter a rate between 0 and 100');
  else if (decimals(r) > 4) bad('tx_rate', 'Maximum 4 decimal places');

  if (!$('tx_section').value) bad('tx_section', 'Select a ' + (mode === 'tcs' ? 'nature of collection' : 'section'));
  if (mode === 'tcs' && !$('tx_payable').value) bad('tx_payable', 'Select the TCS account (Other Current Liability)');
  if (mode === 'tds' && $('tx_high').checked && !$('tx_why').value) bad('tx_why', 'Select a reason for the higher rate');

  var s = $('tx_start').value, e = $('tx_end').value;
  if (s && !validISODate(s)) bad('tx_start', 'Enter a valid date');
  if (e && !validISODate(e)) bad('tx_end', 'Enter a valid date');
  else if (s && e && e < s) bad('tx_end', 'End date cannot be before the start date');

  var dup = txList(mode).some(function (t) { return String(t.tax_name || '').toLowerCase() === name.toLowerCase(); });
  if (name && dup) bad('tx_name', 'A ' + mode.toUpperCase() + ' tax with this name already exists');
  return errs;
}

// function txPayload() {
//   var mode = txMode(), p = {
//     tax_name: nv('tx_name'),
//     tax_percentage: toNum(nv('tx_rate')),
//     tax_type: mode + '_tax',                       // 'tds_tax' / 'tcs_tax'
//     tax_specific_type: $('tx_section').value,
//     tax_specific_type_version: parseInt($('tx_act').value, 10)
//   };
//   if (mode === 'tds') {
//     if ($('tx_receivable').value) p.tax_account_id = $('tx_receivable').value;
//     if ($('tx_payable').value) p.tds_payable_account_id = $('tx_payable').value;
//   } else if ($('tx_payable').value) {
//     p.tax_account_id = $('tx_payable').value;   // TCS: the Other Current Liability account
//   }  if (mode === 'tds' && $('tx_high').checked) p.diff_rate_reason = $('tx_why').value;
//   if ($('tx_start').value) p.start_date = $('tx_start').value;
//   if ($('tx_end').value) p.end_date = $('tx_end').value;
//   return p;
// }

function txPayload() {
  var mode = txMode();
  var p = {
    tax_name: nv('tx_name'),
    tax_percentage: String(nv('tx_rate')),
    tax_type: mode + '_tax',                        // 'tds_tax' / 'tcs_tax'
    tax_specific_type: $('tx_section').value,
    tax_account_id: '',
    diff_rate_reason: '',
    start_date: $('tx_start').value || '',
    end_date: $('tx_end').value || ''
  };

  if (mode === 'tds') {
    if ($('tx_receivable').value) p.tax_account_id = $('tx_receivable').value;
    if ($('tx_payable').value) p.tds_payable_account_id = $('tx_payable').value;
    if ($('tx_high').checked) p.diff_rate_reason = $('tx_why').value;
  } else {
    p.tax_account_id = $('tx_payable').value;       // TCS: the Other Current Liability account
  }

  // Your working payload had no version, which Zoho treats as the new 2025 Act.
  // Only send it when the old Act is selected.
  if ($('tx_act').value === '1') p.tax_specific_type_version = 1;

  return p;
}
function txDone(t, mode) {
  TXM.saving = false;
  var list = mode === 'tds' ? S.tdsTaxes : S.tcsTaxes;
  if (!list.some(function (x) { return String(x.tax_id) === String(t.tax_id); })) list.push(t);
  $('txModal').hidden = true;
  if (txMode() === mode) txFill(t.tax_id);
  recalc();
}

function txSave() {
  if (TXM.saving) return;
  var errs = txValidate(), mode = txMode();
  if (errs.length) {
    $('txStatus').textContent = errs[0].msg;
    if (errs[0].el && errs[0].el.focus) errs[0].el.focus();
    return;
  }
  TXM.saving = true;                                // synchronous lock against double clicks
  $('txSaveBtn').disabled = true;
  $('txStatus').textContent = 'Saving…';
  var p = txPayload();
  if (CONFIG.debug) console.log('%c[Create ' + mode.toUpperCase() + ' payload]', 'color:#7a3db8', p);

  api('POST', '/settings/taxes', {}, p).then(function (res) {
    var t = res && res.tax;
    if (!t || !t.tax_id) throw mkErr('unconfirmed', 'Zoho Books did not return the created tax.', true);
    txDone(t, mode);
  }).catch(function (e) {
    if (CONFIG.debug) console.warn('[SOWidget] create tax failed', e, e && e.json);
    function fail(msg) {
      TXM.saving = false;
      $('txSaveBtn').disabled = false;
      $('txStatus').textContent = msg;
    }
    if (e && e.uncertain) {                         // no confirmation: re-read the list before allowing a retry
      $('txStatus').textContent = 'No confirmation received – checking Zoho Books…';
      return loadTaxes(true).then(function () {
        var hit = txList(mode).filter(function (t) {
          return String(t.tax_name || '').toLowerCase() === p.tax_name.toLowerCase();
        })[0];
        if (hit) txDone(hit, mode);
        else fail('Zoho Books did not confirm the tax was created. Check Direct Taxes in Settings before saving again.');
      }, function () { fail('Could not confirm whether the tax was created. Check Settings before saving again.'); });
    }
    fail('Save failed: ' + errText(e));
  });
}
  /* ================= TOTALS ================= */
  function currentLines() {
    return S.rows.map(function (row) {
      var R = row.refs, t = S.taxMap[R.tax.value];
      return {
        qty: toNum(R.qty.value), rate: toNum(R.rate.value), discount: discText(row),
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
  // inter-state when the Place of Supply state differs from the selected location's state
  function taxIsInter() {
    var pos = $('placeOfSupply') && $('placeOfSupply').value;
    var loc = S.locations.filter(function (l) { return String(l.location_id) === String($('location').value); })[0];
    var sc = loc && loc.address && loc.address.state_code;
    return !!(pos && sc && pos !== sc);
  }

  function fmtPct(n) { return String(round(n, 4)); }

  // GST5 -> CGST2.5 + SGST2.5 (intra) or IGST5 (inter). Non-group taxes stay as they are.
  function taxComponents(tax, inter) {
    var pct = Number(tax.tax_percentage) || 0;
    if (Array.isArray(tax.taxes) && tax.taxes.length) {          // API already returned the group's members
      return tax.taxes.map(function (c) { return { name: c.tax_name, pct: Number(c.tax_percentage) || 0 }; });
    }
    var isGroup = tax.tax_type === 'tax_group' || /^gst\d/i.test(String(tax.tax_name || ''));
    if (!isGroup || !pct) return [{ name: tax.tax_name, pct: pct }];
    if (inter || tax.tax_specification === 'inter') return [{ name: 'IGST' + fmtPct(pct), pct: pct }];
    var h = pct / 2;
    return [{ name: 'CGST' + fmtPct(h), pct: h }, { name: 'SGST' + fmtPct(h), pct: h }];
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
    var inter = taxIsInter(), agg = {}, order = [];
    Object.keys(t.taxes).forEach(function (id) {
      var tx = S.taxMap[id];
      if (!tx) return;
      var comps = taxComponents(tx, inter);
      var sum = comps.reduce(function (a, c) { return a + c.pct; }, 0) || 1;
      comps.forEach(function (c) {
        var key = c.name + '|' + c.pct;                     // same tax on many rows -> one line
        if (!agg[key]) { agg[key] = { name: c.name, pct: c.pct, amt: 0 }; order.push(key); }
        agg[key].amt += t.taxes[id] * c.pct / sum;
      });
    });
    order.forEach(function (k) {
      var a = agg[k], r = mk('div', { class: 't-row' }, box);
      mk('span', { text: a.name + ' [' + fmtPct(a.pct) + '%]' }, r);
      mk('b', { text: money(round(a.amt, precision())) }, r);
    });
    var w = withholding(t), grand = round(t.total + w.signed, precision());
    $('tTds').textContent = w.type === 'tds' ? '- ' + money(w.amount) : money(w.amount);
    $('tTotal').textContent = money(grand);
    $('tCur').textContent = S.currency ? S.currency.currency_code : '';
    S.lastTotal = grand;
  }

  /* ================= CUSTOMER / DEPENDENT FIELDS ================= */
  function setCurrency(cur) {
    var changed = S.currency && cur && String(S.currency.currency_id) !== String(cur.currency_id);
    S.currency = cur || S.baseCurrency;
  
    var label = S.currency
      ? S.currency.currency_code + (S.currency.currency_symbol ? ' (' + S.currency.currency_symbol + ')' : '')
      : '';
  
    // visible Currency field (input)
    var disp = $('currencyTextDisplay');
    if (disp) disp.value = label;
  
    // hint inside the Exchange Rate row (span)
    var hint = $('currencyText');
    if (hint) hint.textContent = label;
  
    var foreign = S.currency && S.baseCurrency && String(S.currency.currency_id) !== String(S.baseCurrency.currency_id);
    $('exchWrap').hidden = !foreign;
    if (foreign) $('exchRate').value = S.currency.exchange_rate != null ? String(S.currency.exchange_rate) : '';
  
    S.rows.forEach(function (r) { if (r.refs.discSym) r.refs.discSym.textContent = curSym(); });
    $('tCur').textContent = S.currency ? S.currency.currency_code : '';
    return changed;
  }

  function fillAddress(prefix, a) {
    ADDR_FIELDS.forEach(function (f) { $(prefix + '_' + f[0]).value = (a && a[f[0]]) || ''; });
  }

  function findCurrencyFor(contact) {
  var id = contact.currency_id || (S.customer && S.customer.currency_id) || '';
  var code = String(contact.currency_code || '').toUpperCase();
  var cur = null;
  if (id) {
    cur = S.currencies.filter(function (c) { return String(c.currency_id) === String(id); })[0] || null;
  }
  if (!cur && code) {
    cur = S.currencies.filter(function (c) { return String(c.currency_code).toUpperCase() === code; })[0] || null;
  }
  if (!cur && CONFIG.debug) {
    console.warn('[SOWidget] Customer currency not found in /settings/currencies:', id, code, contact);
  }
  return cur;
}

  function applyCustomer(contact) {
    S.contact = contact;
    var cur = findCurrencyFor(contact);
    var changed = setCurrency(cur || S.baseCurrency);
    $('rowNotice').textContent = (changed && S.rows.some(function (r) { return !isPristine(r); }))
      ? 'Currency changed to ' + S.currency.currency_code + '. Review the item rates.' : '';

    if (!S.touched.payTerms) {
      soFillTerms(contact.payment_terms != null && contact.payment_terms !== '' ? contact.payment_terms : '');
    }
    if (!S.addrDirty.b) fillAddress('b', contact.billing_address);
    if (!S.addrDirty.s) fillAddress('s', contact.shipping_address);

    // NEW: Populate Place of Supply and Source Location from customer
    if (contact.place_of_contact && $('placeOfSupply')) {
      $('placeOfSupply').value = contact.place_of_contact;
    }
    if (contact.billing_address && contact.billing_address.state_code && $('location')) {
      var sc = contact.billing_address.state_code;
      var curP = S.locations.filter(function (l) { return String(l.location_id) === $('location').value; })[0];
      if (!(curP && curP.address && curP.address.state_code === sc)) {      // keep the current parent if it already matches
        var match = S.locations.filter(function (l) { return l.address && l.address.state_code === sc; })[0];
        if (match) { $('location').value = String(match.location_id); fillWarehouses(); }
      }
    }

    if (!S.touched.priceList && contact.pricebook_id) {
      var pb = S.pricebooks.filter(function (p) { return String(p.pricebook_id) === String(contact.pricebook_id); })[0];
      if (pb) { $('priceList').value = String(pb.pricebook_id); S.pricebook = pb; S.rows.forEach(function (r) { setRowPb(r, pb); }); }
    }

    $('customerHint').textContent = contact.company_name && contact.company_name !== contact.contact_name ? contact.company_name : '';
    S.rows.forEach(function (r) { refreshRate(r); r.refs.rate.classList.remove('invalid'); });
    renderRowsPrecision();
    recalc();
    checkField('customer');
    ciRender();
  }
  function renderRowsPrecision() {
    $('tCur').textContent = S.currency ? S.currency.currency_code : '';
  }

  function selectCustomer(c) {
    ciReset();
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
    ciReset(); ciRender();
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
      status: c.status || 'active', currency_id: c.currency_id || '', currency_code: c.currency_code || '',
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
      Array.prototype.forEach.call(list.querySelectorAll('.lk-item'), function (n, i) { n.classList.toggle('active', i === st.active); });
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
    $('placeOfSupply').addEventListener('change', recalc);
    $('location').addEventListener('change', recalc);
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


    /* ================= NEW TAX (GST component) ================= */
var NT = { saving: false, wired: false, row: null };
var NT_TYPES = [['cgst', 'CGST'], ['sgst', 'SGST'], ['igst', 'IGST'], ['utgst', 'UTGST'], ['cess', 'Cess']];

function ntClose() { if (!NT.saving) $('ntModal').hidden = true; }

function openNewTaxModal(row) {
  NT.row = row || null;
  if (!NT.wired) {
    NT.wired = true;
    $('ntSave').addEventListener('click', ntSave);
    $('ntCancel').addEventListener('click', ntClose);
    $('ntClose').addEventListener('click', ntClose);
    $('ntModal').addEventListener('mousedown', function (ev) { if (ev.target === $('ntModal')) ntClose(); });
    $('ntModal').addEventListener('keydown', function (ev) {
      ev.stopPropagation();
      if (ev.key === 'Escape') { ev.preventDefault(); ntClose(); }
      else if (ev.key === 'Enter' && ev.target.tagName === 'INPUT') { ev.preventDefault(); ntSave(); }
    });
  }
  ['nt_name', 'nt_rate'].forEach(function (id) { $(id).value = ''; mark($(id), ''); });
  fillOptions($('nt_type'), NT_TYPES, 'Select a Tax Type.');
  lookupEnhance($('nt_type'));
  $('nt_type').value = '';
  $('ntStatus').textContent = '';
  NT.saving = false;
  $('ntSave').disabled = false;
  $('ntModal').hidden = false;
  setTimeout(function () { $('nt_name').focus(); }, 30);
}

function ntValidate() {
  var ok = true, name = nv('nt_name'), r = nv('nt_rate'), n = toNum(r);
  mark($('nt_name'), ''); mark($('nt_rate'), '');
  if (!name) { mark($('nt_name'), 'Tax name is required'); ok = false; }
  else if (name.length > 100) { mark($('nt_name'), 'Tax name is too long'); ok = false; }
  else if (S.taxes.some(function (t) { return String(t.tax_name || '').toLowerCase() === name.toLowerCase(); })) {
    mark($('nt_name'), 'A tax with this name already exists'); ok = false;
  }
  if (!r) { mark($('nt_rate'), 'Rate is required'); ok = false; }
  else if (!isFinite(n) || n < 0 || n > 100) { mark($('nt_rate'), 'Enter a rate between 0 and 100'); ok = false; }
  else if (decimals(r) > 4) { mark($('nt_rate'), 'Maximum 4 decimal places'); ok = false; }
  return ok;
}

function ntDone(t) {
  NT.saving = false;
  $('ntSave').disabled = false;
  var id = String(t.tax_id);
  if (!S.taxMap[id]) { S.taxes.push(t); S.taxMap[id] = t; }
  refreshTaxSelects();
  $('ntModal').hidden = true;
  if (NT.row) { NT.row.refs.tax.value = id; onRowChange(NT.row); }   // select the new tax on this row
  else recalc();
}

function ntSave() {
  if (NT.saving || !ntValidate()) return;
  NT.saving = true;
  $('ntSave').disabled = true;
  $('ntStatus').textContent = 'Saving…';
  var p = { tax_name: nv('nt_name'), tax_percentage: toNum(nv('nt_rate')), tax_type: 'tax' };
  if ($('nt_type').value) p.tax_specific_type = $('nt_type').value;
  if (CONFIG.debug) console.log('%c[Create tax payload]', 'color:#7a3db8', p);

  function fail(msg) { NT.saving = false; $('ntSave').disabled = false; $('ntStatus').textContent = msg; }

  api('POST', '/settings/taxes', {}, p).then(function (res) {
    var t = res && res.tax;
    if (!t || !t.tax_id) throw mkErr('unconfirmed', 'Zoho Books did not return the created tax.', true);
    ntDone(t);
  }).catch(function (e) {
    if (e && e.uncertain) {
      $('ntStatus').textContent = 'No confirmation received – checking Zoho Books…';
      return loadTaxes(true).then(function () {
        var hit = S.taxes.filter(function (t) { return String(t.tax_name || '').toLowerCase() === p.tax_name.toLowerCase(); })[0];
        if (hit) ntDone(hit); else fail('Zoho Books did not confirm the tax was created. Check Settings ▸ Taxes before saving again.');
      }, function () { fail('Could not confirm whether the tax was created.'); });
    }
    fail('Save failed: ' + errText(e));
  });
}

    function paint() {
      var q = search.value.trim().toLowerCase(), cur = LK_VALUE.get.call(sel);
      st.items = Array.prototype.filter.call(sel.options, function (o) {
        return !q || (o.text + ' ' + ((o.dataset && o.dataset.desc) || '')).toLowerCase().indexOf(q) > -1;
      });      list.innerHTML = '';
      if (!st.items.length) { mk('div', { class: 'cust-msg', text: 'No matches found' }, list); return; }
      if (st.active >= st.items.length) st.active = 0;
      var lastG = '';
      st.items.forEach(function (o, i) {
        var g = o.dataset && o.dataset.group;
        if (g && g !== lastG) { mk('div', { class: 'lk-grp', text: g }, list); lastG = g; }
        var d = mk('div', {
          class: 'lk-item' + (i === st.active ? ' active' : '') + (o.value === cur ? ' chosen' : '')
        }, list);
        if (o.dataset && o.dataset.desc) {
          mk('div', { class: 'lk-t', text: o.text }, d);
          mk('div', { class: 'lk-d', text: o.dataset.desc }, d);
          if (o.dataset.old) mk('div', { class: 'lk-o', text: 'Earlier: ' + o.dataset.old }, d);
        } else {
          d.textContent = o.text || '— None —';
          if (o.dataset && o.dataset.child) d.classList.add('lk-child');
        }
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
  function locState(l) { var a = l && l.address; return a ? (a.state || a.state_code || '') : ''; }

  // parent locations only (top "Location" field)
  function soLocList() {
    return S.locations.map(function (l) {
      return { location_id: l.location_id, location_name: l.location_name, is_primary: l.is_primary };
    });
  }
  
  // child warehouses of one parent; a parent with no active children is offered as its own warehouse
  // parent first (selectable), then its child warehouses
  function whList(parentId) {
    var p = S.locations.filter(function (l) { return String(l.location_id) === String(parentId); })[0];
    if (!p) return [];
    var out = [{ location_id: p.location_id, location_name: p.location_name, is_child: false }];
    (p.children || []).forEach(function (c) {
      out.push({ location_id: c.location_id, location_name: c.location_name, is_child: true });
    });
    return out;
  }
  
  // like fillSelect, but marks child options so the dropdown can indent them
  function fillWh(sel, list, selectedVal) {
    sel.innerHTML = '';
    list.forEach(function (o) {
      var opt = mk('option', { value: String(o.location_id), text: o.location_name }, sel);
      if (o.is_child) opt.dataset.child = '1';
    });
    if (selectedVal !== undefined) sel.value = selectedVal;
  }
  
  // rebuild the warehouse dropdowns after the parent location changes
  function fillWarehouses() {
    var list = whList($('location').value);
    function has(v) { return list.some(function (x) { return String(x.location_id) === String(v); }); }
    var def = list.length ? String(list[0].location_id) : '';   // parent is the default
    var keep = $('itemLocation').value;
    fillWh($('itemLocation'), list, has(keep) ? keep : def);
    S.rows.forEach(function (r) {
      if (!r.refs.loc) return;
      var cur = r.refs.loc.value;
      fillWh(r.refs.loc, list, has(cur) ? cur : def);
      r.loc = r.refs.loc.value;
    });
    S.prevWh = $('itemLocation').value;
    updateSourceHint();
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

  function openItemModal(row, mode) {
    niWire();
    NI.row = row || null;
    NI.mode = mode || 'new';
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
    Array.prototype.forEach.call(m.querySelectorAll('input,select,textarea'), function (e) { e.disabled = (e.id === 'ni_cat'); });
$('niTitle').textContent = 'New Item'; $('niSave').hidden = false;
    niSync();
    m.hidden = false;
    NI.saving = false;
    $('niSave').disabled = true;
    $('niStatus').textContent = 'Loading…';
    niLoad().then(function () {
      niPopulate();
      if (NI.mode !== 'new' && NI.row && NI.row.item) niFill(NI.row.item, NI.mode);
      $('niSave').disabled = false;
      $('niStatus').textContent = '';
      $('ni_name').focus();
    });
  }


  function niFill(it, mode) {
    function set(id, v) { var e = $(id); if (e && v !== undefined && v !== null) e.value = String(v); }
    niSetRadio('ni_type', it.product_type === 'service' ? 'service' : 'goods');
    set('ni_name', it.name); set('ni_brand', it.brand); set('ni_mfr', it.manufacturer); set('ni_hsn', it.hsn_or_sac);
    set('ni_unit', it.unit); set('ni_sku', it.sku); set('ni_desc', it.description);
    var t = it.item_type || 'sales_and_purchases', inv = t === 'inventory';
    $('ni_sell').checked = inv || /sales/.test(t);
    $('ni_buy').checked = inv || /purchases/.test(t);
    set('ni_rate', it.rate); set('ni_sellAcc', it.account_id); set('ni_sellDesc', it.description);
    set('ni_cost', it.purchase_rate); set('ni_buyAcc', it.purchase_account_id);
    set('ni_buyDesc', it.purchase_description); set('ni_vendor', it.vendor_id);
    $('ni_tax').value = it.is_taxable === false ? 'exempt' : 'taxable';
    set('ni_exempt', it.tax_exemption_id); set('ni_taxId', it.tax_id);
    (it.item_tax_preferences || []).forEach(function (p) {
      set(p.tax_specification === 'inter' ? 'ni_taxInter' : 'ni_taxIntra', p.tax_id);
    });
    $('ni_track').checked = inv; set('ni_invAcc', it.inventory_account_id); set('ni_reorder', it.reorder_level);
    niSetRadio('ni_trk', it.track_serial_number ? 'serial' : (it.track_batch_number ? 'batch' : 'none'));
    niSetRadio('ni_ret', it.is_returnable === false ? '0' : '1');
    var pk = it.package_details || {};
    set('ni_len', pk.length); set('ni_wid', pk.width); set('ni_hgt', pk.height); set('ni_wt', pk.weight);
    set('ni_dimU', pk.dimension_unit); set('ni_wtU', pk.weight_unit);
    (it.custom_fields || []).forEach(function (c) {
      var e = $('nif_' + c.customfield_id);
      if (!e) return;
      if (e.type === 'checkbox') e.checked = String(c.value) === 'true'; else e.value = c.value || '';
    });
    (it.tags || []).forEach(function (t2) {
      var e = $('nit_' + t2.tag_id);
      if (e && t2.tag_option_id) e.value = String(t2.tag_option_id);
    });
    niSync();
    var ro = mode === 'view';
    $('niTitle').textContent = ro ? 'Item Details' : 'Edit Item';
    $('niSave').hidden = ro;
    if (ro) Array.prototype.forEach.call($('niBody').querySelectorAll('input,select,textarea'), function (e) { e.disabled = true; });
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
    if ($('ni_hsn') && !nv('ni_hsn')) bad('ni_hsn', (niVal('ni_type') === 'service' ? 'SAC' : 'HSN') + ' code is required');
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
    NI.saving = false; $('niSave').disabled = false; $('itemModal').hidden = true;
    if (!NI.row) return;
    if (NI.mode === 'edit') {          // keep qty / rate / tax / discount as they are
      var r = NI.row; Object.assign(r.item, it);
      r.refs.item.value = r.item.name;
      r.refs.brand.textContent = r.item.brand || '';
      r.refs.brand.parentNode.dataset.empty = r.item.brand ? '0' : '1';
      showMeta(r);
    } else selectItem(NI.row, it);
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

    var edit = NI.mode === 'edit';
api(edit ? 'PUT' : 'POST', edit ? '/items/' + NI.row.item.item_id : '/items', {}, p).then(function (res) {
      var it = res && res.item;
      if (!it || !it.item_id) throw mkErr('unconfirmed', 'Zoho Books did not return the created item.', true);
      niDone(it);
    }).catch(function (e) {
      if (e && e.uncertain && !edit) {   // same "don't double-create" pattern as customers
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



  /* ================= ADD ITEMS IN BULK ================= */
  var BK = {
    wired: false, all: [], loaded: false, loading: false, err: '',
    sel: [], cats: [], parent: {}, catSel: {}, tmpCat: {},
    items: [], shown: 0, q: '', adding: false
  };

  function bkMatch(it, toks) {
    var hay = [it.name, it.sku, it.hsn_or_sac, it.description, it.upc, it.ean, it.isbn, it.part_number,
      it.category_name, it.brand, it.manufacturer, it.rate].join(' ').toLowerCase();
    return toks.every(function (t) { return hay.indexOf(t) > -1; });
  }

  function bkCatIds() {
    var keys = Object.keys(BK.catSel).filter(function (k) { return BK.catSel[k]; });
    if (!keys.length) return null;
    var out = {};
    keys.forEach(function (k) { out[k] = 1; });
    if ($('bkSub').checked) {
      var again = true;
      while (again) {
        again = false;
        Object.keys(BK.parent).forEach(function (id) {
          if (!out[id] && out[BK.parent[id]]) { out[id] = 1; again = true; }
        });
      }
    }
    return out;
  }

  function bkFilter() {
    var toks = BK.q.toLowerCase().split(/\s+/).filter(Boolean), ids = bkCatIds();
    BK.items = BK.all.filter(function (it) {
      if (ids && !ids[String(it.category_id)]) return false;
      return !toks.length || bkMatch(it, toks);
    });
    bkPaint();
  }

  function bkMsg(t) {
    var l = $('bkList');
    l.innerHTML = '';
    mk('div', { class: 'cust-msg', text: t }, l);
  }

  function bkPaint() {
    if (BK.err && !BK.all.length) { bkMsg('Could not load items: ' + BK.err); return; }
    if (BK.loading && !BK.all.length) { bkMsg('Loading items…'); return; }
    if (!BK.items.length) { bkMsg('No items found'); return; }
    $('bkList').innerHTML = '';
    BK.shown = 0;
    bkMore();
  }

  function bkIsSel(id) {
    return BK.sel.some(function (s) { return String(s.item.item_id) === String(id); });
  }

  function bkMore() {
    var box = $('bkList'), end = Math.min(BK.items.length, BK.shown + 80);
    for (var i = BK.shown; i < end; i++) {
      (function (it) {
        var d = mk('div', { class: 'bk-it' + (bkIsSel(it.item_id) ? ' on' : '') }, box);
        d.dataset.id = String(it.item_id);
        var tx = mk('div', { class: 'bk-tx' }, d);
        mk('div', { class: 'bk-nm', text: it.name }, tx);
        var sub = [it.sku ? 'SKU: ' + it.sku : '', it.hsn_or_sac ? 'HSN/SAC: ' + it.hsn_or_sac : '',
          'Rate: ' + curSym() + Number(it.rate || 0).toLocaleString(undefined, { minimumFractionDigits: precision(), maximumFractionDigits: precision() })]
          .filter(Boolean).join('  ');
        mk('div', { class: 'bk-sb', text: sub }, tx);
        mk('span', { class: 'bk-ck', text: '✓' }, d);
        d.addEventListener('click', function () { bkToggle(it); });
      })(BK.items[i]);
    }
    BK.shown = end;
  }

  function bkSyncChecks() {
    Array.prototype.forEach.call($('bkList').querySelectorAll('.bk-it'), function (n) {
      n.classList.toggle('on', bkIsSel(n.dataset.id));
    });
  }

  function bkToggle(it) {
    var i = -1;
    BK.sel.forEach(function (s, k) { if (String(s.item.item_id) === String(it.item_id)) i = k; });
    if (i > -1) BK.sel.splice(i, 1);
    else BK.sel.push({ item: it, qty: 1 });
    bkSyncChecks();
    bkRenderSel();
  }

  function bkTotals() {
    var q = BK.sel.reduce(function (a, s) { return a + s.qty; }, 0);
    $('bkCount').textContent = String(BK.sel.length);
    $('bkQty').textContent = String(round(q, CONFIG.maxQtyDecimals));
    $('bkAdd').disabled = !BK.sel.length || BK.adding;
  }

  function bkRenderSel() {
    var box = $('bkSel');
    box.innerHTML = '';
    BK.sel.forEach(function (s) {
      var r = mk('div', { class: 'bk-sr' }, box);
      mk('div', { class: 'bk-sn', text: s.item.name }, r);
      var st = mk('div', { class: 'bk-step' }, r);
      var minus = mk('button', { type: 'button', class: 'bk-sb-btn', text: '−' }, st);
      var inp = mk('input', { type: 'text', inputMode: 'decimal', value: String(s.qty) }, st);
      var plus = mk('button', { type: 'button', class: 'bk-sb-btn', text: '+' }, st);
      var x = mk('button', { type: 'button', class: 'bk-x', title: 'Remove', innerHTML: '&times;' }, r);
      minus.disabled = s.qty <= 1;

      function set(v) {
        s.qty = v;
        inp.value = String(v);
        minus.disabled = v <= 1;
        bkTotals();
      }
      minus.addEventListener('click', function () { set(Math.max(1, round(s.qty - 1, CONFIG.maxQtyDecimals))); });
      plus.addEventListener('click', function () { set(round(s.qty + 1, CONFIG.maxQtyDecimals)); });
      inp.addEventListener('input', function () {
        var n = toNum(inp.value);
        if (isFinite(n) && n > 0 && decimals(inp.value.trim()) <= CONFIG.maxQtyDecimals) { s.qty = n; bkTotals(); }
      });
      inp.addEventListener('blur', function () {
        var n = toNum(inp.value);
        set(isFinite(n) && n > 0 ? round(n, CONFIG.maxQtyDecimals) : 1);
      });
      x.addEventListener('click', function () {
        BK.sel = BK.sel.filter(function (z) { return z !== s; });
        bkSyncChecks();
        bkRenderSel();
      });
    });
    bkTotals();
  }

  /* ---- category dropdown ---- */
  function bkCatLabel() {
    var n = Object.keys(BK.catSel).filter(function (k) { return BK.catSel[k]; }).length;
    $('bkCatLbl').textContent = n ? 'Category (' + n + ')' : 'Category';
  }

  function bkPaintCats() {
    var q = $('bkCatSearch').value.trim().toLowerCase(), box = $('bkCatList');
    box.innerHTML = '';
    var list = BK.cats.filter(function (c) { return !q || c.name.toLowerCase().indexOf(q) > -1; });
    if (!list.length) { mk('div', { class: 'cust-msg', text: BK.loading ? 'Loading…' : 'No categories found' }, box); return; }
    list.forEach(function (c) {
      var lab = mk('label', { class: 'bk-cat-it' }, box);
      var cb = mk('input', { type: 'checkbox' }, lab);
      cb.checked = !!BK.tmpCat[c.id];
      mk('span', { text: c.name }, lab);
      cb.addEventListener('change', function () { BK.tmpCat[c.id] = cb.checked; });
    });
  }

  function bkCatOpen() {
    BK.tmpCat = Object.assign({}, BK.catSel);
    $('bkCatSearch').value = '';
    $('bkCatPanel').hidden = false;
    bkPaintCats();
    setTimeout(function () { $('bkCatSearch').focus(); }, 0);
  }
  function bkCatClose() { $('bkCatPanel').hidden = true; }

  // categories come from the loaded items; /categories (if the org supports it) adds sub-category links
  function bkBuildCats() {
    var m = {};
    BK.all.forEach(function (it) { if (it.category_id && it.category_name) m[String(it.category_id)] = it.category_name; });
    return api('GET', '/categories').then(function (j) {
      firstArray(j, 'categories').forEach(function (c) {
        var id = String(c.category_id || '');
        if (!id) return;
        if (!m[id]) m[id] = c.name || c.category_name || id;
        if (c.parent_category_id) BK.parent[id] = String(c.parent_category_id);
      });
    }).catch(function () { /* optional */ }).then(function () {
      BK.cats = Object.keys(m).map(function (id) { return { id: id, name: m[id] }; })
        .sort(function (a, b) { return a.name.toLowerCase().localeCompare(b.name.toLowerCase()); });
      bkPaintCats();
    });
  }

  /* ---- load every active item once, then filter locally ---- */
  function bkLoadItems() {
    if (BK.loaded || BK.loading) return Promise.resolve();
    BK.loading = true;
    BK.err = '';
    bkPaint();
    var all = [], page = 1;
    function next() {
      return api('GET', '/items', { filter_by: 'Status.Active', per_page: 200, page: page, sort_column: 'name' }).then(function (j) {
        var list = firstArray(j, 'items');
        all = all.concat(list);
        if (page === 1) { BK.all = all; bkFilter(); }
        $('bkStatus').textContent = 'Loading items… ' + all.length;
        if (j.page_context && j.page_context.has_more_page && list.length && page < 200) { page++; return next(); }
      });
    }
    return next().then(function () {
      BK.all = all;
      BK.loaded = true;
      $('bkStatus').textContent = '';
      return bkBuildCats();
    }).catch(function (e) {
      BK.err = errText(e);
      $('bkStatus').textContent = '';
    }).then(function () {
      BK.loading = false;
      bkFilter();
    });
  }

  /* ---- add the selected items as sales-order rows ---- */
  function bkAdd() {
    if (!BK.sel.length || BK.adding) return;
    BK.adding = true;
    $('bkAdd').disabled = true;
    $('bkStatus').textContent = 'Adding items…';

    var free = S.rows.filter(isPristine);              // reuse the empty starter row(s) first
    var jobs = BK.sel.map(function (s) {
      var row = free.shift() || addRow();
      return { row: row, item: s.item, qty: s.qty };
    });

    var chunks = [];
    for (var i = 0; i < jobs.length; i += 5) chunks.push(jobs.slice(i, i + 5));
    chunks.reduce(function (p, ch) {
      return p.then(function () {
        return Promise.all(ch.map(function (j) { return selectItem(j.row, j.item, j.qty); }));
      });
    }, Promise.resolve()).then(function () {
      var failed = jobs.filter(function (j) { return !j.row.item; }).length;
      BK.adding = false;
      recalc();
      if (failed) {
        $('bkStatus').textContent = failed + ' item(s) could not be loaded – see the red message on those rows.';
      }
      $('bkModal').hidden = true;
    });
  }

  function bkClose() { if (!BK.adding) $('bkModal').hidden = true; }

  function bkWire() {
    if (BK.wired) return;
    BK.wired = true;
    var t = null;
    $('bkSearch').addEventListener('input', function () {
      clearTimeout(t);
      t = setTimeout(function () { BK.q = $('bkSearch').value; bkFilter(); }, 150);
    });
    $('bkList').addEventListener('scroll', function () {
      var l = $('bkList');
      if (BK.shown < BK.items.length && l.scrollTop + l.clientHeight > l.scrollHeight - 120) bkMore();
    });
    $('bkSub').addEventListener('change', bkFilter);
    $('bkCatBtn').addEventListener('click', function () { if ($('bkCatPanel').hidden) bkCatOpen(); else bkCatClose(); });
    $('bkCatSearch').addEventListener('input', bkPaintCats);
    $('bkCatApply').addEventListener('click', function () {
      BK.catSel = Object.assign({}, BK.tmpCat);
      bkCatClose();
      bkCatLabel();
      bkFilter();
    });
    $('bkAdd').addEventListener('click', bkAdd);
    $('bkCancel').addEventListener('click', bkClose);
    $('bkClose').addEventListener('click', bkClose);
    $('bkModal').addEventListener('mousedown', function (ev) { if (ev.target === $('bkModal')) bkClose(); });
    document.addEventListener('mousedown', function (ev) {
      if (!$('bkCatPanel').hidden && !$('bkCatWrap').contains(ev.target)) bkCatClose();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape' || $('bkModal').hidden) return;
      if (!$('bkCatPanel').hidden) bkCatClose(); else bkClose();
    });
  }

  function openBulk() {
    bkWire();
    BK.sel = [];
    BK.q = '';
    BK.catSel = {};
    BK.adding = false;
    $('bkSearch').value = '';
    $('bkSub').checked = false;
    $('bkStatus').textContent = '';
    bkCatLabel();
    bkRenderSel();
    $('bkModal').hidden = false;
    bkFilter();
    bkLoadItems();
    setTimeout(function () { $('bkSearch').focus(); }, 30);
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



  /* ================= CUSTOMER ADDRESS + GST BLOCK ================= */
  var CI = { ov: {}, gstOv: null, gstShip: null, pop: null, pending: false, wired: false };

  var CI_PENCIL = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

  function ciReset() {
    CI.ov = {}; CI.gstOv = null; CI.gstShip = null;
    S.addrDirty.b = false; S.addrDirty.s = false;   // a new customer brings its own addresses
    ciClosePop(); ciCloseDialog();
  }

  function ciBox() { return $('custInfo'); }

  function ciInit() {
    if (CI.wired) return;
    CI.wired = true;
    var hint = $('customerHint');
    if (hint && !$('custInfo')) {
      var box = mk('div', { id: 'custInfo', class: 'cust-info' });
      hint.parentNode.insertBefore(box, hint.nextSibling);
      box.hidden = true;
    }
    document.addEventListener('mousedown', function (ev) {
      if (CI.pop && !CI.pop.el.contains(ev.target) && !(ev.target.closest && ev.target.closest('.ci-pencil'))) ciClosePop();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { ciClosePop(); ciCloseDialog(); }
    });
  }

  function ciHasAddr(a) {
    if (!a) return false;
    return ADDR_KEYS.some(function (k) { return a[k[0]] != null && String(a[k[0]]).trim() !== ''; });
  }

  function ciAddrOf(kind) {   // order-level override wins over the customer's saved address
    if (CI.ov[kind]) return CI.ov[kind];
    return S.contact ? S.contact[kind + '_address'] : null;
  }

  function ciEff() {          // GST values in effect for this order
    var c = S.contact || {}, o = CI.gstOv || {};
    function pick(k) { return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : (c[k] || ''); }
    return { treat: pick('gst_treatment'), gstin: pick('gst_no'), legal: pick('legal_name'), trade: pick('trade_name') };
  }

  function ciPencil(title, fn) {
    var b = mk('button', { type: 'button', class: 'ci-pencil', title: title }, null);
    b.setAttribute('aria-label', title);
    b.innerHTML = CI_PENCIL;                       // static markup only
    b.addEventListener('click', function (ev) { ev.preventDefault(); fn(b); });
    return b;
  }

  function ciLink(text, fn) {
    var b = mk('button', { type: 'button', class: 'ci-link', text: text }, null);
    b.addEventListener('click', function (ev) { ev.preventDefault(); fn(); });
    return b;
  }


  // Hide Place of Supply when the GST treatment doesn't need it (e.g. Overseas)
function updatePlaceOfSupply() {
  var wrap = $('posWrap'), sel = $('placeOfSupply');
  if (!wrap || !sel) return;
  var r = (S.customer && S.contact && detectGst()) ? GST_BY[ciEff().treat] : null;
  var hide = !!(r && !r.pos);                 // pos:0 → Overseas
  wrap.hidden = hide;
  if (hide) { sel.value = ''; mark(sel, ''); }
}

  /* ---------- render ---------- */
  function ciRender() {
    var box = ciBox();
    updatePlaceOfSupply();

    if (!box) return;
    ciClosePop();
    box.innerHTML = '';
    if (!S.customer || !S.contact) { box.hidden = true; return; }
    box.hidden = false;

    var row = mk('div', { class: 'ci-row' }, box);
    ciAddrCol(row, 'billing');
    ciAddrCol(row, 'shipping');

    ciRemarks(box);

    if (detectGst()) {
      var g = mk('div', { class: 'ci-row ci-gst' }, box);
      ciGstBilling(g);
      ciGstShipping(g);
    }
  }

  function ciAddrCol(parent, kind) {
    var a = ciAddrOf(kind), col = mk('div', { class: 'ci-col' }, parent);
    var h = mk('div', { class: 'ci-h' }, col);
    mk('span', { text: kind === 'billing' ? 'Billing Address' : 'Shipping Address' }, h);
    if (ciHasAddr(a)) {
      h.appendChild(ciPencil('Edit ' + kind + ' address', function () { ciOpenAddr(kind, a, null); }));
      var body = mk('div', { class: 'ci-addr' }, col);
      if (a.attention) mk('div', { class: 'ci-att', text: a.attention }, body);
      if (a.address) mk('div', { text: a.address }, body);
      if (a.street2) mk('div', { text: a.street2 }, body);
      var cityLine = [a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      if (cityLine) mk('div', { text: cityLine }, body);
      if (a.country) mk('div', { text: a.country }, body);
      if (a.phone) mk('div', { class: 'ci-sub', text: 'Phone: ' + a.phone }, body);
    } else {
      var links = mk('div', { class: 'ci-links' }, col);
      links.appendChild(ciLink('New Address', function () { ciOpenAddr(kind, null, null); }));
      if (kind === 'shipping') {
        mk('span', { class: 'ci-sep' }, links);
        links.appendChild(ciLink('+ Dropshipping Address', function () { ciOpenAddr('dropship', null, 'Dropshipping Address'); }));
      }
    }
  }

  function ciGstBilling(parent) {
    var e = ciEff(), r = GST_BY[e.treat], col = mk('div', { class: 'ci-col' }, parent);
    mk('div', { class: 'ci-h', text: 'Billing Recipient GST Details' }, col);
    var line = mk('div', { class: 'ci-kv' }, col);
    mk('span', { class: 'ci-k', text: 'GST Treatment: ' }, line);
    mk('span', { class: 'ci-v', text: r ? r.label : (e.treat || '—') }, line);
    line.appendChild(ciPencil('Edit GST treatment', function (b) { ciOpenTreat(b); }));
  }

  function ciRemarks(parent) {
    var txt = String((S.contact && S.contact.notes) || '').trim();
    if (!txt) return;                       // hide the block when the customer has no remarks
    var w = mk('div', { class: 'ci-remarks' }, parent);
    mk('span', { class: 'ci-rem-l', text: 'Remarks' }, w);
    mk('div', { class: 'ci-rem-v', text: txt }, w);   // textContent, so it is safe from HTML injection
  }

  function ciGstShipping(parent) {
    var e = ciEff(), s = CI.gstShip || {}, col = mk('div', { class: 'ci-col' }, parent);
    var h = mk('div', { class: 'ci-h' }, col);
    mk('span', { text: 'Shipping Recipient GST Details' }, h);
    h.appendChild(ciPencil('Edit shipping recipient GST details', function (b) { ciOpenShipGst(b); }));
    var gstin = CI.gstShip ? (s.unreg ? '' : s.gst_no) : e.gstin;
    var legal = CI.gstShip ? s.legal_name : e.legal;
    var l1 = mk('div', { class: 'ci-kv' }, col);
    mk('span', { class: 'ci-k', text: 'GSTIN: ' }, l1);
    mk('span', { class: 'ci-v', text: gstin || '' }, l1);
    var l2 = mk('div', { class: 'ci-kv' }, col);
    mk('span', { class: 'ci-k', text: 'Business Legal Name: ' }, l2);
    mk('span', { class: 'ci-v', text: legal || '' }, l2);
  }

  /* ---------- small popover (GST) ---------- */
  function ciClosePop() {
    if (CI.pop && CI.pop.el.parentNode) CI.pop.el.parentNode.removeChild(CI.pop.el);
    CI.pop = null;
  }

  function ciField(parent, label, el) {
    var w = mk('div', { class: 'ci-f' }, parent);
    if (label) mk('label', { text: label }, w);
    if (el) w.appendChild(el);
    return w;
  }

  // build(body) fills the popup; update() does the work and may return a Promise or throw an Error.
  function ciPop(anchor, title, build, update) {
    ciClosePop();
    var box = ciBox(), el = mk('div', { class: 'ci-pop', role: 'dialog' }, box);
    var head = mk('div', { class: 'ci-pop-h' }, el);
    mk('span', { text: title }, head);
    var x = mk('button', { type: 'button', class: 'ci-x', title: 'Close', text: '×' }, head);
    var body = mk('div', { class: 'ci-pop-b' }, el);
    build(body);
    var err = mk('div', { class: 'ci-err', hidden: true }, el);
    var foot = mk('div', { class: 'ci-pop-f' }, el);
    var ok = mk('button', { type: 'button', class: 'btn primary', text: 'Update' }, foot);
    var cancel = mk('button', { type: 'button', class: 'btn', text: 'Cancel' }, foot);
    var left = Math.max(0, anchor.getBoundingClientRect().left - box.getBoundingClientRect().left - 20);
    var maxLeft = Math.max(0, box.clientWidth - 320);
    el.style.left = Math.min(left, maxLeft) + 'px';
    el.style.top = (anchor.getBoundingClientRect().bottom - box.getBoundingClientRect().top + 8) + 'px';
    x.addEventListener('click', ciClosePop);
    cancel.addEventListener('click', ciClosePop);
    ok.addEventListener('click', function () {
      if (CI.pending) return;
      err.hidden = true;
      CI.pending = true; ok.disabled = true; ok.textContent = 'Updating…';
      var out;
      try { out = Promise.resolve(update()); } catch (e) { out = Promise.reject(e); }
      out.then(function () { CI.pending = false; ciRender(); }, function (e) {
        CI.pending = false; ok.disabled = false; ok.textContent = 'Update';
        err.textContent = errText(e); err.hidden = false;
      });
    });
    CI.pop = { el: el };
  }

  // PUT the changed fields onto the customer (contact_name is sent too – the update endpoint expects it)
  function ciPutContact(fields) {
    var body = { contact_name: S.contact.contact_name };
    Object.keys(fields).forEach(function (k) { body[k] = fields[k]; });
    return api('PUT', '/contacts/' + S.customer.contact_id, null, body).then(function (j) {
      return (j && j.contact) || {};
    });
  }

  // function ciOpenTreat(anchor) {
  //   var e = ciEff(), sel, gstin, gRow, perm;
  //   ciPop(anchor, 'Configure Tax Preferences', function (body) {
  //     sel = mk('select', {}, null);
  //     mk('option', { value: '', text: 'Select a GST treatment' }, sel);
  //     GST_TREATMENTS.forEach(function (t) { mk('option', { value: t.value, text: t.label }, sel); });
  //     sel.value = GST_BY[e.treat] ? e.treat : '';
  //     ciField(body, 'GST Treatment', sel);
  //     gstin = mk('input', { type: 'text', maxLength: 15, autocomplete: 'off', value: e.gstin || '' }, null);
  //     gRow = ciField(body, 'GSTIN / UIN', gstin);
  //     function sync() { var r = GST_BY[sel.value]; gRow.hidden = !(r && r.reg); }
  //     sel.addEventListener('change', sync); sync();
  //     mk('div', { class: 'ci-ask', text: 'Make it permanent?' }, body);
  //     var lab = mk('label', { class: 'ci-chk' }, body);
  //     perm = mk('input', { type: 'checkbox' }, lab);
  //     mk('span', { text: 'Use these settings for all future transactions of this customer.' }, lab);
  //   }, function () {
  //     var r = GST_BY[sel.value];
  //     if (!r) throw new Error('Select a GST treatment');
  //     var no = r.reg ? gstin.value.trim().toUpperCase() : '';
  //     if (r.req && !no) throw new Error('GSTIN is required for this GST treatment');
  //     if (no && !GSTIN_RE.test(no)) throw new Error('Enter a valid 15-character GSTIN');
  //     if (!perm.checked) {           // this order only
  //       CI.gstOv = CI.gstOv || {};
  //       CI.gstOv.gst_treatment = r.api; CI.gstOv.gst_no = no;
  //       return;
  //     }
  //     var f = { gst_treatment: r.api }; if (no) f.gst_no = no;
  //     return ciPutContact(f).then(function (c) {
  //       S.contact.gst_treatment = c.gst_treatment || r.api;
  //       S.contact.gst_no = c.gst_no != null ? c.gst_no : no;
  //       if (CI.gstOv) { delete CI.gstOv.gst_treatment; delete CI.gstOv.gst_no; }
  //     });
  //   });
  // }

  function ciOpenTreat(anchor) {
    var e = ciEff(), gstin, gRow, perm;
    var rsVal = GST_BY[e.treat] ? e.treat : '';

    ciPop(anchor, 'Configure Tax Preferences', function (body) {
      // Build the custom rich select UI
      var rsWrap = mk('div', { class: 'rs-wrap w-main' }, body);
      var rsBox = mk('div', { class: 'rs-box' }, rsWrap);
      var txt = mk('input', { type: 'text', readOnly: true, placeholder: 'Select a GST treatment', value: GST_BY[rsVal] ? GST_BY[rsVal].label : '' }, rsBox);
      mk('span', { class: 'cust-chev' }, rsBox);
      
      var panel = mk('div', { class: 'rs-panel', hidden: true }, rsWrap);
      var sbox = mk('div', { class: 'cust-search' }, panel);
      sbox.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8a94a6" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
      var search = mk('input', { type: 'text', placeholder: 'Search', autocomplete: 'off' }, sbox);
      var list = mk('div', { class: 'rs-list' }, panel);

      var st = { open: false, active: 0, items: [] };

      function paint() {
        var q = search.value.trim().toLowerCase();
        st.items = GST_TREATMENTS.filter(function (x) { 
          return !q || (x.label + ' ' + x.desc).toLowerCase().indexOf(q) > -1; 
        });
        list.innerHTML = '';
        if (!st.items.length) { mk('div', { class: 'cust-msg', text: 'No matches' }, list); return; }
        if (st.active >= st.items.length) st.active = 0;
        
        st.items.forEach(function (x, i) {
          var d = mk('div', { class: 'rs-item' + (i === st.active ? ' active' : '') + (rsVal === x.value ? ' chosen' : '') }, list);
          d.dataset.i = String(i);
          mk('div', { class: 't', text: x.label }, d);
          if (x.desc) mk('div', { class: 'd', text: x.desc }, d);
          d.addEventListener('mousedown', function (ev) { ev.preventDefault(); choose(i); });
          d.addEventListener('mouseenter', function () { st.active = i; paintActive(); });
        });
      }

      function paintActive() {
        Array.prototype.forEach.call(list.querySelectorAll('.rs-item'), function (n) {
          n.classList.toggle('active', Number(n.dataset.i) === st.active);
        });
      }

      function open() {
        if (st.open) return;
        st.open = true;
        panel.hidden = false;
        rsBox.classList.add('open');
        search.value = '';
        st.active = Math.max(0, st.items.map(function (x) { return x.value; }).indexOf(rsVal));
        paint();
        setTimeout(function () { search.focus(); }, 0);
      }

      function close() {
        if (!st.open) return;
        st.open = false;
        panel.hidden = true;
        rsBox.classList.remove('open');
      }

      function choose(i) {
        var x = st.items[i];
        if (!x) return;
        rsVal = x.value;
        txt.value = x.label;
        gRow.hidden = !x.reg;
        close();
        txt.focus();
      }

      rsBox.addEventListener('click', function () { if (st.open) close(); else open(); });
      txt.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === 'ArrowDown' || ev.key === ' ') { ev.preventDefault(); open(); }
      });
      search.addEventListener('input', function () { st.active = 0; paint(); });
      search.addEventListener('keydown', function (ev) {
        if (ev.key === 'ArrowDown') { ev.preventDefault(); st.active = Math.min(st.items.length - 1, st.active + 1); paintActive(); }
        else if (ev.key === 'ArrowUp') { ev.preventDefault(); st.active = Math.max(0, st.active - 1); paintActive(); }
        else if (ev.key === 'Enter') { ev.preventDefault(); choose(st.active); }
        else if (ev.key === 'Escape') { ev.preventDefault(); close(); txt.focus(); }
        else if (ev.key === 'Tab') close();
      });

      // Add GSTIN field below the rich select
      gstin = mk('input', { type: 'text', maxLength: 15, autocomplete: 'off', value: e.gstin || '' }, null);
      gRow = ciField(body, 'GSTIN / UIN', gstin);
      var r = GST_BY[rsVal];
      gRow.hidden = !(r && r.reg);

      // Add permanent option
      mk('div', { class: 'ci-ask', text: 'Make it permanent?' }, body);
      var lab = mk('label', { class: 'ci-chk' }, body);
      perm = mk('input', { type: 'checkbox' }, lab);
      mk('span', { text: 'Use these settings for all future transactions of this customer.' }, lab);
      
    }, function () {
      var r = GST_BY[rsVal];
      if (!r) throw new Error('Select a GST treatment');
      var no = r.reg ? gstin.value.trim().toUpperCase() : '';
      if (r.req && !no) throw new Error('GSTIN is required for this GST treatment');
      if (no && !GSTIN_RE.test(no)) throw new Error('Enter a valid 15-character GSTIN');
      if (!perm.checked) {           // this order only
        CI.gstOv = CI.gstOv || {};
        CI.gstOv.gst_treatment = r.api; CI.gstOv.gst_no = no;
        return;
      }
      var f = { gst_treatment: r.api }; if (no) f.gst_no = no;
      return ciPutContact(f).then(function (c) {
        S.contact.gst_treatment = c.gst_treatment || r.api;
        S.contact.gst_no = c.gst_no != null ? c.gst_no : no;
        if (CI.gstOv) { delete CI.gstOv.gst_treatment; delete CI.gstOv.gst_no; }
      });
    });
  }
  function ciOpenShipGst(anchor) {
    var e = ciEff(), s = CI.gstShip || { gst_no: e.gstin, legal_name: e.legal, trade_name: e.trade, unreg: false };
    var no, un, legal, trade;
    ciPop(anchor, 'Shipping Recipient GST Details', function (body) {
      var top = mk('div', { class: 'ci-f ci-f-inline' }, body);
      mk('label', { text: 'GSTIN' }, top);
      var lab = mk('label', { class: 'ci-chk' }, top);
      un = mk('input', { type: 'checkbox', checked: !!s.unreg }, lab);
      mk('span', { text: 'is Unregistered Person?' }, lab);
      no = mk('input', { type: 'text', maxLength: 15, autocomplete: 'off', value: s.gst_no || '' }, null);
      ciField(body, '', no);
      legal = mk('input', { type: 'text', autocomplete: 'off', value: s.legal_name || '' }, null);
      ciField(body, 'Business Legal Name', legal);
      trade = mk('input', { type: 'text', autocomplete: 'off', value: s.trade_name || '' }, null);
      ciField(body, 'Business Trade Name', trade);
      function sync() { no.disabled = un.checked; }
      un.addEventListener('change', sync); sync();
    }, function () {
      var g = no.value.trim().toUpperCase();
      if (!un.checked && g && !GSTIN_RE.test(g)) throw new Error('Enter a valid 15-character GSTIN');
      CI.gstShip = { gst_no: un.checked ? '' : g, unreg: un.checked, legal_name: legal.value.trim(), trade_name: trade.value.trim() };
    });
  }

  /* ---------- address dialog ---------- */
  function ciCloseDialog() {
    var o = $('ciOverlay');
    if (o && o.parentNode) o.parentNode.removeChild(o);
  }

  // kind: 'billing' | 'shipping' | 'dropship'
  function ciOpenAddr(kind, a, title) {
    ciCloseDialog(); ciClosePop();
    a = a || {};
    var ov = mk('div', { id: 'ciOverlay', class: 'ci-overlay' }, document.body);
    var dlg = mk('div', { class: 'ci-dialog', role: 'dialog' }, ov);
    var h = mk('div', { class: 'ci-dialog-h' }, dlg);
    mk('span', { text: title || ((a && ciHasAddr(a) ? 'Edit ' : 'New ') + (kind === 'billing' ? 'Billing' : 'Shipping') + ' Address') }, h);
    mk('button', { type: 'button', class: 'ci-x', title: 'Close', text: '×' }, h).addEventListener('click', ciCloseDialog);
    var body = mk('div', { class: 'ci-dialog-b' }, dlg), F = {};
    ADDR_KEYS.forEach(function (k) {
      var el;
      if (k[0] === 'country') {
        el = mk('select', {}, null);
        var list = COUNTRIES.slice();
        if (a.country && list.indexOf(a.country) < 0) list.unshift(a.country);
        mk('option', { value: '', text: 'Select' }, el);
        list.forEach(function (c) { mk('option', { value: c, text: c }, el); });
        el.value = a.country || (S.contact && S.contact.billing_address && S.contact.billing_address.country) || '';
      } else if (k[0] === 'address' || k[0] === 'street2') {
        el = mk('textarea', { rows: 2, placeholder: k[0] === 'address' ? 'Street 1' : 'Street 2', value: a[k[0]] || '' }, null);
      } else {
        el = mk('input', { type: 'text', autocomplete: 'off', value: a[k[0]] || '' }, null);
      }
      F[k[0]] = el;
      ciField(body, k[0] === 'street2' ? '' : k[1], el);
    });
    var err = mk('div', { class: 'ci-err', hidden: true }, dlg);
    var foot = mk('div', { class: 'ci-dialog-f' }, dlg);
    var save = mk('button', { type: 'button', class: 'btn primary', text: kind === 'dropship' ? 'Use on this order' : 'Save' }, foot);
    var cancel = mk('button', { type: 'button', class: 'btn', text: 'Cancel' }, foot);
    var orderOnly = mk('button', { type: 'button', class: 'btn ghost', text: 'Use for this order only', hidden: true }, foot);
    cancel.addEventListener('click', ciCloseDialog);

    function read() {
      var o = {};
      ADDR_KEYS.forEach(function (k) { var v = String(F[k[0]].value || '').trim(); if (v) o[k[0]] = v; });
      return o;
    }
    function showErr(m) { err.textContent = m; err.hidden = !m; }
    function applyOrder(obj) {
      var target = kind === 'billing' ? 'billing' : 'shipping';
      CI.ov[target] = obj;
      fillAddress(target === 'billing' ? 'b' : 's', obj);
      S.addrDirty[target === 'billing' ? 'b' : 's'] = true;
      ciCloseDialog(); ciRender();
    }
    orderOnly.addEventListener('click', function () {
      var o = read(); if (!ciHasAddr(o)) { showErr('Enter at least one address field.'); return; }
      applyOrder(o);
    });
    save.addEventListener('click', function () {
      if (CI.pending) return;
      var o = read();
      if (!ciHasAddr(o)) { showErr('Enter at least one address field.'); return; }
      showErr('');
      if (kind === 'dropship') { applyOrder(o); return; }      // dropship addresses are used on this order only
      CI.pending = true; save.disabled = true; save.textContent = 'Saving…';
      var f = {}; f[kind + '_address'] = o;
      ciPutContact(f).then(function (c) {
        CI.pending = false;
        var saved = c[kind + '_address'] || o;
        S.contact[kind + '_address'] = saved;
        delete CI.ov[kind];
        fillAddress(kind === 'billing' ? 'b' : 's', saved);
        S.addrDirty[kind === 'billing' ? 'b' : 's'] = true;
        ciCloseDialog(); ciRender();
      }, function (e) {
        CI.pending = false; save.disabled = false; save.textContent = 'Save';
        showErr('Could not save to the customer: ' + errText(e));
        orderOnly.hidden = false;
      });
    });
    var first = F.attention; if (first && first.focus) first.focus();
  }

  /* ---------- payload ---------- */
  // Only sends what the user changed for THIS order; the customer's own values are used by Zoho otherwise.
  function ciPayload(p) {
    if (!S.contact) return;
    var o = CI.gstOv;
    if (o && Object.prototype.hasOwnProperty.call(o, 'gst_treatment')) {
      p.gst_treatment = o.gst_treatment;
      if (o.gst_no) p.gst_no = o.gst_no;
    }
    var sg = CI.gstShip, m = CONFIG.shipGstFields;
    if (sg) {
      if (m && typeof m === 'object') {     // set CONFIG.shipGstFields = { gst_no:'..', legal_name:'..', trade_name:'..' } once the real field names are verified
        Object.keys(m).forEach(function (k) { if (m[k] && sg[k]) p[m[k]] = sg[k]; });
      } else if (CONFIG.debug) {
        console.warn('[SOWidget] Shipping recipient GST details are shown here only; no verified sales-order field to save them (set CONFIG.shipGstFields).');
      }
    }
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
    if ($('placeOfSupply') && $('placeOfSupply').value && !$('posWrap').hidden) {
      p.place_of_supply = $('placeOfSupply').value;
    }
    if ((v = $('shipDate').value)) p.shipment_date = v;
    if ((v = $('refNumber').value.trim())) p.reference_number = v;
    if ((v = $('soNumber').value.trim())) p.salesorder_number = v;
    if (!$('exchWrap').hidden) p.exchange_rate = toNum($('exchRate').value);
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
    ciPayload(p);
    var wh = withholding(currentTotals());
    if (wh.tax && CONFIG.debug) {
      console.warn('[SOWidget] ' + wh.type.toUpperCase() + ' is included in the displayed total only; no documented sales-order field is available to save it.');
    }
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
      if (R.tax.value.indexOf('ex:') === 0) {
        var exId = exemptionFor(R.tax.value.slice(3));
        if (exId) li.tax_exemption_id = exId;
        else if (CONFIG.debug) console.warn('[SOWidget] No matching tax exemption for', R.tax.value, '- row sent without tax');
      } else if (R.tax.value) li.tax_id = R.tax.value;
            if (p.discount_type === 'item_level') {
        var d = parseDiscount(discText(r), li.quantity * li.rate);
        if (d.text && d.value > 0) li.discount = d.text;
      }
      if (S.locations.length) li.location_id = String(r.loc || $('location').value);
      if (r.pb) li.pricebook_id = String(r.pb.pricebook_id);
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
        if (detectGst() && !String(j.item.hsn_or_sac || '').trim()) {
          throw mkErr('data', 'Item "' + ids[id] + '" has no HSN/SAC code in Zoho Books. Add it before saving.');
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

  // function buildReferenceUI() {
  //   if ($('placeOfSupply')) {
  //     var states = typeof STATES_IN !== 'undefined' ? STATES_IN : [];
  //     fillOptions($('placeOfSupply'), states.map(function (s) { return [s[0], '[' + s[0] + '] - ' + s[1]]; }), 'Select a state');
  //   }
  //   if (S.salespersons.length) {
  //     $('spWrap').hidden = false;
  //     fillSelect($('salesperson'), S.salespersons, 'salesperson_id', 'salesperson_name', '— none —', '');
  //   }

  //   if (S.locations.length) {
  //     $('locWrap').hidden = false;
  //     var primary = S.locations.filter(function (l) { return l.is_primary; })[0] || S.locations[0];
  //     fillSelect($('location'), soLocList(), 'location_id', 'location_name', null, String(primary.location_id));
  //   }

  //   if (S.pricebooks.length) {
  //     $('plWrap').hidden = false;
  //     fillSelect($('priceList'), S.pricebooks.map(function (p) {
  //       var t = p.pricebook_type === 'fixed_percentage' && p.percentage != null
  //         ? ' [' + p.percentage + '% ' + (p.is_increase ? 'Markup' : 'Markdown') + ']' : '';
  //       return { pricebook_id: p.pricebook_id, name: p.name + t };
  //     }), 'pricebook_id', 'name', 'Select Price List', '');
  //   }

  //   buildCustomFields();
  //   NAMED_CF.forEach(function (n) {
  //     var def = cfDefByLabel(n.label);
  //     if (!def && CONFIG.debug) console.warn('[SOWidget] No custom field named "' + n.label + '" found in this Zoho Books org.');
  //   });
  //   setCurrency(S.baseCurrency);
  //   soFillTerms('');
  //   ['location', 'payTerms', 'salesperson', 'priceList'].forEach(function (id) {
  //     lookupEnhance($(id), id === 'payTerms'
  //       ? { newLabel: 'New Payment Term', onNew: function () { openPaymentTermModal('so'); } }
  //       : null);
  //   });

  //   var prevLoc = $('location').value;
  //   $('location').addEventListener('change', function () {
  //     var v = $('location').value;
  //     updateSourceHint();
  //     if (v === prevLoc) return;
  //     if (!S.rows.some(function (r) { return r.loc !== v; })) { prevLoc = v; return; }
  //     askConfirm('Apply this warehouse to all item rows?').then(function (ok) {
  //       if (ok) { prevLoc = v; S.rows.forEach(function (r) { setRowLoc(r, v); }); }
  //       else { $('location').value = prevLoc; updateSourceHint(); }
  //     });
  //   });
  //   updateSourceHint(); 
  //   lookupEnhance($('tdsTax'), { newLabel: 'New TDS Tax', onNew: openTaxModal });
  //   txFill('');// fill on initial load
  // }
  function buildReferenceUI() {
    if ($('placeOfSupply')) {
      var states = typeof STATES_IN !== 'undefined' ? STATES_IN : [];
      fillOptions($('placeOfSupply'), states.map(function (s) { return [s[0], '[' + s[0] + '] - ' + s[1]]; }), 'Select a state');
    }
    if (S.salespersons.length) {
      $('spWrap').hidden = false;
      fillSelect($('salesperson'), S.salespersons, 'salesperson_id', 'salesperson_name', '— none —', '');
    }

    if (S.locations.length) {
      var primary = S.locations.filter(function (l) { return l.is_primary; })[0] || S.locations[0];
      $('locWrap').hidden = false;
      $('warehouseWrap').hidden = false;
      fillSelect($('location'), soLocList(), 'location_id', 'location_name', null, String(primary.location_id));
      fillWarehouses();
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
    
    // Enhance both dropdowns for the searchable UI
    ['location', 'itemLocation', 'payTerms', 'salesperson', 'priceList'].forEach(function (id) {
      lookupEnhance($(id), id === 'payTerms'
        ? { newLabel: 'New Payment Term', onNew: function () { openPaymentTermModal('so'); } }
        : null);
    });

    $('location').addEventListener('change', fillWarehouses);   // parent changed → reload its child warehouses

    S.prevWh = $('itemLocation').value;
    $('itemLocation').addEventListener('change', function () {
      var v = $('itemLocation').value;
      if (v === S.prevWh) return;
      if (!S.rows.some(function (r) { return r.loc !== v; })) { S.prevWh = v; return; }
      askConfirm('Apply this warehouse location to all item rows?').then(function (ok) {
        if (ok) { S.prevWh = v; S.rows.forEach(function (r) { setRowLoc(r, v); }); }
        else { $('itemLocation').value = S.prevWh; }
      });
    });

    // Changing the top Location updates the Source of Supply hint and the item-table warehouse
$('location').addEventListener('change', function () {
  updateSourceHint();
  var v = $('location').value;
  if ($('itemLocation').value !== v) {
    $('itemLocation').value = v;
    $('itemLocation').dispatchEvent(new Event('change', { bubbles: true }));   // reuses your "apply to all rows?" confirm
  }
});
updateSourceHint();
    lookupEnhance($('tdsTax'), { newLabel: 'New TDS Tax', onNew: openTaxModal });
    txFill('');// fill on initial load
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
      Promise.resolve(loadNcRefs()).then(function () { soFillTerms(); refreshTaxSelects(); });
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
    ciInit();

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
    $('tdsTax').addEventListener('mousedown', function () {
      loadTaxes().then(function () { var id = $('tdsTax').value; txFill(id); });
    });

    $('priceList').addEventListener('change', function () {
      var id = $('priceList').value, prevId = S.pricebook ? String(S.pricebook.pricebook_id) : '';
      if (id === prevId) return;
      var pb = S.pricebooks.filter(function (p) { return String(p.pricebook_id) === id; })[0] || null;
      function apply() {
        S.touched.priceList = true;
        S.pricebook = pb;
        S.rows.forEach(function (r) {
          setRowPb(r, pb);
          if (r.item) { r.rateTouched = false; refreshRate(r, true); }
        });
        $('rowNotice').textContent = '';
        recalc();
      }
      if (!S.rows.some(function (r) { return r.item; })) { apply(); return; }
      askConfirm('Apply this price list to all items? Item rates will be replaced (discounts are not changed).')
        .then(function (ok) { if (ok) apply(); else $('priceList').value = prevId; });
    });

    $('discLevel').addEventListener('change', function () {
      var entity = $('discLevel').value === 'entity_level';
      $('entityDiscRow').hidden = !entity;
      Array.prototype.forEach.call(document.querySelectorAll('.item-row .c-disc input, .item-row .c-disc select'), function (i) { i.disabled = entity; });
      $('thDisc').textContent = entity ? '' : 'Discount';
      recalc();
    });

    $('btnAddRow').addEventListener('click', function () {
      var r = addRow();
      r.refs.item.focus();
    });
    $('btnBulk').addEventListener('click', openBulk);
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
    $('hsnSave').addEventListener('click', hsnSave);
$('hsnCancel').addEventListener('click', function () { $('hsnModal').hidden = true; });
$('hsnClose').addEventListener('click', function () { $('hsnModal').hidden = true; });
$('tagSave').addEventListener('click', tagSave);
$('tagCancel').addEventListener('click', function () { $('tagModal').hidden = true; });
$('tagClose').addEventListener('click', function () { $('tagModal').hidden = true; });
Array.prototype.forEach.call(document.querySelectorAll('input[name="tds_tcs"]'), function (r) {
  r.addEventListener('change', function () { txFill(''); recalc(); });
});
$('tdsTax').addEventListener('change', recalc);
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