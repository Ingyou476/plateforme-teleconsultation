const socket = io();

let localStream;
let peerConnection;

const configuration = {

    iceServers: [

        {
            urls: 'stun:stun.l.google.com:19302'
        },

        {
            urls: 'turn:192.168.23.129:3478',
            username: 'test',
            credential: 'test123'
        }
    ]
};

async function join() {

    const name = document.getElementById('username').value;
    const role = document.getElementById('role').value;

    socket.emit('join-user', { name, role });

    localStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
    });

    document.getElementById('localVideo').srcObject = localStream;

    startSensor();
}

socket.on('users-list', (users) => {

    const usersDiv = document.getElementById('users');

    usersDiv.innerHTML = '';

    for (let id in users) {

        const user = users[id];

        const div = document.createElement('div');

        div.className = 'user';

        div.innerHTML = `
            ${user.name} (${user.role})
            <button onclick="callUser('${id}')">Appeler</button>
        `;

        usersDiv.appendChild(div);
    }
});

async function createPeerConnection(target) {

    peerConnection = new RTCPeerConnection(configuration);

    localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
    });

    peerConnection.ontrack = (event) => {

        document.getElementById('remoteVideo').srcObject =
            event.streams[0];
    };

    peerConnection.onicecandidate = (event) => {

        if (event.candidate) {

            socket.emit('ice-candidate', {
                target,
                candidate: event.candidate
            });
        }
    };
}

async function callUser(target) {

    await createPeerConnection(target);

    const offer = await peerConnection.createOffer();

    await peerConnection.setLocalDescription(offer);

    socket.emit('call-user', {
        target,
        offer,
        callerName: document.getElementById('username').value
    });
}

socket.on('incoming-call', async (data) => {

    await createPeerConnection(data.from);

    await peerConnection.setRemoteDescription(data.offer);

    const answer = await peerConnection.createAnswer();

    await peerConnection.setLocalDescription(answer);

    socket.emit('answer-call', {
        target: data.from,
        answer
    });
});

socket.on('call-answered', async (data) => {

    await peerConnection.setRemoteDescription(data.answer);
});

socket.on('ice-candidate', async (data) => {

    try {

        await peerConnection.addIceCandidate(data.candidate);

    } catch (err) {

        console.error(err);
    }
});

function startSensor() {

    setInterval(() => {

        const bpm = Math.floor(Math.random() * 40) + 60;

        document.getElementById('heartRate').innerText = bpm;

        socket.emit('sensor-data', {
            bpm
        });

    }, 2000);
}