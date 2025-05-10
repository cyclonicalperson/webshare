document.addEventListener("DOMContentLoaded", () => {
    // DOM Elements
    const roomInput = document.getElementById("roomInput");
    const joinRoomBtn = document.getElementById("joinRoomBtn");
    const roomDisplay = document.getElementById("roomDisplay");
    const peerInfo = document.getElementById("peerInfo");
    const fileInput = document.getElementById("fileInput");
    const sendBtn = document.getElementById("sendBtn");
    const progressBar = document.getElementById("progressBar");
    const status = document.getElementById("status");

    // Constants
    const SERVER_URL = "wss://primary-tove-arsenijevicdev-4f187706.koyeb.app";
    const CHUNK_SIZE = 131072; // 128KB chunks
    const MAX_BUFFERED_AMOUNT = 2097152; // 2MB buffer threshold
    const PROGRESS_UPDATE_INTERVAL = 5; // Update progress every 5%
    const RECONNECT_TIMEOUT = 5000; // 5 seconds
    const MAX_RECONNECT_ATTEMPTS = 5;

    // State variables
    let ws = null;
    let pc = null;
    let dc = null;
    let isInitiator = false;
    let currentRoom = "";
    let reconnectAttempts = 0;
    let pendingIceCandidates = [];
    let deviceType = detectDeviceType();
    let isConnectingPeer = false;

    // Detect user's device type
    function detectDeviceType() {
        const ua = navigator.userAgent.toLowerCase();
        const isMobile = /mobile|android|iphone|ipad|ipod|blackberry|windows phone/.test(ua);
        return isMobile ? "mobile" : "desktop";
    }

    // Get appropriate ICE servers based on connection needs
    async function getIceServers(useTurn = false) {
        // Basic STUN servers (always include these)
        const stunServers = [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" }
        ];

        if (!useTurn) {
            console.log("Using STUN-only configuration");
            return stunServers;
        }

        try {
            console.log("Fetching TURN servers...");
            const response = await fetch(`${SERVER_URL.replace("wss:", "https:")}/turn-credentials`);

            if (!response.ok) {
                console.warn("Failed to fetch TURN servers, falling back to backup");
                return [...stunServers, {
                    urls: "turn:openrelay.metered.ca:443",
                    username: "openrelayproject",
                    credential: "openrelayproject"
                }];
            }

            const iceServers = await response.json();
            console.log("Using server-provided ICE configuration");
            return iceServers;
        } catch (err) {
            console.error("Error fetching TURN credentials:", err);
            return [...stunServers, {
                urls: "turn:openrelay.metered.ca:443",
                username: "openrelayproject",
                credential: "openrelayproject"
            }];
        }
    }

    // Connect to the signaling server
    function connectWebSocket() {
        if (ws && ws.readyState === WebSocket.OPEN) return;

        status.textContent = "Connecting to signaling server...";
        console.log("Connecting to WebSocket server...");

        ws = new WebSocket(SERVER_URL);

        ws.onopen = () => {
            reconnectAttempts = 0;
            status.textContent = "Connected to signaling server.";
            console.log("WebSocket connection established");

            // Setup keepalive ping
            setInterval(() => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: "ping" }));
                }
            }, 30000);

            // Join room if we have one
            if (currentRoom) {
                joinRoom(currentRoom);
            }
        };

        ws.onclose = () => {
            console.log("WebSocket connection closed");
            status.textContent = "Connection to server lost. Reconnecting...";
            cleanupPeerConnection();
            attemptReconnect();
        };

        ws.onerror = (err) => {
            console.error("WebSocket error:", err);
            status.textContent = "WebSocket error occurred.";
        };

        ws.onmessage = handleWebSocketMessage;
    }

    // Handle reconnection attempts
    function attemptReconnect() {
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            status.textContent = "Failed to reconnect after multiple attempts.";
            return;
        }

        reconnectAttempts++;
        status.textContent = `Reconnecting... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`;

        setTimeout(connectWebSocket, RECONNECT_TIMEOUT);
    }

    // Process messages from the signaling server
    function handleWebSocketMessage(event) {
        try {
            const data = JSON.parse(event.data);
            console.log("Received:", data.type);

            switch (data.type) {
                case "pong":
                    // Server keepalive response
                    break;

                case "joined":
                    handleRoomJoined(data);
                    break;

                case "offer":
                    handleRemoteOffer(data.offer);
                    break;

                case "answer":
                    handleRemoteAnswer(data.answer);
                    break;

                case "ice-candidate":
                    handleRemoteIceCandidate(data.candidate);
                    break;

                case "room-update":
                    handleRoomUpdate(data);
                    break;

                default:
                    console.log("Unknown message type:", data.type);
            }
        } catch (err) {
            console.error("Error processing message:", err);
        }
    }

    // Handle joining a room successfully
    async function handleRoomJoined(data) {
        console.log(`Joined room: ${data.room}, initiator: ${data.initiator}, peers: ${data.count}`);
        currentRoom = data.room;
        isInitiator = data.initiator;

        roomDisplay.textContent = `Room: ${currentRoom}`;
        peerInfo.textContent = `Peers: ${data.count}`;

        // Start the WebRTC connection if we're the initiator or if there are other peers
        if (isInitiator || data.count > 1) {
            // By default, start with STUN for desktop-desktop connections
            // Use TURN for connections involving mobile devices
            const needTurn = deviceType === "mobile" || data.peerTypes?.includes("mobile");
            await setupPeerConnection(needTurn);

            if (isInitiator) {
                createDataChannel();
                createAndSendOffer();
            }
        }
    }

    // Handle updates about the room state
    async function handleRoomUpdate(data) {
        peerInfo.textContent = `Peers: ${data.count}`;

        // If we're the initiator and a peer just joined, send them an offer
        if (isInitiator && data.count > 1 && (!pc || pc.connectionState !== "connected")) {
            if (isConnectingPeer) {
                console.log("Already connecting to peer, ignoring room update");
                return;
            }

            console.log("New peer detected, sending offer");
            const needTurn = deviceType === "mobile" || data.devices?.includes("mobile");
            await setupPeerConnection(needTurn);
            createDataChannel();
            createAndSendOffer();
        }

        // If all peers left, cleanup
        if (data.count <= 1 && pc) {
            console.log("All peers left, cleaning up connection");
            cleanupPeerConnection();
        }
    }

    // Create a new WebRTC peer connection
    async function setupPeerConnection(useTurn) {
        // Clean up any existing connection
        if (pc) {
            cleanupPeerConnection();
        }

        isConnectingPeer = true;
        console.log(`Creating peer connection (using TURN: ${useTurn})`);

        try {
            // Get appropriate ICE servers
            const iceServers = await getIceServers(useTurn);

            // Create the peer connection
            pc = new RTCPeerConnection({ iceServers });

            // Set up event handlers
            pc.onicecandidate = ({ candidate }) => {
                if (candidate && ws && ws.readyState === WebSocket.OPEN) {
                    console.log("Sending ICE candidate");
                    ws.send(JSON.stringify({
                        type: "ice-candidate",
                        candidate,
                        room: currentRoom
                    }));
                }
            };

            pc.onconnectionstatechange = () => {
                console.log("Connection state:", pc.connectionState);

                if (pc.connectionState === "connected") {
                    isConnectingPeer = false;
                    status.textContent = "Peer connection established!";
                } else if (pc.connectionState === "failed") {
                    // If STUN failed, try with TURN
                    if (!useTurn && isInitiator) {
                        console.log("Connection failed, retrying with TURN");
                        setupPeerConnection(true);
                        createDataChannel();
                        createAndSendOffer();
                    }
                }
            };

            pc.oniceconnectionstatechange = () => {
                console.log("ICE state:", pc.iceConnectionState);

                if (pc.iceConnectionState === "failed" && !useTurn && isInitiator) {
                    console.log("ICE connection failed, retrying with TURN");
                    setupPeerConnection(true);
                    createDataChannel();
                    createAndSendOffer();
                }
            };

            // Handle incoming data channels if we're not the initiator
            if (!isInitiator) {
                pc.ondatachannel = (event) => {
                    console.log("Received data channel");
                    setupDataChannel(event.channel);
                };
            }
        } catch (err) {
            console.error("Error setting up peer connection:", err);
            isConnectingPeer = false;
            status.textContent = "Failed to create peer connection.";
        }
    }

    // Create and send WebRTC offer
    async function createAndSendOffer() {
        if (!pc || !ws || ws.readyState !== WebSocket.OPEN) return;

        try {
            console.log("Creating offer");
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            ws.send(JSON.stringify({
                type: "offer",
                offer: pc.localDescription,
                room: currentRoom
            }));
        } catch (err) {
            console.error("Error creating offer:", err);
        }
    }

    // Handle incoming WebRTC offer
    async function handleRemoteOffer(offer) {
        if (!pc) {
            console.log("Received offer but no peer connection exists");
            return;
        }

        try {
            console.log("Processing remote offer");
            await pc.setRemoteDescription(new RTCSessionDescription(offer));

            // Process any queued ICE candidates
            while (pendingIceCandidates.length > 0) {
                const candidate = pendingIceCandidates.shift();
                await pc.addIceCandidate(candidate);
            }

            // Create and send answer
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            ws.send(JSON.stringify({
                type: "answer",
                answer: pc.localDescription,
                room: currentRoom
            }));
        } catch (err) {
            console.error("Error handling offer:", err);
        }
    }

    // Handle incoming WebRTC answer
    async function handleRemoteAnswer(answer) {
        if (!pc) {
            console.log("Received answer but no peer connection exists");
            return;
        }

        try {
            console.log("Setting remote description from answer");
            await pc.setRemoteDescription(new RTCSessionDescription(answer));

            // Process any queued ICE candidates
            while (pendingIceCandidates.length > 0) {
                const candidate = pendingIceCandidates.shift();
                await pc.addIceCandidate(candidate);
            }
        } catch (err) {
            console.error("Error handling answer:", err);
        }
    }

    // Handle incoming ICE candidates
    async function handleRemoteIceCandidate(candidate) {
        if (!pc || !candidate || !candidate.candidate) return;

        try {
            if (pc.remoteDescription) {
                await pc.addIceCandidate(candidate);
            } else {
                console.log("Queuing ICE candidate");
                pendingIceCandidates.push(candidate);
            }
        } catch (err) {
            console.error("Error adding ICE candidate:", err);
        }
    }

    // Create a data channel for file transfer
    function createDataChannel() {
        if (!pc) return;

        try {
            console.log("Creating data channel");
            dc = pc.createDataChannel("file-transfer");
            setupDataChannel(dc);
        } catch (err) {
            console.error("Error creating data channel:", err);
        }
    }

    // Set up the data channel event handlers
    function setupDataChannel(channel) {
        dc = channel;
        dc.binaryType = "arraybuffer";

        // File transfer state
        let fileMetadata = null;
        let receivedChunks = [];
        let receivedSize = 0;
        let lastProgress = 0;

        dc.onopen = () => {
            console.log("Data channel open");
            sendBtn.disabled = false;
            status.textContent = "Connected! Ready to send files.";
        };

        dc.onclose = () => {
            console.log("Data channel closed");
            sendBtn.disabled = true;
            status.textContent = "File transfer channel closed.";
        };

        dc.onerror = (err) => {
            console.error("Data channel error:", err);
            status.textContent = "Error with file transfer.";
        };

        dc.onmessage = (event) => {
            // Handle incoming file metadata (JSON string)
            if (typeof event.data === "string") {
                try {
                    fileMetadata = JSON.parse(event.data);
                    console.log("Receiving file:", fileMetadata.name);
                    receivedChunks = [];
                    receivedSize = 0;
                    lastProgress = 0;

                    // Show progress bar
                    progressBar.style.display = "block";
                    progressBar.value = 0;
                    status.textContent = `Receiving: ${fileMetadata.name}`;
                } catch (err) {
                    console.error("Error parsing file metadata:", err);
                }
                return;
            }

            // Handle incoming file chunks (ArrayBuffer)
            if (fileMetadata) {
                receivedChunks.push(event.data);
                receivedSize += event.data.byteLength;

                // Update progress
                const progress = Math.min(100, (receivedSize / fileMetadata.size) * 100);
                if (progress >= lastProgress + PROGRESS_UPDATE_INTERVAL || receivedSize >= fileMetadata.size) {
                    progressBar.value = progress;
                    lastProgress = Math.floor(progress / PROGRESS_UPDATE_INTERVAL) * PROGRESS_UPDATE_INTERVAL;
                }

                // File transfer complete
                if (receivedSize >= fileMetadata.size) {
                    const blob = new Blob(receivedChunks, { type: fileMetadata.type || "application/octet-stream" });
                    const url = URL.createObjectURL(blob);

                    // Create download link
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = fileMetadata.name;
                    a.click();
                    URL.revokeObjectURL(url);

                    // Reset state
                    fileMetadata = null;
                    receivedChunks = [];
                    receivedSize = 0;
                    progressBar.style.display = "none";
                    status.textContent = "File received successfully!";
                }
            }
        };
    }

    // Clean up connections
    function cleanupPeerConnection() {
        if (dc) {
            dc.close();
            dc = null;
        }

        if (pc) {
            pc.close();
            pc = null;
        }

        pendingIceCandidates = [];
        isConnectingPeer = false;
        sendBtn.disabled = true;
        progressBar.style.display = "none";
        progressBar.value = 0;
    }

    // Send a file in chunks
    async function sendFile(file) {
        if (!dc || dc.readyState !== "open") {
            status.textContent = "Connection not ready.";
            return;
        }

        try {
            // Send file metadata
            const metadata = {
                name: file.name,
                type: file.type,
                size: file.size
            };

            dc.send(JSON.stringify(metadata));
            status.textContent = `Sending: ${file.name}`;
            console.log("Sending file:", metadata);

            // Setup progress tracking
            progressBar.style.display = "block";
            progressBar.value = 0;
            let lastProgress = 0;

            // Read file as ArrayBuffer
            const arrayBuffer = await file.arrayBuffer();
            let offset = 0;

            // Send file in chunks
            while (offset < file.size) {
                if (dc.bufferedAmount > MAX_BUFFERED_AMOUNT) {
                    // Wait for buffer to clear
                    await new Promise(resolve => setTimeout(resolve, 100));
                    continue;
                }

                // Send next chunk
                const chunk = arrayBuffer.slice(offset, offset + CHUNK_SIZE);
                dc.send(chunk);
                offset += chunk.byteLength;

                // Update progress
                const progress = Math.min(100, (offset / file.size) * 100);
                if (progress >= lastProgress + PROGRESS_UPDATE_INTERVAL || offset >= file.size) {
                    progressBar.value = progress;
                    lastProgress = Math.floor(progress / PROGRESS_UPDATE_INTERVAL) * PROGRESS_UPDATE_INTERVAL;
                }
            }

            status.textContent = "File sent successfully!";
            setTimeout(() => {
                progressBar.style.display = "none";
            }, 2000);

        } catch (err) {
            console.error("Error sending file:", err);
            status.textContent = "Error sending file.";
            progressBar.style.display = "none";
        }
    }

    // Join a room on the signaling server
    function joinRoom(room) {
        if (!room || !ws || ws.readyState !== WebSocket.OPEN) return;

        currentRoom = room;
        console.log(`Joining room: ${room}`);

        // Clean up any existing connections
        cleanupPeerConnection();

        // Send join request
        ws.send(JSON.stringify({
            type: "join",
            room: room,
            deviceType: deviceType
        }));

        status.textContent = `Joining room: ${room}`;
    }

    // Event Listeners
    joinRoomBtn.addEventListener("click", () => {
        const room = roomInput.value.trim();
        if (!room) {
            status.textContent = "Please enter a room name.";
            return;
        }

        joinRoom(room);
    });

    sendBtn.addEventListener("click", () => {
        const file = fileInput.files[0];
        if (!file) {
            status.textContent = "Please select a file first.";
            return;
        }

        sendFile(file);
    });

    // Allow pressing Enter in room input
    roomInput.addEventListener("keypress", (e) => {
        if (e.key === "Enter") {
            joinRoomBtn.click();
        }
    });

    // Initialize connection
    connectWebSocket();
});
