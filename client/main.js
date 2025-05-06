document.addEventListener("DOMContentLoaded", () => {
    const roomInput = document.getElementById("roomInput");
    const joinRoomBtn = document.getElementById("joinRoomBtn");
    const roomDisplay = document.getElementById("roomDisplay");
    const fileInput = document.getElementById("fileInput");
    const sendBtn = document.getElementById("sendBtn");
    const progressBar = document.getElementById("progressBar");
    const status = document.getElementById("status");

    let ws;
    let pc;
    let dc;
    let connectedPeers = 0;

    const MAX_RETRIES = 5;
    let retryCount = 0;

    function connectWebSocket() {
        status.textContent = "Connecting...";
        ws = new WebSocket("wss://primary-tove-arsenijevicdev-4f187706.koyeb.app/");

        ws.onopen = () => {
            retryCount = 0;
            status.textContent = "Connected to signaling server.";
        };

        ws.onerror = (err) => {
            console.error("WebSocket error:", err);
            retryConnection();
        };

        ws.onclose = () => {
            console.warn("WebSocket closed.");
            retryConnection();
        };

        ws.onmessage = async (message) => {
            const data = JSON.parse(message.data);

            if (data.type === "joined") {
                roomDisplay.textContent = `Room: ${data.room}`;
                connectedPeers = data.count;
                updateRoomDisplay();
                createPeerConnection();

                if (data.initiator) {
                    dc = pc.createDataChannel("file");
                    setupDataChannel(dc);
                    const offer = await pc.createOffer();
                    await pc.setLocalDescription(offer);
                    ws.send(JSON.stringify({ type: "offer", offer }));
                }
            } else if (data.type === "offer") {
                await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
                dc = await new Promise(resolve => {
                    pc.ondatachannel = e => resolve(e.channel);
                });
                setupDataChannel(dc);
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                ws.send(JSON.stringify({ type: "answer", answer }));

            } else if (data.type === "answer") {
                await pc.setRemoteDescription(new RTCSessionDescription(data.answer));

            } else if (data.type === "ice-candidate") {
                try {
                    await pc.addIceCandidate(data.candidate);
                } catch (err) {
                    console.error("Failed to add ICE candidate:", err);
                }

            } else if (data.type === "room-update") {
                connectedPeers = data.count;
                updateRoomDisplay();
            }
        };
    }

    function retryConnection() {
        if (retryCount < MAX_RETRIES) {
            retryCount++;
            status.textContent = `Reconnecting... (${retryCount})`;
            setTimeout(connectWebSocket, 1000 * retryCount);
        } else {
            status.textContent = "Failed to connect.";
        }
    }

    function createPeerConnection() {
        pc = new RTCPeerConnection();

        pc.onicecandidate = ({ candidate }) => {
            if (candidate) {
                ws.send(JSON.stringify({ type: "ice-candidate", candidate }));
            }
        };
    }

    function setupDataChannel(channel) {
        channel.binaryType = "arraybuffer";
        let receivedBuffers = [];
        let totalSize = 0;
        let receivedSize = 0;

        channel.onopen = () => {
            status.textContent = "Peer connected.";
        };

        channel.onmessage = (e) => {
            if (typeof e.data === "string" && e.data.startsWith("file-meta:")) {
                const [, name, size] = e.data.split(":");
                totalSize = parseInt(size);
                receivedBuffers = [];
                receivedSize = 0;
                status.textContent = `Receiving: ${name}`;
            } else {
                receivedBuffers.push(e.data);
                receivedSize += e.data.byteLength;
                progressBar.style.display = "block";
                progressBar.value = (receivedSize / totalSize) * 100;

                if (receivedSize >= totalSize) {
                    const blob = new Blob(receivedBuffers);
                    const a = document.createElement("a");
                    a.href = URL.createObjectURL(blob);
                    a.download = "downloaded_file";
                    a.click();
                    progressBar.style.display = "none";
                    progressBar.value = 0;
                    status.textContent = "File received.";
                }
            }
        };
    }

    joinRoomBtn.onclick = () => {
        const room = roomInput.value.trim();
        if (!room) return;

        const tryJoin = () => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "join", room }));
            } else {
                status.textContent = "Waiting for WebSocket to open...";
                setTimeout(tryJoin, 500);
            }
        };

        tryJoin();
    };

    sendBtn.onclick = () => {
        if (!dc || dc.readyState !== "open") {
            alert("DataChannel not open.");
            return;
        }
        const file = fileInput.files[0];
        if (!file) return;

        dc.send(`file-meta:${file.name}:${file.size}`);
        const chunkSize = 64 * 1024;
        let offset = 0;

        const reader = new FileReader();
        reader.onload = (e) => {
            dc.send(e.target.result);
            offset += e.target.result.byteLength;
            progressBar.style.display = "block";
            progressBar.value = (offset / file.size) * 100;

            if (offset < file.size) {
                readSlice(offset);
            } else {
                status.textContent = "File sent.";
                progressBar.style.display = "none";
                progressBar.value = 0;
            }
        };

        const readSlice = (o) => {
            const slice = file.slice(o, o + chunkSize);
            reader.readAsArrayBuffer(slice);
        };

        readSlice(0);
    };

    function updateRoomDisplay() {
        const room = roomInput.value.trim();
        roomDisplay.textContent = `Room: ${room} | Peers: ${connectedPeers}`;
    }

    connectWebSocket();
});
