const statusEl = document.getElementById('status');
const roomDisplay = document.getElementById('roomDisplay');
const progressBar = document.getElementById('progressBar');
const fileInput = document.getElementById('fileInput');
const sendBtn = document.getElementById('sendBtn');
const joinRoomBtn = document.getElementById('joinRoomBtn');
const roomInput = document.getElementById('roomInput');

let ws;
let roomId = '';
let retryCount = 0;
const MAX_RETRIES = 5;

let peerConnection;
let dataChannel;
let receivedMeta = null;
let incomingBuffer = [];
let receivedBytes = 0;
let expectedSize = 0;

joinRoomBtn.onclick = () => {
    const input = roomInput.value.trim();
    if (!input) return alert('Enter a room ID first!');
    roomId = input;
    connectWebSocket();
};

function updateStatus(text, success = false) {
    statusEl.textContent = text;
    statusEl.style.color = success ? 'limegreen' : 'orange';
}

function updateRoomDisplay(count = null) {
    let msg = `Room: ${roomId}`;
    if (count !== null) msg += ` | Users: ${count}`;
    roomDisplay.textContent = msg;
}

function connectWebSocket() {
    ws = new WebSocket('wss://primary-tove-arsenijevicdev-4f187706.koyeb.app/');

    ws.onopen = () => {
        updateStatus('Connected to signaling server', true);
        retryCount = 0;
        ws.send(JSON.stringify({ type: 'join', room: roomId }));
        initializePeer();
    };

    ws.onclose = () => {
        updateStatus('Disconnected. Retrying...');
        if (retryCount < MAX_RETRIES) {
            setTimeout(connectWebSocket, 1000 * (retryCount + 1));
            retryCount++;
        } else {
            updateStatus('Failed to connect. Please refresh.');
        }
    };

    ws.onerror = (e) => {
        console.error('WebSocket error:', e);
        ws.close();
    };

    ws.onmessage = async (event) => {
        const message = JSON.parse(event.data);

        if (message.type === 'room_info') {
            updateRoomDisplay(message.clients);
        }

        if (message.answer) {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(message.answer));
        } else if (message.offer) {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(message.offer));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            ws.send(JSON.stringify({ answer }));
        } else if (message.ice) {
            peerConnection.addIceCandidate(new RTCIceCandidate(message.ice));
        }
    };
}

function initializePeer() {
    peerConnection = new RTCPeerConnection();

    peerConnection.onicecandidate = ({ candidate }) => {
        if (candidate) {
            ws.send(JSON.stringify({ ice: candidate }));
        }
    };

    dataChannel = peerConnection.createDataChannel('file');
    setupDataChannel();

    peerConnection.createOffer().then(offer => {
        peerConnection.setLocalDescription(offer);
        ws.send(JSON.stringify({ offer }));
    });

    peerConnection.ondatachannel = (event) => {
        dataChannel = event.channel;
        setupDataChannel();
    };
}

function setupDataChannel() {
    dataChannel.onopen = () => {
        updateStatus('Peer connection established', true);
    };

    dataChannel.onmessage = (e) => {
        if (typeof e.data === 'string') {
            receivedMeta = JSON.parse(e.data);
            expectedSize = receivedMeta.size || 0;
            incomingBuffer = [];
            receivedBytes = 0;
            progressBar.style.display = 'block';
            progressBar.value = 0;
        } else if (receivedMeta) {
            incomingBuffer.push(e.data);
            receivedBytes += e.data.byteLength;
            progressBar.value = (receivedBytes / expectedSize) * 100;

            if (receivedBytes >= expectedSize) {
                const blob = new Blob(incomingBuffer, { type: receivedMeta.type });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = receivedMeta.name || 'received_file';
                a.click();
                receivedMeta = null;
                progressBar.style.display = 'none';
            }
        }
    };
}

sendBtn.onclick = () => {
    const file = fileInput.files[0];
    if (!file || !dataChannel || dataChannel.readyState !== 'open') {
        alert('Connection not ready or file not selected');
        return;
    }

    const chunkSize = 64 * 1024;
    const totalChunks = Math.ceil(file.size / chunkSize);
    let offset = 0;

    dataChannel.send(JSON.stringify({ name: file.name, type: file.type, size: file.size }));
    progressBar.style.display = 'block';
    progressBar.value = 0;

    function sendChunk() {
        const slice = file.slice(offset, offset + chunkSize);
        dataChannel.send(slice);
        offset += chunkSize;
        progressBar.value = (offset / file.size) * 100;

        if (offset < file.size) {
            setTimeout(sendChunk, 10);
        } else {
            console.log('File sent successfully');
        }
    }

    sendChunk();
};
