/* 白板 —— 全屏无限画布。零依赖：绘制 / 命中 / 撤销 / 本地存储 / PNG / PDF。 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var canvas = $('board');
  var g = canvas.getContext('2d');
  var editor = $('editor');

  var FONT = 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  var LS_KEY = 'board.v1';
  var MIN_K = 0.15, MAX_K = 5;

  var state = {
    tool: 'pen',
    color: '#1f2328',
    width: 4,
    fontSize: 22,
    noteColor: '#fff59d',
    shapes: [],
    view: { x: 0, y: 0, k: 1 },
    selected: null,
    drag: null,
    undo: [],
    redo: []
  };

  var seq = 1;
  function uid() { return seq++; }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  /* ══ 视图换算 ═════════════════════════════════════════ */
  function toWorld(px, py) {
    return { x: (px - state.view.x) / state.view.k, y: (py - state.view.y) / state.view.k };
  }
  function localPt(e) {
    var r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function cssSize() {
    var r = canvas.getBoundingClientRect();
    return { w: r.width || window.innerWidth, h: r.height || window.innerHeight };
  }

  /* ══ 尺寸 / 重绘 ══════════════════════════════════════ */
  function resize() {
    var s = cssSize();
    var dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    canvas.width = Math.round(s.w * dpr);
    canvas.height = Math.round(s.h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function draw() {
    var s = cssSize();
    var W = s.w, H = s.h;
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#fff';
    g.fillRect(0, 0, W, H);

    var k = state.view.k;
    // 点阵背景
    if (k > 0.32) {
      var step = 32 * k;
      var sx = state.view.x % step, sy = state.view.y % step;
      g.fillStyle = 'rgba(31,35,40,.085)';
      for (var gx = sx; gx < W; gx += step) {
        for (var gy = sy; gy < H; gy += step) g.fillRect(gx, gy, 1.3, 1.3);
      }
    }

    g.save();
    g.translate(state.view.x, state.view.y);
    g.scale(k, k);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (var i = 0; i < state.shapes.length; i++) drawShape(g, state.shapes[i]);
    if (state.drag && state.drag.preview) drawShape(g, state.drag.preview);
    if (state.selected) {
      var b = bbox(state.selected);
      if (b) {
        g.strokeStyle = '#1971c2';
        g.lineWidth = 1.5 / k;
        g.setLineDash([6 / k, 4 / k]);
        g.strokeRect(b.x - 6, b.y - 6, b.w + 12, b.h + 12);
        g.setLineDash([]);
      }
    }
    g.restore();

    $('zoom').textContent = Math.round(k * 100) + '%';
  }

  /* ══ 图形绘制（可传入导出用的 ctx）════════════════════ */
  function drawShape(c, s) {
    c.lineWidth = s.size || 4;
    c.strokeStyle = s.color || '#1f2328';
    c.fillStyle = s.color || '#1f2328';
    c.lineCap = 'round';
    c.lineJoin = 'round';

    switch (s.t) {
      case 'pen': {
        var pts = s.pts;
        if (!pts || !pts.length) return;
        if (pts.length === 1) {
          c.beginPath();
          c.arc(pts[0].x, pts[0].y, (s.size || 4) / 2, 0, Math.PI * 2);
          c.fill();
          return;
        }
        c.beginPath();
        c.moveTo(pts[0].x, pts[0].y);
        for (var i = 1; i < pts.length - 1; i++) {
          // 二次贝塞尔平滑，避免折线感
          var mx = (pts[i].x + pts[i + 1].x) / 2;
          var my = (pts[i].y + pts[i + 1].y) / 2;
          c.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
        }
        var last = pts[pts.length - 1];
        c.lineTo(last.x, last.y);
        c.stroke();
        break;
      }
      case 'line':
        c.beginPath();
        c.moveTo(s.x1, s.y1);
        c.lineTo(s.x2, s.y2);
        c.stroke();
        break;
      case 'arrow': {
        c.beginPath();
        c.moveTo(s.x1, s.y1);
        c.lineTo(s.x2, s.y2);
        c.stroke();
        var ang = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
        var hl = Math.max(11, (s.size || 4) * 3.2);
        c.beginPath();
        c.moveTo(s.x2, s.y2);
        c.lineTo(s.x2 - hl * Math.cos(ang - 0.42), s.y2 - hl * Math.sin(ang - 0.42));
        c.lineTo(s.x2 - hl * Math.cos(ang + 0.42), s.y2 - hl * Math.sin(ang + 0.42));
        c.closePath();
        c.fill();
        break;
      }
      case 'rect': {
        var rx = Math.min(s.x, s.x + s.w), ry = Math.min(s.y, s.y + s.h);
        var rw = Math.abs(s.w), rh = Math.abs(s.h);
        var r = Math.min(10, rw / 6, rh / 6);
        roundRect(c, rx, ry, rw, rh, r);
        c.stroke();
        break;
      }
      case 'ellipse':
        c.beginPath();
        c.ellipse(s.x + s.w / 2, s.y + s.h / 2, Math.abs(s.w / 2), Math.abs(s.h / 2), 0, 0, Math.PI * 2);
        c.stroke();
        break;
      case 'diamond': {
        var cx = s.x + s.w / 2, cy = s.y + s.h / 2;
        c.beginPath();
        c.moveTo(cx, s.y);
        c.lineTo(s.x + s.w, cy);
        c.lineTo(cx, s.y + s.h);
        c.lineTo(s.x, cy);
        c.closePath();
        c.stroke();
        break;
      }
      case 'text': {
        c.fillStyle = s.color;
        c.font = (s.fs || 22) + 'px ' + FONT;
        c.textBaseline = 'top';
        var lines = String(s.text || '').split('\n');
        for (var li = 0; li < lines.length; li++) {
          c.fillText(lines[li], s.x, s.y + li * (s.fs || 22) * 1.36);
        }
        break;
      }
      case 'image': {
        var ix = Math.min(s.x, s.x + s.w), iy = Math.min(s.y, s.y + s.h);
        var iw = Math.abs(s.w), ih = Math.abs(s.h);
        if (iw < 1 || ih < 1) break;
        var im = getImg(s.src);
        if (im.complete && im.naturalWidth > 0) {
          c.drawImage(im, ix, iy, iw, ih);
          c.strokeStyle = 'rgba(0,0,0,.10)';
          c.lineWidth = 1;
          c.strokeRect(ix + .5, iy + .5, iw - 1, ih - 1);
        } else {
          c.fillStyle = '#f4f5f7';
          c.fillRect(ix, iy, iw, ih);
        }
        break;
      }
      case 'note': {
        var nx = Math.min(s.x, s.x + s.w), ny = Math.min(s.y, s.y + s.h);
        var nw = Math.abs(s.w), nh = Math.abs(s.h);
        c.save();
        c.shadowColor = 'rgba(16,24,40,.14)';
        c.shadowBlur = 12;
        c.shadowOffsetY = 3;
        c.fillStyle = s.bg || '#fff59d';
        roundRect(c, nx, ny, nw, nh, 6);
        c.fill();
        c.restore();
        c.strokeStyle = 'rgba(0,0,0,.10)';
        c.lineWidth = 1;
        roundRect(c, nx, ny, nw, nh, 6);
        c.stroke();

        c.fillStyle = '#1f2328';
        c.font = '15px ' + FONT;
        c.textBaseline = 'top';
        var rows = wrapText(c, s.text || '', nw - 22);
        for (var ri = 0; ri < rows.length && 12 + ri * 22 < nh - 8; ri++) {
          c.fillText(rows[ri], nx + 11, ny + 10 + ri * 22);
        }
        break;
      }
    }
  }

  function roundRect(c, x, y, w, h, r) {
    if (w <= 0 || h <= 0) { c.beginPath(); return; }
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y);
    c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r);
    c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h);
    c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r);
    c.quadraticCurveTo(x, y, x + r, y);
    c.closePath();
  }

  function wrapText(c, text, maxW) {
    var rows = [];
    String(text).split('\n').forEach(function (line) {
      var cur = '';
      for (var i = 0; i < line.length; i++) {
        var next = cur + line[i];
        if (c.measureText(next).width > maxW && cur) { rows.push(cur); cur = line[i]; }
        else cur = next;
      }
      rows.push(cur);
    });
    return rows;
  }

  /* ══ 包围盒与命中 ═════════════════════════════════════ */
  function bbox(s) {
    switch (s.t) {
      case 'pen': {
        if (!s.pts || !s.pts.length) return null;
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        s.pts.forEach(function (p) {
          if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
        });
        var pad = (s.size || 4) / 2;
        return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
      }
      case 'line':
      case 'arrow':
        return {
          x: Math.min(s.x1, s.x2), y: Math.min(s.y1, s.y2),
          w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1)
        };
      case 'rect':
      case 'ellipse':
      case 'diamond':
      case 'note':
      case 'image':
        return {
          x: Math.min(s.x, s.x + s.w), y: Math.min(s.y, s.y + s.h),
          w: Math.abs(s.w), h: Math.abs(s.h)
        };
      case 'text': {
        g.font = (s.fs || 22) + 'px ' + FONT;
        var lines = String(s.text || '').split('\n');
        var w = 0;
        lines.forEach(function (l) { w = Math.max(w, g.measureText(l).width); });
        var fs = s.fs || 22;
        return { x: s.x, y: s.y, w: w || fs, h: lines.length * fs * 1.36 };
      }
    }
    return null;
  }

  function hit(s, wx, wy) {
    var b = bbox(s);
    if (!b) return false;
    var pad = (s.t === 'pen' || s.t === 'line' || s.t === 'arrow') ? (s.size || 4) / 2 + 5 : 7;
    return wx >= b.x - pad && wx <= b.x + b.w + pad && wy >= b.y - pad && wy <= b.y + b.h + pad;
  }

  function shapeAt(wx, wy) {
    for (var i = state.shapes.length - 1; i >= 0; i--) {
      if (hit(state.shapes[i], wx, wy)) return state.shapes[i];
    }
    return null;
  }

  /* ══ 撤销 / 存储 ══════════════════════════════════════ */
  function snapshot() {
    state.undo.push(JSON.stringify(state.shapes));
    if (state.undo.length > 60) state.undo.shift();
    state.redo.length = 0;
    syncButtons();
  }
  function undo() {
    if (!state.undo.length) return;
    state.redo.push(JSON.stringify(state.shapes));
    state.shapes = JSON.parse(state.undo.pop());
    state.selected = null;
    draw(); persist(); syncButtons();
  }
  function redo() {
    if (!state.redo.length) return;
    state.undo.push(JSON.stringify(state.shapes));
    state.shapes = JSON.parse(state.redo.pop());
    state.selected = null;
    draw(); persist(); syncButtons();
  }
  function syncButtons() {
    $('undo').disabled = !state.undo.length;
    $('redo').disabled = !state.redo.length;
  }

  /* ── 自动保存到本机浏览器：改动后 320ms 落盘，关页面前强制落盘 ── */
  var saveTimer = 0;
  var saveEl = null;

  function pad2(n) { return String(n).padStart(2, '0'); }

  function setSave(mode, ts) {
    if (!saveEl) saveEl = $('save');
    if (!saveEl) return;
    saveEl.classList.remove('saving', 'error');
    if (mode === 'saving') {
      saveEl.classList.add('saving');
      saveEl.textContent = '保存中…';
      saveEl.dataset.tip = '正在写入本机浏览器存储';
    } else if (mode === 'saved') {
      var d = new Date(ts || Date.now());
      saveEl.textContent = '已存本机 ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
      saveEl.dataset.tip = '内容已保存在这台设备的浏览器里，刷新或关掉再打开都还在；需要文件时再点导出';
    } else if (mode === 'error') {
      saveEl.classList.add('error');
      saveEl.textContent = '本机存储已满';
      saveEl.dataset.tip = '浏览器本地存储写不进去了，请先点「导出 PNG/PDF」或清空部分内容，否则刷新会丢失';
    } else {
      saveEl.textContent = '自动保存已开启';
      saveEl.dataset.tip = '内容自动保存在这台设备的浏览器里，刷新不丢；需要文件时再点导出';
    }
  }

  function flushSave() {
    clearTimeout(saveTimer);
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        v: 1, shapes: state.shapes, view: state.view, savedAt: Date.now()
      }));
      setSave('saved');
      return true;
    } catch (e) {
      setSave('error');
      return false;
    }
  }

  function persist() {
    setSave('saving');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 320);
  }

  function restore() {
    var ts = 0;
    try {
      var d = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (d && Array.isArray(d.shapes)) {
        state.shapes = d.shapes;
        if (d.view && typeof d.view.k === 'number') state.view = d.view;
        state.shapes.forEach(function (s) { if (s.id >= seq) seq = s.id + 1; });
        ts = d.savedAt || 0;
      }
    } catch (e) { /* 忽略损坏数据 */ }
    return ts;
  }

  /* ══ 文字编辑 ════════════════════════════════════════ */
  var editing = null;

  function openEditor(shape, sp) {
    editing = { shape: shape, isNew: !shape.text, before: JSON.stringify(state.shapes) };
    editor.hidden = false;
    var k = state.view.k;
    var fs = (shape.t === 'note' ? 15 : (shape.fs || 22)) * k;
    editor.style.font = fs + 'px ' + FONT;
    editor.style.left = Math.max(8, sp.x) + 'px';
    editor.style.top = (sp.y - fs - 8) + 'px';
    editor.style.minWidth = (shape.t === 'note' ? 120 : 90) * k + 'px';
    editor.value = shape.text || '';
    editor.focus();
    editor.select();
  }

  function closeEditor(commit) {
    if (!editing) return;
    var sh = editing.shape;
    editor.hidden = true;
    var at = state.shapes.indexOf(sh);
    if (commit) {
      sh.text = editor.value.replace(/\s+$/, '');
      if (sh.t === 'text' && !sh.text && at >= 0) state.shapes.splice(at, 1);
    } else if (!sh.text && at >= 0) {
      state.shapes.splice(at, 1);
    }
    editing = null;
    draw(); persist(); syncButtons();
  }

  /* ══ 指针交互 ════════════════════════════════════════ */
  var pointers = new Map();
  var pinch = null;
  var spaceDown = false;

  function onDown(e) {
    if (e.pointerType === 'mouse' && e.button === 2) return;

    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 2) {
      // 双指：放弃正在进行的描绘，进入缩放
      if (state.drag && (state.drag.mode === 'pen' || state.drag.mode === 'shape')) {
        state.drag = null;
        draw();
      }
      state.drag = null;
      startPinch();
      return;
    }
    if (pointers.size > 2) return;

    if (editing) { closeEditor(true); return; }

    var sp = localPt(e);
    var w = toWorld(sp.x, sp.y);

    if (e.button === 1 || state.tool === 'pan' || spaceDown) {
      state.drag = { mode: 'pan', sx: sp.x, sy: sp.y, ox: state.view.x, oy: state.view.y };
      canvas.style.cursor = 'grabbing';
      if (e.cancelable) e.preventDefault();
      return;
    }

    switch (state.tool) {
      case 'select': {
        var s = shapeAt(w.x, w.y);
        state.selected = s;
        if (s) {
          if ((s.t === 'note' || s.t === 'text') && e.detail >= 2) {
            if (e.cancelable) e.preventDefault(); // 阻止兼容 mousedown 抢焦点，否则编辑器会立刻失焦关闭
            openEditor(s, sp);
            draw();
            return;
          }
          snapshot();
          state.drag = { mode: 'move', start: w, orig: JSON.parse(JSON.stringify(s)), shape: s };
        }
        draw();
        break;
      }
      case 'pen':
        state.drag = { mode: 'pen', preview: { id: uid(), t: 'pen', color: state.color, size: state.width, pts: [w] } };
        break;
      case 'line':
      case 'arrow':
        state.drag = { mode: 'shape', preview: { id: uid(), t: state.tool, color: state.color, size: state.width, x1: w.x, y1: w.y, x2: w.x, y2: w.y } };
        break;
      case 'rect':
      case 'ellipse':
      case 'diamond':
        state.drag = { mode: 'shape', preview: { id: uid(), t: state.tool, color: state.color, size: state.width, x: w.x, y: w.y, w: 0, h: 0 } };
        break;
      case 'text': {
        if (e.cancelable) e.preventDefault(); // 关键：阻止兼容 mousedown 的默认抢焦行为，否则编辑器刚聚焦就被 blur 关闭，永远打不了字
        snapshot();
        var sh = { id: uid(), t: 'text', color: state.color, fs: state.fontSize, x: w.x, y: w.y, text: '' };
        state.shapes.push(sh);
        openEditor(sh, sp);
        draw();
        break;
      }
      case 'note': {
        if (e.cancelable) e.preventDefault(); // 同上
        snapshot();
        var nt = { id: uid(), t: 'note', bg: state.noteColor, x: w.x, y: w.y, w: 168, h: 104, text: '' };
        state.shapes.push(nt);
        state.selected = nt;
        openEditor(nt, sp);
        draw();
        break;
      }
      case 'eraser':
        snapshot();
        state.drag = { mode: 'erase' };
        eraseAt(w);
        break;
    }
  }

  function onMove(e) {
    if (pointers.has(e.pointerId)) {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    if (pinch) { updatePinch(); return; }

    var d = state.drag;
    if (!d) return;
    if (d.mode === 'pan') {
      var sp0 = localPt(e);
      state.view.x = d.ox + (sp0.x - d.sx);
      state.view.y = d.oy + (sp0.y - d.sy);
      draw(); persist();
      return;
    }

    var sp = localPt(e);
    var w = toWorld(sp.x, sp.y);

    switch (d.mode) {
      case 'pen': {
        var pts = d.preview.pts;
        var last = pts[pts.length - 1];
        if (Math.abs(w.x - last.x) + Math.abs(w.y - last.y) > 0.8 / state.view.k) pts.push(w);
        break;
      }
      case 'shape':
        if (d.preview.t === 'line' || d.preview.t === 'arrow') {
          d.preview.x2 = w.x; d.preview.y2 = w.y;
        } else {
          d.preview.w = w.x - d.preview.x;
          d.preview.h = w.y - d.preview.y;
          if (e.shiftKey) {
            var m = Math.max(Math.abs(d.preview.w), Math.abs(d.preview.h));
            d.preview.w = Math.sign(d.preview.w || 1) * m;
            d.preview.h = Math.sign(d.preview.h || 1) * m;
          }
        }
        break;
      case 'move': {
        var o = d.orig;
        var dx = w.x - d.start.x, dy = w.y - d.start.y;
        var t = d.shape;
        if (t.t === 'pen') {
          t.pts = o.pts.map(function (p) { return { x: p.x + dx, y: p.y + dy }; });
        } else if (t.t === 'line' || t.t === 'arrow') {
          t.x1 = o.x1 + dx; t.y1 = o.y1 + dy;
          t.x2 = o.x2 + dx; t.y2 = o.y2 + dy;
        } else {
          t.x = o.x + dx; t.y = o.y + dy;
          if (t.t === 'note') { t.w = o.w; t.h = o.h; }
        }
        break;
      }
      case 'erase':
        eraseAt(w);
        break;
    }
    draw();
  }

  function onUp(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2 && pinch) { pinch = null; }
    if (pointers.size === 0 && e.pointerType !== 'mouse') canvas.style.cursor = cursorFor(state.tool);

    var d = state.drag;
    if (!d) { syncButtons(); return; }

    if (d.mode === 'pan') {
      state.drag = null;
      canvas.style.cursor = cursorFor(state.tool);
      return;
    }
    if (d.mode === 'pen' && d.preview.pts.length) {
      state.shapes.push(d.preview);
    } else if (d.mode === 'shape') {
      var p = d.preview;
      var tiny = (p.t === 'line' || p.t === 'arrow')
        ? Math.abs(p.x2 - p.x1) + Math.abs(p.y2 - p.y1) < 5
        : Math.abs(p.w) + Math.abs(p.h) < 8;
      if (!tiny) { state.shapes.push(p); }
      else { state.undo.pop(); }
    }
    state.drag = null;
    draw(); persist(); syncButtons();
  }

  function eraseAt(w) {
    for (var i = state.shapes.length - 1; i >= 0; i--) {
      if (hit(state.shapes[i], w.x, w.y)) state.shapes.splice(i, 1);
    }
    if (state.selected && state.shapes.indexOf(state.selected) < 0) state.selected = null;
  }

  /* ══ 双指缩放 ════════════════════════════════════════ */
  function startPinch() {
    var arr = Array.from(pointers.values());
    var a = arr[0], b = arr[1];
    var mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    pinch = {
      d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      k0: state.view.k,
      world: {
        x: (mid.x - state.view.x) / state.view.k,
        y: (mid.y - state.view.y) / state.view.k
      }
    };
  }

  function updatePinch() {
    var arr = Array.from(pointers.values());
    if (arr.length < 2 || !pinch) return;
    var a = arr[0], b = arr[1];
    var dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    var mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    var k = clamp(pinch.k0 * (dist / pinch.d0), MIN_K, MAX_K);
    state.view.k = k;
    state.view.x = mid.x - pinch.world.x * k;
    state.view.y = mid.y - pinch.world.y * k;
    draw(); persist();
  }

  /* ══ 滚轮缩放 / 适应内容 ══════════════════════════════ */
  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    var sp = localPt(e);
    var factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0018));
    var nk = clamp(state.view.k * factor, MIN_K, MAX_K);
    var w = toWorld(sp.x, sp.y);
    state.view.k = nk;
    state.view.x = sp.x - w.x * nk;
    state.view.y = sp.y - w.y * nk;
    draw(); persist();
  }, { passive: false });

  function contentBBox() {
    var b = null;
    for (var i = 0; i < state.shapes.length; i++) {
      var sb = bbox(state.shapes[i]);
      if (!sb) continue;
      if (!b) { b = { x: sb.x, y: sb.y, w: sb.w, h: sb.h }; continue; }
      var x2 = Math.max(b.x + b.w, sb.x + sb.w);
      var y2 = Math.max(b.y + b.h, sb.y + sb.h);
      b.x = Math.min(b.x, sb.x); b.y = Math.min(b.y, sb.y);
      b.w = x2 - b.x; b.h = y2 - b.y;
    }
    return b;
  }

  function fitView() {
    var b = contentBBox();
    var s = cssSize();
    if (!b || (b.w < 1 && b.h < 1)) {
      state.view = { x: s.w / 2, y: s.h / 2, k: 1 };
      draw(); persist();
      return;
    }
    var k = clamp(Math.min((s.w - 120) / b.w, (s.h - 140) / b.h), MIN_K, 2.5);
    state.view.k = k;
    state.view.x = (s.w - b.w * k) / 2 - b.x * k;
    state.view.y = (s.h - b.h * k) / 2 - b.y * k;
    draw(); persist();
  }

  /* ══ 导出：渲染内容成离屏画布 ═════════════════════════ */
  function renderContent(maxSide) {
    var b = contentBBox();
    if (!b) return null;
    var pad = 36;
    var W = b.w + pad * 2, H = b.h + pad * 2;
    var s = clamp(maxSide / Math.max(W, H), 0.5, 3);
    var cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(W * s));
    cv.height = Math.max(1, Math.round(H * s));
    var c = cv.getContext('2d');
    c.fillStyle = '#fff';
    c.fillRect(0, 0, cv.width, cv.height);
    c.save();
    c.translate(-b.x * s + pad * s, -b.y * s + pad * s);
    c.scale(s, s);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    for (var i = 0; i < state.shapes.length; i++) drawShape(c, state.shapes[i]);
    c.restore();
    return cv;
  }

  function stamp() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  function download(blob, name) {
    if (window.__noDownload) { window.__lastDownload = { blob: blob, name: name }; return; }
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function exportPNG() {
    var cv = renderContent(2400);
    if (!cv) return toast('白板还是空的，先画点什么');
    cv.toBlob(function (blob) {
      if (!blob) return toast('导出失败，请重试');
      download(blob, '白板-' + stamp() + '.png');
      toast('已导出 PNG · ' + cv.width + '×' + cv.height);
    }, 'image/png');
  }

  /* ── PDF：手写最小 PDF，图像用 FlateDecode 无损嵌入 ── */
  var A4 = [595.28, 841.89];

  async function zlibDeflate(bytes) {
    if (typeof CompressionStream !== 'function') return null;
    try {
      var stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) { return null; }
  }

  async function exportPDF() {
    var cv = renderContent(2000);
    if (!cv) return toast('白板还是空的，先画点什么');
    toast('正在生成 PDF…');

    var w = cv.width, h = cv.height;
    var px = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;

    // 图像数据：优先无损 RGB + FlateDecode，不支持时退回 JPEG(DCTDecode)
    var filter, imgBytes;
    var rgb = new Uint8Array(w * h * 3);
    for (var i = 0, j = 0; i < px.length; i += 4) {
      rgb[j++] = px[i]; rgb[j++] = px[i + 1]; rgb[j++] = px[i + 2];
    }
    var z = await zlibDeflate(rgb);
    if (z) {
      filter = '/FlateDecode';
      imgBytes = z;
    } else {
      var blob = await new Promise(function (r) { cv.toBlob(r, 'image/jpeg', 0.94); });
      imgBytes = new Uint8Array(await blob.arrayBuffer());
      filter = '/DCTDecode';
    }

    // 版面：按内容比例选 A4 横/纵，等比居中
    var land = w >= h;
    var pw = land ? A4[1] : A4[0];
    var ph = land ? A4[0] : A4[1];
    var margin = 18;
    var sc = Math.min((pw - margin * 2) / w, (ph - margin * 2) / h);
    var dw = w * sc, dh = h * sc;
    var dx = (pw - dw) / 2, dy = (ph - dh) / 2;
    var n = function (v) { return (Math.round(v * 1000) / 1000).toString(); };

    var enc = new TextEncoder();
    var chunks = [], total = 0, offsets = {};
    function put(bytes) { chunks.push(bytes); total += bytes.length; }
    function putStr(s) { put(enc.encode(s)); }
    function obj(num, dict, stream) {
      offsets[num] = total;
      putStr(num + ' 0 obj\n' + dict);
      if (stream) {
        putStr('\nstream\n');
        put(stream);
        putStr('\nendstream');
      }
      putStr('\nendobj\n');
    }

    putStr('%PDF-1.4\n');
    put(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A])); // 二进制标记

    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + n(pw) + ' ' + n(ph) + ']' +
           ' /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>');
    obj(4, '<< /Type /XObject /Subtype /Image /Width ' + w + ' /Height ' + h +
           ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter ' + filter +
           ' /Length ' + imgBytes.length + ' >>', imgBytes);

    var content = 'q\n' + n(dw) + ' 0 0 ' + n(dh) + ' ' + n(dx) + ' ' + n(dy) + ' cm\n/Im0 Do\nQ\n';
    var contentBytes = enc.encode(content);
    obj(5, '<< /Length ' + contentBytes.length + ' >>', contentBytes);

    var xref = total;
    putStr('xref\n0 6\n0000000000 65535 f \n');
    for (var o = 1; o <= 5; o++) {
      putStr(String(offsets[o]).padStart(10, '0') + ' 00000 n \n');
    }
    putStr('trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');

    var out = new Uint8Array(total), at = 0;
    chunks.forEach(function (c) { out.set(c, at); at += c.length; });

    download(new Blob([out], { type: 'application/pdf' }),
      '白板-' + stamp() + '.pdf');
    toast('已导出 PDF · A4 ' + (land ? '横向' : '纵向') +
      ' · ' + Math.round(out.length / 1024) + ' KB');
  }

  /* ══ 工具切换 ════════════════════════════════════════ */
  function cursorFor(t) {
    if (t === 'pan') return 'grab';
    if (t === 'select') return 'default';
    if (t === 'text') return 'text';
    if (t === 'eraser') return 'cell';
    if (t === 'note') return 'copy';
    return 'crosshair';
  }

  function setTool(t) {
    state.tool = t;
    Array.prototype.forEach.call(document.querySelectorAll('[data-tool]'), function (b) {
      var on = b.dataset.tool === t;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (state.drag && state.drag.mode !== 'pan') state.drag = null;
    canvas.style.cursor = cursorFor(t);
    draw();
  }

  /* ══ 吐司 ════════════════════════════════════════════ */
  var toastTimer = 0;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('on'); }, 2400);
  }

  /* ══ 粘贴 / 拖入图片 ══════════════════════════════════ */
  var imgCache = {};
  function getImg(src) {
    var im = imgCache[src];
    if (!im) {
      var keys = Object.keys(imgCache);
      if (keys.length > 40) delete imgCache[keys[0]]; // 简单缓存上限，防内存膨胀
      im = imgCache[src] = new Image();
      im.onload = function () { draw(); }; // 加载完成后补一帧
      im.src = src;
    }
    return im;
  }

  function insertImageBlob(blob, worldPt) {
    if (!blob || !blob.type || blob.type.indexOf('image/') !== 0) return;
    var url = URL.createObjectURL(blob);
    var probe = new Image();
    probe.onload = function () {
      URL.revokeObjectURL(url);
      // 存储前压到最大 640px：截图/照片直接存 dataURL 很容易撑爆 localStorage
      var MAX_STORE = 640;
      var sc = Math.min(1, MAX_STORE / Math.max(probe.naturalWidth, probe.naturalHeight));
      var cw = Math.max(1, Math.round(probe.naturalWidth * sc));
      var chh = Math.max(1, Math.round(probe.naturalHeight * sc));
      var cv = document.createElement('canvas');
      cv.width = cw; cv.height = chh;
      var c = cv.getContext('2d');
      c.drawImage(probe, 0, 0, cw, chh);
      var src = cv.toDataURL('image/png'); // 先试 PNG（保留透明）
      if (src.length > 380000) {           // 太大则白底 JPEG 兜底
        c.fillStyle = '#fff';
        c.fillRect(0, 0, cw, chh);
        c.drawImage(probe, 0, 0, cw, chh);
        src = cv.toDataURL('image/jpeg', 0.82);
      }

      // 画布里的显示尺寸：长边约 300 个世界单位，和便签大小协调
      var DISPLAY = 300;
      var dw = DISPLAY * cw / Math.max(cw, chh);
      var dh = DISPLAY * chh / Math.max(cw, chh);
      var cp = worldPt || toWorld(cssSize().w / 2, cssSize().h / 2);
      // 连续粘贴时错开摆放，避免完全重叠
      for (var i = 0; i < state.shapes.length; i++) {
        var b = state.shapes[i];
        if (b.t === 'image' && Math.abs(b.x - (cp.x - dw / 2)) < 8 && Math.abs(b.y - (cp.y - dh / 2)) < 8) {
          cp.x += 26; cp.y += 26;
          i = -1; // 重新检查，防止和错位后的图形再重叠
        }
      }
      snapshot();
      var sh = { id: uid(), t: 'image', src: src, x: cp.x - dw / 2, y: cp.y - dh / 2, w: dw, h: dh };
      state.shapes.push(sh);
      state.selected = sh;
      draw(); persist(); syncButtons();
      toast('已添加图片，可用「选择」拖动或删除');
    };
    probe.onerror = function () {
      URL.revokeObjectURL(url);
      toast('图片读取失败');
    };
    probe.src = url;
  }

  document.addEventListener('paste', function (e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf('image/') === 0) {
        var f = items[i].getAsFile();
        if (f) { e.preventDefault(); insertImageBlob(f); }
        return;
      }
    }
  });

  document.addEventListener('dragover', function (e) {
    if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0) e.preventDefault();
  });
  document.addEventListener('drop', function (e) {
    var dt = e.dataTransfer;
    if (!dt || Array.prototype.indexOf.call(dt.types || [], 'Files') < 0) return;
    e.preventDefault(); // 阻止浏览器直接打开图片文件
    var f = dt.files && dt.files[0];
    if (f && /^image\//.test(f.type)) {
      var sp = localPt(e);
      insertImageBlob(f, toWorld(sp.x, sp.y));
    } else {
      toast('只能放入图片文件');
    }
  });

  /* ══ 事件绑定 ════════════════════════════════════════ */
  canvas.addEventListener('pointerdown', function (e) {
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 部分浏览器不支持 */ }
    onDown(e);
  });
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  canvas.addEventListener('dblclick', function (e) {
    var sp = localPt(e);
    var w = toWorld(sp.x, sp.y);
    var s = shapeAt(w.x, w.y);
    if (s && (s.t === 'note' || s.t === 'text')) {
      snapshot();
      state.selected = s;
      openEditor(s, sp);
    }
  });

  $('dock').addEventListener('click', function (e) {
    var b = e.target.closest('[data-tool]');
    if (b) setTool(b.dataset.tool);
  });

  $('colors').addEventListener('click', function (e) {
    var b = e.target.closest('[data-color]');
    if (!b) return;
    state.color = b.dataset.color;
    if (state.selected && state.selected.t !== 'note') {
      state.selected.color = state.color;
      draw(); persist();
    }
    Array.prototype.forEach.call(this.querySelectorAll('.dot'), function (x) {
      var on = x === b;
      x.classList.toggle('on', on);
      x.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  });

  $('width').addEventListener('change', function () {
    state.width = Number(this.value);
    if (state.selected && state.selected.size !== undefined) {
      state.selected.size = state.width; draw(); persist();
    }
  });
  $('font').addEventListener('change', function () {
    state.fontSize = Number(this.value);
    if (state.selected && state.selected.t === 'text') {
      state.selected.fs = state.fontSize; draw(); persist();
    }
  });
  $('noteColor').addEventListener('change', function () {
    state.noteColor = this.value;
    if (state.selected && state.selected.t === 'note') {
      state.selected.bg = this.value; draw(); persist();
    }
  });

  $('undo').addEventListener('click', undo);
  $('redo').addEventListener('click', redo);
  $('del').addEventListener('click', function () {
    if (!state.selected) return toast('先用「选择」点一下要删的东西');
    snapshot();
    state.shapes.splice(state.shapes.indexOf(state.selected), 1);
    state.selected = null;
    draw(); persist();
  });
  $('fit').addEventListener('click', fitView);
  $('clear').addEventListener('click', function () {
    if (!state.shapes.length) return;
    if (!window.confirm('清空整块白板？此操作可以用「撤销」找回。')) return;
    snapshot();
    state.shapes = [];
    state.selected = null;
    draw(); persist();
  });
  $('png').addEventListener('click', exportPNG);
  $('pdf').addEventListener('click', exportPDF);

  editor.addEventListener('keydown', function (e) {
    e.stopPropagation();
    if (e.isComposing) return; // 中文输入法组词中：回车/ESC 先交给输入法，不要提交或关闭编辑器
    if (e.key === 'Enter') { e.preventDefault(); closeEditor(true); }
    else if (e.key === 'Escape') { e.preventDefault(); closeEditor(false); }
  });
  editor.addEventListener('blur', function () { if (editing) closeEditor(true); });

  document.addEventListener('keydown', function (e) {
    if (e.target === editor) return;
    var tag = (e.target.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    var mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (state.selected) { $('del').click(); e.preventDefault(); }
      return;
    }
    if (e.key === ' ') { spaceDown = true; canvas.style.cursor = 'grab'; e.preventDefault(); return; }
    if (e.key === 'Escape') { state.selected = null; draw(); return; }

    var map = {
      v: 'select', p: 'pen', l: 'line', a: 'arrow', r: 'rect',
      o: 'ellipse', d: 'diamond', t: 'text', n: 'note', e: 'eraser', h: 'pan'
    };
    var t = map[e.key.toLowerCase()];
    if (t && !mod) setTool(t);
  });

  document.addEventListener('keyup', function (e) {
    if (e.key === ' ') {
      spaceDown = false;
      canvas.style.cursor = cursorFor(state.tool);
    }
  });

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', function () { setTimeout(resize, 120); });

  // 首次打开时的小提示自动淡出
  setTimeout(function () {
    var tip = $('tip');
    if (tip) tip.classList.add('hide');
  }, 6000);

  // 关页面 / 切后台时立刻落盘，避免最后 320ms 的改动丢掉
  window.addEventListener('pagehide', flushSave);
  window.addEventListener('beforeunload', flushSave);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) flushSave();
  });

  var restoredAt = restore();
  setSave(state.shapes.length ? 'saved' : 'idle', restoredAt);
  resize();
  syncButtons();
  canvas.style.cursor = cursorFor(state.tool);

  /* ══ 悬浮工具提示：悬停 / 点击聚焦图标即显示名称与快捷键 ══ */
  (function () {
    if (!matchMedia('(hover: hover)').matches) return; // 触屏设备不启用
    var tipEl = null, cur = null;

    function ensure() {
      if (!tipEl) {
        tipEl = document.createElement('div');
        tipEl.className = 'tooltip';
        tipEl.setAttribute('role', 'tooltip');
        document.body.appendChild(tipEl);
      }
      return tipEl;
    }

    function showFor(el) {
      var text = el.getAttribute('data-tip');
      if (!text) return;
      var t = ensure();
      t.textContent = text;
      t.style.left = '-9999px';
      t.style.top = '0px';
      t.classList.add('on');
      var r = el.getBoundingClientRect();
      var tw = t.offsetWidth, th = t.offsetHeight;
      var x = Math.min(Math.max(8, r.left + r.width / 2 - tw / 2), window.innerWidth - tw - 8);
      var y = el.closest('.dock') ? (r.bottom + 7) : (r.top - th - 7); // 顶栏向下弹，底栏向上弹
      t.style.left = x + 'px';
      t.style.top = Math.max(4, y) + 'px';
      cur = el;
    }

    function hide() {
      if (tipEl) tipEl.classList.remove('on');
      cur = null;
    }

    document.addEventListener('mouseover', function (e) {
      var el = e.target.closest && e.target.closest('[data-tip]');
      if (el && el !== cur) showFor(el);
      else if (!el) hide();
    });
    document.addEventListener('mouseout', function (e) {
      if (cur && !e.relatedTarget) hide(); // 鼠标离开窗口
    });
    document.addEventListener('focusin', function (e) {
      var el = e.target.closest && e.target.closest('[data-tip]');
      if (el) showFor(el); // 键盘 Tab 或点击聚焦时同样显示
    });
    document.addEventListener('focusout', hide);
    document.addEventListener('pointerdown', function (e) {
      if (!(e.target.closest && e.target.closest('[data-tip]'))) hide();
    });
    window.addEventListener('blur', hide);
  })();

  /* ══ 自检钩子（?test=1）═══════════════════════════════ */
  if (/[?&]test=1/.test(location.search)) runTests();

  function runTests() {
    window.BOARD = {
      state: state, draw: draw, drawShape: drawShape, bbox: bbox, hit: hit,
      snapshot: snapshot, undo: undo, redo: redo, toWorld: toWorld,
      contentBBox: contentBBox, renderContent: renderContent,
      setTool: setTool, zlibDeflate: zlibDeflate, exportPNG: exportPNG, exportPDF: exportPDF,
      persist: persist, flushSave: flushSave, restore: restore, setSave: setSave
    };
    var out = [];
    var queue = [];
    function T(name, fn) { queue.push([name, fn]); }
    function assert(c, m) { if (!c) throw new Error(m || 'assert'); }

    T('画布铺满视口', function () {
      var s = cssSize();
      assert(s.w > 200 && s.h > 200, '视口尺寸异常: ' + s.w + 'x' + s.h);
      assert(Math.abs(canvas.width / (window.devicePixelRatio || 1) - s.w) < 2, '画布宽应与视口一致');
    });

    T('白底与点阵', function () {
      var d = g.getImageData(4, 4, 1, 1).data;
      assert(d[0] === 255 && d[3] === 255, '左上应为白底（避开点阵原点）');
    });

    T('画笔落笔与平滑', function () {
      state.shapes = [];
      var pen = { id: uid(), t: 'pen', color: '#1f2328', size: 4, pts: [] };
      for (var i = 0; i < 40; i++) pen.pts.push({ x: 60 + i * 6, y: 120 + Math.sin(i / 3) * 30 });
      state.shapes.push(pen);
      var b = bbox(pen);
      assert(b.w > 200 && b.h > 50, 'bbox 应覆盖笔迹: ' + Math.round(b.w) + 'x' + Math.round(b.h));
      assert(hit(pen, 120, 120), '笔迹附近应命中');
      assert(!hit(pen, 600, 600), '远处不应命中');
    });

    T('六种图形 bbox', function () {
      var cases = [
        [{ t: 'line', x1: 0, y1: 0, x2: 100, y2: 40 }, 100, 40],
        [{ t: 'arrow', x1: 10, y1: 20, x2: 110, y2: 20 }, 100, 0],
        [{ t: 'rect', x: 5, y: 5, w: 80, h: 50 }, 80, 50],
        [{ t: 'ellipse', x: 0, y: 0, w: 60, h: 30 }, 60, 30],
        [{ t: 'diamond', x: 0, y: 0, w: 40, h: 40 }, 40, 40],
        [{ t: 'note', x: 0, y: 0, w: 168, h: 104 }, 168, 104]
      ];
      cases.forEach(function (c) {
        var b = bbox(c[0]);
        assert(b && Math.abs(b.w - c[1]) < 0.01 && Math.abs(b.h - c[2]) < 0.01,
          c[0].t + ' bbox 错: ' + b.w + 'x' + b.h);
      });
    });

    T('文字与便签可命中', function () {
      var tx = { id: uid(), t: 'text', color: '#1f2328', fs: 22, x: 40, y: 40, text: '白板测试' };
      assert(bbox(tx).w > 40, '文字 bbox 应非空');
      assert(hit(tx, 60, 50), '文字应可命中');
      var nt = { id: uid(), t: 'note', bg: '#fff59d', x: 300, y: 300, w: 168, h: 104, text: '便签内容' };
      assert(hit(nt, 380, 350), '便签内应命中');
      assert(!hit(nt, 100, 100), '便签外不应命中');
    });

    T('撤销 / 重做', function () {
      state.shapes = [];
      state.undo = []; state.redo = [];
      snapshot();
      state.shapes.push({ id: uid(), t: 'rect', color: '#000', size: 4, x: 0, y: 0, w: 20, h: 20 });
      assert(state.shapes.length === 1, '应有 1 个');
      undo();
      assert(state.shapes.length === 0, '撤销后应为 0');
      redo();
      assert(state.shapes.length === 1, '重做后应恢复 1');
      undo();
    });

    T('视图换算往返', function () {
      state.view = { x: 140, y: 90, k: 1.8 };
      var w = toWorld(300, 210);
      var back = { x: w.x * state.view.k + state.view.x, y: w.y * state.view.k + state.view.y };
      assert(Math.abs(back.x - 300) < 1e-6 && Math.abs(back.y - 210) < 1e-6, '往返应回到原点');
      state.view = { x: 0, y: 0, k: 1 };
    });

    T('内容包围盒合并', function () {
      state.shapes = [
        { id: uid(), t: 'rect', color: '#000', size: 2, x: 0, y: 0, w: 100, h: 50 },
        { id: uid(), t: 'rect', color: '#000', size: 2, x: 200, y: 100, w: 100, h: 100 }
      ];
      var b = contentBBox();
      assert(b.x === 0 && b.y === 0 && Math.abs(b.w - 300) < 0.01 && Math.abs(b.h - 200) < 0.01,
        '合并包围盒错: ' + JSON.stringify(b));
    });

    T('导出画布带留白且非空', function () {
      var cv = renderContent(1400);
      assert(cv, '应返回画布');
      var c = cv.getContext('2d');
      var corner = c.getImageData(2, 2, 1, 1).data;
      assert(corner[0] === 255 && corner[1] === 255, '边缘应留白');
      var all = c.getImageData(0, 0, cv.width, cv.height).data;
      var found = false;
      for (var i = 0; i < all.length; i += 4) {
        if (all[i] < 240 || all[i + 1] < 240 || all[i + 2] < 240) { found = true; break; }
      }
      assert(found, '画面里应有内容');
      window.__cv = cv;
    });

    T('zlib 压缩可用', async function () {
      var z = await zlibDeflate(new Uint8Array(1000).fill(7));
      assert(z && z.length > 0, 'FlateDecode 数据应非空');
      assert(z[0] === 0x78, 'zlib 头应以 0x78 开头: ' + z[0].toString(16));
    });

    T('PDF 结构合法', async function () {
      window.__noDownload = true;
      window.__lastDownload = null;
      state.shapes = [
        { id: uid(), t: 'rect', color: '#1971c2', size: 4, x: 100, y: 100, w: 240, h: 140 },
        { id: uid(), t: 'text', color: '#1f2328', fs: 22, x: 120, y: 120, text: 'PDF 导出校验' }
      ];
      await exportPDF();
      var got = window.__lastDownload;
      window.__noDownload = false;
      assert(got && got.blob, '应生成 PDF blob');
      assert(/\.pdf$/.test(got.name), '文件名应以 .pdf 结尾: ' + got.name);
      var buf = new Uint8Array(await got.blob.arrayBuffer());
      var text = new TextDecoder('latin1').decode(buf);
      assert(text.indexOf('%PDF-1.4') === 0, '文件头应为 %PDF-1.4');
      assert(text.indexOf('/Type /Catalog') > 0, '缺少 Catalog');
      assert(text.indexOf('/Subtype /Image') > 0, '缺少图像对象');
      assert(/\/Filter \/(FlateDecode|DCTDecode)/.test(text), '缺少图像滤镜');
      assert(text.trim().endsWith('%%EOF'), '缺少 %%EOF 结尾');
      var m = /startxref\s+(\d+)/.exec(text);
      assert(m, '缺少 startxref');
      assert(text.slice(Number(m[1]), Number(m[1]) + 4) === 'xref', 'startxref 偏移不对: ' + m[1]);
      var xm = /xref\s+0 (\d+)/.exec(text);
      assert(xm && Number(xm[1]) === 6, 'xref 条目数应为 6');
      // 每个 xref 条目指向对应对象
      var body = text.slice(Number(m[1]));
      for (var o = 1; o <= 5; o++) {
        var line = body.split('\n')[2 + o];
        var off = Number(line.slice(0, 10));
        assert(text.slice(off, off + String(o).length + 6).indexOf(o + ' 0 obj') === 0,
          '对象 ' + o + ' 的 xref 偏移不正确');
      }
      assert(/\/MediaBox \[0 0 595\.28 841\.89\]|\/MediaBox \[0 0 841\.89 595\.28\]/.test(text), '应为 A4 页面');
      window.__pdfBytes = buf;
    });

    T('导出 PNG 生成有效文件', async function () {
      window.__noDownload = true;
      window.__lastDownload = null;
      exportPNG();
      await new Promise(function (r) { setTimeout(r, 600); });
      var got = window.__lastDownload;
      window.__noDownload = false;
      assert(got && got.blob, '应生成 PNG blob');
      assert(got.blob.type === 'image/png', '类型应为 image/png，实际: ' + got.blob.type);
      var sig = new Uint8Array(await got.blob.slice(0, 8).arrayBuffer());
      var png = [137, 80, 78, 71, 13, 10, 26, 10];
      assert(png.every(function (v, i) { return sig[i] === v; }), 'PNG 魔数不对');
    });

    T('工具切换与光标', function () {
      setTool('eraser');
      assert(state.tool === 'eraser', '工具应切换');
      assert(document.querySelector('[data-tool="eraser"]').classList.contains('on'), '按钮应高亮');
      setTool('pen');
      assert(document.querySelectorAll('[data-tool].on').length === 1, '只能有一个高亮');
    });

    T('本地存储持久化', function () {
      state.shapes = [{ id: 999, t: 'rect', color: '#000', size: 2, x: 1, y: 2, w: 30, h: 30 }];
      persist();
      return new Promise(function (r) { setTimeout(r, 500); }).then(function () {
        var raw = localStorage.getItem('board.v1');
        assert(raw && raw.indexOf('"t":"rect"') > 0, '应写入 localStorage');
      });
    });

    T('保存状态在界面上可见', function () {
      state.shapes = [{ id: uid(), t: 'rect', color: '#000', size: 2, x: 0, y: 0, w: 10, h: 10 }];
      persist();
      var el = $('save');
      assert(el.textContent.indexOf('保存中') >= 0, '改动后应立即显示「保存中」，实际: ' + el.textContent);
      assert(el.classList.contains('saving'), '应有 saving 状态类');
      return new Promise(function (r) { setTimeout(r, 700); }).then(function () {
        assert(/已存本机 \d\d:\d\d/.test(el.textContent), '落盘后应显示「已存本机 时:分」，实际: ' + el.textContent);
        assert(!el.classList.contains('saving'), 'saving 类应移除');
      });
    });

    T('关页面前强制落盘（不等防抖）', function () {
      localStorage.removeItem('board.v1');
      state.shapes = [{ id: uid(), t: 'ellipse', color: '#1971c2', size: 3, x: 5, y: 5, w: 40, h: 30 }];
      var ok = flushSave();
      assert(ok === true, 'flushSave 应立即返回 true');
      var raw = JSON.parse(localStorage.getItem('board.v1') || 'null');
      assert(raw && raw.shapes && raw.shapes.length === 1, '应立即写入图形');
      assert(raw.savedAt > 0, '应记录保存时间戳');
    });

    T('重新打开时恢复上次内容', function () {
      state.shapes = [];
      var ts = restore();
      assert(state.shapes.length === 1, '应恢复 1 个图形，实际: ' + state.shapes.length);
      assert(state.shapes[0].t === 'ellipse', '恢复的应是刚才的椭圆');
      assert(ts > 0, '应带回上次保存时间');
    });

    (async function () {
      for (var i = 0; i < queue.length; i++) {
        try {
          await queue[i][1]();
          out.push(queue[i][0] + ': PASS');
        } catch (e) {
          out.push(queue[i][0] + ': FAIL ' + e.message);
        }
      }
      var pass = out.filter(function (s) { return s.indexOf('PASS') >= 0; }).length;
      var pre = document.createElement('pre');
      pre.id = 'r';
      pre.style.cssText = 'position:fixed;left:8px;top:8px;z-index:9999;font-size:12px;background:#fff;border:1px solid #ccc;padding:8px;max-height:90vh;overflow:auto';
      pre.textContent = out.join('\n') + '\nRESULTS: ' + pass + '/' + out.length + ' PASS';
      document.body.appendChild(pre);
    })();
  }
})();
