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

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    if (/\s/.test(src[i])) { i++; continue; }

    if (src[i] === '{') {
      let j = i + 1;
      while (j < src.length && src[j] !== '}') j++;
      tokens.push(src.slice(i, j + 1));
      i = j + 1;
      continue;
    }

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

    if (src[i] === '$') {
      let j = i + 1;
      while (j < src.length && /\d/.test(src[j])) j++;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }

    if (src[i] === '!' || src[i] === '?') {
      let j = i;
      while (j < src.length && (src[j] === '!' || src[j] === '?')) j++;
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

    const termMatch = src.slice(i).match(/^(1-0|0-1|1\/2-1\/2|\*)/);
    if (termMatch) {
      tokens.push(termMatch[0]);
      i += termMatch[0].length;
      continue;
    }

    const castleMatch = src.slice(i).match(/^(O-O-O|O-O)[+#]?/);
    if (castleMatch) {
      tokens.push(castleMatch[0]);
      i += castleMatch[0].length;
      continue;
    }

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
  constructor(san, moveNum, isBlack) {
    this.san = san;
    this.moveNum = moveNum || 0;
    this.isBlack = isBlack || false;
    this.comments = [];
    this.nags = [];
    this.children = [];
  }
}

// ─── TREE PARSER ─────────────────────────────────────────────────────────────

function buildTree(movesText) {
  const root = new MoveNode(null, 0, false);

  function parse(tokens, parentNode, moveNum, isBlack) {
    let cur = parentNode;
    let curMoveNum = moveNum;
    let curIsBlack = isBlack;

    // We keep the last realized node as branch point
    let branchPoint = parentNode;
    let branchMoveNum = moveNum;
    let branchIsBlack = isBlack;

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];

      if (/^(\*|1-0|0-1|1\/2-1\/2)$/.test(tok)) break;

      // Move number token
      if (/^\d+\.(\.\.)?$/.test(tok)) {
        const num = parseInt(tok);
        const dots = tok.match(/\./g)?.length || 1;
        curMoveNum = num;
        curIsBlack = dots >= 3;
        continue;
      }

      if (tok.startsWith('{')) {
        const text = tok.slice(1, -1).trim();
        if (text && !cur.comments.includes(text)) cur.comments.push(text);
        continue;
      }

      if (tok.startsWith('\( ') || /^[!?]+ \)/.test(tok)) {
        cur.nags.push(tok);
        continue;
      }

      if (tok.startsWith('(')) {
        const inner = tok.slice(1, -1).trim();
        const innerToks = tokenize(inner);
        // Attach variation to the LAST REALIZED move (before current if needed)
        parse(innerToks, branchPoint, branchMoveNum, branchIsBlack);
        continue;
      }

      if (looksLikeSan(tok)) {
        const san = tok.replace(/[!?]+$/, '');
        const leftover = tok.slice(san.length);

        // IMPORTANT FIX: update branch point BEFORE advancing
        branchPoint = cur;
        branchMoveNum = curMoveNum;
        branchIsBlack = curIsBlack;

        let child = cur.children.find(c => c.san === san);
        if (!child) {
          child = new MoveNode(san, curMoveNum, curIsBlack);
          cur.children.push(child);
        }
        cur = child;

        // Advance move counter
        if (curIsBlack) {
          curMoveNum++;
          curIsBlack = false;
        } else {
          curIsBlack = true;
        }

        if (leftover) {
          child.nags.push(...(leftover.match(/[!?]+/g) || []));
        }
      }
    }
  }

  const tokens = tokenize(movesText);
  parse(tokens, root, 1, false);
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

function serialize(node, inVariation = false) {
  if (!node.san) {
    // Root node
    if (node.children.length === 0) return '';
    let out = '';
    if (node.comments.length) out += node.comments.map(c => `{${c}}`).join(' ') + ' ';
    const [main, ...vars] = node.children;
    out += serialize(main, false);
    for (const v of vars) out += ` (${serialize(v, true)})`;
    return out.trim();
  }

  let out = '';

  // Show move number:
  // - Always for White
  // - For Black: when in variation, after comment, or forced
  const showNumber = !node.isBlack || inVariation || node.comments.length > 0 || node.nags.length > 0;

  if (showNumber) {
    out += node.isBlack ? `\( {node.moveNum}... ` : ` \){node.moveNum}. `;
  }

  out += node.san;

  if (node.nags.length) out += ' ' + node.nags.join('');
  if (node.comments.length) out += ' ' + node.comments.map(c => `{${c}}`).join(' ');

  if (node.children.length === 0) return out;

  const [main, ...vars] = node.children;

  // After comment or variation → force number on next black move if needed
  const nextNeedsNum = node.comments.length > 0 || vars.length > 0;

  out += ' ' + serialize(main, false, nextNeedsNum && main.isBlack);

  for (const v of vars) {
    out += ` (${serialize(v, true)})`;
  }

  return out;
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
      tree = buildTree(movesText);
    } catch (e) {
      try {
        tree = buildTree(extractMovesText(sanitizePgn(gt)));
      } catch (e2) {
        tree = new MoveNode(null);
      }
    }

    if (noMerge) {
      const uniqueName = `\( {chapterName}__ \){chapterOrder.length}`;
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
      block += `[\( {k} " \){v}"]\n`;
    }
    block += '\n';

    let movetext = '';
    try { movetext = serialize(root, false); } catch (e) {}
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
