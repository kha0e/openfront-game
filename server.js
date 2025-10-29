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

// Game class defines the grid and methods for manipulating it.  This version
// manages troops on a per‑player basis rather than per cell.  Each player
// receives pooled troops which grow over time based on territory size and
// cities.  Attacks spend a percentage of the player's total troops.
class Game {
  constructor() {
    // Initialise each grid cell; troops property remains for legacy but is
    // unused in the gameplay.  Ports and cities live on cells.
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
    // players[id] = { id, name, color, cells: Set<int>, troops: number }
    this.players = {};
    this.bots = [];
  }
  /**
   * Add a new player to the game.  Returns false if the maximum number of
   * players has been reached.
   */
  addPlayer(id, name) {
    if (Object.keys(this.players).length >= MAX_PLAYERS_PER_GAME) return false;
    const color = randomColor();
    // Start with no territory and zero troops.  Troops will be granted on
    // spawn.
    this.players[id] = { id, name, color, cells: new Set(), troops: 0 };
    return true;
  }
  /**
   * Remove a player from the game and free their territory.
   */
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
  /**
   * Spawn a player on an empty land cell.  Grants initial troops to the
   * player and claims the chosen cell.
   */
  spawn(id, x, y) {
    const idx = y * GRID_W + x;
    const cell = this.cells[idx];
    if (!cell.land || cell.owner) return false;
    cell.owner = id;
    cell.troops = 0;
    cell.port = false;
    cell.city = false;
    this.players[id].cells.add(idx);
    // grant starting troops
    this.players[id].troops += 10;
    return true;
  }
  /**
   * Attack from a source cell to a destination cell using a fraction of the
   * player's pooled troops.  The percent argument should be in the range
   * 0–1.  The game will deduct that percentage of the player's total troops
   * and resolve the attack.  Returns true if the attack was valid.
   */
  attack(id, srcX, srcY, dstX, dstY, percent) {
    const srcIdx = srcY * GRID_W + srcX;
    const dstIdx = dstY * GRID_W + dstX;
    const srcCell = this.cells[srcIdx];
    const dstCell = this.cells[dstIdx];
    const player = this.players[id];
    if (!player || !srcCell || srcCell.owner !== id) return false;
    // Validate movement: either adjacent or two steps via port for water jump
    const dx = dstX - srcX;
    const dy = dstY - srcY;
    const maxStep = Math.max(Math.abs(dx), Math.abs(dy));
    if (maxStep !== 1) {
      if (maxStep === 2 && srcCell.port) {
        const midX = srcX + Math.sign(dx);
        const midY = srcY + Math.sign(dy);
        const midIdx = midY * GRID_W + midX;
        const midCell = this.cells[midIdx];
        if (!(midCell && !midCell.land && dstCell && dstCell.land)) {
          return false;
        }
      } else {
        return false;
      }
    }
    // Compute troops to send.  Require at least one.
    const totalTroops = player.troops;
    const toSend = Math.floor(totalTroops * percent);
    if (toSend < 1) return false;
    // Deduct troops from the player
    player.troops -= toSend;
    // If dest is unowned, capture it
    if (!dstCell.owner) {
      dstCell.owner = id;
      dstCell.port = false;
      dstCell.city = false;
      player.cells.add(dstIdx);
      return true;
    }
    // If dest belongs to attacker, do nothing (no reinforcement)
    if (dstCell.owner === id) {
      return false;
    }
    // Otherwise battle another player
    const defenderId = dstCell.owner;
    const defender = this.players[defenderId];
    if (!defender) return false;
    if (toSend > defender.troops) {
      // Eliminates defender's troops
      defender.troops = 0;
      // Transfer cell
      defender.cells.delete(dstIdx);
      dstCell.owner = id;
      dstCell.port = false;
      dstCell.city = false;
      player.cells.add(dstIdx);
      return true;
    }
    // Otherwise reduce defender troop pool
    defender.troops -= toSend;
    return true;
  }
  /**
   * Expand from a source cell into all neighbouring enemy or unclaimed cells.
   * Sends the specified fraction of troops divided evenly among all targets.
   */
  expand(id, x, y, percent) {
    const srcIdx = y * GRID_W + x;
    const srcCell = this.cells[srcIdx];
    if (!srcCell || srcCell.owner !== id) return false;
    const player = this.players[id];
    if (!player) return false;
    // Build list of reachable target coordinates (adjacent or via port)
    const targets = [];
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        if (i === 0 && j === 0) continue;
        const nx = x + i;
        const ny = y + j;
        if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
        const nidx = ny * GRID_W + nx;
        const ncell = this.cells[nidx];
        if (!ncell) continue;
        if (!ncell.owner || ncell.owner !== id) {
          targets.push({ x: nx, y: ny });
        }
      }
    }
    // Port jump (two steps) if source has a port
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
        if (midCell && !midCell.land && destCell && destCell.land && (!destCell.owner || destCell.owner !== id)) {
          targets.push({ x: destX, y: destY });
        }
      }
    }
    if (targets.length === 0) return false;
    // Divide the percent across all targets.  We'll call attack for each.
    const per = percent / targets.length;
    let any = false;
    for (const t of targets) {
      const ok = this.attack(id, x, y, t.x, t.y, per);
      any = any || ok;
    }
    return any;
  }
  /**
   * Build a port on a cell if adjacent to water and player has enough troops.
   */
  buildPort(id, x, y) {
    const idx = y * GRID_W + x;
    const cell = this.cells[idx];
    const player = this.players[id];
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
    if (!player || player.troops < 5) return false;
    player.troops -= 5;
    cell.port = true;
    return true;
  }
  /**
   * Build a city on a cell if the player has enough troops.
   */
  buildCity(id, x, y) {
    const idx = y * GRID_W + x;
    const cell = this.cells[idx];
    const player = this.players[id];
    if (!cell || cell.owner !== id || !cell.land || cell.city) return false;
    if (!player || player.troops < 10) return false;
    player.troops -= 10;
    cell.city = true;
    return true;
  }
  /**
   * Periodic update: grows troop pools and executes bot actions.
   */
  update() {
    // Grow troops for each player based on territory and cities
    for (const pid in this.players) {
      const player = this.players[pid];
      const territorySize = player.cells.size;
      let cityCount = 0;
      for (const cellIdx of player.cells) {
        const cell = this.cells[cellIdx];
        if (cell.city) cityCount += 1;
      }
      let maxTroops = 5 + Math.floor(territorySize / 2) + cityCount * 5;
      const growth = Math.max(1, Math.floor(player.troops / 3));
      player.troops = Math.min(player.troops + growth, maxTroops);
    }
    // bot actions
    for (const bot of this.bots) {
      this.botAct(bot);
    }
  }
  /**
   * Bot behaviour using pooled troops.  Bots expand randomly.
   */
  botAct(bot) {
    if (bot.cells.size === 0) {
      // spawn
      for (let i = 0; i < 50; i++) {
        const x = Math.floor(Math.random() * GRID_W);
        const y = Math.floor(Math.random() * GRID_H);
        const idx = y * GRID_W + x;
        const cell = this.cells[idx];
        if (cell.land && !cell.owner) {
          cell.owner = bot.id;
          cell.port = false;
          cell.city = false;
          bot.cells.add(idx);
          bot.troops = 10;
          return;
        }
      }
      return;
    }
    const ownCells = Array.from(bot.cells);
    const srcIdx = ownCells[Math.floor(Math.random() * ownCells.length)];
    const srcCell = this.cells[srcIdx];
    const x = srcIdx % GRID_W;
    const y = Math.floor(srcIdx / GRID_W);
    // gather possible targets
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
        if (!ncell.owner || ncell.owner !== bot.id) {
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
        if (midCell && !midCell.land && destCell && destCell.land && (!destCell.owner || destCell.owner !== bot.id)) {
          possibleTargets.push({ x: destX, y: destY });
        }
      }
    }
    if (possibleTargets.length === 0) return;
    // Choose one and attack with half of bot's troops
    const target = possibleTargets[Math.floor(Math.random() * possibleTargets.length)];
    const toSend = Math.floor(bot.troops / 2);
    if (toSend < 1) return;
    const percent = toSend / bot.troops;
    this.attack(bot.id, x, y, target.x, target.y, percent);
  }
  /**
   * Prepare state for sending to clients.  Includes player troop counts.
   */
  serializeState() {
    const players = {};
    for (const pid in this.players) {
      const p = this.players[pid];
      players[pid] = { id: p.id, name: p.name, color: p.color, troops: p.troops };
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
    const bot = { id: botId, name: 'Bot', color, cells: new Set(), troops: 0 };
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
      const ok = game.attack(playerId, srcX, srcY, dstX, dstY, troopsPercent);
      res.writeHead(200);
      res.end(JSON.stringify({ ok }));
    });
    return;
  }
  // Expand API: attack all neighbouring cells using a percentage of troop pool
  if (req.method === 'POST' && url.pathname === '/api/expand') {
    parseRequestBody(req, (err, body) => {
      if (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      const { playerId, x, y, troopsPercent } = body;
      const ok = game.expand(playerId, x, y, troopsPercent);
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