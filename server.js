const http = require('http');
const fs = require('fs');
const path = require('path');

// Load the precomputed land mask
const landMask = require('./generated/land_mask.json');
const GRID_W = landMask[0].length;
const GRID_H = landMask.length;

const TICK_INTERVAL_MS = 1000;
const MAX_PLAYERS_PER_GAME = 10;

// Generate a random colour string in HSL format for players
function randomColor() {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue}, 60%, 50%)`;
}

// Game class defines the grid and methods for manipulating it
class Game {
  constructor() {
    this.cells = new Array(GRID_W * GRID_H);
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const idx = y * GRID_W + x;
        this.cells[idx] = {
          land: landMask[y][x] === 1,
          owner: null,
          troops: 0,
          port: false,
          city: false,
        };
      }
    }
    this.players = {}; // id -> {id, name, color, cells:Set}
    this.bots = [];
  }
  addPlayer(id, name) {
    if (Object.keys(this.players).length >= MAX_PLAYERS_PER_GAME) return false;
    const color = randomColor();
    this.players[id] = { id, name, color, cells: new Set() };
    return true;
  }
  removePlayer(id) {
    const player = this.players[id];
    if (!player) return;
    for (const cellIdx of player.cells) {
      const cell = this.cells[cellIdx];
      cell.owner = null;
      cell.troops = 0;
      cell.port = false;
      cell.city = false;
    }
    delete this.players[id];
  }
  spawn(id, x, y) {
    const idx = y * GRID_W + x;
    const cell = this.cells[idx];
    if (!cell.land || cell.owner) return false;
    cell.owner = id;
    cell.troops = 10;
    cell.port = false;
    cell.city = false;
    this.players[id].cells.add(idx);
    return true;
  }
  attack(id, srcX, srcY, dstX, dstY, troops) {
    const srcIdx = srcY * GRID_W + srcX;
    const dstIdx = dstY * GRID_W + dstX;
    const srcCell = this.cells[srcIdx];
    const dstCell = this.cells[dstIdx];
    if (!srcCell || srcCell.owner !== id || srcCell.troops <= 1) return false;
    if (troops <= 0 || troops >= srcCell.troops) return false;
    const dx = dstX - srcX;
    const dy = dstY - srcY;
    const maxStep = Math.max(Math.abs(dx), Math.abs(dy));
    if (maxStep !== 1) {
      // crossing water
      if (maxStep === 2 && srcCell.port) {
        const midX = srcX + Math.sign(dx);
        const midY = srcY + Math.sign(dy);
        const midIdx = midY * GRID_W + midX;
        const midCell = this.cells[midIdx];
        if (midCell && !midCell.land && dstCell && dstCell.land) {
          // allowed
        } else {
          return false;
        }
      } else {
        return false;
      }
    }
    // deduct troops
    srcCell.troops -= troops;
    if (!dstCell.owner) {
      dstCell.owner = id;
      dstCell.troops = troops;
      dstCell.port = false;
      dstCell.city = false;
      this.players[id].cells.add(dstIdx);
    } else if (dstCell.owner === id) {
      dstCell.troops += troops;
    } else {
      if (troops > dstCell.troops) {
        const defenderId = dstCell.owner;
        this.players[defenderId].cells.delete(dstIdx);
        dstCell.owner = id;
        dstCell.troops = troops - dstCell.troops;
        dstCell.port = false;
        dstCell.city = false;
        this.players[id].cells.add(dstIdx);
      } else {
        dstCell.troops -= troops;
      }
    }
    return true;
  }
  buildPort(id, x, y) {
    const idx = y * GRID_W + x;
    const cell = this.cells[idx];
    if (!cell || cell.owner !== id || !cell.land || cell.port) return false;
    // Check adjacency to water
    let adjacentWater = false;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        if (i === 0 && j === 0) continue;
        const nx = x + i;
        const ny = y + j;
        if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
        const nidx = ny * GRID_W + nx;
        const ncell = this.cells[nidx];
        if (ncell && !ncell.land) adjacentWater = true;
      }
    }
    if (!adjacentWater) return false;
    if (cell.troops < 5) return false;
    cell.troops -= 5;
    cell.port = true;
    return true;
  }
  buildCity(id, x, y) {
    const idx = y * GRID_W + x;
    const cell = this.cells[idx];
    if (!cell || cell.owner !== id || !cell.land || cell.city) return false;
    if (cell.troops < 10) return false;
    cell.troops -= 10;
    cell.city = true;
    return true;
  }
  // Troop growth and bot actions
  update() {
    // troop growth
    for (let idx = 0; idx < this.cells.length; idx++) {
      const cell = this.cells[idx];
      if (cell.owner) {
        const player = this.players[cell.owner];
        if (!player) continue;
        const territorySize = player.cells.size;
        let maxTroops = 5 + Math.floor(territorySize / 2);
        if (cell.city) maxTroops += 5;
        const growth = Math.max(1, Math.floor(cell.troops / 3));
        cell.troops = Math.min(cell.troops + growth, maxTroops);
      }
    }
    // bot actions
    for (const bot of this.bots) {
      this.botAct(bot);
    }
  }
  // Bot behaviour (same as before)
  botAct(bot) {
    if (bot.cells.size === 0) {
      for (let i = 0; i < 50; i++) {
        const x = Math.floor(Math.random() * GRID_W);
        const y = Math.floor(Math.random() * GRID_H);
        const idx = y * GRID_W + x;
        const cell = this.cells[idx];
        if (cell.land && !cell.owner) {
          cell.owner = bot.id;
          cell.troops = 10;
          bot.cells.add(idx);
          return;
        }
      }
      return;
    }
    const ownCells = Array.from(bot.cells);
    const srcIdx = ownCells[Math.floor(Math.random() * ownCells.length)];
    const srcCell = this.cells[srcIdx];
    if (!srcCell || srcCell.troops <= 1) return;
    const x = srcIdx % GRID_W;
    const y = Math.floor(srcIdx / GRID_W);
    const possibleTargets = [];
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        if (i === 0 && j === 0) continue;
        const nx = x + i;
        const ny = y + j;
        if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
        const nidx = ny * GRID_W + nx;
        const ncell = this.cells[nidx];
        if (!ncell) continue;
        if (ncell.owner !== bot.id) {
          possibleTargets.push({ x: nx, y: ny });
        }
      }
    }
    if (srcCell.port) {
      const dirs = [
        { dx: -1, dy: 0 }, { dx: 1, dy: 0 }, { dx: 0, dy: -1 }, { dx: 0, dy: 1 },
        { dx: -1, dy: -1 }, { dx: -1, dy: 1 }, { dx: 1, dy: -1 }, { dx: 1, dy: 1 },
      ];
      for (const dir of dirs) {
        const midX = x + dir.dx;
        const midY = y + dir.dy;
        const destX = x + dir.dx * 2;
        const destY = y + dir.dy * 2;
        if (destX < 0 || destY < 0 || destX >= GRID_W || destY >= GRID_H) continue;
        const midCell = this.cells[midY * GRID_W + midX];
        const destCell = this.cells[destY * GRID_W + destX];
        if (midCell && !midCell.land && destCell && destCell.land && destCell.owner !== bot.id) {
          possibleTargets.push({ x: destX, y: destY });
        }
      }
    }
    if (possibleTargets.length === 0) return;
    const target = possibleTargets[Math.floor(Math.random() * possibleTargets.length)];
    const troopsToSend = Math.floor(srcCell.troops / 2);
    if (troopsToSend < 1) return;
    this.attack(bot.id, x, y, target.x, target.y, troopsToSend);
  }
  // Prepare state for sending to clients
  serializeState() {
    const players = {};
    for (const pid in this.players) {
      const p = this.players[pid];
      players[pid] = { id: p.id, name: p.name, color: p.color };
    }
    return {
      gridW: GRID_W,
      gridH: GRID_H,
      cells: this.cells.map((c) => ({
        land: c.land,
        owner: c.owner,
        troops: c.troops,
        port: c.port,
        city: c.city,
      })),
      players,
    };
  }
}
const game = new Game();
// Manage bots to fill up the game
function ensureBots() {
  while (game.bots.length + Object.keys(game.players).length < MAX_PLAYERS_PER_GAME) {
    const botId = 'bot-' + Math.random().toString(36).substr(2, 5);
    const color = randomColor();
    const bot = { id: botId, name: 'Bot', color, cells: new Set() };
    game.bots.push(bot);
    game.players[botId] = bot;
  }
}
// SSE clients: list of {id, res}
const sseClients = [];
// Broadcast new state to all SSE clients
function broadcastState() {
  const data = JSON.stringify(game.serializeState());
  for (const client of sseClients) {
    client.res.write(`data: ${data}\n\n`);
  }
}
// Periodic update
setInterval(() => {
  game.update();
  broadcastState();
}, TICK_INTERVAL_MS);
// Helper to parse JSON body from POST requests
function parseRequestBody(req, callback) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk.toString();
  });
  req.on('end', () => {
    try {
      const json = JSON.parse(body || '{}');
      callback(null, json);
    } catch (err) {
      callback(err);
    }
  });
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // SSE endpoint
  if (url.pathname === '/events') {
    const playerId = url.searchParams.get('id');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`data: ${JSON.stringify(game.serializeState())}\n\n`);
    const client = { id: playerId, res };
    sseClients.push(client);
    // Remove player and SSE client on close
    req.on('close', () => {
      const idx = sseClients.indexOf(client);
      if (idx >= 0) sseClients.splice(idx, 1);
      if (playerId && !playerId.startsWith('bot-')) {
        game.removePlayer(playerId);
      }
    });
    return;
  }
  // API routes
  if (req.method === 'POST' && url.pathname === '/api/join') {
    parseRequestBody(req, (err, body) => {
      if (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
        return;
      }
      const name = body.name || 'Anonyme';
      const id = Math.random().toString(36).substr(2, 9);
      const ok = game.addPlayer(id, name);
      if (!ok) {
        res.writeHead(403);
        res.end(JSON.stringify({ ok: false, error: 'Partie pleine' }));
        return;
      }
      ensureBots();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, playerId: id }));
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/spawn') {
    parseRequestBody(req, (err, body) => {
      if (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      const { playerId, x, y } = body;
      const ok = game.spawn(playerId, x, y);
      res.writeHead(200);
      res.end(JSON.stringify({ ok }));
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/attack') {
    parseRequestBody(req, (err, body) => {
      if (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      const { playerId, srcX, srcY, dstX, dstY, troopsPercent } = body;
      const srcIdx = srcY * GRID_W + srcX;
      const srcCell = game.cells[srcIdx];
      let ok = false;
      if (srcCell && srcCell.owner === playerId) {
        const available = srcCell.troops;
        const troops = Math.floor(available * troopsPercent);
        if (troops >= 1) {
          ok = game.attack(playerId, srcX, srcY, dstX, dstY, troops);
        }
      }
      res.writeHead(200);
      res.end(JSON.stringify({ ok }));
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/build_port') {
    parseRequestBody(req, (err, body) => {
      const { playerId, x, y } = body;
      const ok = game.buildPort(playerId, x, y);
      res.writeHead(200);
      res.end(JSON.stringify({ ok }));
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/build_city') {
    parseRequestBody(req, (err, body) => {
      const { playerId, x, y } = body;
      const ok = game.buildCity(playerId, x, y);
      res.writeHead(200);
      res.end(JSON.stringify({ ok }));
    });
    return;
  }
  // Serve static files
  let filePath = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
  fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404);
        res.end('404');
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(500);
          res.end('Server Error');
          return;
        }
        // Determine MIME type
        const ext = path.extname(filePath).toLowerCase();
        let contentType = 'text/plain';
        if (ext === '.html') contentType = 'text/html';
        else if (ext === '.css') contentType = 'text/css';
        else if (ext === '.js') contentType = 'application/javascript';
        else if (ext === '.png') contentType = 'image/png';
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
      });
  });
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Server listening on port', PORT);
});
