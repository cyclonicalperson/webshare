const WebSocket = require('ws');
const http = require('http');
const fetch = require('node-fetch');

const server = http.createServer();
const wss = new WebSocket.Server({ server });
const rooms = new Map();
const clientRoom = new Map();

// CORS middleware
function setCORSHeaders(res, origin) {
    const allowedOrigins = ['https://websharer.netlify.app', 'http://localhost:8000', 'http://localhost:8080', 'http://127.0.0.1:8000', 'http://127.0.0.1:8080'];
    const corsOrigin = allowedOrigins.includes(origin) ? origin : 'https://websharer.netlify.app';
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

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
            clients.delete(client);
            clientRoom.delete(client);
        }
    }
    if (clients.size === 0) {
        rooms.delete(roomId);
        console.log(`Deleted empty room: ${roomId}`);
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
            if (prevRoom && prevRoom !== roomId && rooms.has(prevRoom)) {
                console.log(`Removing client from previous room: ${prevRoom}`);
                rooms.get(prevRoom).delete(ws);
                broadcastRoomInfo(prevRoom);
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
            broadcastRoomInfo(roomId);
        }
        clientRoom.delete(ws);
    });

    ws.on('error', (err) => {
        console.error("WebSocket error:", err);
        const roomId = clientRoom.get(ws);
        if (roomId && rooms.has(roomId)) {
            rooms.get(roomId).delete(ws);
            broadcastRoomInfo(roomId);
        }
        clientRoom.delete(ws);
    });
});

// Endpoint to fetch TURN credentials
server.on('request', async (req, res) => {
    if (req.url === '/turn-credentials' && req.method === 'GET') {
        setCORSHeaders(res, req.headers.origin);
        const apiKey = process.env.METERED_API_KEY;
        console.log(`Using METERED_API_KEY: ${apiKey ? apiKey.slice(0, 8) + '... (hidden)' : 'not set'}`);
        if (!apiKey) {
            console.error("METERED_API_KEY not set");
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Server configuration error: METERED_API_KEY not set" }));
            return;
        }
        try {
            const response = await fetch(`https://webshare.metered.live/api/v1/turn/credentials?apiKey=${apiKey}`);
            if (!response.ok) {
                const errorText = await response.text();
                console.error(`HTTP error fetching TURN credentials, status: ${response.status}, text: ${errorText}`);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Failed to fetch TURN credentials: ${errorText}` }));
                return;
            }
            const iceServers = await response.json();
            console.log("Serving ICE servers:", iceServers);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(iceServers));
        } catch (err) {
            console.error("Failed to fetch TURN credentials:", err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Failed to fetch TURN credentials: " + err.message }));
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