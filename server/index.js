// server/index.js
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const wss = new WebSocket.Server({ port: 3000 });
const rooms = new Map();

wss.on('connection', (ws) => {
    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        const { type, room, payload } = msg;

        if (type === 'join') {
            ws.room = room;
            if (!rooms.has(room)) rooms.set(room, []);
            rooms.get(room).push(ws);
            console.log(`User joined room: ${room}`);
        }

        // Relay messages to other clients in the same room
        if (['offer', 'answer', 'ice'].includes(type)) {
            const peers = rooms.get(room) || [];
            peers.forEach((peer) => {
                if (peer !== ws) peer.send(JSON.stringify({ type, payload }));
            });
        }
    });

    ws.on('close', () => {
        if (ws.room && rooms.has(ws.room)) {
            const updated = rooms.get(ws.room).filter((peer) => peer !== ws);
            if (updated.length) {
                rooms.set(ws.room, updated);
            } else {
                rooms.delete(ws.room);
            }
        }
    });
});

console.log('WebSocket signaling server running on ws://localhost:3000');
