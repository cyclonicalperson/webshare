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
    let isReconnecting = false;
    const CHUNK_SIZE = 131072; // 128KB chunks
    const MAX_BUFFERED_AMOUNT = 4194304; // 4MB buffer threshold
    const PROGRESS_UPDATE_INTERVAL = 5; // Update progress every 5%
    const WS_TIMEOUT = 20000; // 20s for Koyeb wakeup

    async function fetchIceServers() {
        try {
            const response = await fetch("https://primary-tove-arsenijevicdev-4f187706.koyeb.app/turn-credentials");
            if (!response.ok) {
                console.error(`HTTP error fetching ICE servers, status: ${response.status}`);
                return [
                    { urls: "stun:stun.l.google.com:19302" },
                    { urls: "stun:stun1.l.google.com:3478" }
                ];
            }
            return await response.json();
        } catch (err) {
            console.error("Failed to fetch ICE servers:", err);
            return [
                { urls: "stun:stun.l.google.com:19302" },
                { urls: "stun:stun1.l.google.com:3478" }
            ];
        }
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
                ws.send(JSON.stringify({ type: "join", room: currentRoom }));
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

        ws.onmessage = async (message) => {
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
                        updateRoomDisplay();
                        updatePeerInfo(data.count);

                        cleanupPeerConnection();
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
                        if (!pc) {
                            await createPeerConnection();
                            pc.ondatachannel = (e) => {
                                console.log("Setting up DataChannel for non-initiator.");
                                dc = e.channel;
                                setupDataChannel(dc);
                            };
                        }
                        if (pc) {
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
                        }
                        break;

                    case "answer":
                        if (pc) {
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
                        console.log(`Room update: ${data.room}, count: ${data.count}`);
                        updatePeerInfo(data.count);
                        if (isInitiator && data.count > 1 && pc && pc.connectionState !== "connected") {
                            console.log("New peer joined, restarting ICE as initiator.");
                            pc.restartIce();
                            const offer = await pc.createOffer();
                            await pc.setLocalDescription(offer);
                            ws.send(JSON.stringify({ type: "offer", offer, room: currentRoom }));
                        }
                        break;

                    default:
                        console.warn("Unknown message type:", data.type);
                }
            } catch (err) {
                console.error("Error processing WebSocket message:", err);
            }
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
        const iceServers = await fetchIceServers();
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
                status.textContent = "ICE connection failed. Restarting...";
                console.log("ICE failed, attempting restart.");
                if (isInitiator) {
                    pc.restartIce();
                    pc.createOffer().then(offer => {
                        pc.setLocalDescription(offer);
                        ws.send(JSON.stringify({ type: "offer", offer, room: currentRoom }));
                    }).catch(err => console.error("Failed to restart ICE:", err));
                }
            }
        };

        pc.onconnectionstatechange = () => {
            console.log("Connection state:", pc.connectionState);
            if (pc.connectionState === "connected") {
                status.textContent = "Peer connection established.";
            } else if (pc.connectionState === "disconnected" || pc.connectionState === "closed") {
                status.textContent = "Peer connection lost.";
                cleanupPeerConnection();
            }
        };
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
            ws.send(JSON.stringify({ type: "join", room }));
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

    connectWebSocket();
});