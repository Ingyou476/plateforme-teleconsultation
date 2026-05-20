const express = require('express');
const http = require('http');
const path = require('path');
const socketIo = require('socket.io');
const os = require('os');

const app = express();
const PORT = 3443;

const server = http.createServer(app);
// Activation du CORS pour autoriser les connexions multi-appareils sur le réseau de la VM
const io = socketIo(server, { cors: { origin: "*" }, transports: ['websocket', 'polling'] });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Base de données mémoire ----------
const users = [
    { id: "admin_root", name: "Administrateur", email: "admin@doctoline.fr", password: "invite", role: "admin" }
];
const doctors = [];
const appointments = [];
const consultationHistory = [];
const auditLogs = [];

function logAction(actor, action) {
    const logEntry = {
        id: Date.now().toString() + Math.random().toString(36).substr(2, 4),
        timestamp: new Date().toLocaleString('fr-FR'),
        actor: actor,
        action: action
    };
    auditLogs.push(logEntry);
    io.emit('admin:new-log', logEntry);
}

// ---------- API REST ----------
app.post('/api/register', (req, res) => {
    const { name, email, password, role, specialty } = req.body;
    if (users.find(u => u.email === email))
        return res.status(409).json({ success: false, message: 'Email déjà utilisé' });
    
    const newUser = { id: Date.now().toString(), name, email, password, role };
    users.push(newUser);
    if (role === 'medecin') {
        doctors.push({ id: Date.now().toString(), userId: newUser.id, name, specialty });
    }
    logAction(name, `Inscription en tant que [${role}]`);
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
    logAction(user.name, "Connexion réussie");
    res.json({ success: true, user: { id: user.id, name: user.name, role: user.role, doctorId } });
});

app.get('/api/admin/users', (req, res) => res.json(users.filter(u => u.role !== 'admin')));
app.get('/api/admin/logs', (req, res) => res.json(auditLogs));

app.delete('/api/admin/users/:id', (req, res) => {
    const userId = req.params.id;
    const userIdx = users.findIndex(u => u.id === userId);
    if (userIdx !== -1) {
        const userName = users[userIdx].name;
        users.splice(userIdx, 1);
        const docIdx = doctors.findIndex(d => d.userId === userId);
        if (docIdx !== -1) doctors.splice(docIdx, 1);
        
        logAction("ADMIN", `Suppression de l'utilisateur : ${userName}`);
        return res.json({ success: true });
    }
    res.status(404).json({ success: false });
});

app.get('/api/doctors', (req, res) => {
    res.json(doctors.map(d => ({ id: d.id, name: d.name, specialty: d.specialty })));
});

app.get('/api/doctors/:doctorId/slots', (req, res) => {
    const { doctorId } = req.params;
    const { date } = req.query;
    if (!date) return res.json([]);
    const slots = [];
    for (let hour = 9; hour < 18; hour++) {
        for (let minute = 0; minute < 60; minute += 30) {
            const start = new Date(date);
            start.setHours(hour, minute, 0, 0);
            if (start <= new Date()) continue;
            const alreadyBooked = appointments.some(a => a.doctorId === doctorId && a.start === start.toISOString());
            if (!alreadyBooked) {
                slots.push({
                    start: start.toISOString(),
                    startTimeFormatted: start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                });
            }
        }
    }
    res.json(slots);
});

app.post('/api/appointments', (req, res) => {
    const { patientId, patientName, doctorId, doctorName, start, end } = req.body;
    const newApp = { id: Date.now().toString(), patientId, patientName, doctorId, doctorName, start, end };
    appointments.push(newApp);
    logAction(patientName, `Rendez-vous pris avec le Dr. ${doctorName}`);
    res.json({ success: true, appointment: newApp });
});

app.get('/api/patients/:patientId/appointments', (req, res) => {
    res.json(appointments.filter(a => a.patientId === req.params.patientId));
});

app.get('/api/doctors/:doctorId/appointments', (req, res) => {
    res.json(appointments.filter(a => a.doctorId === req.params.doctorId));
});

app.delete('/api/appointments/:appointmentId', (req, res) => {
    const idx = appointments.findIndex(a => a.id === req.params.appointmentId);
    if (idx !== -1) {
        logAction("Système", `Annulation rendez-vous ID: ${req.params.appointmentId}`);
        appointments.splice(idx, 1);
    }
    res.json({ success: true });
});

app.post('/api/history', (req, res) => {
    consultationHistory.push(req.body);
    logAction(req.body.patientName, `Consultation archivée (${req.body.avgBpm} BPM moyens)`);
    res.json({ success: true });
});

app.get('/api/history', (req, res) => res.json(consultationHistory));

// ---------- SIGNALISATION WEBRTC ----------
const activeCalls = new Map();

io.on('connection', (socket) => {
    socket.on('register', (data) => {
        socket.userId = data.userId;
        socket.join(`user-${data.userId}`);
    });

    socket.on('call:request', (data) => {
        const { appointmentId, patientId, patientName, doctorId, doctorName } = data;
        const callId = `call_${appointmentId}`;
        activeCalls.set(callId, { callId, patientSocketId: socket.id, doctorId, patientName, status: 'waiting' });
        io.to(`user-${doctorId}`).emit('call:incoming', { callId, patientName, fromSocketId: socket.id });
    });

    socket.on('call:accept', (data) => {
        const { callId } = data;
        const call = activeCalls.get(callId);
        if (call && call.status === 'waiting') {
            call.status = 'accepted';
            call.doctorSocketId = socket.id;
            io.to(call.patientSocketId).emit('call:accepted', { callId, doctorSocketId: socket.id });
            socket.emit('webrtc:ready', { callId, targetSocketId: call.patientSocketId });
        }
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

    socket.on('chat:message', (data) => {
        io.to(data.targetSocketId).emit('chat:message', { msg: data.msg });
    });
    
    socket.on('sensor:data', (data) => {
        io.to(data.targetSocketId).emit('sensor:data', { fhir: data.fhir });
    });

    socket.on('call:end', (data) => {
        const call = activeCalls.get(data.callId);
        if (call) {
            if (call.patientSocketId) io.to(call.patientSocketId).emit('call:ended');
            if (call.doctorSocketId) io.to(call.doctorSocketId).emit('call:ended');
            activeCalls.delete(data.callId);
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
    console.log(`\n🚀 Serveur HTTP démarré sur la VM.`);
    console.log(`🔗 Adresse locale de test : http://${getLocalIp()}:${PORT}\n`);
});