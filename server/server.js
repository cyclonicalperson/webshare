const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: process.env.PORT || 3000 });

const rooms = new Map();
const clientRoom = new Map();

function broadcastRoomInfo(roomId) {
    const clients = rooms.get(roomId);
    if (!clients) {
        console.log(`No clients in room ${roomId}`);
        return;
    }
    const message = JSON.stringify({
        type: 'room-update',
        room: roomId,
        count: clients.size,
    });
    console.log(`Broadcasting room update: ${roomId}, count: ${clients.size}`);
    for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        } else {
            console.log(`Client in room ${roomId} is not open, state: ${client.readyState}`);
        }
    }
}

function forwardToRoom(sender, messageObj) {
    const roomId = clientRoom.get(sender);
    if (!roomId) {
        console.log("No room found for sender");
        return;
    }
    const clients = rooms.get(roomId);
    if (!clients) {
        console.log(`No clients in room ${roomId}`);
        return;
    }
    const msg = JSON.stringify(messageObj);
    console.log(`Forwarding ${messageObj.type} to room ${roomId}`);
    for (const client of clients) {
        if (client !== sender && client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    }
}

wss.on('connection', (ws) => {
    console.log("New WebSocket connection established");

    ws.on('message', (data) => {
        let msg;
        try {
            msg = JSON.parse(data);
            console.log("Received message:", msg);
        } catch (err) {
            console.error("Failed to parse message:", err);
            return;
        }

        if (msg.type === 'join') {
            const roomId = msg.room;
            if (!roomId) {
                console.log("No room ID provided");
                return;
            }

            // Clean up previous room
            const prevRoom = clientRoom.get(ws);
            if (prevRoom && rooms.has(prevRoom)) {
                console.log(`Removing client from previous room: ${prevRoom}`);
                rooms.get(prevRoom).delete(ws);
                broadcastRoomInfo(prevRoom);
                if (rooms.get(prevRoom).size === 0) {
                    rooms.delete(prevRoom);
                    console.log(`Deleted empty room: ${prevRoom}`);
                }
            }

            // Join new room
            if (!rooms.has(roomId)) {
                rooms.set(roomId, new Set());
                console.log(`Created new room: ${roomId}`);
            }
            rooms.get(roomId).add(ws);
            clientRoom.set(ws, roomId);
            console.log(`Client joined room: ${roomId}`);

            const clients = rooms.get(roomId);
            const initiator = clients.size === 1;

            ws.send(JSON.stringify({
                type: 'joined',
                room: roomId,
                count: clients.size,
                initiator
            }));
            console.log(`Sent joined message to client: ${roomId}, count: ${clients.size}, initiator: ${initiator}`);

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
            console.log(`Client disconnected from room: ${roomId}`);
            rooms.get(roomId).delete(ws);
            if (rooms.get(roomId).size === 0) {
                rooms.delete(roomId);
                console.log(`Deleted empty room: ${roomId}`);
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
