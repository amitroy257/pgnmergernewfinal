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

// ─── TOKENIZER ────────────────────────────────────────────────────────────────

function tokenizePGN(src) {
  const tokens = [];
  let i = 0;

  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }

    // Comment { ... } with nested brace support
    if (c === '{') {
      let j = i + 1, depth = 1;
      while (j < src.length && depth) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
        j++;
      }
      tokens.push({ type: 'comment', value: src.slice(i + 1, j - 1).trim() });
      i = j;
      continue;
    }

    // Variation ( ... ) — recursively tokenized
    if (c === '(') {
      let depth = 1, j = i + 1;
      while (j < src.length && depth) {
        if (src[j] === '(') depth++;
        else if (src[j] === ')') depth--;
        j++;
      }
      const inner = src.slice(i + 1, j - 1);
      tokens.push({ type: 'variation', value: tokenizePGN(inner) });
      i = j;
      continue;
    }

    // NAG $12
    if (c === '$') {
      let j = i + 1;
      while (j < src.length && /\d/.test(src[j])) j++;
      tokens.push({ type: 'nag', value: src.slice(i, j) });
      i = j;
      continue;
    }

    // Annotation glyphs ! ?
    if (c === '!' || c === '?') {
      let j = i;
      while (j < src.length && (src[j] === '!' || src[j] === '?')) j++;
      tokens.push({ type: 'nag', value: src.slice(i, j) });
      i = j;
      continue;
    }

    // Game termination
    const termMatch = src.slice(i).match(/^(1-0|0-1|1\/2-1\/2|\*)/);
    if (termMatch) {
      tokens.push({ type: 'term', value: termMatch[0] });
      i += termMatch[0].length;
      continue;
    }

    // Move number 12. or 12...
    const moveNumMatch = src.slice(i).match(/^(\d+)\.{1,3}/);
    if (moveNumMatch) {
      tokens.push({ type: 'moveNum', value: moveNumMatch[0] });
      i += moveNumMatch[0].length;
      continue;
    }

    // Castling
    const castleMatch = src.slice(i).match(/^(O-O-O|O-O)[+#]?/);
    if (castleMatch) {
      tokens.push({ type: 'move', value: castleMatch[0] });
      i += castleMatch[0].length;
      continue;
    }

    // SAN move
    const sanMatch = src.slice(i).match(/^[KQRBNP]?[a-h]?[1-8]?x?[a-h][1-8](?:=[KQRBN])?[+#]?/);
    if (sanMatch && looksLikeSan(sanMatch[0])) {
      tokens.push({ type: 'move', value: sanMatch[0] });
      i += sanMatch[0].length;
      continue;
    }

    // Unknown token — skip word
    let j = i + 1;
    while (j < src.length && !/\s/.test(src[j])) j++;
    i = j;
  }

  return tokens;
}

// ─── MOVE NODE ────────────────────────────────────────────────────────────────

class MoveNode {
  constructor(san) {
    this.san = san;
    this.comments = [];
    this.nags = [];
    this.children = [];
  }
}

// ─── TREE BUILDER ────────────────────────────────────────────────────────────

function buildMoveTree(tokens) {
  const root = new MoveNode(null);

  function parse(tokens, parent) {
    let current = parent;
    for (const tok of tokens) {
      if (tok.type === 'term') break;

      if (tok.type === 'move') {
        // Find existing child with same SAN (for merging)
        let node = current.children.find(c => c.san === tok.value);
        if (!node) {
          node = new MoveNode(tok.value);
          current.children.push(node);
        }
        current = node;

      } else if (tok.type === 'comment') {
        if (!current.comments.includes(tok.value)) {
          current.comments.push(tok.value);
        }

      } else if (tok.type === 'nag') {
        current.nags.push(tok.value);

      } else if (tok.type === 'variation') {
        // Variation branches from current node's PARENT (before current move)
        // We pass `parent` which is the node before `current`
        parse(tok.value, parent);

      } else if (tok.type === 'moveNum') {
        // skip
      }
    }
    return current;
  }

  // We need parent tracking — wrap parse to track properly
  function parseWithParent(tokens, parentNode) {
    let current = parentNode;
    let prevNode = parentNode; // tracks the node before current

    for (const tok of tokens) {
      if (tok.type === 'term') break;

      if (tok.type === 'move') {
        let node = current.children.find(c => c.san === tok.value);
        if (!node) {
          node = new MoveNode(tok.value);
          current.children.push(node);
        }
        prevNode = current;  // remember where we came from
        current = node;

      } else if (tok.type === 'comment') {
        if (!current.comments.includes(tok.value)) {
          current.comments.push(tok.value);
        }

      } else if (tok.type === 'nag') {
        current.nags.push(tok.value);

      } else if (tok.type === 'variation') {
        // Branch from prevNode (the node BEFORE current move was played)
        parseWithParent(tok.value, prevNode);

      } else if (tok.type === 'moveNum') {
        // skip
      }
    }
  }

  parseWithParent(tokens, root);
  return root;
}

// ─── SERIALIZE TREE → PGN ────────────────────────────────────────────────────

function serializeTree(node, moveNum, isBlack, isVarStart) {
  if (moveNum === undefined) moveNum = 1;
  if (isBlack === undefined) isBlack = false;
  if (isVarStart === undefined) isVarStart = false;

  if (!node.san) {
    if (node.children.length === 0) return '';
    let out = '';
    if (node.comments.length) out += node.comments.map(c => `{${c}}`).join(' ') + ' ';
    const [main, ...vars] = node.children;
    out += serializeTree(main, moveNum, isBlack);
    for (const v of vars) out += ` (${serializeTree(v, moveNum, isBlack, true)})`;
    return out.trim();
  }

  let out = '';
  // Add move number: always for white, or at start of a variation for black
  if (!isBlack) {
    out += `${moveNum}. `;
  } else if (isVarStart) {
    out += `${moveNum}... `;
  }
  out += node.san;

  if (node.nags.length) out += ' ' + node.nags.join('');
  if (node.comments.length) out += ' ' + node.comments.map(c => `{${c}}`).join(' ');

  const nextIsBlack = !isBlack;
  const nextNum = isBlack ? moveNum + 1 : moveNum;

  if (node.children.length === 0) return out;

  const [main, ...vars] = node.children;
  out += ' ' + serializeTree(main, nextNum, nextIsBlack);

  for (const v of vars) {
    out += ` (${serializeTree(v, nextNum, nextIsBlack, true)})`;
  }

  return out;
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

    // Keep chapters with no moves (e.g. Introduction)
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
      const tokens = tokenizePGN(movesText);
      tree = buildMoveTree(tokens);
    } catch (e) {
      try {
        const tokens = tokenizePGN(extractMovesText(sanitizePgn(gt)));
        tree = buildMoveTree(tokens);
      } catch (e2) {
        tree = new MoveNode(null);
      }
    }

    if (noMerge) {
      const uniqueKey = `${chapterName}__${chapterOrder.length}`;
      chapterMap.set(uniqueKey, { headers, root: tree, noMerge: true, displayName: chapterName });
      chapterOrder.push(uniqueKey);
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
    try { movetext = serializeTree(root, 1, false); } catch (e) {}
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
};
