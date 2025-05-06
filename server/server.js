const express = require("express");
const fetch = require("node-fetch");
const WebSocket = require("ws");
const dotenv = require("dotenv");
const rateLimit = require("express-rate-limit");
const cors = require("cors");

// Load environment variables
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Metered API key from environment variable
const METERED_API_KEY = process.env.METERED_API_KEY;

// Enable CORS for all origins (or specify: ["https://websharer.netlify.app"])
app.use(cors({
    origin: "*" // Use "*" for simplicity; replace with "https://websharer.netlify.app" for production
}));

// Rate limiting for credential endpoint
const credentialLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 10, // 10 requests per minute
    message: "Too many credential requests, please try again later."
});

app.use(express.json());

// Endpoint to fetch Metered TURN credentials
app.get("/get-turn-credentials", credentialLimiter, async (req, res) => {
    try {
        if (!METERED_API_KEY) {
            console.error("Missing METERED_API_KEY in environment variables.");
            return res.status(500).json({ error: "Metered API key not configured." });
        }
        console.log(`Credential request from ${req.ip}`);
        const response = await fetch(
            `https://webshare.metered.live/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`,
            { method: "POST" }
        );
        if (!response.ok) {
            const errorText = await response.text();
            console.error("Metered API error details:", errorText);
            return res.status(500).json({ error: `Metered API error: ${response.status}` });
        }
        const data = await response.json();
        res.json({
            username: data.username,
            password: data.password,
            uris: data.uris
        });
    } catch (err) {
        console.error("Error fetching TURN credentials:", err.message);
        res.status(500).json({ error: "Failed to fetch TURN credentials" });
    }
});

// WebSocket server for signaling
const wss = new WebSocket.Server({ noServer: true });

wss.on("connection", (ws) => {
    console.log("New WebSocket connection");
    ws.isAlive = true;

    ws.on("pong", () => {
        ws.isAlive = true;
    });

    ws.on("message", (message) => {
        try {
            const data = JSON.parse(message);
            console.log("Received WebSocket message:", data);

            switch (data.type) {
                case "ping":
                    ws.send(JSON.stringify({ type: "pong" }));
                    break;
                case "join":
                    // Assign initiator: first client in room is initiator
                    ws.initiator = wss.clients.size === 1;
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: "joined",
                                room: data.room,
                                initiator: ws.initiator,
                                count: wss.clients.size
                            }));
                        }
                    });
                    break;
                case "offer":
                case "answer":
                case "ice-candidate":
                    wss.clients.forEach(client => {
                        if (client !== ws && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify(data));
                        }
                    });
                    break;
                default:
                    console.warn("Unknown message type:", data.type);
            }
        } catch (err) {
            console.error("Error processing WebSocket message:", err);
        }
    });

    ws.on("close", () => {
        console.log("WebSocket connection closed");
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                    type: "room-update",
                    room: "1",
                    count: wss.clients.size
                }));
            }
        });
    });
});

// HTTP server for Express and WebSocket
const server = app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

// Upgrade HTTP to WebSocket
server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
    });
});

// Keep WebSocket connections alive
setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);