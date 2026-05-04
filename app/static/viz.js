/* =========================================================
   vnp · plan view — fetched from /plans/<name>/plan.json
   ========================================================= */

(() => {
const PLAN_NAME = window.PLAN_NAME;
const URL_PLAN   = `/plans/${encodeURIComponent(PLAN_NAME)}/plan.json`;
const URL_ADD    = `/plans/${encodeURIComponent(PLAN_NAME)}/add`;
const URL_EDIT   = `/plans/${encodeURIComponent(PLAN_NAME)}/edit`;
const URL_DELETE = `/plans/${encodeURIComponent(PLAN_NAME)}/delete`;
const URL_CARVE  = `/plans/${encodeURIComponent(PLAN_NAME)}/commit_carve`;
const URL_IMPORT = `/plans/${encodeURIComponent(PLAN_NAME)}/import_infoblox`;

//==========================================================
//  Pure CIDR helpers (mirror app/planning.py shape)
//==========================================================
const ipToInt = (ip) => ip.split('.').map(Number).reduce((a,o)=>(a<<8>>>0)+o,0)>>>0;
const intToIp = (n) => [(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255].join('.');
function cidrInfo(cidr) {
  const [ip, p] = cidr.split('/');
  const prefix = +p;
  const start = ipToInt(ip);
  const size  = Math.pow(2, 32 - prefix);
  return { cidr, ip, prefix, start, size, end: start + size };
}
function isSubnetOf(a, b) {
  const A = cidrInfo(a), B = cidrInfo(b);
  return A.start >= B.start && A.end <= B.end && A.size <= B.size;
}
function fmtBytes(n) {
  if (n >= 1<<20) return `${(n / (1<<20)).toFixed(1)}M`;
  if (n >= 1<<10) return `${(n / (1<<10)).toFixed(1)}K`;
  return `${n}`;
}

//==========================================================
//  Build hierarchy + free space (client-side, for shape parity)
//==========================================================
function buildTree(plan) {
  const items = [
    ...(plan.supernets    || []).map(s => ({...s, kind:'supernet'})),
    ...(plan.allocations  || []).map(a => ({...a, kind:'allocation'})),
    ...(plan.reservations || []).map(r => ({...r, kind:'reservation'})),
  ].map(x => ({ ...x, ...cidrInfo(x.cidr), children: [], free: [] }));
  items.sort((a,b) => a.size === b.size ? a.start - b.start : b.size - a.size);

  const roots = [];
  for (const it of items) {
    let parent = null;
    for (const cand of items) {
      if (cand === it) continue;
      if (it.start >= cand.start && it.end <= cand.end && it.size < cand.size) {
        if (!parent || cand.size < parent.size) parent = cand;
      }
    }
    if (parent) {
      parent.children.push(it);
      it._parent = parent;   // upward backref for tag inheritance lookups
    } else if (it.kind === 'supernet') {
      roots.push(it);
    } else {
      it.orphan = true;
      roots.push(it);
    }
  }
  for (const it of items) computeFree(it);
  for (const it of items) it.children.sort((a,b)=>a.start-b.start);
  return { roots, items };
}
function computeFree(parent) {
  // A leaf allocation or reservation is fully consumed by itself — its
  // interior isn't "free space available for carving." Without this guard,
  // computeFree would return [parent] which then gets drawn as a hatched
  // is-free rect on top of the allocation's body, visually erasing it.
  if (parent.kind !== 'supernet' && parent.children.length === 0) {
    parent.free = [];
    return;
  }
  let ranges = [{start: parent.start, size: parent.size}];
  const kids = parent.children.slice().sort((a,b)=>a.start-b.start);
  for (const k of kids) {
    const next = [];
    for (const r of ranges) {
      if (k.start >= r.start + r.size || k.start + k.size <= r.start) {
        next.push(r); continue;
      }
      const left = { start: r.start, size: k.start - r.start };
      const rightStart = k.start + k.size;
      const right = { start: rightStart, size: (r.start + r.size) - rightStart };
      for (const sub of [left, right]) {
        if (sub.size <= 0) continue;
        decomposeAligned(sub.start, sub.size).forEach(c => next.push(c));
      }
    }
    ranges = next;
  }
  parent.free = ranges
    .filter(r => r.size > 0)
    .map(r => `${intToIp(r.start)}/${32 - Math.log2(r.size)}`);
}
function decomposeAligned(start, size) {
  const out = [];
  let s = start, remaining = size;
  while (remaining > 0) {
    const align = s === 0 ? 32 : Math.min(32 - Math.log2(remaining), trailingZeros(s) || 32);
    const blockSize = Math.pow(2, Math.min(31, align));
    const finalSize = Math.min(blockSize, remaining);
    const fs = Math.pow(2, Math.floor(Math.log2(finalSize)));
    out.push({ start: s, size: fs });
    s += fs; remaining -= fs;
  }
  return out;
}
function trailingZeros(n) {
  if (n === 0) return 32;
  let c = 0;
  while ((n & 1) === 0) { n >>>= 1; c++; }
  return c;
}
function totalAddresses(node) { return node.size; }
function usedAddresses(node) {
  if (!node.children.length) return node.kind === 'supernet' ? 0 : node.size;
  let used = 0;
  for (const c of node.children) used += c.size;
  return used;
}

// A node's "effective" tags = its own tags + every ancestor's tags, with
// duplicates removed. Order is innermost-first so the node's own tags win
// when something downstream picks a "primary" tag (e.g. for viz coloring).
function effectiveTags(node) {
  const seen = new Set();
  const out = [];
  let n = node;
  while (n) {
    for (const t of (n.tags || [])) {
      if (!seen.has(t)) { seen.add(t); out.push(t); }
    }
    n = n._parent;
  }
  return out;
}
function inheritedTags(node) {
  const own = new Set(node.tags || []);
  return effectiveTags(node).filter(t => !own.has(t));
}

//==========================================================
//  Tag color hashing
//==========================================================
const TAG_HUES = {};
function tagColor(tag) {
  if (TAG_HUES[tag]) return TAG_HUES[tag];
  let h = 0;
  for (let i=0; i<tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const c = `oklch(0.66 0.13 ${hue})`;
  TAG_HUES[tag] = c;
  return c;
}
function primaryTagColor(tags) {
  if (!tags || !tags.length) return getCss('--used');
  const skip = new Set(['Cloud','CDE Subnet']);
  const t = tags.find(x => !skip.has(x)) || tags[0];
  return tagColor(t);
}
function getCss(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }

//==========================================================
//  State + server fetch
//==========================================================
let PLAN = { name: PLAN_NAME, supernets: [], allocations: [], reservations: [] };
let SERVER = { conflicts: [], orphans: [] };
let TREE = { roots: [], items: [] };
const STATE = {
  selectedCidr: null,
  hoveredCidr:  null,
  colorMode:    'state',
  zoom:         'all',
  proposals:    [],
  tab:          'add',
  search:       '',
  tagFilter:    null,
  detailCidr:   null,
};
const SELECTED_PARENTS = new Set();

async function fetchPlan() {
  try {
    const r = await fetch(URL_PLAN, {
      headers: { 'Accept': 'application/json' },
      cache: 'no-store',  // disk cache served stale data after a commit
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    PLAN = {
      name: data.name,
      supernets: data.supernets || [],
      allocations: data.allocations || [],
      reservations: data.reservations || [],
    };
    SERVER = { conflicts: data.conflicts || [], orphans: data.orphans || [] };
    TREE = buildTree(PLAN);
  } catch (e) {
    toast(`failed to load plan: ${e}`, 'err');
  }
}

async function refresh() {
  await fetchPlan();
  populateParentTagFilter();   // tag list depends on plan data
  populateParents();
  renderTree();
  renderViz();
  renderProposals();           // STATE.proposals may have been cleared mid-flow
  updateLegend();
  refreshBanners();
  updateBreadcrumbs();
}

//==========================================================
//  Search / matching / copy
//==========================================================
function norm(s) { return (s||'').toLowerCase(); }
function nodeMatches(node, q) {
  if (!q) return { self: false, descendant: false };
  const ql = q.toLowerCase();
  // Effective tags include inherited ones, so searching "prod" finds every
  // child of a "prod"-tagged supernet, not just the supernet itself.
  const self = norm(node.cidr).includes(ql)
            || norm(node.name).includes(ql)
            || effectiveTags(node).some(t => norm(t).includes(ql))
            || norm(node.description).includes(ql);
  let descendant = false;
  for (const c of (node.children||[])) {
    const m = nodeMatches(c, q);
    if (m.self || m.descendant) { descendant = true; break; }
  }
  return { self, descendant };
}
function nodePassesTag(node, tag) {
  if (!tag) return true;
  if (effectiveTags(node).includes(tag)) return true;
  return (node.children||[]).some(c => nodePassesTag(c, tag));
}
function highlightMatch(text, q) {
  if (!text) return '';
  const safe = String(text).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  if (!q) return safe;
  const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + ')', 'ig');
  return safe.replace(re, '<mark>$1</mark>');
}
function copyText(t, successMsg) {
  // For long/multi-line copies (e.g. "copy all" of carve proposals), pass
  // a short successMsg so the toast doesn't echo the whole pasted blob.
  const okMsg = successMsg || `copied: ${t}`;
  const fallback = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      toast(ok ? okMsg : 'clipboard blocked', ok ? 'ok' : 'err');
    } catch { toast('clipboard blocked', 'err'); }
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(t).then(
      () => toast(okMsg, 'ok'),
      fallback
    );
  } else fallback();
}
let __toastTimer;
function toast(msg, kind='ok') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast on ' + kind;
  clearTimeout(__toastTimer);
  __toastTimer = setTimeout(() => el.classList.remove('on'), 1800);
}
function nodeOf(cidr) { return TREE.items.find(i => i.cidr === cidr); }
function parentOf(cidr) {
  for (const it of TREE.items) {
    if ((it.children||[]).some(c => c.cidr === cidr)) return it;
  }
  return null;
}

// Hovering a tree row should glow the matching viz block. Listeners go on
// `.row` (not the outer `.node`) so a child row's hover doesn't keep its
// parent highlighted.
function bindTreeHoverHighlight(rowEl, cidr) {
  rowEl.addEventListener('mouseenter', () => {
    const block = document.querySelector(`#viz [data-cidr="${CSS.escape(cidr)}"]`);
    if (block) block.classList.add('hover');
  });
  rowEl.addEventListener('mouseleave', () => {
    const block = document.querySelector(`#viz [data-cidr="${CSS.escape(cidr)}"]`);
    if (block) block.classList.remove('hover');
  });
}

//==========================================================
//  Render tree (sidebar)
//==========================================================
const treeEl = document.getElementById('tree');
function renderTree() {
  treeEl.innerHTML = '';
  let count = 0;
  for (const root of TREE.roots) {
    treeEl.appendChild(renderNode(root, true));
    count += countNodes(root);
  }
  document.getElementById('treeCount').textContent = `${count} nodes`;
}
function countNodes(n) { return 1 + (n.children||[]).reduce((a,c)=>a+countNodes(c),0); }
function renderNode(node, isRoot) {
  const el = document.createElement('div');
  el.className = 'node'
    + (node.kind === 'supernet'    ? ' is-supernet'    : '')
    + (node.kind === 'reservation' ? ' is-reservation' : '');
  el.dataset.cidr = node.cidr;
  el.dataset.collapsed = 'false';
  el.dataset.leaf = node.children.length === 0 && (node.free||[]).length === 0 ? 'true' : 'false';
  if (STATE.selectedCidr === node.cidr) el.classList.add('selected');

  const matches = nodeMatches(node, STATE.search);
  if (STATE.search) {
    if (matches.self) el.classList.add('match');
    if (!matches.self && !matches.descendant) el.classList.add('hidden');
  }

  const used = usedAddresses(node);
  const total = totalAddresses(node);
  const pct = total > 0 ? Math.round(100 * used / total) : 0;
  const pctLabel = node.kind === 'reservation' ? 'reserved' : `${pct}%`;

  const row = document.createElement('div');
  row.className = 'row';
  const matchedName = highlightMatch(node.name || '', STATE.search);
  const matchedCidr = highlightMatch(node.cidr, STATE.search);
  row.innerHTML = `
    <span class="twist"></span>
    <span style="display:flex; align-items:center; min-width:0; gap:0;">
      <span class="cidr copyable" data-copy="${node.cidr}" title="Click to copy">${matchedCidr}</span>
      <span class="name">${matchedName}</span>
    </span>
    <span class="actions-tn">
      <button data-act="del" title="Delete">×</button>
    </span>
    <span class="pct">${pctLabel}</span>
  `;
  row.addEventListener('click', (e) => {
    if (e.target.closest('.twist')) {
      el.dataset.collapsed = el.dataset.collapsed === 'true' ? 'false' : 'true';
      e.stopPropagation();
      return;
    }
    if (e.target.closest('[data-copy]')) {
      e.stopPropagation();
      copyText(e.target.closest('[data-copy]').dataset.copy);
      return;
    }
    if (e.target.closest('[data-act="del"]')) {
      e.stopPropagation();
      requestDelete(node.cidr);
      return;
    }
    selectCidr(node.cidr);
    openDetail(node.cidr);
  });
  bindTreeHoverHighlight(row, node.cidr);
  el.appendChild(row);

  if (node.children.length || (node.free||[]).length) {
    const kids = document.createElement('div');
    kids.className = 'children';
    for (const c of node.children) kids.appendChild(renderNode(c, false));
    for (const f of (node.free || [])) {
      const fi = cidrInfo(f);
      const fe = document.createElement('div');
      fe.className = 'node is-free';
      fe.dataset.cidr = f;
      fe.dataset.leaf = 'true';
      fe.innerHTML = `
        <div class="row">
          <span class="twist"></span>
          <span style="display:flex; align-items:center;">
            <span class="cidr">${f}</span>
            <span class="name">free · ${fmtBytes(fi.size)} addrs</span>
          </span>
          <span class="pct" style="color:var(--acc); border-color:color-mix(in oklab, var(--acc), transparent 70%);">free</span>
        </div>
      `;
      fe.addEventListener('click', () => {
        selectCidr(f);
        switchTab('carve');
        document.getElementById('carveValue').value = fi.prefix + 1;
        runPreview(f, node.cidr);
      });
      bindTreeHoverHighlight(fe.querySelector('.row'), f);
      kids.appendChild(fe);
    }
    el.appendChild(kids);
  }
  return el;
}

//==========================================================
//  Render viz (D3)
//==========================================================
const vizEl = document.getElementById('viz');
const vizWrap = document.getElementById('vizWrap');
function renderViz() {
  // Preserve scroll position across the rebuild. Clearing innerHTML briefly
  // collapses the scroll container's content, which causes the browser to
  // clamp scrollTop down — without the snapshot/restore, every render would
  // jump back to the top.
  const savedScroll = vizWrap ? vizWrap.scrollTop : 0;
  vizEl.innerHTML = '';
  const supers = TREE.roots.filter(r => r.kind === 'supernet');

  if (!supers.length) {
    vizEl.innerHTML = `
      <div class="empty">
        <div class="glyph-big">${'<i></i>'.repeat(16)}</div>
        <h2>no supernets yet</h2>
        <p>Add a top-level supernet — a /16, /20, whatever you control — and you'll see it carved into bytes here. Allocations live inside.</p>
        <div style="display:flex; gap:8px;">
          <button class="btn primary" id="emptyAdd">+ add supernet</button>
          <button class="btn ghost" id="emptyImport">↥ import csv</button>
        </div>
        <div class="empty-hints">
          <span><kbd>/</kbd> search</span>
          <span><kbd>c</kbd> carve</span>
          <span><kbd>t</kbd> theme</span>
        </div>
      </div>
    `;
    document.getElementById('emptyAdd')?.addEventListener('click', () => switchTab('add'));
    document.getElementById('emptyImport')?.addEventListener('click', () => switchTab('import'));
    return;
  }

  const focus = STATE.zoom === 'focus' && STATE.selectedCidr;
  const targets = focus
    ? supers.filter(s => isSubnetOf(STATE.selectedCidr, s.cidr) || s.cidr === STATE.selectedCidr || isSubnetOf(s.cidr, STATE.selectedCidr))
    : supers;

  for (const root of targets) {
    const wrap = document.createElement('div');
    wrap.className = 'viz-supernet';

    const used = usedAddresses(root);
    const total = totalAddresses(root);
    const pct = total > 0 ? Math.round(100 * used / total) : 0;

    const cap = document.createElement('div');
    cap.className = 'cap';
    cap.innerHTML = `
      <div class="lhs">
        <span class="cidr">${root.cidr}</span>
        <span class="label">${root.name || ''}</span>
      </div>
      <div class="rhs">
        <span>${fmtBytes(used)} / ${fmtBytes(total)}</span>
        <div class="density-bar"><div class="fill" style="width:${pct}%"></div></div>
        <span style="color:${pct>80?'var(--warn)':'var(--fg-1)'}; font-weight:500;">${pct}%</span>
      </div>
    `;
    wrap.appendChild(cap);

    const baseHeight = focus ? 220 : 140;
    const depthBoost = maxDepth(root) * 24;
    const height = Math.max(baseHeight, baseHeight + depthBoost);
    const width = vizEl.clientWidth - 48;

    const svg = d3.select(wrap).append('svg')
      .attr('class', 'viz-svg')
      .attr('viewBox', `0 0 ${width} ${height}`)
      .attr('preserveAspectRatio', 'none')
      .style('height', height + 'px');

    drawNode(svg, root, 0, 0, width, height, 0, root);
    drawProposalOverlays(svg, root, 0, 0, width, height);
    vizEl.appendChild(wrap);
  }

  if (!targets.length) {
    vizEl.innerHTML = '<div style="padding:48px; text-align:center; color:var(--fg-3); font-family:JetBrains Mono,monospace; font-size:12px;">no supernets in scope</div>';
  }

  // Restore scroll synchronously — by this point all wraps are appended so
  // scrollHeight has grown back to its full value and the assignment isn't
  // clamped. The browser doesn't paint between this and the earlier DOM
  // mutations, so there's no visible flicker.
  if (vizWrap) vizWrap.scrollTop = savedScroll;
}

function maxDepth(n) {
  if (!n.children.length) return 1;
  return 1 + Math.max(...n.children.map(maxDepth));
}

function drawNode(svg, node, x, y, w, h, depth, supernetRoot) {
  const padTop = depth === 0 ? 22 : 16;
  const pad = 2;
  const innerY = y + padTop;
  const innerH = Math.max(0, h - padTop - pad);

  const dimByFilter = (STATE.tagFilter && !nodePassesTag(node, STATE.tagFilter))
                   || (STATE.search && !(nodeMatches(node, STATE.search).self || nodeMatches(node, STATE.search).descendant));
  const inConflict = SERVER.conflicts.some(([a,b]) => a === node.cidr || b === node.cidr);
  const g = svg.append('g').attr('class', 'viz-block' +
    (node.kind === 'supernet'    ? ' is-supernet'    : '') +
    (node.kind === 'reservation' ? ' is-reservation' : '') +
    (STATE.selectedCidr === node.cidr ? ' selected' : '') +
    (inConflict ? ' conflict' : '') +
    (dimByFilter ? ' dim' :
     (STATE.selectedCidr && STATE.selectedCidr !== node.cidr && !isSubnetOf(node.cidr, STATE.selectedCidr) && !isSubnetOf(STATE.selectedCidr, node.cidr) ? ' dim' : '')));
  g.attr('data-cidr', node.cidr);

  const fill = node.kind === 'supernet'    ? getCss('--supernet')
            : node.kind === 'reservation' ? getCss('--bg-3')
            : STATE.colorMode === 'tag'   ? primaryTagColor(effectiveTags(node))
            : STATE.colorMode === 'util'  ? utilColor(node)
            :                               getCss('--used');

  g.append('rect')
    .attr('class', 'body')
    .attr('x', x + pad).attr('y', y + pad)
    .attr('width', Math.max(0, w - 2*pad))
    .attr('height', Math.max(0, h - 2*pad))
    .attr('rx', 3)
    .attr('fill', fill)
    .attr('stroke', node.kind === 'supernet' ? getCss('--line') : 'rgba(0,0,0,0.2)')
    .attr('stroke-width', 1);

  if (w > 60) {
    g.append('text')
      .attr('x', x + 8).attr('y', y + 14)
      .attr('font-weight', '600')
      .text(node.cidr);
    if (w > 180 && node.name) {
      g.append('text')
        .attr('x', x + 8).attr('y', y + 14)
        .attr('text-anchor', 'start')
        .attr('font-weight', '400')
        .attr('opacity', 0.75)
        .attr('dx', cidrLen(node.cidr) + 12)
        .text(node.name.length > 28 ? node.name.slice(0, 26) + '…' : node.name);
    }
  }

  bindHover(g.node(), node);

  if (innerH < 12 || w < 40) return;

  const pieces = [];
  for (const c of node.children) pieces.push({ kind: 'child', node: c, ...cidrInfo(c.cidr) });
  for (const f of (node.free || [])) pieces.push({ kind: 'free', cidr: f, ...cidrInfo(f) });
  pieces.sort((a,b)=>a.start-b.start);

  const innerX = x + pad;
  const innerW = Math.max(0, w - 2 * pad);
  const parentInfo = cidrInfo(node.cidr);
  const scale = innerW / parentInfo.size;

  // Minimum visible width for non-free blocks. A /28 inside a /16 is 1/4096
  // of the parent's width — about 0.24 px at 1000 px wide, i.e. invisible.
  // Force allocations and reservations to render at least this wide, and
  // shrink free pieces proportionally to compensate. Free pieces have no
  // floor; a tiny gap can collapse to zero.
  const MIN_BLOCK_PX = 6;
  const naturalPw = pieces.map(p => p.size * scale);
  let allocDeficit = 0;   // px we owe to undersized non-free pieces
  let freeTotal = 0;      // px currently allocated to free pieces (donor pool)
  for (let i = 0; i < pieces.length; i++) {
    if (pieces[i].kind === 'free') {
      freeTotal += naturalPw[i];
    } else if (naturalPw[i] < MIN_BLOCK_PX) {
      allocDeficit += (MIN_BLOCK_PX - naturalPw[i]);
    }
  }
  const freeShrink = freeTotal > 0
    ? Math.max(0, (freeTotal - allocDeficit) / freeTotal)
    : 1;

  let cursor = innerX;
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    const pw = (p.kind === 'free')
      ? naturalPw[i] * freeShrink
      : Math.max(naturalPw[i], MIN_BLOCK_PX);
    const px = cursor;
    cursor += pw;

    if (p.kind === 'free') {
      const fg = svg.append('g')
        .attr('class', 'viz-block is-free' +
          (STATE.proposals && STATE.proposals.some(pp => pp.cidr === p.cidr) ? ' proposed' : '') +
          (STATE.selectedCidr === p.cidr ? ' selected' : ''))
        .attr('data-cidr', p.cidr);
      fg.append('rect')
        .attr('class', 'body')
        .attr('x', px).attr('y', innerY)
        .attr('width', Math.max(0, pw - pad))
        .attr('height', innerH)
        .attr('rx', 2);
      if (pw > 50) {
        fg.append('text')
          .attr('class', 'dark')
          .attr('x', px + 5).attr('y', innerY + 13)
          .attr('opacity', 0.7)
          .text(p.cidr);
      }
      bindHoverFree(fg.node(), p, node);
    } else {
      drawNode(svg, p.node, px, innerY, pw, innerH, depth + 1, supernetRoot);
    }
  }
}

function drawProposalOverlays(svg, root, x, y, w, h) {
  if (!STATE.proposals || !STATE.proposals.length) return;
  const rootInfo = cidrInfo(root.cidr);
  for (const p of STATE.proposals) {
    if (!p.cidr) continue;
    const pi = cidrInfo(p.cidr);
    if (pi.start < rootInfo.start || pi.end > rootInfo.end) continue;
    let host = root, hostX = x, hostY = y, hostW = w, hostH = h;
    outer: while (true) {
      for (const c of host.children) {
        const ci = cidrInfo(c.cidr);
        if (pi.start >= ci.start && pi.end <= ci.end) {
          const padTop = (host === root) ? 22 : 16;
          const pad = 2;
          const innerY = hostY + padTop;
          const innerH = Math.max(0, hostH - padTop - pad);
          const innerX = hostX + pad;
          const innerW = Math.max(0, hostW - 2 * pad);
          const hostInfo = cidrInfo(host.cidr);
          const scale = innerW / hostInfo.size;
          const cx = innerX + (ci.start - hostInfo.start) * scale;
          const cw = ci.size * scale;
          host = c; hostX = cx; hostY = innerY; hostW = cw; hostH = innerH;
          continue outer;
        }
      }
      break;
    }
    const padTop = (host === root) ? 22 : 16;
    const pad = 2;
    const innerY = hostY + padTop;
    const innerH = Math.max(0, hostH - padTop - pad);
    const innerX = hostX + pad;
    const innerW = Math.max(0, hostW - 2 * pad);
    const hostInfo = cidrInfo(host.cidr);
    const scale = innerW / hostInfo.size;
    const px = innerX + (pi.start - hostInfo.start) * scale;
    // Mirror the min-width treatment in drawNode so tiny proposed carves
    // (e.g. /28 in a /16) remain visible during preview.
    const pw = Math.max(pi.size * scale, 6);

    const og = svg.append('g').attr('class', 'viz-block proposed').attr('data-cidr', p.cidr);
    og.append('rect')
      .attr('class', 'body')
      .attr('x', px).attr('y', innerY)
      .attr('width', Math.max(0, pw - pad))
      .attr('height', innerH)
      .attr('rx', 2);
    if (pw > 50) {
      og.append('text')
        .attr('x', px + 5).attr('y', innerY + 13)
        .attr('fill', getCss('--acc'))
        .attr('font-weight', '600')
        .text('▸ ' + p.cidr);
    }
  }
}

function utilColor(node) {
  const used = usedAddresses(node), total = totalAddresses(node);
  const pct = total > 0 ? used/total : 0;
  const hue = 165 - pct * 130;
  return `oklch(0.66 0.13 ${hue})`;
}
function cidrLen(c) { return c.length * 6.6; }

//==========================================================
//  Selection + tooltips
//==========================================================
function selectCidr(cidr) {
  STATE.selectedCidr = cidr;
  document.getElementById('statSel').textContent = `sel: ${cidr}`;
  renderTree();
  renderViz();
  const treeNode = treeEl.querySelector(`.node[data-cidr="${CSS.escape(cidr)}"]`);
  if (treeNode) treeNode.scrollIntoView({block:'nearest'});
}

const tooltip = document.getElementById('tooltip');
function bindHover(el, node) {
  el.addEventListener('mouseenter', (e) => {
    el.classList.add('hover');
    showTooltip(e, tooltipForNode(node));
  });
  el.addEventListener('mousemove', (e) => positionTooltip(e));
  el.addEventListener('mouseleave', () => {
    el.classList.remove('hover');
    hideTooltip();
  });
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    selectCidr(node.cidr);
    openDetail(node.cidr);   // mirror tree-row click: open the editor too
  });
}
function bindHoverFree(el, p, parent) {
  el.addEventListener('mouseenter', (e) => {
    el.classList.add('hover');
    showTooltip(e, tooltipForFree(p, parent));
  });
  el.addEventListener('mousemove', positionTooltip);
  el.addEventListener('mouseleave', () => { el.classList.remove('hover'); hideTooltip(); });
  el.addEventListener('click', () => {
    selectCidr(p.cidr);
    switchTab('carve');
    document.getElementById('carveValue').value = p.prefix + 1;
    runPreview(p.cidr, parent.cidr);
  });
}
function tooltipForNode(node) {
  const used = usedAddresses(node), total = totalAddresses(node);
  const pct = total > 0 ? Math.round(100 * used / total) : 0;
  const ownSet = new Set(node.tags || []);
  const ownChips = (node.tags || []).map(t =>
    `<span class="tag clickable" data-tag="${t}" title="Click to filter by ${t}"><span class="dot" style="background:${tagColor(t)}"></span>${t}</span>`
  ).join('');
  const inheritedChips = inheritedTags(node).map(t =>
    `<span class="tag clickable inherited" data-tag="${t}" title="Inherited from a parent · click to filter"><span class="dot" style="background:${tagColor(t)}"></span>${t}</span>`
  ).join('');
  const tagBlock = (ownChips || inheritedChips)
    ? `<div class="tip-tags">${ownChips}${inheritedChips}</div>`
    : '';
  const usedRow = node.kind === 'reservation'
    ? `<span class="k">status</span><span class="v" style="color:var(--warn)">reserved · excluded from carve</span>`
    : `<span class="k">used</span><span class="v">${fmtBytes(used)} (${pct}%)</span>`;
  return `
    <div class="tip-cidr"${node.kind==='reservation' ? ' style="color:var(--warn)"' : ''}>${node.cidr}</div>
    <div class="tip-name">${node.name || '<i style="color:var(--fg-3)">unnamed</i>'}</div>
    <div class="tip-grid">
      <span class="k">type</span><span class="v">${node.kind}</span>
      <span class="k">size</span><span class="v">${fmtBytes(total)} addrs (/${node.prefix})</span>
      ${usedRow}
      <span class="k">range</span><span class="v">${intToIp(node.start)} – ${intToIp(node.end - 1)}</span>
      ${node.description ? `<span class="k">desc</span><span class="v" style="text-align:right; color:var(--fg-2)">${node.description}</span>` : ''}
    </div>
    ${tagBlock}
  `;
}
function tooltipForFree(p, parent) {
  return `
    <div class="tip-cidr" style="color:var(--fg)">${p.cidr}</div>
    <div class="tip-name" style="color:var(--acc)">free slot</div>
    <div class="tip-grid">
      <span class="k">in</span><span class="v">${parent.cidr}</span>
      <span class="k">size</span><span class="v">${fmtBytes(p.size)} addrs (/${p.prefix})</span>
      <span class="k">range</span><span class="v">${intToIp(p.start)} – ${intToIp(p.end - 1)}</span>
    </div>
    <div style="margin-top:8px; padding-top:8px; border-top:1px dashed var(--line); font-size:11px; color:var(--fg-2);">
      <span style="color:var(--acc)">→</span> click to carve here
    </div>
  `;
}
function showTooltip(e, html) {
  tooltip.innerHTML = html;
  tooltip.classList.add('on');
  positionTooltip(e);
}
function positionTooltip(e) {
  const x = e.clientX, y = e.clientY;
  const r = tooltip.getBoundingClientRect();
  let nx = x + 14, ny = y + 14;
  if (nx + r.width > window.innerWidth - 8) nx = x - r.width - 14;
  if (ny + r.height > window.innerHeight - 8) ny = y - r.height - 14;
  tooltip.style.left = nx + 'px';
  tooltip.style.top = ny + 'px';
}
function hideTooltip() { tooltip.classList.remove('on'); }

//==========================================================
//  Carve: multi-parent preview + commit
//==========================================================
function eligibleParents() {
  // Reservations are explicitly excluded from carving — that's the whole point.
  return TREE.items.filter(i =>
    i.kind !== 'reservation' && (
      ((i.kind === 'supernet' || i.children.length > 0) && (i.free || []).length > 0)
      || (i.kind === 'supernet' && i.children.length === 0)
    )
  );
}

// tag-name -> group letter ('A' | 'B' | 'C'). Tags not in this map are
// ignored by the filter (= chip is "off"). Within a group: OR.
// Across groups: AND. Three groups covers env + AZ + one extra facet.
const PARENT_TAG_GROUPS = new Map();
let CURRENT_GROUP = 'A';

function tagsByGroup() {
  const out = { A: [], B: [], C: [] };
  for (const [tag, g] of PARENT_TAG_GROUPS) out[g].push(tag);
  return out;
}

function filteredEligibleParents() {
  const all = eligibleParents();
  if (PARENT_TAG_GROUPS.size === 0) return all;
  const groups = tagsByGroup();
  // Keep only non-empty groups; each must have at least one match (OR
  // within a group). All non-empty groups must be satisfied (AND across).
  // Tag matching uses *effective* tags so a child inherits its parent's
  // tags — e.g. an allocation under a supernet tagged "prod" is itself
  // matched by group { "prod" }.
  const required = Object.values(groups).filter(g => g.length > 0);
  return all.filter(it => {
    const have = new Set(effectiveTags(it));
    return required.every(g => g.some(t => have.has(t)));
  });
}

function populateParentTagFilter() {
  const filterEl = document.getElementById('parentTagFilter');
  const fieldEl  = document.getElementById('parentTagFilterField');
  // Collect every distinct tag across all eligible parents (not just visible).
  const tags = new Set();
  for (const it of eligibleParents()) for (const t of (it.tags || [])) tags.add(t);

  if (tags.size === 0) {
    fieldEl.style.display = 'none';
    PARENT_TAG_GROUPS.clear();
    return;
  }
  // Drop assignments for tags that no longer exist (e.g., after a delete).
  for (const t of [...PARENT_TAG_GROUPS.keys()]) if (!tags.has(t)) PARENT_TAG_GROUPS.delete(t);

  fieldEl.style.display = '';
  filterEl.innerHTML = '';

  for (const t of [...tags].sort((a, b) => a.localeCompare(b))) {
    const grp = PARENT_TAG_GROUPS.get(t);
    const chip = document.createElement('span');
    chip.className = 'tag clickable' + (grp ? ` in-group-${grp.toLowerCase()}` : '');
    chip.innerHTML = grp
      ? `${escapeHtml(t)}<span class="gbadge">${grp}</span>`
      : escapeHtml(t);
    chip.title = grp
      ? `In group ${grp}. Click to remove from group ${grp}, or switch the active group first to move it.`
      : `Click to add to group ${CURRENT_GROUP}.`;
    chip.addEventListener('click', () => {
      const cur = PARENT_TAG_GROUPS.get(t);
      if (cur === CURRENT_GROUP) {
        PARENT_TAG_GROUPS.delete(t);                // already here → remove
      } else {
        PARENT_TAG_GROUPS.set(t, CURRENT_GROUP);    // assign or move into active group
      }
      populateParentTagFilter();
      populateParents();
    });
    filterEl.appendChild(chip);
  }
  if (PARENT_TAG_GROUPS.size > 0) {
    const clear = document.createElement('span');
    clear.className = 'tag clickable clear';
    clear.textContent = '× clear';
    clear.addEventListener('click', () => {
      PARENT_TAG_GROUPS.clear();
      populateParentTagFilter();
      populateParents();
    });
    filterEl.appendChild(clear);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
}

// Render a /prefix CIDR's mask as dotted-quad — Infoblox CSV exports use
// "255.255.255.240" rather than "/28", and we want our exports to look
// like real exports.
function cidrToDottedNetmask(cidr) {
  const prefix = +cidr.split('/')[1];
  const mask = prefix === 0 ? 0 : ((~0 << (32 - prefix)) >>> 0);
  return [(mask>>>24)&255, (mask>>>16)&255, (mask>>>8)&255, mask&255].join('.');
}

// Quote a CSV field if it contains commas, quotes, or newlines (RFC 4180).
function csvField(v) {
  const s = (v === null || v === undefined) ? '' : String(v);
  return /[,"\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
}

// Produce CSV in the same shape vnp's import accepts (see
// docs/infoblox-csv-schema.md). Reservations are vnp-only and don't have
// an Infoblox counterpart; callers can pass them but they're emitted as
// a comment-prefixed networkcontainer block isn't a real Infoblox concept,
// so we drop them and the caller surfaces a hint to the user.
function formatInfobloxCsv({ supernets = [], allocations = [] }) {
  const sections = [];
  const COLUMNS = 'address*,netmask*,comment,EA-Network Name,EA-TAGS';
  const row = (kind, rec) => {
    const addr = rec.cidr.split('/')[0];
    const mask = cidrToDottedNetmask(rec.cidr);
    const tags = (rec.tags || []).join(',');
    return [
      kind,
      csvField(addr),
      csvField(mask),
      csvField(rec.description || ''),
      csvField(rec.name || ''),
      csvField(tags),
    ].join(',');
  };
  if (supernets.length) {
    sections.push(['header-networkcontainer,' + COLUMNS,
                   ...supernets.map(s => row('networkcontainer', s))].join('\n'));
  }
  if (allocations.length) {
    sections.push(['header-network,' + COLUMNS,
                   ...allocations.map(a => row('network', a))].join('\n'));
  }
  // Blank line between header blocks; trailing newline so the file ends cleanly.
  return sections.join('\n\n') + '\n';
}

function populateParents() {
  const wrap = document.getElementById('parentPicker');
  wrap.innerHTML = '';

  // Drop selections that are no longer eligible at all (regardless of filter).
  // Filtered-out-but-still-eligible selections persist so toggling the filter
  // doesn't silently deselect the user's choices.
  const allEligibleCidrs = new Set(eligibleParents().map(i => i.cidr));
  for (const c of [...SELECTED_PARENTS]) if (!allEligibleCidrs.has(c)) SELECTED_PARENTS.delete(c);

  const items = filteredEligibleParents();
  for (const it of items) {
    const totalFree = (it.free || []).reduce((a, c) => a + cidrInfo(c).size, 0);
    const row = document.createElement('div');
    row.className = 'pp-row'
      + (it.kind === 'supernet' ? ' is-supernet' : '')
      + (SELECTED_PARENTS.has(it.cidr) ? ' checked' : '');
    // Native browser tooltip: full name, description (if any), and tag list
    // — own tags first, then inherited tags marked with a "↑" prefix so the
    // distinction is visible.
    const titleParts = [it.cidr];
    if (it.name) titleParts.push('— ' + it.name);
    let title = titleParts.join(' ');
    if (it.description) title += '\n' + it.description;
    if ((it.tags || []).length) title += '\nTags: ' + it.tags.join(', ');
    const inh = inheritedTags(it);
    if (inh.length) title += '\nInherited: ' + inh.join(', ');
    row.title = title;
    row.innerHTML = `
      <span class="cb"></span>
      <span style="display:flex; min-width:0; align-items:center;">
        <span class="cidr">${it.cidr}</span>
        <span class="name">${it.name || ''}</span>
      </span>
      <span class="free-pill">${fmtBytes(totalFree)} free</span>
    `;
    row.addEventListener('click', () => {
      if (SELECTED_PARENTS.has(it.cidr)) SELECTED_PARENTS.delete(it.cidr);
      else SELECTED_PARENTS.add(it.cidr);
      row.classList.toggle('checked');
      updateParentCount();
    });
    wrap.appendChild(row);
  }
  updateParentCount();
}
function updateParentCount() {
  const total = eligibleParents().length;
  const visible = filteredEligibleParents().length;
  document.getElementById('parentCount').textContent = SELECTED_PARENTS.size;
  // Show "· N of M visible" only when at least one chip is in some group.
  const visibleEl = document.getElementById('parentVisible');
  visibleEl.textContent = (PARENT_TAG_GROUPS.size > 0)
    ? ` · ${visible} of ${total} visible`
    : '';
}

function proposeForParent(parentCidr, mode, value, repeat = 1) {
  const parentNode = TREE.items.find(i => i.cidr === parentCidr);
  if (!parentNode) return [{ parent: parentCidr, cidr: null, reason: 'unknown' }];

  const targetPrefix = mode === 'prefix' ? value
                     : mode === 'hosts'  ? Math.max(1, Math.ceil(32 - Math.log2(Math.max(2, value + 2))))
                     :                     parentNode.prefix + Math.ceil(Math.log2(value));
  if (targetPrefix < parentNode.prefix || targetPrefix > 32) {
    return [{ parent: parentCidr, cidr: null, reason: `/${targetPrefix} doesn't fit in /${parentNode.prefix}` }];
  }

  const want = Math.pow(2, 32 - targetPrefix);
  const freeRanges = (parentNode.free || []).map(cidrInfo).map(r => ({ start: r.start, end: r.end }));
  freeRanges.sort((a,b) => a.start - b.start);

  const out = [];
  for (let i = 0; i < repeat; i++) {
    let placed = null;
    for (const r of freeRanges) {
      const aligned = Math.ceil(r.start / want) * want;
      if (aligned + want <= r.end) {
        placed = aligned;
        r.start = aligned + want;
        break;
      }
    }
    if (placed === null) {
      out.push({ parent: parentCidr, cidr: null, reason: out.length === 0 ? 'no free slot' : `only ${out.length} of ${repeat} fit` });
      break;
    }
    out.push({ parent: parentCidr, cidr: `${intToIp(placed)}/${targetPrefix}`, parentNode });
  }
  return out;
}

function runPreview(forcedCidr, forcedParent) {
  if (forcedCidr && forcedParent) {
    SELECTED_PARENTS.clear();
    SELECTED_PARENTS.add(forcedParent);
    populateParents();
  }

  const mode = document.querySelector('#carveMode button[aria-pressed="true"]').dataset.mode;
  const value = +document.getElementById('carveValue').value;
  const repeat = Math.max(1, Math.min(64, +document.getElementById('carveRepeat').value || 1));

  STATE.proposals = [...SELECTED_PARENTS].flatMap(p => proposeForParent(p, mode, value, repeat));

  if (forcedCidr && forcedParent) {
    const idx = STATE.proposals.findIndex(p => p.parent === forcedParent);
    if (idx >= 0) {
      const parentNode = TREE.items.find(i => i.cidr === forcedParent);
      STATE.proposals[idx] = { parent: forcedParent, cidr: forcedCidr, parentNode };
    }
  }

  renderProposals();
  renderViz();
}

function resolveCarveName(tmpl, parentCidr, n) {
  if (!tmpl) return '';
  const it = TREE.items.find(i => i.cidr === parentCidr);
  const parentLabel = (it && it.name) || parentCidr;
  return tmpl.replaceAll('{parent}', parentLabel).replaceAll('{n}', String(n));
}

// Resolve names for every proposal once, reused by both the rendered rows
// and the "copy all" button so they always agree.
function enrichProposals() {
  const tmpl = document.getElementById('carveName').value || '';
  const perParentIdx = {};
  return STATE.proposals.map((p) => {
    let childName = '';
    if (p.cidr) {
      perParentIdx[p.parent] = (perParentIdx[p.parent] || 0) + 1;
      childName = resolveCarveName(tmpl, p.parent, perParentIdx[p.parent]);
    }
    return { ...p, childName };
  });
}

function renderProposals() {
  const list = document.getElementById('proposalsList');
  if (!STATE.proposals.length) {
    list.style.display = 'none';
    document.getElementById('carveCommitBtn').disabled = true;
    return;
  }
  list.style.display = '';
  list.innerHTML = '';

  const enriched = enrichProposals();
  const okCount = enriched.filter(p => p.cidr).length;

  // Header strip: count + "copy all" button. Only when there's at least
  // one fit to copy.
  if (okCount > 0) {
    const header = document.createElement('div');
    header.className = 'proposal-header';
    header.innerHTML = `
      <span class="proposal-summary">${okCount} proposed</span>
      <button type="button" class="btn ghost proposals-copy-btn" id="proposalsCopyBtn"
              title="Copy CIDRs (and names if templated) to clipboard">
        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
        copy all
      </button>
    `;
    list.appendChild(header);
  }

  enriched.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'proposal' + (p.cidr ? '' : ' no-fit');
    // Look up the parent's human-readable name so the preview row reads
    // "in 10.166.0.0/18 (ent-a-us.e1.prd) ..." instead of just the CIDR.
    const parentItem = TREE.items.find(it => it.cidr === p.parent);
    const parentName = parentItem && parentItem.name ? parentItem.name : '';
    const parentLabel = parentName
      ? `<b>${p.parent}</b> <span style="color:var(--fg-2)">${escapeHtml(parentName)}</span>`
      : `<b>${p.parent}</b>`;
    if (p.cidr) {
      const childNameHtml = p.childName
        ? `<span class="pname">${escapeHtml(p.childName)}</span>`
        : '';
      const pi = cidrInfo(p.cidr);
      row.innerHTML = `
        <span class="icon">▸</span>
        <div>
          <div class="pcidr">${p.cidr}${childNameHtml}</div>
          <div class="pmeta">in ${parentLabel} · ${fmtBytes(pi.size)} addrs · /${pi.prefix}</div>
        </div>
        <span class="pill ok">fit</span>
      `;
    } else {
      row.innerHTML = `
        <span class="icon">✕</span>
        <div>
          <div class="pcidr" style="color:var(--err);">${parentLabel}</div>
          <div class="pmeta">${p.reason}</div>
        </div>
        <span class="pill err">no fit</span>
      `;
    }
    list.appendChild(row);
  });

  // Wire the copy button. Output is Infoblox-compatible CSV using the
  // same schema vnp's import accepts (docs/infoblox-csv-schema.md), so
  // copying preview rows and pasting them into another vnp instance — or
  // a real Infoblox import — round-trips cleanly.
  const copyBtn = document.getElementById('proposalsCopyBtn');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const fits = enriched.filter(p => p.cidr);
      const tagsValue = (document.getElementById('carveTags').value || '');
      const tags = tagsValue.split(',').map(s => s.trim()).filter(Boolean);
      const allocations = fits.map(p => ({
        cidr: p.cidr,
        name: p.childName || '',
        description: '',
        tags,
      }));
      const csv = formatInfobloxCsv({ allocations });
      copyText(csv, `copied ${fits.length} row${fits.length === 1 ? '' : 's'} as Infoblox CSV`);
    });
  }

  document.getElementById('commitCount').textContent = okCount ? `(${okCount})` : '';
  document.getElementById('carveCommitBtn').disabled = okCount === 0;
}

async function commitCarve() {
  const ok = STATE.proposals.filter(p => p.cidr);
  if (!ok.length) return;
  const tmpl = document.getElementById('carveName').value || '';
  const tags = (document.getElementById('carveTags').value || '').split(',').map(s=>s.trim()).filter(Boolean);
  const perParentIdx = {};
  const allocations = ok.map((p) => {
    perParentIdx[p.parent] = (perParentIdx[p.parent] || 0) + 1;
    return {
      cidr: p.cidr,
      name: resolveCarveName(tmpl, p.parent, perParentIdx[p.parent]),
      description: '',
      tags,
    };
  });

  try {
    const r = await fetch(URL_CARVE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ allocations }),
    });
    const data = await r.json();
    if (data.ok) {
      const n = (data.committed || []).length;
      toast(`committed ${n} carve${n===1?'':'s'}`, 'ok');
      STATE.proposals = [];
      STATE.selectedCidr = (data.committed || [])[0] || null;
      await refresh();
    } else {
      toast(`commit failed: ${data.error || 'unknown'}`, 'err');
    }
  } catch (e) {
    toast(`commit failed: ${e}`, 'err');
  }
}

//==========================================================
//  Add / Edit / Delete (server calls + refresh)
//==========================================================
async function postJSON(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await r.json(); } catch {}
  return { ok: r.ok && data.ok !== false, data };
}

async function addRecord() {
  const kind = document.querySelector('[data-add-kind][aria-pressed="true"]').dataset.addKind;
  const cidr = document.getElementById('addCidr').value.trim();
  const name = document.getElementById('addName').value.trim();
  const desc = document.getElementById('addDesc').value.trim();
  const tags = document.getElementById('addTags').value;
  if (!cidr) { toast('cidr is required', 'err'); return; }
  const { ok, data } = await postJSON(URL_ADD, { kind, cidr, name, description: desc, tags });
  if (!ok) { toast(data.error || 'add failed', 'err'); return; }
  toast(`added ${cidr}`, 'ok');
  document.getElementById('addCidr').value = '';
  document.getElementById('addName').value = '';
  document.getElementById('addDesc').value = '';
  document.getElementById('addTags').value = '';
  await refresh();
}
function resetAdd() {
  document.getElementById('addCidr').value = '';
  document.getElementById('addName').value = '';
  document.getElementById('addDesc').value = '';
  document.getElementById('addTags').value = '';
}

async function requestDelete(cidr) {
  const node = nodeOf(cidr); if (!node) return;
  const what = node.kind;  // 'supernet' | 'allocation' | 'reservation'
  const childWarning = node.children.length
    ? `\n\nThis contains ${node.children.length} child item${node.children.length>1?'s':''} which will become orphans.`
    : '';
  if (!confirm(`Delete ${what} ${cidr}${node.name ? ' (' + node.name + ')' : ''}?${childWarning}`)) return;
  const { ok, data } = await postJSON(URL_DELETE, { cidr, kind: what });
  if (!ok) { toast(data.error || 'delete failed', 'err'); return; }
  if (STATE.selectedCidr === cidr) STATE.selectedCidr = null;
  toast(`deleted ${cidr}`, 'ok');
  await refresh();
}

//==========================================================
//  Detail panel
//==========================================================
const detail = document.getElementById('detail');
function openDetail(cidr) {
  const node = nodeOf(cidr);
  if (!node) return;
  STATE.detailCidr = cidr;
  const used = usedAddresses(node), total = totalAddresses(node);
  const pct = total > 0 ? Math.round(100 * used / total) : 0;
  document.getElementById('detailKind').textContent = `${node.kind} detail`;
  const kindBadge = document.getElementById('detailKindBadge');
  kindBadge.textContent = node.kind;
  kindBadge.className = 'detail-kind' + (node.kind === 'reservation' ? ' kind-reservation' : '');
  const detailCidrEl = document.getElementById('detailCidr');
  detailCidrEl.textContent = node.cidr;
  detailCidrEl.dataset.copy = node.cidr;
  document.getElementById('detailSize').textContent = `${fmtBytes(total)} / ${node.prefix}`;
  document.getElementById('detailRange').textContent = `${intToIp(node.start)} – ${intToIp(node.end-1)}`;
  const par = parentOf(cidr);
  document.getElementById('detailParent').textContent = par ? par.cidr : '—';
  document.getElementById('detailUtil').textContent =
    node.kind === 'reservation' ? 'reserved' :
    node.kind === 'supernet'    ? `${pct}%` :
    node.children.length        ? `${pct}%` :
                                  'leaf';
  document.getElementById('detailName').value = node.name || '';
  document.getElementById('detailDesc').value = node.description || '';
  document.getElementById('detailTags').value = (node.tags||[]).join(', ');
  detail.classList.add('on');
  detail.setAttribute('aria-hidden', 'false');
}
function closeDetail() {
  detail.classList.remove('on');
  detail.setAttribute('aria-hidden', 'true');
  STATE.detailCidr = null;
}
async function saveDetail() {
  const cidr = STATE.detailCidr; if (!cidr) return;
  const name = document.getElementById('detailName').value.trim();
  const desc = document.getElementById('detailDesc').value.trim();
  const tags = document.getElementById('detailTags').value;
  const { ok, data } = await postJSON(URL_EDIT, { cidr, name, description: desc, tags });
  if (!ok) { toast(data.error || 'save failed', 'err'); return; }
  toast(`saved ${cidr}`, 'ok');
  closeDetail();
  await refresh();
}

//==========================================================
//  Banners (orphans + conflicts)
//==========================================================
function refreshBanners() {
  const orphanBanner = document.getElementById('orphanBanner');
  if (SERVER.orphans.length) {
    orphanBanner.style.display = '';
    document.getElementById('orphanCount').textContent =
      `${SERVER.orphans.length} orphan${SERVER.orphans.length===1?'':'s'}`;
    document.getElementById('orphanList').innerHTML =
      SERVER.orphans.map(c => `<a href="#" data-jump="${c}">${c}</a>`).join('');
  } else {
    orphanBanner.style.display = 'none';
  }
  const cb = document.getElementById('conflictBanner');
  if (SERVER.conflicts.length) {
    cb.style.display = '';
    document.getElementById('conflictCount').textContent =
      `${SERVER.conflicts.length} conflict${SERVER.conflicts.length===1?'':'s'}`;
    document.getElementById('conflictList').innerHTML =
      SERVER.conflicts.flatMap(([a,b]) => [
        `<a href="#" data-jump="${a}">${a}</a>`,
        ' ⇄ ',
        `<a href="#" data-jump="${b}">${b}</a>`,
        ' &nbsp; '
      ]).join('');
  } else {
    cb.style.display = 'none';
  }
  document.getElementById('metaConflicts').textContent = String(SERVER.conflicts.length);
}

//==========================================================
//  Breadcrumbs / sidebar meta
//==========================================================
function updateBreadcrumbs() {
  const nSuper = (PLAN.supernets    || []).length;
  const nAlloc = (PLAN.allocations  || []).length;
  const nResv  = (PLAN.reservations || []).length;
  let totalAddrs = 0, usedAddrs = 0;
  for (const r of TREE.roots.filter(x=>x.kind==='supernet')) {
    totalAddrs += r.size;
    usedAddrs  += usedAddresses(r);
  }
  const pct = totalAddrs ? Math.round(1000 * usedAddrs / totalAddrs) / 10 : 0;
  document.getElementById('badgeSupers').textContent = `${nSuper} supernet${nSuper===1?'':'s'}`;
  document.getElementById('badgeAllocs').textContent = `${nAlloc} alloc${nAlloc===1?'':'s'}`;
  const reservedBadge = document.getElementById('badgeReserved');
  if (nResv > 0) {
    reservedBadge.style.display = '';
    reservedBadge.textContent = `${nResv} reserved`;
  } else {
    reservedBadge.style.display = 'none';
  }
  document.getElementById('badgeUtil').textContent = `${pct}% util`;
  const supers = (PLAN.supernets || []).map(s => s.cidr);
  document.getElementById('metaSpace').textContent    = supers.length ? supers.slice(0,2).join(', ') + (supers.length>2 ? ` +${supers.length-2}` : '') : '—';
  document.getElementById('metaUtil').textContent     = totalAddrs ? `${pct}%` : '—';
  document.getElementById('metaReserved').textContent = String(nResv);
}

//==========================================================
//  Tabs / segmented controls
//==========================================================
function switchTab(name) {
  STATE.tab = name;
  document.querySelectorAll('.rail-tabs button').forEach(b => {
    b.setAttribute('aria-selected', b.dataset.tab === name);
  });
  document.querySelectorAll('[data-panel]').forEach(p => {
    p.style.display = p.dataset.panel === name ? '' : 'none';
  });
}
document.querySelectorAll('.rail-tabs button').forEach(b => {
  b.addEventListener('click', () => switchTab(b.dataset.tab));
});
document.querySelectorAll('.seg button[data-color]').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.seg button[data-color]').forEach(x => x.setAttribute('aria-pressed','false'));
    b.setAttribute('aria-pressed','true');
    STATE.colorMode = b.dataset.color;
    updateLegend();
    renderViz();
  });
});
document.querySelectorAll('.seg button[data-zoom]').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.seg button[data-zoom]').forEach(x => x.setAttribute('aria-pressed','false'));
    b.setAttribute('aria-pressed','true');
    STATE.zoom = b.dataset.zoom;
    renderViz();
  });
});
document.querySelectorAll('#carveMode button').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#carveMode button').forEach(x => x.setAttribute('aria-pressed','false'));
    b.setAttribute('aria-pressed','true');
    const mode = b.dataset.mode;
    document.getElementById('carveValueLbl').textContent =
      mode === 'prefix' ? 'prefix length' : mode === 'hosts' ? 'host count' : 'split into N';
    document.getElementById('carveValue').value = mode === 'prefix' ? 28 : mode === 'hosts' ? 100 : 4;
  });
});
const ADD_KIND_HINTS = {
  supernet:    'A top-level block you own. Roots the hierarchy.',
  allocation:  'An existing subnet seen in the wild — consumes free space.',
  reservation: 'A range to keep off-limits — consumes free space, but never carved into.',
};
function syncAddKindHint() {
  const k = document.querySelector('[data-add-kind][aria-pressed="true"]')?.dataset.addKind || 'supernet';
  const el = document.getElementById('addKindHint');
  if (el) el.textContent = ADD_KIND_HINTS[k] || '';
}
document.querySelectorAll('[data-add-kind]').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('[data-add-kind]').forEach(x => x.setAttribute('aria-pressed','false'));
    b.setAttribute('aria-pressed','true');
    syncAddKindHint();
  });
});
syncAddKindHint();
// Group selector ([A] [B] [C]) sets which group new chip clicks land in.
// Doesn't re-filter on its own — switching the active group is just
// changing where future clicks go; the current assignments are unchanged.
document.querySelectorAll('#parentTagGroupSelector button').forEach(b => {
  b.addEventListener('click', () => {
    CURRENT_GROUP = b.dataset.group;
    document.querySelectorAll('#parentTagGroupSelector button').forEach(x =>
      x.setAttribute('aria-pressed', x.dataset.group === CURRENT_GROUP ? 'true' : 'false')
    );
    // Refresh chip tooltips so the "click to add to group X" hint reflects
    // the new active group; no actual filter change.
    populateParentTagFilter();
  });
});

// "all" / "supers" act on the *visible* (filter-respecting) list. "none"
// always clears everything regardless of filter.
document.getElementById('parentSelectAll').addEventListener('click', () => {
  filteredEligibleParents().forEach(i => SELECTED_PARENTS.add(i.cidr));
  populateParents();
});
document.getElementById('parentSelectNone').addEventListener('click', () => {
  SELECTED_PARENTS.clear(); populateParents();
});
document.getElementById('parentSelectSupers').addEventListener('click', () => {
  SELECTED_PARENTS.clear();
  filteredEligibleParents()
    .filter(i => i.kind === 'supernet')
    .forEach(i => SELECTED_PARENTS.add(i.cidr));
  populateParents();
});
document.getElementById('carvePreviewBtn').addEventListener('click', () => runPreview());
document.getElementById('carveCommitBtn').addEventListener('click', commitCarve);

// Live-update proposal name labels as the template is edited — saves a
// click on "preview" just to see the substituted names.
document.getElementById('carveName').addEventListener('input', () => {
  if (STATE.proposals.length) renderProposals();
});

document.getElementById('addSubmit').addEventListener('click', addRecord);
document.getElementById('addReset').addEventListener('click', resetAdd);

document.getElementById('detailClose').addEventListener('click', closeDetail);
document.getElementById('detailCancel').addEventListener('click', closeDetail);
document.getElementById('detailCidr').addEventListener('click', () => copyText(document.getElementById('detailCidr').textContent));
document.getElementById('detailSave').addEventListener('click', saveDetail);
document.getElementById('detailDelete').addEventListener('click', () => {
  const cidr = STATE.detailCidr; if (!cidr) return;
  closeDetail();
  requestDelete(cidr);
});

// Import form
document.getElementById('importForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = document.getElementById('importFile').files[0];
  if (!file) { toast('select a file first', 'err'); return; }
  const fd = new FormData();
  fd.append('file', file);
  try {
    const r = await fetch(URL_IMPORT, { method: 'POST', body: fd });
    const data = await r.json();
    if (!r.ok || !data.ok) {
      toast(data.error || 'import failed', 'err');
      return;
    }
    const last = document.getElementById('importLast');
    const body = document.getElementById('importLastBody');
    last.style.display = '';
    body.textContent =
      `${data.added_supernets} supernets · ${data.added_allocations} allocations · `
      + `${data.skipped_duplicates} dup · ${data.parse_errors.length} errors · ${data.rejected.length} rejected`;
    toast('imported', 'ok');
    document.getElementById('importFile').value = '';
    await refresh();
  } catch (err) {
    toast(`import failed: ${err}`, 'err');
  }
});

//==========================================================
//  Search
//==========================================================
const searchbar = document.getElementById('searchbar');
const searchInput = document.getElementById('searchInput');
const searchMatches = document.getElementById('searchMatches');
function openSearch() {
  searchbar.classList.add('on');
  searchInput.focus();
  searchInput.select();
}
function closeSearch() {
  searchbar.classList.remove('on');
  searchInput.value = '';
  STATE.search = '';
  renderTree(); renderViz();
  searchMatches.textContent = '';
}
document.getElementById('searchBtn').addEventListener('click', openSearch);
document.getElementById('searchCloseBtn').addEventListener('click', closeSearch);
searchInput.addEventListener('input', () => {
  STATE.search = searchInput.value.trim();
  let count = 0;
  if (STATE.search) {
    for (const it of TREE.items) if (nodeMatches(it, STATE.search).self) count++;
  }
  searchMatches.textContent = STATE.search ? `${count} match${count===1?'':'es'}` : '';
  renderTree(); renderViz();
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSearch();
});

//==========================================================
//  Tag filter
//==========================================================
const tagFilterEl = document.getElementById('tagFilter');
const tagFilterLabel = document.getElementById('tagFilterLabel');
function setTagFilter(tag) {
  STATE.tagFilter = tag || null;
  if (tag) {
    tagFilterLabel.textContent = tag;
    tagFilterEl.classList.add('on');
  } else {
    tagFilterEl.classList.remove('on');
  }
  renderViz(); renderTree();
}
document.getElementById('tagFilterClear').addEventListener('click', () => setTagFilter(null));
document.addEventListener('click', (e) => {
  const t = e.target.closest('.tag.clickable[data-tag]');
  if (t) setTagFilter(t.dataset.tag);
});

//==========================================================
//  Copy CIDR (delegated outside tree)
//==========================================================
document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-copy]');
  if (c && !e.target.closest('.row')) {
    e.preventDefault();
    copyText(c.dataset.copy);
  }
});

//==========================================================
//  Banner jump links
//==========================================================
document.addEventListener('click', (e) => {
  const j = e.target.closest('[data-jump]');
  if (j) { e.preventDefault(); selectCidr(j.dataset.jump); openDetail(j.dataset.jump); }
});

//==========================================================
//  Export plan as Infoblox CSV (round-trips through Import tab)
//==========================================================
document.getElementById('exportBtn').addEventListener('click', () => {
  const csv = formatInfobloxCsv({
    supernets:   PLAN.supernets   || [],
    allocations: PLAN.allocations || [],
  });
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${PLAN.name || 'plan'}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  // Reservations are a vnp-only concept (no Infoblox counterpart) so the
  // CSV export drops them. Mention it explicitly so the user can grab the
  // raw plan JSON file from disk if they need full fidelity.
  const nResv = (PLAN.reservations || []).length;
  toast(
    nResv > 0
      ? `exported ${PLAN.name}.csv · ${nResv} reservation${nResv === 1 ? '' : 's'} omitted (vnp-only)`
      : `exported ${PLAN.name}.csv`,
    'ok',
  );
});

//==========================================================
//  Legend
//==========================================================
function updateLegend() {
  const lg = document.getElementById('legend');
  if (STATE.colorMode === 'tag') {
    const allTags = new Set();
    for (const a of (PLAN.allocations || [])) (a.tags || []).forEach(t => allTags.add(t));
    const top = [...allTags].slice(0, 6);
    lg.innerHTML = top.map(t => `<span><span class="swatch" style="background:${tagColor(t)}"></span>${t}</span>`).join('') || '<span style="color:var(--fg-3)">no tags</span>';
  } else if (STATE.colorMode === 'util') {
    lg.innerHTML = `
      <span><span class="swatch" style="background:oklch(0.66 0.13 165)"></span>0%</span>
      <span><span class="swatch" style="background:oklch(0.66 0.13 100)"></span>50%</span>
      <span><span class="swatch" style="background:oklch(0.66 0.13 35)"></span>100%</span>`;
  } else {
    lg.innerHTML = `
      <span><span class="swatch" style="background: var(--used)"></span>allocated</span>
      <span><span class="swatch" style="background: var(--free); border:1px dashed var(--free-2)"></span>free</span>
      <span><span class="swatch" style="background: var(--supernet); border:1px solid var(--line)"></span>supernet</span>`;
  }
}

//==========================================================
//  Keyboard
//==========================================================
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (detail.classList.contains('on')) { closeDetail(); return; }
    if (searchbar.classList.contains('on')) { closeSearch(); return; }
    if (STATE.tagFilter) { setTagFilter(null); return; }
  }
  if (e.target.matches('input, select, textarea')) return;
  if (e.key === 'c') switchTab('carve');
  if (e.key === '/') { e.preventDefault(); openSearch(); }
});

window.addEventListener('vnp:theme', () => { renderViz(); updateLegend(); });
window.addEventListener('resize', () => { clearTimeout(window.__rs); window.__rs = setTimeout(renderViz, 120); });

// ---- init ----
refresh();
})();
