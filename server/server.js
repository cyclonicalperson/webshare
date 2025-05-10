const WebSocket = require('ws');
const http = require('http');
const fetch = require('node-fetch');

const server = http.createServer();
const wss = new WebSocket.Server({ server });

const rooms = new Map();
const clientRoom = new Map();

// CORS middleware
function setCORSHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', 'https://websharer.netlify.app');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function broadcastRoomInfo(roomId) {
    const clients = rooms.get(roomId);
    if (!clients) {
        console.log(`No clients in room ${roomId}`);
        return;
    }
    // Collect peerTypes from all clients in the room
    const peerTypes = Array.from(clients).map(client => clientRoom.get(client)?.deviceType || 'unknown');
    const message = JSON.stringify({
        type: 'room-update',
        room: roomId,
        count: clients.size,
        peerTypes
    });
    console.log(`Broadcasting room update: ${roomId}, count: ${clients.size}, peerTypes: ${peerTypes}`);
    for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        } else {
            console.log(`Client in room ${roomId} is not open, state: ${client.readyState}`);
        }
    }
}

function forwardToRoom(sender, messageObj) {
    const roomData = clientRoom.get(sender);
    const roomId = roomData?.roomId;
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
    console.log(`Forwarding ${messageObj.type} to room ${roomId}:`, msg);
    let forwardedCount = 0;
    for (const client of clients) {
        if (client !== sender && client.readyState === WebSocket.OPEN) {
            client.send(msg);
            forwardedCount++;
        }
    }
    console.log(`Forwarded ${messageObj.type} to ${forwardedCount} clients in room ${roomId}`);
}

wss.on('connection', (ws) => {
    console.log("New WebSocket connection established");

    ws.on('message', (data) => {
        let msg;
        try {
            msg = JSON.parse(data);
            console.log("Received message:", msg);
        } catch (err) {
            console.error("Failed to parse message:", err.message);
            return;
        }

        if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
            return;
        }

        if (msg.type === 'join') {
            const roomId = msg.room;
            if (!roomId) {
                console.log("No room ID provided");
                return;
            }
            // Store deviceType from the join message
            const deviceType = msg.deviceType || 'unknown';
            clientRoom.set(ws, { roomId, deviceType });

            // Clean up previous room
            const prevRoom = clientRoom.get(ws)?.roomId;
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
            console.log(`Client joined room: ${roomId}`);

            const clients = rooms.get(roomId);
            const initiator = clients.size === 1;
            // Collect peerTypes for the room
            const peerTypes = Array.from(clients).map(client => clientRoom.get(client)?.deviceType || 'unknown');

            ws.send(JSON.stringify({
                type: 'joined',
                room: roomId,
                count: clients.size,
                initiator,
                peerTypes
            }));
            console.log(`Sent joined message to client: ${roomId}, count: ${clients.size}, initiator: ${initiator}, peerTypes: ${peerTypes}`);

            broadcastRoomInfo(roomId);
            return;
        }

        if (msg.type === 'offer' || msg.type === 'answer' || msg.type === 'ice-candidate') {
            forwardToRoom(ws, msg);
        }
    });

    ws.on('close', () => {
        const roomData = clientRoom.get(ws);
        const roomId = roomData?.roomId;
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
        console.error("WebSocket error:", err.message);
    });
});

// Endpoint to fetch TURN credentials
server.on('request', async (req, res) => {
    if (req.url === '/turn-credentials' && req.method === 'GET') {
        setCORSHeaders(res);
        try {
            const apiKey = process.env.METERED_API_KEY;
            if (!apiKey) {
                console.error("METERED_API_KEY not set");
            }
            const response = await fetch(`https://webshare.metered.live/api/v1/turn/credentials?apiKey=${apiKey}`);
            if (!response.ok) {
                console.error(`TURN fetch failed: ${response.status} ${response.statusText}`);
            }
            const iceServers = await response.json();
            console.log("Fetched TURN credentials:", JSON.stringify(iceServers, null, 2));
            const hasTurn = iceServers.some(server => server.urls.includes("turn:") || server.urls.includes("turns:"));
            if (!hasTurn) {
                console.warn("No TURN servers in response, may cause connection issues");
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(iceServers));
        } catch (err) {
            console.error("Failed to fetch TURN credentials:", err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Failed to fetch TURN credentials" }));
        }
    } else {
        res.writeHead(404);
        res.end();
    }
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
    console.log(`Server running on port ${port}`);
});