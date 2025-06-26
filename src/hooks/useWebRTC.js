import { useState, useRef, useCallback } from "react";

// --- Constants ---
const SERVER_URL = "wss://primary-tove-arsenijevicdev-4f187706.koyeb.app";
const CHUNK_SIZE = 262144;
const MAX_BUFFERED_AMOUNT = 4194304;
const PROGRESS_UPDATE_INTERVAL = 1;
const WS_TIMEOUT = 20000;
const CONNECTION_TIMEOUT = 15000;
const MAX_CONNECTION_RETRIES = 5;
const TURN_FETCH_RETRIES = 3; // Wait for ICE gathering

// --- Device detection ---
function detectDeviceType() {
    const ua = navigator.userAgent.toLowerCase();
    const isMobileUA = /mobile|android|iphone|ipad|ipod|blackberry|windows phone|tablet|kindle|silk|playbook/.test(ua);
    const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    const isSmallScreen = window.screen.width <= 768 || window.screen.height <= 768;
    return (isMobileUA || isTouchDevice || isSmallScreen) ? "mobile" : "desktop";
}

export function useWebRTC(callback, deps) {
    // --- State variables ---
    const [room, setRoom] = useState("");
    const [peers, setPeers] = useState(0);
    const [connected, setConnected] = useState(false);
    const [fileName, setFileName] = useState("");
    const [progress, setProgress] = useState(0);
    const [progressVisible, setProgressVisible] = useState(false);
    const [status, setStatus] = useState("Not connected");
    const [sending, setSending] = useState(false);

    // --- Internal variables ---
    const ws = useRef(null);
    const pc = useRef(null);
    const dc = useRef(null);
    const fileRef = useRef(null);
    const isInitiator = useRef(false);
    const currentRoom = useRef("");
    const reconnectAttempts = useRef(0);
    const pendingIceCandidates = useRef([]);
    const isConnectingPeer = useRef(false);
    const connectionRetries = useRef(0);
    const iceGatheringTimeout = useRef(null);
    const connectionTimeout = useRef(null);
    const deviceType = detectDeviceType();

    // --- Enhanced ICE servers with multiple fallbacks ---
    async function getIceServers(useTurn = false) {
        const stunServers = [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" }, // Additional STUN servers
            { urls: "stun:stun2.l.google.com:19302" },
            { urls: "stun:stun.stunprotocol.org:3478" }
        ];

        if (!useTurn) {
            console.log("Using STUN configuration:", JSON.stringify(stunServers, null, 2));
            return stunServers;
        }

        // Enhanced TURN servers with multiple providers
        const fallbackTurnServers = [
            ...stunServers,
            {
                urls: "turns:standard.relay.metered.ca:443?transport=tcp",
                username: "846538aa24ea50d97dd15a71",
                credential: "reAP96J/diZKhFyL"
            },
            {
                urls: "turn:standard.relay.metered.ca:80?transport=tcp",
                username: "846538aa24ea50d97dd15a71",
                credential: "reAP96J/diZKhFyL"
            }
        ];

        let attempt = 0;
        while (attempt <= TURN_FETCH_RETRIES) {
            try {
                console.log(`Fetching TURN servers (attempt ${attempt + 1}/${TURN_FETCH_RETRIES + 1})...`);
                const response = await fetch(`${SERVER_URL.replace("wss:", "https:")}/turn-credentials`, {
                    timeout: 5000 // Add timeout to prevent hanging
                });

                if (response.ok) {
                    const iceServers = await response.json();
                    console.log("TURN credentials response:", JSON.stringify(iceServers, null, 2));
                    const hasValidServers = iceServers && iceServers.length > 0;
                    if (!hasValidServers) {
                        console.warn("Empty or invalid TURN response, using fallback");
                        return fallbackTurnServers;
                    }
                    const combinedServers = [
                        ...stunServers,
                        ...iceServers.filter(server => server.urls && server.username && server.credential)
                    ];
                    console.log("Combined ICE servers:", JSON.stringify(combinedServers, null, 2));
                    return combinedServers.length > stunServers.length ? combinedServers : fallbackTurnServers;
                } else {
                    console.warn(`TURN fetch failed: ${response.status} ${response.statusText}`);
                    throw new Error(`HTTP ${response.status}`);
                }

            } catch (err) {
                console.error(`Error fetching TURN credentials (attempt ${attempt + 1}):`, err.message);
                attempt++;
                if (attempt > TURN_FETCH_RETRIES) {
                    console.warn("Max TURN fetch retries reached, using fallback TURN");
                    return fallbackTurnServers;
                }
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // Exponential backoff
            }
        }
        return fallbackTurnServers;
    }

    // --- Enhanced WebSocket logic ---
    const connectWebSocket = useCallback(() => {
        if (ws.current && ws.current.readyState === WebSocket.OPEN) return;

        setStatus("Connecting to signaling server...");
        console.log("Connecting to WebSocket server...");

        try {
            ws.current = new window.WebSocket(SERVER_URL);
            ws.current.timeout = WS_TIMEOUT;

            ws.current.onopen = () => {
                reconnectAttempts.current = 0;
                setStatus("Connected to signaling server.");
                console.log("WebSocket connection established");

                // Send heartbeat to keep connection alive
                const heartbeat = setInterval(() => {
                    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
                        ws.current.send(JSON.stringify({type: "ping"}));
                    } else {
                        clearInterval(heartbeat);
                    }
                }, 30000);

                if (currentRoom.current) {
                    ws.current.send(JSON.stringify({
                        type: "join",
                        room: currentRoom.current,
                        deviceType
                    }));
                }
            };

            ws.current.onclose = (event) => {
                console.log("WebSocket connection closed:", event.code, event.reason);
                setStatus("Connection to server lost. Reconnecting...");
                cleanupPeerConnection();
                attemptReconnect();
            };

            ws.current.onerror = (err) => {
                console.error("WebSocket error:", err);
                setStatus("WebSocket error occurred. Retrying...");
            };

            ws.current.onmessage = async (event) => {
                await handleWebSocketMessage(event);
            };
        } catch (err) {
            console.error("Error creating WebSocket:", err);
            setStatus("Failed to connect to server.");
            attemptReconnect();
        }
    }, deps);

    function attemptReconnect() {
        if (reconnectAttempts.current >= MAX_CONNECTION_RETRIES) {
            setStatus("Failed to reconnect after multiple attempts.");
            console.log("Max reconnect attempts reached");
            return;
        }

        reconnectAttempts.current++;
        setStatus(`Reconnecting... (${reconnectAttempts.current}/${MAX_CONNECTION_RETRIES})`);
        console.log(`Reconnect attempt ${reconnectAttempts.current}/${MAX_CONNECTION_RETRIES}`);

        // Exponential backoff for reconnection
        const delay = Math.min(CONNECTION_TIMEOUT * Math.pow(2, reconnectAttempts.current - 1), 30000);
        setTimeout(connectWebSocket, delay);
    }

    // --- WebSocket message handler ---
    async function handleWebSocketMessage(event) {
        try {
            const data = JSON.parse(event.data);
            console.log("Received:", data.type, data);

            switch (data.type) {
                case "pong":
                    console.log("Received pong");
                    break;
                case "joined":
                    await handleRoomJoined(data);
                    break;
                case "offer":
                    await handleRemoteOffer(data.offer);
                    break;
                case "answer":
                    await handleRemoteAnswer(data.answer);
                    break;
                case "ice-candidate":
                    await handleRemoteIceCandidate(data.candidate);
                    break;
                case "room-update":
                    await handleRoomUpdate(data);
                    break;
                default:
                    console.log("Unknown message type:", data.type);
            }
        } catch (err) {
            console.error("Error processing message:", err.message);
            setStatus("Error processing server message.");
        }
    }

    // --- Room join logic ---
    async function handleRoomJoined(data) {
        try {
            console.log(`Joined room: ${data.room}, initiator: ${data.initiator}, peers: ${data.count}`);
            currentRoom.current = data.room;
            isInitiator.current = data.initiator;
            setPeers(data.count);
            setStatus(`Joined room: ${data.room} (${data.count} peers)`);

            // Reset connection attempts for new room
            connectionRetries.current = 0;

            // Start WebRTC connection if there are other peers
            if (data.count > 1) {
                const needTurn = deviceType === "mobile" ||
                    (data.peerTypes && data.peerTypes.includes("mobile")) ||
                    connectionRetries.current > 1; // Use TURN after first retry

                await setupPeerConnection(needTurn);

                if (isInitiator.current) {
                    createDataChannel();
                    // Wait a bit for ICE gathering before sending offer
                    setTimeout(async () => {
                        await createAndSendOffer();
                    }, 1000);
                }
            }
        } catch (err) {
            console.error("Error handling room joined:", err.message);
            setStatus("Error joining room.");
        }
    }

    // --- Room update logic ---
    async function handleRoomUpdate(data) {
        try {
            setPeers(data.count);
            console.log(`Room update: ${data.count} peers, peer types:`, data.peerTypes);

            // If we're the initiator and a peer just joined
            if (isInitiator.current && data.count > 1) {
                // Don't start multiple connection attempts
                if (isConnectingPeer.current) {
                    console.log("Already connecting to peer, ignoring room update");
                    return;
                }

                // Check if we already have a working connection
                if (pc.current && pc.current.connectionState === "connected") {
                    console.log("Already connected to peer");
                    return;
                }

                if (connectionRetries.current >= MAX_CONNECTION_RETRIES) {
                    console.log("Max connection retries reached, stopping attempts");
                    setStatus(`Connection failed after ${MAX_CONNECTION_RETRIES} attempts`);
                    return;
                }

                console.log("New peer detected, initiating connection");
                const needTurn = deviceType === "mobile" ||
                    (data.peerTypes && data.peerTypes.includes("mobile")) ||
                    connectionRetries.current > 1;

                await setupPeerConnection(needTurn);
                createDataChannel();

                // Wait for ICE gathering before sending offer
                setTimeout(async () => {
                    await createAndSendOffer();
                }, 1000);
            }

            // Clean up if all peers left
            if (data.count <= 1 && pc.current) {
                console.log("All peers left, cleaning up connection");
                cleanupPeerConnection();
                connectionRetries.current = 0;
                setStatus("Waiting for peers...");
            }
        } catch (err) {
            console.error("Error handling room update:", err.message);
            setStatus("Error updating room state.");
        }
    }

    // --- Retry logic with progressive TURN usage ---
    async function retryConnection(useTurn) {
        if (connectionRetries.current < MAX_CONNECTION_RETRIES) {
            connectionRetries.current++;
            console.log(`Retrying connection (attempt ${connectionRetries.current}/${MAX_CONNECTION_RETRIES})`);
            setStatus(`Retrying connection (${connectionRetries.current}/${MAX_CONNECTION_RETRIES})`);

            // Progressive strategy: use TURN after first failure
            const shouldUseTurn = useTurn || connectionRetries.current > 1;

            // Wait before retry with exponential backoff
            const delay = Math.min(2000 * connectionRetries.current, 10000);
            await new Promise(resolve => setTimeout(resolve, delay));

            await setupPeerConnection(shouldUseTurn);

            if (isInitiator.current) {
                createDataChannel();
                setTimeout(async () => {
                    await createAndSendOffer();
                }, 1000);
            }
        } else {
            console.log("Max connection retries reached");
            setStatus("Connection failed. Try refreshing or check your network.");
            isConnectingPeer.current = false;
        }
    }

    // --- Peer connection setup ---
    async function setupPeerConnection(useTurn) {
        // Clean up existing connection
        if (pc.current) {
            pc.current.close();
            pc.current = null;
        }

        // Clear existing timeouts
        if (connectionTimeout.current) {
            clearTimeout(connectionTimeout.current);
        }
        if (iceGatheringTimeout.current) {
            clearTimeout(iceGatheringTimeout.current);
        }

        isConnectingPeer.current = true;
        console.log(`Creating peer connection (using TURN: ${useTurn}, attempt ${connectionRetries.current + 1}/${MAX_CONNECTION_RETRIES})`);

        try {
            const iceServers = await getIceServers(useTurn);

            // RTCPeerConnection configuration
            const config = {
                iceServers,
                iceCandidatePoolSize: 10, // Pre-gather ICE candidates
                rtcpMuxPolicy: 'require',
                bundlePolicy: 'max-bundle',
                iceTransportPolicy: useTurn ? 'relay' : 'all' // Force relay when using TURN
            };

            pc.current = new window.RTCPeerConnection(config);

            let _ICE_GATHERING_COMPLETE = false;

            // Connection timeout
            connectionTimeout.current = setTimeout(() => {
                if (pc.current && pc.current.connectionState !== "connected") {
                    console.log(`Connection timed out after ${CONNECTION_TIMEOUT / 1000}s (TURN: ${useTurn})`);
                    cleanupPeerConnection();
                    isConnectingPeer.current = false;
                    retryConnection(useTurn);
                }
            }, CONNECTION_TIMEOUT);

            // ICE candidate handling with better logging
            pc.current.onicecandidate = ({ candidate }) => {
                if (candidate) {
                    console.log("Generated ICE candidate:", candidate.candidate);
                    if (ws.current && ws.current.readyState === window.WebSocket.OPEN) {
                        ws.current.send(JSON.stringify({
                            type: "ice-candidate",
                            candidate,
                            room: currentRoom.current
                        }));
                    }
                } else {
                    console.log("ICE gathering completed");
                    _ICE_GATHERING_COMPLETE = true;
                }
            };

            // Connection state monitoring
            pc.current.onconnectionstatechange = () => {
                const state = pc.current.connectionState;
                console.log("Connection state changed:", state);

                switch (state) {
                    case "connected":
                        console.log("✅ Peer connection established successfully!");
                        isConnectingPeer.current = false;
                        connectionRetries.current = 0;
                        if (connectionTimeout.current) {
                            clearTimeout(connectionTimeout.current);
                        }
                        setStatus("Connected! Ready to transfer files.");
                        setConnected(true);
                        break;

                    case "connecting":
                        setStatus("Establishing connection...");
                        break;

                    case "failed":
                    case "disconnected":
                        console.log(`❌ Connection ${state} (TURN: ${useTurn})`);
                        if (connectionTimeout.current) {
                            clearTimeout(connectionTimeout.current);
                        }
                        cleanupPeerConnection();
                        isConnectingPeer.current = false;
                        retryConnection(useTurn);
                        break;

                    case "closed":
                        console.log("Connection closed");
                        setConnected(false);
                        setStatus("Connection closed");
                        break;
                }
            };

            // ICE connection state monitoring
            pc.current.oniceconnectionstatechange = () => {
                const state = pc.current.iceConnectionState;
                console.log("ICE connection state:", state);

                switch (state) {
                    case "checking":
                        setStatus("Checking connection...");
                        break;
                    case "connected":
                    case "completed":
                        console.log("✅ ICE connection successful");
                        break;
                    case "failed":
                        console.log("❌ ICE connection failed, add a TURN server and see about:webrtc for more details");
                        if (connectionTimeout.current) {
                            clearTimeout(connectionTimeout.current);
                        }
                        cleanupPeerConnection();
                        isConnectingPeer.current = false;
                        retryConnection(true); // Force TURN on ICE failure
                        break;
                    case "disconnected":
                        console.log("ICE connection disconnected");
                        setStatus("Connection lost, attempting to reconnect...");
                        break;
                }
            };

            // ICE gathering state monitoring
            pc.current.onicegatheringstatechange = () => {
                console.log("ICE gathering state:", pc.current.iceGatheringState);
                if (pc.current.iceGatheringState === "complete") {
                    _ICE_GATHERING_COMPLETE = true;
                }
            };

            // Handle incoming data channels for non-initiators
            if (!isInitiator.current) {
                pc.current.ondatachannel = (event) => {
                    console.log("📨 Received data channel");
                    setupDataChannel(event.channel);
                };
            }

        } catch (err) {
            console.error("Error setting up peer connection:", err.message);
            isConnectingPeer.current = false;
            await retryConnection(useTurn);
        }
    }

    // --- Offer creation with ICE gathering wait ---
    async function createAndSendOffer() {
        if (!pc.current || !ws.current || ws.current.readyState !== window.WebSocket.OPEN) {
            console.log("Cannot create offer: peer connection or websocket not ready");
            return;
        }

        try {
            console.log("Creating offer...");
            const offer = await pc.current.createOffer({
                offerToReceiveAudio: false,
                offerToReceiveVideo: false
            });

            await pc.current.setLocalDescription(offer);
            console.log("Local description set, waiting for ICE candidates...");

            // Wait a bit for ICE candidates to be gathered
            setTimeout(() => {
                if (ws.current && ws.current.readyState === window.WebSocket.OPEN) {
                    ws.current.send(JSON.stringify({
                        type: "offer",
                        offer: pc.current.localDescription,
                        room: currentRoom.current
                    }));
                    console.log("📤 Sent offer:", pc.current.localDescription);
                }
            }, 2000);

        } catch (err) {
            console.error("Error creating offer:", err.message);
            setStatus("Error creating offer.");
            await retryConnection(false);
        }
    }

    // --- Remote offer handling ---
    async function handleRemoteOffer(offer) {
        if (!pc.current) {
            console.log("⚠️ Received offer but no peer connection exists");
            // Try to create peer connection for this offer
            const needTurn = deviceType === "mobile" || connectionRetries.current > 0;
            await setupPeerConnection(needTurn);
            if (!pc.current) return;
        }

        try {
            console.log("📥 Processing remote offer:", offer);
            await pc.current.setRemoteDescription(new window.RTCSessionDescription(offer));

            // Process any queued ICE candidates
            console.log(`Processing ${pendingIceCandidates.current.length} queued ICE candidates`);
            while (pendingIceCandidates.current.length > 0) {
                const candidate = pendingIceCandidates.current.shift();
                try {
                    await pc.current.addIceCandidate(candidate);
                } catch (err) {
                    console.warn("Failed to add queued ICE candidate:", err.message);
                }
            }

            // Create and send answer
            const answer = await pc.current.createAnswer();
            await pc.current.setLocalDescription(answer);

            // Wait for some ICE candidates before sending answer
            setTimeout(() => {
                if (ws.current && ws.current.readyState === window.WebSocket.OPEN) {
                    ws.current.send(JSON.stringify({
                        type: "answer",
                        answer: pc.current.localDescription,
                        room: currentRoom.current
                    }));
                    console.log("📤 Sent answer:", pc.current.localDescription);
                }
            }, 1000);

        } catch (err) {
            console.error("Error handling offer:", err.message);
            setStatus("Error processing offer.");
            await retryConnection(false);
        }
    }

    // --- Remote answer handling ---
    async function handleRemoteAnswer(answer) {
        if (!pc.current) {
            console.log("⚠️ Received answer but no peer connection exists");
            return;
        }

        try {
            console.log("📥 Processing remote answer:", answer);
            await pc.current.setRemoteDescription(new window.RTCSessionDescription(answer));

            // Process any queued ICE candidates
            console.log(`Processing ${pendingIceCandidates.current.length} queued ICE candidates`);
            while (pendingIceCandidates.current.length > 0) {
                const candidate = pendingIceCandidates.current.shift();
                try {
                    await pc.current.addIceCandidate(candidate);
                } catch (err) {
                    console.warn("Failed to add queued ICE candidate:", err.message);
                }
            }
        } catch (err) {
            console.error("Error handling answer:", err.message);
            setStatus("Error processing answer.");
        }
    }

    // --- ICE candidate handling ---
    async function handleRemoteIceCandidate(candidate) {
        if (!candidate || !candidate.candidate) {
            console.log("Received empty ICE candidate (end-of-candidates)");
            return;
        }

        try {
            console.log("📥 Received ICE candidate:", candidate.candidate);

            if (pc.current && pc.current.remoteDescription) {
                await pc.current.addIceCandidate(candidate);
                console.log("✅ Added ICE candidate");
            } else {
                console.log("🔄 Queuing ICE candidate (no remote description yet)");
                pendingIceCandidates.current.push(candidate);
            }
        } catch (err) {
            console.error("❌ Error adding ICE candidate:", err.message);
            // Don't fail the entire connection for one bad candidate
        }
    }

    // --- Data channel creation ---
    function createDataChannel() {
        if (!pc.current) {
            console.log("Cannot create data channel: no peer connection");
            return;
        }

        try {
            console.log("Creating data channel...");
            dc.current = pc.current.createDataChannel("file-transfer", {
                ordered: true,
                maxRetransmits: 3
            });
            setupDataChannel(dc.current);
        } catch (err) {
            console.error("Error creating data channel:", err.message);
            setStatus("Error creating data channel.");
        }
    }

    // --- Data channel setup ---
    function setupDataChannel(channel) {
        dc.current = channel;
        dc.current.binaryType = "arraybuffer";
        let fileMetadata = null;
        let receivedChunks = [];
        let receivedSize = 0;
        let lastProgress = 0;

        dc.current.onopen = () => {
            console.log("📡 Data channel opened");
            setStatus("Connected! Ready to send files.");
            setConnected(true);
        };

        dc.current.onclose = () => {
            console.log("📪 Data channel closed");
            setStatus("File transfer channel closed.");
            setConnected(false);
        };

        dc.current.onerror = (err) => {
            console.error("Data channel error:", err);
            setStatus("Error with file transfer.");
        };

        dc.current.onmessage = (event) => {
            if (typeof event.data === "string") {
                try {
                    fileMetadata = JSON.parse(event.data);
                    console.log("📋 Receiving file:", fileMetadata.name);
                    receivedChunks = [];
                    receivedSize = 0;
                    lastProgress = 0;
                    setProgressVisible(true);
                    setProgress(0);
                    setStatus(`Receiving: ${fileMetadata.name}`);
                } catch (err) {
                    console.error("Error parsing file metadata:", err.message);
                    setStatus("Error parsing file metadata.");
                }
                return;
            }

            if (fileMetadata) {
                receivedChunks.push(event.data);
                receivedSize += event.data.byteLength;
                const prog = Math.min(100, (receivedSize / fileMetadata.size) * 100);

                if (prog >= lastProgress + PROGRESS_UPDATE_INTERVAL || receivedSize >= fileMetadata.size) {
                    setProgress(prog);
                    lastProgress = Math.floor(prog / PROGRESS_UPDATE_INTERVAL) * PROGRESS_UPDATE_INTERVAL;
                }

                if (receivedSize >= fileMetadata.size) {
                    setProgress(100);
                    setProgressVisible(false);
                    setStatus(`✅ Received: ${fileMetadata.name}`);

                    // Download file
                    const blob = new Blob(receivedChunks);
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = fileMetadata.name;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                }
            }
        };
    }

    // --- Enhanced cleanup ---
    function cleanupPeerConnection() {
        console.log("🧹 Cleaning up peer connection");

        setConnected(false);
        setProgressVisible(false);
        setProgress(0);
        setSending(false);

        // Clear timeouts
        if (connectionTimeout.current) {
            clearTimeout(connectionTimeout.current);
            connectionTimeout.current = null;
        }
        if (iceGatheringTimeout.current) {
            clearTimeout(iceGatheringTimeout.current);
            iceGatheringTimeout.current = null;
        }

        // Close data channel
        if (dc.current) {
            dc.current.close();
            dc.current = null;
        }

        // Close peer connection
        if (pc.current) {
            pc.current.close();
            pc.current = null;
        }

        // Clear pending ICE candidates
        pendingIceCandidates.current = [];
        isConnectingPeer.current = false;
    }

    // --- Public API for UI ---
    const joinRoom = useCallback((roomName) => {
        setRoom(roomName);
        currentRoom.current = roomName;
        setStatus("Joining room...");
        if (!ws.current || ws.current.readyState !== window.WebSocket.OPEN) {
            connectWebSocket();
            setTimeout(() => {
                if (ws.current && ws.current.readyState === window.WebSocket.OPEN) {
                    ws.current.send(JSON.stringify({ type: "join", room: roomName, deviceType }));
                }
            }, 1000);
        } else {
            ws.current.send(JSON.stringify({ type: "join", room: roomName, deviceType }));
        }
    }, [deviceType, connectWebSocket]);

    const selectFile = useCallback((file) => {
        fileRef.current = file;
        setFileName(file ? file.name : "");
    }, []);

    const sendFile = useCallback(() => {
        if (!fileRef.current || !dc.current || dc.current.readyState !== "open") return;
        setSending(true);
        setProgressVisible(true);
        setStatus(`Sending: ${fileRef.current.name}`);
        setProgress(0);

        // Send metadata
        dc.current.send(JSON.stringify({
            name: fileRef.current.name,
            size: fileRef.current.size,
            type: fileRef.current.type
        }));

        // Send file in chunks
        const file = fileRef.current;
        let offset = 0;
        let lastProgress = 0;

        function sendChunk() {
            if (!dc.current || dc.current.readyState !== "open") {
                setStatus("Data channel closed.");
                setSending(false);
                setProgressVisible(false);
                return;
            }
            const slice = file.slice(offset, offset + CHUNK_SIZE);
            const reader = new FileReader();
            reader.onload = (e) => {
                if (e.target.error) {
                    setStatus("Error reading file.");
                    setSending(false);
                    setProgressVisible(false);
                    return;
                }
                dc.current.send(e.target.result);
                offset += CHUNK_SIZE;
                const prog = Math.min(100, (offset / file.size) * 100);
                if (prog >= lastProgress + PROGRESS_UPDATE_INTERVAL || offset >= file.size) {
                    setProgress(prog);
                    lastProgress = Math.floor(prog / PROGRESS_UPDATE_INTERVAL) * PROGRESS_UPDATE_INTERVAL;
                }
                if (offset < file.size) {
                    if (dc.current.bufferedAmount < MAX_BUFFERED_AMOUNT) {
                        sendChunk();
                    } else {
                        setTimeout(sendChunk, 100);
                    }
                } else {
                    setProgress(100);
                    setStatus("File sent!");
                    setSending(false);
                    setProgressVisible(false);
                }
            };
            reader.readAsArrayBuffer(slice);
        }
        sendChunk();
    }, []);

    // --- Return API for React UI ---
    return {
        room, setRoom,
        peers,
        connected,
        joinRoom,
        fileName, setFileName,
        selectFile,
        sendFile,
        progress,
        progressVisible,
        status,
        sending
    };
}
