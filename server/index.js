const http = require('http');
const WebSocket = require('ws');

const server = http.createServer();
const wss = new WebSocket.Server({ server });

const rooms = {};

wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        const { type, room, payload } = JSON.parse(message);
        if (!rooms[room]) rooms[room] = [];
        if (!rooms[room].includes(ws)) rooms[room].push(ws);

        rooms[room].forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type, payload }));
            }
        });
    });

    ws.on('close', () => {
        for (const room in rooms) {
            rooms[room] = rooms[room].filter(client => client !== ws);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`WebSocket server running on port ${PORT}`);
});
