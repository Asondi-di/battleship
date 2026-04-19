# **🔧 Архитектура**

**1\. Chrome Extension**

* интерфейс (поле, кнопки)  
* подключение к серверу через WebSocket

**2\. Локальный сервер (Node.js)**

* хранит игроков  
* управляет комнатами  
* синхронизирует ходы

---

# **🚀 Шаг 1\. Сервер (Node.js)**

Установка:

mkdir battleship  
cd battleship  
npm init \-y  
npm install ws express

### **`server.js`**

const express \= require('express');  
const WebSocket \= require('ws');

const app \= express();  
const server \= app.listen(3000, () \=\> {  
   console.log('Server running on http://localhost:3000');  
});

const wss \= new WebSocket.Server({ server });

let rooms \= {};

wss.on('connection', (ws) \=\> {  
   let currentRoom \= null;  
   let playerId \= Math.random().toString(36).substr(2, 9);

   ws.on('message', (message) \=\> {  
       const data \= JSON.parse(message);

       if (data.type \=== 'join') {  
           currentRoom \= data.room;

           if (\!rooms\[currentRoom\]) {  
               rooms\[currentRoom\] \= \[\];  
           }

           rooms\[currentRoom\].push({ ws, playerId });

           broadcast(currentRoom, {  
               type: 'players',  
               players: rooms\[currentRoom\].map(p \=\> p.playerId)  
           });  
       }

       if (data.type \=== 'move') {  
           broadcast(currentRoom, {  
               type: 'move',  
               from: playerId,  
               x: data.x,  
               y: data.y  
           });  
       }  
   });

   ws.on('close', () \=\> {  
       if (currentRoom && rooms\[currentRoom\]) {  
           rooms\[currentRoom\] \= rooms\[currentRoom\].filter(p \=\> p.ws \!== ws);  
       }  
   });  
});

function broadcast(room, data) {  
   rooms\[room\].forEach(player \=\> {  
       player.ws.send(JSON.stringify(data));  
   });  
}  
---

# **🧩 Шаг 2\. Chrome Extension**

## **📁 Структура**

extension/  
├── manifest.json  
├── popup.html  
├── popup.js  
└── style.css  
---

## **`manifest.json`**

{  
 "manifest\_version": 3,  
 "name": "Battleship LAN",  
 "version": "1.0",  
 "action": {  
   "default\_popup": "popup.html"  
 },  
 "permissions": \["storage"\]  
}  
---

## **`popup.html`**

\<\!DOCTYPE html\>  
\<html\>  
\<head\>  
\<link rel="stylesheet" href="style.css"\>  
\</head\>  
\<body\>

\<h3\>Морской бой\</h3\>

\<input id="room" placeholder="Комната"\>  
\<button id="connect"\>Подключиться\</button\>

\<div id="game"\>\</div\>

\<script src="popup.js"\>\</script\>  
\</body\>  
\</html\>  
---

## **`style.css`**

\#game {  
   display: grid;  
   grid-template-columns: repeat(10, 30px);  
   gap: 2px;  
   margin-top: 10px;  
}

.cell {  
   width: 30px;  
   height: 30px;  
   background: \#ddd;  
   cursor: pointer;  
}

.hit {  
   background: red;  
}

.miss {  
   background: blue;  
}  
---

## **`popup.js`**

let ws;  
const game \= document.getElementById('game');

function createGrid() {  
   game.innerHTML \= '';  
   for (let y \= 0; y \< 10; y++) {  
       for (let x \= 0; x \< 10; x++) {  
           const cell \= document.createElement('div');  
           cell.className \= 'cell';

           cell.onclick \= () \=\> {  
               ws.send(JSON.stringify({  
                   type: 'move',  
                   x, y  
               }));  
           };

           cell.dataset.x \= x;  
           cell.dataset.y \= y;

           game.appendChild(cell);  
       }  
   }  
}

document.getElementById('connect').onclick \= () \=\> {  
   const room \= document.getElementById('room').value;

   ws \= new WebSocket('ws://localhost:3000');

   ws.onopen \= () \=\> {  
       ws.send(JSON.stringify({  
           type: 'join',  
           room  
       }));  
   };

   ws.onmessage \= (event) \=\> {  
       const data \= JSON.parse(event.data);

       if (data.type \=== 'move') {  
           const cells \= document.querySelectorAll('.cell');

           cells.forEach(cell \=\> {  
               if (  
                   cell.dataset.x \== data.x &&  
                   cell.dataset.y \== data.y  
               ) {  
                   cell.classList.add('hit');  
               }  
           });  
       }  
   };

   createGrid();  
};  
---

# **🧪 Как запускать**

1. Запускаешь сервер:

node server.js

2. В Chrome:  
* chrome://extensions  
* Включить "Режим разработчика"  
* "Загрузить распакованное расширение"  
* выбрать папку `extension`  
3. На разных компах в сети:  
* вместо `localhost` указать IP сервера:

ws \= new WebSocket('ws://192.168.0.10:3000');  
---

# **⚠️ Ограничения текущей версии**

Это **MVP**, тут нет:

* расстановки кораблей  
* проверки попаданий  
* очередности ходов  
* победителя  
* UI для нескольких игроков

---

# **🔥 Как довести до полноценной игры**

Добавить:

### **1\. Логику игры**

* массив поля (10x10)  
* генерацию кораблей  
* проверку попаданий

### **2\. Очередь игроков**

currentTurn \= player1

### **3\. Комнаты**

* до 2–4 игроков

### **4\. Состояние игры на сервере**

* хранить поле каждого игрока

### **5\. UI**

* два поля (своё \+ врага)  
* отображение кораблей

---

# **💡 Важный момент**

Если хочешь сделать **реально удобную версию**, лучше:

* фронт: React (в расширении)  
* сервер: Node.js \+ WebSocket  
* или вообще уйти от расширения и сделать **PWA**

---

# **👉 Хочешь дальше?**

Могу тебе:

* дописать **полную игровую логику (корабли, победа)**  
* сделать **React-версию расширения**  
* или сделать **без сервера (через WebRTC, чистый LAN)**

Скажи, какой уровень нужен — MVP или уже почти продакшн.

