const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: process.env.PORT || 3000 });

const rooms = new Map();
const clientRoom = new Map();

function broadcastRoomInfo(roomId) {
    const clients = rooms.get(roomId);
    if (!clients) return;
    const message = JSON.stringify({
        type: 'room-update',
        room: roomId,
        count: clients.size,
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
        } catch (err) {
            console.error("Failed to parse message:", err);
            return;
        }

        if (msg.type === 'join') {
            const roomId = msg.room;
            if (!roomId) return;

            // Clean up previous room
            const prevRoom = clientRoom.get(ws);
            if (prevRoom && rooms.has(prevRoom)) {
                rooms.get(prevRoom).delete(ws);
                broadcastRoomInfo(prevRoom);
                if (rooms.get(prevRoom).size === 0) {
                    rooms.delete(prevRoom);
                }
            }

            // Join new room
            if (!rooms.has(roomId)) rooms.set
            rooms.set(roomId, new Set());
            rooms.get(roomId).add(ws);
            clientRoom.set(ws, roomId);

            const clients = rooms.get(roomId);
            const initiator = clients.size === 1;

            ws.send(JSON.stringify({
                type: 'joined',
                room: roomId,
                count: clients.size,
                initiator
            }));

            broadcastRoomInfo(roomId);
            return;
        }

        if (msg.type === 'offer' || msg.type === 'answer' || msg.type === 'ice-candidate') {
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

    ws.on('error', (err) => {
        console.error("WebSocket error:", err);
    });
});

console.log('WebSocket signaling server running on port 3000');