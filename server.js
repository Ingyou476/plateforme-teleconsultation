const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const socketIo = require('socket.io');
const os = require('os');

const app = express();
const PORT = 3443;

// ---------- Certificats SSL ----------
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
const users = [];
const doctors = [];
const appointments = [];
const consultationHistory = [];  // historique des consultations terminées
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

// RDV PATIENT
app.get('/api/patients/:patientId/appointments', (req, res) => {
    res.json(appointments.filter(a => a.patientId === req.params.patientId));
});

// RDV MÉDECIN
app.get('/api/doctors/:doctorId/appointments', (req, res) => {
    res.json(appointments.filter(a => a.doctorId === req.params.doctorId));
});

// ANNULER RDV
app.delete('/api/appointments/:appointmentId', (req, res) => {
    const idx = appointments.findIndex(a => a.id === req.params.appointmentId);
    if (idx === -1) return res.status(404).json({ success: false });
    appointments.splice(idx, 1);
    res.json({ success: true });
});

// EXCEPTION (indisponibilité)
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

// HISTORIQUE CONSULTATIONS
app.get('/api/patients/:patientId/history', (req, res) => {
    res.json(consultationHistory.filter(h => h.patientId === req.params.patientId));
});

app.get('/api/doctors/:doctorId/history', (req, res) => {
    res.json(consultationHistory.filter(h => h.doctorId === req.params.doctorId));
});

// ENDPOINT FHIR Observation (pour la démonstration)
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
                coding: [{
                    system: "http://terminology.hl7.org/CodeSystem/observation-category",
                    code: "vital-signs",
                    display: "Vital Signs"
                }]
            }],
            code: {
                coding: [{
                    system: "http://loinc.org",
                    code: "8867-4",
                    display: "Heart rate"
                }],
                text: "Fréquence cardiaque"
            },
            subject: {
                reference: `Patient/${patientId}`,
                display: patientName
            },
            effectiveDateTime: now,
            valueQuantity: {
                value: heartRate,
                unit: "beats/minute",
                system: "http://unitsofmeasure.org",
                code: "/min"
            },
            interpretation: [{
                coding: [{
                    system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation",
                    code: heartRate < 60 ? "L" : heartRate > 100 ? "H" : "N",
                    display: heartRate < 60 ? "Low" : heartRate > 100 ? "High" : "Normal"
                }]
            }]
        });
    }

    if (temperature !== undefined) {
        observations.push({
            resourceType: "Observation",
            id: `temp-${Date.now()}`,
            status: "final",
            category: [{
                coding: [{
                    system: "http://terminology.hl7.org/CodeSystem/observation-category",
                    code: "vital-signs",
                    display: "Vital Signs"
                }]
            }],
            code: {
                coding: [{
                    system: "http://loinc.org",
                    code: "8310-5",
                    display: "Body temperature"
                }],
                text: "Température corporelle"
            },
            subject: {
                reference: `Patient/${patientId}`,
                display: patientName
            },
            effectiveDateTime: now,
            valueQuantity: {
                value: temperature,
                unit: "degree Celsius",
                system: "http://unitsofmeasure.org",
                code: "Cel"
            },
            interpretation: [{
                coding: [{
                    system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation",
                    code: temperature > 37.8 ? "H" : "N",
                    display: temperature > 37.8 ? "High" : "Normal"
                }]
            }]
        });
    }

    if (spo2 !== undefined) {
        observations.push({
            resourceType: "Observation",
            id: `spo2-${Date.now()}`,
            status: "final",
            category: [{
                coding: [{
                    system: "http://terminology.hl7.org/CodeSystem/observation-category",
                    code: "vital-signs",
                    display: "Vital Signs"
                }]
            }],
            code: {
                coding: [{
                    system: "http://loinc.org",
                    code: "2708-6",
                    display: "Oxygen saturation in Arterial blood"
                }],
                text: "Saturation en oxygène (SpO2)"
            },
            subject: {
                reference: `Patient/${patientId}`,
                display: patientName
            },
            effectiveDateTime: now,
            valueQuantity: {
                value: spo2,
                unit: "%",
                system: "http://unitsofmeasure.org",
                code: "%"
            },
            bodySite: {
                coding: [{
                    system: "http://snomed.info/sct",
                    code: "7569003",
                    display: "Finger structure"
                }]
            },
            interpretation: [{
                coding: [{
                    system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation",
                    code: spo2 < 95 ? "L" : "N",
                    display: spo2 < 95 ? "Low" : "Normal"
                }]
            }]
        });
    }

    res.json({ success: true, observations });
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

    // APPEL - Initiation par le médecin
    socket.on('call:request', (data) => {
        const { appointmentId, patientId, patientName, doctorId, doctorName } = data;
        const callId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
        activeCalls.set(callId, {
            callId, appointmentId, patientId, patientName, doctorId, doctorName,
            initiatorSocketId: socket.id,
            initiatorRole: socket.userRole,
            status: 'waiting',
            startTime: null
        });
        // Notifier le destinataire
        const targetId = socket.userRole === 'medecin' ? patientId : doctorId;
        io.to(`user-${targetId}`).emit('call:incoming', {
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
            call.acceptorSocketId = socket.id;
            call.startTime = new Date();
            
            // Notifier l'initiateur
            io.to(call.initiatorSocketId).emit('call:accepted', {
                callId, doctorId, doctorName, peerSocketId: socket.id
            });
            // Notifier l'accepteur
            socket.emit('webrtc:ready', {
                callId,
                patientId: call.patientId,
                patientName: call.patientName,
                peerSocketId: call.initiatorSocketId
            });
        }
    });

    socket.on('call:reject', (data) => {
        const { callId } = data;
        const call = activeCalls.get(callId);
        if (call) {
            io.to(call.initiatorSocketId).emit('call:rejected', { callId });
            activeCalls.delete(callId);
        }
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

    // Fin d'appel
    socket.on('call:end', (data) => {
        const call = activeCalls.get(data.callId);
        if (call) {
            // Sauvegarder dans l'historique
            consultationHistory.push({
                id: call.callId,
                patientId: call.patientId,
                patientName: call.patientName,
                doctorId: call.doctorId,
                doctorName: call.doctorName,
                startTime: call.startTime,
                endTime: new Date(),
                appointmentId: call.appointmentId
            });
            // Mettre à jour le statut du RDV
            const appt = appointments.find(a => a.id === call.appointmentId);
            if (appt) appt.status = 'completed';

            if (call.initiatorSocketId) io.to(call.initiatorSocketId).emit('call:ended');
            if (call.acceptorSocketId) io.to(call.acceptorSocketId).emit('call:ended');
            activeCalls.delete(data.callId);
        }
    });

    // Transfert des données capteur via socket (en temps réel vers le médecin)
    socket.on('sensor:data', (data) => {
        const { callId, heartRate, temperature, spo2 } = data;
        const call = activeCalls.get(callId);
        if (call) {
            // Envoyer les données aux deux participants
            if (call.initiatorSocketId) io.to(call.initiatorSocketId).emit('sensor:update', data);
            if (call.acceptorSocketId) io.to(call.acceptorSocketId).emit('sensor:update', data);
        }
    });

    socket.on('disconnect', () => {
        console.log('🔴 Déconnecté', socket.id);
        if (socket.userId) activeSessions.delete(socket.userId);
        for (const [callId, call] of activeCalls.entries()) {
            if (call.initiatorSocketId === socket.id || call.acceptorSocketId === socket.id) {
                const otherSocketId = call.initiatorSocketId === socket.id 
                    ? call.acceptorSocketId 
                    : call.initiatorSocketId;
                if (otherSocketId) io.to(otherSocketId).emit('call:ended');
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
    console.log(`📅 Calendrier, RDV, WebRTC avec TURN, FHIR actifs.\n`);
});
