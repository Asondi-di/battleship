const BOARD_SIZE = 10;
const SHIP_SET = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
const SETTINGS_KEY = 'battleshipSettings';
const STATS_KEY = 'battleshipSessionStats';

let ws = null;
let pendingAction = null;
let timerTick = null;
let reconnectTimer = null;
let reconnectAttempt = 0;

const state = {
    playerId: null,
    roomId: null,
    hostId: null,
    maxPlayers: 4,
    status: 'waiting',
    turn: null,
    turnDeadline: null,
    turnTimeoutMs: 30000,
    winner: null,
    players: [],
    myShips: [],
    myHitsTaken: [],
    shotBoards: {},
    chat: [],
    rematchVotes: [],
    selectedTargetId: '',
    leaderboard: [],
    events: [],
    manualOrientation: 'horizontal',
    selectedDockShipIndex: null,
    clientId: '',
    achievements: [],
    achievementSet: new Set(),
    hasSavedMatchStats: false,
    sessionStats: {
        matches: 0,
        wins: 0,
        shots: 0,
        hits: 0,
        shipsSunk: 0,
    },
    settings: {
        serverUrl: 'ws://localhost:3000',
        nickname: '',
        room: '',
        maxPlayers: '4',
        soundEnabled: true,
        manualMode: true,
    },
};

const el = (id) => document.getElementById(id);
const serverUrlEl = el('serverUrl');
const detectServerUrlBtn = el('detectServerUrl');
const nicknameEl = el('nickname');
const roomEl = el('room');
const randomRoomBtn = el('randomRoom');
const copyInviteBtn = el('copyInvite');
const maxPlayersEl = el('maxPlayers');
const createRoomBtn = el('createRoom');
const joinRoomBtn = el('joinRoom');
const addBotBtn = el('addBot');
const autoPlaceBtn = el('autoPlace');
const clearFleetBtn = el('clearFleet');
const sendFleetBtn = el('sendFleet');
const startGameBtn = el('startGame');
const rematchBtn = el('rematch');
const reconnectBtn = el('reconnect');
const soundToggleEl = el('soundToggle');
const manualModeEl = el('manualMode');
const rotateShipBtn = el('rotateShip');
const statusEl = el('status');
const turnBannerEl = el('turnBanner');
const roomMetaEl = el('roomMeta');
const timerMetaEl = el('timerMeta');
const playersEl = el('players');
const achievementsEl = el('achievements');
const leaderboardEl = el('leaderboard');
const sessionStatsEl = el('sessionStats');
const eventsEl = el('events');
const clearEventsBtn = el('clearEvents');
const myBoardEl = el('myBoard');
const enemyBoardEl = el('enemyBoard');
const shipDockEl = el('shipDock');
const targetSelectEl = el('targetSelect');
const targetStatsEl = el('targetStats');
const lobbyProgressEl = el('lobbyProgress');
const lobbyProgressBarEl = el('lobbyProgressBar');
const myProgressEl = el('myProgress');
const myProgressBarEl = el('myProgressBar');
const chatLogEl = el('chatLog');
const chatInputEl = el('chatInput');
const sendChatBtn = el('sendChat');

createRoomBtn.onclick = () => connect('create-room');
joinRoomBtn.onclick = () => connect('join-room');
detectServerUrlBtn.onclick = detectServerUrl;
randomRoomBtn.onclick = generateRoomCode;
copyInviteBtn.onclick = copyInvite;
addBotBtn.onclick = () => wsSend({ type: 'add-bot' });
autoPlaceBtn.onclick = autoPlace;
clearFleetBtn.onclick = clearFleet;
sendFleetBtn.onclick = sendFleet;
startGameBtn.onclick = startGame;
rematchBtn.onclick = () => wsSend({ type: 'request-rematch' });
reconnectBtn.onclick = reconnect;
clearEventsBtn.onclick = () => { state.events = []; renderEvents(); };
sendChatBtn.onclick = sendChat;
chatInputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') sendChat();
});
rotateShipBtn.onclick = () => {
    state.manualOrientation = state.manualOrientation === 'horizontal' ? 'vertical' : 'horizontal';
    rotateShipBtn.textContent = state.manualOrientation === 'horizontal' ? '↻ Горизонтально' : '↕ Вертикально';
};
window.addEventListener('keydown', (event) => {
    if (event.key.toLowerCase() === 'r') rotateShipBtn.click();
    if (event.key.toLowerCase() === 'a' && state.status === 'waiting') autoPlace();
});

soundToggleEl.onchange = () => { state.settings.soundEnabled = soundToggleEl.checked; persistSettings(); };
manualModeEl.onchange = () => { state.settings.manualMode = manualModeEl.checked; persistSettings(); renderShipDock(); };

[serverUrlEl, nicknameEl, roomEl, maxPlayersEl].forEach((element) => {
    element.addEventListener('change', persistSettingsFromFields);
    element.addEventListener('blur', persistSettingsFromFields);
});

targetSelectEl.onchange = () => {
    state.selectedTargetId = targetSelectEl.value;
    renderBoards();
    renderTargetStats();
};

loadSettings();
renderBoards();
renderShipDock();
renderTargetStats();
renderSessionStats();

function connect(action) {
    const room = roomEl.value.trim();
    const serverUrl = serverUrlEl.value.trim();
    const nickname = nicknameEl.value.trim();

    if (!room) return alert('Введите код комнаты');
    if (!serverUrl.startsWith('ws://') && !serverUrl.startsWith('wss://')) return alert('Некорректный URL WebSocket');

    if (ws && ws.readyState <= 1) ws.close();

    persistSettingsFromFields();
    pendingAction = { type: action, room, nickname, maxPlayers: Number(maxPlayersEl.value), clientId: state.clientId };

    ws = new WebSocket(serverUrl);

    ws.onopen = () => {
        reconnectAttempt = 0;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        setStatus('Подключено к серверу. Отправляем запрос в комнату...');
        ws.send(JSON.stringify(pendingAction));
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'hello') return void (state.playerId = data.playerId);
        if (data.type === 'error') return alert(data.message);
        if (data.type === 'move-result') return handleMoveResult(data);
        if (data.type === 'room-state') return applyRoomState(data);
    };

    ws.onclose = () => {
        setStatus('Отключено от сервера');
        scheduleReconnect();
    };
    ws.onerror = () => setStatus('Ошибка подключения');
}

function wsSend(payload) {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify(payload));
}

function reconnect() {
    if (!pendingAction) return setStatus('Нет данных для переподключения.');
    if (reconnectTimer) clearTimeout(reconnectTimer);
    connect(pendingAction.type);
}

function scheduleReconnect() {
    if (!pendingAction || state.status === 'finished') return;
    if (reconnectAttempt >= 5) return;
    reconnectAttempt += 1;
    const delay = Math.min(1000 * (2 ** (reconnectAttempt - 1)), 8000);
    setStatus(`Переподключение через ${Math.round(delay / 1000)}с (попытка ${reconnectAttempt}/5)...`);
    reconnectTimer = setTimeout(() => connect(pendingAction.type), delay);
}

async function detectServerUrl() {
    detectServerUrlBtn.disabled = true;
    try {
        const response = await fetch('http://localhost:3000/network-info');
        const data = await response.json();
        const url = Array.isArray(data.wsUrls) && data.wsUrls.length ? data.wsUrls[0] : '';
        if (!url) return alert('Не удалось определить адрес.');
        serverUrlEl.value = url;
        persistSettingsFromFields();
        setStatus(`Автоподстановка: ${url}`);
    } catch {
        alert('Не удалось получить IP хоста. Запустите сервер (npm start).');
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
    state.turnDeadline = data.turnDeadline;
    state.turnTimeoutMs = data.turnTimeoutMs || 30000;
    state.players = data.players || [];
    state.myShips = data.yourShips || [];
    state.myHitsTaken = data.yourHitsTaken || [];
    state.shotBoards = data.shotBoards || {};
    state.leaderboard = data.leaderboard || [];
    state.chat = data.chat || [];
    state.rematchVotes = data.rematchVotes || [];
    if (state.status !== 'finished') state.hasSavedMatchStats = false;

    syncTargetSelect();

    autoPlaceBtn.disabled = state.status !== 'waiting';
    clearFleetBtn.disabled = state.status !== 'waiting';
    sendFleetBtn.disabled = state.myShips.length !== SHIP_SET.length || state.status !== 'waiting';

    const isHost = state.playerId === state.hostId;
    const everyoneJoined = state.players.length === state.maxPlayers;
    const everyoneReady = state.players.length > 0 && state.players.every((player) => player.ready);
    startGameBtn.disabled = !(isHost && state.status === 'waiting' && everyoneJoined && everyoneReady);
    addBotBtn.disabled = !(isHost && state.status === 'waiting' && state.players.length < state.maxPlayers);

    roomMetaEl.textContent = `Комната: ${state.roomId} | Хост: ${playerName(state.hostId)} | Игроки: ${state.players.length}/${state.maxPlayers}`;

    if (data.infoMessage) setStatus(data.infoMessage);

    renderPlayers();
    renderBoards();
    renderShipDock();
    renderTurnBanner();
    renderLeaderboard();
    renderEvents();
    renderProgress();
    renderTargetStats();
    renderChat();
    renderAchievements();
    finalizeMatchStats();
    updateTimerMeta();
}

function updateTimerMeta() {
    if (timerTick) clearInterval(timerTick);
    const tick = () => {
        if (state.status !== 'playing' || !state.turnDeadline) {
            timerMetaEl.textContent = 'Таймер хода: -';
            return;
        }
        const left = Math.max(0, Math.ceil((state.turnDeadline - Date.now()) / 1000));
        timerMetaEl.textContent = `Таймер хода: ${left}s (${playerName(state.turn)})`;
    };
    tick();
    timerTick = setInterval(tick, 500);
}

function renderPlayers() {
    playersEl.innerHTML = '';
    state.players.forEach((player) => {
        const badge = document.createElement('div');
        badge.className = 'player-badge';
        if (state.status === 'playing' && player.id === state.turn) badge.classList.add('turn');
        badge.innerHTML = `
            <strong>${player.nickname}</strong>
            <span>${short(player.id)}</span>
            <span>${player.id === state.hostId ? '👑 Хост' : player.isBot ? '🤖 Бот' : '👤 Игрок'}</span>
            <span>${player.ready ? '✅ Готов' : '⌛ Расставляет флот'}</span>
            <span>${player.alive ? '🟢 В игре' : '⚫ Выбыл'}</span>
            <span>${player.online === false ? '📴 Отключен' : '🟢 Онлайн'}</span>
        `;
        playersEl.appendChild(badge);
    });
}

function renderTurnBanner() {
    turnBannerEl.className = 'turn-banner';
    if (state.status === 'waiting') return void (turnBannerEl.textContent = 'Подготовка к бою: расставьте флот и ждите запуск от хоста.');

    if (state.status === 'playing') {
        if (state.turn === state.playerId) {
            turnBannerEl.textContent = '🔥 ВАШ ХОД!';
            turnBannerEl.classList.add('my-turn');
            playSound('turn');
            return;
        }
        return void (turnBannerEl.textContent = `⌛ Ход игрока: ${playerName(state.turn)}.`);
    }

    if (state.status === 'finished') {
        turnBannerEl.textContent = state.winner === state.playerId ? '🏆 МАТЧ ОКОНЧЕН: ВЫ ПОБЕДИЛИ!' : `🏁 Победитель: ${playerName(state.winner)}.`;
        turnBannerEl.classList.add('finished');
        unlockAchievement(state.winner === state.playerId ? 'Победитель' : 'До реванша');
        playSound('finish');
    }
}

function renderLeaderboard() {
    leaderboardEl.innerHTML = '';
    if (!state.leaderboard.length) return void (leaderboardEl.textContent = 'Рейтинг появится после старта матча.');
    state.leaderboard.forEach((entry) => {
        const row = document.createElement('div');
        row.className = 'leaderboard-item';
        if (entry.id === state.playerId) row.classList.add('me');
        row.innerHTML = `<strong>#${entry.place}</strong><span>${entry.nickname}</span><span>🎯 ${entry.hits}</span><span>💥 ${entry.kills}</span><span>🚢 ${entry.shipsSunk}</span><span>⭐ ${entry.score}</span>`;
        leaderboardEl.appendChild(row);
    });
}

function renderSessionStats() {
    const shots = state.sessionStats.shots;
    const hits = state.sessionStats.hits;
    const accuracy = shots ? Math.round((hits / shots) * 100) : 0;
    sessionStatsEl.innerHTML = `
        <span>Матчей: <strong>${state.sessionStats.matches}</strong></span>
        <span>Побед: <strong>${state.sessionStats.wins}</strong></span>
        <span>Выстрелов: <strong>${shots}</strong></span>
        <span>Попаданий: <strong>${hits}</strong></span>
        <span>Точность: <strong>${accuracy}%</strong></span>
        <span>Потоплено: <strong>${state.sessionStats.shipsSunk}</strong></span>
    `;
}

function renderEvents() {
    eventsEl.innerHTML = '';
    if (!state.events.length) return void (eventsEl.textContent = 'Лента событий пуста.');
    state.events.slice(-8).reverse().forEach((message) => {
        const eventEl = document.createElement('div');
        eventEl.className = 'event-item';
        eventEl.textContent = message;
        eventsEl.appendChild(eventEl);
    });
}

function renderProgress() {
    const ready = state.players.filter((player) => player.ready).length;
    const total = state.maxPlayers || 1;
    const lobbyPercent = Math.round((ready / total) * 100);
    lobbyProgressEl.textContent = `${ready}/${total} игроков готовы`;
    lobbyProgressBarEl.style.width = `${lobbyPercent}%`;

    const mine = state.leaderboard.find((item) => item.id === state.playerId);
    const shots = (mine?.hits || 0) + (mine?.misses || 0);
    const accuracy = shots ? Math.round((mine.hits / shots) * 100) : 0;
    myProgressEl.textContent = `Попаданий: ${mine?.hits || 0} · Точность: ${accuracy}%`;
    myProgressBarEl.style.width = `${accuracy}%`;

    if (shots >= 10 && accuracy >= 70) unlockAchievement('Снайпер');
}

function renderTargetStats() {
    if (!state.selectedTargetId) return void (targetStatsEl.textContent = 'Нет живых противников.');
    const target = state.players.find((player) => player.id === state.selectedTargetId);
    const board = state.shotBoards[state.selectedTargetId] || { yourShots: [], hitsOnOpponent: [] };
    const shots = board.yourShots.length;
    const hits = board.hitsOnOpponent.length;
    const accuracy = shots ? Math.round((hits / shots) * 100) : 0;
    targetStatsEl.textContent = `По цели ${target ? target.nickname : short(state.selectedTargetId)}: выстрелов ${shots}, попаданий ${hits}, точность ${accuracy}%.`;
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
    if (!aliveOpponents.length) return void (state.selectedTargetId = '');
    if (!aliveOpponents.some((player) => player.id === state.selectedTargetId)) state.selectedTargetId = aliveOpponents[0].id;
    targetSelectEl.value = state.selectedTargetId;
}

function renderChat() {
    chatLogEl.innerHTML = '';
    state.chat.slice(-30).forEach((line) => {
        const row = document.createElement('div');
        row.className = 'chat-item';
        row.innerHTML = `<strong>${line.nickname}:</strong> ${escapeHtml(line.text)}`;
        chatLogEl.appendChild(row);
    });
    chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

function sendChat() {
    const text = chatInputEl.value.trim();
    if (!text) return;
    wsSend({ type: 'chat', text });
    chatInputEl.value = '';
}

function renderShipDock() {
    shipDockEl.innerHTML = '';
    if (!state.settings.manualMode || state.status !== 'waiting') {
        shipDockEl.textContent = 'Ручная расстановка отключена. Используйте авторасстановку или включите ручной режим.';
        return;
    }

    const placed = state.myShips.map((ship) => ship.cells.length);
    SHIP_SET.forEach((size, index) => {
        const usedIdx = placed.indexOf(size);
        if (usedIdx !== -1) placed[usedIdx] = -1;
        const token = document.createElement('button');
        token.className = 'dock-ship';
        token.draggable = usedIdx === -1;
        token.textContent = `${size}⚓`;
        if (usedIdx !== -1) token.classList.add('placed');
        if (state.selectedDockShipIndex === index) token.classList.add('selected');
        token.onclick = () => { state.selectedDockShipIndex = index; renderShipDock(); };
        token.ondragstart = (event) => {
            state.selectedDockShipIndex = index;
            event.dataTransfer?.setData('text/plain', String(index));
        };
        shipDockEl.appendChild(token);
    });
}

function setStatus(text) {
    statusEl.textContent = `Статус: ${text}`;
}

function handleMoveResult(data) {
    const attacker = playerName(data.from);
    const defender = playerName(data.to);
    const coord = `${data.target?.x + 1}:${data.target?.y + 1}`;
    let message = `${formatTime(new Date())} 🎯 ${attacker} → ${defender} (${coord}): ${data.hit ? 'попадание' : 'мимо'}.`;
    if (data.shipSunk) message += ` Корабль ${defender} уничтожен!`;
    if (data.defenderDefeated) message += ` Игрок ${defender} выбыл.`;
    if (data.winner) message += ` Победитель: ${playerName(data.winner)}.`;
    pushEvent(message);

    if (data.from === state.playerId && data.hit) unlockAchievement('Первое попадание');
    if (data.from === state.playerId && data.shipSunk) unlockAchievement('Кораблекрушитель');
    if (data.to === state.playerId && !data.hit) unlockAchievement('Маневрист');

    playSound(data.hit ? 'hit' : 'miss');
}

function pushEvent(message) {
    state.events.push(message);
    if (state.events.length > 40) state.events = state.events.slice(-40);
    renderEvents();
}

function unlockAchievement(name) {
    if (state.achievementSet.has(name)) return;
    state.achievementSet.add(name);
    state.achievements.push({ name, at: Date.now() });
    renderAchievements();
    pushEvent(`${formatTime(new Date())} 🏅 Достижение: ${name}`);
}

function renderAchievements() {
    achievementsEl.innerHTML = '';
    if (!state.achievements.length) return void (achievementsEl.textContent = 'Пока нет достижений.');
    state.achievements.slice(-6).reverse().forEach((item) => {
        const badge = document.createElement('span');
        badge.className = 'achievement';
        badge.textContent = `🏅 ${item.name}`;
        achievementsEl.appendChild(badge);
    });
}

function playerName(id) {
    return state.players.find((candidate) => candidate.id === id)?.nickname || short(id);
}

function autoPlace() {
    state.myShips = generateFleet();
    pushEvent(`${formatTime(new Date())} ⚙️ Ваш флот автоматически расставлен.`);
    renderBoards();
    renderShipDock();
}

function clearFleet() {
    state.myShips = [];
    state.selectedDockShipIndex = null;
    renderBoards();
    renderShipDock();
    setStatus('Флот очищен. Можно расставить заново.');
}

function sendFleet() {
    if (!ws || ws.readyState !== 1) return alert('Сначала подключитесь к серверу');
    ws.send(JSON.stringify({ type: 'place-ships', ships: state.myShips }));
}

function startGame() {
    if (!ws || ws.readyState !== 1) return alert('Нет подключения к серверу');
    ws.send(JSON.stringify({ type: 'start-game' }));
}

function renderBoards() {
    myBoardEl.innerHTML = '';
    enemyBoardEl.innerHTML = '';

    const myShipKeys = new Set(state.myShips.flatMap((ship) => ship.cells.map((cell) => key(cell.x, cell.y))));
    const myHitKeys = new Set(state.myHitsTaken.map((cell) => key(cell.x, cell.y)));

    const selectedBoard = state.shotBoards[state.selectedTargetId] || { yourShots: [], hitsOnOpponent: [] };
    const yourShotKeys = new Set((selectedBoard.yourShots || []).map((cell) => key(cell.x, cell.y)));
    const hitOnOpponentKeys = new Set((selectedBoard.hitsOnOpponent || []).map((cell) => key(cell.x, cell.y)));

    for (let y = 0; y < BOARD_SIZE; y += 1) {
        for (let x = 0; x < BOARD_SIZE; x += 1) {
            const coordinate = key(x, y);
            const myCell = document.createElement('button');
            myCell.className = 'cell';
            myCell.dataset.label = `${x + 1}:${y + 1}`;
            if (myShipKeys.has(coordinate)) myCell.classList.add('ship');
            if (myHitKeys.has(coordinate)) myCell.classList.add('hit');
            if (myHitKeys.has(coordinate) && !myShipKeys.has(coordinate)) myCell.classList.add('miss');
            if (state.status === 'waiting' && state.settings.manualMode) {
                myCell.onclick = () => tryPlaceManualShip(x, y);
                myCell.ondragover = (e) => e.preventDefault();
                myCell.ondrop = (e) => {
                    e.preventDefault();
                    const idx = Number(e.dataTransfer?.getData('text/plain'));
                    state.selectedDockShipIndex = Number.isInteger(idx) ? idx : state.selectedDockShipIndex;
                    tryPlaceManualShip(x, y);
                };
            } else {
                myCell.disabled = true;
            }
            myBoardEl.appendChild(myCell);

            const enemyCell = document.createElement('button');
            enemyCell.className = 'cell enemy';
            enemyCell.dataset.label = `${x + 1}:${y + 1}`;
            if (yourShotKeys.has(coordinate) && hitOnOpponentKeys.has(coordinate)) enemyCell.classList.add('hit');
            else if (yourShotKeys.has(coordinate)) enemyCell.classList.add('miss');
            else if (isHintCell(x, y)) enemyCell.classList.add('hint');
            enemyCell.onclick = () => attack(state.selectedTargetId, x, y, yourShotKeys.has(coordinate), enemyCell);
            enemyBoardEl.appendChild(enemyCell);
        }
    }
}

function tryPlaceManualShip(x, y) {
    if (state.selectedDockShipIndex === null) return;
    const used = state.myShips.map((ship) => ship.cells.length);
    const size = SHIP_SET[state.selectedDockShipIndex];
    const alreadyPlacedCount = used.filter((value) => value === size).length;
    const allowedCount = SHIP_SET.filter((value) => value === size).length;
    if (alreadyPlacedCount >= allowedCount) return;

    const cells = [];
    for (let i = 0; i < size; i += 1) {
        const cx = x + (state.manualOrientation === 'horizontal' ? i : 0);
        const cy = y + (state.manualOrientation === 'vertical' ? i : 0);
        cells.push({ x: cx, y: cy });
    }

    const occupied = new Set(state.myShips.flatMap((ship) => ship.cells.map((c) => key(c.x, c.y))));
    for (const cell of cells) {
        if (cell.x < 0 || cell.y < 0 || cell.x >= BOARD_SIZE || cell.y >= BOARD_SIZE) return;
        for (let dy = -1; dy <= 1; dy += 1) {
            for (let dx = -1; dx <= 1; dx += 1) {
                if (occupied.has(key(cell.x + dx, cell.y + dy))) return;
            }
        }
    }

    state.myShips.push({ cells });
    state.selectedDockShipIndex = null;
    renderBoards();
    renderShipDock();
    if (state.myShips.length === SHIP_SET.length) unlockAchievement('Адмирал логистики');
}

function attack(targetId, x, y, alreadyShot, cellEl) {
    if (!targetId || !ws || ws.readyState !== 1 || state.status !== 'playing' || state.turn !== state.playerId || alreadyShot) return;
    cellEl.classList.add('shot-anim');
    ws.send(JSON.stringify({ type: 'move', targetId, x, y }));
}

function isHintCell(x, y) {
    if (state.status !== 'playing') return false;
    const selectedBoard = state.shotBoards[state.selectedTargetId] || { yourShots: [], hitsOnOpponent: [] };
    const hits = new Set((selectedBoard.hitsOnOpponent || []).map((cell) => key(cell.x, cell.y)));
    const shots = new Set((selectedBoard.yourShots || []).map((cell) => key(cell.x, cell.y)));
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nearby = key(x + dx, y + dy);
        if (hits.has(nearby) && !shots.has(key(x, y))) return true;
    }
    return (x + y) % 2 === 0;
}

function key(x, y) { return `${x}:${y}`; }
function short(id) { return id ? id.slice(0, 4) : '-'; }

function generateFleet() {
    const board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(0));
    const ships = [];
    for (const size of SHIP_SET) {
        let placed = false;
        for (let attempts = 0; !placed && attempts < 2000; attempts += 1) {
            const horizontal = Math.random() < 0.5;
            const startX = Math.floor(Math.random() * BOARD_SIZE);
            const startY = Math.floor(Math.random() * BOARD_SIZE);
            const cells = [];
            for (let i = 0; i < size; i += 1) {
                const x = startX + (horizontal ? i : 0);
                const y = startY + (horizontal ? 0 : i);
                if (x >= BOARD_SIZE || y >= BOARD_SIZE) { cells.length = 0; break; }
                cells.push({ x, y });
            }
            if (!cells.length || !canPlaceShip(board, cells)) continue;
            cells.forEach((cell) => { board[cell.y][cell.x] = 1; });
            ships.push({ cells });
            placed = true;
        }
        if (!placed) return generateFleet();
    }
    return ships;
}

function canPlaceShip(board, cells) {
    return cells.every((cell) => {
        for (let dy = -1; dy <= 1; dy += 1) {
            for (let dx = -1; dx <= 1; dx += 1) {
                const nx = cell.x + dx;
                const ny = cell.y + dy;
                if (nx < 0 || ny < 0 || nx >= BOARD_SIZE || ny >= BOARD_SIZE) continue;
                if (board[ny][nx] === 1) return false;
            }
        }
        return true;
    });
}

function loadSettings() {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (raw) state.settings = { ...state.settings, ...JSON.parse(raw) };
    } catch {
        // ignore
    }
    state.clientId = localStorage.getItem('battleshipClientId') || `client-${Math.random().toString(36).slice(2, 12)}`;
    localStorage.setItem('battleshipClientId', state.clientId);
    try {
        const statsRaw = localStorage.getItem(STATS_KEY);
        if (statsRaw) state.sessionStats = { ...state.sessionStats, ...JSON.parse(statsRaw) };
    } catch {
        // ignore
    }

    serverUrlEl.value = state.settings.serverUrl;
    nicknameEl.value = state.settings.nickname;
    roomEl.value = state.settings.room;
    maxPlayersEl.value = state.settings.maxPlayers;
    soundToggleEl.checked = Boolean(state.settings.soundEnabled);
    manualModeEl.checked = Boolean(state.settings.manualMode);
}

function persistSettingsFromFields() {
    state.settings.serverUrl = serverUrlEl.value.trim();
    state.settings.nickname = nicknameEl.value.trim();
    state.settings.room = roomEl.value.trim();
    state.settings.maxPlayers = maxPlayersEl.value;
    persistSettings();
}

function persistSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
}

function persistSessionStats() {
    localStorage.setItem(STATS_KEY, JSON.stringify(state.sessionStats));
}

function generateRoomCode() {
    const code = `room-${Math.random().toString(36).slice(2, 6)}-${Math.random().toString(36).slice(2, 5)}`;
    roomEl.value = code;
    persistSettingsFromFields();
    setStatus(`Новый код комнаты: ${code}`);
}

async function copyInvite() {
    const room = roomEl.value.trim();
    const serverUrl = serverUrlEl.value.trim();
    if (!room || !serverUrl) return alert('Заполните адрес сервера и код комнаты');
    const invite = `Battleship Arena\nСервер: ${serverUrl}\nКомната: ${room}`;
    try {
        await navigator.clipboard.writeText(invite);
        setStatus('Инвайт скопирован в буфер обмена.');
    } catch {
        setStatus('Не удалось скопировать инвайт.');
    }
}

function finalizeMatchStats() {
    if (state.status !== 'finished' || state.hasSavedMatchStats) return;
    const me = state.leaderboard.find((entry) => entry.id === state.playerId);
    if (!me) return;
    state.hasSavedMatchStats = true;
    state.sessionStats.matches += 1;
    if (state.winner === state.playerId) state.sessionStats.wins += 1;
    state.sessionStats.shots += (me.hits || 0) + (me.misses || 0);
    state.sessionStats.hits += me.hits || 0;
    state.sessionStats.shipsSunk += me.shipsSunk || 0;
    persistSessionStats();
    renderSessionStats();
}

function formatTime(date) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function playSound(type) {
    if (!state.settings.soundEnabled) return;
    const context = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'triangle';
    oscillator.frequency.value = ({ hit: 620, miss: 260, turn: 720, finish: 420 }[type] || 420);
    gain.gain.value = 0.05;
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.12);
}

function escapeHtml(text) {
    return text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}