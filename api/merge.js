// api/merge.js — Vercel serverless function
// PGN Chapter Merger — mirrors merge-pgn.py / python-chess logic in pure JS

// ─── SANITIZER ────────────────────────────────────────────────────────────────

function sanitizePgn(raw) {
  let s = raw;
  s = s.replace(/\[(\w+)\s+"?\[object Object\]"?\]/g, '[$1 "?"]');
  s = s.replace(/(\])\s*(\[)/g, '$1\n$2');
  s = s.replace(/\b(\d+)\s+(?=[KQRBNP][a-h1-8]|[a-h][1-8a-h]|O-O)/g, '$1. ');
  s = s.replace(/(\d+)\.{2,}/g, '$1.');
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

// ─── PGN SPLITTER ─────────────────────────────────────────────────────────────

function splitGames(text) {
  const games = [];
  let current = [];
  for (const line of text.split('\n')) {
    if (/^\s*\[Event\s+"/i.test(line) && current.length > 0) {
      const g = current.join('\n').trim();
      if (g) games.push(g);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length) {
    const g = current.join('\n').trim();
    if (g) games.push(g);
  }
  return games;
}

// ─── HEADER PARSER ────────────────────────────────────────────────────────────

function parseHeaders(gameText) {
  const headers = {};
  const re = /\[(\w+)\s+"([^"]*)"\]/g;
  let m;
  while ((m = re.exec(gameText)) !== null) headers[m[1]] = m[2];
  return headers;
}

function extractMovesText(gameText) {
  const lines = gameText.split('\n');
  let pastHeaders = false;
  const out = [];
  for (const line of lines) {
    if (!line.trim().startsWith('[')) pastHeaders = true;
    if (pastHeaders) out.push(line);
  }
  return out.join(' ').trim();
}

function hasRealMoves(movesText) {
  if (/--/.test(movesText)) return true;
  return movesText.replace(/\*/g, '').replace(/\s+/g, '').length > 0;
}

// ─── SAN VALIDATOR ───────────────────────────────────────────────────────────

function looksLikeSan(tok) {
  if (!tok) return false;
  if (/^O-O(-O)?[+#]?$/.test(tok)) return true;
  if (/^[a-h][1-8][+#]?$/.test(tok)) return true;
  if (/^[a-h]x[a-h][1-8](=[KQRBN])?[+#]?$/.test(tok)) return true;
  if (/^[a-h][1-8]?x?[a-h][1-8](=[KQRBN])?[+#]?$/.test(tok)) return true;
  if (/^[KQRBN][a-h1-8]?[a-h1-8]?x?[a-h][1-8][+#]?$/.test(tok)) return true;
  return false;
}

// ─── COMMENT MERGING (from merge-pgn.py) ─────────────────────────────────────

function mergeCommentText(t1, t2) {
  t1 = (t1 || '').trim();
  t2 = (t2 || '').trim();
  if (!t1) return t2;
  if (!t2) return t1;
  if (t1.toLowerCase() === t2.toLowerCase()) return t1;
  if (t2.toLowerCase().includes(t1.toLowerCase())) return t2;
  if (t1.toLowerCase().includes(t2.toLowerCase())) return t1;
  return t1 + '\n\n' + t2;
}

// ─── MOVE NODE ────────────────────────────────────────────────────────────────

class MoveNode {
  constructor(san, moveNum, isBlack, parent) {
    this.san = san;           // null for root
    this.moveNum = moveNum || 0;
    this.isBlack = isBlack || false;
    this.comments = [];
    this.nags = [];
    this.variations = [];     // [0]=mainline, [1+]=alternatives
    this.parent = parent || null;
  }
}

// ─── PGN PARSER ──────────────────────────────────────────────────────────────
// Recursive descent matching python-chess read_game() behavior exactly.
// '(' always branches from the PARENT of the current node.

function parsePgn(src) {
  const root = new MoveNode(null, 0, false, null);
  _parse(src, { i: 0 }, root, 1, false);
  return root;
}

function _skipWS(src, pos) {
  while (pos.i < src.length && /[\s\r\n]/.test(src[pos.i])) pos.i++;
}

function _readComment(src, pos) {
  pos.i++; // skip '{'
  const start = pos.i;
  let depth = 1;
  while (pos.i < src.length) {
    if (src[pos.i] === '{') depth++;
    else if (src[pos.i] === '}') { depth--; if (depth === 0) break; }
    pos.i++;
  }
  const text = src.slice(start, pos.i).trim();
  if (pos.i < src.length) pos.i++; // skip '}'
  return text;
}

function _nextTok(src, pos) {
  _skipWS(src, pos);
  if (pos.i >= src.length) return null;
  const ch = src[pos.i];
  if (ch === '{' || ch === '(' || ch === ')') return null;
  if (ch === '$') {
    let j = pos.i + 1;
    while (j < src.length && /\d/.test(src[j])) j++;
    const t = src.slice(pos.i, j); pos.i = j; return t;
  }
  if (ch === '!' || ch === '?') {
    let j = pos.i;
    while (j < src.length && (src[j] === '!' || src[j] === '?')) j++;
    const t = src.slice(pos.i, j); pos.i = j; return t;
  }
  const rest = src.slice(pos.i);
  let m;
  if ((m = rest.match(/^(\d+)\.{1,3}/))) { pos.i += m[0].length; return m[0]; }
  if ((m = rest.match(/^(1-0|0-1|1\/2-1\/2|\*)/))) { pos.i += m[0].length; return m[0]; }
  if (rest.slice(0, 2) === '--') { pos.i += 2; return '--'; }
  if ((m = rest.match(/^(O-O-O|O-O)[+#]?/))) { pos.i += m[0].length; return m[0]; }
  if ((m = rest.match(/^[KQRBNP]?[a-h]?[1-8]?x?[a-h][1-8](?:=[KQRBN])?[+#]?/)) && looksLikeSan(m[0])) {
    pos.i += m[0].length; return m[0];
  }
  pos.i++; return null;
}

function _parse(src, pos, parentNode, mn, ib) {
  let cur = parentNode;
  let moveNum = mn;
  let isBlack = ib;

  while (pos.i < src.length) {
    _skipWS(src, pos);
    if (pos.i >= src.length) break;
    const ch = src[pos.i];

    if (ch === '{') {
      const text = _readComment(src, pos);
      if (text) {
        const prev = cur.comments.join('\n\n');
        const merged = mergeCommentText(prev, text);
        cur.comments = merged ? [merged] : [];
      }
      continue;
    }

    if (ch === '(') {
      pos.i++; // consume '('
      // Variation is an alternative to `cur` — branch from cur's parent
      // with the same (moveNum, isBlack) as cur was played
      if (cur.parent !== null) {
        _parse(src, pos, cur.parent, cur.moveNum, cur.isBlack);
      } else {
        // cur is root, just parse into root
        _parse(src, pos, cur, moveNum, isBlack);
      }
      continue;
    }

    if (ch === ')') {
      pos.i++;
      return;
    }

    const tok = _nextTok(src, pos);
    if (tok === null) continue;

    if (/^(\*|1-0|0-1|1\/2-1\/2)$/.test(tok)) break;

    if (/^\d+\.{1,3}$/.test(tok)) {
      moveNum = parseInt(tok);
      isBlack = (tok.match(/\./g) || []).length >= 3;
      continue;
    }

    if (/^\$\d+$/.test(tok) || /^[!?]+$/.test(tok)) {
      cur.nags.push(tok);
      continue;
    }

    // It's a move
    const san = tok.replace(/[!?]+$/, '');
    const nag = tok.slice(san.length);

    let child = cur.variations.find(c => c.san === san && c.moveNum === moveNum && c.isBlack === isBlack);
    if (!child) {
      child = new MoveNode(san, moveNum, isBlack, cur);
      cur.variations.push(child);
    }
    if (nag && !child.nags.includes(nag)) child.nags.push(nag);

    cur = child;
    if (isBlack) { moveNum++; isBlack = false; } else { isBlack = true; }
  }
}

// ─── MERGE TREES ─────────────────────────────────────────────────────────────

function mergeTrees(target, source) {
  const merged = mergeCommentText(
    target.comments.join('\n\n'),
    source.comments.join('\n\n')
  );
  target.comments = merged ? [merged] : [];

  for (const nag of (source.nags || [])) {
    if (!target.nags.includes(nag)) target.nags.push(nag);
  }

  for (const srcChild of source.variations) {
    const existing = target.variations.find(
      c => c.san === srcChild.san && c.moveNum === srcChild.moveNum && c.isBlack === srcChild.isBlack
    );
    if (existing) {
      mergeTrees(existing, srcChild);
    } else {
      srcChild.parent = target;
      target.variations.push(srcChild);
    }
  }
}

// ─── SERIALIZE TREE → PGN ────────────────────────────────────────────────────
// Mirrors python-chess StringExporter exactly:
//   for each node: emit THIS move, then sibling alts in (), then recurse mainline child

function serialize(root) {
  const parts = [];
  _emitNode(root, parts, false, false);
  return parts.join(' ').replace(/  +/g, ' ').trim();
}

// Emit node and all its continuation
// inVariation: are we inside a (...) block? Only matters for the FIRST move (start of variation)
// forceNum: force showing move number (for black move after comment/variation)
function _emitNode(node, parts, inVariation, forceNum) {
  if (node.san == null) {
    // Root
    if (node.comments.length) {
      for (const c of node.comments) parts.push(`{${c}}`);
    }
    if (node.variations.length === 0) return;
    const [main, ...alts] = node.variations;
    // Emit main's header
    _emitHeader(main, parts, false, false);
    // Emit root-level sibling variations (alternatives to main) right after main's header
    for (const alt of alts) {
      const ap = [];
      _emitVariationContent(alt, ap);
      parts.push('(' + ap.join(' ').replace(/  +/g, ' ').trim() + ')');
    }
    // Whether the next black move (main's first child) needs ellipsis
    // Yes, if there were sibling alts rendered
    const nextForce = alts.length > 0 && main.variations.length > 0 && main.variations[0].isBlack;
    // Recurse into main's children
    _emitChildren(main, parts, false, nextForce);
    return;
  }
  _emitHeader(node, parts, inVariation, forceNum);
  _emitChildren(node, parts, false, false);
}

// Emit just the header of a node: move number (maybe) + san + nags + comments
function _emitHeader(node, parts, inVariation, forceNum) {
  let movePart;
  if (node.san === '--') {
    movePart = `${node.moveNum}. --`;
  } else {
    // Show move number if: white move always; black move if first in variation, forced, or
    // inVariation (only for the very first move of a variation)
    const showNum = !node.isBlack || inVariation || forceNum;
    if (showNum) {
      movePart = node.isBlack
        ? `${node.moveNum}... ${node.san}`
        : `${node.moveNum}. ${node.san}`;
    } else {
      movePart = node.san;
    }
  }
  if (node.nags.length) movePart += ' ' + node.nags.join(' ');
  parts.push(movePart);
  if (node.comments.length) {
    for (const c of node.comments) parts.push(`{${c}}`);
  }
}

// Emit the children of a node (mainline + sibling alternatives)
// afterSiblingAlt: was a sibling variation just emitted? (affects forceNum for next black)
function _emitChildren(node, parts, inVariation, externalForceNum) {
  if (node.variations.length === 0) return;

  const [main, ...alts] = node.variations;

  // For black main move: force num if node had comments, or if there are sibling alts,
  // or if an external force was passed in
  // forceNum: black needs number only after a COMMENT on the parent (not after alts, which come after the move)
  const forceNum = externalForceNum || (node.comments.length > 0 && main.isBlack);

  // Emit main child header (NOT in variation context — it's mainline)
  _emitHeader(main, parts, false, forceNum);

  // Emit sibling alternatives right after main's header
  for (const alt of alts) {
    const ap = [];
    _emitVariationContent(alt, ap);
    parts.push('(' + ap.join(' ').replace(/  +/g, ' ').trim() + ')');
  }

  // Next force: if main had comments or siblings, and main's first child is black
  const nextForce = (main.comments.length > 0 || alts.length > 0) &&
    main.variations.length > 0 && main.variations[0].isBlack;

  // Recurse into main's children
  _emitChildren(main, parts, false, nextForce);
}

// Emit a variation's full content (first move gets inVariation=true for the number)
function _emitVariationContent(node, parts) {
  // First move of variation always shows number
  _emitHeader(node, parts, true, false);
  // After first move, render children (NOT in variation context anymore)
  _emitChildren(node, parts, false, false);
}

// ─── CHAPTER CLASSIFICATION ──────────────────────────────────────────────────

const NO_MERGE_RE = /annotated\s+games?|model\s+games?|supplementary\s+games?/i;
const PLACEHOLDER_RE = /^(\?+|unknown|\?+\.\?+\.\?+)$/i;

function getChapterName(headers) {
  const candidates = [headers.Event, headers.White].filter(
    v => v && !PLACEHOLDER_RE.test(v.trim())
  );
  return (candidates[0] || '?').trim();
}

// ─── CORE MERGE PIPELINE ──────────────────────────────────────────────────────

function mergeChapters(rawPgn) {
  const chapterMap = new Map();
  const chapterOrder = [];
  const gameTexts = splitGames(rawPgn);

  for (let gt of gameTexts) {
    if (!gt.trim()) continue;
    let headers = parseHeaders(gt);
    if (gt.includes('[object Object]')) {
      gt = sanitizePgn(gt);
      headers = parseHeaders(gt);
    }

    const chapterName = getChapterName(headers);
    if (chapterName === '?') continue;

    const movesText = extractMovesText(gt);

    if (!hasRealMoves(movesText)) {
      if (!chapterMap.has(chapterName)) {
        chapterMap.set(chapterName, { headers, root: new MoveNode(null), noMerge: false });
        chapterOrder.push(chapterName);
      }
      continue;
    }

    const noMerge = NO_MERGE_RE.test(chapterName);
    let tree;
    try {
      tree = parsePgn(movesText);
    } catch (e) {
      try { tree = parsePgn(extractMovesText(sanitizePgn(gt))); }
      catch (e2) { tree = new MoveNode(null); }
    }

    if (noMerge) {
      const uniqueName = `${chapterName}__${chapterOrder.length}`;
      chapterMap.set(uniqueName, { headers, root: tree, noMerge: true, displayName: chapterName });
      chapterOrder.push(uniqueName);
    } else if (!chapterMap.has(chapterName)) {
      chapterMap.set(chapterName, { headers, root: tree, noMerge: false });
      chapterOrder.push(chapterName);
    } else {
      mergeTrees(chapterMap.get(chapterName).root, tree);
    }
  }

  const out = [];
  for (const key of chapterOrder) {
    const { headers, root, displayName } = chapterMap.get(key);
    const name = displayName || key;
    const cleanHeaders = {
      Event: name, Site: '?', Date: '????.??.??',
      Round: '?', White: '?', Black: '?', Result: '*'
    };
    let block = '';
    for (const [k, v] of Object.entries(cleanHeaders)) block += `[${k} "${v}"]\n`;
    block += '\n';
    let movetext = '';
    try {
      if (root && root instanceof MoveNode) movetext = serialize(root);
    } catch (e) {
      console.error('Serialization failed for chapter:', name, e);
    }
    block += (movetext ? movetext.trim() + ' ' : '') + '*';
    out.push(block);
  }
  return out.join('\n\n');
}

// ─── VERCEL HANDLER ──────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST')
    return res.status(405).end(JSON.stringify({ error: 'Method not allowed' }));

  try {
    const body = await new Promise((resolve, reject) => {
      const chunks = [];
      const timer = setTimeout(() => reject(new Error('Timeout reading body')), 25000);
      req.on('data', c => chunks.push(c));
      req.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString()); });
      req.on('error', e => { clearTimeout(timer); reject(e); });
    });

    let pgn, filename;
    try {
      const parsed = JSON.parse(body);
      pgn = parsed.pgn;
      filename = parsed.filename || 'output.pgn';
    } catch (e) {
      return res.status(400).end(JSON.stringify({ error: 'Invalid JSON body' }));
    }

    if (!pgn) return res.status(400).end(JSON.stringify({ error: 'No PGN provided' }));

    const merged = mergeChapters(pgn);
    const base = filename.replace(/\.pgn$/i, '');
    return res.status(200).end(JSON.stringify({ pgn: merged, filename: `${base} merged.pgn` }));
  } catch (err) {
    console.error('[merge] error:', err);
    return res.status(500).end(JSON.stringify({ error: String(err.message || err) }));
  }
};
