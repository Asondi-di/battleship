const http = require('http');
const os = require('os');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const BOARD_SIZE = 10;
const DEFAULT_SHIPS = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
const MAX_PLAYERS = 4;

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
        }
    });

    ws.on('close', () => {
        if (!roomId) return;

        const room = rooms.get(roomId);
        if (!room) return;

        room.players = room.players.filter((player) => player.id !== playerId);

        if (room.players.length === 0) {
            rooms.delete(roomId);
            return;
        }

        if (room.hostId === playerId) {
            room.hostId = room.players[0].id;
        }

        if (room.status === 'playing') {
            const disconnected = room.players.find((p) => p.id === playerId);
            if (disconnected) disconnected.alive = false;
            settleWinnerIfNeeded(room);
            moveTurnToNextAlive(room, room.turn);
        }

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
        maxPlayers,
        hostId: playerId,
        players: [createPlayer(playerId, nickname, ws)],
    };

    rooms.set(roomName, room);
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
    broadcastRoomState(room, `${nickname} подключился к комнате.`);
    return roomName;
}

function createPlayer(id, nickname, ws) {
    return {
        id,
        nickname,
        ws,
        ready: false,
        alive: true,
        ships: [],
        hitsTaken: new Set(),
        shotsByTarget: new Map(),
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
    room.players.forEach((player) => {
        player.alive = true;
        player.hitsTaken = new Set();
        player.shotsByTarget = new Map();
    });
    room.turn = room.players[0].id;

    broadcastRoomState(room, 'Игра запущена создателем комнаты.');
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

    if (!isInsideBoard(x, y)) {
        safeSendToPlayer(room, playerId, { type: 'error', message: 'Координаты вне поля' });
        return;
    }

    const attacker = room.players.find((player) => player.id === playerId);
    const defender = room.players.find((player) => player.id === targetId);

    if (!attacker || !defender) return;

    if (!defender.alive) {
        safeSendToPlayer(room, playerId, { type: 'error', message: 'Этот игрок уже выбыл' });
        return;
    }

    if (attacker.id === defender.id) {
        safeSendToPlayer(room, playerId, { type: 'error', message: 'Нельзя стрелять в себя' });
        return;
    }

    const targetShots = attacker.shotsByTarget.get(defender.id) || new Set();
    const key = pointKey(x, y);

    if (targetShots.has(key)) {
        safeSendToPlayer(room, playerId, { type: 'error', message: 'Вы уже стреляли в эту клетку выбранного поля' });
        return;
    }

    targetShots.add(key);
    attacker.shotsByTarget.set(defender.id, targetShots);

    const hit = isShipAt(defender.ships, x, y);
    if (hit) {
        defender.hitsTaken.add(key);
    }

    if (defender.alive && areAllShipsSunk(defender)) {
        defender.alive = false;
    }

    settleWinnerIfNeeded(room);

    if (room.status === 'playing') {
        moveTurnToNextAlive(room, attacker.id);
    }

    broadcast(room, {
        type: 'move-result',
        roomId: room.id,
        from: attacker.id,
        to: defender.id,
        target: { x, y },
        hit,
        winner: room.winner,
    });

    broadcastRoomState(room);
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

function broadcastRoomState(room, infoMessage = null) {
    room.players.forEach((viewer) => {
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
            you: viewer.id,
            players: room.players.map((player) => ({
                id: player.id,
                nickname: player.nickname,
                ready: player.ready,
                alive: player.alive,
            })),
            yourShips: viewer.ships,
            yourHitsTaken: Array.from(viewer.hitsTaken).map(keyToPoint),
            shotBoards,
        });
    });
}

function broadcast(room, payload) {
    room.players.forEach((player) => safeSend(player.ws, payload));
}

function safeSendToPlayer(room, playerId, payload) {
    const player = room.players.find((candidate) => candidate.id === playerId);
    if (player) safeSend(player.ws, payload);
}

function safeSend(ws, payload) {
    if (ws.readyState === WebSocket.OPEN) {
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

        for (let i = 0; i < sorted.length; i++) {
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