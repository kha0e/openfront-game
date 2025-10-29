(() => {
  let playerId = null;
  let gameState = null;
  let selectedCell = null;
  let worldImage = null;
  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');
  const loginOverlay = document.getElementById('login-overlay');
  const nameInput = document.getElementById('name-input');
  const joinBtn = document.getElementById('join-btn');
  const joinError = document.getElementById('join-error');
  const troopSlider = document.getElementById('troop-slider');
  const troopValue = document.getElementById('troop-value');
  const buildPortBtn = document.getElementById('build-port-btn');
  const buildCityBtn = document.getElementById('build-city-btn');
  // Update slider label
  troopSlider.addEventListener('input', () => {
    troopValue.textContent = troopSlider.value + '%';
  });
  // Resize canvas
  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    drawGame();
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();
  // Load world image
  function loadWorldImage() {
    worldImage = new Image();
    worldImage.src = 'assets/world_map.png';
    worldImage.onload = drawGame;
  }
  loadWorldImage();
  // Convert mouse event to grid coordinates
  function eventToGridCoords(ev) {
    if (!gameState) return null;
    const rect = canvas.getBoundingClientRect();
    const cx = ev.clientX - rect.left;
    const cy = ev.clientY - rect.top;
    const cellW = canvas.width / gameState.gridW;
    const cellH = canvas.height / gameState.gridH;
    const x = Math.floor(cx / cellW);
    const y = Math.floor(cy / cellH);
    if (x < 0 || y < 0 || x >= gameState.gridW || y >= gameState.gridH) return null;
    return { x, y };
  }
  // Join handler
  joinBtn.addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) {
      joinError.textContent = 'Veuillez entrer un nom.';
      return;
    }
    fetch('/api/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
      .then((res) => res.json())
      .then((resp) => {
        if (resp.ok) {
          playerId = resp.playerId;
          loginOverlay.style.display = 'none';
          startEventStream();
        } else {
          joinError.textContent = resp.error || 'Impossible de rejoindre la partie.';
        }
      })
      .catch(() => {
        joinError.textContent = 'Erreur de connexion.';
      });
  });
  // Start Server-Sent Events connection
  function startEventStream() {
    const evtSrc = new EventSource('/events?id=' + encodeURIComponent(playerId));
    evtSrc.onmessage = (ev) => {
      try {
        const state = JSON.parse(ev.data);
        gameState = state;
        // Keep selected cell if it still belongs to the player
        if (selectedCell) {
          const idx = selectedCell.y * state.gridW + selectedCell.x;
          const cell = state.cells[idx];
          if (!cell || cell.owner !== playerId) {
            selectedCell = null;
          }
        }
        drawGame();
      } catch (err) {
        console.error('Error parsing state', err);
      }
    };
    evtSrc.onerror = () => {
      console.error('EventSource error');
    };
  }
  // Canvas click handler
  canvas.addEventListener('click', (ev) => {
    if (!gameState || !playerId) return;
    const coords = eventToGridCoords(ev);
    if (!coords) return;
    const { x, y } = coords;
    const idx = y * gameState.gridW + x;
    const cell = gameState.cells[idx];
    const isShift = ev.shiftKey;
    if (!selectedCell) {
      if (cell.owner === playerId) {
        selectedCell = { x, y };
      } else if (cell.land && !cell.owner) {
        // Spawn
        fetch('/api/spawn', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ playerId, x, y }),
        });
      }
    } else {
      if (isShift) {
        // Attack
        const percent = parseInt(troopSlider.value, 10) / 100;
        fetch('/api/attack', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            playerId,
            srcX: selectedCell.x,
            srcY: selectedCell.y,
            dstX: x,
            dstY: y,
            troopsPercent: percent,
          }),
        });
      }
      if (cell.owner === playerId) {
        selectedCell = { x, y };
      }
    }
  });
  // Right click to deselect
  canvas.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    selectedCell = null;
  });
  // Build port/city buttons
  buildPortBtn.addEventListener('click', () => {
    if (!selectedCell || !playerId) return;
    fetch('/api/build_port', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId, x: selectedCell.x, y: selectedCell.y }),
    });
  });
  buildCityBtn.addEventListener('click', () => {
    if (!selectedCell || !playerId) return;
    fetch('/api/build_city', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId, x: selectedCell.x, y: selectedCell.y }),
    });
  });
  // Draw game state
  function drawGame() {
    if (!gameState) return;
    if (worldImage && worldImage.complete) {
      ctx.drawImage(worldImage, 0, 0, canvas.width, canvas.height);
    } else {
      ctx.fillStyle = '#004';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    const cellW = canvas.width / gameState.gridW;
    const cellH = canvas.height / gameState.gridH;
    for (let y = 0; y < gameState.gridH; y++) {
      for (let x = 0; x < gameState.gridW; x++) {
        const idx = y * gameState.gridW + x;
        const cell = gameState.cells[idx];
        if (!cell.land) continue;
        if (cell.owner) {
          const player = gameState.players[cell.owner];
          ctx.fillStyle = player ? player.color : '#888';
        } else {
          ctx.fillStyle = 'rgba(255,255,255,0.05)';
        }
        ctx.fillRect(x * cellW, y * cellH, cellW, cellH);
        if (selectedCell && selectedCell.x === x && selectedCell.y === y) {
          ctx.strokeStyle = '#FFD700';
          ctx.lineWidth = 2;
          ctx.strokeRect(x * cellW + 1, y * cellH + 1, cellW - 2, cellH - 2);
        }
        if (cell.port) {
          ctx.fillStyle = '#00BFFF';
          ctx.beginPath();
          ctx.arc(
            x * cellW + cellW * 0.8,
            y * cellH + cellH * 0.2,
            Math.min(cellW, cellH) * 0.1,
            0,
            Math.PI * 2
          );
          ctx.fill();
        }
        if (cell.city) {
          ctx.fillStyle = '#FFA500';
          ctx.beginPath();
          ctx.arc(
            x * cellW + cellW * 0.2,
            y * cellH + cellH * 0.2,
            Math.min(cellW, cellH) * 0.1,
            0,
            Math.PI * 2
          );
          ctx.fill();
        }
        if (cell.owner && cell.troops > 0) {
          ctx.fillStyle = '#000';
          ctx.font = `${Math.floor(cellH * 0.5)}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(cell.troops.toString(), x * cellW + cellW / 2, y * cellH + cellH / 2);
        }
      }
    }
  }
})();
