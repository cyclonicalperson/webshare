document.addEventListener("DOMContentLoaded", () => {
    const roomInput = document.getElementById("roomInput");
    const joinRoomBtn = document.getElementById("joinRoomBtn");
    const roomDisplay = document.getElementById("roomDisplay");
    const peerInfo = document.getElementById("peerInfo");
    const fileInput = document.getElementById("fileInput");
    const sendBtn = document.getElementById("sendBtn");
    const progressBar = document.getElementById("progressBar");
    const status = document.getElementById("status");

    let ws = null;
    let pc = null;
    let dc = null;
    let isInitiator = false;
    let currentRoom = "";
    const MAX_RETRIES = 5;
    let retryCount = 0;
    let pendingIceCandidates = [];
    let pendingOffers = []; // Queue for incoming offers
    let isReconnecting = false;
    let iceRestartCount = 0;
    const MAX_ICE_RESTARTS = 1;
    const CHUNK_SIZE = 131072; // 128KB chunks
    const MAX_BUFFERED_AMOUNT = 4194304; // 4MB buffer threshold
    const PROGRESS_UPDATE_INTERVAL = 5; // Update progress every 5%
    const WS_TIMEOUT = 20000; // 20s for Koyeb wakeup
    let usingTurn = false;
    let turnCredentials = null;
    let lastPeerCount = 0;
    let peerDeviceType = "unknown";
    let localDeviceType = "desktop";
    let isProcessingOffer = false; // Prevent multiple offer processing

    function detectDeviceType() {
        const ua = navigator.userAgent.toLowerCase();
        const isMobile = /mobile|android|iphone|ipad|tablet|ipod|blackberry|windows phone/.test(ua);
        localDeviceType = isMobile ? "mobile" : "desktop";
        console.log(`Detected device type: ${localDeviceType}`);
        return localDeviceType;
    }

    async function fetchIceServers(useTurn = false) {
        if (!useTurn) {
            console.log("Attempting STUN-only connection.");
            return [
                { urls: "stun:stun.l.google.com:19302" },
                { urls: "stun:stun1.l.google.com:3478" }
            ];
        }

        turnCredentials = null;
        try {
            console.log("Fetching ICE servers with TURN...");
            const response = await fetch("https://primary-tove-arsenijevicdev-4f187706.koyeb.app/turn-credentials");
            if (!response.ok) {
                console.error(`HTTP error fetching ICE servers, status: ${response.status}, text: ${await response.text()}`);
                return [
                    { urls: "stun:stun.l.google.com:19302" },
                    {
                        urls: "turn:openrelay.metered.ca:443",
                        username: "openrelayproject",
                        credential: "openrelayproject"
                    }
                ];
            }
            const iceServers = await response.json();
            console.log("Fetched ICE servers:", iceServers);
            const turnServer = iceServers.find(server => server.urls.includes("turn:") && server.urls.includes(":443")) ||
                iceServers.find(server => server.urls.includes("turn:"));
            const stunServer = iceServers.find(server => server.urls.includes("stun:"));
            const selectedServers = [];
            if (turnServer) selectedServers.push(turnServer);
            if (stunServer) selectedServers.push(stunServer);
            turnCredentials = selectedServers.length > 0 ? selectedServers : [
                { urls: "stun:stun.l.google.com:19302" },
                {
                    urls: "turn:openrelay.metered.ca:443",
                    username: "openrelayproject",
                    credential: "openrelayproject"
                }
            ];
            return turnCredentials;
        } catch (err) {
            console.error("Failed to fetch ICE servers:", err);
            return [
                { urls: "stun:stun.l.google.com:19302" },
                {
                    urls: "turn:openrelay.metered.ca:443",
                    username: "openrelayproject",
                    credential: "openrelayproject"
                }
            ];
        }
    }

    async function decideIceServers() {
        const useTurn = localDeviceType === "mobile" || peerDeviceType === "mobile";
        console.log(`Deciding ICE servers: local=${localDeviceType}, peer=${peerDeviceType}, useTurn=${useTurn}`);
        return await fetchIceServers(useTurn);
    }

    function connectWebSocket() {
        if (isReconnecting || ws?.readyState === WebSocket.OPEN) return;
        isReconnecting = true;
        status.textContent = "Connecting to signaling server...";
        console.log("Attempting WebSocket connection...");
        ws = new WebSocket("wss://primary-tove-arsenijevicdev-4f187706.koyeb.app");
        ws.timeout = WS_TIMEOUT;

        ws.onopen = () => {
            retryCount = 0;
            isReconnecting = false;
            status.textContent = "Connected to signaling server.";
            console.log("WebSocket connection established.");
            setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: "ping" }));
                    console.log("Sent ping");
                }
            }, 30000);
            if (currentRoom) {
                console.log(`Joining room: ${currentRoom}`);
                ws.send(JSON.stringify({ type: "join", room: currentRoom, deviceType: localDeviceType }));
            }
        };

        ws.onerror = (err) => {
            console.error("WebSocket error:", err);
            status.textContent = "WebSocket error occurred.";
        };

        ws.onclose = () => {
            console.warn("WebSocket closed.");
            status.textContent = "WebSocket connection closed.";
            cleanupPeerConnection();
            retryConnection();
        };

        ws.onmessage = (message) => {
            (async () => {
                try {
                    const data = JSON.parse(message.data);
                    console.log("Received message:", data);

                    switch (data.type) {
                        case "pong":
                            console.log("Received pong from server");
                            break;

                        case "joined":
                            console.log(`Joined room: ${data.room}, initiator: ${data.initiator}, count: ${data.count}`);
                            currentRoom = data.room;
                            isInitiator = data.initiator;
                            iceRestartCount = 0;
                            usingTurn = false;
                            lastPeerCount = data.count;
                            updateRoomDisplay();
                            updatePeerInfo(data.count);

                            await createPeerConnection();

                            if (isInitiator) {
                                console.log("Creating DataChannel as initiator.");
                                dc = pc.createDataChannel("file");
                                setupDataChannel(dc);
                                console.log("Creating offer as initiator.");
                                const offer = await pc.createOffer();
                                await pc.setLocalDescription(offer);
                                ws.send(JSON.stringify({ type: "offer", offer, room: currentRoom }));
                            }
                            break;

                        case "offer":
                            if (isProcessingOffer) {
                                console.log("Offer received while processing another offer, queuing...");
                                pendingOffers.push(data.offer);
                                break;
                            }

                            isProcessingOffer = true;
                            try {
                                if (!pc) {
                                    await createPeerConnection();
                                    pc.ondatachannel = (e) => {
                                        console.log("Setting up DataChannel for non-initiator.");
                                        dc = e.channel;
                                        setupDataChannel(dc);
                                    };
                                }
                                if (pc.signalingState !== "stable") {
                                    console.log("Rolling back signaling state to handle new offer.");
                                    await pc.setLocalDescription({ type: "rollback" });
                                }
                                console.log("Received offer, setting remote description.");
                                await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
                                while (pendingIceCandidates.length > 0) {
                                    const candidate = pendingIceCandidates.shift();
                                    try {
                                        await pc.addIceCandidate(candidate);
                                        console.log("Added queued ICE candidate:", candidate);
                                    } catch (err) {
                                        console.error("Failed to add queued ICE candidate:", err);
                                    }
                                }
                                const answer = await pc.createAnswer();
                                await pc.setLocalDescription(answer);
                                ws.send(JSON.stringify({ type: "answer", answer, room: currentRoom }));
                            } finally {
                                isProcessingOffer = false;
                                // Process the next queued offer, if any
                                if (pendingOffers.length > 0) {
                                    const nextOffer = pendingOffers.shift();
                                    ws.onmessage({ data: JSON.stringify({ type: "offer", offer: nextOffer, room: currentRoom }) });
                                }
                            }
                            break;

                        case "answer":
                            if (pc) {
                                if (pc.signalingState !== "have-local-offer") {
                                    console.warn("Cannot set remote answer, signaling state is:", pc.signalingState);
                                    break;
                                }
                                console.log("Received answer, setting remote description.");
                                await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
                                while (pendingIceCandidates.length > 0) {
                                    const candidate = pendingIceCandidates.shift();
                                    try {
                                        await pc.addIceCandidate(candidate);
                                        console.log("Added queued ICE candidate:", candidate);
                                    } catch (err) {
                                        console.error("Failed to add queued ICE candidate:", err);
                                    }
                                }
                            }
                            break;

                        case "ice-candidate":
                            if (pc && pc.remoteDescription && data.candidate.candidate) {
                                try {
                                    console.log("Adding ICE candidate:", data.candidate);
                                    await pc.addIceCandidate(data.candidate);
                                } catch (err) {
                                    console.error("Failed to add ICE candidate:", err);
                                }
                            } else {
                                console.log("Queuing ICE candidate:", data.candidate);
                                pendingIceCandidates.push(data.candidate);
                            }
                            break;

                        case "room-update":
                            console.log(`Room update: ${data.room}, count: ${data.count}, devices: ${JSON.stringify(data.devices)}`);
                            updatePeerInfo(data.count);

                            if (data.devices && data.devices.length > 0) {
                                const otherDevices = data.devices.filter(device => device !== localDeviceType);
                                peerDeviceType = otherDevices.length > 0 ? otherDevices[0] : "unknown";
                                console.log(`Updated peer device type: ${peerDeviceType}`);
                            }

                            if (isInitiator && data.count === 1 && lastPeerCount > 1) {
                                console.log("Peer disconnected, resetting initiator state.");
                                cleanupPeerConnection();
                                peerDeviceType = "unknown";
                                lastPeerCount = data.count;
                                return;
                            }

                            if (isInitiator && data.count > lastPeerCount && data.count > 1) {
                                console.log("Peer count increased, initiator sending new offer.");
                                if (pc && pc.connectionState === "connected") {
                                    console.log("Connection already established, restarting ICE.");
                                    iceRestartCount++;
                                    if (iceRestartCount <= MAX_ICE_RESTARTS) {
                                        pc.restartIce();
                                        const offer = await pc.createOffer();
                                        await pc.setLocalDescription(offer);
                                        ws.send(JSON.stringify({ type: "offer", offer, room: currentRoom }));
                                    }
                                } else {
                                    if (pc) {
                                        console.log("Cleaning up old PeerConnection before creating new one.");
                                        cleanupPeerConnection();
                                    }
                                    await createPeerConnection();
                                    dc = pc.createDataChannel("file");
                                    setupDataChannel(dc);
                                    const offer = await pc.createOffer();
                                    await pc.setLocalDescription(offer);
                                    ws.send(JSON.stringify({ type: "offer", offer, room: currentRoom }));
                                }
                            }

                            if (isInitiator && data.count > 1 && pc && pc.connectionState !== "connected" && iceRestartCount < MAX_ICE_RESTARTS) {
                                console.log(`Restarting ICE as initiator (attempt ${iceRestartCount + 1}/${MAX_ICE_RESTARTS}, usingTurn: ${usingTurn}).`);
                                iceRestartCount++;
                                pc.restartIce();
                                const offer = await pc.createOffer();
                                await pc.setLocalDescription(offer);
                                ws.send(JSON.stringify({ type: "offer", offer, room: currentRoom }));
                            } else if (iceRestartCount >= MAX_ICE_RESTARTS && !usingTurn) {
                                console.log("Max ICE restarts reached with STUN, switching to TURN and resetting PeerConnection.");
                                usingTurn = true;
                                cleanupPeerConnection();
                                await createPeerConnection();
                                if (isInitiator) {
                                    dc = pc.createDataChannel("file");
                                    setupDataChannel(dc);
                                    const offer = await pc.createOffer();
                                    await pc.setLocalDescription(offer);
                                    ws.send(JSON.stringify({ type: "offer", offer, room: currentRoom }));
                                }
                            } else if (iceRestartCount >= MAX_ICE_RESTARTS && usingTurn) {
                                console.log("Max ICE restarts reached with TURN, falling back to STUN-only for debugging.");
                                usingTurn = false;
                                cleanupPeerConnection();
                                await createPeerConnection();
                                if (isInitiator) {
                                    dc = pc.createDataChannel("file");
                                    setupDataChannel(dc);
                                    const offer = await pc.createOffer();
                                    await pc.setLocalDescription(offer);
                                    ws.send(JSON.stringify({ type: "offer", offer, room: currentRoom }));
                                }
                            }

                            lastPeerCount = data.count;
                            break;

                        default:
                            console.warn("Unknown message type:", data.type);
                    }
                } catch (err) {
                    console.error("Error processing WebSocket message:", err);
                }
            })();
        };
    }

    function retryConnection() {
        if (retryCount >= MAX_RETRIES || isReconnecting) {
            status.textContent = "Failed to connect to signaling server.";
            isReconnecting = false;
            return;
        }
        retryCount++;
        status.textContent = `Reconnecting... (Attempt ${retryCount}/${MAX_RETRIES})`;
        console.log(`Reconnecting attempt ${retryCount}/${MAX_RETRIES}`);
        setTimeout(connectWebSocket, 5000 * retryCount);
    }

    async function createPeerConnection() {
        console.log("Creating new PeerConnection.");
        const iceServers = await decideIceServers();
        pc = new RTCPeerConnection({ iceServers });

        pc.onicecandidate = ({ candidate }) => {
            if (candidate) {
                console.log("Sending ICE candidate:", candidate);
                ws.send(JSON.stringify({ type: "ice-candidate", candidate, room: currentRoom }));
            }
        };

        pc.oniceconnectionstatechange = () => {
            console.log("ICE connection state:", pc.iceConnectionState);
            if (pc.iceConnectionState === "failed") {
                (async () => {
                    status.textContent = "ICE connection failed. Attempting recovery...";
                    console.log(`ICE failed, attempting recovery (attempt ${iceRestartCount + 1}/${MAX_ICE_RESTARTS}, usingTurn: ${usingTurn}).`);
                    if (isInitiator && iceRestartCount < MAX_ICE_RESTARTS) {
                        iceRestartCount++;
                        pc.restartIce();
                        const offer = await pc.createOffer();
                        await pc.setLocalDescription(offer);
                        ws.send(JSON.stringify({ type: "offer", offer, room: currentRoom }));
                    } else if (iceRestartCount >= MAX_ICE_RESTARTS && !usingTurn) {
                        console.log("Max ICE restarts reached with STUN, switching to TURN and resetting PeerConnection.");
                        usingTurn = true;
                        cleanupPeerConnection();
                        await createPeerConnection();
                        if (isInitiator) {
                            dc = pc.createDataChannel("file");
                            setupDataChannel(dc);
                            const offer = await pc.createOffer();
                            await pc.setLocalDescription(offer);
                            ws.send(JSON.stringify({ type: "offer", offer, room: currentRoom }));
                        }
                    } else if (usingTurn && iceRestartCount >= MAX_ICE_RESTARTS) {
                        console.log("Max ICE restarts reached with TURN, falling back to STUN-only for debugging.");
                        usingTurn = false;
                        cleanupPeerConnection();
                        await createPeerConnection();
                        if (isInitiator) {
                            dc = pc.createDataChannel("file");
                            setupDataChannel(dc);
                            const offer = await pc.createOffer();
                            await pc.setLocalDescription(offer);
                            ws.send(JSON.stringify({ type: "offer", offer, room: currentRoom }));
                        }
                    }
                })();
            } else if (pc.iceConnectionState === "connected") {
                iceRestartCount = 0;
            }
        };

        pc.onconnectionstatechange = () => {
            console.log("Connection state:", pc.connectionState);
            if (pc.connectionState === "connected") {
                status.textContent = "Peer connection established.";
                iceRestartCount = 0;
            } else if (pc.connectionState === "disconnected" || pc.connectionState === "closed") {
                (async () => {
                    status.textContent = "Peer connection lost.";
                    if (isInitiator && lastPeerCount > 1) {
                        console.log("Connection lost, attempting to re-establish with new PeerConnection.");
                        cleanupPeerConnection();
                        await createPeerConnection();
                        dc = pc.createDataChannel("file");
                        setupDataChannel(dc);
                        const offer = await pc.createOffer();
                        await pc.setLocalDescription(offer);
                        ws.send(JSON.stringify({ type: "offer", offer, room: currentRoom }));
                    }
                })();
            }
        };

        if (!isInitiator) {
            pc.ondatachannel = (e) => {
                console.log("Setting up DataChannel for non-initiator.");
                dc = e.channel;
                setupDataChannel(dc);
            };
        }
    }

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
        pendingOffers = [];
        isProcessingOffer = false;
        sendBtn.disabled = true;
        progressBar.style.display = "none";
        progressBar.value = 0;
        console.log("Cleaned up PeerConnection and DataChannel.");
    }

    function setupDataChannel(channel) {
        dc = channel;
        dc.binaryType = "arraybuffer";
        let receivedMeta = null;
        let receivedChunks = [];
        let receivedSize = 0;
        let lastProgress = 0;

        dc.onopen = () => {
            console.log("DataChannel is open!");
            sendBtn.disabled = false;
            status.textContent = "Peer connected, ready to send files.";
        };

        dc.onmessage = (e) => {
            console.log("DataChannel message received:", e.data);
            if (typeof e.data === "string") {
                try {
                    receivedMeta = JSON.parse(e.data);
                    console.log("Received file metadata:", receivedMeta);
                    receivedChunks = [];
                    receivedSize = 0;
                    lastProgress = 0;
                    progressBar.style.display = "block";
                    progressBar.value = 0;
                } catch (err) {
                    console.error("Failed to parse metadata:", err);
                }
            } else if (receivedMeta) {
                receivedChunks.push(e.data);
                receivedSize += e.data.byteLength;
                const progress = (receivedSize / receivedMeta.size) * 100;
                if (progress >= lastProgress + PROGRESS_UPDATE_INTERVAL || receivedSize >= receivedMeta.size) {
                    progressBar.value = progress;
                    lastProgress = Math.floor(progress / PROGRESS_UPDATE_INTERVAL) * PROGRESS_UPDATE_INTERVAL;
                    console.log(`Received chunk, progress: ${progress.toFixed(2)}%`);
                }

                if (receivedSize >= receivedMeta.size) {
                    const blob = new Blob(receivedChunks, { type: receivedMeta.type });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = receivedMeta.name || "received_file";
                    a.click();
                    URL.revokeObjectURL(url);
                    receivedMeta = null;
                    receivedChunks = [];
                    receivedSize = 0;
                    progressBar.style.display = "none";
                    status.textContent = `File "${a.download}" received.`;
                }
            }
        };

        dc.onclose = () => {
            console.log("DataChannel closed.");
            sendBtn.disabled = true;
            progressBar.style.display = "none";
            status.textContent = "DataChannel closed.";
            if (isInitiator && lastPeerCount > 1) {
                (async () => {
                    console.log("DataChannel closed, attempting to re-establish connection.");
                    cleanupPeerConnection();
                    await createPeerConnection();
                    dc = pc.createDataChannel("file");
                    setupDataChannel(dc);
                    const offer = await pc.createOffer();
                    await pc.setLocalDescription(offer);
                    ws.send(JSON.stringify({ type: "offer", offer, room: currentRoom }));
                })();
            }
        };

        dc.onerror = (e) => {
            console.error("DataChannel error:", e);
            status.textContent = "DataChannel error occurred.";
        };
    }

    joinRoomBtn.onclick = () => {
        const room = roomInput.value.trim();
        if (!room) {
            status.textContent = "Please enter a room name.";
            return;
        }
        if (ws?.readyState === WebSocket.OPEN) {
            if (currentRoom !== room) {
                cleanupPeerConnection();
                currentRoom = room;
            }
            console.log(`Sending join request for room: ${room}`);
            ws.send(JSON.stringify({ type: "join", room, deviceType: localDeviceType }));
            status.textContent = `Joining room: ${room}`;
        } else {
            status.textContent = "WebSocket not connected. Reconnecting...";
            currentRoom = room;
            connectWebSocket();
        }
    };

    async function sendChunkedFile(file) {
        const arrayBuffer = await file.arrayBuffer();
        let offset = 0;
        let lastProgress = 0;

        while (offset < file.size) {
            while (offset < file.size && dc.bufferedAmount < MAX_BUFFERED_AMOUNT) {
                const chunk = arrayBuffer.slice(offset, offset + CHUNK_SIZE);
                dc.send(chunk);
                offset += chunk.byteLength;
                const progress = (offset / file.size) * 100;
                if (progress >= lastProgress + PROGRESS_UPDATE_INTERVAL || offset >= file.size) {
                    progressBar.value = progress;
                    lastProgress = Math.floor(progress / PROGRESS_UPDATE_INTERVAL) * PROGRESS_UPDATE_INTERVAL;
                    console.log(`Sent chunk, progress: ${progress.toFixed(2)}%`);
                }
            }

            if (offset < file.size && dc.bufferedAmount >= MAX_BUFFERED_AMOUNT) {
                console.log(`Buffer full (${dc.bufferedAmount} bytes), waiting...`);
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }
    }

    sendBtn.onclick = async () => {
        const file = fileInput.files[0];
        console.log("File selected:", file);
        console.log("DataChannel:", dc);
        console.log("DataChannel readyState:", dc?.readyState);

        if (!file) {
            status.textContent = "No file selected.";
            return;
        }
        if (!dc || dc.readyState !== "open") {
            status.textContent = "DataChannel not ready or not connected.";
            return;
        }

        try {
            status.textContent = `Sending file: ${file.name}`;
            progressBar.style.display = "block";
            progressBar.value = 0;

            const metadata = { name: file.name, type: file.type, size: file.size };
            dc.send(JSON.stringify(metadata));
            console.log("Sent metadata:", metadata);

            await sendChunkedFile(file);

            status.textContent = `File "${file.name}" sent successfully.`;
            progressBar.style.display = "none";
        } catch (err) {
            console.error("Error sending file:", err);
            status.textContent = "Failed to send file.";
            progressBar.style.display = "none";
        }
    };

    function updateRoomDisplay() {
        roomDisplay.textContent = `Room: ${currentRoom || "Not joined"}`;
    }

    function updatePeerInfo(count) {
        peerInfo.textContent = `Peers: ${count || 0}`;
    }

    detectDeviceType();
    connectWebSocket();
});