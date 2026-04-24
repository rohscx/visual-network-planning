// D3 nested-rectangle viz of a plan tree.
// Each supernet gets its own "treemap" row; children are drawn proportional to
// their address-space share inside the parent rectangle. Free space is drawn
// in gray using the CIDRs emitted by the backend.

(function () {
  const container = document.getElementById('viz');
  if (!container) return;
  const url = container.dataset.treeUrl;

  fetch(url)
    .then((r) => r.json())
    .then((tree) => render(container, tree))
    .catch((err) => {
      container.textContent = 'Failed to load viz: ' + err;
    });

  function render(el, tree) {
    el.innerHTML = '';
    if (!tree.roots || tree.roots.length === 0) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'No supernets yet — add one to see the visualization.';
      el.appendChild(p);
      return;
    }
    const width = el.clientWidth || 600;
    for (const root of tree.roots) {
      const height = rootHeight(root);
      const svg = d3.select(el).append('svg')
        .attr('width', width)
        .attr('height', height)
        .style('margin-bottom', '12px')
        .style('display', 'block')
        .style('background', '#fafbfd')
        .style('border', '1px solid #d8d8e0')
        .style('border-radius', '4px');
      drawNode(svg, root, 0, 0, width, height, 0);
    }
  }

  function rootHeight(node) {
    const depth = maxDepth(node);
    return Math.max(160, 80 + depth * 70);
  }
  function maxDepth(node) {
    if (!node.children || node.children.length === 0) return 1;
    return 1 + Math.max(...node.children.map(maxDepth));
  }

  // Convert a CIDR like "10.0.1.0/24" to a BigInt range [start, end).
  function cidrRange(cidr) {
    const [ip, plen] = cidr.split('/');
    const prefix = parseInt(plen, 10);
    const parts = ip.split('.').map((p) => parseInt(p, 10));
    const addr = ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
    const size = Math.pow(2, 32 - prefix);
    return { start: addr, size };
  }

  function drawNode(svg, node, x, y, w, h, depth) {
    const padding = depth === 0 ? 2 : 1;
    const labelHeight = 18;
    const bodyY = y + labelHeight;
    const bodyH = Math.max(0, h - labelHeight - padding);

    const g = svg.append('g').attr('class', 'viz-block');

    // Background rect for this node.
    const cls = node.is_supernet ? 'supernet' : 'used';
    g.append('rect')
      .attr('class', cls)
      .attr('x', x + padding)
      .attr('y', y + padding)
      .attr('width', Math.max(0, w - 2 * padding))
      .attr('height', Math.max(0, h - 2 * padding))
      .attr('rx', 3);

    // Label at the top of the rect.
    g.append('text')
      .attr('x', x + 6)
      .attr('y', y + 13)
      .text(`${node.cidr}${node.name ? '  ' + node.name : ''}`);

    if (bodyH < 8) return;

    // Sort children+free together by network address so layout matches hierarchy.
    const pieces = [];
    const parentRange = cidrRange(node.cidr);
    for (const c of (node.children || [])) {
      const r = cidrRange(c.cidr);
      pieces.push({ kind: 'child', start: r.start, size: r.size, node: c });
    }
    for (const f of (node.free || [])) {
      const r = cidrRange(f);
      pieces.push({ kind: 'free', start: r.start, size: r.size, cidr: f });
    }
    pieces.sort((a, b) => a.start - b.start);

    const innerX = x + padding;
    const innerW = w - 2 * padding;
    const scale = innerW / parentRange.size;

    for (const piece of pieces) {
      const pw = piece.size * scale;
      const px = innerX + (piece.start - parentRange.start) * scale;
      if (piece.kind === 'free') {
        const fg = svg.append('g').attr('class', 'viz-block');
        fg.append('rect')
          .attr('class', 'free')
          .attr('x', px)
          .attr('y', bodyY)
          .attr('width', Math.max(0, pw - padding))
          .attr('height', bodyH)
          .attr('rx', 2);
        if (pw > 40) {
          fg.append('text')
            .attr('class', 'free-label')
            .attr('x', px + 4)
            .attr('y', bodyY + 13)
            .text(piece.cidr);
        }
      } else {
        drawNode(svg, piece.node, px, bodyY, pw, bodyH, depth + 1);
      }
    }
  }
})();
