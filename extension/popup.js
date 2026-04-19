const BOARD_SIZE = 10;
const SHIP_SET = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];

let ws = null;
let state = {
    roomId: null,
    playerId: null,
    status: 'waiting',
    turn: null,
    winner: null,
    players: [],
    ready: [],
    myShips: [],
    myHitsTaken: [],
    myShots: [],
    enemyHitsTaken: [],
    enemyShots: [],
};

const connectBtn = document.getElementById('connect');
const autoPlaceBtn = document.getElementById('autoPlace');
const sendFleetBtn = document.getElementById('sendFleet');
const statusEl = document.getElementById('status');
const playersEl = document.getElementById('players');
const roomEl = document.getElementById('room');
const serverUrlEl = document.getElementById('serverUrl');
const myBoardEl = document.getElementById('myBoard');
const enemyBoardEl = document.getElementById('enemyBoard');

connectBtn.onclick = connect;
autoPlaceBtn.onclick = autoPlace;
sendFleetBtn.onclick = sendFleet;

renderBoards();

function connect() {
    const room = roomEl.value.trim();
    const serverUrl = serverUrlEl.value.trim();

    if (!room) {
        alert('Введите название комнаты');
        return;
    }

    if (!serverUrl.startsWith('ws://') && !serverUrl.startsWith('wss://')) {
        alert('Неверный URL WebSocket');
        return;
    }

    if (ws && ws.readyState <= 1) {
        ws.close();
    }

    ws = new WebSocket(serverUrl);

    ws.onopen = () => {
        setStatus('Подключено. Вход в комнату...');
        ws.send(JSON.stringify({ type: 'join', room }));
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

        if (data.type === 'room-state') {
            applyRoomState(data);
            return;
        }

        if (data.type === 'move-result') {
            if (data.winner) {
                setStatus(data.winner === state.playerId ? 'Вы победили!' : 'Вы проиграли.');
            }
        }
    };

    ws.onclose = () => {
        setStatus('Отключено от сервера');
    };

    ws.onerror = () => {
        setStatus('Ошибка подключения');
    };
}

function applyRoomState(data) {
    state.roomId = data.roomId;
    state.status = data.status;
    state.turn = data.turn;
    state.winner = data.winner;
    state.players = data.players || [];
    state.ready = data.ready || [];
    state.myShips = data.yourShips || [];
    state.myHitsTaken = data.yourHitsTaken || [];
    state.myShots = data.yourShots || [];
    state.enemyHitsTaken = data.enemyHitsTaken || [];
    state.enemyShots = data.enemyShots || [];

    autoPlaceBtn.disabled = state.players.length < 1;
    sendFleetBtn.disabled = state.myShips.length !== SHIP_SET.length;

    const readyString = state.ready.map((r) => `${r.id.slice(0, 4)}:${r.ready ? '✅' : '⌛'}`).join(', ');
    playersEl.textContent = `Игроки (${state.players.length}/2): ${readyString || '-'}`;

    if (data.infoMessage) {
        setStatus(data.infoMessage);
    } else if (state.status === 'waiting') {
        setStatus('Ждём второго игрока и готовности.');
    } else if (state.status === 'playing') {
        setStatus(state.turn === state.playerId ? 'Ваш ход.' : 'Ход соперника.');
    } else if (state.status === 'finished') {
        setStatus(state.winner === state.playerId ? 'Вы победили!' : 'Победил соперник.');
    }

    renderBoards();
}

function setStatus(text) {
    statusEl.textContent = `Статус: ${text}`;
}

function autoPlace() {
    const ships = generateFleet();
    state.myShips = ships;
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

function renderBoards() {
    const myShipKeys = new Set(state.myShips.flatMap((ship) => ship.cells.map((c) => `${c.x}:${c.y}`)));
    const myHitKeys = new Set(state.myHitsTaken.map((c) => `${c.x}:${c.y}`));
    const enemyShotKeys = new Set(state.enemyShots.map((c) => `${c.x}:${c.y}`));

    const enemyMyShotKeys = new Set(state.myShots.map((c) => `${c.x}:${c.y}`));
    const enemyHitKeys = new Set(state.enemyHitsTaken.map((c) => `${c.x}:${c.y}`));

    myBoardEl.innerHTML = '';
    enemyBoardEl.innerHTML = '';

    for (let y = 0; y < BOARD_SIZE; y++) {
        for (let x = 0; x < BOARD_SIZE; x++) {
            const key = `${x}:${y}`;
            const myCell = document.createElement('div');
            myCell.className = 'cell';
            if (myShipKeys.has(key)) myCell.classList.add('ship');
            if (myHitKeys.has(key)) myCell.classList.add('hit');
            if (enemyShotKeys.has(key) && !myHitKeys.has(key)) myCell.classList.add('miss');
            myBoardEl.appendChild(myCell);

            const enemyCell = document.createElement('div');
            enemyCell.className = 'cell enemy';
            if (enemyMyShotKeys.has(key) && enemyHitKeys.has(key)) {
                enemyCell.classList.add('hit');
            } else if (enemyMyShotKeys.has(key)) {
                enemyCell.classList.add('miss');
            }

            enemyCell.onclick = () => {
                if (!ws || ws.readyState !== 1) return;
                if (state.status !== 'playing') return;
                if (state.turn !== state.playerId) return;
                if (enemyMyShotKeys.has(key)) return;

                ws.send(JSON.stringify({ type: 'move', x, y }));
            };

            enemyBoardEl.appendChild(enemyCell);
        }
    }
}

function generateFleet() {
    const board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(0));
    const ships = [];

    for (const size of SHIP_SET) {
        let placed = false;
        let attempts = 0;

        while (!placed && attempts < 2000) {
            attempts++;
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

            if (!cells.length || !canPlaceShip(board, cells)) {
                continue;
            }

            for (const cell of cells) {
                board[cell.y][cell.x] = 1;
            }
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