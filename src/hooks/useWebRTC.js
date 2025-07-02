import { useState, useRef, useCallback } from "react";

// --- Constants ---
const SERVER_URL = "wss://primary-tove-arsenijevicdev-4f187706.koyeb.app";
const BASE_CHUNK_SIZE = 32768;
const FALLBACK_CHUNK_SIZE = 8192;
const PROGRESS_UPDATE_INTERVAL = 1;
const WS_TIMEOUT = 20000;
const CONNECTION_TIMEOUT = 8000;
const MAX_CONNECTION_RETRIES = 5;
const TURN_FETCH_RETRIES = 3;
const BUFFER_THRESHOLD = 393216;
const BUFFER_POLL_INTERVAL = 50;

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
    const sendQueue = useRef([]);
    const isSending = useRef(false);
    const transferTimeout = useRef(null);

    // --- ICE servers ---
    async function getIceServers(useTurn = false) {
        const stunServers = [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" },
            { urls: "stun:stun2.l.google.com:19302" },
            { urls: "stun:stun.stunprotocol.org:3478" }
        ];

        if (!useTurn) return stunServers;

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
                const response = await fetch(`${SERVER_URL.replace("wss:", "https:")}/turn-credentials`);
                if (response.ok) {
                    const iceServers = await response.json();
                    const combinedServers = [...stunServers, ...iceServers.filter(server => server.urls && server.username && server.credential)];
                    return combinedServers.length > stunServers.length ? combinedServers : fallbackTurnServers;
                } else {
                    console.warn(`TURN fetch failed: ${response.status} ${response.statusText}`);
                    return fallbackTurnServers;
                }
            } catch (error) {
                console.error(`Error fetching TURN credentials (attempt ${attempt + 1}):`, error.message);
                attempt++;
                if (attempt > TURN_FETCH_RETRIES) return fallbackTurnServers;
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            }
        }
        return fallbackTurnServers;
    }

    // --- WebSocket logic ---
    const connectWebSocket = useCallback(() => {
        if (ws.current && ws.current.readyState === WebSocket.OPEN) return;

        setStatus("Connecting to signaling server...");
        try {
            ws.current = new window.WebSocket(SERVER_URL);
            ws.current.timeout = WS_TIMEOUT;

            ws.current.onopen = () => {
                reconnectAttempts.current = 0;
                setStatus("Connected to signaling server.");
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

            ws.current.onclose = () => {
                setStatus("Connection to server lost. Reconnecting...");
                cleanupPeerConnection();
                attemptReconnect();
            };

            ws.current.onerror = () => {
                setStatus("WebSocket error occurred. Retrying...");
            };

            ws.current.onmessage = async (event) => {
                await handleWebSocketMessage(event);
            };
        } catch (error) {
            console.error("Error creating WebSocket:", error.message);
            setStatus("Failed to connect to server.");
            attemptReconnect();
        }
    }, [deps, attemptReconnect, deviceType, handleWebSocketMessage]);

    function attemptReconnect() {
        if (reconnectAttempts.current >= MAX_CONNECTION_RETRIES) {
            setStatus("Failed to reconnect after multiple attempts.");
            return;
        }

        reconnectAttempts.current++;
        setStatus(`Reconnecting... (${reconnectAttempts.current}/${MAX_CONNECTION_RETRIES})`);
        const delay = Math.min(CONNECTION_TIMEOUT * Math.pow(2, reconnectAttempts.current - 1), 30000);
        setTimeout(connectWebSocket, delay);
    }

    // --- WebSocket message handler ---
    async function handleWebSocketMessage(event) {
        try {
            const data = JSON.parse(event.data);
            switch (data.type) {
                case "pong":
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
                case "transfer-complete":
                    handleTransferComplete();
                    break;
                default:
                    console.log("Unknown message type:", data.type);
            }
        } catch (error) {
            console.error("Error processing message:", error.message);
            setStatus("Error processing server message.");
        }
    }

    // --- Successful file transfer handler ---
    function handleTransferComplete() {
        if (isSending.current) {
            setProgress(100);
            setStatus("File sent successfully!");
            setTimeout(() => {
                setProgressVisible(false);
                setProgress(0);
                setStatus("Connected! Ready to send files.");
                setSending(false);
                setFileName("");
                fileRef.current = null;
                isSending.current = false;
                sendQueue.current = [];
                if (transferTimeout.current) {
                    clearTimeout(transferTimeout.current);
                    transferTimeout.current = null;
                }
            }, 500);
        }
    }

    async function handleRoomJoined(data) {
        try {
            currentRoom.current = data.room;
            isInitiator.current = data.initiator;
            setPeers(data.count);
            setStatus(`Joined room: ${data.room} (${data.count} peers)`);
            connectionRetries.current = 0;

            if (data.count > 1) {
                const needTurn = deviceType === "mobile" || (data.peerTypes && data.peerTypes.includes("mobile")) || connectionRetries.current > 1;
                await setupPeerConnection(needTurn);

                if (isInitiator.current) {
                    createDataChannel();
                    setTimeout(async () => {
                        await createAndSendOffer();
                    }, 1000);
                }
            }
        } catch (error) {
            console.error("Error handling room joined:", error.message);
            setStatus("Error joining room.");
        }
    }

    // --- Room update logic ---
    async function handleRoomUpdate(data) {
        try {
            setPeers(data.count);
            if (data.count > 1) {
                if (pc.current && pc.current.connectionState === "connected") return;

                if (connectionRetries.current >= MAX_CONNECTION_RETRIES) {
                    setStatus(`Connection failed after ${MAX_CONNECTION_RETRIES} attempts`);
                    return;
                }

                if (isInitiator.current) {
                    isConnectingPeer.current = false; // Reset to allow new connection
                    cleanupPeerConnection(); // Ensure clean state
                    const needTurn = deviceType === "mobile" || (data.peerTypes && data.peerTypes.includes("mobile")) || connectionRetries.current > 1;
                    await setupPeerConnection(needTurn);
                    createDataChannel();
                    setStatus("Initiating connection...");
                    setTimeout(async () => {
                        await createAndSendOffer();
                    }, 1000);
                } else {
                    setStatus("Waiting for initiator to connect...");
                }
            } else {
                cleanupPeerConnection();
                connectionRetries.current = 0;
                setStatus("Detecting peers...");
            }
        } catch {
            setStatus("Error updating room state.");
        }
    }

    // --- Retry logic ---
    async function retryConnection(useTurn) {
        if (connectionRetries.current < MAX_CONNECTION_RETRIES) {
            connectionRetries.current++;
            setStatus(`Retrying connection (${connectionRetries.current}/${MAX_CONNECTION_RETRIES})`);
            const delay = Math.min(2000 * connectionRetries.current, 10000);
            await new Promise(resolve => setTimeout(resolve, delay));

            await setupPeerConnection(useTurn || connectionRetries.current > 1);
            if (isInitiator.current) {
                createDataChannel();
                setTimeout(async () => {
                    await createAndSendOffer();
                }, 1000);
            }
        } else {
            setStatus("Connection failed. Try refreshing or check your network.");
            isConnectingPeer.current = false;
        }
    }

    // --- Peer connection setup ---
    async function setupPeerConnection(useTurn) {
        cleanupPeerConnection();
        isConnectingPeer.current = true;

        try {
            const iceServers = await getIceServers(useTurn);
            const config = {
                iceServers,
                iceCandidatePoolSize: 10,
                rtcpMuxPolicy: 'require',
                bundlePolicy: 'max-bundle',
                iceTransportPolicy: useTurn ? 'relay' : 'all'
            };

            pc.current = new window.RTCPeerConnection(config);

            connectionTimeout.current = setTimeout(() => {
                if (pc.current && pc.current.connectionState !== "connected") {
                    cleanupPeerConnection();
                    isConnectingPeer.current = false;
                    retryConnection(useTurn);
                }
            }, CONNECTION_TIMEOUT);

            pc.current.onicecandidate = ({ candidate }) => {
                if (candidate && ws.current && ws.current.readyState === window.WebSocket.OPEN) {
                    ws.current.send(JSON.stringify({
                        type: "ice-candidate",
                        candidate,
                        room: currentRoom.current
                    }));
                }
            };

            pc.current.onconnectionstatechange = () => {
                const state = pc.current.connectionState;
                switch (state) {
                    case "connected":
                        isConnectingPeer.current = false;
                        connectionRetries.current = 0;
                        if (connectionTimeout.current) clearTimeout(connectionTimeout.current);
                        setStatus("Connected! Ready to transfer files.");
                        setConnected(true);
                        break;
                    case "connecting":
                        setStatus("Establishing connection...");
                        break;
                    case "failed":
                    case "disconnected":
                        if (connectionTimeout.current) clearTimeout(connectionTimeout.current);
                        cleanupPeerConnection();
                        isConnectingPeer.current = false;
                        retryConnection(useTurn);
                        break;
                    case "closed":
                        setConnected(false);
                        setStatus("Connection closed");
                        break;
                }
            };

            pc.current.oniceconnectionstatechange = () => {
                const state = pc.current.iceConnectionState;
                switch (state) {
                    case "checking":
                        setStatus("Checking connection...");
                        break;
                    case "connected":
                    case "completed":
                        break;
                    case "failed":
                        if (connectionTimeout.current) clearTimeout(connectionTimeout.current);
                        cleanupPeerConnection();
                        isConnectingPeer.current = false;
                        retryConnection(true);
                        break;
                    case "disconnected":
                        setStatus("Connection lost, attempting to reconnect...");
                        break;
                }
            };

            if (!isInitiator.current) {
                pc.current.ondatachannel = (event) => {
                    setupDataChannel(event.channel);
                };
            }
        } catch (error) {
            console.error("Error setting up peer connection:", error.message);
            isConnectingPeer.current = false;
            await retryConnection(useTurn);
        }
    }

    // --- Offer creation ---
    async function createAndSendOffer() {
        if (!pc.current || !ws.current || ws.current.readyState !== window.WebSocket.OPEN) return;

        try {
            const offer = await pc.current.createOffer({
                offerToReceiveAudio: false,
                offerToReceiveVideo: false
            });
            await pc.current.setLocalDescription(offer);
            setTimeout(() => {
                if (ws.current && ws.current.readyState === window.WebSocket.OPEN) {
                    ws.current.send(JSON.stringify({
                        type: "offer",
                        offer: pc.current.localDescription,
                        room: currentRoom.current
                    }));
                }
            }, 2000);
        } catch (error) {
            console.error("Error creating offer:", error.message);
            setStatus("Error creating offer.");
            await retryConnection(false);
        }
    }

    // --- Remote offer handling ---
    async function handleRemoteOffer(offer) {
        if (!pc.current) {
            const needTurn = deviceType === "mobile" || connectionRetries.current > 0;
            await setupPeerConnection(needTurn);
            if (!pc.current) return;
        }

        try {
            await pc.current.setRemoteDescription(new window.RTCSessionDescription(offer));
            while (pendingIceCandidates.current.length > 0) {
                const candidate = pendingIceCandidates.current.shift();
                try {
                    await pc.current.addIceCandidate(candidate);
                } catch (error) {
                    console.warn("Failed to add queued ICE candidate:", error.message);
                }
            }

            const answer = await pc.current.createAnswer();
            await pc.current.setLocalDescription(answer);
            setTimeout(() => {
                if (ws.current && ws.current.readyState === window.WebSocket.OPEN) {
                    ws.current.send(JSON.stringify({
                        type: "answer",
                        answer: pc.current.localDescription,
                        room: currentRoom.current
                    }));
                }
            }, 1000);
        } catch (error) {
            console.error("Error handling offer:", error.message);
            setStatus("Error processing offer.");
            await retryConnection(false);
        }
    }

    // --- Remote answer handling ---
    async function handleRemoteAnswer(answer) {
        if (!pc.current) return;

        try {
            if (pc.current.signalingState === "stable") return;
            await pc.current.setRemoteDescription(new window.RTCSessionDescription(answer));
            while (pendingIceCandidates.current.length > 0) {
                const candidate = pendingIceCandidates.current.shift();
                try {
                    await pc.current.addIceCandidate(candidate);
                } catch (error) {
                    console.warn("Failed to add queued ICE candidate:", error.message);
                }
            }
        } catch (error) {
            console.error("Error handling answer:", error.message);
            setStatus("Error processing answer.");
            if (error.message.includes("Cannot set remote answer")) {
                cleanupPeerConnection();
                await retryConnection(false);
            }
        }
    }

    // --- ICE candidate handling ---
    async function handleRemoteIceCandidate(candidate) {
        if (!candidate || !candidate.candidate) return;

        try {
            if (pc.current && pc.current.remoteDescription) {
                await pc.current.addIceCandidate(candidate);
            } else {
                pendingIceCandidates.current.push(candidate);
            }
        } catch (error) {
            console.error("Error adding ICE candidate:", error.message);
        }
    }

    // --- Data channel creation ---
    function createDataChannel() {
        if (!pc.current) return;

        try {
            dc.current = pc.current.createDataChannel("file-transfer", {
                ordered: true,
                maxRetransmits: 5
            });
            setupDataChannel(dc.current);
        } catch (error) {
            console.error("Error creating data channel:", error.message);
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
            setStatus("Connected! Ready to send files.");
            setConnected(true);
        };

        dc.current.onclose = () => {
            if (!isConnectingPeer.current) {
                setStatus("File transfer channel closed.");
                setConnected(false);
            }
        };

        dc.current.onerror = () => {
            setStatus("Error with file transfer.");
            setConnected(false);
        };

        dc.current.onmessage = (event) => {
            if (typeof event.data === "string") {
                try {
                    fileMetadata = JSON.parse(event.data);
                    receivedChunks = [];
                    receivedSize = 0;
                    lastProgress = 0;
                    setProgressVisible(true);
                    setProgress(0);
                    setStatus(`Receiving: ${fileMetadata.name}`);
                } catch {
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
                    setStatus(`Received: ${fileMetadata.name}`);
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

    // --- Cleanup ---
    function cleanupPeerConnection() {
        setConnected(false);
        setProgressVisible(false);
        setProgress(0);
        setSending(false);
        isSending.current = false;
        sendQueue.current = [];
        isConnectingPeer.current = false;

        if (connectionTimeout.current) {
            clearTimeout(connectionTimeout.current);
            connectionTimeout.current = null;
        }
        if (iceGatheringTimeout.current) {
            clearTimeout(iceGatheringTimeout.current);
            iceGatheringTimeout.current = null;
        }
        if (dc.current) {
            dc.current.close();
            dc.current = null;
        }
        if (pc.current) {
            pc.current.close();
            pc.current = null;
        }
        pendingIceCandidates.current = [];
    }

    // --- Public API ---
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

    const sendFile = useCallback(async () => {
        if (!fileRef.current) {
            setStatus("No file selected. Please select a file.");
            return;
        }
        if (!dc.current || dc.current.readyState !== "open") {
            setStatus("No active data channel. Please connect to a peer.");
            return;
        }
        if (!pc.current || pc.current.connectionState !== "connected") {
            setStatus("Peer connection not active. Please reconnect.");
            return;
        }
        if (isSending.current) {
            setStatus("Already sending a file. Please wait.");
            return;
        }

        try {
            setSending(true);
            setProgressVisible(true);
            setStatus(`Sending: ${fileRef.current.name}`);
            setProgress(0);
            isSending.current = true;

            const chunkSize = (deviceType === "mobile" || connectionRetries.current > 1) ? FALLBACK_CHUNK_SIZE : BASE_CHUNK_SIZE;

            const file = fileRef.current;
            const metadata = {
                name: file.name,
                size: file.size,
                type: file.type
            };
            dc.current.send(JSON.stringify(metadata));

            let offset = 0;
            let lastProgress = 0;

            while (offset < file.size) {
                const slice = file.slice(offset, offset + chunkSize);
                sendQueue.current.push(slice);
                offset += chunkSize;
            }

            async function processQueue() {
                while (sendQueue.current.length > 0) {
                    if (!dc.current || dc.current.readyState !== "open" || !pc.current || pc.current.connectionState !== "connected") {
                        setStatus("Connection lost during send");
                        cleanupPeerConnection();
                        return;
                    }

                    while (dc.current && dc.current.bufferedAmount > BUFFER_THRESHOLD) {
                        await new Promise(resolve => setTimeout(resolve, BUFFER_POLL_INTERVAL));
                        if (!dc.current || dc.current.readyState !== "open") {
                            setStatus("Data channel closed during buffer wait");
                            cleanupPeerConnection();
                            return;
                        }
                    }

                    const slice = sendQueue.current.shift();
                    const reader = new FileReader();

                    await new Promise((resolve, reject) => {
                        reader.onload = (e) => {
                            if (e.target.error || !e.target.result || e.target.result.byteLength === 0) {
                                setStatus("FileReader error or empty result");
                                cleanupPeerConnection();
                                return reject();
                            }
                            try {
                                if (!dc.current || dc.current.readyState !== "open") {
                                    setStatus("Data channel closed before sending chunk");
                                    cleanupPeerConnection();
                                    return reject();
                                }
                                dc.current.send(e.target.result);
                                const sentBytes = offset - (sendQueue.current.length * chunkSize);
                                const prog = Math.min(100, Math.round((sentBytes / file.size) * 100));
                                if (prog >= lastProgress + PROGRESS_UPDATE_INTERVAL || sentBytes >= file.size) {
                                    setProgress(prog);
                                    lastProgress = Math.floor(prog / PROGRESS_UPDATE_INTERVAL) * PROGRESS_UPDATE_INTERVAL;
                                }
                                resolve();
                            } catch {
                                setStatus("Error sending file chunk");
                                cleanupPeerConnection();
                                reject();
                            }
                        };
                        reader.onerror = () => {
                            setStatus("FileReader error");
                            cleanupPeerConnection();
                            reject();
                        };
                        reader.readAsArrayBuffer(slice);
                    });
                }

                setProgress(100);
                setStatus("File sent successfully!");
                setTimeout(() => {
                    setProgressVisible(false);
                    setProgress(0);
                    setStatus("Connected! Ready to send files.");
                    setSending(false);
                    setFileName("");
                    fileRef.current = null;
                    isSending.current = false;
                }, 2000);
            }

            await processQueue();
        } catch {
            setStatus("Error initiating file send");
            cleanupPeerConnection();
        }
    }, [deviceType]);

    return {
        room,
        setRoom,
        peers,
        connected,
        joinRoom,
        fileName,
        setFileName,
        selectFile,
        sendFile,
        progress,
        progressVisible,
        status,
        sending
    };
}