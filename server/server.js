const WebSocket = require('ws');
const http = require('http');
const fetch = require('node-fetch');

// Create HTTP server and WebSocket server
const server = http.createServer();
const wss = new WebSocket.Server({ server });

// Data structures to track rooms and clients
const rooms = new Map(); // roomId -> Set of clients
const clientRoom = new Map(); // client -> roomId
const clientDeviceType = new Map(); // client -> deviceType

// List of allowed origins for CORS
const ALLOWED_ORIGINS = [
    'https://websharer.netlify.app',
    'http://localhost:8000',
    'http://localhost:8080',
    'http://127.0.0.1:8000',
    'http://127.0.0.1:8080'
];

// Set CORS headers for HTTP responses
function setCORSHeaders(res, origin) {
    const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : 'https://websharer.netlify.app';
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Send room state update to all clients in a room
function broadcastRoomInfo(roomId) {
    const clients = rooms.get(roomId);
    if (!clients || clients.size === 0) {
        rooms.delete(roomId);
        console.log(`Room ${roomId} is empty, deleted`);
        return;
    }

    // Get all device types in this room
    const devices = Array.from(clients).map(client => clientDeviceType.get(client) || 'unknown');

    // Prepare message
    const message = JSON.stringify({
        type: 'room-update',
        room: roomId,
        count: clients.size,
        devices: devices
    });

    console.log(`Broadcasting to room ${roomId}: ${clients.size} clients, devices: ${devices}`);

    // Send to all clients in room
    for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        } else {
            // Clean up stale connections
            clients.delete(client);
            clientRoom.delete(client);
            clientDeviceType.delete(client);
        }
    }

    // Delete room if empty
    if (clients.size === 0) {
        rooms.delete(roomId);
        console.log(`Room ${roomId} is now empty, deleted`);
    }
}

// Forward signaling messages to other clients in the room
function forwardToRoom(sender, message) {
    const roomId = clientRoom.get(sender);
    if (!roomId) return;

    const clients = rooms.get(roomId);
    if (!clients) return;

    const msg = JSON.stringify(message);
    console.log(`Forwarding ${message.type} in room ${roomId}`);

    for (const client of clients) {
        if (client !== sender && client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    }
}

// Handle new WebSocket connections
wss.on('connection', (ws) => {
    console.log('New client connected');

    // Handle messages from clients
    ws.on('message', (data) => {
        let msg;
        try {
            msg = JSON.parse(data);
        } catch (err) {
            console.error('Failed to parse message:', err);
            return;
        }

        switch (msg.type) {
            case 'ping':
                // Respond to keepalive pings
                ws.send(JSON.stringify({ type: 'pong' }));
                break;

            case 'join':
                handleJoinRoom(ws, msg);
                break;

            case 'offer':
            case 'answer':
            case 'ice-candidate':
                // Forward signaling messages to peers
                forwardToRoom(ws, msg);
                break;

            default:
                console.log(`Unknown message type: ${msg.type}`);
        }
    });

    // Handle disconnection
    ws.on('close', () => {
        handleClientDisconnect(ws);
    });

    // Handle errors
    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
        handleClientDisconnect(ws);
    });
});

// Handle client joining a room
function handleJoinRoom(client, message) {
    const roomId = message.room;
    if (!roomId) return;

    // Store client's device type
    const deviceType = message.deviceType || 'unknown';
    clientDeviceType.set(client, deviceType);
    console.log(`Client device: ${deviceType}`);

    // Remove from previous room if any
    const previousRoom = clientRoom.get(client);
    if (previousRoom && previousRoom !== roomId) {
        const room = rooms.get(previousRoom);
        if (room) {
            room.delete(client);
            broadcastRoomInfo(previousRoom);
        }
    }

    // Add to new room
    if (!rooms.has(roomId)) {
        rooms.set(roomId, new Set());
        console.log(`Created new room: ${roomId}`);
    }

    const room = rooms.get(roomId);
    room.add(client);
    clientRoom.set(client, roomId);

    // Determine if this client is the initiator (first in room)
    const isInitiator = room.size === 1;

    // Tell the client they've joined
    client.send(JSON.stringify({
        type: 'joined',
        room: roomId,
        count: room.size,
        initiator: isInitiator,
        peerTypes: Array.from(room)
            .filter(c => c !== client)
            .map(c => clientDeviceType.get(c) || 'unknown')
    }));

    // Update everyone in the room
    broadcastRoomInfo(roomId);
}

// Handle client disconnection
function handleClientDisconnect(client) {
    const roomId = clientRoom.get(client);

    if (roomId && rooms.has(roomId)) {
        console.log(`Client left room: ${roomId}`);
        rooms.get(roomId).delete(client);
        broadcastRoomInfo(roomId);
    }

    clientRoom.delete(client);
    clientDeviceType.delete(client);
}

// HTTP endpoint for TURN server credentials
server.on('request', async (req, res) => {
    if (req.url === '/turn-credentials' && req.method === 'GET') {
        setCORSHeaders(res, req.headers.origin);

        const apiKey = process.env.METERED_API_KEY;
        if (!apiKey) {
            console.error("METERED_API_KEY environment variable not set");
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: "Server configuration error: METERED_API_KEY not set"
            }));
            return;
        }

        try {
            // Fetch TURN credentials from Metered
            const metered_url = `https://webshare.metered.live/api/v1/turn/credentials?apiKey=${apiKey}`;
            const response = await fetch(metered_url);

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`Error from TURN service: ${response.status} - ${errorText}`);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: `Failed to fetch TURN credentials: ${errorText}`
                }));
                return;
            }

            const iceServers = await response.json();
            console.log("Serving ICE servers");

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(iceServers));
        } catch (err) {
            console.error("Error fetching TURN credentials:", err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: `Failed to fetch TURN credentials: ${err.message}`
            }));
        }
    } else {
        // Not found for any other endpoint
        res.writeHead(404);
        res.end();
    }
});

// Start the server
const port = process.env.PORT || 3000;
server.listen(port, () => {
    console.log(`WebShare signaling server running on port ${port}`);
});