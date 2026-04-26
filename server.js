const http = require('http');
const os = require('os');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const BOARD_SIZE = 10;
const DEFAULT_SHIPS = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
const MAX_PLAYERS = 4;
const TURN_TIMEOUT_MS = 30000;

const rooms = new Map();

const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
    }

    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    if (req.url === '/network-info') {
        const ips = getLanIPv4Addresses();
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({
            ok: true,
            port: PORT,
            ips,
            wsUrls: ips.map((ip) => `ws://${ip}:${PORT}`),
        }));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Battleship WebSocket server is running');
});

const wss = new WebSocket.Server({ server });

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Battleship server started on http://0.0.0.0:${PORT}`);
});

setInterval(() => {
    rooms.forEach((room) => {
        if (room.status !== 'playing') return;
        if (!room.turnDeadline || Date.now() < room.turnDeadline) return;

        const attacker = room.players.find((player) => player.id === room.turn);
        if (!attacker || !attacker.alive) {
            moveTurnToNextAlive(room, room.turn);
            startTurnTimer(room);
            broadcastRoomState(room, 'Ход был пропущен из-за таймаута.');
            return;
        }

        if (attacker.isBot) {
            performBotMove(room, attacker, true);
            return;
        }

        room.moveNumber += 1;
        moveTurnToNextAlive(room, attacker.id);
        startTurnTimer(room);
        broadcastRoomState(room, `⏱️ ${attacker.nickname} не успел походить. Ход передан дальше.`);
    });
}, 1000);

wss.on('connection', (ws) => {
    const playerId = Math.random().toString(36).slice(2, 10);
    let roomId = null;

    safeSend(ws, { type: 'hello', playerId });

    ws.on('message', (raw) => {
        let data;
        try {
            data = JSON.parse(raw.toString());
        } catch {
            safeSend(ws, { type: 'error', message: 'Некорректный JSON' });
            return;
        }

        if (data.type === 'create-room') {
            roomId = handleCreateRoom(ws, playerId, data);
            return;
        }

        if (data.type === 'join-room') {
            roomId = handleJoinRoom(ws, playerId, data);
            return;
        }

        if (!roomId) {
            safeSend(ws, { type: 'error', message: 'Сначала создайте комнату или подключитесь к ней' });
            return;
        }

        const room = rooms.get(roomId);
        if (!room) {
            safeSend(ws, { type: 'error', message: 'Комната не найдена' });
            return;
        }

        if (data.type === 'place-ships') {
            handlePlaceShips(room, playerId, data.ships);
            return;
        }

        if (data.type === 'start-game') {
            handleStartGame(room, playerId);
            return;
        }

        if (data.type === 'move') {
            handleMove(room, playerId, data.targetId, data.x, data.y);
            return;
        }

        if (data.type === 'chat') {
            handleChat(room, playerId, data.text);
            return;
        }

        if (data.type === 'add-bot') {
            handleAddBot(room, playerId);
            return;
        }

        if (data.type === 'request-rematch') {
            handleRematch(room, playerId);
        }
    });

    ws.on('close', () => {
        if (!roomId) return;

        const room = rooms.get(roomId);
        if (!room) return;

        const disconnected = room.players.find((player) => player.id === playerId);
        room.players = room.players.filter((player) => !(player.id === playerId && !player.isBot));

        if (!room.players.length) {
            rooms.delete(roomId);
            return;
        }

        if (room.hostId === playerId) {
            room.hostId = room.players[0]?.id || null;
        }

        if (room.status === 'playing' && disconnected) {
            disconnected.alive = false;
            settleWinnerIfNeeded(room);
            moveTurnToNextAlive(room, room.turn);
            startTurnTimer(room);
        }

        addSystemChat(room, `Игрок ${disconnected?.nickname || playerId.slice(0, 4)} отключился.`);
        broadcastRoomState(room, `Игрок ${playerId.slice(0, 4)} отключился.`);
    });
});

function handleCreateRoom(ws, playerId, data) {
    const roomName = String(data.room || '').trim();
    const nickname = normalizeNickname(data.nickname, playerId);
    const maxPlayers = Number(data.maxPlayers);

    if (!roomName) {
        safeSend(ws, { type: 'error', message: 'Введите код комнаты' });
        return null;
    }

    if (rooms.has(roomName)) {
        safeSend(ws, { type: 'error', message: 'Комната уже существует' });
        return null;
    }

    if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > MAX_PLAYERS) {
        safeSend(ws, { type: 'error', message: 'Лимит игроков: от 2 до 4' });
        return null;
    }

    const room = {
        id: roomName,
        status: 'waiting',
        turn: null,
        winner: null,
        moveNumber: 0,
        maxPlayers,
        hostId: playerId,
        rematchVotes: new Set(),
        turnDeadline: null,
        players: [createPlayer(playerId, nickname, ws)],
        chat: [],
    };

    rooms.set(roomName, room);
    addSystemChat(room, 'Комната создана. Ожидаем игроков.');
    broadcastRoomState(room, 'Комната создана. Ожидаем игроков.');
    return roomName;
}

function handleJoinRoom(ws, playerId, data) {
    const roomName = String(data.room || '').trim();
    const nickname = normalizeNickname(data.nickname, playerId);

    if (!roomName) {
        safeSend(ws, { type: 'error', message: 'Введите код комнаты' });
        return null;
    }

    const room = rooms.get(roomName);
    if (!room) {
        safeSend(ws, { type: 'error', message: 'Комната не найдена' });
        return null;
    }

    if (room.status !== 'waiting') {
        safeSend(ws, { type: 'error', message: 'Игра уже началась, подключение закрыто' });
        return null;
    }

    if (room.players.length >= room.maxPlayers) {
        safeSend(ws, { type: 'error', message: `Комната заполнена (${room.maxPlayers}/${room.maxPlayers})` });
        return null;
    }

    room.players.push(createPlayer(playerId, nickname, ws));
    addSystemChat(room, `${nickname} подключился к комнате.`);
    broadcastRoomState(room, `${nickname} подключился к комнате.`);
    return roomName;
}

function createPlayer(id, nickname, ws, isBot = false) {
    return {
        id,
        nickname,
        ws,
        isBot,
        ready: false,
        alive: true,
        ships: [],
        hitsTaken: new Set(),
        shotsByTarget: new Map(),
        eliminatedAtMove: null,
        stats: {
            hits: 0,
            misses: 0,
            shipsSunk: 0,
            kills: 0,
        },
    };
}

function handlePlaceShips(room, playerId, ships) {
    if (room.status !== 'waiting') {
        safeSendToPlayer(room, playerId, { type: 'error', message: 'Расстановка доступна только до старта игры' });
        return;
    }

    const player = room.players.find((p) => p.id === playerId);
    if (!player) return;

    const validation = validateShips(ships);
    if (!validation.ok) {
        safeSend(player.ws, { type: 'error', message: validation.message });
        return;
    }

    player.ships = ships;
    player.ready = true;

    broadcastRoomState(room, `${player.nickname} подтвердил расстановку.`);
}

function handleStartGame(room, playerId) {
    if (room.hostId !== playerId) {
        safeSendToPlayer(room, playerId, { type: 'error', message: 'Только создатель может запустить игру' });
        return;
    }

    if (room.status !== 'waiting') {
        safeSendToPlayer(room, playerId, { type: 'error', message: 'Игра уже запущена' });
        return;
    }

    if (room.players.length !== room.maxPlayers) {
        safeSendToPlayer(room, playerId, { type: 'error', message: 'Не все игроки подключились' });
        return;
    }

    const allReady = room.players.every((player) => player.ready);
    if (!allReady) {
        safeSendToPlayer(room, playerId, { type: 'error', message: 'Не все игроки подтвердили флот' });
        return;
    }

    room.status = 'playing';
    room.winner = null;
    room.rematchVotes.clear();
    room.players.forEach((player) => {
        player.alive = true;
        player.hitsTaken = new Set();
        player.shotsByTarget = new Map();
        player.eliminatedAtMove = null;
        player.stats = { hits: 0, misses: 0, shipsSunk: 0, kills: 0 };
    });
    room.moveNumber = 0;
    room.turn = room.players[0].id;
    startTurnTimer(room);

    addSystemChat(room, 'Игра запущена создателем комнаты.');
    broadcastRoomState(room, 'Игра запущена создателем комнаты.');
    triggerBotTurnIfNeeded(room);
}

function handleMove(room, playerId, targetId, x, y) {
    if (room.status !== 'playing') {
        safeSendToPlayer(room, playerId, { type: 'error', message: 'Игра не запущена' });
        return;
    }
    if (room.turn !== playerId) {
        safeSendToPlayer(room, playerId, { type: 'error', message: 'Сейчас ход другого игрока' });
        return;
    }
    executeMove(room, playerId, targetId, x, y);
}

function executeMove(room, playerId, targetId, x, y) {

    if (!isInsideBoard(x, y)) {
        safeSendToPlayer(room, playerId, { type: 'error', message: 'Координаты вне поля' });
        return false;
    }

    const attacker = room.players.find((player) => player.id === playerId);
    const defender = room.players.find((player) => player.id === targetId);

    if (!attacker || !defender) return false;

    if (!defender.alive) {
        safeSendToPlayer(room, playerId, { type: 'error', message: 'Этот игрок уже выбыл' });
        return false;
    }

    if (attacker.id === defender.id) {
        safeSendToPlayer(room, playerId, { type: 'error', message: 'Нельзя стрелять в себя' });
        return false;
    }

    const targetShots = attacker.shotsByTarget.get(defender.id) || new Set();
    const shotKey = pointKey(x, y);

    if (targetShots.has(shotKey)) {
        safeSendToPlayer(room, playerId, { type: 'error', message: 'Вы уже стреляли в эту клетку выбранного поля' });
        return false;
    }

    targetShots.add(shotKey);
    attacker.shotsByTarget.set(defender.id, targetShots);
    room.moveNumber += 1;

    const hit = isShipAt(defender.ships, x, y);
    if (hit) {
        defender.hitsTaken.add(shotKey);
        attacker.stats.hits += 1;
    } else {
        attacker.stats.misses += 1;
    }

    const sunkShip = hit ? getShipSunkByShot(defender, x, y) : null;
    const shipSunk = Boolean(sunkShip);
    if (shipSunk) attacker.stats.shipsSunk += 1;

    let defenderDefeated = false;
    if (defender.alive && areAllShipsSunk(defender)) {
        defender.alive = false;
        defender.eliminatedAtMove = room.moveNumber;
        defenderDefeated = true;
        attacker.stats.kills += 1;
    }

    settleWinnerIfNeeded(room);

    if (room.status === 'playing') {
        moveTurnToNextAlive(room, attacker.id);
        startTurnTimer(room);
    } else {
        room.turnDeadline = null;
    }

    broadcast(room, {
        type: 'move-result',
        roomId: room.id,
        from: attacker.id,
        to: defender.id,
        target: { x, y },
        hit,
        shipSunk,
        defenderDefeated,
        winner: room.winner,
    });

    broadcastRoomState(room);
    triggerBotTurnIfNeeded(room);
    return true;
}

function handleChat(room, playerId, text) {
    const player = room.players.find((p) => p.id === playerId);
    if (!player) return;

    const clean = String(text || '').trim().slice(0, 240);
    if (!clean) return;

    room.chat.push({
        id: Math.random().toString(36).slice(2, 9),
        from: player.id,
        nickname: player.nickname,
        text: clean,
        ts: Date.now(),
    });
    room.chat = room.chat.slice(-40);
    broadcastRoomState(room);
}

function handleAddBot(room, playerId) {
    if (room.hostId !== playerId) {
        safeSendToPlayer(room, playerId, { type: 'error', message: 'Только хост может добавлять ботов' });
        return;
    }

    if (room.status !== 'waiting') {
        safeSendToPlayer(room, playerId, { type: 'error', message: 'Ботов можно добавлять только до старта матча' });
        return;
    }

    if (room.players.length >= room.maxPlayers) {
        safeSendToPlayer(room, playerId, { type: 'error', message: 'Комната уже заполнена' });
        return;
    }

    const botId = `bot-${Math.random().toString(36).slice(2, 8)}`;
    const botIndex = room.players.filter((p) => p.isBot).length + 1;
    const bot = createPlayer(botId, `Bot-${botIndex}`, null, true);
    bot.ships = generateFleet();
    bot.ready = true;
    room.players.push(bot);

    addSystemChat(room, `${bot.nickname} присоединился к матчу.`);
    broadcastRoomState(room, `${bot.nickname} добавлен в комнату.`);
}

function handleRematch(room, playerId) {
    if (room.status !== 'finished') {
        safeSendToPlayer(room, playerId, { type: 'error', message: 'Рематч доступен только после завершения игры' });
        return;
    }

    room.rematchVotes.add(playerId);
    const humans = room.players.filter((player) => !player.isBot);
    const allHumansReady = humans.every((player) => room.rematchVotes.has(player.id));

    if (!allHumansReady) {
        broadcastRoomState(room, `Игрок ${playerId.slice(0, 4)} проголосовал за рематч (${room.rematchVotes.size}/${humans.length}).`);
        return;
    }

    room.status = 'waiting';
    room.turn = null;
    room.winner = null;
    room.moveNumber = 0;
    room.turnDeadline = null;
    room.rematchVotes.clear();

    room.players.forEach((player) => {
        player.ready = player.isBot;
        player.alive = true;
        player.hitsTaken = new Set();
        player.shotsByTarget = new Map();
        player.eliminatedAtMove = null;
        player.stats = { hits: 0, misses: 0, shipsSunk: 0, kills: 0 };
        if (player.isBot) {
            player.ships = generateFleet();
        } else {
            player.ships = [];
        }
    });

    addSystemChat(room, 'Все согласились на рематч. Подготовьте флот и запускайте новый бой!');
    broadcastRoomState(room, 'Рематч запущен: снова этап расстановки.');
}

function addSystemChat(room, text) {
    room.chat.push({
        id: Math.random().toString(36).slice(2, 9),
        from: 'system',
        nickname: 'Система',
        text,
        ts: Date.now(),
    });
    room.chat = room.chat.slice(-40);
}

function settleWinnerIfNeeded(room) {
    const alivePlayers = room.players.filter((player) => player.alive);
    if (alivePlayers.length === 1 && room.status === 'playing') {
        room.status = 'finished';
        room.winner = alivePlayers[0].id;
        room.turn = null;
    }
}

function moveTurnToNextAlive(room, currentPlayerId) {
    const alivePlayers = room.players.filter((player) => player.alive);
    if (alivePlayers.length <= 1) {
        room.turn = null;
        return;
    }

    const currentIndex = alivePlayers.findIndex((player) => player.id === currentPlayerId);
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % alivePlayers.length;
    room.turn = alivePlayers[nextIndex].id;
}

function startTurnTimer(room) {
    if (room.status !== 'playing' || !room.turn) {
        room.turnDeadline = null;
        return;
    }

    room.turnDeadline = Date.now() + TURN_TIMEOUT_MS;
}

function triggerBotTurnIfNeeded(room) {
    if (room.status !== 'playing' || !room.turn) return;
    const active = room.players.find((player) => player.id === room.turn);
    if (!active || !active.isBot) return;

    setTimeout(() => {
        performBotMove(room, active);
    }, 650 + Math.floor(Math.random() * 550));
}

function performBotMove(room, bot, byTimeout = false) {
    if (room.status !== 'playing' || room.turn !== bot.id || !bot.alive) return;

    const targets = room.players.filter((player) => player.id !== bot.id && player.alive);
    if (!targets.length) return;

    const target = targets[Math.floor(Math.random() * targets.length)];
    const shots = bot.shotsByTarget.get(target.id) || new Set();

    const options = [];
    for (let y = 0; y < BOARD_SIZE; y += 1) {
        for (let x = 0; x < BOARD_SIZE; x += 1) {
            const candidate = pointKey(x, y);
            if (!shots.has(candidate)) {
                options.push({ x, y });
            }
        }
    }

    if (!options.length) {
        moveTurnToNextAlive(room, bot.id);
        startTurnTimer(room);
        broadcastRoomState(room, `${bot.nickname} пропустил ход (нет доступных клеток).`);
        return;
    }

    const choice = options[Math.floor(Math.random() * options.length)];
    if (byTimeout) {
        addSystemChat(room, `⏱️ ${bot.nickname} ходит по таймеру.`);
    }
    executeMove(room, bot.id, target.id, choice.x, choice.y);
}

function broadcastRoomState(room, infoMessage = null) {
    const leaderboard = buildLeaderboard(room);

    room.players.forEach((viewer) => {
        if (viewer.isBot) return;

        const opponents = room.players.filter((player) => player.id !== viewer.id);
        const shotBoards = {};

        opponents.forEach((opponent) => {
            const yourShots = Array.from(viewer.shotsByTarget.get(opponent.id) || []).map(keyToPoint);
            const hitsOnOpponent = yourShots.filter((point) => opponent.hitsTaken.has(pointKey(point.x, point.y)));
            const shotsFromOpponent = Array.from(opponent.shotsByTarget.get(viewer.id) || []).map(keyToPoint);

            shotBoards[opponent.id] = {
                yourShots,
                hitsOnOpponent,
                shotsFromOpponent,
            };
        });

        safeSend(viewer.ws, {
            type: 'room-state',
            roomId: room.id,
            status: room.status,
            turn: room.turn,
            winner: room.winner,
            infoMessage,
            hostId: room.hostId,
            maxPlayers: room.maxPlayers,
            moveNumber: room.moveNumber,
            turnDeadline: room.turnDeadline,
            you: viewer.id,
            players: room.players.map((player) => ({
                id: player.id,
                nickname: player.nickname,
                ready: player.ready,
                alive: player.alive,
                isBot: player.isBot,
            })),
            yourShips: viewer.ships,
            yourHitsTaken: Array.from(viewer.hitsTaken).map(keyToPoint),
            shotBoards,
            leaderboard,
            chat: room.chat,
            rematchVotes: Array.from(room.rematchVotes),
            turnTimeoutMs: TURN_TIMEOUT_MS,
        });
    });
}

function broadcast(room, payload) {
    room.players.forEach((player) => safeSend(player.ws, payload));
}

function safeSendToPlayer(room, playerId, payload) {
    const player = room.players.find((candidate) => candidate.id === playerId);
    if (player && !player.isBot) safeSend(player.ws, payload);
}

function safeSend(ws, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    }
}

function normalizeNickname(nickname, fallbackId) {
    const cleaned = String(nickname || '').trim();
    if (!cleaned) return `Player-${fallbackId.slice(0, 4)}`;
    return cleaned.slice(0, 18);
}

function validateShips(ships) {
    if (!Array.isArray(ships) || ships.length !== DEFAULT_SHIPS.length) {
        return { ok: false, message: 'Неверное количество кораблей' };
    }

    const sizes = ships.map((ship) => (Array.isArray(ship.cells) ? ship.cells.length : 0)).sort((a, b) => b - a);
    const expected = [...DEFAULT_SHIPS].sort((a, b) => b - a);
    if (JSON.stringify(sizes) !== JSON.stringify(expected)) {
        return { ok: false, message: 'Неверная конфигурация флота' };
    }

    const occupied = new Set();

    for (const ship of ships) {
        if (!Array.isArray(ship.cells) || ship.cells.length === 0) {
            return { ok: false, message: 'Корабль без клеток' };
        }

        const xs = ship.cells.map((cell) => cell.x);
        const ys = ship.cells.map((cell) => cell.y);
        const sameX = xs.every((x) => x === xs[0]);
        const sameY = ys.every((y) => y === ys[0]);

        if (!sameX && !sameY) {
            return { ok: false, message: 'Корабли должны быть прямыми' };
        }

        const sorted = [...ship.cells].sort((a, b) => (sameX ? a.y - b.y : a.x - b.x));

        for (let i = 0; i < sorted.length; i += 1) {
            const cell = sorted[i];
            if (!isInsideBoard(cell.x, cell.y)) {
                return { ok: false, message: 'Корабль выходит за границы поля' };
            }

            if (i > 0) {
                const prev = sorted[i - 1];
                const distance = Math.abs(prev.x - cell.x) + Math.abs(prev.y - cell.y);
                if (distance !== 1) {
                    return { ok: false, message: 'Клетки корабля должны идти подряд' };
                }
            }

            const key = pointKey(cell.x, cell.y);
            if (occupied.has(key)) {
                return { ok: false, message: 'Корабли пересекаются' };
            }
            occupied.add(key);
        }
    }

    const neighbors = [
        [-1, -1], [0, -1], [1, -1],
        [-1, 0], [1, 0],
        [-1, 1], [0, 1], [1, 1],
    ];

    for (const key of occupied) {
        const { x, y } = keyToPoint(key);
        for (const [dx, dy] of neighbors) {
            const nKey = pointKey(x + dx, y + dy);
            if (!occupied.has(nKey)) continue;

            const shipA = shipIndexByCell(ships, x, y);
            const shipB = shipIndexByCell(ships, x + dx, y + dy);
            if (shipA !== shipB) {
                return { ok: false, message: 'Корабли не должны соприкасаться' };
            }
        }
    }

    return { ok: true };
}

function shipIndexByCell(ships, x, y) {
    return ships.findIndex((ship) => ship.cells.some((cell) => cell.x === x && cell.y === y));
}

function areAllShipsSunk(player) {
    return player.ships.every((ship) => ship.cells.every((cell) => player.hitsTaken.has(pointKey(cell.x, cell.y))));
}

function getShipSunkByShot(player, x, y) {
    const ship = player.ships.find((candidate) => candidate.cells.some((cell) => cell.x === x && cell.y === y));
    if (!ship) return null;
    const isSunk = ship.cells.every((cell) => player.hitsTaken.has(pointKey(cell.x, cell.y)));
    return isSunk ? ship : null;
}

function buildLeaderboard(room) {
    const scoreByPlayer = (player) => (
        (player.stats.kills * 120)
        + (player.stats.shipsSunk * 40)
        + (player.stats.hits * 8)
        - (player.stats.misses * 2)
        + (player.alive ? 30 : 0)
    );

    const sorted = [...room.players].sort((a, b) => {
        if (a.alive !== b.alive) return Number(b.alive) - Number(a.alive);

        if (!a.alive && !b.alive) {
            const aMove = a.eliminatedAtMove ?? -1;
            const bMove = b.eliminatedAtMove ?? -1;
            if (aMove !== bMove) return bMove - aMove;
        }

        const diffScore = scoreByPlayer(b) - scoreByPlayer(a);
        if (diffScore !== 0) return diffScore;

        if (b.stats.kills !== a.stats.kills) return b.stats.kills - a.stats.kills;
        if (b.stats.hits !== a.stats.hits) return b.stats.hits - a.stats.hits;
        return a.stats.misses - b.stats.misses;
    });

    return sorted.map((player, index) => ({
        id: player.id,
        nickname: player.nickname,
        place: index + 1,
        alive: player.alive,
        hits: player.stats.hits,
        misses: player.stats.misses,
        kills: player.stats.kills,
        shipsSunk: player.stats.shipsSunk,
        score: scoreByPlayer(player),
    }));
}

function isInsideBoard(x, y) {
    return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < BOARD_SIZE && y < BOARD_SIZE;
}

function isShipAt(ships, x, y) {
    return ships.some((ship) => ship.cells.some((cell) => cell.x === x && cell.y === y));
}

function pointKey(x, y) {
    return `${x}:${y}`;
}

function keyToPoint(key) {
    const [x, y] = key.split(':').map(Number);
    return { x, y };
}

function generateFleet() {
    const board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(0));
    const ships = [];

    for (const size of DEFAULT_SHIPS) {
        let placed = false;
        let attempts = 0;

        while (!placed && attempts < 2000) {
            attempts += 1;
            const horizontal = Math.random() < 0.5;
            const startX = Math.floor(Math.random() * BOARD_SIZE);
            const startY = Math.floor(Math.random() * BOARD_SIZE);

            const cells = [];
            for (let i = 0; i < size; i += 1) {
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

        if (!placed) return generateFleet();
    }

    return ships;
}

function canPlaceShip(board, cells) {
    for (const cell of cells) {
        for (let dy = -1; dy <= 1; dy += 1) {
            for (let dx = -1; dx <= 1; dx += 1) {
                const nx = cell.x + dx;
                const ny = cell.y + dy;
                if (nx < 0 || ny < 0 || nx >= BOARD_SIZE || ny >= BOARD_SIZE) continue;
                if (board[ny][nx] === 1) return false;
            }
        }
    }
    return true;
}

function getLanIPv4Addresses() {
    const interfaces = os.networkInterfaces();
    const ips = [];

    Object.values(interfaces).forEach((entries) => {
        if (!Array.isArray(entries)) return;
        entries.forEach((entry) => {
            if (entry && entry.family === 'IPv4' && !entry.internal) {
                ips.push(entry.address);
            }
        });
    });

    return Array.from(new Set(ips));
}