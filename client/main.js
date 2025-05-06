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
    let isReconnecting = false; // Prevent multiple simultaneous reconnections

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
            // Re-join the room if previously in one
            if (currentRoom) {
                console.log(`Re-joining room: ${currentRoom}`);
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
            retryConnection();
        };

        ws.onmessage = async (message) => {
            try {
                const data = JSON.parse(message.data);
                console.log("Received message:", data);

                switch (data.type) {
                    case "joined":
                        console.log(`Joined room: ${data.room}, initiator: ${data.initiator}, count: ${data.count}`);
                        currentRoom = data.room;
                        isInitiator = data.initiator;
                        updateRoomDisplay();
                        updatePeerInfo(data.count);

                        // Only reset PeerConnection if not already connected
                        if (!pc || pc.connectionState !== "connected") {
                            cleanupPeerConnection();
                            createPeerConnection();
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
                        }
                        break;

                    case "offer":
                        if (!pc) createPeerConnection();
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
                        if (pc && pc.remoteDescription) {
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
                        if (isInitiator && data.count > 1 && pc) {
                            console.log("New peer joined, re-sending offer as initiator.");
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
        setTimeout(connectWebSocket, 2000 * retryCount); // Exponential backoff
    }

    function createPeerConnection() {
        console.log("Creating new PeerConnection.");
        pc = new RTCPeerConnection({
            iceServers: [
                { urls: "stun:stun.l.google.com:19302" },
                { urls: "stun:stun1.l.google.com:19302" }
            ]
        });

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
                cleanupPeerConnection();
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: "join", room: currentRoom }));
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
        console.log("Cleaned up PeerConnection and DataChannel.");
    }

    function setupDataChannel(channel) {
        dc = channel;
        dc.binaryType = "arraybuffer";
        let receivedMeta = null;

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
                } catch (err) {
                    console.error("Failed to parse metadata:", err);
                }
            } else if (receivedMeta) {
                const blob = new Blob([e.data], { type: receivedMeta.type });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = receivedMeta.name || "received_file";
                a.click();
                URL.revokeObjectURL(url);
                receivedMeta = null;
                status.textContent = `File "${a.download}" received.`;
            }
        };

        dc.onclose = () => {
            console.log("DataChannel closed.");
            sendBtn.disabled = true;
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
            dc.send(JSON.stringify({ name: file.name, type: file.type }));

            const arrayBuffer = await file.arrayBuffer();
            dc.send(arrayBuffer);
            status.textContent = `File "${file.name}" sent successfully.`;
        } catch (err) {
            console.error("Error sending file:", err);
            status.textContent = "Failed to send file.";
        }
    };

    function updateRoomDisplay() {
        roomDisplay.textContent = `Room: ${currentRoom || "Not joined"}`;
    }

    function updatePeerInfo(count) {
        peerInfo.textContent = `Peers: ${count || 0}`;
    }

    // Initialize WebSocket connection
    connectWebSocket();
});