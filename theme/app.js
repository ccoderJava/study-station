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
    var dirs = orderedDirs(g);
    var h = '<div class="side-tools"><button type="button" class="side-fold" id="foldAll">' +
      (dirs.length && dirs.every(function (d) { return folds[d]; }) ? '全部展开' : '全部折叠') +
      '</button></div>';
    dirs.forEach(function (dir) {
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
        saveFolds();
        syncFoldBtn(dirs);
      });
    });

    var btn = side.querySelector('#foldAll');
    if (btn) {
      btn.addEventListener('click', function () {
        var collapse = !dirs.every(function (d) { return folds[d]; });
        dirs.forEach(function (d) { folds[d] = collapse; });
        saveFolds();
        Array.prototype.forEach.call(side.querySelectorAll('.sgwrap'), function (w) {
          w.classList.toggle('closed', collapse);
        });
        syncFoldBtn(dirs);
      });
    }
    markSide();
  }

  function saveFolds() {
    try { localStorage.setItem(FOLD_KEY, JSON.stringify(folds)); } catch (e) {}
  }

  /* 拖动分隔条调侧栏宽度；双击复位。宽度存 localStorage，全站生效 */
  var SIDEW_KEY = 'review-side-w-v1';
  var SIDEW_DEF = 264, SIDEW_MIN = 180, SIDEW_MAX = 460;

  function sideWidth() {
    var v = 0;
    try { v = parseInt(localStorage.getItem(SIDEW_KEY), 10) || 0; } catch (e) { v = 0; }
    if (!v) return SIDEW_DEF;
    return Math.min(sideMax(), Math.max(SIDEW_MIN, v));
  }

  /* 上限同时受窗口宽度约束，窄屏拖到最大也不至于把正文压没 */
  function sideMax() {
    return Math.max(SIDEW_MIN, Math.min(SIDEW_MAX, Math.round(window.innerWidth * 0.42)));
  }

  function bindSideResize() {
    var bar = document.getElementById('sideResize');
    if (!bar || !side) return;
    var dragging = false, startX = 0, startW = 0;

    function apply(w) {
      w = Math.round(Math.min(sideMax(), Math.max(SIDEW_MIN, w)));
      side.style.flexBasis = w + 'px';
      side.style.width = w + 'px';
      return w;
    }
    apply(sideWidth());

    bar.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startW = side.getBoundingClientRect().width;
      bar.classList.add('drag');
      side.classList.add('resizing');
      document.body.classList.add('col-resizing');
      try { bar.setPointerCapture(e.pointerId); } catch (err) {}
    });

    bar.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      apply(startW + (e.clientX - startX));
    });

    function end() {
      if (!dragging) return;
      dragging = false;
      bar.classList.remove('drag');
      side.classList.remove('resizing');
      document.body.classList.remove('col-resizing');
      try {
        localStorage.setItem(SIDEW_KEY, String(Math.round(side.getBoundingClientRect().width)));
      } catch (err) {}
    }
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);

    bar.addEventListener('dblclick', function () {
      apply(SIDEW_DEF);
      try { localStorage.setItem(SIDEW_KEY, String(SIDEW_DEF)); } catch (err) {}
    });

    /* 窗口缩小时把超限宽度夹回来；放大后按存档恢复 */
    window.addEventListener('resize', function () {
      if (dragging) return;
      apply(sideWidth());
    });
  }

  /* 按钮文案跟随当前状态：全收起时显示「全部展开」 */
  function syncFoldBtn(dirs) {
    var btn = side.querySelector('#foldAll');
    if (!btn) return;
    var allClosed = dirs && dirs.length && dirs.every(function (d) { return folds[d]; });
    btn.textContent = allClosed ? '全部展开' : '全部折叠';
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
    if (tocCleanup) tocCleanup();
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
      '<p>从下到上逐层打通：前四层是资格线，后两层是溢价线。节点编号里字母代表层（A→S1 … F→S6），数字是层内序号。</p></div>';
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
  /* ------------------------------------------------------------ 图谱（力导向） */
  var LAYER_HUE = {
    S1: '#2563eb', S2: '#0d9488', S3: '#7c3aed',
    S4: '#db2777', S5: '#ea580c', S6: '#64748b'
  };
  var GF = { rep: 9000, rest: 108, spring: 0.05, anchor: 0.028, center: 0.005, damp: 0.82, maxV: 18, iter: 760 };
  var gSeed = 20261103;

  /* 标签宽度估算：中文按一个字宽，ASCII 按 0.55，大写与空格另有系数。
     不能靠 getBBox（节点还没进 DOM），估算够用且布局稳定。 */
  function labelW(s, size) {
    var w = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i), ch = s.charAt(i);
      if (c > 255) w += size;
      else if (c === 32) w += size * 0.34;
      else if (ch >= 'A' && ch <= 'Z') w += size * 0.64;
      else w += size * 0.55;
    }
    return w;
  }

  /* 从节点中心指向 (tx,ty) 的射线与节点边框的交点：线要停在标签边上，不能压字 */
  function clipPt(n, tx, ty) {
    var dx = tx - n.x, dy = ty - n.y;
    var adx = Math.abs(dx), ady = Math.abs(dy);
    if (adx < 0.01 && ady < 0.01) return { x: n.x, y: n.y };
    var hw = (n.w || 16) / 2, hh = (n.h || 16) / 2;
    var t = Math.min(adx > 0.01 ? hw / adx : 1e9, ady > 0.01 ? hh / ady : 1e9);
    return { x: n.x + dx * t, y: n.y + dy * t };
  }

  /* 线段与矩形的相交参数区间（Liang-Barsky），没交点返回 null */
  function segRect(x1, y1, x2, y2, rc) {
    var t0 = 0, t1 = 1, dx = x2 - x1, dy = y2 - y1;
    var p = [-dx, dx, -dy, dy];
    var q = [x1 - rc.x1, rc.x2 - x1, y1 - rc.y1, rc.y2 - y1];
    for (var i = 0; i < 4; i++) {
      if (p[i] === 0) { if (q[i] < 0) return null; }
      else {
        var r = q[i] / p[i];
        if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
        else { if (r < t0) return null; if (r < t1) t1 = r; }
      }
    }
    return [t0, t1];
  }

  /* 把层色按比例混白：得到不透明的浅色底，底下的连线不会透上来 */
  function tint(hex, t) {
    var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    function m(v) { return Math.round(255 - (255 - v) * t); }
    return 'rgb(' + m(r) + ',' + m(g) + ',' + m(b) + ')';
  }

  /* 一条边可能穿过别的标签：按标签矩形切成若干段，只画露在外面的部分 */
  function edgeSegs(e, g) {
    var p1 = clipPt(e.a, e.b.x, e.b.y), p2 = clipPt(e.b, e.a.x, e.a.y);
    var cuts = [];
    g.nodes.forEach(function (n) {
      if (n === e.a || n === e.b) return;
      var iv = segRect(p1.x, p1.y, p2.x, p2.y, {
        x1: n.x - n.w / 2, x2: n.x + n.w / 2,
        y1: n.y - n.h / 2, y2: n.y + n.h / 2
      });
      if (iv && iv[1] - iv[0] > 0.0005) cuts.push(iv);
    });
    var spans = [];
    if (!cuts.length) {
      spans.push([0, 1]);
    } else {
      cuts.sort(function (a, b) { return a[0] - b[0]; });
      var cur = 0;
      cuts.forEach(function (iv) {
        if (iv[0] > cur) spans.push([cur, Math.min(iv[0], 1)]);
        if (iv[1] > cur) cur = iv[1];
      });
      if (cur < 1) spans.push([cur, 1]);
    }
    /* 每段两端各缩 1.8px：不然端点刚好压在标签边上，看起来像连进去了 */
    var len = Math.sqrt((p2.x - p1.x) * (p2.x - p1.x) + (p2.y - p1.y) * (p2.y - p1.y)) || 1;
    var pad = 1.8 / len;
    return spans.filter(function (s) { return s[1] - s[0] > 0.002; }).map(function (s) {
      var t0 = Math.min(s[0] + pad, s[1]), t1 = Math.max(s[1] - pad, s[0]);
      return [
        { x: p1.x + (p2.x - p1.x) * t0, y: p1.y + (p2.y - p1.y) * t0 },
        { x: p1.x + (p2.x - p1.x) * t1, y: p1.y + (p2.y - p1.y) * t1 }
      ];
    });
  }

  function graphModel() {
    var gnodes = [], byKey = {}, edges = [];
    nodes.forEach(function (n) {
      byKey[n.id] = {
        key: n.id, id: n.id, kind: 'node', name: n.name, layer: n.layer,
        color: LAYER_HUE[n.layer] || '#64748b', deg: 0, cards: n.cards.length, scs: n.scenarios.length
      };
      gnodes.push(byKey[n.id]);
    });
    items.forEach(function (it) {
      if (it.kind !== 'scenario') return;
      byKey[it.id] = {
        key: it.id, id: it.id, kind: 'scenario', name: it.title,
        /* 图上只写短名：长标题会把布局撑散，完整标题留给悬停提示 */
        short: it.graph || it.title,
        layer: null, color: '#f59e0b', deg: 0, cards: 0, scs: 0
      };
      gnodes.push(byKey[it.id]);
    });
    items.forEach(function (it) {
      if (it.kind !== 'scenario') return;
      var a = byKey[it.id];
      if (!a) return;
      it.nodes.forEach(function (nid) {
        var b = byKey[nid];
        if (!b) return;
        edges.push({ a: a, b: b, sc: it.id });
        a.deg++; b.deg++;
      });
    });
    return { nodes: gnodes, edges: edges, byKey: byKey };
  }

  function graphLayout(g) {
    var W = 1080, H = 750, cx = W / 2, cy = H / 2, R = 290;
    var anchors = {};
    layers.forEach(function (L, i) {
      var a = -Math.PI / 2 + i * 2 * Math.PI / layers.length;
      anchors[L.id] = { x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R };
    });
    var seed = gSeed;
    function rnd() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }

    /* 先量标签尺寸：知识点用 11.5 号，场景题短名用 10 号、更矮，两类大小有别 */
    g.nodes.forEach(function (n) {
      if (n.kind === 'node') {
        n.w = Math.max(58, Math.round(labelW(n.name, 11.5) + 26));
        n.h = 28;
        n.deg = n.deg || 0;
      } else {
        n.w = Math.max(50, Math.round(labelW(n.short, 10) + 22));
        n.h = 22;
      }
    });

    var scTotal = 0, scIdx = 0;
    g.nodes.forEach(function (n) { if (n.kind === 'scenario') scTotal++; });
    /* 场景题集中在中心，知识点围在外环：两类标签分区，一眼能看出「题在内、知识点在外」。
       中心按 4 / 7 / 9 分三圈，圈内均布、圈间错开角度，二十个标签不会挤成一坨。 */
    var perRing = [4, 7, 9], rings = [78, 140, 198];
    g.nodes.forEach(function (n) {
      if (n.kind === 'node' && anchors[n.layer]) {
        n.x = anchors[n.layer].x + (rnd() - 0.5) * 200;
        n.y = anchors[n.layer].y + (rnd() - 0.5) * 200;
      } else {
        var ri = 0, cum = 0;
        while (ri < perRing.length - 1 && scIdx >= cum + perRing[ri]) { cum += perRing[ri]; ri++; }
        var inRing = scIdx - cum;
        var a2 = -Math.PI / 2 + inRing * 2 * Math.PI / perRing[ri] + ri * 0.5;
        n.ax = cx + Math.cos(a2) * rings[ri];
        n.ay = cy + Math.sin(a2) * rings[ri];
        n.x = n.ax + (rnd() - 0.5) * 34;
        n.y = n.ay + (rnd() - 0.5) * 34;
        scIdx++;
      }
      n.vx = 0; n.vy = 0;
    });

    var t, i, j, A, B, dx, dy, d2, d, f, ux, uy;
    for (t = 0; t < GF.iter; t++) {
      var alpha = 1 - t / GF.iter;
      for (i = 0; i < g.nodes.length; i++) {
        A = g.nodes[i];
        for (j = i + 1; j < g.nodes.length; j++) {
          B = g.nodes[j];
          dx = B.x - A.x; dy = B.y - A.y;
          d2 = dx * dx + dy * dy;
          if (d2 < 9) { d2 = 9; dx = (j - i) * 0.31 + 0.2; dy = (i + j) * 0.17 + 0.2; }
          d = Math.sqrt(d2);
          f = GF.rep / d2 * alpha;
          ux = dx / d; uy = dy / d;
          A.vx -= ux * f; A.vy -= uy * f;
          B.vx += ux * f; B.vy += uy * f;
        }
      }
      g.edges.forEach(function (e) {
        var ex = e.b.x - e.a.x, ey = e.b.y - e.a.y;
        var ed = Math.sqrt(ex * ex + ey * ey) || 1;
        var ef = (ed - GF.rest) * GF.spring * alpha;
        var e1 = ex / ed, e2 = ey / ed;
        e.a.vx += e1 * ef; e.a.vy += e2 * ef;
        e.b.vx -= e1 * ef; e.b.vy -= e2 * ef;
      });
      g.nodes.forEach(function (n) {
        if (n.kind === 'node' && anchors[n.layer]) {
          n.vx += (anchors[n.layer].x - n.x) * GF.anchor * alpha;
          n.vy += (anchors[n.layer].y - n.y) * GF.anchor * alpha;
        } else if (n.ax != null) {
          n.vx += (n.ax - n.x) * 0.02 * alpha;
          n.vy += (n.ay - n.y) * 0.02 * alpha;
        } else {
          n.vx += (cx - n.x) * GF.center * alpha;
          n.vy += (cy - n.y) * GF.center * alpha;
        }
        n.vx *= GF.damp; n.vy *= GF.damp;
        var sp = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
        if (sp > GF.maxV) { n.vx = n.vx / sp * GF.maxV; n.vy = n.vy / sp * GF.maxV; }
        n.x += n.vx; n.y += n.vy;
      });
    }

    /* 横纵比归一：横向拉开、纵向压扁，让画面接近容器比例 */
    var sx = 1.06, sy = 0.78, gx = 0, gy = 0;
    g.nodes.forEach(function (n) { gx += n.x; gy += n.y; });
    gx /= g.nodes.length; gy /= g.nodes.length;
    g.nodes.forEach(function (n) { n.x = gx + (n.x - gx) * sx; n.y = gy + (n.y - gy) * sy; });

    /* 去重叠：按矩形分离（胶囊宽高比大，用圆近似会让标签横向压在一起） */
    var gap = 10;
    function separate(iter) {
      for (var k = 0; k < iter; k++) {
        var hit = 0;
        for (var a = 0; a < g.nodes.length; a++) {
          for (var b = a + 1; b < g.nodes.length; b++) {
            var A2 = g.nodes[a], B2 = g.nodes[b];
            var needX = (A2.w + B2.w) / 2 + gap;
            var needY = (A2.h + B2.h) / 2 + gap;
            var ddx = B2.x - A2.x, ddy = B2.y - A2.y;
            var ox = needX - Math.abs(ddx), oy = needY - Math.abs(ddy);
            if (ox > 0 && oy > 0) {
              hit++;
              /* 沿重叠较小的轴推开，位移最小、形状保持最好 */
              if (ox < oy) {
                var s1 = ddx >= 0 ? 1 : -1;
                A2.x -= s1 * ox / 2; B2.x += s1 * ox / 2;
              } else {
                var s2 = ddy >= 0 ? 1 : -1;
                A2.y -= s2 * oy / 2; B2.y += s2 * oy / 2;
              }
            }
          }
        }
        if (!hit) break;
      }
    }
    separate(180);

    /* 团簇回位：去重叠是「对半推开」，整团会一路漂到角落（Spring 那组就飘到过右下角）。
       按层把质心拉回锚点、场景题拉回中心，再收一次重叠，保证既紧凑又不重叠。 */
    var byLayer = {};
    g.nodes.forEach(function (n) {
      if (n.kind === 'node') (byLayer[n.layer] = byLayer[n.layer] || []).push(n);
    });
    Object.keys(byLayer).forEach(function (lid) {
      var pts = byLayer[lid], anc = anchors[lid];
      if (!anc || !pts.length) return;
      var mx2 = 0, my2 = 0;
      pts.forEach(function (n) { mx2 += n.x; my2 += n.y; });
      mx2 /= pts.length; my2 /= pts.length;
      pts.forEach(function (n) { n.x += (anc.x - mx2) * 0.55; n.y += (anc.y - my2) * 0.55; });
    });
    var scn = g.nodes.filter(function (n) { return n.kind === 'scenario'; });
    if (scn.length) {
      var mx3 = 0, my3 = 0;
      scn.forEach(function (n) { mx3 += n.x; my3 += n.y; });
      mx3 /= scn.length; my3 /= scn.length;
      scn.forEach(function (n) { n.x += (cx - mx3) * 0.35; n.y += (cy - my3) * 0.35; });
    }
    separate(160);
  }

  function graphBBox(g, pad) {
    var x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
    g.nodes.forEach(function (n) {
      x1 = Math.min(x1, n.x - n.w / 2);
      x2 = Math.max(x2, n.x + n.w / 2);
      y1 = Math.min(y1, n.y - n.h / 2);
      y2 = Math.max(y2, n.y + n.h / 2);
    });
    return { x: x1 - pad, y: y1 - pad, w: (x2 - x1) + pad * 2, h: (y2 - y1) + pad * 2 };
  }

  function graphSvg(g, bb) {
    var out = [];
    out.push('<svg id="gsvg" viewBox="' + Math.round(bb.x) + ' ' + Math.round(bb.y) + ' ' +
      Math.round(bb.w) + ' ' + Math.round(bb.h) + '" preserveAspectRatio="xMidYMid meet">');
    out.push('<g id="gpan">');
    out.push('<g id="gedges">');
    g.edges.forEach(function (e) {
      edgeSegs(e, g).forEach(function (s) {
        out.push('<line class="gline" data-sc="' + e.sc + '" data-a="' + e.a.key + '" data-b="' + e.b.key +
          '" x1="' + s[0].x.toFixed(1) + '" y1="' + s[0].y.toFixed(1) +
          '" x2="' + s[1].x.toFixed(1) + '" y2="' + s[1].y.toFixed(1) +
          '" stroke="#c8d2e0" stroke-width="1.15"/>');
      });
    });
    out.push('</g><g id="gnodes">');

    g.nodes.forEach(function (n) {
      if (n.kind === 'scenario') {
        /* 场景题也是名称标签：橙色虚线框和知识点区分，不再出现 S01 这种编号 */
        var sw = n.w, sh = n.h;
        out.push('<g class="gn gsc" data-key="' + n.key + '" data-kind="scenario" data-layer=""' +
          ' transform="translate(' + n.x.toFixed(1) + ',' + n.y.toFixed(1) + ')">' +
          '<rect class="sb" x="' + (-sw / 2).toFixed(1) + '" y="' + (-sh / 2).toFixed(1) +
          '" width="' + sw + '" height="' + sh + '" rx="' + (sh / 2) + '" fill="#fff8ef"' +
          ' stroke="#f59e0b" stroke-width="1.3" stroke-dasharray="4 2.5"/>' +
          '<text y="3.4" text-anchor="middle" font-size="10" font-weight="600" fill="#b45309">' +
          esc(n.short) + '</text>' +
          '</g>');
      } else {
        /* 知识点直接写名称：底色深浅表示被关联的次数，不再是「编号 + 外部文字」 */
        var w = n.w, h = n.h;
        var fill = tint(n.color, n.deg >= 3 ? 0.2 : n.deg >= 1 ? 0.14 : 0.09);
        out.push('<g class="gn" data-key="' + n.key + '" data-kind="node" data-layer="' + n.layer + '"' +
          ' transform="translate(' + n.x.toFixed(1) + ',' + n.y.toFixed(1) + ')">' +
          '<rect class="nb" x="' + (-w / 2).toFixed(1) + '" y="' + (-h / 2).toFixed(1) +
          '" width="' + w + '" height="' + h + '" rx="' + (h / 2) + '" fill="' + fill +
          '" stroke="' + n.color + '" stroke-width="1.5"/>' +
          '<text y="4" text-anchor="middle" font-size="11.5" font-weight="600" fill="' + n.color + '">' +
          esc(n.name) + '</text>' +
          '</g>');
      }
    });
    out.push('</g></g></svg>');
    return out.join('');
  }

  function viewGraph() {
    var g = graphModel();
    graphLayout(g);
    var bb = graphBBox(g, 22);
    var scenarios = items.filter(function (i) { return i.kind === 'scenario'; });
    var links = g.edges.length;

    var legend = layers.map(function (L) {
      return '<button class="glg on" data-layer="' + L.id + '">' +
        '<i style="background:' + (LAYER_HUE[L.id] || '#64748b') + '"></i>' + esc(L.name) + '</button>';
    }).join('') +
      '<button class="glg on" data-layer="__sc" style="cursor:default;border-style:dashed">' +
      '<i style="background:#f59e0b"></i>场景题</button>';

    var h = '<div class="hd"><h1>知识图谱</h1>' +
      '<p>每个标签是一个知识点，颜色代表所属层，底色越深表示被越多内容关联；橙色虚线框是场景题，把跨层的知识点串在一起。拖动可平移，滚轮缩放，悬停看关联。</p></div>' +
      '<div class="gtools">' +
      '<button class="gbtn" id="gfit">适应窗口</button>' +
      '<button class="gbtn" id="gzin">＋</button>' +
      '<button class="gbtn" id="gzout">－</button>' +
      '<button class="gbtn" id="grelayout">重新布局</button>' +
      '<span class="gstat">' + nodes.length + ' 个知识点 · ' + scenarios.length + ' 道场景题 · ' + links + ' 条关联</span>' +
      '</div>' +
      '<div class="glegend">' + legend + '</div>' +
      '<div class="gwrap" id="gw">' + graphSvg(g, bb) +
      '<div class="gtipbox" id="gtip"></div></div>';

    view.className = 'wide';
    view.innerHTML = h;
    view.scrollTop = 0;
    bindGraph(g);
  }

  function bindGraph(g) {
    var svg = document.getElementById('gsvg');
    var pan = document.getElementById('gpan');
    var tip = document.getElementById('gtip');
    var wrap = document.getElementById('gw');
    if (!svg) return;
    var tf = { x: 0, y: 0, k: 1 };
    var vb = svg.viewBox.baseVal;
    function apply() { pan.setAttribute('transform', 'translate(' + tf.x + ',' + tf.y + ') scale(' + tf.k + ')'); }
    function reset() { tf = { x: 0, y: 0, k: 1 }; apply(); }
    apply();

    /* 缩放：以鼠标位置为锚点 */
    function zoomAt(clientX, clientY, factor) {
      var rect = svg.getBoundingClientRect();
      var vx = vb.x + (clientX - rect.left) / rect.width * vb.width;
      var vy = vb.y + (clientY - rect.top) / rect.height * vb.height;
      var k2 = Math.max(0.45, Math.min(3.6, tf.k * factor));
      if (k2 === tf.k) return;
      var r = k2 / tf.k;
      tf.x = vx - (vx - tf.x) * r;
      tf.y = vy - (vy - tf.y) * r;
      tf.k = k2;
      apply();
    }
    svg.addEventListener('wheel', function (e) {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0016));
    }, { passive: false });

    /* 平移 */
    var drag = null, panRaf = 0;
    svg.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.gn')) return;
      resetHi();
      drag = { x: e.clientX, y: e.clientY, tx: tf.x, ty: tf.y };
      svg.classList.add('dragging');
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var rect = svg.getBoundingClientRect();
      var sx = vb.width / rect.width, sy = vb.height / rect.height;
      tf.x = drag.tx + (e.clientX - drag.x) * sx;
      tf.y = drag.ty + (e.clientY - drag.y) * sy;
      if (!panRaf) panRaf = requestAnimationFrame(function () { panRaf = 0; apply(); });
    });
    function endDrag(e) {
      if (!drag) return;
      drag = null;
      svg.classList.remove('dragging');
      try { svg.releasePointerCapture(e.pointerId); } catch (err) {}
    }
    svg.addEventListener('pointerup', endDrag);
    svg.addEventListener('pointercancel', endDrag);

    document.getElementById('gfit').addEventListener('click', reset);
    document.getElementById('gzin').addEventListener('click', function () {
      var r = svg.getBoundingClientRect();
      zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.28);
    });
    document.getElementById('gzout').addEventListener('click', function () {
      var r = svg.getBoundingClientRect();
      zoomAt(r.left + r.width / 2, r.top + r.height / 2, 0.78);
    });
    document.getElementById('grelayout').addEventListener('click', function () {
      gSeed = Math.floor(Math.random() * 1e8);
      var g2 = graphModel();
      graphLayout(g2);
      var bb2 = graphBBox(g2, 22);
      var gw = document.getElementById('gw');
      gw.innerHTML = graphSvg(g2, bb2) + '<div class="gtipbox" id="gtip"></div>';
      bindGraph(g2);
    });

    /* 悬停：高亮邻居。
       三件事一起做才不闪：
       1) 事件委托到 svg，跨标签移动时直接换目标，不会先「灭」再「亮」；
       2) 110ms 预热，指针快速扫过不触发任何重绘；
       3) 高亮状态交给 CSS（一个 data-hi 属性 + 少量 .on 类），
          不再逐个元素写 inline style —— 之前 53 个节点 + 四百多条线段每次都要重算样式。 */
    var nodeEls = Array.prototype.slice.call(svg.querySelectorAll('.gn'));
    var lineEls = Array.prototype.slice.call(svg.querySelectorAll('.gline'));
    var elByKey = {}, linesByKey = {};
    nodeEls.forEach(function (n) {
      elByKey[n.getAttribute('data-key')] = n;
    });
    lineEls.forEach(function (l) {
      var a = l.getAttribute('data-a'), b = l.getAttribute('data-b');
      (linesByKey[a] = linesByKey[a] || []).push(l);
      (linesByKey[b] = linesByKey[b] || []).push(l);
    });

    var hiKey = '', onNodes = [], onLines = [];
    var pendKey = '', pendTimer = 0, leaveTimer = 0;
    var pt = null, hoverEvt = null, hoverRaf = 0;

    function clearPaint() {
      for (var i = 0; i < onNodes.length; i++) onNodes[i].classList.remove('on');
      for (var j = 0; j < onLines.length; j++) onLines[j].classList.remove('on');
      onNodes = []; onLines = [];
    }
    function resetHi() {
      clearPaint();
      svg.removeAttribute('data-hi');
      hiKey = ''; pendKey = '';
      clearTimeout(pendTimer);
      tip.style.display = 'none';
    }
    function moveTip(cx2, cy2) {
      var r = wrap.getBoundingClientRect();
      /* 钳在容器内，靠边时不至于飘出画布；上移 20px 让提示不压住正在看的标签 */
      var half = Math.min(130, r.width / 2);
      var x = Math.max(half, Math.min(r.width - half, cx2 - r.left));
      var y = Math.max(48, cy2 - r.top - 20);
      tip.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0) translate(-50%,-100%)';
    }
    function setHi(key) {
      clearPaint();
      if (!key) return;
      var n = g.byKey[key];
      if (!n) return;
      hiKey = key;
      var el = elByKey[key];
      if (el) { el.classList.add('on'); onNodes.push(el); }
      var ls = linesByKey[key] || [];
      for (var i = 0; i < ls.length; i++) { ls[i].classList.add('on'); onLines.push(ls[i]); }
      g.edges.forEach(function (e) {
        var other = e.a.key === key ? e.b.key : e.b.key === key ? e.a.key : '';
        if (!other) return;
        var oel = elByKey[other];
        if (oel && onNodes.indexOf(oel) < 0) { oel.classList.add('on'); onNodes.push(oel); }
      });
      svg.setAttribute('data-hi', '1');
      tip.innerHTML = n.kind === 'scenario'
        ? '<b>' + esc(n.name) + '</b><br>场景题 · 串起 ' + n.deg + ' 个知识点'
        : '<b>' + esc(n.name) + '</b><br>卡片 ' + n.cards + ' 篇 · 场景题 ' + n.scs + ' 道';
      if (pt) {
        moveTip(pt.x, pt.y);
        tip.style.display = 'block';
      }
    }
    function handleHover() {
      if (drag || !hoverEvt) return;
      var t = hoverEvt.target;
      var el = t && t.closest ? t.closest('.gn') : null;
      var key = el ? el.getAttribute('data-key') : '';
      if (key) {
        clearTimeout(leaveTimer);
        if (key === hiKey) { if (pt) moveTip(pt.x, pt.y); return; }
        if (key === pendKey) return;
        pendKey = key;
        clearTimeout(pendTimer);
        pendTimer = setTimeout(function () { if (pendKey === key) setHi(key); }, 110);
      } else {
        clearTimeout(pendTimer);
        pendKey = '';
        if (!hiKey) { tip.style.display = 'none'; return; }
        clearTimeout(leaveTimer);
        leaveTimer = setTimeout(resetHi, 220);
      }
    }

    svg.addEventListener('pointermove', function (e) {
      pt = { x: e.clientX, y: e.clientY };
      if (drag) return;
      hoverEvt = e;
      if (!hoverRaf) {
        hoverRaf = requestAnimationFrame(function () { hoverRaf = 0; handleHover(); });
      }
    });
    svg.addEventListener('pointerleave', function () {
      clearTimeout(pendTimer);
      clearTimeout(leaveTimer);
      pendKey = '';
      leaveTimer = setTimeout(resetHi, 220);
    });

    nodeEls.forEach(function (el) {
      el.addEventListener('click', function () {
        var key = el.getAttribute('data-key');
        var kind = el.getAttribute('data-kind');
        location.hash = kind === 'scenario' ? '#/card/' + key : '#/node/' + key;
      });
    });

    /* 图层筛选（每次点击时重新取 DOM，重新布局后依然有效） */
    Array.prototype.forEach.call(view.querySelectorAll('.glg'), function (btn) {
      var lyr = btn.getAttribute('data-layer');
      if (lyr === '__sc' || btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', function () {
        var off = btn.classList.toggle('off');
        var svg2 = document.getElementById('gsvg');
        if (!svg2) return;
        Array.prototype.forEach.call(svg2.querySelectorAll('.gn[data-layer="' + lyr + '"]'), function (n2) {
          n2.style.display = off ? 'none' : '';
        });
        Array.prototype.forEach.call(svg2.querySelectorAll('.gline'), function (l) {
          var a = g.byKey[l.getAttribute('data-a')], b = g.byKey[l.getAttribute('data-b')];
          var hit = (a && a.layer === lyr) || (b && b.layer === lyr);
          if (hit) l.style.display = off ? 'none' : '';
        });
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
  var tocCleanup = null;
  var TOCW_KEY = 'review-toc-w-v1';
  var TOCW_DEF = 160;

  function tocWidth() {
    var v = 0;
    try { v = parseInt(localStorage.getItem(TOCW_KEY), 10) || 0; } catch (e) { v = 0; }
    if (!v) return TOCW_DEF;
    return Math.min(360, Math.max(140, v));
  }

  function viewCard(id) {
    var it = itemById[id];
    if (!it) { view.innerHTML = '<p class="emptyhit">内容不存在</p>'; return; }
    var i = idxById[id];
    var prev = items[i - 1], next = items[i + 1];
    var st = stOf(id);

    /* 目录只取 h2 / h3；不足 3 条就不显示右栏，避免短文平白多一列 */
    var toc = (it.toc || []).filter(function (t) { return t.lv === 2 || t.lv === 3; });
    if (!toc.length) toc = (it.toc || []).filter(function (t) { return t.lv <= 3; });

    var h = '<div class="viewcard">';
    h += '<div class="reader">';
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

    if (toc.length >= 3) {
      var tw = tocWidth();
      h += '<div class="toc-resize" title="拖动调整目录宽度 · 双击复位"></div>';
      h += '<nav class="toc" style="flex:0 0 ' + tw + 'px;width:' + tw + 'px" aria-label="本页目录">' +
        '<div class="toc-h">本页目录</div>' +
        toc.map(function (t) {
          return '<button type="button" class="toclink lv' + t.lv + '" data-t="' + t.id + '" title="' +
            esc(t.t) + '">' + esc(t.t) + '</button>';
        }).join('') + '</nav>';
    }
    h += '</div>';

    view.className = '';
    view.innerHTML = h;
    view.scrollTop = 0;
    bindToc();
    bindTocResize();

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

  /* 右侧目录：点击滚到标题，滚动时高亮当前章节 */
  function bindToc() {
    if (tocCleanup) { tocCleanup(); tocCleanup = null; }
    var links = Array.prototype.slice.call(view.querySelectorAll('.toclink'));
    if (!links.length) return;
    var heads = links.map(function (a) { return document.getElementById(a.dataset.t); })
      .filter(Boolean);
    if (!heads.length) return;

    function setActive(hid) {
      links.forEach(function (a) {
        var on = a.dataset.t === hid;
        a.classList.toggle('on', on);
        if (on) a.setAttribute('aria-current', 'true');
        else a.removeAttribute('aria-current');
      });
    }
    links.forEach(function (a) {
      a.addEventListener('click', function () {
        var el = document.getElementById(a.dataset.t);
        if (!el) return;
        setActive(a.dataset.t);
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    var ticking = false;
    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        var base = view.getBoundingClientRect().top;
        var cur = heads[0].id;
        for (var k = 0; k < heads.length; k++) {
          if (heads[k].getBoundingClientRect().top - base <= 76) cur = heads[k].id;
          else break;
        }
        /* 滚到底时最后一项永远到不了顶部，兜底选中它 */
        if (view.scrollTop + view.clientHeight >= view.scrollHeight - 6) {
          cur = heads[heads.length - 1].id;
        }
        setActive(cur);
      });
    }
    view.addEventListener('scroll', onScroll, { passive: true });
    tocCleanup = function () {
      view.removeEventListener('scroll', onScroll);
      tocCleanup = null;
    };
    onScroll();
  }

  /* 拖动分隔条调目录宽度；双击复位。宽度存 localStorage，全站生效 */
  function bindTocResize() {
    var bar = view.querySelector('.toc-resize');
    var toc = view.querySelector('.toc');
    if (!bar || !toc) return;
    var dragging = false, startX = 0, startW = 0;

    function apply(w) {
      w = Math.round(Math.min(360, Math.max(140, w)));
      toc.style.flexBasis = w + 'px';
      toc.style.width = w + 'px';
      return w;
    }

    bar.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startW = toc.getBoundingClientRect().width;
      bar.classList.add('drag');
      toc.classList.add('resizing');
      document.body.classList.add('col-resizing');
      try { bar.setPointerCapture(e.pointerId); } catch (err) {}
    });

    bar.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      apply(startW - (e.clientX - startX));
    });

    function end() {
      if (!dragging) return;
      dragging = false;
      bar.classList.remove('drag');
      toc.classList.remove('resizing');
      document.body.classList.remove('col-resizing');
      try {
        localStorage.setItem(TOCW_KEY, String(Math.round(toc.getBoundingClientRect().width)));
      } catch (err) {}
    }
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);

    bar.addEventListener('dblclick', function () {
      apply(TOCW_DEF);
      try { localStorage.setItem(TOCW_KEY, String(TOCW_DEF)); } catch (err) {}
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
      if (closeFigure()) return;
      var m = document.getElementById('modal');
      if (m && m.classList.contains('on')) { m.classList.remove('on'); return; }
      qres.classList.remove('on'); q.blur();
    }
    if (LB.on && (e.key === '+' || e.key === '=')) { lbZoomCenter(1.3); return; }
    if (LB.on && (e.key === '-' || e.key === '_')) { lbZoomCenter(0.77); return; }
    if (LB.on && e.key === '0') { lbReset(); return; }
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

  /* ------------------------------------------------------------ 插图放大
     点击正文里的 figure（内联 svg 或位图）→ 全屏查看。
     inline svg 无法用 <img> 放大（file:// 下会被拦），所以克隆节点塞进灯箱，
     靠外层 transform 做缩放平移，保持矢量清晰。 */

  var LB = { el: null, stage: null, box: null, cap: null, w: 0, h: 0, k: 1, x: 0, y: 0, on: false, drag: null };
  var LB_MIN = 0.45, LB_MAX = 6;

  function lbApply() {
    LB.box.style.transform = 'translate(' + LB.x + 'px,' + LB.y + 'px) scale(' + LB.k + ')';
  }
  function lbCenter() {
    LB.x = -LB.w / 2; LB.y = -LB.h / 2; lbApply();
  }
  function lbReset() { LB.k = 1; lbCenter(); }
  function lbZoomAt(cx, cy, factor) {
    var r = LB.stage.getBoundingClientRect();
    var ox = r.left + r.width / 2, oy = r.top + r.height / 2;
    var k2 = Math.max(LB_MIN, Math.min(LB_MAX, LB.k * factor));
    if (k2 === LB.k) return;
    var ratio = k2 / LB.k;
    LB.x = cx - ox - (cx - ox - LB.x) * ratio;
    LB.y = cy - oy - (cy - oy - LB.y) * ratio;
    LB.k = k2;
    lbApply();
  }
  function lbZoomCenter(factor) {
    var r = LB.stage.getBoundingClientRect();
    lbZoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
  }

  function closeFigure() {
    if (!LB.on) return false;
    LB.on = false;
    LB.drag = null;
    LB.el.classList.remove('on');
    LB.stage.classList.remove('dragging');
    LB.el.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('lb-open');
    setTimeout(function () { if (!LB.on) LB.box.innerHTML = ''; }, 200);
    return true;
  }

  function lbShow(cap) {
    LB.cap.textContent = cap || '';
    LB.k = 1;
    LB.on = true;
    LB.el.classList.add('on');
    LB.el.setAttribute('aria-hidden', 'false');
    document.body.classList.add('lb-open');
    lbCenter();
  }

  function openFigure(node) {
    var fig = node.closest('figure');
    var capEl = fig ? fig.querySelector('figcaption') : null;
    var cap = capEl ? capEl.textContent.trim() : (node.getAttribute('alt') || '');
    /* 先让灯箱可见，否则 stage 还没布局，clientWidth 是 0 */
    LB.el.classList.add('on');
    LB.el.setAttribute('aria-hidden', 'false');
    document.body.classList.add('lb-open');
    var sw = LB.stage.clientWidth || window.innerWidth;
    var sh = LB.stage.clientHeight || window.innerHeight;
    LB.box.innerHTML = '';

    function fit(nw, nh) {
      /* 先整幅放进窗口：窄屏留白收窄、允许缩到 0.3 倍（否则只能拖），宽屏最多放大 2.6 倍 */
      var mx = sw < 700 ? 20 : 96;
      var s = Math.min((sw - mx) / nw, (sh - 90) / nh);
      s = Math.max(0.3, Math.min(2.6, s));
      return [Math.round(nw * s), Math.round(nh * s)];
    }

    if (node.tagName.toLowerCase() === 'svg') {
      var clone = node.cloneNode(true);
      clone.removeAttribute('class');
      var vb = (clone.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
      var vw = vb.length === 4 && vb[2] > 0 ? vb[2] : 900;
      var vh = vb.length === 4 && vb[3] > 0 ? vb[3] : 520;
      var d = fit(vw, vh);
      LB.w = d[0]; LB.h = d[1];
      clone.setAttribute('width', LB.w);
      clone.setAttribute('height', LB.h);
      clone.style.width = LB.w + 'px';
      clone.style.height = LB.h + 'px';
      LB.box.appendChild(clone);
      lbShow(cap);
    } else {
      var img = new Image();
      img.alt = node.getAttribute('alt') || '';
      img.onload = function () {
        var d2 = fit(img.naturalWidth || 1200, img.naturalHeight || 800);
        LB.w = d2[0]; LB.h = d2[1];
        img.style.width = LB.w + 'px';
        img.style.height = LB.h + 'px';
        LB.box.appendChild(img);
        lbShow(cap);
      };
      img.onerror = function () { LB.box.innerHTML = ''; };
      img.src = node.getAttribute('src');
    }
  }

  function initFigure() {
    LB.el = document.getElementById('lb');
    LB.stage = document.getElementById('lbStage');
    LB.box = document.getElementById('lbBox');
    LB.cap = document.getElementById('lbCap');
    if (!LB.el) return;

    /* 只认正文里的插图：图谱 svg、页头图标都不受影响 */
    document.addEventListener('click', function (e) {
      if (!e.target.closest) return;
      var hit = e.target.closest('article figure svg, article figure img');
      if (!hit) return;
      if (LB.on) return;
      openFigure(hit);
    });

    LB.stage.addEventListener('wheel', function (e) {
      e.preventDefault();
      lbZoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0018));
    }, { passive: false });

    LB.stage.addEventListener('pointerdown', function (e) {
      if (!LB.on) return;
      LB.drag = { x: e.clientX, y: e.clientY, tx: LB.x, ty: LB.y, moved: false };
      LB.stage.classList.add('dragging');
      try { LB.stage.setPointerCapture(e.pointerId); } catch (err) {}
    });
    LB.stage.addEventListener('pointermove', function (e) {
      if (!LB.drag) return;
      LB.x = LB.drag.tx + (e.clientX - LB.drag.x);
      LB.y = LB.drag.ty + (e.clientY - LB.drag.y);
      LB.drag.moved = true;
      lbApply();
    });
    function endDrag(e) {
      if (!LB.drag) return;
      var moved = LB.drag.moved;
      LB.drag = null;
      LB.stage.classList.remove('dragging');
      try { LB.stage.releasePointerCapture(e.pointerId); } catch (err) {}
      /* 点空白处关闭；拖过就不算点击 */
      if (!moved && !e.target.closest('.lb-box')) closeFigure();
    }
    LB.stage.addEventListener('pointerup', endDrag);
    LB.stage.addEventListener('pointercancel', endDrag);
    LB.stage.addEventListener('dblclick', function (e) {
      if (e.target.closest('.lb-box')) lbReset();
    });

    document.getElementById('lbClose').addEventListener('click', closeFigure);
    document.getElementById('lbFit').addEventListener('click', lbReset);
    document.getElementById('lbIn').addEventListener('click', function () { lbZoomCenter(1.3); });
    document.getElementById('lbOut').addEventListener('click', function () { lbZoomCenter(0.77); });

    window.addEventListener('resize', function () {
      if (LB.on) lbReset();
    });
  }

  /* ------------------------------------------------------------ 代码配色
     只切 html[data-code]，颜色全走 CSS 变量，正文不重渲染、滚动位置不丢。 */
  var CODE_KEY = 'review-code-style-v1';
  function initCodeStyle() {
    var sel = document.getElementById('codeStyle');
    if (!sel) return;
    var cur = 'light';
    try { cur = localStorage.getItem(CODE_KEY) || 'light'; } catch (e) {}
    var ok = false;
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === cur) ok = true;
    }
    if (!ok) cur = 'light';
    sel.value = cur;
    document.documentElement.setAttribute('data-code', cur);
    sel.addEventListener('change', function () {
      var v = sel.value || 'light';
      document.documentElement.setAttribute('data-code', v);
      try { localStorage.setItem(CODE_KEY, v); } catch (e) {}
    });
  }

  window.addEventListener('hashchange', route);
  bindSideResize();
  initFigure();
  initCodeStyle();
  renderSide();
  route();
})();
