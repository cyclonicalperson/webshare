const express = require("express");
const fetch = require("node-fetch");
const WebSocket = require("ws");
const rateLimit = require("express-rate-limit");
const cors = require("cors");

const app = express();
const port = process.env.PORT || 3000;

// Enable trust proxy for Koyeb's X-Forwarded-For header
app.set("trust proxy", true);

// Metered API key from environment variable
const METERED_API_KEY = process.env.METERED_API_KEY;
const EXPECTED_API_KEY = "d14dc88365230f82d6529f70d98547c61dba";
console.log("Environment variables:", Object.keys(process.env));
console.log("METERED_API_KEY loaded:", !!METERED_API_KEY);
console.log("METERED_API_KEY length:", METERED_API_KEY?.length);
console.log("METERED_API_KEY matches expected:", METERED_API_KEY === EXPECTED_API_KEY);

// Enable CORS for all origins (or specify: ["https://websharer.netlify.app"])
app.use(cors({
    origin: "*" // Use "*" for testing; replace with "https://websharer.netlify.app" for production
}));

// Rate limiting for credential endpoint
const credentialLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 10, // 10 requests per minute
    message: "Too many credential requests, please try again later."
});

app.use(express.json());

// Health check endpoint
app.get("/health", (req, res) => {
    res.status(200).json({ status: "ok", METERED_API_KEY_SET: !!METERED_API_KEY });
});

// Endpoint to fetch Metered TURN credentials
app.get("/get-turn-credentials", credentialLimiter, async (req, res) => {
    console.log(`Incoming request: ${req.method} ${req.url}`);
    console.log("Request headers:", req.headers);

    if (!METERED_API_KEY) {
        console.error("Missing METERED_API_KEY in environment variables.");
        return res.status(500).json({ error: "Metered API key not configured." });
    }

    if (METERED_API_KEY !== EXPECTED_API_KEY) {
        console.error("METERED_API_KEY does not match expected value.");
        return res.status(500).json({ error: "Invalid Metered API key." });
    }

    console.log(`Credential request from ${req.ip}`);
    const maxRetries = 3;
    let attempt = 0;

    while (attempt < maxRetries) {
        attempt++;
        console.log(`Fetching TURN credentials, attempt ${attempt}/${maxRetries}`);
        try {
            const response = await fetch(
                `https://webshare.metered.live/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`,
                {
                    method: "GET",
                    headers: {
                        "Accept": "application/json",
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:138.0) Gecko/20100101 Firefox/138.0"
                    }
                }
            );
            console.log("Metered API response status:", response.status);
            console.log("Metered API response headers:", Object.fromEntries(response.headers));

            if (!response.ok) {
                const errorText = await response.text().catch(() => "No response body");
                console.error(`Metered API error (attempt ${attempt}):`, response.status, errorText);
                if (attempt === maxRetries) {
                    console.error("Max retries reached, falling back to STUN servers.");
                    return res.status(200).json([
                        {
                            urls: [
                                "stun:stun.l.google.com:19302",
                                "stun:stun1.l.google.com:3478"
                            ]
                        }
                    ]);
                }
                // Wait before retrying
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                continue;
            }

            const data = await response.json();
            console.log("Metered API response data:", data);

            // Validate response as an array of ICE servers
            if (!Array.isArray(data) || !data[0]?.urls || !data[0].username || !data[0].credential) {
                console.error(`Invalid TURN credentials received (attempt ${attempt}):`, data);
                if (attempt === maxRetries) {
                    console.error("Max retries reached, falling back to STUN servers.");
                    return res.status(200).json([
                        {
                            urls: [
                                "stun:stun.l.google.com:19302",
                                "stun:stun1.l.google.com:3478"
                            ]
                        }
                    ]);
                }
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                continue;
            }

            res.json(data); // Return the array as-is
            return;
        } catch (error) {
            console.error(`Error fetching TURN credentials (attempt ${attempt}):`, error.message);
            if (attempt === maxRetries) {
                console.error("Max retries reached, falling back to STUN servers.");
                return res.status(200).json([
                    {
                        urls: [
                            "stun:stun.l.google.com:19302",
                            "stun:stun1.l.google.com:3478"
                        ]
                    }
                ]);
            }
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
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