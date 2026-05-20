const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const socketIo = require('socket.io');
const os = require('os');

const app = express();
const PORT = 3443;

// ---------- Gestion des Certificats SSL ----------
let SSL_KEY_PATH = '/home/iut/certs/192.168.23.129-key.pem';
let SSL_CERT_PATH = '/home/iut/certs/192.168.23.129.pem';

// Fallback si on change de machine ou de dossier pendant la démo
if (!fs.existsSync(SSL_KEY_PATH) || !fs.existsSync(SSL_CERT_PATH)) {
    SSL_KEY_PATH = path.join(__dirname, 'certs', 'key.pem');
    SSL_CERT_PATH = path.join(__dirname, 'certs', 'cert.pem');
}

if (!fs.existsSync(SSL_KEY_PATH) || !fs.existsSync(SSL_CERT_PATH)) {
    console.error('❌ Certificats SSL introuvables. Mode sécurisé impossible.');
    console.error('Assurez-vous d\'avoir vos certificats valides pour l\'adresse IP de la VM.');
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
const users = [];
const doctors = [];
const appointments = [];
const consultationHistory = [];  
const activeSessions = new Map();

// ---------- Routes API ----------

// INSCRIPTION
app.post('/api/register', (req, res) => {
    const { name, email, password, role, specialty, description } = req.body;
    if (!name || !email || !password || !role) {
        return res.status(400).json({ success: false, message: 'Champs requis manquants' });
    }
    if (users.find(u => u.email === email)) {
        return res.status(409).json({ success: false, message: 'Email déjà utilisé' });
    }
    const newUser = { id: Date.now().toString(), name, email, password, role };
    users.push(newUser);

    if (role === 'medecin') {
        if (!specialty) {
            return res.status(400).json({ success: false, message: 'Spécialité requise pour un médecin' });
        }
        const defaultSchedule = {
            monday:    { enabled: true,  start: '09:00', end: '18:00', slotDuration: 30 },
            tuesday:   { enabled: true,  start: '09:00', end: '18:00', slotDuration: 30 },
            wednesday: { enabled: true,  start: '09:00', end: '18:00', slotDuration: 30 },
            thursday:  { enabled: true,  start: '09:00', end: '18:00', slotDuration: 30 },
            friday:    { enabled: true,  start: '09:00', end: '18:00', slotDuration: 30 },
            saturday:  { enabled: false },
            sunday:    { enabled: false }
        };
        doctors.push({
            id: Date.now().toString() + '_doc',
            userId: newUser.id,
            name: newUser.name,
            specialty,
            description: description || '',
            defaultSchedule,
            exceptions: []
        });
    }
    res.json({ success: true, message: 'Inscription réussie' });
});

// CONNEXION
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    const user = users.find(u => u.email === email && u.password === password);
    if (!user) return res.status(401).json({ success: false, message: 'Identifiants invalides' });

    const oldSocketId = activeSessions.get(user.id);
    if (oldSocketId) {
        const oldSocket = io.sockets.sockets.get(oldSocketId);
        if (oldSocket) oldSocket.emit('force-logout', { message: 'Connexion depuis un autre appareil' });
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

// LISTE DES MÉDECINS
app.get('/api/doctors', (req, res) => {
    res.json(doctors.map(d => ({
        id: d.id,
        name: d.name,
        specialty: d.specialty,
        description: d.description
    })));
});

// CRÉNEAUX DISPONIBLES
app.get('/api/doctors/:doctorId/slots', (req, res) => {
    const { doctorId } = req.params;
    const { date } = req.query;
    if (!date) return res.status(400).json({ success: false, message: 'Date manquante' });

    const doctor = doctors.find(d => d.id === doctorId);
    if (!doctor) return res.status(404).json([]);

    const targetDate = new Date(date);
    const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const dayOfWeek = dayNames[targetDate.getDay()];
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
                a.doctorId === doctorId && a.start === slotStart.toISOString() && a.status !== 'cancelled'
            );
            if (!alreadyBooked) {
                slots.push({
                    start: slotStart.toISOString(),
                    end: slotEnd.toISOString(),
                    startTimeFormatted: slotStart.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
                });
            }
        }
        current = new Date(current.getTime() + schedule.slotDuration * 60000);
    }
    res.json(slots);
});

// PRENDRE RDV
app.post('/api/appointments', (req, res) => {
    const { patientId, patientName, doctorId, doctorName, start, end } = req.body;
    const existing = appointments.find(a => a.doctorId === doctorId && a.start === start && a.status !== 'cancelled');
    if (existing) return res.status(409).json({ success: false, message: 'Créneau déjà pris' });
    const newAppointment = {
        id: Date.now().toString(),
        patientId, patientName, doctorId, doctorName, start, end, status: 'upcoming'
    };
    appointments.push(newAppointment);
    res.json({ success: true, appointment: newAppointment });
});

app.get('/api/patients/:patientId/appointments', (req, res) => {
    res.json(appointments.filter(a => a.patientId === req.params.patientId));
});

app.get('/api/doctors/:doctorId/appointments', (req, res) => {
    res.json(appointments.filter(a => a.doctorId === req.params.doctorId));
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

// ENPOINT FHIR OBSERVATION (Conforme HL7 FHIR r4)
app.post('/api/fhir/observation', (req, res) => {
    const { patientId, patientName, heartRate, temperature, spo2 } = req.body;
    const now = new Date().toISOString();
    const observations = [];

    if (heartRate !== undefined) {
        observations.push({
            resourceType: "Observation",
            id: `hr-${Date.now()}`,
            status: "final",
            category: [{
                coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs", display: "Vital Signs" }]
            }],
            code: {
                coding: [{ system: "http://loinc.org", code: "8867-4", display: "Heart rate" }],
                text: "Fréquence cardiaque"
            },
            subject: { reference: `Patient/${patientId}`, display: patientName },
            effectiveDateTime: now,
            valueQuantity: { value: heartRate, unit: "beats/minute", system: "http://unitsofmeasure.org", code: "/min" }
        });
    }

    if (temperature !== undefined) {
        observations.push({
            resourceType: "Observation",
            id: `temp-${Date.now()}`,
            status: "final",
            category: [{
                coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs", display: "Vital Signs" }]
            }],
            code: {
                coding: [{ system: "http://loinc.org", code: "8310-5", display: "Body temperature" }],
                text: "Température corporelle"
            },
            subject: { reference: `Patient/${patientId}`, display: patientName },
            effectiveDateTime: now,
            valueQuantity: { value: temperature, unit: "degree Celsius", system: "http://unitsofmeasure.org", code: "Cel" }
        });
    }

    if (spo2 !== undefined) {
        observations.push({
            resourceType: "Observation",
            id: `spo2-${Date.now()}`,
            status: "final",
            category: [{
                coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs", display: "Vital Signs" }]
            }],
            code: {
                coding: [{ system: "http://loinc.org", code: "2708-6", display: "Oxygen saturation in Arterial blood" }],
                text: "Saturation en oxygène (SpO2)"
            },
            subject: { reference: `Patient/${patientId}`, display: patientName },
            effectiveDateTime: now,
            valueQuantity: { value: spo2, unit: "%", system: "http://unitsofmeasure.org", code: "%" }
        });
    }

    res.json({ success: true, observations });
});

// ---------- Signalisation WebRTC via Socket.io ----------
const activeCalls = new Map();

io.on('connection', (socket) => {
    console.log('🟢 Nouveau client connecté:', socket.id);

    socket.on('register', (data) => {
        socket.userId = data.userId;
        socket.userName = data.userName;
        socket.userRole = data.role;
        activeSessions.set(data.userId, socket.id);
        socket.join(`user-${data.userId}`);
    });

    socket.on('call:request', (data) => {
        const { appointmentId, patientId, patientName, doctorId, doctorName } = data;
        const callId = `call_${Date.now()}`;
        activeCalls.set(callId, {
            callId, appointmentId, patientId, patientName, doctorId, doctorName,
            initiatorSocketId: socket.id,
            status: 'waiting',
            startTime: null
        });
        const targetId = socket.userRole === 'medecin' ? patientId : doctorId;
        io.to(`user-${targetId}`).emit('call:incoming', {
            callId, appointmentId, patientId, patientName, doctorId, doctorName,
            fromSocketId: socket.id
        });
        socket.emit('call:requested', { callId });
    });

    socket.on('call:accept', (data) => {
        const { callId } = data;
        const call = activeCalls.get(callId);
        if (call && call.status === 'waiting') {
            call.status = 'accepted';
            call.acceptorSocketId = socket.id;
            call.startTime = new Date();
            
            io.to(call.initiatorSocketId).emit('call:accepted', { callId, peerSocketId: socket.id });
            socket.emit('webrtc:ready', { callId, peerSocketId: call.initiatorSocketId });
        }
    });

    socket.on('call:reject', (data) => {
        const call = activeCalls.get(data.callId);
        if (call) {
            io.to(call.initiatorSocketId).emit('call:rejected', { callId: data.callId });
            activeCalls.delete(data.callId);
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

    socket.on('call:end', (data) => {
        const call = activeCalls.get(data.callId);
        if (call) {
            const appt = appointments.find(a => a.id === call.appointmentId);
            if (appt) appt.status = 'completed';

            if (call.initiatorSocketId) io.to(call.initiatorSocketId).emit('call:ended');
            if (call.acceptorSocketId) io.to(call.acceptorSocketId).emit('call:ended');
            activeCalls.delete(data.callId);
        }
    });

    socket.on('sensor:data', (data) => {
        const call = activeCalls.get(data.callId);
        if (call) {
            const target = socket.id === call.initiatorSocketId ? call.acceptorSocketId : call.initiatorSocketId;
            if (target) io.to(target).emit('sensor:update', data);
        }
    });

    socket.on('disconnect', () => {
        if (socket.userId) activeSessions.delete(socket.userId);
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
    console.log(`\n🔒 Serveur HTTPS DoctoLine démarré sur : https://${ip}:${PORT}`);
});