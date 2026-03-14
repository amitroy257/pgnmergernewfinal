// api/merge.js — Vercel serverless function
// PGN Chapter Merger — no external dependencies, crash-proof

// ─── SANITIZER ────────────────────────────────────────────────────────────────

function sanitizePgn(raw) {
  let s = raw;
  s = s.replace(/\[(\w+)\s+"?\[object Object\]"?\]/g, '[$1 "?"]');
  s = s.replace(/(\])\s*(\[)/g, '$1\n$2');
  s = s.replace(/\b(\d+)\s+(?=[KQRBNP][a-h1-8]|[a-h][1-8a-h]|O-O)/g, '$1. ');
  s = s.replace(/(\d+)\.{2,}/g, '$1.');
  s = s.replace(
    /(\{[^}]*)\}\s*\.?\s*([A-Z]?[a-h][a-h1-8x]?[1-8]?(?:=[KQRBN])?[+#]?|O-O(?:-O)?[+#]?)\s+(?=\d)/g,
    (_, pre, tok) => `${pre} ${tok}} `
  );
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
  return movesText.replace(/\*/g, '').replace(/\s+/g, '').length > 0;
}

// ─── SAN VALIDATOR (no chess.js needed) ──────────────────────────────────────
// We use a simple regex-based SAN validator.
// We don't do full legality checking — we just check if a token LOOKS like a
// valid SAN move. Illegal moves will still be included in the tree but this
// prevents random words/numbers from being treated as moves.

function looksLikeSan(tok) {
  if (!tok) return false;
  // Castling
  if (/^O-O(-O)?[+#]?$/.test(tok)) return true;
  // Pawn move: e4, exd5, e8=Q, exd8=Q+
  if (/^[a-h][1-8]([+#])?$/.test(tok)) return true;
  if (/^[a-h]x[a-h][1-8](=[KQRBN])?[+#]?$/.test(tok)) return true;
  if (/^[a-h][1-8]?x?[a-h][1-8](=[KQRBN])?[+#]?$/.test(tok)) return true;
  // Piece move: Nf3, Nxf3, N1f3, Nbf3, Nbxf3
  if (/^[KQRBN][a-h1-8]?[a-h1-8]?x?[a-h][1-8][+#]?$/.test(tok)) return true;
  return false;
}

// ─── TOKENIZER ────────────────────────────────────────────────────────────────

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    if (/\s/.test(src[i])) { i++; continue; }

    // Comment { ... }
    if (src[i] === '{') {
      let j = i + 1;
      while (j < src.length && src[j] !== '}') j++;
      tokens.push(src.slice(i, j + 1));
      i = j + 1;
      continue;
    }

    // Variation ( ... ) with nesting
    if (src[i] === '(') {
      let depth = 0, j = i;
      while (j < src.length) {
        if (src[j] === '(') depth++;
        else if (src[j] === ')') { depth--; if (depth === 0) { j++; break; } }
        j++;
      }
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }

    // NAG $12
    if (src[i] === '$') {
      let j = i + 1;
      while (j < src.length && /\d/.test(src[j])) j++;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }

    // Annotation glyphs ! ?
    if (src[i] === '!' || src[i] === '?') {
      let j = i;
      while (j < src.length && (src[j] === '!' || src[j] === '?')) j++;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }

    // Move number 12. or 12...
    const numMatch = src.slice(i).match(/^(\d+)\.{1,3}/);
    if (numMatch) {
      tokens.push(numMatch[0]);
      i += numMatch[0].length;
      continue;
    }

    // Game termination
    const termMatch = src.slice(i).match(/^(1-0|0-1|1\/2-1\/2|\*)/);
    if (termMatch) {
      tokens.push(termMatch[0]);
      i += termMatch[0].length;
      continue;
    }

    // Castling (must come before SAN)
    const castleMatch = src.slice(i).match(/^(O-O-O|O-O)[+#]?/);
    if (castleMatch) {
      tokens.push(castleMatch[0]);
      i += castleMatch[0].length;
      continue;
    }

    // SAN move
    const sanMatch = src.slice(i).match(/^[KQRBNP]?[a-h]?[1-8]?x?[a-h][1-8](?:=[KQRBN])?[+#]?/);
    if (sanMatch && looksLikeSan(sanMatch[0])) {
      tokens.push(sanMatch[0]);
      i += sanMatch[0].length;
      continue;
    }

    i++;
  }
  return tokens;
}

// ─── MOVE NODE ────────────────────────────────────────────────────────────────

class MoveNode {
  constructor(san) {
    this.san = san;       // null for root
    this.comments = [];
    this.nags = [];
    this.children = [];
  }
}

// ─── TREE PARSER ─────────────────────────────────────────────────────────────

function buildTree(movesText) {
  const root = new MoveNode(null);
  const parentMap = new WeakMap();
  parentMap.set(root, null);

  function parse(tokens, parentNode) {
    let cur = parentNode;

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];

      // Termination markers
      if (/^(\*|1-0|0-1|1\/2-1\/2)$/.test(tok)) break;

      // Move number — skip
      if (/^\d+\./.test(tok)) continue;

      // Comment
      if (tok.startsWith('{')) {
        const text = tok.slice(1, -1).trim();
        if (text && !cur.comments.includes(text)) cur.comments.push(text);
        continue;
      }

      // NAG / annotation
      if (tok.startsWith('$') || /^[!?]+$/.test(tok)) {
        cur.nags.push(tok);
        continue;
      }

      // Variation — parse against parent node
      if (tok.startsWith('(')) {
        const inner = tok.slice(1, -1).trim();
        const innerToks = tokenize(inner);
        const varParent = parentMap.get(cur) || parentNode;
        parse(innerToks, varParent);
        continue;
      }

      // SAN move
      if (looksLikeSan(tok)) {
        const san = tok.replace(/[!?]+$/, '');
        let child = cur.children.find(c => c.san === san);
        if (!child) {
          child = new MoveNode(san);
          cur.children.push(child);
          parentMap.set(child, cur);
        }
        cur = child;
      }
      // Unknown token — silently skip
    }
  }

  const tokens = tokenize(movesText);
  parse(tokens, root);
  return root;
}

// ─── MERGE TREES ─────────────────────────────────────────────────────────────

function mergeTrees(target, source) {
  for (const c of source.comments) {
    if (!target.comments.includes(c)) target.comments.push(c);
  }
  for (const srcChild of source.children) {
    const existing = target.children.find(c => c.san === srcChild.san);
    if (existing) {
      mergeTrees(existing, srcChild);
    } else {
      target.children.push(srcChild);
    }
  }
}

// ─── SERIALIZE TREE → PGN ────────────────────────────────────────────────────

function serialize(node, moveNum, isBlack) {
  // Root node
  if (!node.san) {
    if (node.children.length === 0) return '';
    let out = '';
    if (node.comments.length) out += node.comments.map(c => `{${c}}`).join(' ') + ' ';
    const [main, ...vars] = node.children;
    out += serialize(main, 1, false);
    for (const v of vars) out += ` (${serialize(v, 1, false)})`;
    return out.trim();
  }

  let out = !isBlack ? `${moveNum}. ` : '';
  out += node.san;
  if (node.nags.length) out += ' ' + node.nags.join('');
  if (node.comments.length) out += ' ' + node.comments.map(c => `{${c}}`).join(' ');

  const nextIsBlack = !isBlack;
  const nextNum = isBlack ? moveNum + 1 : moveNum;

  if (node.children.length === 0) return out;

  const [main, ...vars] = node.children;
  out += ' ' + serialize(main, nextNum, nextIsBlack);
  for (const v of vars) {
    out += ` (${serialize(v, isBlack ? moveNum : moveNum, isBlack)})`;
  }
  return out;
}

// ─── CHAPTER CLASSIFICATION ──────────────────────────────────────────────────

const GAME_COLLECTION_RE = /annotated\s+games?|model\s+games?|supplementary\s+games?|\bgames\b/i;
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
    if (GAME_COLLECTION_RE.test(chapterName)) continue;

    const movesText = extractMovesText(gt);
    if (!hasRealMoves(movesText)) continue;

    let tree;
    try {
      tree = buildTree(movesText);
    } catch (e) {
      try {
        tree = buildTree(extractMovesText(sanitizePgn(gt)));
      } catch (e2) {
        tree = new MoveNode(null);
      }
    }

    if (!chapterMap.has(chapterName)) {
      chapterMap.set(chapterName, { headers, root: tree });
      chapterOrder.push(chapterName);
    } else {
      mergeTrees(chapterMap.get(chapterName).root, tree);
    }
  }

  const out = [];
  for (const name of chapterOrder) {
    const { headers, root } = chapterMap.get(name);

    const cleanHeaders = {
      Event: name,
      Site: '?',
      Date: '????.??.??',
      Round: '?',
      White: '?',
      Black: '?',
      Result: '*'
    };

    let block = '';
    for (const [k, v] of Object.entries(cleanHeaders)) {
      block += `[${k} "${v}"]\n`;
    }
    block += '\n';

    let movetext = '';
    try { movetext = serialize(root, 1, false); } catch (e) {}
    block += (movetext ? movetext + ' ' : '') + '*';
    out.push(block);
  }

  return out.join('\n\n');
}

// ─── VERCEL HANDLER ──────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).end(JSON.stringify({ error: 'Method not allowed' }));
  }

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
    const outputName = `${base} merged.pgn`;

    return res.status(200).end(JSON.stringify({ pgn: merged, filename: outputName }));
  } catch (err) {
    console.error('[merge] error:', err);
    return res.status(500).end(JSON.stringify({ error: String(err.message || err) }));
  }
};      while (j < src.length && (src[j] === '!' || src[j] === '?')) j++;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }

    const numMatch = src.slice(i).match(/^(\d+)\.{1,3}/);
    if (numMatch) {
      tokens.push(numMatch[0]);
      i += numMatch[0].length;
      continue;
    }

    const castleMatch = src.slice(i).match(/^(O-O-O|O-O)[+#]?/);
    if (castleMatch) {
      tokens.push(castleMatch[0]);
      i += castleMatch[0].length;
      continue;
    }

    const termMatch = src.slice(i).match(/^(1-0|0-1|1\/2-1\/2|\*)/);
    if (termMatch) {
      tokens.push(termMatch[0]);
      i += termMatch[0].length;
      continue;
    }

    const sanMatch = src.slice(i).match(/^[KQRBNP]?[a-h]?[1-8]?x?[a-h][1-8](?:=[KQRBN])?[+#]?/);
    if (sanMatch) {
      tokens.push(sanMatch[0]);
      i += sanMatch[0].length;
      continue;
    }

    i++;
  }
  return tokens;
}

// ─── MOVE NODE ────────────────────────────────────────────────────────────────

class MoveNode {
  constructor(san, fen) {
    this.san = san;
    this.fen = fen;
    this.comments = [];
    this.nags = [];
    this.children = [];
  }
}

// ─── TREE PARSER ─────────────────────────────────────────────────────────────

function buildTree(movesText, startFen) {
  const root = new MoveNode(null, startFen);
  const parentMap = new WeakMap();
  const parentFenMap = new WeakMap();
  parentMap.set(root, null);
  parentFenMap.set(root, startFen);

  function parse(tokens, idx, parentNode, fen) {
    const board = new Chess(fen);
    let cur = parentNode;

    while (idx < tokens.length) {
      const tok = tokens[idx];

      if (/^(\*|1-0|0-1|1\/2-1\/2)$/.test(tok)) { idx++; break; }
      if (/^\d+\./.test(tok)) { idx++; continue; }

      if (tok.startsWith('{')) {
        const text = tok.slice(1, -1).trim();
        if (text && !cur.comments.includes(text)) cur.comments.push(text);
        idx++; continue;
      }

      if (tok.startsWith('$') || /^[!?]+$/.test(tok)) {
        cur.nags.push(tok);
        idx++; continue;
      }

      if (tok.startsWith('(')) {
        const inner = tok.slice(1, -1).trim();
        const innerToks = tokenize(inner);
        const varParent = parentMap.get(cur) || parentNode;
        const varFen = parentFenMap.get(cur) || fen;
        parse(innerToks, 0, varParent, varFen);
        idx++; continue;
      }

      let result = null;
      try { result = board.move(tok, { sloppy: true }); } catch (e) {}

      if (result) {
        const newFen = board.fen();
        let child = cur.children.find(c => c.san === result.san);
        if (!child) {
          child = new MoveNode(result.san, newFen);
          cur.children.push(child);
          parentMap.set(child, cur);
          parentFenMap.set(child, cur.fen || startFen);
        }
        cur = child;
      } else {
        if (tok.length > 0) {
          const illegal = `[${tok}]`;
          if (!cur.comments.includes(illegal)) cur.comments.push(illegal);
        }
      }

      idx++;
    }
    return idx;
  }

  const tokens = tokenize(movesText);
  parse(tokens, 0, root, startFen);
  return root;
}

// ─── MERGE TREES ─────────────────────────────────────────────────────────────

function mergeTrees(target, source) {
  for (const c of source.comments) {
    if (!target.comments.includes(c)) target.comments.push(c);
  }
  for (const srcChild of source.children) {
    const existing = target.children.find(c => c.san === srcChild.san);
    if (existing) {
      mergeTrees(existing, srcChild);
    } else {
      target.children.push(srcChild);
    }
  }
}

// ─── SERIALIZE TREE → PGN MOVETEXT ───────────────────────────────────────────

function serialize(node, moveNum, isBlack) {
  if (!node.san) {
    if (node.children.length === 0) return '';
    let out = '';
    if (node.comments.length) out += node.comments.map(c => `{${c}}`).join(' ') + ' ';
    const [main, ...vars] = node.children;
    out += serialize(main, 1, false);
    for (const v of vars) {
      out += ` (${serialize(v, 1, false)})`;
    }
    return out.trim();
  }

  let out = '';
  if (!isBlack) {
    out += `${moveNum}. `;
  } else {
    out += '';
  }
  out += node.san;

  if (node.nags.length) out += node.nags.map(n => n.startsWith('$') ? n : ` ${n}`).join('');
  if (node.comments.length) out += ' ' + node.comments.map(c => `{${c}}`).join(' ');

  const nextIsBlack = !isBlack;
  const nextNum = isBlack ? moveNum + 1 : moveNum;

  if (node.children.length === 0) return out;

  const [main, ...vars] = node.children;
  out += ' ' + serialize(main, nextNum, nextIsBlack);

  for (const v of vars) {
    out += ' (' + serialize(v, isBlack ? moveNum : moveNum, isBlack) + ')';
  }

  return out;
}

// ─── CHAPTER CLASSIFICATION ──────────────────────────────────────────────────

const GAME_COLLECTION_RE = /annotated\s+games?|model\s+games?|supplementary\s+games?|\bgames\b/i;
const PLACEHOLDER_RE = /^(\?+|unknown|\?+\.\?+\.\?+)$/i;

function getChapterName(headers) {
  // Prefer Event first, then White — skip "?", "Unknown" placeholders
  const candidates = [headers.Event, headers.White].filter(
    v => v && !PLACEHOLDER_RE.test(v.trim())
  );
  return (candidates[0] || '?').trim();
}

// ─── CORE MERGE PIPELINE ──────────────────────────────────────────────────────

function mergeChapters(rawPgn) {
  const startFen = new Chess().fen();
  const chapterMap = new Map();
  const chapterOrder = [];

  const gameTexts = splitGames(rawPgn);

  for (let gt of gameTexts) {
    if (!gt.trim()) continue;

    let headers = parseHeaders(gt);

    if (
      Object.values(headers).some(v => v.includes('[object Object]')) ||
      gt.includes('[object Object]')
    ) {
      gt = sanitizePgn(gt);
      headers = parseHeaders(gt);
    }

    const chapterName = getChapterName(headers);

    // Skip unnamed/placeholder chapters and game collections
    if (chapterName === '?') continue;
    if (GAME_COLLECTION_RE.test(chapterName)) continue;

    const movesText = extractMovesText(gt);

    // Skip games with no real moves (just "*")
    if (!hasRealMoves(movesText)) continue;

    let tree;
    try {
      tree = buildTree(movesText, startFen);
    } catch (e) {
      try {
        tree = buildTree(extractMovesText(sanitizePgn(gt)), startFen);
      } catch (e2) {
        tree = new MoveNode(null, startFen);
      }
    }

    if (!chapterMap.has(chapterName)) {
      chapterMap.set(chapterName, { headers, root: tree });
      chapterOrder.push(chapterName);
    } else {
      mergeTrees(chapterMap.get(chapterName).root, tree);
    }
  }

  const out = [];
  for (const name of chapterOrder) {
    const { headers, root } = chapterMap.get(name);

    // Build clean headers — use Event as the chapter label
    const cleanHeaders = {
      Event: name,
      Site: headers.Site || '?',
      Date: (headers.Date && !PLACEHOLDER_RE.test(headers.Date)) ? headers.Date : '????.??.??',
      Round: headers.Round || '?',
      White: '?',
      Black: '?',
      Result: '*'
    };

    let block = '';
    for (const [k, v] of Object.entries(cleanHeaders)) {
      block += `[${k} "${v}"]\n`;
    }
    block += '\n';

    let movetext = '';
    try {
      movetext = serialize(root, 1, false);
    } catch (e) {}

    block += (movetext || '') + (movetext ? ' ' : '') + '*';
    out.push(block);
  }

  return out.join('\n\n');
}

// ─── VERCEL HANDLER ──────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();

    let pgn, filename;
    try {
      const parsed = JSON.parse(body);
      pgn = parsed.pgn;
      filename = parsed.filename || 'output.pgn';
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    if (!pgn) return res.status(400).json({ error: 'No PGN provided' });

    const merged = mergeChapters(pgn);
    const base = filename.replace(/\.pgn$/i, '');
    const outputName = `${base} merged.pgn`;

    return res.status(200).json({ pgn: merged, filename: outputName });
  } catch (err) {
    console.error('[merge] Fatal error:', err);
    return res.status(500).json({ error: 'Internal error: ' + err.message });
  }
};    }

    // Semicolon comment to end of line
    if (c === ';') {
      const nl = text.indexOf('\n', i);
      const j = nl === -1 ? n : nl;
      const val = text.slice(i + 1, j).trim();
      if (val) tokens.push({ type: 'comment', value: val });
      i = j + 1;
      continue;
    }

    if (c === '(') { tokens.push({ type: 'open' }); i++; continue; }
    if (c === ')') { tokens.push({ type: 'close' }); i++; continue; }

    // NAG $N
    if (c === '$') {
      let j = i + 1;
      while (j < n && /\d/.test(text[j])) j++;
      tokens.push({ type: 'nag', value: text.slice(i, j) });
      i = j;
      continue;
    }

    // Annotation glyphs ! ?
    if (/[!?]/.test(c)) {
      let j = i;
      while (j < n && /[!?]/.test(text[j])) j++;
      tokens.push({ type: 'nag', value: text.slice(i, j) });
      i = j;
      continue;
    }

    // Results
    if (text.startsWith('1/2-1/2', i)) { tokens.push({ type: 'result', value: '1/2-1/2' }); i += 7; continue; }
    if (text.startsWith('1-0', i))     { tokens.push({ type: 'result', value: '1-0' });     i += 3; continue; }
    if (text.startsWith('0-1', i))     { tokens.push({ type: 'result', value: '0-1' });     i += 3; continue; }
    if (c === '*')                      { tokens.push({ type: 'result', value: '*' });       i++;    continue; }

    // Move number: digits followed by dots
    if (/\d/.test(c)) {
      let j = i;
      while (j < n && /\d/.test(text[j])) j++;
      while (j < n && text[j] === '.') j++;
      tokens.push({ type: 'number', value: text.slice(i, j) });
      i = j;
      continue;
    }

    // SAN move (piece letter, pawn file, or castling)
    if (/[NBRQKa-h]/.test(c) || c === 'O') {
      let j = i;
      while (j < n && /[NBRQKa-h1-8xO=+#\-]/.test(text[j])) j++;
      const word = text.slice(i, j);
      if (/[a-zA-Z]/.test(word) && word.length >= 2) {
        tokens.push({ type: 'move', value: word });
      }
      i = j;
      continue;
    }

    i++; // skip unknown
  }

  return tokens;
}

// ─── Move Node ────────────────────────────────────────────────────────────────

class MoveNode {
  constructor(san, fen) {
    this.san = san;
    this.fen = fen;
    this.comments = [];
    this.children = [];
  }

  findOrCreateChild(san, fen) {
    const ex = this.children.find(c => c.fen === fen);
    if (ex) return ex;
    const child = new MoveNode(san, fen);
    this.children.push(child);
    return child;
  }

  addComment(text) {
    if (text && !this.comments.includes(text)) this.comments.push(text);
  }
}

// ─── Tree Builder ─────────────────────────────────────────────────────────────

/**
 * Parse tokens into a move tree rooted at `root`.
 *
 * Design: we maintain a "cursor" = the node we last added a move to.
 * The cursor's parent is the node we're attaching siblings/children to.
 *
 * Stack frames save (parentNode, chess, lastNode) so we can restore state
 * after a variation ends.
 */
function buildTree(tokens, root, warnings) {
  // parentNode: node we add new children to
  // chess:      board state AT parentNode's position
  // lastNode:   most recently added child (for comment attachment and variation branching)

  let parentNode = root;
  let chess = new Chess(root.fen);
  let lastNode = null;

  const stack = []; // { parentNode, chessFen, lastNode }

  function attachComment(text) {
    (lastNode || parentNode).addComment(text);
  }

  for (const tok of tokens) {
    switch (tok.type) {

      case 'comment':
        attachComment(tok.value);
        break;

      case 'nag':
      case 'number':
      case 'result':
        // ignored
        break;

      case 'open': {
        // Save current state; variation branches from before lastNode
        stack.push({
          parentNode,
          chessFen: chess.fen(),
          lastNode
        });
        // Rewind to the state before lastNode was played
        if (lastNode) {
          parentNode = parentNode; // stays — variation is a sibling to lastNode
          chess = new Chess(parentNode.fen);
          lastNode = null;
        }
        // else: duplicate frame, no change needed
        break;
      }

      case 'close': {
        if (stack.length > 0) {
          const frame = stack.pop();
          parentNode = frame.parentNode;
          chess = new Chess(frame.chessFen);
          lastNode = frame.lastNode;
        }
        break;
      }

      case 'move': {
        const san = tok.value;
        let moveObj = null;

        try {
          moveObj = chess.move(san, { sloppy: true });
        } catch (_) { /* illegal */ }

        if (!moveObj) {
          warnings.push(`Illegal move "${san}" → comment`);
          attachComment(`[${san}]`);
          break;
        }

        const newFen = chess.fen();
        const child = parentNode.findOrCreateChild(moveObj.san, newFen);

        // Descend: this child is now the parent for subsequent moves
        lastNode = child;
        parentNode = child;
        // chess is already at newFen (moveObj applied in-place)
        break;
      }
    }
  }
}

// ─── PGN Renderer ─────────────────────────────────────────────────────────────

function renderComments(comments) {
  const unique = [...new Set(comments.map(c => c.trim()).filter(Boolean))];
  return unique.length ? ' {' + unique.join(' | ') + '}' : '';
}

/**
 * Render a MoveNode and all its descendants to PGN.
 *
 * @param {MoveNode} node         - current node
 * @param {number}   moveNum      - fullmove number for this node
 * @param {boolean}  blackToMove  - true if it was black's turn to play this node
 * @param {boolean}  forceNum     - force showing move number (e.g. after variation)
 * @returns {string}
 */
function renderMoves(node, moveNum, blackToMove, forceNum) {
  if (!node.san) {
    // Root node — render children
    if (node.children.length === 0) return '';
    const [main, ...alts] = node.children;
    const parts = [];

    const altStrs = alts.map(a => {
      const s = renderMoves(a, moveNum, blackToMove, true);
      return s ? `(${s})` : null;
    }).filter(Boolean);

    const mainStr = renderMoves(main, moveNum, blackToMove, forceNum);

    if (altStrs.length > 0) {
      // main line first, then alternatives indented
      return mainStr + '\n   ' + altStrs.join('\n   ');
    }
    return mainStr;
  }

  // Render this node's move
  let movePart = '';
  if (!blackToMove || forceNum) {
    movePart += moveNum + (blackToMove ? '... ' : '. ');
  }
  movePart += node.san;
  movePart += renderComments(node.comments);

  if (node.children.length === 0) return movePart;

  const [main, ...alts] = node.children;

  // Next move number/color
  const nextMoveNum = blackToMove ? moveNum + 1 : moveNum;
  const nextBlack   = !blackToMove;

  // Render alternatives
  const altStrs = alts.map(a => {
    const s = renderMoves(a, nextMoveNum, nextBlack, true);
    return s ? `(${s})` : null;
  }).filter(Boolean);

  // Render main line continuation
  const mainStr = renderMoves(main, nextMoveNum, nextBlack, false);

  if (altStrs.length > 0) {
    const varBlock = altStrs.join('\n   ');
    const afterVars = mainStr ? '\n   ' + mainStr : '';
    return movePart + '\n   ' + varBlock + afterVars;
  }

  return movePart + (mainStr ? ' ' + mainStr : '');
}

// ─── Chapter ──────────────────────────────────────────────────────────────────

class Chapter {
  constructor(name, headers) {
    this.name = name;
    this.headers = { ...headers };
    this.root = new MoveNode(null, START_FEN);
    this.warnings = [];
  }

  addGame(moveText) {
    const tokens = tokenize(moveText);
    buildTree(tokens, this.root, this.warnings);
  }

  toPgn() {
    const h = this.headers;
    let out = `[Event "${this.name}"]\n`;

    const skip = new Set(['Event', 'White']);
    for (const [k, v] of Object.entries(h)) {
      if (skip.has(k)) continue;
      if (!v || v === '?') continue;
      out += `[${k} "${v}"]\n`;
    }

    if (!h.Site)   out += '[Site "?"]\n';
    if (!h.Date)   out += '[Date "????.??.??"]\n';
    if (!h.Round)  out += '[Round "?"]\n';
    if (!h.Black)  out += '[Black "?"]\n';
    if (!h.Result) out += '[Result "*"]\n';

    out += '\n';

    const moves = renderMoves(this.root, 1, false, false);
    out += (moves || '') + (moves ? ' ' : '') + '*\n';

    return out;
  }
}

// ─── Main Merge Function ──────────────────────────────────────────────────────

function mergeGames(rawPgn) {
  const warnings = [];

  const sanitized = sanitizePgn(rawPgn);
  const gameStrings = splitGames(sanitized);

  if (gameStrings.length === 0) {
    throw new Error('No games found in PGN file');
  }

  const chapters = new Map();
  const order = [];
  let skipped = 0;

  for (const gameStr of gameStrings) {
    let headers;
    try {
      headers = parseHeaders(gameStr);
    } catch (_) {
      skipped++;
      continue;
    }

    const name = getChapterName(headers);

    if (GAME_CHAPTER_RE.test(name)) {
      warnings.push(`Skipped game chapter: "${name}"`);
      skipped++;
      continue;
    }

    if (!chapters.has(name)) {
      chapters.set(name, new Chapter(name, headers));
      order.push(name);
    }

    const moveText = getMoveText(gameStr);
    if (!moveText.trim()) continue;

    const chapter = chapters.get(name);
    try {
      chapter.addGame(moveText);
    } catch (e) {
      try {
        chapter.addGame(sanitizePgn(moveText));
      } catch (_) {
        warnings.push(`Skipped malformed game in chapter "${name}"`);
      }
    }
  }

  if (chapters.size === 0) {
    throw new Error('No valid opening chapters found after filtering');
  }

  // Collect chapter-level warnings (deduplicated, capped)
  for (const ch of chapters.values()) {
    for (const w of ch.warnings.slice(0, 3)) warnings.push(w);
  }

  const output = order.map(n => chapters.get(n).toPgn()).join('\n\n');

  return {
    pgn: output,
    inputGames: gameStrings.length,
    chapters: chapters.size,
    skipped,
    warnings: [...new Set(warnings)].slice(0, 50)
  };
}

// ─── Vercel Handler ───────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')   { res.status(405).send('Method Not Allowed'); return; }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) {
      res.status(400).send('Invalid JSON body');
      return;
    }
  }

  if (!body || !body.pgn) {
    res.status(400).send('Missing "pgn" field');
    return;
  }

  try {
    const result = mergeGames(body.pgn);
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
};
