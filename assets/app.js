(function () {
  'use strict';

  var KB = window.KB;
  var layers = KB.layers, nodes = KB.nodes, items = KB.items;
  var nodeById = {}, itemById = {}, idxById = {};
  nodes.forEach(function (n) { nodeById[n.id] = n; });
  items.forEach(function (it, i) { itemById[it.id] = it; idxById[it.id] = i; });

  var view = document.getElementById('view');
  var side = document.getElementById('side');
  var q = document.getElementById('q');
  var qres = document.getElementById('qres');

  var PROG_KEY = 'review-progress-v1';
  var prog = {};
  try { prog = JSON.parse(localStorage.getItem(PROG_KEY) || '{}') || {}; } catch (e) { prog = {}; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function saveProg() {
    try { localStorage.setItem(PROG_KEY, JSON.stringify(prog)); } catch (e) {}
  }

  /* ---------------------------------------------------------- 进度与复习计划
     prog[id] 兼容两种形态：
       旧：'solid' / 'learning'
       新：{ s, n, due, last, lapses }
     due 是「下次该复习的日期」，由掌握度标记与复习动作共同推进。 */

  var INTERVALS = [1, 3, 7, 15, 30, 60];   // 连续答对第 n 次后的间隔（天）
  var EV_ORDER = ['简历关联', '生产故障', '项目实践', '面试高频', '体系补全'];

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function addDays(str, n) {
    var p = (str || todayStr()).split('-');
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function entry(id) {
    var v = prog[id];
    if (!v) return null;
    if (typeof v === 'string') { v = { s: v }; prog[id] = v; }
    if (v.s !== 'solid' && v.s !== 'learning') return null;
    return v;
  }
  function stOf(id) { var e = entry(id); return e ? e.s : 'todo'; }
  function setStatus(id, s) {
    if (s === 'todo') { delete prog[id]; saveProg(); return; }
    var e = entry(id) || {};
    var today = todayStr();
    if (!e.s || e.s !== s) {
      e.n = s === 'solid' ? (e.n || 1) : 0;
      e.last = today;
      e.due = addDays(today, 1);
    }
    if (!e.due) e.due = addDays(today, 1);
    e.s = s;
    prog[id] = e;
    saveProg();
  }
  function reviewStep(id, ok) {
    var e = entry(id) || { s: 'learning', n: 0 };
    var today = todayStr();
    if (ok) { e.n = (e.n || 0) + 1; e.s = 'solid'; }
    else { e.n = 0; e.lapses = (e.lapses || 0) + 1; e.s = 'learning'; }
    e.due = addDays(today, ok ? INTERVALS[Math.min(e.n, INTERVALS.length - 1)] : 1);
    e.last = today;
    prog[id] = e;
    saveProg();
  }
  function evRank(it) { var i = EV_ORDER.indexOf(it.event); return i === -1 ? 99 : i; }
  function dueList() {
    var today = todayStr();
    return items.filter(function (it) {
      var e = entry(it.id);
      return e && e.due && e.due <= today;
    }).sort(function (a, b) {
      var ea = entry(a.id), eb = entry(b.id);
      var la = ea.lapses || 0, lb = eb.lapses || 0;
      if (la !== lb) return lb - la;                    // 总忘的优先
      if (ea.due !== eb.due) return ea.due < eb.due ? -1 : 1;  // 拖得久的优先
      return evRank(a) - evRank(b);                      // 简历关联优先
    });
  }
  function learnedCount() {
    return items.filter(function (it) { return !!entry(it.id); }).length;
  }

  var DIR_ORDER = ['Java 并发', 'JVM', 'MySQL', 'Redis', '消息队列', '微服务', 'Spring', '系统设计', '支付清算', '财资业务'];
  function orderedDirs(map) {
    var ks = [];
    DIR_ORDER.forEach(function (d) { if (map[d]) ks.push(d); });
    Object.keys(map).forEach(function (d) { if (ks.indexOf(d) === -1) ks.push(d); });
    return ks;
  }
  function groupBy(arr, key) {
    var m = {};
    arr.forEach(function (x) {
      var k = x[key] || '未分类';
      (m[k] = m[k] || []).push(x);
    });
    return m;
  }
  function covered(n) { return n.cards.length > 0 || n.scenarios.length > 0; }
  function layerPct(lid) {
    var ns = nodes.filter(function (n) { return n.layer === lid; });
    if (!ns.length) return 0;
    return Math.round(ns.filter(covered).length * 100 / ns.length);
  }

  /* ------------------------------------------------------------ 侧栏 */
  var FOLD_KEY = 'review-side-fold-v1';
  var folds = {};
  try { folds = JSON.parse(localStorage.getItem(FOLD_KEY) || '{}') || {}; } catch (e) { folds = {}; }

  function renderSide() {
    var g = groupBy(items, 'direction');
    var h = '';
    orderedDirs(g).forEach(function (dir) {
      var list = g[dir];
      h += '<div class="sgwrap' + (folds[dir] ? ' closed' : '') + '" data-dir="' + esc(dir) + '">' +
        '<div class="sgroup" title="点击折叠/展开">' + esc(dir) +
        ' <span class="cnt">' + list.length + '</span><span class="caret">▾</span></div>';
      list.forEach(function (it) {
        var st = stOf(it.id);
        h += '<a class="slink" href="#/card/' + it.id + '" data-id="' + it.id + '">' +
          '<span class="dot ' + (st === 'todo' ? '' : st) + '"></span>' +
          '<span class="nm">' + esc(it.title) + '</span></a>';
      });
      h += '</div>';
    });
    side.innerHTML = h;
    Array.prototype.forEach.call(side.querySelectorAll('.sgroup'), function (gd) {
      gd.addEventListener('click', function () {
        var wrap = gd.parentNode;
        var closed = wrap.classList.toggle('closed');
        folds[wrap.dataset.dir] = closed;
        try { localStorage.setItem(FOLD_KEY, JSON.stringify(folds)); } catch (e) {}
      });
    });
    markSide();
  }
  function markSide() {
    var id = currentCardId();
    Array.prototype.forEach.call(side.querySelectorAll('.slink'), function (a) {
      a.classList.toggle('on', a.dataset.id === id);
    });
  }
  function currentCardId() {
    var p = parts();
    return p[0] === 'card' ? p[1] : null;
  }

  /* ------------------------------------------------------------ 路由 */
  function parts() {
    return location.hash.replace(/^#/, '').split('/').filter(Boolean);
  }
  function setTabs(name) {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      var href = t.getAttribute('href').replace('#/', '');
      var on = (name === 'home' && href === '') || href === name;
      t.classList.toggle('on', on);
    });
  }
  function route() {
    var p = parts();
    var head = p[0] || '';
    if (head === 'card' && p[1]) { viewCard(decodeURIComponent(p[1])); setTabs(''); }
    else if (head === 'node' && p[1]) { viewNode(p[1]); setTabs('roadmap'); }
    else if (head === 'roadmap') { viewRoadmap(); setTabs('roadmap'); }
    else if (head === 'graph') { viewGraph(); setTabs('graph'); }
    else if (head === 'cards') { viewList(); setTabs('cards'); }
    else if (head === 'review') { viewReview(); setTabs('review'); }
    else { viewHome(); setTabs('home'); }
    markSide();
  }

  /* ------------------------------------------------------------ 总览 */
  function viewHome() {
    var cov = nodes.filter(covered).length;
    var nc = items.filter(function (i) { return i.kind === 'card'; }).length;
    var ns = items.filter(function (i) { return i.kind === 'scenario'; }).length;
    var solid = items.filter(function (i) { return stOf(i.id) === 'solid'; }).length;
    var learning = items.filter(function (i) { return stOf(i.id) === 'learning'; }).length;
    var gaps = nodes.filter(function (n) { return !covered(n); });

    var h = '<div class="hd"><h1>复习总览</h1>' +
      '<p>六层能力模型 · ' + nodes.length + ' 个知识点 · 内容更新于 ' + esc(KB.generated) + '</p></div>';

    h += '<div class="stats">' +
      stat(cov + '/' + nodes.length, '知识点覆盖', Math.round(cov * 100 / nodes.length)) +
      stat(nc, '知识卡片', null) +
      stat(ns, '场景题', null) +
      stat(solid + '/' + items.length, '已能讲', Math.round(solid * 100 / items.length)) +
      '</div>';

    var due = dueList();
    if (due.length) {
      h += '<div class="duebar"><div class="db-l"><b>今天该复习 ' + due.length + ' 篇</b>' +
        '<span>按遗忘曲线排的，先过总忘的和拖得最久的</span></div>' +
        '<a class="btn primary" href="#/review">开始复习</a></div>';
    } else if (learnedCount()) {
      h += '<div class="duebar calm"><div class="db-l"><b>今天没有待复习</b>' +
        '<span>已学 ' + learnedCount() + ' 篇，新标记的内容明天进队列</span></div>' +
        '<a class="btn" href="#/review">查看队列</a></div>';
    } else {
      h += '<div class="duebar calm"><div class="db-l"><b>还没有复习记录</b>' +
        '<span>读完一篇后标记「能讲」，它会自动进入明天的复习队列</span></div>' +
        '<a class="btn" href="#/cards">去读第一篇</a></div>';
    }

    h += '<div class="sec"><h2>能力分层 <em>资格层决定能否过面，护城河决定定级</em></h2>';
    layers.forEach(function (L) {
      var p = layerPct(L.id);
      h += '<div class="layrow"><span class="lid">' + L.id + '</span>' +
        '<span class="lname">' + esc(L.name) + '</span>' +
        '<span class="lbar"><i style="width:' + p + '%"></i></span>' +
        '<span class="lpct">' + p + '%</span></div>';
    });
    h += '</div>';

    if (gaps.length) {
      h += '<div class="sec"><h2>待补缺口 <em>' + gaps.length + ' 个节点还没有内容</em></h2><div class="gaps">';
      gaps.forEach(function (n) {
        h += '<a class="gapchip" href="#/node/' + n.id + '"><b>' + n.id + '</b> ' + esc(n.name) + '</a>';
      });
      h += '</div></div>';
    }

    var next = items.filter(function (i) { return stOf(i.id) === 'todo'; })
      .sort(function (a, b) {
        var d = evRank(a) - evRank(b);
        if (d) return d;
        return a.kind === b.kind ? 0 : (a.kind === 'scenario' ? -1 : 1);
      }).slice(0, 5);
    if (next.length) {
      h += '<div class="sec"><h2>下一步学什么 <em>按「简历关联 &gt; 生产故障 &gt; 项目实践」排的</em></h2>';
      next.forEach(function (it) { h += rowItem(it); });
      h += '</div>';
    }

    view.className = '';
    view.innerHTML = h;
    view.scrollTop = 0;
  }
  function stat(v, k, pct) {
    return '<div class="stat"><div class="v">' + esc(v) + '</div><div class="k">' + esc(k) + '</div>' +
      (pct != null ? '<div class="bar"><i style="width:' + pct + '%"></i></div>' : '') + '</div>';
  }

  /* ------------------------------------------------------------ 今日复习 */
  var reviewMsg = '';
  function dayDiff(from, to) {
    var a = from.split('-'), b = to.split('-');
    var t1 = new Date(+a[0], +a[1] - 1, +a[2]).getTime();
    var t2 = new Date(+b[0], +b[1] - 1, +b[2]).getTime();
    return Math.round((t2 - t1) / 86400000);
  }
  function viewReview() {
    var today = todayStr();
    var due = dueList();
    var solid = items.filter(function (i) { return stOf(i.id) === 'solid'; }).length;
    var done = items.filter(function (i) { var e = entry(i.id); return e && e.last === today; }).length;

    var h = '<div class="hd"><h1>今日复习</h1><p>' + today +
      ' · 间隔按 1 / 3 / 7 / 15 / 30 / 60 天递进，答错回到 1 天</p></div>';

    h += '<div class="stats three">' +
      stat(due.length, '待复习', null) +
      stat(done, '今天已复习', null) +
      stat(solid + '/' + items.length, '已能讲', Math.round(solid * 100 / items.length)) +
      '</div>';

    if (reviewMsg) {
      h += '<div class="reviewmsg">' + esc(reviewMsg) + '</div>';
    }

    if (!due.length) {
      var fresh = items.filter(function (i) { return stOf(i.id) === 'todo'; })
        .sort(function (a, b) { return evRank(a) - evRank(b); }).slice(0, 3);
      h += '<div class="emptybox"><b>队列空了</b>' +
        '<p>没有到期的卡片。标记「能讲」的内容会在第二天进来，答错则第二天再来一次。</p></div>';
      if (fresh.length) {
        h += '<div class="sec"><h2>还没学过的高优先级内容</h2>';
        fresh.forEach(function (it) { h += rowItem(it); });
        h += '</div>';
      }
      view.className = '';
      view.innerHTML = h;
      view.scrollTop = 0;
      return;
    }

    h += '<div class="sec"><h2>轮到这些 <em>先过总忘的，再过拖得久的</em></h2>';
    due.forEach(function (it) {
      var e = entry(it.id);
      var late = dayDiff(e.due, today);
      var meta = [
        it.direction,
        it.event,
        '第 ' + (e.n || 0) + ' 次',
        '上次 ' + (e.last || '—'),
        late > 0 ? '逾期 ' + late + ' 天' : '今天到期',
        (e.lapses ? '忘过 ' + e.lapses + ' 次' : '')
      ].filter(Boolean).join(' · ');
      h += '<div class="rcard" data-id="' + it.id + '">' +
        '<div class="rc-main">' +
        '<div class="rc-t">' + (it.kind === 'scenario' ? '<span class="pill sc">场景</span> ' : '') +
        '<a href="#/card/' + it.id + '">' + esc(it.title) + '</a></div>' +
        '<div class="rc-m">' + esc(meta) + '</div>' +
        '<div class="rc-d">' + esc(it.excerpt || '') + '</div>' +
        '</div>' +
        '<div class="rc-act">' +
        '<a class="btn" href="#/card/' + it.id + '">先读一遍</a>' +
        '<button class="btn ok" data-act="ok" data-id="' + it.id + '">记住了</button>' +
        '<button class="btn warn" data-act="no" data-id="' + it.id + '">忘了</button>' +
        '</div></div>';
    });
    h += '</div>';

    view.className = '';
    view.innerHTML = h;
    view.scrollTop = 0;

    Array.prototype.forEach.call(view.querySelectorAll('.rc-act button'), function (b) {
      b.addEventListener('click', function () {
        var id = b.dataset.id;
        var it = itemById[id];
        reviewStep(id, b.dataset.act === 'ok');
        var e = entry(id);
        reviewMsg = '「' + (it ? it.title : id) + '」已记录，下次复习 ' + e.due +
          (b.dataset.act === 'ok' ? '（第 ' + e.n + ' 次，间隔 ' + (INTERVALS[Math.min(e.n - 1, INTERVALS.length - 1)]) + ' 天）' : '（回到 1 天后再来）');
        viewReview();
        renderSide();
      });
    });
  }

  /* ------------------------------------------------------------ 路线图 */
  function viewRoadmap() {
    var h = '<div class="hd"><h1>六层能力路线</h1>' +
      '<p>从下到上逐层打通：前四层是资格线，后两层是溢价线。虚线框为待补节点。</p></div>';
    layers.forEach(function (L) {
      var ns = nodes.filter(function (n) { return n.layer === L.id; });
      h += '<div class="layer"><div class="lhead"><span class="lid">' + L.id + '</span>' +
        '<span class="lname">' + esc(L.name) + '</span>' +
        '<span class="lrole">' + esc(L.role) + ' · ' + esc(L.desc) + '</span>' +
        '<span class="lpct">' + layerPct(L.id) + '%</span></div><div class="ngrid">';
      ns.forEach(function (n) {
        var c = covered(n);
        h += '<a class="nodebox' + (c ? '' : ' gap') + '" href="#/node/' + n.id + '">' +
          '<span class="nid">' + n.id + '</span>' +
          '<span class="nname">' + esc(n.name) + '</span>' +
          '<span class="nmeta">' + (c ? n.cards.length + ' 卡片 · ' + n.scenarios.length + ' 场景题' : '待补') +
          '</span></a>';
      });
      h += '</div></div>';
    });
    view.className = '';
    view.innerHTML = h;
    view.scrollTop = 0;
  }

  /* ------------------------------------------------------------ 图谱 */
  var G = { cols: 7, gap: 126, laneH: 138, top: 30, left: 205, w: 1030 };
  function nodePos() {
    var pos = {};
    layers.forEach(function (L, li) {
      var ns = nodes.filter(function (n) { return n.layer === L.id; });
      var span = (ns.length - 1) * G.gap;
      var startX = G.left + (G.cols - 1) * G.gap / 2 - span / 2;
      ns.forEach(function (n, i) {
        pos[n.id] = { x: startX + i * G.gap, y: G.top + li * G.laneH + 56 };
      });
    });
    return pos;
  }
  function viewGraph() {
    var pos = nodePos();
    var H = G.top + layers.length * G.laneH + 16;
    var svg = ['<svg viewBox="0 0 ' + G.w + ' ' + H + '" width="100%" style="min-width:760px" font-family="-apple-system,PingFang SC,sans-serif">'];

    layers.forEach(function (L, li) {
      var y = G.top + li * G.laneH;
      svg.push('<rect x="30" y="' + y + '" width="' + (G.w - 56) + '" height="112" rx="12" fill="#f8f9fb" stroke="#e3e7ee" stroke-width="1"/>');
      svg.push('<text x="46" y="' + (y + 26) + '" font-size="12" font-weight="600" fill="#2563eb">' + L.id + '</text>');
      svg.push('<text x="46" y="' + (y + 46) + '" font-size="12.5" fill="#46505e">' + esc(L.name) + '</text>');
      svg.push('<text x="46" y="' + (y + 64) + '" font-size="11" fill="#9aa4b2">' + layerPct(L.id) + '%</text>');
    });

    var scenarios = items.filter(function (i) { return i.kind === 'scenario'; });
    scenarios.forEach(function (s, si) {
      var pts = s.nodes.filter(function (id) { return pos[id]; }).map(function (id) { return pos[id]; });
      for (var a = 0; a < pts.length; a++) {
        for (var b = a + 1; b < pts.length; b++) {
          var p1 = pts[a], p2 = pts[b];
          var dx = p2.x - p1.x, dy = p2.y - p1.y;
          var k = 0.14 + si * 0.03;
          var mx = (p1.x + p2.x) / 2 - dy * k;
          var my = (p1.y + p2.y) / 2 + dx * k;
          svg.push('<path class="gline" data-sc="' + s.id + '" d="M' + p1.x + ',' + p1.y +
            ' Q' + mx + ',' + my + ' ' + p2.x + ',' + p2.y + '" fill="none" stroke="#e8b96a" stroke-width="1.4" opacity="0.55"/>');
        }
      }
    });

    nodes.forEach(function (n) {
      var p = pos[n.id];
      var c = covered(n);
      var cnt = n.cards.length + n.scenarios.length;
      var r = 17 + Math.min(cnt * 1.6, 8);
      svg.push('<g class="gnode" data-id="' + n.id + '" style="cursor:pointer">');
      svg.push('<circle cx="' + p.x + '" cy="' + p.y + '" r="' + r + '" fill="' + (c ? '#e8f0fe' : '#ffffff') +
        '" stroke="' + (c ? '#7ba7ee' : '#cbd3de') + '" stroke-width="1.2"' + (c ? '' : ' stroke-dasharray="4 3"') + '/>');
      svg.push('<text x="' + p.x + '" y="' + (p.y + 4) + '" text-anchor="middle" font-size="11.5" font-weight="600" fill="' +
        (c ? '#123fa8' : '#9aa4b2') + '">' + n.id + '</text>');
      svg.push('<text x="' + p.x + '" y="' + (p.y + r + 15) + '" text-anchor="middle" font-size="11.5" fill="#46505e">' + esc(n.name) + '</text>');
      svg.push('</g>');
    });

    svg.push('</svg>');

    var h = '<div class="hd"><h1>知识图谱</h1>' +
      '<p>圆点是知识点，越大关联内容越多；橙色曲线表示同一道场景题串联的多个知识点。</p></div>' +
      '<div class="graphwrap">' + svg.join('') + '</div>' +
      '<div style="margin-top:14px;font-size:12.5px;color:#9aa4b2">' +
      '场景题：' + scenarios.map(function (s) {
        return '<a href="#/card/' + s.id + '" style="margin-right:12px">' + esc(s.title) + '</a>';
      }).join('') + '</div>';

    view.className = 'wide';
    view.innerHTML = h;
    view.scrollTop = 0;

    Array.prototype.forEach.call(view.querySelectorAll('.gnode'), function (g) {
      g.addEventListener('click', function () { location.hash = '#/node/' + g.dataset.id; });
      g.addEventListener('mouseenter', function () {
        var id = g.dataset.id;
        var rel = new Set([id]);
        items.forEach(function (it) {
          if (it.nodes.indexOf(id) > -1) it.nodes.forEach(function (x) { rel.add(x); });
        });
        Array.prototype.forEach.call(view.querySelectorAll('.gnode'), function (g2) {
          g2.style.opacity = rel.has(g2.dataset.id) ? '1' : '0.28';
        });
        Array.prototype.forEach.call(view.querySelectorAll('.gline'), function (ln) {
          var s = itemById[ln.dataset.sc];
          ln.setAttribute('opacity', s && s.nodes.indexOf(id) > -1 ? '0.95' : '0.12');
        });
      });
      g.addEventListener('mouseleave', function () {
        Array.prototype.forEach.call(view.querySelectorAll('.gnode'), function (g2) { g2.style.opacity = '1'; });
        Array.prototype.forEach.call(view.querySelectorAll('.gline'), function (ln) { ln.setAttribute('opacity', '0.55'); });
      });
    });
  }

  /* ------------------------------------------------------------ 知识点详情 */
  function viewNode(id) {
    var n = nodeById[id];
    if (!n) { view.innerHTML = '<p class="emptyhit">知识点不存在</p>'; return; }
    var L = layers.filter(function (x) { return x.id === n.layer; })[0] || { name: '', role: '' };
    var cards = n.cards.map(function (i) { return itemById[i]; }).filter(Boolean);
    var scs = n.scenarios.map(function (i) { return itemById[i]; }).filter(Boolean);

    var h = '<div class="crumb"><a href="#/roadmap">路线图</a> / ' + n.layer + ' ' + esc(L.name) + '</div>';
    h += '<div class="nodehead"><h1><span style="color:#2563eb;font-size:14px;font-weight:600;margin-right:8px">' +
      n.id + '</span>' + esc(n.name) + '</h1>' +
      '<div style="font-size:12.5px;color:#6b7684">' + esc(L.role) + ' · ' + esc(L.desc) + '</div>';
    if (n.keywords && n.keywords.length) {
      h += '<div class="kw">' + n.keywords.map(function (k) {
        return '<span class="kwt" data-kw="' + esc(k) + '" title="点击搜索「' + esc(k) + '」相关内容">' + esc(k) + '</span>';
      }).join('') + '</div>';
    }
    h += '</div>';

    h += '<div class="sec"><h2>知识点卡片 <em>' + cards.length + ' 篇</em></h2>';
    if (cards.length) { cards.forEach(function (it) { h += rowItem(it); }); }
    else { h += '<div class="emptyhit">还没有卡片。这个节点是缺口，建议优先补。</div>'; }
    h += '</div>';

    h += '<div class="sec"><h2>关联场景题 <em>' + scs.length + ' 道</em></h2>';
    if (scs.length) { scs.forEach(function (it) { h += rowItem(it); }); }
    else { h += '<div class="emptyhit">暂无。场景题是把多个知识点串起来用的练习。</div>'; }
    h += '</div>';

    if (n.html && n.html.indexOf('待补充') === -1) {
      h += '<div class="sec"><h2>节点说明</h2><div class="reader">' + n.html + '</div></div>';
    }

    view.className = '';
    view.innerHTML = h;
    view.scrollTop = 0;
  }

  function rowItem(it) {
    var st = stOf(it.id);
    var badge = it.kind === 'scenario' ? '<span class="pill sc">场景</span>' : '';
    var stTxt = st === 'solid' ? '已能讲' : st === 'learning' ? '学习中' : '';
    return '<a class="rowitem" href="#/card/' + it.id + '"><div class="ri-main">' +
      '<div class="ri-t">' + badge + (badge ? ' ' : '') + esc(it.title) + '</div>' +
      '<div class="ri-d">' + esc(it.excerpt || '') + '</div></div>' +
      '<div class="ri-r">' + esc(stTxt) + '</div></a>';
  }

  /* ------------------------------------------------------------ 卡片阅读 */
  function viewCard(id) {
    var it = itemById[id];
    if (!it) { view.innerHTML = '<p class="emptyhit">内容不存在</p>'; return; }
    var i = idxById[id];
    var prev = items[i - 1], next = items[i + 1];
    var st = stOf(id);

    var h = '<div class="reader">';
    h += '<div class="crumb"><a href="#/cards">全部内容</a> / ' + esc(it.direction) +
      ' / <a href="#/node/' + it.primary + '">' + esc((nodeById[it.primary] || {}).name || it.primary) + '</a></div>';

    h += '<div class="titlebar"><h1>' + esc(it.title) + '</h1></div>';

    h += '<div class="meta">' +
      (it.kind === 'scenario' ? '<span class="pill sc">场景题</span>' : '<span class="pill kp">知识点</span>') +
      (it.level === 'core' ? '<span class="pill core">重点</span>' : '') +
      '<span>' + esc(it.direction) + '</span><span class="sp">·</span>' +
      '<span>' + esc(it.event) + '</span>' +
      (it.project ? '<span class="sp">·</span><span>' + esc(it.project) + '</span>' : '') +
      '<span class="sp">·</span><span>更新 ' + esc(it.updated || it.created || '') + '</span>' +
      (function () {
        var e = entry(id);
        return e && e.due ? '<span class="sp">·</span><span class="due">下次复习 ' + e.due +
          (e.n ? ' · 第 ' + e.n + ' 次' : '') + '</span>' : '';
      })() +
      '<span class="prog">' +
      '<button class="pbtn' + (st === 'todo' ? ' on' : '') + '" data-s="todo">未学</button>' +
      '<button class="pbtn' + (st === 'learning' ? ' on' : '') + '" data-s="learning">学习中</button>' +
      '<button class="pbtn' + (st === 'solid' ? ' on' : '') + '" data-s="solid">能讲</button>' +
      '</span></div>';

    h += '<article>' + it.html + '</article>';

    h += '<div class="sec" style="margin-top:34px"><h2>关联知识点</h2><div class="kw">' +
      it.nodes.map(function (nid) {
        var n = nodeById[nid];
        return '<a class="pill kp" style="text-decoration:none" href="#/node/' + nid + '">' + nid + ' ' + esc(n ? n.name : '') + '</a>';
      }).join('') + '</div></div>';

    h += '<div class="footnav">' +
      (prev ? '<a href="#/card/' + prev.id + '">上一篇<b>' + esc(prev.title) + '</b></a>' : '<span style="flex:1"></span>') +
      (next ? '<a class="r" href="#/card/' + next.id + '">下一篇<b>' + esc(next.title) + '</b></a>' : '') +
      '</div>';

    h += '</div>';
    view.className = '';
    view.innerHTML = h;
    view.scrollTop = 0;

    Array.prototype.forEach.call(view.querySelectorAll('.pbtn'), function (b) {
      b.addEventListener('click', function () {
        var s = b.dataset.s;
        setStatus(id, s);
        Array.prototype.forEach.call(view.querySelectorAll('.pbtn'), function (x) {
          x.classList.toggle('on', x.dataset.s === s);
        });
        var e = entry(id);
        var dueEl = view.querySelector('.meta .due');
        if (e && e.due) {
          if (!dueEl) {
            var sp = document.createElement('span');
            sp.className = 'sp';
            sp.textContent = '·';
            dueEl = document.createElement('span');
            dueEl.className = 'due';
            var prog = view.querySelector('.prog');
            prog.parentNode.insertBefore(sp, prog);
            prog.parentNode.insertBefore(dueEl, prog);
          }
          dueEl.textContent = '下次复习 ' + e.due + (e.n ? ' · 第 ' + e.n + ' 次' : '');
        }
        markSide();
      });
    });
  }

  /* ------------------------------------------------------------ 全部内容 */
  var listFilter = 'all';
  function viewList() {
    var dirs = groupBy(items, 'direction');
    var h = '<div class="hd"><h1>全部内容</h1><p>' + items.length + ' 篇，按技术方向分组。</p></div>';
    h += '<div class="filterbar">' +
      ['all', 'card', 'scenario'].map(function (k) {
        var label = k === 'all' ? '全部' : k === 'card' ? '知识卡片' : '场景题';
        return '<span class="fchip' + (listFilter === k ? ' on' : '') + '" data-f="' + k + '">' + label + '</span>';
      }).join('') + '</div>';

    orderedDirs(dirs).forEach(function (dir) {
      var list = dirs[dir].filter(function (it) { return listFilter === 'all' || it.kind === listFilter; });
      if (!list.length) return;
      h += '<div class="sec"><h2>' + esc(dir) + ' <em>' + list.length + ' 篇</em></h2>';
      list.forEach(function (it) { h += rowItem(it); });
      h += '</div>';
    });

    view.className = '';
    view.innerHTML = h;
    view.scrollTop = 0;
    Array.prototype.forEach.call(view.querySelectorAll('.fchip'), function (c) {
      c.addEventListener('click', function () { listFilter = c.dataset.f; viewList(); });
    });
  }

  /* ------------------------------------------------------------ 搜索 */
  function doSearch(kw) {
    kw = (kw || '').trim().toLowerCase();
    if (!kw) { qres.classList.remove('on'); qres.innerHTML = ''; return; }
    var res = [];
    nodes.forEach(function (n) {
      var hay = (n.id + ' ' + n.name + ' ' + (n.keywords || []).join(' ')).toLowerCase();
      if (hay.indexOf(kw) > -1) {
        res.push({ href: '#/node/' + n.id, t: n.id + ' ' + n.name, m: '知识点 · ' + (n.cards.length + n.scenarios.length) + ' 篇内容' });
      }
    });
    items.forEach(function (it) {
      var hay = (it.id + ' ' + it.title + ' ' + it.nodes.join(' ') + ' ' + it.direction + ' ' + it.event + ' ' + it.excerpt).toLowerCase();
      if (hay.indexOf(kw) > -1) {
        res.push({ href: '#/card/' + it.id, t: it.title, m: (it.kind === 'scenario' ? '场景题' : '卡片') + ' · ' + it.direction + ' · ' + it.nodes.join(' ') });
      }
    });
    if (!res.length) {
      qres.innerHTML = '<div class="qempty">没有匹配的内容</div>';
    } else {
      qres.innerHTML = res.slice(0, 24).map(function (r) {
        return '<a class="qitem" href="' + r.href + '"><div class="qt">' + esc(r.t) + '</div><div class="qm">' + esc(r.m) + '</div></a>';
      }).join('');
    }
    qres.classList.add('on');
  }
  q.addEventListener('input', function () { doSearch(q.value); });
  q.addEventListener('focus', function () { if (q.value.trim()) doSearch(q.value); });
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.searchbox')) qres.classList.remove('on');
  });
  document.addEventListener('keydown', function (e) {
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    if (e.key === 'Escape') {
      var m = document.getElementById('modal');
      if (m && m.classList.contains('on')) { m.classList.remove('on'); return; }
      qres.classList.remove('on'); q.blur();
    }
    if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') { e.preventDefault(); q.focus(); }
  });
  qres.addEventListener('click', function (e) {
    if (e.target.closest('.qitem')) { qres.classList.remove('on'); q.value = ''; }
  });
  /* 点击节点标签 → 用该关键词搜索 */
  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('.kwt') : null;
    if (!t) return;
    q.value = t.dataset.kw || '';
    doSearch(q.value);
    q.focus();
  });

  /* ------------------------------------------------------------ 数据导入导出 */
  var modal = document.getElementById('modal');
  var exportTa = document.getElementById('exportTa');
  var importTa = document.getElementById('importTa');
  var dataMsg = document.getElementById('dataMsg');
  var dataStat = document.getElementById('dataStat');

  function msg(t, bad) {
    dataMsg.textContent = t;
    dataMsg.className = 'msg' + (bad ? ' bad' : ' ok');
  }
  function refreshData() {
    exportTa.value = JSON.stringify({
      app: 'pay-review-station', version: 1,
      exported: todayStr(), progress: prog
    }, null, 2);
    var learned = learnedCount();
    var solid = items.filter(function (i) { return stOf(i.id) === 'solid'; }).length;
    dataStat.textContent = '已学 ' + learned + ' / ' + items.length + ' 篇 · 能讲 ' + solid +
      ' · 今日待复习 ' + dueList().length;
    dataMsg.textContent = '';
    dataMsg.className = 'msg';
  }
  function openModal() { refreshData(); modal.classList.add('on'); }
  function closeModal() { modal.classList.remove('on'); }

  function validEntry(v) {
    if (typeof v === 'string') return v === 'solid' || v === 'learning';
    return !!v && typeof v === 'object' && (v.s === 'solid' || v.s === 'learning');
  }
  function normalize(v) {
    if (typeof v === 'string') return { s: v };
    var e = { s: v.s };
    if (typeof v.n === 'number') e.n = v.n;
    if (typeof v.lapses === 'number') e.lapses = v.lapses;
    if (typeof v.due === 'string') e.due = v.due;
    if (typeof v.last === 'string') e.last = v.last;
    return e;
  }
  function mergeInto(incoming) {
    var r = { added: 0, updated: 0, same: 0, unknown: 0 };
    Object.keys(incoming).forEach(function (id) {
      if (!itemById[id]) { r.unknown++; return; }
      var inc = normalize(incoming[id]);
      var cur = entry(id);
      if (!cur) { prog[id] = inc; r.added++; return; }
      var take = false;
      if ((inc.last || '') > (cur.last || '')) take = true;
      else if ((inc.last || '') === (cur.last || '') && (inc.n || 0) > (cur.n || 0)) take = true;
      if (take) { prog[id] = inc; r.updated++; } else { r.same++; }
    });
    return r;
  }
  function doImport(text) {
    var obj;
    try { obj = JSON.parse(text); } catch (e) { msg('JSON 解析失败：' + e.message, true); return; }
    var incoming = obj && obj.progress ? obj.progress : obj;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      msg('格式不对，需要 {"progress": {"A3-01": {...}}} 这样的结构', true);
      return;
    }
    var clean = {}, bad = 0;
    Object.keys(incoming).forEach(function (id) {
      if (!validEntry(incoming[id])) { bad++; return; }
      clean[id] = incoming[id];
    });
    var r = mergeInto(clean);
    saveProg();
    renderSide();
    route();
    refreshData();
    msg('导入完成：新增 ' + r.added + '，更新 ' + r.updated + '，未变 ' + r.same +
      (r.unknown ? '，忽略 ' + r.unknown + ' 个未知条目' : '') +
      (bad ? '，跳过 ' + bad + ' 条非法数据' : ''));
  }
  function copyText(t) {
    function fallback() {
      exportTa.focus();
      exportTa.select();
      try { document.execCommand('copy'); msg('已复制到剪贴板'); }
      catch (e) { msg('复制失败，请手动全选复制', true); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(function () { msg('已复制到剪贴板'); }, fallback);
    } else { fallback(); }
  }
  function download() {
    try {
      var blob = new Blob([exportTa.value], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'review-progress-' + todayStr() + '.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      msg('已生成下载文件');
    } catch (e) {
      msg('下载被浏览器拦截，请用「复制到剪贴板」', true);
    }
  }

  document.getElementById('dataBtn').addEventListener('click', openModal);
  document.getElementById('modalClose').addEventListener('click', closeModal);
  modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
  document.getElementById('copyBtn').addEventListener('click', function () { copyText(exportTa.value); });
  document.getElementById('dlBtn').addEventListener('click', download);
  document.getElementById('pickBtn').addEventListener('click', function () {
    document.getElementById('importFile').click();
  });
  document.getElementById('importFile').addEventListener('change', function (e) {
    var f = e.target.files && e.target.files[0];
    if (!f) return;
    var rd = new FileReader();
    rd.onload = function () { importTa.value = String(rd.result); msg('已读入文件，点「合并导入」生效'); };
    rd.readAsText(f);
    e.target.value = '';
  });
  document.getElementById('mergeBtn').addEventListener('click', function () {
    if (!importTa.value.trim()) { msg('先粘贴或选择一个 JSON 文件', true); return; }
    doImport(importTa.value);
  });
  document.getElementById('clearBtn').addEventListener('click', function () {
    if (!confirm('确定清空全部学习进度？此操作不可撤销，建议先导出备份。')) return;
    prog = {};
    saveProg();
    renderSide();
    route();
    refreshData();
    msg('已清空全部进度');
  });

  window.addEventListener('hashchange', route);
  renderSide();
  route();
})();
