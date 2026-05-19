const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const socketIo = require('socket.io');
const os = require('os');

const app = express();
const PORT = 3443;

// ---------- Chemins SSL (à ajuster selon votre VM) ----------
const SSL_KEY_PATH = '/home/iut/certs/192.168.23.129-key.pem';
const SSL_CERT_PATH = '/home/iut/certs/192.168.23.129.pem';

if (!fs.existsSync(SSL_KEY_PATH) || !fs.existsSync(SSL_CERT_PATH)) {
    console.error('❌ Certificats SSL manquants. Générez-les avec mkcert :');
    console.error('  mkcert -install');
    console.error('  cd ~/certs && mkcert 192.168.23.129');
    process.exit(1);
}

const credentials = {
    key: fs.readFileSync(SSL_KEY_PATH),
    cert: fs.readFileSync(SSL_CERT_PATH)
};

const server = https.createServer(credentials, app);
const io = socketIo(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling']
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Base de données mémoire ----------
const users = [];        // { id, name, email, password, role }
const doctors = [];      // { id, userId, name, specialty }
const appointments = []; // { id, patientId, patientName, doctorId, doctorName, start, end }

// ---------- Routes API ----------
app.post('/api/register', (req, res) => {
    const { name, email, password, role, specialty } = req.body;
    if (users.find(u => u.email === email)) {
        return res.status(409).json({ success: false, message: 'Email déjà utilisé' });
    }
    const newUser = { id: Date.now().toString(), name, email, password, role };
    users.push(newUser);
    if (role === 'medecin') {
        doctors.push({ id: Date.now().toString(), userId: newUser.id, name, specialty });
    }
    res.json({ success: true, message: 'Inscription réussie' });
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    const user = users.find(u => u.email === email && u.password === password);
    if (!user) return res.status(401).json({ success: false, message: 'Identifiants invalides' });
    let doctorId = null;
    if (user.role === 'medecin') {
        const doc = doctors.find(d => d.userId === user.id);
        doctorId = doc ? doc.id : null;
    }
    res.json({ success: true, user: { id: user.id, name: user.name, role: user.role, doctorId } });
});

app.get('/api/doctors', (req, res) => {
    res.json(doctors.map(d => ({ id: d.id, name: d.name, specialty: d.specialty })));
});

// Créneaux disponibles : jours ouvrés (lundi-vendredi) de 9h à 18h, par tranche de 30 min
app.get('/api/doctors/:doctorId/slots', (req, res) => {
    const { doctorId } = req.params;
    const { date } = req.query;
    if (!date) return res.json([]);
    const doctor = doctors.find(d => d.id === doctorId);
    if (!doctor) return res.json([]);

    const dayOfWeek = new Date(date).getDay(); // 0=dimanche, 6=samedi
    if (dayOfWeek === 0 || dayOfWeek === 6) return res.json([]);

    const slots = [];
    for (let hour = 9; hour < 18; hour++) {
        for (let minute = 0; minute < 60; minute += 30) {
            const start = new Date(date);
            start.setHours(hour, minute, 0, 0);
            const end = new Date(start.getTime() + 30 * 60000);
            // Ne pas proposer les créneaux passés
            if (start <= new Date()) continue;
            const alreadyBooked = appointments.some(a => a.doctorId === doctorId && a.start === start.toISOString());
            if (!alreadyBooked) {
                slots.push({
                    start: start.toISOString(),
                    end: end.toISOString(),
                    startTimeFormatted: start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                });
            }
        }
    }
    res.json(slots);
});

app.post('/api/appointments', (req, res) => {
    const { patientId, patientName, doctorId, doctorName, start, end } = req.body;
    const existing = appointments.find(a => a.doctorId === doctorId && a.start === start);
    if (existing) return res.status(409).json({ success: false, message: 'Créneau déjà pris' });
    const newApp = {
        id: Date.now().toString(),
        patientId, patientName, doctorId, doctorName, start, end
    };
    appointments.push(newApp);
    res.json({ success: true, appointment: newApp });
});

app.get('/api/patients/:patientId/appointments', (req, res) => {
    const patientApps = appointments.filter(a => a.patientId === req.params.patientId);
    res.json(patientApps);
});

app.get('/api/doctors/:doctorId/appointments', (req, res) => {
    const doctorApps = appointments.filter(a => a.doctorId === req.params.doctorId);
    res.json(doctorApps);
});

app.delete('/api/appointments/:appointmentId', (req, res) => {
    const idx = appointments.findIndex(a => a.id === req.params.appointmentId);
    if (idx !== -1) appointments.splice(idx, 1);
    res.json({ success: true });
});

// ---------- WebSocket (signalisation WebRTC) ----------
const activeCalls = new Map();

io.on('connection', (socket) => {
    console.log('🟢 Client connecté', socket.id);

    socket.on('register', (data) => {
        socket.userId = data.userId;
        socket.userName = data.userName;
        socket.userRole = data.role;
        socket.join(`user-${data.userId}`);
    });

    // Patient demande un appel pour un rendez-vous précis
    socket.on('call:request', (data) => {
        const { appointmentId, patientId, patientName, doctorId, doctorName } = data;
        const callId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        activeCalls.set(callId, {
            callId, appointmentId, patientId, patientName, doctorId, doctorName,
            patientSocketId: socket.id, status: 'waiting'
        });
        io.to(`user-${doctorId}`).emit('call:incoming', {
            callId, patientId, patientName, doctorId, doctorName, fromSocketId: socket.id
        });
        socket.emit('call:requested', { callId });
    });

    socket.on('call:accept', (data) => {
        const { callId, doctorId, doctorName, patientSocketId } = data;
        const call = activeCalls.get(callId);
        if (call && call.status === 'waiting') {
            call.status = 'accepted';
            call.doctorSocketId = socket.id;
            io.to(call.patientSocketId).emit('call:accepted', {
                callId, doctorId, doctorName, doctorSocketId: socket.id
            });
            socket.emit('webrtc:ready', {
                callId,
                patientId: call.patientId,
                patientName: call.patientName,
                patientSocketId: call.patientSocketId
            });
        }
    });

    socket.on('call:reject', (data) => {
        const { callId, patientSocketId } = data;
        io.to(patientSocketId).emit('call:rejected');
        activeCalls.delete(callId);
    });

    // Signalisation WebRTC
    socket.on('webrtc:offer', (data) => {
        io.to(data.targetSocketId).emit('webrtc:offer', { offer: data.offer, fromSocketId: socket.id });
    });
    socket.on('webrtc:answer', (data) => {
        io.to(data.targetSocketId).emit('webrtc:answer', { answer: data.answer, fromSocketId: socket.id });
    });
    socket.on('webrtc:ice-candidate', (data) => {
        io.to(data.targetSocketId).emit('webrtc:ice-candidate', { candidate: data.candidate, fromSocketId: socket.id });
    });

    socket.on('call:end', (data) => {
        const call = activeCalls.get(data.callId);
        if (call) {
            if (call.patientSocketId) io.to(call.patientSocketId).emit('call:ended');
            if (call.doctorSocketId) io.to(call.doctorSocketId).emit('call:ended');
            activeCalls.delete(data.callId);
        }
    });

    socket.on('disconnect', () => {
        console.log('🔴 Déconnecté', socket.id);
        for (const [callId, call] of activeCalls.entries()) {
            if (call.patientSocketId === socket.id || call.doctorSocketId === socket.id) {
                if (call.patientSocketId && call.patientSocketId !== socket.id)
                    io.to(call.patientSocketId).emit('call:ended');
                if (call.doctorSocketId && call.doctorSocketId !== socket.id)
                    io.to(call.doctorSocketId).emit('call:ended');
                activeCalls.delete(callId);
            }
        }
    });
});

function getLocalIp() {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) return iface.address;
        }
    }
    return 'localhost';
}

server.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIp();
    console.log(`\n🔒 Serveur HTTPS démarré sur https://${ip}:${PORT}`);
    console.log(`📅 Prise de rendez-vous, WebRTC avec TURN actif.\n`);
});