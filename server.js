const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Battleship WebSocket server is running');
});
const wss = new WebSocket.Server({ server });

const BOARD_SIZE = 10;
const DEFAULT_SHIPS = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
const rooms = new Map();

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Battleship server started on http://0.0.0.0:${PORT}`);
});

wss.on('connection', (ws) => {
    const playerId = Math.random().toString(36).slice(2, 10);
    let roomId = null;

    ws.send(
        JSON.stringify({
            type: 'hello',
            playerId,
        })
    );

    ws.on('message', (raw) => {
        let data;
        try {
            data = JSON.parse(raw.toString());
        } catch {
            safeSend(ws, { type: 'error', message: 'Некорректный JSON' });
            return;
        }

        if (data.type === 'join') {
            roomId = String(data.room || '').trim();
            if (!roomId) {
                safeSend(ws, { type: 'error', message: 'Введите название комнаты' });
                return;
            }

            const room = getOrCreateRoom(roomId);
            if (room.players.length >= 2) {
                safeSend(ws, { type: 'error', message: 'Комната уже заполнена (2/2)' });
                return;
            }

            room.players.push(createPlayer(playerId, ws));
            broadcastRoomState(room);
            return;
        }

        if (!roomId) {
            safeSend(ws, { type: 'error', message: 'Сначала подключитесь к комнате' });
            return;
        }

        const room = rooms.get(roomId);
        if (!room) return;

        if (data.type === 'place-ships') {
            handlePlaceShips(room, playerId, data.ships);
            return;
        }

        if (data.type === 'move') {
            handleMove(room, playerId, data.x, data.y);
        }
    });

    ws.on('close', () => {
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;

        room.players = room.players.filter((p) => p.id !== playerId);
        if (room.players.length === 0) {
            rooms.delete(roomId);
            return;
        }

        room.status = 'waiting';
        room.turn = null;
        room.winner = null;
        room.players.forEach((p) => {
            p.ready = false;
            p.ships = [];
            p.hits = new Set();
            p.shots = new Set();
        });

        broadcastRoomState(room, `${playerId} отключился. Начните новую партию.`);
    });
});

function createPlayer(id, ws) {
    return {
        id,
        ws,
        ready: false,
        ships: [],
        hits: new Set(),
        shots: new Set(),
    };
}

function getOrCreateRoom(roomId) {
    if (!rooms.has(roomId)) {
        rooms.set(roomId, {
            id: roomId,
            status: 'waiting',
            turn: null,
            winner: null,
            players: [],
        });
    }
    return rooms.get(roomId);
}

function handlePlaceShips(room, playerId, ships) {
    const player = room.players.find((p) => p.id === playerId);
    if (!player) return;

    const result = validateShips(ships);
    if (!result.ok) {
        safeSend(player.ws, { type: 'error', message: result.message });
        return;
    }

    player.ships = ships;
    player.ready = true;

    const readyCount = room.players.filter((p) => p.ready).length;
    if (room.players.length === 2 && readyCount === 2) {
        room.status = 'playing';
        room.turn = room.players[0].id;
        room.winner = null;
    }

    broadcastRoomState(room);
}

function handleMove(room, playerId, x, y) {
    if (room.status !== 'playing') {
        safeSendToPlayer(room, playerId, { type: 'error', message: 'Игра ещё не началась' });
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

    const attacker = room.players.find((p) => p.id === playerId);
    const defender = room.players.find((p) => p.id !== playerId);
    if (!attacker || !defender) return;

    const key = pointKey(x, y);
    if (attacker.shots.has(key)) {
        safeSend(attacker.ws, { type: 'error', message: 'Вы уже стреляли в эту клетку' });
        return;
    }

    attacker.shots.add(key);
    const isHit = isShipAt(defender.ships, x, y);
    if (isHit) {
        defender.hits.add(key);
    }

    const sunkShip = isHit ? findSunkShip(defender.ships, defender.hits, x, y) : null;
    const allSunk = defender.ships.every((ship) => ship.cells.every((c) => defender.hits.has(pointKey(c.x, c.y))));

    if (allSunk) {
        room.status = 'finished';
        room.winner = attacker.id;
        room.turn = null;
    } else if (!isHit) {
        room.turn = defender.id;
    }

    broadcast(room, {
        type: 'move-result',
        roomId: room.id,
        from: attacker.id,
        target: { x, y },
        hit: isHit,
        sunk: Boolean(sunkShip),
        sunkSize: sunkShip?.cells.length || 0,
        nextTurn: room.turn,
        winner: room.winner,
    });

    broadcastRoomState(room);
}

function broadcastRoomState(room, infoMessage = null) {
    const playerIds = room.players.map((p) => p.id);

    room.players.forEach((player) => {
        const enemy = room.players.find((p) => p.id !== player.id);

        safeSend(player.ws, {
            type: 'room-state',
            roomId: room.id,
            status: room.status,
            turn: room.turn,
            winner: room.winner,
            infoMessage,
            you: player.id,
            players: playerIds,
            ready: room.players.map((p) => ({ id: p.id, ready: p.ready })),
            yourShips: player.ships,
            yourHitsTaken: Array.from(player.hits).map(keyToPoint),
            yourShots: Array.from(player.shots).map(keyToPoint),
            enemyHitsTaken: enemy ? Array.from(enemy.hits).map(keyToPoint) : [],
            enemyShots: enemy ? Array.from(enemy.shots).map(keyToPoint) : [],
        });
    });
}

function broadcast(room, payload) {
    room.players.forEach((player) => safeSend(player.ws, payload));
}

function safeSendToPlayer(room, playerId, payload) {
    const player = room.players.find((p) => p.id === playerId);
    if (player) safeSend(player.ws, payload);
}

function safeSend(ws, data) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

function validateShips(ships) {
    if (!Array.isArray(ships) || ships.length !== DEFAULT_SHIPS.length) {
        return { ok: false, message: 'Неверное количество кораблей' };
    }

    const sizes = ships.map((s) => (Array.isArray(s.cells) ? s.cells.length : 0)).sort((a, b) => b - a);
    const expected = [...DEFAULT_SHIPS].sort((a, b) => b - a);

    if (JSON.stringify(sizes) !== JSON.stringify(expected)) {
        return { ok: false, message: 'Неверная конфигурация флота' };
    }

    const occupied = new Set();

    for (const ship of ships) {
        if (!Array.isArray(ship.cells) || ship.cells.length === 0) {
            return { ok: false, message: 'Корабль без клеток' };
        }

        const xs = ship.cells.map((c) => c.x);
        const ys = ship.cells.map((c) => c.y);
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
                const dist = Math.abs(prev.x - cell.x) + Math.abs(prev.y - cell.y);
                if (dist !== 1) {
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
            if (occupied.has(nKey)) {
                const cellShip = shipIndexByCell(ships, x, y);
                const neighShip = shipIndexByCell(ships, x + dx, y + dy);
                if (cellShip !== neighShip) {
                    return { ok: false, message: 'Корабли не должны соприкасаться' };
                }
            }
        }
    }

    return { ok: true };
}

function shipIndexByCell(ships, x, y) {
    return ships.findIndex((ship) => ship.cells.some((c) => c.x === x && c.y === y));
}

function isInsideBoard(x, y) {
    return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < BOARD_SIZE && y < BOARD_SIZE;
}

function pointKey(x, y) {
    return `${x}:${y}`;
}

function keyToPoint(key) {
    const [x, y] = key.split(':').map(Number);
    return { x, y };
}

function isShipAt(ships, x, y) {
    return ships.some((ship) => ship.cells.some((cell) => cell.x === x && cell.y === y));
}

function findSunkShip(ships, hits, x, y) {
    const target = ships.find((ship) => ship.cells.some((cell) => cell.x === x && cell.y === y));
    if (!target) return null;
    const sunk = target.cells.every((cell) => hits.has(pointKey(cell.x, cell.y)));
    return sunk ? target : null;
}