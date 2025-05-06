document.addEventListener("DOMContentLoaded", () => {
    const roomInput = document.getElementById("roomInput");
    const joinRoomBtn = document.getElementById("joinRoomBtn");
    const roomDisplay = document.getElementById("roomDisplay");
    const peerInfo = document.getElementById("peerInfo");
    const fileInput = document.getElementById("fileInput");
    const sendBtn = document.getElementById("sendBtn");
    const progressBar = document.getElementById("progressBar");
    const status = document.getElementById("status");

    let ws;
    let pc = null;
    let dc = null;
    let isInitiator = false;
    let currentRoom = "";
    const MAX_RETRIES = 5;
    let retryCount = 0;
    let pendingIceCandidates = [];
    let isReconnecting = false;
    let lastOfferTime = 0;
    const OFFER_RETRY_DELAY = 2000; // 2s delay between offers
    const CHUNK_SIZE = 131072; // 128KB chunks
    const MAX_BUFFERED_AMOUNT = 4194304; // 4MB buffer threshold
    const PROGRESS_UPDATE_INTERVAL = 5; // Update progress every 5%

    async function fetchTurnCredentials() {
        try {
            console.log("Fetching TURN credentials...");
            const response = await fetch("https://primary-tove-arsenijevicdev-4f187706.koyeb.app/get-turn-credentials", {
                method: "GET",
                headers: { "Content-Type": "application/json" }
            });
            if (!response.ok) {
                console.error(`HTTP error: ${response.status}`);
                status.textContent = "Failed to fetch TURN credentials. Please try again.";
                return null;
            }
            const data = await response.json();
            if (!data.username || !data.password || !data.uris) {
                console.error("Invalid TURN credentials received");
                status.textContent = "Failed to fetch TURN credentials. Please try again.";
                return null;
            }
            console.log("Received TURN credentials:", data);
            return {
                username: data.username,
                credential: data.password,
                urls: data.uris
            };
        } catch (err) {
            console.error("Failed to fetch TURN credentials:", err);
            status.textContent = "Failed to fetch TURN credentials. Please try again.";
            return null;
        }
    }

    function connectWebSocket() {
        if (isReconnecting) return;
        isReconnecting = true;
        status.textContent = "Connecting to signaling server...";
        console.log("Attempting WebSocket connection...");
        ws = new WebSocket("wss://primary-tove-arsenijevicdev-4f187706.koyeb.app");

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
            }, 15000); // Ping every 15s
            if (currentRoom) {
                console.log(`Re-joining room: ${currentRoom}`);
                setTimeout(() => {
                    ws.send(JSON.stringify({ type: "join", room: currentRoom }));
                }, 1000); // Delay rejoin by 1s
            }
        };

        ws.onerror = (err) => {
            console.error("WebSocket error:", err);
            status.textContent = "WebSocket error occurred.";
        };

        ws.onclose = () => {
            console.warn("WebSocket closed.");
            status.textContent = "WebSocket connection closed.";
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

                        if (!pc || pc.connectionState !== "connected") {
                            cleanupPeerConnection();
                            await createPeerConnection();
                        }

                        if (!isInitiator) {
                            console.log("Setting up DataChannel for non-initiator.");
                            pc.ondatachannel = (e) => {
                                dc = e.channel;
                                setupDataChannel(dc);
                            };
                        } else {
                            console.log("Creating DataChannel as initiator.");
                            dc = pc.createDataChannel("file");
                            setupDataChannel(dc);
                            console.log("Creating offer as initiator.");
                            const offer = await pc.createOffer();
                            await pc.setLocalDescription(offer);
                            ws.send(JSON.stringify({ type: "offer", offer, room: currentRoom }));
                            lastOfferTime = Date.now();
                        }
                        break;

                    case "offer":
                        if (!pc) await createPeerConnection();
                        console.log("Received offer, setting remote description.");
                        try {
                            if (Date.now() - lastOfferTime < OFFER_RETRY_DELAY) {
                                console.log("Ignoring rapid offer retry");
                                return;
                            }
                            await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
                            while (pendingIceCandidates.length > 0) {
                                const candidate = pendingIceCandidates.shift();
                                try {
                                    if (candidate && candidate.candidate) {
                                        await pc.addIceCandidate(candidate);
                                        console.log("Added queued ICE candidate:", candidate);
                                    }
                                } catch (err) {
                                    console.error("Failed to add queued ICE candidate:", err);
                                }
                            }
                            const answer = await pc.createAnswer();
                            await pc.setLocalDescription(answer);
                            ws.send(JSON.stringify({ type: "answer", answer, room: currentRoom }));
                            lastOfferTime = Date.now();
                        } catch (err) {
                            console.error("Failed to handle offer:", err);
                        }
                        break;

                    case "answer":
                        if (pc) {
                            console.log("Received answer, setting remote description.");
                            try {
                                await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
                                while (pendingIceCandidates.length > 0) {
                                    const candidate = pendingIceCandidates.shift();
                                    try {
                                        if (candidate && candidate.candidate) {
                                            await pc.addIceCandidate(candidate);
                                            console.log("Added queued ICE candidate:", candidate);
                                        }
                                    } catch (err) {
                                        console.error("Failed to add queued ICE candidate:", err);
                                    }
                                }
                            } catch (err) {
                                console.error("Failed to handle answer:", err);
                            }
                        }
                        break;

                    case "ice-candidate":
                        if (pc && pc.remoteDescription && data.candidate && data.candidate.candidate) {
                            try {
                                console.log("Adding ICE candidate:", data.candidate);
                                await pc.addIceCandidate(data.candidate);
                            } catch (err) {
                                console.error("Failed to add ICE candidate:", err);
                            }
                        } else {
                            if (data.candidate && data.candidate.candidate) {
                                console.log("Queuing ICE candidate:", data.candidate);
                                pendingIceCandidates.push(data.candidate);
                            } else {
                                console.log("Ignoring empty ICE candidate");
                            }
                        }
                        break;

                    case "room-update":
                        console.log(`Room update: ${data.room}, count: ${data.count}`);
                        updatePeerInfo(data.count);
                        if (isInitiator && data.count > 1 && pc && pc.connectionState !== "connected") {
                            if (Date.now() - lastOfferTime < OFFER_RETRY_DELAY) {
                                console.log("Delaying ICE restart due to recent offer");
                                return;
                            }
                            console.log("New peer joined, restarting ICE as initiator.");
                            pc.restartIce();
                            const offer = await pc.createOffer();
                            await pc.setLocalDescription(offer);
                            ws.send(JSON.stringify({ type: "offer", offer, room: currentRoom }));
                            lastOfferTime = Date.now();
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
        const turnCredentials = await fetchTurnCredentials();
        if (!turnCredentials) {
            console.error("Cannot create PeerConnection without TURN credentials.");
            status.textContent = "Failed to create peer connection.";
            return;
        }

        pc = new RTCPeerConnection({
            iceServers: [
                { urls: "stun:stun.l.google.com:19302" },
                { urls: "stun:stun1.l.google.com:3478" },
                {
                    urls: turnCredentials.urls,
                    username: turnCredentials.username,
                    credential: turnCredentials.credential
                }
            ],
            iceCandidatePoolSize: 10 // Increase for longer ICE gathering
        });

        pc.onicecandidate = ({ candidate }) => {
            if (candidate && candidate.candidate) {
                console.log("Sending ICE candidate:", candidate);
                ws.send(JSON.stringify({ type: "ice-candidate", candidate, room: currentRoom }));
            } else {
                console.log("Ignoring empty ICE candidate");
            }
        };

        pc.oniceconnectionstatechange = () => {
            console.log("ICE connection state:", pc.iceConnectionState);
            if (pc.iceConnectionState === "failed") {
                status.textContent = "ICE connection failed. Restarting...";
                console.log("ICE failed, attempting restart. Check about:webrtc for details.");
                if (isInitiator && Date.now() - lastOfferTime >= OFFER_RETRY_DELAY) {
                    pc.restartIce();
                    pc.createOffer().then(offer => {
                        pc.setLocalDescription(offer);
                        ws.send(JSON.stringify({ type: "offer", offer, room: currentRoom }));
                        lastOfferTime = Date.now();
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
            currentRoom = room;
            console.log(`Sending join request for room: ${room}`);
            ws.send(JSON.stringify({ type: "join", room }));
            status.textContent = `Joining room: ${room}`;
        } else {
            status.textContent = "WebSocket not connected. Reconnecting...";
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