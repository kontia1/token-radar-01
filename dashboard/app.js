/* Token Radar page.
 *
 * Renders window.RADAR (written by main.ts into out/data.js) with no fetch, no network and no library.
 * Every number on screen comes from the model, never from this file. What this file adds is the reading
 * order: the board first, then one protocol's numbers, then the arguments behind its place.
 *
 * THE MODEL, AS THE PAGE SHOWS IT (lib/model.ts holds the same constants with the full reasoning):
 *
 *   base     = tvl_usd * M.value_share             the float a token would put in play, as a share of TVL;
 *                                                  M.value_share is the snapshot's own median mcap/TVL over
 *                                                  its token-bearing protocols, clamped; 0.22 is the prior
 *   momentum = 1 + clamp(change_7d, -40, 80)/100 * 0.5
 *   age      = 0.85 + min(age_days, 2190)/2190 * 0.35      years with no token is a proven book
 *   category = first band matching the category: lending 1.40, DEX 1.34, perps 1.30, CDP 1.24,
 *              restaking 1.22, yield 1.16, staking 1.10, curator 1.08, RWA 1.05, bridge 1.00,
 *              games/NFT 0.80, meme 0.72, unmatched 0.92
 *   chain    = min(1.35, 1 + 0.16 if it holds Ethereum/Solana/Base + 0.05 per further chain)
 *   implied  = round(base * momentum * age * category * chain), never below 1
 *   score    = round(quality / best reachable quality * 100)   quality = the four multipliers multiplied
 *
 * The detail panel prints that product term by term for the selected row, so a reader can disagree with
 * one multiplier without having to disagree with the ranking.
 */
(function () {
  'use strict';

  var R = window.RADAR;
  var $ = function (id) { return document.getElementById(id); };

  if (!R || !Array.isArray(R.rows)) {
    $('count').textContent = 'data.js did not load: open this page from the build output directory.';
    return;
  }

  var M = R.model;
  var rows = R.rows;
  var bySlug = {};
  for (var i = 0; i < rows.length; i++) bySlug[rows[i].slug] = rows[i];

  var state = {
    sort: 'rank',
    dir: 1,
    q: '',
    category: '',
    chain: '',
    minTvl: 0,
    watchOnly: false,
    selected: null
  };

  // ------------------------------------------------------------------ formatters

  function usd(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }

  function pct(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  }

  function mult(n) { return '×' + n.toFixed(2); }

  function days(n) {
    if (typeof n !== 'number' || !isFinite(n)) return 'unknown';
    if (n >= 365) return (n / 365).toFixed(1) + ' yr';
    return n + ' d';
  }

  function chainCell(chains) {
    if (!chains || chains.length === 0) return '—';
    if (chains.length <= 2) return chains.join(', ');
    return chains.slice(0, 2).join(', ') + ' +' + (chains.length - 2);
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  // ------------------------------------------------------------------ filters

  function categoryOptions() {
    var seen = {};
    var list = [];
    rows.forEach(function (r) {
      var c = r.category || 'Uncategorised';
      if (!seen[c]) { seen[c] = 0; list.push(c); }
      seen[c] += 1;
    });
    list.sort(function (a, b) { return seen[b] - seen[a] || (a < b ? -1 : 1); });
    return list.map(function (c) { return { name: c, count: seen[c] }; });
  }

  function chainOptions() {
    var seen = {};
    var list = [];
    rows.forEach(function (r) {
      (r.chains || []).forEach(function (c) {
        if (!seen[c]) { seen[c] = 0; list.push(c); }
        seen[c] += 1;
      });
    });
    list.sort(function (a, b) { return seen[b] - seen[a] || (a < b ? -1 : 1); });
    return list.map(function (c) { return { name: c, count: seen[c] }; });
  }

  function haystack(r) {
    return [
      r.name, r.slug, r.category || '', (r.chains || []).join(' '), r.category_why || ''
    ].join(' ').toLowerCase();
  }

  function visible() {
    var q = state.q.trim().toLowerCase();
    var out = rows.filter(function (r) {
      if (state.watchOnly && !r.on_watchlist) return false;
      if (state.category && (r.category || 'Uncategorised') !== state.category) return false;
      if (state.chain && (r.chains || []).indexOf(state.chain) === -1) return false;
      if (state.minTvl > 0 && !(r.tvl_usd >= state.minTvl * 1e6)) return false;
      if (q && haystack(r).indexOf(q) === -1) return false;
      return true;
    });
    out.sort(comparator());
    return out;
  }

  function valueOf(r, key) {
    if (key === 'chains') return (r.chains || []).length;
    if (key === 'name' || key === 'category') return (r[key] || '').toLowerCase();
    var v = r[key];
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  function comparator() {
    var key = state.sort;
    var dir = state.dir;
    return function (a, b) {
      var x = valueOf(a, key);
      var y = valueOf(b, key);
      if (x === null && y === null) return a.rank - b.rank;
      if (x === null) return 1;      // a missing 7 day print always sinks, either direction
      if (y === null) return -1;
      if (x < y) return -1 * dir;
      if (x > y) return 1 * dir;
      return a.rank - b.rank;
    };
  }

  // ------------------------------------------------------------------ the table

  var tbody = $('rows');
  var empty = $('empty');
  var count = $('count');

  function renderTable() {
    var list = visible();
    tbody.textContent = '';
    var frag = document.createDocumentFragment();

    list.forEach(function (r) {
      var tr = el('tr');
      tr.tabIndex = 0;
      tr.dataset.slug = r.slug;
      tr.setAttribute('aria-label', 'Rank ' + r.rank + ', ' + r.name + ', implied value ' + usd(r.implied_value_usd));
      if (state.selected === r.slug) tr.className = 'selected';

      var tdRank = el('td', 'num rank');
      tdRank.textContent = r.rank;
      tr.appendChild(tdRank);

      var tdWho = el('td');
      var who = el('div', 'who');
      var name = el('span', 'n');
      name.textContent = r.name;
      if (r.on_watchlist) {
        var star = el('span', 'star', '★');
        star.title = 'on the sealed watchlist';
        name.appendChild(star);
      }
      who.appendChild(name);
      who.appendChild(el('span', 's', r.slug));
      tdWho.appendChild(who);
      tr.appendChild(tdWho);

      tr.appendChild(el('td', 'cat', r.category || '—'));

      var tdChains = el('td', 'chains chains-col');
      tdChains.textContent = chainCell(r.chains);
      tdChains.title = (r.chains || []).join(', ');
      tr.appendChild(tdChains);

      var tdTvl = el('td', 'num');
      tdTvl.textContent = usd(r.tvl_usd);
      tr.appendChild(tdTvl);

      var tdChg = el('td', 'num');
      if (typeof r.change_7d === 'number' && isFinite(r.change_7d)) {
        tdChg.textContent = pct(r.change_7d);
        tdChg.className = 'num ' + (r.change_7d > 0.5 ? 'up' : r.change_7d < -0.5 ? 'down' : 'flat');
      } else {
        tdChg.textContent = '—';
        tdChg.className = 'num flat';
      }
      tr.appendChild(tdChg);

      var tdValue = el('td', 'num value');
      tdValue.textContent = usd(r.implied_value_usd);
      tr.appendChild(tdValue);

      var tdScore = el('td', 'num');
      var wrap = el('span', 'score');
      var bar = el('span', 'bar');
      var fill = el('i');
      fill.style.width = Math.max(2, Math.min(100, r.score)) + '%';
      bar.appendChild(fill);
      wrap.appendChild(bar);
      wrap.appendChild(el('span', null, r.score));
      tdScore.appendChild(wrap);
      tdScore.title = 'score ' + r.score + ' of 100: the four multipliers relative to the best reachable product';
      tr.appendChild(tdScore);

      frag.appendChild(tr);
    });

    tbody.appendChild(frag);
    empty.hidden = list.length !== 0;

    if (list.length === 0) {
      count.textContent = '0 of ' + rows.length + ' rows match';
    } else {
      count.innerHTML = '';
      count.appendChild(el('b', null, list.length + ' of ' + rows.length));
      count.appendChild(document.createTextNode(
        ' rows · rank ' + list[0].rank + ' to ' + list[list.length - 1].rank +
        ' · implied value ' + usd(list[0].implied_value_usd) + ' to ' + usd(list[list.length - 1].implied_value_usd)
      ));
    }
  }

  function markSort() {
    var ths = document.querySelectorAll('thead th');
    for (var i = 0; i < ths.length; i++) ths[i].removeAttribute('aria-sort');
    var btn = document.querySelector('thead th button[data-sort="' + state.sort + '"]');
    if (btn) {
      btn.parentNode.setAttribute('aria-sort', state.dir === 1 ? 'ascending' : 'descending');
    }
  }

  // ------------------------------------------------------------------ the detail

  var detail = $('detail');

  function ladderRow(label, why, factor, running, lift) {
    var tr = el('tr');

    var td1 = el('td', 'factor');
    td1.textContent = label;
    tr.appendChild(td1);

    var td2 = el('td', 'num');
    td2.textContent = factor;
    tr.appendChild(td2);

    var td3 = el('td', 'num');
    td3.textContent = usd(running);
    tr.appendChild(td3);

    var td4 = el('td', 'num');
    if (lift === null) {
      td4.textContent = '—';
    } else {
      td4.textContent = (lift > 0 ? '+' : '') + lift.toFixed(0) + '%';
      td4.className = 'num ' + (lift > 0 ? 'plus' : lift < 0 ? 'minus' : 'flat');
    }
    tr.appendChild(td4);

    var td5 = el('td', 'why');
    td5.textContent = why;
    tr.appendChild(td5);

    return tr;
  }

  function renderDetail(slug) {
    var r = bySlug[slug];
    if (!r) return;
    detail.textContent = '';
    detail.removeAttribute('data-empty');

    var m = r.model;

    // head
    var head = el('div', 'd-head');
    head.appendChild(el('div', 'd-rank', 'Rank ' + r.rank + ' of ' + rows.length + (r.on_watchlist ? ' · ★ watchlist' : ' · below the floor')));
    head.appendChild(el('h2', 'd-name', r.name));

    var meta = el('p', 'd-meta');
    meta.appendChild(document.createTextNode((r.category || 'Uncategorised')));
    meta.appendChild(el('span', 'dot', '·'));
    meta.appendChild(document.createTextNode((r.chains || []).join(', ') || 'no chain recorded'));
    head.appendChild(meta);

    var badge = el('span', 'badge');
    badge.textContent = 'no token in the record';
    head.appendChild(badge);

    var listed = el('p', 'd-meta');
    listed.textContent = 'Listed ' + (r.listed_at || 'unknown') + ' · age ' + days(r.age_days) + ' with no token';
    head.appendChild(listed);

    detail.appendChild(head);

    // numbers
    var stats = el('dl', 'd-stats');
    [
      ['TVL', usd(r.tvl_usd)],
      ['7d TVL', pct(r.change_7d)],
      ['Chains', (r.chains || []).length],
      ['Implied value', usd(r.implied_value_usd)],
      ['Score', r.score + ' / 100'],
      ['Momentum', mult(m.growth_multiplier)]
    ].forEach(function (pair) {
      var d = el('div');
      d.appendChild(el('dt', null, pair[0]));
      d.appendChild(el('dd', null, pair[1]));
      stats.appendChild(d);
    });
    detail.appendChild(stats);

    // why this ranks here
    var whySec = el('section', 'd-sec');
    var whyHead = el('h3', null, 'Why this ranks here');
    whyHead.appendChild(el('em', null, 'base × four multipliers'));
    whySec.appendChild(whyHead);
    whySec.appendChild(el('p', null,
      'The row starts from its TVL read as a float, then each multiplier moves it. Lift is that ' +
      'multiplier’s own effect on the figure, not a share of the total.'));

    var table = el('table', 'ladder');
    var thead = el('thead');
    var htr = el('tr');
    [['step', ''], ['factor', 'num'], ['running', 'num'], ['lift', 'num'], ['why', '']].forEach(function (h) {
      var th = el('th', h[1], h[0]);
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    var tb = el('tbody');
    var running = m.base_usd;
    var baseWhy = M.value_share_basis === 'snapshot-median'
      ? 'the float a launch would carry: the snapshot’s median mcap/TVL across ' + M.value_share_sample + ' token-bearing protocols'
      : 'the float a launch would carry, at the model’s prior share of the book';
    tb.appendChild(ladderRow('TVL × ' + M.value_share, baseWhy, usd(r.tvl_usd), running, null));

    var steps = [
      ['momentum', m.growth_multiplier, '7d TVL ' + pct(r.change_7d) + ', clamped to −' + Math.abs(M.growth_floor) + '%..+' + M.growth_cap + '% and weighted ' + M.growth_weight],
      ['age', m.age_multiplier, days(r.age_days) + ' with no token, full credit at ' + M.age_full_days + ' days'],
      ['category', m.category_multiplier, r.category_why || 'default band (' + M.category_default + ')'],
      ['chain', m.chain_multiplier, (r.chains || []).length + ' chain(s): +' + M.chain_home_bonus + ' for a home chain, +' + M.chain_extra_bonus + ' each further, capped at ×' + M.chain_cap]
    ];
    var prev = running;
    steps.forEach(function (s) {
      running = prev * s[1];
      var lift = (s[1] - 1) * 100;
      tb.appendChild(ladderRow(s[0], s[2], mult(s[1]), running, lift));
      prev = running;
    });

    var totalTr = el('tr');
    var a = el('td', 'factor total', 'implied value');
    totalTr.appendChild(a);
    totalTr.appendChild(el('td', 'num', ''));
    var b = el('td', 'num total', usd(r.implied_value_usd));
    totalTr.appendChild(b);
    totalTr.appendChild(el('td', 'num', ''));
    var c = el('td', 'why', 'score ' + r.score + ' of 100 on the same product, against the best reachable ×' + M.score_ceiling);
    totalTr.appendChild(c);
    tb.appendChild(totalTr);

    table.appendChild(tb);
    whySec.appendChild(table);
    detail.appendChild(whySec);

    // the plan
    var planSec = el('section', 'd-sec');
    var planHead = el('h3', null, 'The farm plan');
    planHead.appendChild(el('em', null, r.farm_steps.length + ' steps, from this row’s own numbers'));
    planSec.appendChild(planHead);

    var ol = el('ol', 'steps');
    r.farm_steps.forEach(function (step) {
      var li = el('li');
      var colon = step.indexOf(':');
      if (colon > 0 && colon < 28) {
        li.appendChild(el('b', null, step.slice(0, colon + 1)));
        li.appendChild(document.createTextNode(step.slice(colon + 1)));
      } else {
        li.textContent = step;
      }
      ol.appendChild(li);
    });
    planSec.appendChild(ol);
    detail.appendChild(planSec);

    var foot = el('p', 'd-foot');
    foot.textContent = 'Implied value is a share of TVL under this model, not a price target or a forecast. ' +
      'Snapshot ' + R.as_of + ', source ' + R.source + ', model ' + R.model_version + '.';
    detail.appendChild(foot);

    if (window.innerWidth <= 1180) {
      detail.scrollIntoView({ block: 'start', behavior: 'auto' });
    }
  }

  function select(slug, focusRow) {
    state.selected = slug;
    var trs = tbody.querySelectorAll('tr');
    for (var i = 0; i < trs.length; i++) {
      var on = trs[i].dataset.slug === slug;
      trs[i].classList.toggle('selected', on);
      if (on && focusRow) trs[i].focus();
    }
    renderDetail(slug);
  }

  // ------------------------------------------------------------------ wiring

  function fillSelect(node, list, allLabel) {
    var keep = node.value;
    node.textContent = '';
    var all = el('option', null, allLabel);
    all.value = '';
    node.appendChild(all);
    list.forEach(function (item) {
      var opt = el('option', null, item.name + '  (' + item.count + ')');
      opt.value = item.name;
      node.appendChild(opt);
    });
    node.value = keep;
  }

  fillSelect($('category'), categoryOptions(), 'all categories');
  fillSelect($('chain'), chainOptions(), 'all chains');

  $('q').addEventListener('input', function (e) {
    state.q = e.target.value;
    renderTable();
  });
  $('category').addEventListener('change', function (e) {
    state.category = e.target.value;
    renderTable();
  });
  $('chain').addEventListener('change', function (e) {
    state.chain = e.target.value;
    renderTable();
  });
  $('tvl').addEventListener('change', function (e) {
    state.minTvl = Number(e.target.value) || 0;
    renderTable();
  });
  $('watch').addEventListener('change', function (e) {
    state.watchOnly = e.target.checked;
    renderTable();
  });

  $('controls').addEventListener('reset', function () {
    window.setTimeout(function () {
      state.q = '';
      state.category = '';
      state.chain = '';
      state.minTvl = 0;
      state.watchOnly = false;
      renderTable();
    }, 0);
  });

  var headers = document.querySelectorAll('thead th button[data-sort]');
  for (var h = 0; h < headers.length; h++) {
    headers[h].addEventListener('click', function (e) {
      var key = e.currentTarget.dataset.sort;
      if (state.sort === key) {
        state.dir = state.dir === 1 ? -1 : 1;
      } else {
        state.sort = key;
        state.dir = key === 'rank' || key === 'name' || key === 'category' ? 1 : -1;
      }
      markSort();
      renderTable();
      var first = tbody.querySelector('tr');
      if (first) first.focus();
    });
  }

  tbody.addEventListener('click', function (e) {
    var tr = e.target.closest('tr');
    if (tr && tr.dataset.slug) select(tr.dataset.slug, false);
  });

  tbody.addEventListener('keydown', function (e) {
    var tr = e.target.closest('tr');
    if (!tr) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select(tr.dataset.slug, true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      var next = e.key === 'ArrowDown' ? tr.nextElementSibling : tr.previousElementSibling;
      if (next) {
        next.focus();
        select(next.dataset.slug, false);
      }
    }
  });

  document.addEventListener('keydown', function (e) {
    var typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (e.key === '/' && !typing) {
      e.preventDefault();
      $('q').focus();
    } else if (e.key === 'Escape') {
      if (typing && document.activeElement.id === 'q' && $('q').value !== '') {
        $('q').value = '';
        state.q = '';
        renderTable();
      } else {
        $('reset').click();
      }
    }
  });

  // ------------------------------------------------------------------ boot

  $('as-of').textContent = R.as_of;
  $('universe').textContent = R.universe.protocols + ' (' + R.universe.pre_token + ' no token)';
  $('ranked').textContent = R.universe.ranked + ' of ' + R.universe.pre_token;
  $('model-version').textContent = R.model_version;

  // The base is calibrated per run, so no static number in the page can be allowed to drift from it.
  var shareText = String(M.value_share).replace(/0+$/, '').replace(/\.$/, '');
  $('base-share').textContent = shareText;
  $('base-share-note').textContent = shareText;
  $('base-source').textContent = M.value_share_basis === 'snapshot-median'
    ? '(peer median of ' + M.value_share_sample + ')'
    : '(model prior)';

  detail.setAttribute('data-empty', '1');
  markSort();
  renderTable();

  // Open the strongest row on a wide screen: the page should explain itself before it is clicked.
  if (window.innerWidth > 1180 && rows.length > 0) {
    select(rows[0].slug, false);
  }
})();
