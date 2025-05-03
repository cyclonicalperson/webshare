const ws = new WebSocket('ws://localhost:3000');
let pc, dataChannel;
let roomId = '';
let fileInput = document.getElementById('fileInput');
let sendBtn = document.getElementById('sendBtn');
let chooseFileBtn = document.getElementById('chooseFileBtn');
let fileNameLabel = document.getElementById('fileName');

let incomingFileMeta = null;

ws.onmessage = async (event) => {
    const { type, payload } = JSON.parse(event.data);

    if (type === 'offer') {
        await createPeer(false);
        await pc.setRemoteDescription(new RTCSessionDescription(payload));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ type: 'answer', room: roomId, payload: answer }));
    } else if (type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(payload));
    } else if (type === 'ice') {
        await pc.addIceCandidate(new RTCIceCandidate(payload));
    }
};

document.getElementById('joinBtn').onclick = async () => {
    roomId = document.getElementById('roomInput').value;
    if (!roomId) return alert('Enter a room ID');
    ws.send(JSON.stringify({ type: 'join', room: roomId }));

    await createPeer(true);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ type: 'offer', room: roomId, payload: offer }));
};

chooseFileBtn.onclick = () => {
    fileInput.click();
};

fileInput.onchange = () => {
    const file = fileInput.files[0];
    if (file) {
        fileNameLabel.textContent = `Selected: ${file.name}`;
    }
};

dataChannel.onopen = () => {
    console.log('✅ DataChannel open');
};

dataChannel.onclose = () => {
    console.warn('⚠️ DataChannel closed');
};

dataChannel.onerror = (err) => {
    console.error('❌ DataChannel error:', err);
};

sendBtn.onclick = () => {
    console.log('[Send] Button clicked');

    const file = fileInput.files[0];
    if (!file) return alert('No file selected.');

    if (!dataChannel || dataChannel.readyState !== 'open') {
        return alert('DataChannel is not ready.');
    }

    // Send metadata
    const metadata = {
        filename: file.name,
        size: file.size,
        type: file.type
    };

    console.log('[Send] Sending metadata:', metadata);
    dataChannel.send(JSON.stringify(metadata));

    file.arrayBuffer().then(buffer => {
        console.log('[Send] Sending file buffer. Size:', buffer.byteLength);
        dataChannel.send(buffer);
    }).catch(err => {
        console.error('[Send] Error converting file to buffer:', err);
    });
};


async function createPeer(initiator) {
    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

    if (initiator) {
        dataChannel = pc.createDataChannel('file');
        setupDataChannel();
    } else {
        pc.ondatachannel = (event) => {
            dataChannel = event.channel;
            setupDataChannel();
        };
    }

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            ws.send(JSON.stringify({ type: 'ice', room: roomId, payload: event.candidate }));
        }
    };

    sendBtn.disabled = false;
}

function setupDataChannel() {
    dataChannel.onopen = () => {
        console.log('✅ DataChannel open');
        sendBtn.disabled = false;
    };

    dataChannel.onmessage = (e) => {
        if (typeof e.data === 'string') {
            console.log('[Receive] Got metadata:', e.data);
            try {
                const meta = JSON.parse(e.data);
                if (meta.filename && meta.size) {
                    incomingFileMeta = meta;
                }
            } catch (err) {
                console.error('[Receive] Failed to parse metadata:', err);
            }
        } else if (e.data instanceof ArrayBuffer && incomingFileMeta) {
            console.log('[Receive] Got file buffer. Saving as:', incomingFileMeta.filename);

            const blob = new Blob([e.data], { type: incomingFileMeta.type || 'application/octet-stream' });
            const url = URL.createObjectURL(blob);

            const a = document.createElement('a');
            a.href = url;
            a.download = incomingFileMeta.filename;
            a.click();

            incomingFileMeta = null;
        } else {
            console.warn('[Receive] Received unexpected message format:', e.data);
        }
    };
}
