const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const socketIo = require('socket.io');
const os = require('os');

const app = express();
const PORT = 3443;

// ---------- Certificats SSL (générés avec mkcert) ----------
// Chemins à adapter si besoin (utilisateur iut)
const SSL_KEY_PATH = '/home/iut/certs/192.168.23.129-key.pem';
const SSL_CERT_PATH = '/home/iut/certs/192.168.23.129.pem';

if (!fs.existsSync(SSL_KEY_PATH) || !fs.existsSync(SSL_CERT_PATH)) {
    console.error('❌ Certificats SSL introuvables. Générez-les avec :');
    console.error('  mkcert -install');
    console.error('  cd ~/certs && mkcert 192.168.23.129');
    process.exit(1);
}

const credentials = {
    key: fs.readFileSync(SSL_KEY_PATH, 'utf8'),
    cert: fs.readFileSync(SSL_CERT_PATH, 'utf8')
};

const server = https.createServer(credentials, app);
const io = socketIo(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling']
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Base de données mémoire ----------
const users = [];               // { id, name, email, password, role }
const doctors = [];             // { id, userId, name, specialty, description, defaultSchedule, exceptions }
const appointments = [];        // { id, patientId, patientName, doctorId, doctorName, start, end, status }
const activeSessions = new Map(); // userId -> socketId

// ---------- Routes API ----------
app.post('/api/register', (req, res) => {
    const { name, email, password, role, specialty, description } = req.body;
    if (!name || !email || !password || !role) {
        return res.status(400).json({ success: false, message: 'Champs requis' });
    }
    if (users.find(u => u.email === email)) {
        return res.status(409).json({ success: false, message: 'Email déjà utilisé' });
    }
    const newUser = { id: Date.now().toString(), name, email, password, role };
    users.push(newUser);

    if (role === 'medecin') {
        if (!specialty) {
            return res.status(400).json({ success: false, message: 'Spécialité requise' });
        }
        // Planning par défaut : lundi-vendredi 9h-18h, créneaux de 30 min
        const defaultSchedule = {
            monday: { enabled: true, start: '09:00', end: '18:00', slotDuration: 30 },
            tuesday: { enabled: true, start: '09:00', end: '18:00', slotDuration: 30 },
            wednesday: { enabled: true, start: '09:00', end: '18:00', slotDuration: 30 },
            thursday: { enabled: true, start: '09:00', end: '18:00', slotDuration: 30 },
            friday: { enabled: true, start: '09:00', end: '18:00', slotDuration: 30 },
            saturday: { enabled: false },
            sunday: { enabled: false }
        };
        doctors.push({
            id: Date.now().toString(),
            userId: newUser.id,
            name: newUser.name,
            specialty,
            description: description || '',
            defaultSchedule,
            exceptions: [] // { date: 'YYYY-MM-DD', allDay: true }
        });
    }
    res.json({ success: true, message: 'Inscription réussie' });
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    const user = users.find(u => u.email === email && u.password === password);
    if (!user) return res.status(401).json({ success: false, message: 'Identifiants invalides' });

    // Déconnexion de l'autre session
    const oldSocketId = activeSessions.get(user.id);
    if (oldSocketId) {
        const oldSocket = io.sockets.sockets.get(oldSocketId);
        if (oldSocket) oldSocket.emit('force-logout', { message: 'Quelqu\'un s\'est connecté avec votre compte' });
        activeSessions.delete(user.id);
    }

    let doctorInfo = null;
    if (user.role === 'medecin') {
        doctorInfo = doctors.find(d => d.userId === user.id);
    }
    res.json({
        success: true,
        user: {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            doctorId: doctorInfo?.id || null
        }
    });
});

app.get('/api/doctors', (req, res) => {
    const list = doctors.map(d => ({
        id: d.id,
        name: d.name,
        specialty: d.specialty,
        description: d.description
    }));
    res.json(list);
});

app.get('/api/doctors/:doctorId/slots', (req, res) => {
    const { doctorId } = req.params;
    const { date } = req.query;
    if (!date) return res.status(400).json({ success: false, message: 'Date manquante' });

    const doctor = doctors.find(d => d.id === doctorId);
    if (!doctor) return res.status(404).json([]);

    const targetDate = new Date(date);
    const dayOfWeek = targetDate.toLocaleDateString('en-US', { weekday: 'lowercase' });
    const schedule = doctor.defaultSchedule[dayOfWeek];
    if (!schedule || !schedule.enabled) return res.json([]);

    const exception = doctor.exceptions.find(e => e.date === date);
    if (exception && exception.allDay) return res.json([]);

    const slots = [];
    const [startHour, startMin] = schedule.start.split(':').map(Number);
    const [endHour, endMin] = schedule.end.split(':').map(Number);
    let current = new Date(targetDate);
    current.setHours(startHour, startMin, 0, 0);
    const end = new Date(targetDate);
    end.setHours(endHour, endMin, 0, 0);

    while (current < end) {
        const slotStart = new Date(current);
        const slotEnd = new Date(current.getTime() + schedule.slotDuration * 60000);
        if (slotEnd <= end) {
            const alreadyBooked = appointments.some(a =>
                a.doctorId === doctorId && a.start === slotStart.toISOString()
            );
            if (!alreadyBooked) {
                slots.push({
                    start: slotStart.toISOString(),
                    end: slotEnd.toISOString(),
                    startTimeFormatted: slotStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                });
            }
        }
        current = new Date(current.getTime() + schedule.slotDuration * 60000);
    }
    res.json(slots);
});

app.post('/api/appointments', (req, res) => {
    const { patientId, patientName, doctorId, doctorName, start, end } = req.body;
    const existing = appointments.find(a => a.doctorId === doctorId && a.start === start);
    if (existing) return res.status(409).json({ success: false, message: 'Créneau déjà pris' });
    const newAppointment = {
        id: Date.now().toString(),
        patientId, patientName, doctorId, doctorName, start, end, status: 'upcoming'
    };
    appointments.push(newAppointment);
    res.json({ success: true, appointment: newAppointment });
});

app.get('/api/patients/:patientId/appointments', (req, res) => {
    const patientAppointments = appointments.filter(a => a.patientId === req.params.patientId);
    res.json(patientAppointments);
});

app.get('/api/doctors/:doctorId/appointments', (req, res) => {
    const doctorAppointments = appointments.filter(a => a.doctorId === req.params.doctorId);
    res.json(doctorAppointments);
});

app.delete('/api/appointments/:appointmentId', (req, res) => {
    const idx = appointments.findIndex(a => a.id === req.params.appointmentId);
    if (idx === -1) return res.status(404).json({ success: false });
    appointments.splice(idx, 1);
    res.json({ success: true });
});

app.post('/api/doctors/:doctorId/exceptions', (req, res) => {
    const { doctorId } = req.params;
    const { date } = req.body;
    const doctor = doctors.find(d => d.id === doctorId);
    if (!doctor) return res.status(404).json({ success: false });
    if (!doctor.exceptions.find(e => e.date === date)) {
        doctor.exceptions.push({ date, allDay: true });
    }
    res.json({ success: true });
});

// ---------- WebSocket (signalisation WebRTC) ----------
const activeCalls = new Map();

io.on('connection', (socket) => {
    console.log('🟢 Nouveau client:', socket.id);

    socket.on('register', (data) => {
        socket.userId = data.userId;
        socket.userName = data.userName;
        socket.userRole = data.role;
        activeSessions.set(data.userId, socket.id);
        socket.join(`user-${data.userId}`);
        console.log(`✅ ${data.userName} (${data.role}) enregistré`);
    });

    socket.on('call:request', (data) => {
        const { appointmentId, patientId, patientName, doctorId, doctorName } = data;
        const callId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
        activeCalls.set(callId, {
            callId, appointmentId, patientId, patientName, doctorId, doctorName,
            patientSocketId: socket.id, status: 'waiting'
        });
        io.to(`user-${doctorId}`).emit('call:incoming', {
            callId, appointmentId, patientId, patientName, doctorId, doctorName,
            fromSocketId: socket.id
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
        if (socket.userId) activeSessions.delete(socket.userId);
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
    console.log(`📅 Calendrier, RDV, WebRTC avec TURN actif.\n`);
});