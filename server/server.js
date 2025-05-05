const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: process.env.PORT || 3000 });

const rooms = new Map(); // roomId => Set of clients
const clientRoom = new Map(); // ws => roomId

function broadcastRoomInfo(roomId) {
    const clients = rooms.get(roomId);
    if (!clients) return;
    const message = JSON.stringify({
        type: 'room_info',
        room: roomId,
        clients: clients.size,
    });
    for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    }
}

function forwardToRoom(sender, messageObj) {
    const roomId = clientRoom.get(sender);
    if (!roomId) return;
    const clients = rooms.get(roomId);
    if (!clients) return;
    const msg = JSON.stringify(messageObj);
    for (const client of clients) {
        if (client !== sender && client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    }
}

wss.on('connection', (ws) => {
    ws.on('message', (data) => {
        let msg;
        try {
            msg = JSON.parse(data);
        } catch {
            return;
        }

        if (msg.type === 'join') {
            const roomId = msg.room;
            if (!roomId) return;

            // Remove from previous room if exists
            const prevRoom = clientRoom.get(ws);
            if (prevRoom && rooms.has(prevRoom)) {
                rooms.get(prevRoom).delete(ws);
                broadcastRoomInfo(prevRoom);
            }

            // Add to new room
            if (!rooms.has(roomId)) rooms.set(roomId, new Set());
            rooms.get(roomId).add(ws);
            clientRoom.set(ws, roomId);
            broadcastRoomInfo(roomId);
            return;
        }

        // Forward offer/answer/ice only to other clients in the room
        if (msg.offer || msg.answer || msg.ice) {
            forwardToRoom(ws, msg);
        }
    });

    ws.on('close', () => {
        const roomId = clientRoom.get(ws);
        if (roomId && rooms.has(roomId)) {
            rooms.get(roomId).delete(ws);
            if (rooms.get(roomId).size === 0) {
                rooms.delete(roomId);
            } else {
                broadcastRoomInfo(roomId);
            }
        }
        clientRoom.delete(ws);
    });
});

console.log('WebSocket signaling server running on port 3000');
