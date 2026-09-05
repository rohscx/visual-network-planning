/* =========================================================
   vnp · plan view — fetched from /plans/<name>/plan.json
   ========================================================= */

(() => {
const PLAN_NAME = window.PLAN_NAME;
const URL_PLAN   = `/plans/${encodeURIComponent(PLAN_NAME)}/plan.json`;
const URL_ADD    = `/plans/${encodeURIComponent(PLAN_NAME)}/add`;
const URL_EDIT   = `/plans/${encodeURIComponent(PLAN_NAME)}/edit`;
const URL_RECLASSIFY = `/plans/${encodeURIComponent(PLAN_NAME)}/reclassify`;
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
  // Cidr → item map. Used by nodeOf / parentOf — without this they walk
  // items linearly and any caller that loops over matches (e.g. the
  // search "copy all" handler) sits at O(N²).
  const byCidr = new Map();
  for (const it of items) byCidr.set(it.cidr, it);
  return { roots, items, byCidr };
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
// buildTree computes every node's direct gaps before summaries read them.
// Composed from the children's own cached answers rather than re-walking the
// whole subtree per call: utilColor() and every tree row ask for this, so the
// re-walking version cost ~465ms to repaint a 671-node plan in "by util".
// buildTree returns fresh node objects each load, so the cache expires itself.
const subtreeFree = (root) => {
  if (root._subtreeFree) return root._subtreeFree;
  // a reservation consumes its range outright — never carve-eligible
  if (root.kind === 'reservation') return (root._subtreeFree = { total: 0, largest: null });
  let total = 0, largest = null, largestSize = 0;
  for (const cidr of root.free) {
    const { size } = cidrInfo(cidr);
    total += size;
    if (size > largestSize) { largest = cidr; largestSize = size; }
  }
  for (const child of root.children) {
    const cf = subtreeFree(child);
    total += cf.total;
    const cs = cf.largest ? cidrInfo(cf.largest).size : 0;
    if (cs > largestSize) { largest = cf.largest; largestSize = cs; }
  }
  return (root._subtreeFree = { total, largest });
};
const capacityLabel = ({ total, largest }) => largest
  ? `largest /${cidrInfo(largest).prefix} · ${fmtBytes(total)} free`
  : 'no free space';

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
let TREE = { roots: [], items: [], byCidr: new Map() };
const STATE = {
  selectedCidr: null,
  hoveredCidr:  null,
  colorMode:    'state',
  zoom:         'all',
  proposals:    [],
  tab:          'add',
  search:       '',     // raw user input
  searchRe:     null,   // compiled RegExp (or null when search is empty)
  tagFilter:    null,
  detailCidr:   null,
  density:      loadDensity(),   // 'detail' | 'compact' (Direction B)
};
const SELECTED_PARENTS = new Set();
// Supernets currently expanded in compact mode. Session-only on purpose:
// it's a "what am I looking at right now" thing, not a preference.
const EXPANDED = new Set();

function loadDensity() {
  // ?density=compact wins (shareable), then the remembered choice, then detail.
  const q = new URLSearchParams(location.search).get('density');
  if (q === 'compact' || q === 'detail') return q;
  try {
    const v = localStorage.getItem('vnp.density');
    if (v === 'compact' || v === 'detail') return v;
  } catch {}
  return 'detail';
}

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
  // If the detail panel is open on a record that just disappeared (the
  // user deleted it from another tab, or reclassified to a different
  // bucket / state that drops it from TREE.items), close the slide-over
  // before the next interaction tries to save a stale CIDR.
  if (STATE.detailCidr && !TREE.items.some(it => it.cidr === STATE.detailCidr)) {
    closeDetail();
  }
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
// Compile the user's search input into a case-insensitive regex. If the
// input isn't valid regex (mismatched parens, dangling quantifier), fall
// back to a literal-string match so the UI doesn't blank itself while the
// user is mid-typing something like "(prod" or "[".
function compileSearch(q) {
  if (!q) return null;
  try { return new RegExp(q, 'i'); }
  catch {
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped, 'i');
  }
}

function nodeMatches(node, re) {
  if (!re) return { self: false, descendant: false };
  // Effective tags include inherited ones, so searching "prod" finds every
  // child of a "prod"-tagged supernet, not just the supernet itself.
  const self = re.test(node.cidr)
            || re.test(node.name || '')
            || effectiveTags(node).some(t => re.test(t))
            || re.test(node.description || '');
  let descendant = false;
  for (const c of (node.children || [])) {
    const m = nodeMatches(c, re);
    if (m.self || m.descendant) { descendant = true; break; }
  }
  return { self, descendant };
}
function nodePassesTag(node, tag) {
  if (!tag) return true;
  if (effectiveTags(node).includes(tag)) return true;
  return (node.children||[]).some(c => nodePassesTag(c, tag));
}
function highlightMatch(text, re) {
  if (!text) return '';
  const safe = String(text).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  if (!re) return safe;
  // Build a global version of the live regex so replace() wraps every
  // match (e.g. "mis|qe|raas" highlights all three terms in one field).
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
  const reG = new RegExp(re.source, flags);
  return safe.replace(reG, m => `<mark>${m}</mark>`);
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
function nodeOf(cidr) { return TREE.byCidr ? TREE.byCidr.get(cidr) : TREE.items.find(i => i.cidr === cidr); }
function parentOf(cidr) {
  const it = nodeOf(cidr);
  return it ? (it._parent || null) : null;
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

  const matches = nodeMatches(node, STATE.searchRe);
  if (STATE.searchRe) {
    if (matches.self) el.classList.add('match');
    if (!matches.self && !matches.descendant) el.classList.add('hidden');
  }

  const used = totalAddresses(node) - subtreeFree(node).total;
  const total = totalAddresses(node);
  const pct = total > 0 ? Math.round(100 * used / total) : 0;
  const pctLabel = node.kind === 'reservation' ? 'reserved' : `${pct}%`;

  const row = document.createElement('div');
  row.className = 'row';
  const matchedName = highlightMatch(node.name || '', STATE.searchRe);
  const matchedCidr = highlightMatch(node.cidr, STATE.searchRe);
  // Native browser tooltip surfaces the full text when the name (or CIDR
  // in a narrow sidebar) gets ellipsized by overflow. Skip on rows with
  // no name to avoid an empty-quote popup.
  const rowTooltip = node.name ? `${node.cidr} — ${node.name}` : node.cidr;
  row.title = rowTooltip;
  // Direction C: CIDR / actions / pct on line one, the full name on its own
  // line beneath — so a 30-char name never has to squeeze beside a 12px
  // CIDR in a 280px sidebar. Rows without a name stay single-line.
  row.innerHTML = `
    <span class="twist"></span>
    <span class="cidr copyable" data-copy="${node.cidr}" title="Click to copy">${matchedCidr}</span>
    <span class="actions-tn">
      <button data-act="del" title="Delete">×</button>
    </span>
    <span class="pct">${pctLabel}</span>
    ${node.name ? `<span class="name">${matchedName}</span>` : ''}
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
    vizEl.classList.remove('compact');
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
          <span><kbd>d</kbd> density</span>
        </div>
      </div>
    `;
    document.getElementById('emptyAdd')?.addEventListener('click', () => switchTab('add'));
    document.getElementById('emptyImport')?.addEventListener('click', () => switchTab('import'));
    return;
  }

  // Cache CSS variable lookups for the duration of the render. Each
  // getCss() call goes through getComputedStyle, which forces a sync
  // style recalc — and we'd otherwise hit it ~3× per node × hundreds of
  // nodes, which dominates the click→paint time on slower machines.
  const CSS_VARS = {
    supernet: getCss('--supernet'),
    bg3:      getCss('--bg-3'),
    free:     getCss('--free'),
    used:     getCss('--used'),
    line:     getCss('--line'),
    acc:      getCss('--acc'),
  };

  const focus = STATE.zoom === 'focus' && STATE.selectedCidr;
  let targets = focus
    ? supers.filter(s => isSubnetOf(STATE.selectedCidr, s.cidr) || s.cidr === STATE.selectedCidr || isSubnetOf(s.cidr, STATE.selectedCidr))
    : supers;
  // When search is active, hide entire supernets that contain zero matches
  // (declutters the canvas without distorting spatial proportions inside
  // the supernets that do contain matches).
  if (STATE.searchRe) {
    targets = targets.filter(s => {
      const m = nodeMatches(s, STATE.searchRe);
      return m.self || m.descendant;
    });
  }

  vizEl.classList.toggle('compact', STATE.density === 'compact' && targets.length > 0);
  if (STATE.density === 'compact' && targets.length) {
    renderCompact(targets, CSS_VARS);
  } else for (const root of targets) {
    const wrap = document.createElement('div');
    wrap.className = 'viz-supernet';

    const total = totalAddresses(root);
    const free = subtreeFree(root);
    // Share the capacity figure's basis: usedAddresses() counts only direct
    // children, so a /16 tiled by four /18 containers reads 100% while its
    // leaves sit mostly empty — beside "28.9K free" that looks like a bug.
    const pct = total > 0 ? Math.round(100 * (total - free.total) / total) : 0;
    const capacity = capacityLabel(free);

    const cap = document.createElement('div');
    cap.className = 'cap';
    cap.innerHTML = `
      <div class="lhs">
        <span class="cidr">${root.cidr}</span>
        <span class="label">${root.name || ''}</span>
      </div>
      <div class="rhs">
        <span class="capacity">${capacity}</span>
        <div class="density-bar"><div class="fill" style="width:${pct}%"></div></div>
        <span class="pct${pct > 80 ? ' hot' : ''}">${pct}% assigned</span>
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

    drawNode(svg, root, 0, 0, width, height, 0, root, CSS_VARS);
    drawProposalOverlays(svg, root, 0, 0, width, height, CSS_VARS);
    vizEl.appendChild(wrap);
  }

  if (!targets.length) {
    const msg = STATE.searchRe
      ? 'no supernets contain matches · clear search to see everything'
      : 'no supernets in scope';
    vizEl.innerHTML = `<div style="padding:48px; text-align:center; color:var(--fg-2); font-family:JetBrains Mono,monospace; font-size:12px;">${msg}</div>`;
  }

  // Restore scroll synchronously — by this point all wraps are appended so
  // scrollHeight has grown back to its full value and the assignment isn't
  // clamped. The browser doesn't paint between this and the earlier DOM
  // mutations, so there's no visible flicker.
  if (vizWrap) vizWrap.scrollTop = savedScroll;

  // Apply current selection (selected + dim classes) as a single post-pass.
  // drawNode emits dim-filter only; selection state is layered on top so a
  // click can update it cheaply without rebuilding the SVG.
  applySelectionVisual();
  if (STATE.density === 'compact') updateOverviewViewport();
}

//==========================================================
//  Direction B — compact density: 40px rows, expand in place, overview
//==========================================================
function fillFor(node, css) {
  return node.kind === 'reservation' ? css.bg3
       : STATE.colorMode === 'tag'   ? primaryTagColor(effectiveTags(node))
       : STATE.colorMode === 'util'  ? utilColor(node)
       :                               css.used;
}

// canvas resolves runtime oklch fills to the same sRGB channels used for contrast.
const inkCanvas = document.createElement('canvas');
inkCanvas.width = inkCanvas.height = 1;
const inkContext = inkCanvas.getContext('2d', { willReadFrequently: true });
const inkCache = new Map();
const labelInk = (fill) => {
  if (inkCache.has(fill)) return inkCache.get(fill);
  inkContext.clearRect(0, 0, 1, 1);
  inkContext.fillStyle = fill;
  inkContext.fillRect(0, 0, 1, 1);
  const channels = inkContext.getImageData(0, 0, 1, 1).data;
  const linear = Array.from(channels).slice(0, 3).map(value => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  const ink = luminance > 0.179 ? '#0b0d10' : 'var(--fg)';
  inkCache.set(fill, ink);
  return ink;
};

function renderCompact(targets, css) {
  const list = document.createElement('div');
  list.className = 'viz-list';
  const ov = document.createElement('aside');
  ov.className = 'viz-overview';

  for (const [rowIndex, root] of targets.entries()) {
    const total = totalAddresses(root);
    const free = subtreeFree(root);
    const pct = total > 0 ? Math.round(100 * (total - free.total) / total) : 0;
    const capacity = capacityLabel(free);
    const ri = cidrInfo(root.cidr);
    const isOpen = EXPANDED.has(root.cidr);
    const dimByFilter = !!(STATE.tagFilter && !nodePassesTag(root, STATE.tagFilter));

    const row = document.createElement('div');
    row.className = 'viz-row' + (isOpen ? ' expanded' : '') + (dimByFilter ? ' dim-filter' : '');
    row.dataset.cidr = root.cidr;
    row.dataset.rowIndex = rowIndex;

    // Proportional strip: direct children at true positions, no labels (so
    // nothing can collide), reservations dashed, proposals as mint outlines.
    // Leaf-level occupancy, not "direct children" — a /16 tiled by four
    // /18 containers would otherwise read as one solid 100% bar. Nested
    // supernets become 1px dividers at their left edge; an allocation that
    // has its own children gets a faint underlay with its leaves on top.
    let bars = '';
    const dividers = [];
    const pos = (ci) => `left:${((ci.start - ri.start) / ri.size * 100).toFixed(3)}%;width:${(ci.size / ri.size * 100).toFixed(3)}%;`;
    const walk = (n) => {
      for (const c of n.children) {
        const ci = cidrInfo(c.cidr);
        const dim = dimmedByFilter(c) ? ' dim-filter' : '';
        const title = `title="${escapeHtml(c.cidr)}${c.name ? ' · ' + escapeHtml(c.name) : ''}"`;
        if (c.kind === 'supernet') {
          // A container contributes a divider and its leaves, never a fill of
          // its own — a childless /18 painted as a solid bar read as "fully
          // allocated" when it is in fact entirely free.
          if (ci.start !== ri.start) dividers.push((ci.start - ri.start) / ri.size * 100);
          walk(c);
        } else if (c.kind === 'allocation' && c.children.length > 0) {
          bars += `<div class="b sub${dim}" style="${pos(ci)}background:${fillFor(c, css)};" ${title}></div>`;
          walk(c);
        } else {
          const rv = c.kind === 'reservation';
          bars += `<div class="b${rv ? ' rv' : ''}${dim}" style="${pos(ci)}${rv ? '' : 'background:' + fillFor(c, css) + ';'}" ${title}></div>`;
        }
      }
    };
    walk(root);
    for (const d of dividers) bars += `<div class="dv" style="left:${d.toFixed(3)}%"></div>`;
    for (const p of (STATE.proposals || [])) {
      if (!p.cidr) continue;
      const pi = cidrInfo(p.cidr);
      if (pi.start < ri.start || pi.end > ri.end) continue;
      bars += `<div class="b pp" style="left:${((pi.start - ri.start) / ri.size * 100).toFixed(3)}%;width:${(pi.size / ri.size * 100).toFixed(3)}%;" title="proposed ${escapeHtml(p.cidr)}"></div>`;
    }
    const middle = isOpen
      ? `<span class="vr-chip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"></path></svg>expanded in place · click a free slot to carve</span>`
      : `<div class="vr-strip">${bars}</div>`;

    row.innerHTML = `
      <div class="vr-head" role="button" tabindex="0" aria-expanded="${isOpen}"
           aria-label="${escapeHtml(root.cidr)}${root.name ? ' — ' + escapeHtml(root.name) : ''}, ${capacity}, ${pct}% assigned. Expand in place.">
        <div class="vr-id"><span class="cidr">${escapeHtml(root.cidr)}</span><span class="label">${escapeHtml(root.name || '')}</span></div>
        ${middle}
        <div class="vr-figs">
          <span class="capacity">${capacity}</span>
          <div class="density-bar"><div class="fill" style="width:${pct}%"></div></div>
          <span class="pct${pct > 80 ? ' hot' : ''}">${pct}% assigned</span>
        </div>
      </div>`;
    const head = row.querySelector('.vr-head');
    const toggle = () => {
      if (EXPANDED.has(root.cidr)) EXPANDED.delete(root.cidr); else EXPANDED.add(root.cidr);
      selectCidr(root.cidr);
      renderViz();
      // restore focus by position after renderViz() rebuilds the list;
      // duplicate root CIDRs mean CIDR cannot uniquely identify a row.
      const again = vizEl.querySelector(`.viz-list .viz-row[data-row-index="${rowIndex}"] .vr-head`);
      if (again) again.focus();
    };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    head.addEventListener('mouseenter', (e) => showTooltip(e, tooltipForNode(root)));
    head.addEventListener('mousemove', (e) => positionTooltip(e));
    head.addEventListener('mouseleave', hideTooltip);
    if (isOpen) {
      const det = document.createElement('div');
      det.className = 'vr-detail';
      row.appendChild(det);
    }
    list.appendChild(row);
  }

  // Overview column: one bar per supernet, viewport box tracks scroll.
  const bars = document.createElement('div');
  bars.className = 'ov-bars';
  let html = '';
  for (const root of targets) {
    const total = totalAddresses(root);
    // Same basis as the rows beside it, so a bar never disagrees with its row.
    const pct = total > 0 ? Math.round(100 * (total - subtreeFree(root).total) / total) : 0;
    const directUsed = usedAddresses(root);
    const rvUsed = root.children.filter(c => c.kind === 'reservation').reduce((a, c) => a + c.size, 0);
    const rv = directUsed > 0 && rvUsed / directUsed > 0.5;
    html += `<div class="ov-bar${rv ? ' rv' : ''}" data-ov="${escapeHtml(root.cidr)}" role="button" tabindex="0" aria-label="Jump to ${escapeHtml(root.cidr)}, ${pct}% used" title="${escapeHtml(root.cidr)}${root.name ? ' · ' + escapeHtml(root.name) : ''} · ${pct}%"><i style="width:${pct}%"></i></div>`;
  }
  bars.innerHTML = html + '<div class="ov-view"></div>';
  // The bar column scrolls on its own once it is capped; a re-render would
  // otherwise snap it back to the top mid-scroll.
  const keptScroll = renderCompact.ovScroll || 0;
  bars.addEventListener('scroll', () => { renderCompact.ovScroll = bars.scrollTop; }, { passive: true });
  requestAnimationFrame(() => { bars.scrollTop = keptScroll; });
  const jumpTo = (b) => {
    const row = list.querySelector(`.viz-row[data-cidr="${CSS.escape(b.dataset.ov)}"]`);
    if (row) row.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  bars.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ov]'); if (b) jumpTo(b);
  });
  bars.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const b = e.target.closest('[data-ov]'); if (!b) return;
    e.preventDefault(); jumpTo(b);
  });
  const n = targets.length;
  ov.innerHTML = `<div class="ov-head"><span>overview</span><span class="n">${n} supernet${n === 1 ? '' : 's'}</span></div>`;
  ov.appendChild(bars);
  ov.insertAdjacentHTML('beforeend', '<div class="ov-hint">mint box = rows on screen · click a bar to jump · yellow = mostly reserved</div>');

  vizEl.appendChild(list);
  vizEl.appendChild(ov);

  // Expanded rows get the full strip — the same drawNode as detail mode, so
  // free-slot click-to-carve, tooltips and proposal overlays all work
  // unchanged. Measured after insertion so the SVG fits its row.
  for (const row of list.querySelectorAll('.viz-row.expanded')) {
    const root = nodeOf(row.dataset.cidr); if (!root) continue;
    const det = row.querySelector('.vr-detail');
    const width = Math.max(200, det.clientWidth);
    const height = 140 + maxDepth(root) * 24;
    const svg = d3.select(det).append('svg')
      .attr('class', 'viz-svg')
      .attr('viewBox', `0 0 ${width} ${height}`)
      .attr('preserveAspectRatio', 'none')
      .style('height', height + 'px');
    drawNode(svg, root, 0, 0, width, height, 0, root, css);
    drawProposalOverlays(svg, root, 0, 0, width, height, css);
  }

  if (!renderCompact.scrollBound && vizWrap) {
    vizWrap.addEventListener('scroll', () => {
      if (STATE.density === 'compact') requestAnimationFrame(updateOverviewViewport);
    }, { passive: true });
    renderCompact.scrollBound = true;
  }
}

function updateOverviewViewport() {
  const ov = vizEl.querySelector('.viz-overview'); if (!ov || !vizWrap) return;
  const box = ov.querySelector('.ov-view');
  const bars = [...ov.querySelectorAll('.ov-bar')];
  const rows = [...vizEl.querySelectorAll('.viz-list > .viz-row')];
  if (!box || !rows.length || bars.length !== rows.length) return;
  const wr = vizWrap.getBoundingClientRect();
  let first = -1, last = -1;
  rows.forEach((r, i) => {
    const rr = r.getBoundingClientRect();
    if (rr.bottom > wr.top && rr.top < wr.bottom) { if (first < 0) first = i; last = i; }
  });
  if (first < 0) { box.style.display = 'none'; return; }
  const top = bars[first].offsetTop, bottom = bars[last].offsetTop + bars[last].offsetHeight;
  box.style.display = '';
  box.style.top = (top - 3) + 'px';
  box.style.height = (bottom - top + 6) + 'px';

  // Keep the marker in view when the column is scrollable, or it drifts below
  // the clipped edge on a tall plan and the overview stops answering
  // "where am I?".
  const track = box.parentElement;
  if (track && track.scrollHeight > track.clientHeight) {
    const t = top - 3, b = bottom + 3;
    if (t < track.scrollTop) track.scrollTop = Math.max(0, t - 6);
    else if (b > track.scrollTop + track.clientHeight) track.scrollTop = b - track.clientHeight + 6;
    renderCompact.ovScroll = track.scrollTop;
  }
}

function setDensity(d) {
  STATE.density = d;
  try { localStorage.setItem('vnp.density', d); } catch {}
  syncDensitySeg();
  renderViz();
}
function syncDensitySeg() {
  document.querySelectorAll('.seg button[data-density]').forEach(x =>
    x.setAttribute('aria-pressed', x.dataset.density === STATE.density ? 'true' : 'false'));
}

function maxDepth(n) {
  if (!n.children.length) return 1;
  return 1 + Math.max(...n.children.map(maxDepth));
}

// The one filter predicate, shared by the detail SVG and the compact strip
// so a tag pill or a search dims the same blocks in both densities.
function dimmedByFilter(node) {
  if (STATE.tagFilter && !nodePassesTag(node, STATE.tagFilter)) return true;
  if (STATE.searchRe) {
    const m = nodeMatches(node, STATE.searchRe);
    if (!m.self && !m.descendant) return true;
  }
  return false;
}

function tickLaneHeight(node, innerW, innerH) {
  return innerH >= 30 && node.children.some(c => c.size * innerW / node.size < 6) ? 5 : 0;
}

function drawTicks(svg, node, x, y, w, h, css) {
  const groups = [];
  for (const child of node.children) {
    if (child.size * w / node.size >= 6) continue;
    const left = Math.max(x, Math.min(x + w - 6, x + (child.start - node.start) * w / node.size));
    const last = groups[groups.length - 1];
    if (last && left < last.right) {
      last.right = Math.max(last.right, left + 6);
      last.nodes.push(child);
    } else groups.push({ left, right: left + 6, nodes: [child] });
  }
  for (const group of groups) {
    const first = group.nodes[0];
    const g = svg.append('g')
      .attr('class', 'viz-block viz-tick' +
        (group.nodes.every(n => dimmedByFilter(n)) ? ' dim-filter' : '') +
        (group.nodes.some(n => n.kind === 'reservation') ? ' is-reservation' : '') +
        (group.nodes.some(n => SERVER.conflicts.some(pair => pair.includes(n.cidr))) ? ' conflict' : ''))
      .attr('data-cidr', first.cidr)
      .attr('data-cidrs', JSON.stringify(group.nodes.map(n => n.cidr)))
      .attr('data-count', group.nodes.length);
    g.append('rect').attr('class', 'body')
      .attr('x', group.left).attr('y', y).attr('width', group.right - group.left)
      .attr('height', h).attr('fill', fillFor(first, css));
    if (group.nodes.length > 1) {
      g.append('text').attr('x', (group.left + group.right) / 2).attr('y', y + h - 0.5)
        .style('fill', labelInk(fillFor(first, css))).text(group.nodes.length);
    }
    bindHover(g.node(), first, group.nodes);
  }
}

function drawNode(svg, node, x, y, w, h, depth, supernetRoot, css) {
  const padTop = depth === 0 ? 22 : 16;
  const pad = 2;
  const innerY = y + padTop;
  const innerH = Math.max(0, h - padTop - pad);

  // Filter-based dim (tag-filter pill, search) is baked in here. Selection-
  // based dim is applied separately by applySelectionVisual() so a click
  // doesn't have to rebuild the SVG to update which blocks are dimmed.
  const dimByFilter = dimmedByFilter(node);
  const inConflict = SERVER.conflicts.some(([a,b]) => a === node.cidr || b === node.cidr);
  const g = svg.append('g').attr('class', 'viz-block' +
    (node.kind === 'supernet'    ? ' is-supernet'    : '') +
    (node.kind === 'reservation' ? ' is-reservation' : '') +
    (inConflict ? ' conflict' : '') +
    (dimByFilter ? ' dim-filter' : ''));
  g.attr('data-cidr', node.cidr);

  const fill = node.kind === 'supernet'    ? css.supernet
            : node.kind === 'reservation' ? css.bg3
            : STATE.colorMode === 'tag'   ? primaryTagColor(effectiveTags(node))
            : STATE.colorMode === 'util'  ? utilColor(node)
            :                               css.used;

  g.append('rect')
    .attr('class', 'body')
    .attr('x', depth === 0 ? x + pad : x).attr('y', y + pad)
    .attr('width', depth === 0 ? Math.max(0, w - 2*pad) : Math.max(1, w))
    .attr('height', Math.max(0, h - 2*pad))
    .attr('rx', 3)
    .attr('fill', fill)
    .attr('stroke', node.kind === 'supernet' ? css.line : 'rgba(0,0,0,0.2)')
    .attr('stroke-width', 1);

  const label = fitCidrLabel(node.cidr, w, node._parent && node._parent.cidr);
  if (label) {
    g.append('text')
      .attr('x', x + 8).attr('y', y + 14)
      .attr('font-weight', '600')
      // reservations keep their warn-yellow from the stylesheet: that colour
      // is the semantic cue, and it already clears 9.9:1 on the fill.
      .style('fill', node.kind === 'reservation' ? null : labelInk(fill))
      .text(label);
    if (node.name) {
      const nm = node.name.length > 28 ? node.name.slice(0, 26) + '…' : node.name;
      // Name only if cidr + gap + name all fit inside the block.
      if (cidrLen(label) + 12 + cidrLen(nm) + LABEL_PAD <= w) {
        g.append('text')
          .attr('x', x + 8).attr('y', y + 14)
          .attr('text-anchor', 'start')
          .style('fill', node.kind === 'reservation' ? null : labelInk(fill))
          .attr('font-weight', '400')
          .attr('opacity', 0.75)
          .attr('dx', cidrLen(label) + 12)
          .text(nm);
      }
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

  const laneH = tickLaneHeight(node, innerW, innerH);
  const contentH = innerH - laneH;
  for (const p of pieces) {
    const pw = p.size * scale;
    const px = innerX + (p.start - parentInfo.start) * scale;

    if (p.kind === 'free') {
      const fg = svg.append('g')
        .attr('class', 'viz-block is-free' +
          (STATE.proposals && STATE.proposals.some(pp => pp.cidr === p.cidr) ? ' proposed' : ''))
        .attr('data-cidr', p.cidr);
      fg.append('rect')
        .attr('class', 'body')
        .attr('x', px).attr('y', innerY)
        .attr('width', pw)
        .attr('height', contentH)
        .attr('rx', 2);
      const fl = fitCidrLabel(p.cidr, pw, node.cidr);
      if (fl) {
        fg.append('text')
          .style('fill', labelInk(css.free))
          .attr('x', px + 5).attr('y', innerY + 13)
          .attr('opacity', 0.7)
          .text(fl);
      }
      bindHoverFree(fg.node(), p, node);
    } else {
      drawNode(svg, p.node, px, innerY, pw, contentH, depth + 1, supernetRoot, css);
    }
  }
  if (laneH) drawTicks(svg, node, innerX, innerY + contentH, innerW, laneH, css);
}

function drawProposalOverlays(svg, root, x, y, w, h, css) {
  if (!STATE.proposals || !STATE.proposals.length) return;
  const rootInfo = cidrInfo(root.cidr);
  for (const p of STATE.proposals) {
    if (!p.cidr) continue;
    const pi = cidrInfo(p.cidr);
    if (pi.start < rootInfo.start || pi.end > rootInfo.end) continue;

    // reuse exact matches: their proportional geometry already accounts
    // for any space taken by the tick lane.
    const existing = svg.node().querySelector(
      `.viz-block[data-cidr="${CSS.escape(p.cidr)}"]`
    );
    if (existing) {
      existing.classList.add('proposed');
      continue;
    }

    let host = root, hostX = x, hostY = y, hostW = w, hostH = h;
    outer: while (true) {
      for (const c of host.children) {
        const ci = cidrInfo(c.cidr);
        if (pi.start >= ci.start && pi.end <= ci.end) {
          const padTop = (host === root) ? 22 : 16;
          const pad = 2;
          const innerY = hostY + padTop;
          const availableH = Math.max(0, hostH - padTop - pad);
          const innerH = availableH - tickLaneHeight(host, Math.max(0, hostW - 2 * pad), availableH);
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
    const availableH = Math.max(0, hostH - padTop - pad);
    const innerH = availableH - tickLaneHeight(host, Math.max(0, hostW - 2 * pad), availableH);
    const innerX = hostX + pad;
    const innerW = Math.max(0, hostW - 2 * pad);
    const hostInfo = cidrInfo(host.cidr);
    const scale = innerW / hostInfo.size;
    const px = innerX + (pi.start - hostInfo.start) * scale;
    // a one-pixel floor keeps previews visible without moving adjacent space.
    const pw = Math.max(pi.size * scale, 1);

    const og = svg.append('g').attr('class', 'viz-block proposed').attr('data-cidr', p.cidr);
    og.append('rect')
      .attr('class', 'body')
      .attr('x', px).attr('y', innerY)
      .attr('width', pw)
      .attr('height', innerH)
      .attr('rx', 2);
    if (pw > 50) {
      og.append('text')
        .attr('x', px + 5).attr('y', innerY + 13)
        .attr('fill', css.acc)
        .attr('font-weight', '600')
        .text('▸ ' + p.cidr);
    }
  }
}

function utilColor(nodeOrPct) {
  const pct = typeof nodeOrPct === 'number'
    ? nodeOrPct
    : totalAddresses(nodeOrPct) > 0
      ? (totalAddresses(nodeOrPct) - subtreeFree(nodeOrPct).total) / totalAddresses(nodeOrPct)
      : 0;
  // lightness carries utilization even when hue cannot be distinguished.
  return `oklch(${0.82 - 0.48 * Math.max(0, Math.min(1, pct))} 0.07 260)`;
}
function cidrLen(c) { return c.length * 6.6; }

// Direction A — gate labels on the LABEL's width, not the block's. A CIDR
// label is ~92px at 10px mono, so the old "block > 60px" rule let every
// 61–100px block spill its label into the neighbour. Try the full CIDR,
// then a short form that drops the octets shared with the parent
// (".24.0/21"), else no label — hover still shows everything.
const LABEL_PAD = 10;
// Elide only the leading octets the PARENT already establishes: a /16 parent
// pins two, a /8 pins one. Dropping a fixed two octets made siblings
// ambiguous — 10.0.0.0/16 and 10.1.0.0/16 both rendered as ".0.0/16" under a
// /8. With no parent context we don't shorten at all.
function shortCidr(cidr, parentCidr) {
  if (!parentCidr) return '';
  const fixed = Math.min(3, Math.floor(cidrInfo(parentCidr).prefix / 8));
  if (fixed < 1) return '';
  const [ip, p] = cidr.split('/');
  const oct = ip.split('.'), pOct = parentCidr.split('/')[0].split('.');
  for (let i = 0; i < fixed; i++) if (oct[i] !== pOct[i]) return '';
  return '.' + oct.slice(fixed).join('.') + '/' + p;
}
function fitCidrLabel(cidr, w, parentCidr) {
  if (cidrLen(cidr) + LABEL_PAD <= w) return cidr;
  const s = shortCidr(cidr, parentCidr);
  if (s && cidrLen(s) + LABEL_PAD <= w) return s;
  return '';
}

//==========================================================
//  Selection + tooltips
//==========================================================

// Lightweight pass that toggles the `selected` and selection-driven `dim`
// classes on existing tree rows and viz blocks — no full re-render. Called
// from selectCidr (so a click is cheap on large plans) and once at the
// end of every renderViz so freshly-built blocks pick up the current
// selection state. dim-filter classes (set by drawNode based on tag /
// search filters) are left alone; CSS treats either dim class as
// equivalent.
function applySelectionVisual() {
  const sel = STATE.selectedCidr;
  // Tree rows
  for (const el of treeEl.querySelectorAll('.node')) {
    el.classList.toggle('selected', el.dataset.cidr === sel);
  }
  // Viz blocks. Skip .proposed overlays — they have their own dashed-
  // pulse treatment and sit on top of an existing free block with the
  // same data-cidr, so without this exclusion clicking a free block
  // would mark *both* the block and its proposal overlay as selected.
  for (const el of document.querySelectorAll('#viz .viz-block:not(.proposed)')) {
    const cidr = el.getAttribute('data-cidr');
    const cidrs = el.dataset.cidrs ? JSON.parse(el.dataset.cidrs) : [cidr];
    el.classList.toggle('selected', !!sel && cidrs.includes(sel));
    const isLineage = !sel || cidrs.some(c => c === sel || isSubnetOf(c, sel) || isSubnetOf(sel, c));
    el.classList.toggle('dim', !!sel && !isLineage);
  }
  // Compact-mode rows carry the same selected / lineage-dim treatment.
  for (const el of document.querySelectorAll('#viz .viz-row[data-cidr]')) {
    const cidr = el.dataset.cidr;
    el.classList.toggle('selected', !!sel && cidr === sel);
    const isLineage = !sel || cidr === sel || isSubnetOf(cidr, sel) || isSubnetOf(sel, cidr);
    el.classList.toggle('dim', !!sel && !isLineage);
  }
}

function selectCidr(cidr) {
  STATE.selectedCidr = cidr;
  document.getElementById('statSel').textContent = `sel: ${cidr}`;
  applySelectionVisual();
  const treeNode = treeEl.querySelector(`.node[data-cidr="${CSS.escape(cidr)}"]`);
  if (treeNode) treeNode.scrollIntoView({block: 'nearest'});
}

const tooltip = document.getElementById('tooltip');
function bindHover(el, node, nodes = [node]) {
  el.addEventListener('mouseenter', (e) => {
    el.classList.add('hover');
    const records = nodes.length > 1
      ? `<div class="tip-name">${nodes.length} records · click repeatedly to cycle</div>` +
        nodes.slice(0, 8).map(n => `<div>${escapeHtml(n.cidr)} · ${escapeHtml(n.name || 'unnamed')}</div>`).join('') +
        (nodes.length > 8 ? `<div>+${nodes.length - 8} more</div>` : '')
      : '';
    showTooltip(e, tooltipForNode(node) + records);
  });
  el.addEventListener('mousemove', (e) => positionTooltip(e));
  el.addEventListener('mouseleave', () => {
    el.classList.remove('hover');
    hideTooltip();
  });
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    const selected = nodes.findIndex(n => n.cidr === STATE.selectedCidr);
    const target = nodes[(selected + 1) % nodes.length];
    selectCidr(target.cidr);
    openDetail(target.cidr);   // mirror tree-row click: open the editor too
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
  const used = totalAddresses(node) - subtreeFree(node).total, total = totalAddresses(node);
  const pct = total > 0 ? Math.round(100 * used / total) : 0;
  const ownSet = new Set(node.tags || []);
  const ownChips = (node.tags || []).map(t =>
    `<span class="tag clickable" data-tag="${t}" title="Click to filter by ${t}"><span class="dot" style="background:${tagColor(t)}"></span>${t}</span>`
  ).join('');
  const inherited = inheritedTags(node);
  const inheritedChips = inherited.map(t =>
    `<span class="tag clickable inherited" data-tag="${t}" title="Inherited from a parent · click to filter"><span class="dot" style="background:${tagColor(t)}"></span>${t}</span>`
  ).join('');
  // When both kinds are present, insert a tiny "inherited" label so the
  // ↑-prefixed chips read as a labelled group rather than just "faded
  // chips at the end."
  const inheritedDivider = (ownChips && inheritedChips)
    ? '<span class="tip-tags-divider">inherited</span>'
    : '';
  const tagBlock = (ownChips || inheritedChips)
    ? `<div class="tip-tags">${ownChips}${inheritedDivider}${inheritedChips}</div>`
    : '';
  const usedRow = node.kind === 'reservation'
    ? `<span class="k">status</span><span class="v" style="color:var(--warn)">reserved · excluded from carve</span>`
    : `<span class="k">used</span><span class="v">${fmtBytes(used)} (${pct}%)</span>`;
  return `
    <div class="tip-cidr"${node.kind==='reservation' ? ' style="color:var(--warn)"' : ''}>${node.cidr}</div>
    <div class="tip-name">${node.name || '<i style="color:var(--fg-2)">unnamed</i>'}</div>
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

// Escapes for BOTH text and attribute contexts. The compact strip
// interpolates plan data into title="…", where an unescaped quote in an
// imported name ("EA-Network Name" comes straight from someone else's CSV)
// would close the attribute and let the rest parse as markup.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
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
  // Forced-cidr mode (free-block click): exactly one proposal at the
  // clicked spot, regardless of stale repeat count or selected-parent
  // set. Bypassing proposeForParent here also avoids the case where a
  // previous "repeat: 4" carve session leaves N-1 extra proposals
  // scattered around the same supernet.
  if (forcedCidr && forcedParent) {
    SELECTED_PARENTS.clear();
    SELECTED_PARENTS.add(forcedParent);
    populateParents();
    const parentNode = TREE.items.find(i => i.cidr === forcedParent);
    STATE.proposals = [{ parent: forcedParent, cidr: forcedCidr, parentNode }];
    renderProposals();
    renderViz();
    return;
  }

  const mode = document.querySelector('#carveMode button[aria-pressed="true"]').dataset.mode;
  const value = +document.getElementById('carveValue').value;
  const repeat = Math.max(1, Math.min(64, +document.getElementById('carveRepeat').value || 1));

  STATE.proposals = [...SELECTED_PARENTS].flatMap(p => proposeForParent(p, mode, value, repeat));

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

  // Wire the copy button. Output is TSV with a header so it pastes into
  // a spreadsheet as columns AND still reads as tabular text in a chat
  // / ticket. (The Export button in the topbar uses Infoblox CSV — that's
  // for whole-plan handoff to other tools; this is for ad-hoc paste.)
  const copyBtn = document.getElementById('proposalsCopyBtn');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const fits = enriched.filter(p => p.cidr);
      const lines = ['cidr\tname\tparent_cidr\tparent_name\tsize\tprefix'];
      for (const p of fits) {
        const pi = cidrInfo(p.cidr);
        const parentItem = TREE.items.find(it => it.cidr === p.parent);
        const parentName = (parentItem && parentItem.name) || '';
        lines.push([
          p.cidr,
          p.childName || '',
          p.parent,
          parentName,
          pi.size,
          `/${pi.prefix}`,
        ].join('\t'));
      }
      copyText(lines.join('\n'), `copied ${fits.length} row${fits.length === 1 ? '' : 's'}`);
    });
  }

  document.getElementById('commitCount').textContent = okCount ? `(${okCount})` : '';
  document.getElementById('carveCommitBtn').disabled = okCount === 0;
}

async function commitCarve() {
  const btn = document.getElementById('carveCommitBtn');
  if (btn.disabled) return;   // already in-flight, or no proposals (renderProposals disabled it)
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

  btn.disabled = true;   // hold the lock across the round-trip
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
      // refresh() rebuilds + renderProposals re-disables the button
      // (proposals are now empty) — so we deliberately *don't* re-enable
      // in a finally.
      await refresh();
    } else {
      toast(`commit failed: ${data.error || 'unknown'}`, 'err');
      btn.disabled = false;   // proposals remain — let the user retry
    }
  } catch (e) {
    toast(`commit failed: ${e}`, 'err');
    btn.disabled = false;
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

// Run `fn` with `btn` disabled, restoring on completion. Bails out
// immediately if the button is already disabled — protects every
// async POST handler from rapid double-clicks producing two requests.
async function withButtonLock(btn, fn) {
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  try { return await fn(); }
  finally { btn.disabled = false; }
}

async function addRecord() {
  const cidrInput = document.getElementById('addCidr');
  // Clear any previous error highlight before the next round-trip.
  cidrInput.classList.remove('field-error');
  const kind = document.querySelector('[data-add-kind][aria-pressed="true"]').dataset.addKind;
  const cidr = cidrInput.value.trim();
  const name = document.getElementById('addName').value.trim();
  const desc = document.getElementById('addDesc').value.trim();
  const tags = document.getElementById('addTags').value;
  if (!cidr) {
    cidrInput.classList.add('field-error');
    cidrInput.focus();
    toast('cidr is required', 'err');
    return;
  }
  const { ok, data } = await postJSON(URL_ADD, { kind, cidr, name, description: desc, tags });
  if (!ok) {
    // Server rejected — almost always a CIDR problem (invalid, dup, overlap).
    cidrInput.classList.add('field-error');
    cidrInput.focus();
    cidrInput.select();
    toast(data.error || 'add failed', 'err');
    return;
  }
  toast(`added ${cidr}`, 'ok');
  cidrInput.value = '';
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
  // If the panel is already open on a *different* cidr, drop the `on`
  // class briefly so the slide-in transition replays for the new
  // content. The final add('on') below is deferred via rAF in that
  // case; same-cidr re-clicks paint synchronously with no bounce.
  const wasOpen = detail.classList.contains('on');
  const needsReplay = wasOpen && STATE.detailCidr !== cidr;
  if (needsReplay) detail.classList.remove('on');
  STATE.detailCidr = cidr;
  const used = totalAddresses(node) - subtreeFree(node).total, total = totalAddresses(node);
  const pct = total > 0 ? Math.round(100 * used / total) : 0;
  document.getElementById('detailKind').textContent = `${node.kind} detail`;
  // Sync the type segmented control to this record's current kind. saveDetail
  // diffs current vs displayed kind to decide whether to call /reclassify.
  for (const b of document.querySelectorAll('#detailKindSeg button')) {
    b.setAttribute('aria-pressed', b.dataset.kind === node.kind ? 'true' : 'false');
  }
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
  detail.setAttribute('aria-hidden', 'false');
  // When replaying the transition, defer the `on` flip to the next frame
  // so the browser actually animates the off→on change. Otherwise both
  // states land in the same paint and the slide-in is skipped.
  if (needsReplay) {
    requestAnimationFrame(() => detail.classList.add('on'));
  } else {
    detail.classList.add('on');
  }
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
  const newKind = document
    .querySelector('#detailKindSeg button[aria-pressed="true"]')
    ?.dataset.kind;
  const currentKind = nodeOf(cidr)?.kind;

  // Reclassify first when the type changed, so /edit then runs against
  // the record in its final bucket. Skipped entirely when the kind is
  // unchanged — saving common edits costs the same one POST as before.
  if (newKind && newKind !== currentKind) {
    const r = await postJSON(URL_RECLASSIFY, { cidr, new_kind: newKind });
    if (!r.ok) { toast(r.data.error || 'reclassify failed', 'err'); return; }
  }
  const { ok, data } = await postJSON(URL_EDIT, { cidr, name, description: desc, tags });
  if (!ok) { toast(data.error || 'save failed', 'err'); return; }
  toast(`saved ${cidr}`, 'ok');
  closeDetail();
  await refresh();
}

// Make the type seg behave like the other segmented controls (single
// active pressed state). saveDetail reads aria-pressed to determine
// the user's choice.
for (const b of document.querySelectorAll('#detailKindSeg button')) {
  b.addEventListener('click', () => {
    for (const x of document.querySelectorAll('#detailKindSeg button')) {
      x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
    }
  });
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
    usedAddrs  += r.size - subtreeFree(r).total;
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
document.querySelectorAll('.seg button[data-density]').forEach(b => {
  b.addEventListener('click', () => setDensity(b.dataset.density));
});
syncDensitySeg();
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

document.getElementById('addSubmit').addEventListener('click', (e) =>
  withButtonLock(e.currentTarget, addRecord));
document.getElementById('addReset').addEventListener('click', resetAdd);
// Drop the field-error highlight as soon as the user starts editing the
// offending field — they've acknowledged the error, no point keeping the
// red border.
document.getElementById('addCidr').addEventListener('input', (e) =>
  e.currentTarget.classList.remove('field-error'));

document.getElementById('detailClose').addEventListener('click', closeDetail);
document.getElementById('detailCancel').addEventListener('click', closeDetail);
document.getElementById('detailCidr').addEventListener('click', () => copyText(document.getElementById('detailCidr').textContent));
document.getElementById('detailSave').addEventListener('click', (e) =>
  withButtonLock(e.currentTarget, saveDetail));
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
  STATE.searchRe = null;
  document.getElementById('searchCopyBtn').style.display = 'none';
  renderTree(); renderViz();
  searchMatches.textContent = '';
}
document.getElementById('searchBtn').addEventListener('click', openSearch);
document.getElementById('searchCloseBtn').addEventListener('click', closeSearch);
searchInput.addEventListener('input', () => {
  STATE.search = searchInput.value.trim();
  STATE.searchRe = compileSearch(STATE.search);
  let count = 0;
  if (STATE.searchRe) {
    for (const it of TREE.items) if (nodeMatches(it, STATE.searchRe).self) count++;
  }
  searchMatches.textContent = STATE.searchRe ? `${count} match${count === 1 ? '' : 'es'}` : '';
  document.getElementById('searchCopyBtn').style.display =
    (STATE.searchRe && count > 0) ? '' : 'none';
  renderTree(); renderViz();
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSearch();
});

// Copy every matched node as TSV with header — pastes into a spreadsheet
// or sits cleanly in a ticket. Uses the same regex the search uses, so
// the copy and the on-screen highlights agree.
document.getElementById('searchCopyBtn').addEventListener('click', () => {
  if (!STATE.searchRe) return;
  const hits = TREE.items.filter(it => nodeMatches(it, STATE.searchRe).self);
  if (!hits.length) return;
  hits.sort((a, b) => a.start - b.start);
  const lines = ['cidr\tname\tkind\tparent_cidr\tparent_name\ttags\tdescription'];
  for (const it of hits) {
    const par = parentOf(it.cidr);
    lines.push([
      it.cidr,
      it.name || '',
      it.kind,
      par ? par.cidr : '',
      par && par.name ? par.name : '',
      effectiveTags(it).join(','),
      (it.description || '').replace(/[\t\n\r]/g, ' '),  // keep TSV intact
    ].join('\t'));
  }
  copyText(lines.join('\n'), `copied ${hits.length} match${hits.length === 1 ? '' : 'es'}`);
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
//  Export plan as JSON (full fidelity — supernets, allocations, reservations)
//==========================================================
document.getElementById('exportBtn').addEventListener('click', () => {
  const payload = {
    name:         PLAN.name,
    supernets:    PLAN.supernets    || [],
    allocations:  PLAN.allocations  || [],
    reservations: PLAN.reservations || [],
  };
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${PLAN.name || 'plan'}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast(`exported ${PLAN.name}.json`, 'ok');
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
    lg.innerHTML = top.map(t => `<span><span class="swatch" style="background:${tagColor(t)}"></span>${t}</span>`).join('') || '<span style="color:var(--fg-2)">no tags</span>';
  } else if (STATE.colorMode === 'util') {
    lg.innerHTML = `
      <span><span class="swatch" style="background:${utilColor(0)}"></span>0%</span>
      <span><span class="swatch" style="background:${utilColor(0.5)}"></span>50%</span>
      <span><span class="swatch" style="background:${utilColor(1)}"></span>100%</span>`;
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
  if (e.key === 'd') setDensity(STATE.density === 'compact' ? 'detail' : 'compact');
  if (e.key === '/') { e.preventDefault(); openSearch(); }
});

window.addEventListener('resize', () => { clearTimeout(window.__rs); window.__rs = setTimeout(renderViz, 120); });

// ---- init ----
refresh();
})();
