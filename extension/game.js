const BOARD_SIZE = 10;
const SHIP_SET = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];

let ws = null;
let pendingAction = null;

const state = {
    playerId: null,
    roomId: null,
    hostId: null,
    maxPlayers: 4,
    status: 'waiting',
    turn: null,
    winner: null,
    players: [],
    myShips: [],
    myHitsTaken: [],
    shotBoards: {},
    selectedTargetId: '',
    leaderboard: [],
    events: [],
};

const serverUrlEl = document.getElementById('serverUrl');
const detectServerUrlBtn = document.getElementById('detectServerUrl');
const nicknameEl = document.getElementById('nickname');
const roomEl = document.getElementById('room');
const maxPlayersEl = document.getElementById('maxPlayers');
const createRoomBtn = document.getElementById('createRoom');
const joinRoomBtn = document.getElementById('joinRoom');
const autoPlaceBtn = document.getElementById('autoPlace');
const sendFleetBtn = document.getElementById('sendFleet');
const startGameBtn = document.getElementById('startGame');
const statusEl = document.getElementById('status');
const turnBannerEl = document.getElementById('turnBanner');
const roomMetaEl = document.getElementById('roomMeta');
const playersEl = document.getElementById('players');
const leaderboardEl = document.getElementById('leaderboard');
const eventsEl = document.getElementById('events');
const myBoardEl = document.getElementById('myBoard');
const enemyBoardEl = document.getElementById('enemyBoard');
const targetSelectEl = document.getElementById('targetSelect');

createRoomBtn.onclick = () => connect('create-room');
joinRoomBtn.onclick = () => connect('join-room');
detectServerUrlBtn.onclick = detectServerUrl;
autoPlaceBtn.onclick = autoPlace;
sendFleetBtn.onclick = sendFleet;
startGameBtn.onclick = startGame;
targetSelectEl.onchange = () => {
    state.selectedTargetId = targetSelectEl.value;
    renderBoards();
};

renderBoards();

function connect(action) {
    const room = roomEl.value.trim();
    const serverUrl = serverUrlEl.value.trim();
    const nickname = nicknameEl.value.trim();

    if (!room) {
        alert('Введите код комнаты');
        return;
    }

    if (!serverUrl.startsWith('ws://') && !serverUrl.startsWith('wss://')) {
        alert('Некорректный URL WebSocket');
        return;
    }

    if (ws && ws.readyState <= 1) {
        ws.close();
    }

    pendingAction = {
        type: action,
        room,
        nickname,
        maxPlayers: Number(maxPlayersEl.value),
    };

    ws = new WebSocket(serverUrl);

    ws.onopen = () => {
        setStatus('Подключено к серверу. Отправляем запрос в комнату...');
        ws.send(JSON.stringify(pendingAction));
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.type === 'hello') {
            state.playerId = data.playerId;
            return;
        }

        if (data.type === 'error') {
            alert(data.message);
            return;
        }

        if (data.type === 'move-result' && data.winner) {
            handleMoveResult(data);
            return;
        }

        if (data.type === 'move-result') {
            handleMoveResult(data);
            return;
        }

        if (data.type === 'room-state') {
            applyRoomState(data);
        }
    };

    ws.onclose = () => setStatus('Отключено от сервера');
    ws.onerror = () => setStatus('Ошибка подключения');
}

async function detectServerUrl() {
    detectServerUrlBtn.disabled = true;

    try {
        const response = await fetch('http://localhost:3000/network-info');
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        const url = Array.isArray(data.wsUrls) && data.wsUrls.length ? data.wsUrls[0] : '';

        if (!url) {
            alert('Не удалось определить адрес. Проверьте, что сервер запущен на этом ПК.');
            return;
        }

        serverUrlEl.value = url;
        setStatus(`Автоподстановка: ${url}`);
    } catch {
        alert('Не удалось получить IP хоста. Запустите сервер (npm start) на этом ПК или введите адрес вручную.');
    } finally {
        detectServerUrlBtn.disabled = false;
    }
}

function applyRoomState(data) {
    state.roomId = data.roomId;
    state.hostId = data.hostId;
    state.maxPlayers = data.maxPlayers;
    state.status = data.status;
    state.turn = data.turn;
    state.winner = data.winner;
    state.players = data.players || [];
    state.myShips = data.yourShips || [];
    state.myHitsTaken = data.yourHitsTaken || [];
    state.shotBoards = data.shotBoards || {};
    state.leaderboard = data.leaderboard || [];

    syncTargetSelect();

    autoPlaceBtn.disabled = state.status !== 'waiting';
    sendFleetBtn.disabled = state.myShips.length !== SHIP_SET.length || state.status !== 'waiting';

    const isHost = state.playerId === state.hostId;
    const everyoneJoined = state.players.length === state.maxPlayers;
    const everyoneReady = state.players.length > 0 && state.players.every((player) => player.ready);
    startGameBtn.disabled = !(isHost && state.status === 'waiting' && everyoneJoined && everyoneReady);

    roomMetaEl.textContent = `Комната: ${state.roomId} | Хост: ${short(state.hostId)} | Игроки: ${state.players.length}/${state.maxPlayers}`;
    renderPlayers();

    if (data.infoMessage) {
        setStatus(data.infoMessage);
    } else if (state.status === 'waiting') {
        setStatus('Ожидание игроков, расстановки и запуска от хоста.');
    } else if (state.status === 'playing') {
        setStatus(state.turn === state.playerId ? 'Ваш ход. Выберите цель и стреляйте.' : `Ход игрока ${short(state.turn)}`);
    } else if (state.status === 'finished') {
        setStatus(state.winner === state.playerId ? 'Победа! 🎉' : `Победил ${short(state.winner)}`);
    }

    renderBoards();
    renderTurnBanner();
    renderLeaderboard();
    renderEvents();
}

function renderPlayers() {
    playersEl.innerHTML = '';
    state.players.forEach((player) => {
        const badge = document.createElement('div');
        badge.className = 'player-badge';
        if (state.status === 'playing' && player.id === state.turn) {
            badge.classList.add('turn');
        }
        badge.innerHTML = `
            <strong>${player.nickname}</strong>
            <span>${short(player.id)}</span>
            <span>${player.id === state.hostId ? '👑 Хост' : '👤 Игрок'}</span>
            <span>${player.ready ? '✅ Готов' : '⌛ Расставляет флот'}</span>
            <span>${player.alive ? '🟢 В игре' : '⚫ Выбыл'}</span>
        `;
        playersEl.appendChild(badge);
    });
}

function renderTurnBanner() {
    turnBannerEl.className = 'turn-banner';

    if (state.status === 'waiting') {
        turnBannerEl.textContent = 'Подготовка к бою: расставьте флот и ждите запуск от хоста.';
        return;
    }

    if (state.status === 'playing') {
        if (state.turn === state.playerId) {
            turnBannerEl.textContent = '🔥 СЕЙЧАС ВАШ ХОД! Выберите живого противника и нанесите удар.';
            turnBannerEl.classList.add('my-turn');
            return;
        }

        const active = state.players.find((player) => player.id === state.turn);
        turnBannerEl.textContent = `⌛ Ход игрока: ${active ? active.nickname : short(state.turn)}.`;
        return;
    }

    if (state.status === 'finished') {
        const winner = state.players.find((player) => player.id === state.winner);
        turnBannerEl.textContent = winner && winner.id === state.playerId
            ? '🏆 МАТЧ ОКОНЧЕН: ВЫ ПОБЕДИЛИ!'
            : `🏁 Матч окончен. Победитель: ${winner ? winner.nickname : short(state.winner)}.`;
        turnBannerEl.classList.add('finished');
        return;
    }

    turnBannerEl.textContent = 'Игра не активна.';
}

function renderLeaderboard() {
    leaderboardEl.innerHTML = '';
    if (!state.leaderboard.length) {
        leaderboardEl.textContent = 'Рейтинг появится после старта матча.';
        return;
    }

    state.leaderboard.forEach((entry) => {
        const row = document.createElement('div');
        row.className = 'leaderboard-item';
        if (entry.id === state.playerId) {
            row.classList.add('me');
        }

        row.innerHTML = `
            <strong>#${entry.place}</strong>
            <span>${entry.nickname}</span>
            <span>🎯 ${entry.hits}</span>
            <span>💥 ${entry.kills}</span>
            <span>🚢 ${entry.shipsSunk}</span>
            <span>⭐ ${entry.score}</span>
        `;
        leaderboardEl.appendChild(row);
    });
}

function renderEvents() {
    eventsEl.innerHTML = '';
    if (!state.events.length) {
        eventsEl.textContent = 'Лента событий пуста.';
        return;
    }

    state.events.slice(-8).reverse().forEach((message) => {
        const eventEl = document.createElement('div');
        eventEl.className = 'event-item';
        eventEl.textContent = message;
        eventsEl.appendChild(eventEl);
    });
}

function syncTargetSelect() {
    const aliveOpponents = state.players.filter((player) => player.id !== state.playerId && player.alive);

    targetSelectEl.innerHTML = '';
    aliveOpponents.forEach((player) => {
        const option = document.createElement('option');
        option.value = player.id;
        option.textContent = `${player.nickname} (${short(player.id)})`;
        targetSelectEl.appendChild(option);
    });

    if (!aliveOpponents.length) {
        state.selectedTargetId = '';
        return;
    }

    if (!aliveOpponents.some((player) => player.id === state.selectedTargetId)) {
        state.selectedTargetId = aliveOpponents[0].id;
    }

    targetSelectEl.value = state.selectedTargetId;
}

function setStatus(text) {
    statusEl.textContent = `Статус: ${text}`;
}

function handleMoveResult(data) {
    const attacker = playerName(data.from);
    const defender = playerName(data.to);
    const coord = `${data.target?.x + 1}:${data.target?.y + 1}`;
    const shotResult = data.hit ? 'попадание' : 'мимо';
    let message = `🎯 ${attacker} → ${defender} (${coord}): ${shotResult}.`;

    if (data.shipSunk) {
        message += ` Корабль ${defender} уничтожен!`;
    }
    if (data.defenderDefeated) {
        message += ` Игрок ${defender} выбыл из матча.`;
    }
    if (data.winner) {
        message += ` Победитель: ${playerName(data.winner)}.`;
    }

    pushEvent(message);

    if (data.to === state.playerId && data.hit) {
        setStatus(`По вашему флоту попал ${attacker} (${coord}).`);
    } else if (data.from === state.playerId) {
        if (data.hit) {
            setStatus(data.shipSunk ? `Отличный выстрел: корабль ${defender} потоплен.` : `Есть попадание по ${defender}.`);
        } else {
            setStatus(`Вы промахнулись по ${defender}.`);
        }
    }
}

function pushEvent(message) {
    state.events.push(message);
    if (state.events.length > 30) {
        state.events = state.events.slice(-30);
    }
    renderEvents();
}

function playerName(id) {
    const player = state.players.find((candidate) => candidate.id === id);
    return player ? player.nickname : short(id);
}

function autoPlace() {
    state.myShips = generateFleet();
    sendFleetBtn.disabled = false;
    renderBoards();
}

function sendFleet() {
    if (!ws || ws.readyState !== 1) {
        alert('Сначала подключитесь к серверу');
        return;
    }

    ws.send(JSON.stringify({ type: 'place-ships', ships: state.myShips }));
}

function startGame() {
    if (!ws || ws.readyState !== 1) {
        alert('Нет подключения к серверу');
        return;
    }

    ws.send(JSON.stringify({ type: 'start-game' }));
}

function renderBoards() {
    myBoardEl.innerHTML = '';
    enemyBoardEl.innerHTML = '';

    const myShipKeys = new Set(state.myShips.flatMap((ship) => ship.cells.map((cell) => key(cell.x, cell.y))));
    const myHitKeys = new Set(state.myHitsTaken.map((cell) => key(cell.x, cell.y)));

    const selectedBoard = state.shotBoards[state.selectedTargetId] || { yourShots: [], hitsOnOpponent: [], shotsFromOpponent: [] };
    const yourShotKeys = new Set((selectedBoard.yourShots || []).map((cell) => key(cell.x, cell.y)));
    const hitOnOpponentKeys = new Set((selectedBoard.hitsOnOpponent || []).map((cell) => key(cell.x, cell.y)));

    for (let y = 0; y < BOARD_SIZE; y++) {
        for (let x = 0; x < BOARD_SIZE; x++) {
            const coordinate = key(x, y);

            const myCell = document.createElement('button');
            myCell.className = 'cell';
            if (myShipKeys.has(coordinate)) myCell.classList.add('ship');
            if (myHitKeys.has(coordinate)) myCell.classList.add('hit');
            if (myHitKeys.has(coordinate) && !myShipKeys.has(coordinate)) myCell.classList.add('miss');
            myCell.disabled = true;
            myBoardEl.appendChild(myCell);

            const enemyCell = document.createElement('button');
            enemyCell.className = 'cell enemy';
            if (yourShotKeys.has(coordinate) && hitOnOpponentKeys.has(coordinate)) {
                enemyCell.classList.add('hit');
            } else if (yourShotKeys.has(coordinate)) {
                enemyCell.classList.add('miss');
            }

            enemyCell.onclick = () => attack(state.selectedTargetId, x, y, yourShotKeys.has(coordinate));
            enemyBoardEl.appendChild(enemyCell);
        }
    }
}

function attack(targetId, x, y, alreadyShot) {
    if (!targetId) return;
    if (!ws || ws.readyState !== 1) return;
    if (state.status !== 'playing') return;
    if (state.turn !== state.playerId) return;
    if (alreadyShot) return;

    ws.send(JSON.stringify({ type: 'move', targetId, x, y }));
}

function key(x, y) {
    return `${x}:${y}`;
}

function short(id) {
    return id ? id.slice(0, 4) : '-';
}

function generateFleet() {
    const board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(0));
    const ships = [];

    for (const size of SHIP_SET) {
        let placed = false;
        let attempts = 0;

        while (!placed && attempts < 2000) {
            attempts += 1;
            const horizontal = Math.random() < 0.5;
            const startX = Math.floor(Math.random() * BOARD_SIZE);
            const startY = Math.floor(Math.random() * BOARD_SIZE);

            const cells = [];
            for (let i = 0; i < size; i++) {
                const x = startX + (horizontal ? i : 0);
                const y = startY + (horizontal ? 0 : i);
                if (x >= BOARD_SIZE || y >= BOARD_SIZE) {
                    cells.length = 0;
                    break;
                }
                cells.push({ x, y });
            }

            if (!cells.length || !canPlaceShip(board, cells)) continue;

            cells.forEach((cell) => {
                board[cell.y][cell.x] = 1;
            });
            ships.push({ cells });
            placed = true;
        }

        if (!placed) {
            return generateFleet();
        }
    }

    return ships;
}

function canPlaceShip(board, cells) {
    for (const cell of cells) {
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const nx = cell.x + dx;
                const ny = cell.y + dy;
                if (nx < 0 || ny < 0 || nx >= BOARD_SIZE || ny >= BOARD_SIZE) continue;
                if (board[ny][nx] === 1) return false;
            }
        }
    }
    return true;
}