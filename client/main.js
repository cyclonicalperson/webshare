const ws = new WebSocket('https://webshare-8jx3.onrender.com');
let pc, dataChannel;
let fileInput = document.getElementById('fileInput');
let sendBtn = document.getElementById('sendBtn');
let roomId;
let receivedMeta = null;

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
        pc.addIceCandidate(new RTCIceCandidate(payload));
    }
};

document.getElementById('joinBtn').onclick = async () => {
    roomId = document.getElementById('roomInput').value;
    if (!roomId) return alert('Enter room ID');
    ws.send(JSON.stringify({ type: 'join', room: roomId }));

    await createPeer(true);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ type: 'offer', room: roomId, payload: offer }));
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
    dataChannel.onopen = () => console.log('DataChannel open');
    dataChannel.onmessage = (e) => {
        if (typeof e.data === 'string') {
            // Metadata (filename and type)
            try {
                receivedMeta = JSON.parse(e.data);
            } catch (err) {
                console.error('Failed to parse metadata:', err);
            }
        } else if (receivedMeta) {
            const blob = new Blob([e.data], { type: receivedMeta.type });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = receivedMeta.name || 'received_file';
            a.click();
            receivedMeta = null;
        }
    };

    sendBtn.onclick = () => {
        const file = fileInput.files[0];
        if (!file) return alert('Choose a file first');

        // First send metadata
        dataChannel.send(JSON.stringify({ name: file.name, type: file.type }));

        // Then send file as Blob
        dataChannel.send(file);
    };


    document.getElementById('chooseFileBtn').onclick = () => {
        fileInput.click();
    };

    fileInput.onchange = () => {
        const file = fileInput.files[0];
        if (file) {
            document.getElementById('fileName').textContent = `Selected: ${file.name}`;
        }
    };
}
