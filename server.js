const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const socketIo = require('socket.io');
const os = require('os');

const app = express();
const PORT = 3443;

// ---------- En-têtes de Sécurité (Cybersecurity) ----------
app.use((req, res, next) => {
    res.setHeader("X-Frame-Options", "DENY"); // Protège contre le Clickjacking
    res.setHeader("X-Content-Type-Options", "nosniff"); // Évite le MIME sniffing
    res.setHeader("X-XSS-Protection", "1; mode=block"); // Protection XSS basique pour navigateurs anciens
    res.setHeader("Content-Security-Policy", "default-src 'self' https://stun.l.google.com:19302; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss: https:; video-src 'self' blob:; font-src 'self';");
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains"); // Force le HTTPS
    next();
});

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
const consultationHistory = [];
const activeSessions = new Map();

// --- Système de Logs d'Audit (Cybersecurity Monitoring) ---
const securityLogs = [];

function logActivity(userId, username, role, action, status, details, reqOrSocket = null) {
    let ip = "0.0.0.0";
    if (reqOrSocket) {
        if (reqOrSocket.handshake) {
            ip = reqOrSocket.handshake.address || "0.0.0.0";
        } else {
            ip = reqOrSocket.headers['x-forwarded-for'] || reqOrSocket.socket.remoteAddress || "0.0.0.0";
        }
        if (ip.substr(0, 7) == "::ffff:") ip = ip.substr(7); // Nettoyage IPv6
        if (ip === "::1") ip = "127.0.0.1";
    }
    const logEntry = {
        id: `log-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
        timestamp: new Date().toISOString(),
        userId: userId || 'system',
        username: username || 'Système',
        role: role || 'Système',
        action,
        status: status ? 'SUCCESS' : 'FAILED',
        details,
        ip
    };
    securityLogs.unshift(logEntry); // Placer le plus récent en premier
    if (securityLogs.length > 500) securityLogs.pop(); // Limite mémoire

    // Diffusion en direct aux administrateurs connectés
    io.to('role-admin').emit('admin:new-log', logEntry);
}

// --- Configuration des réponses 2FA Admin ---
const ADMIN_2FA_ANSWERS = {
    q1: "yaziz",
    q2: "pure",
    q3: "abon"
};

// ---------- Routes API ----------

// INSCRIPTION
app.post('/api/register', (req, res) => {
    const { name, email, password, role, specialty, description } = req.body;
    if (!name || !email || !password || !role) {
        logActivity(null, email, role, 'INSCRIPTION', false, 'Champs requis manquants', req);
        return res.status(400).json({ success: false, message: 'Champs requis manquants' });
    }
    if (users.find(u => u.email === email)) {
        logActivity(null, email, role, 'INSCRIPTION', false, 'Conflit : Email déjà utilisé', req);
        return res.status(409).json({ success: false, message: 'Email déjà utilisé' });
    }
    
    const newUser = { id: Date.now().toString(), name, email, password, role };
    users.push(newUser);

    if (role === 'medecin') {
        if (!specialty) {
            logActivity(newUser.id, name, role, 'INSCRIPTION', false, 'Spécialité manquante pour médecin', req);
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

    logActivity(newUser.id, name, role, 'INSCRIPTION', true, 'Compte utilisateur créé avec succès', req);
    res.json({ success: true, message: 'Inscription réussie' });
});

// CONNEXION - ÉTAPE 1
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    const user = users.find(u => u.email === email && u.password === password);
    
    if (!user) {
        logActivity(null, email, 'Inconnu', 'CONNEXION', false, 'Identifiants erronés ou tentative malveillante', req);
        return res.status(401).json({ success: false, message: 'Identifiants invalides' });
    }

    // Détection Admin pour enclencher le 2FA
    if (user.role === 'admin') {
        logActivity(user.id, user.name, user.role, '2FA_REQUIS', true, 'Première étape validée, en attente des questions secrètes', req);
        return res.json({ success: true, requires2FA: true, userId: user.id });
    }

    completeLoginWorkflow(user, req, res);
});

// CONNEXION - ÉTAPE 2 (Validation Questions 2FA Admin)
app.post('/api/login/verify-2fa', (req, res) => {
    const { userId, answer1, answer2, answer3 } = req.body;
    const user = users.find(u => u.id === userId);

    if (!user || user.role !== 'admin') {
        return res.status(400).json({ success: false, message: 'Requête invalide' });
    }

    const clean = (str) => String(str || '').trim().toLowerCase();

    if (clean(answer1) === ADMIN_2FA_ANSWERS.q1 &&
        clean(answer2) === ADMIN_2FA_ANSWERS.q2 &&
        clean(answer3) === ADMIN_2FA_ANSWERS.q3) {
        
        logActivity(user.id, user.name, user.role, '2FA_SUCCESS', true, 'Double authentification validée avec succès', req);
        completeLoginWorkflow(user, req, res);
    } else {
        logActivity(user.id, user.name, user.role, '2FA_FAILED', false, 'Échec validation 2FA : réponses fausses', req);
        res.status(401).json({ success: false, message: 'Réponses secrètes incorrectes.' });
    }
});

function completeLoginWorkflow(user, req, res) {
    const oldSocketId = activeSessions.get(user.id);
    if (oldSocketId) {
        const oldSocket = io.sockets.sockets.get(oldSocketId);
        if (oldSocket) oldSocket.emit('force-logout', { message: 'Connexion depuis un autre appareil' });
        activeSessions.delete(user.id);
        logActivity(user.id, user.name, user.role, 'SESSION', true, 'Ancienne session déconnectée (Sécurité multi-compte)', req);
    }

    let doctorInfo = null;
    if (user.role === 'medecin') {
        doctorInfo = doctors.find(d => d.userId === user.id);
    }

    logActivity(user.id, user.name, user.role, 'CONNEXION', true, 'Authentification réussie', req);
    
    res.json({
        success: true,
        requires2FA: false,
        user: {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            doctorId: doctorInfo?.id || null
        }
    });
}

// --- ROUTES APIS RESERVÉES ADMIN ---
app.get('/api/admin/logs', (req, res) => {
    res.json(securityLogs);
});

app.get('/api/admin/users', (req, res) => {
    res.json(users.map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role })));
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
    logActivity(patientId, patientName, 'patient', 'RDV_CREATE', true, `Rendez-vous pris avec le Dr. ${doctorName}`);
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
    const appt = appointments[idx];
    appointments.splice(idx, 1);
    logActivity(appt.patientId, appt.patientName, 'patient', 'RDV_CANCEL', true, `Rendez-vous annulé avec Dr. ${appt.doctorName}`);
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
    logActivity(doctor.userId, doctor.name, 'medecin', 'DISPO_EXCEPTION', true, `Indisponibilité ajoutée pour le ${date}`);
    res.json({ success: true });
});

// HISTORIQUE CONSULTATIONS
app.get('/api/patients/:patientId/history', (req, res) => {
    res.json(consultationHistory.filter(h => h.patientId === req.params.patientId));
});

app.get('/api/doctors/:doctorId/history', (req, res) => {
    res.json(consultationHistory.filter(h => h.doctorId === req.params.doctorId));
});

// ENDPOINT FHIR Observation
app.post('/api/fhir/observation', (req, res) => {
    const { patientId, patientName, heartRate, temperature, spo2 } = req.body;
    const now = new Date().toISOString();
    const observations = [];

    if (heartRate !== undefined) {
        observations.push({
            resourceType: "Observation", id: `hr-${Date.now()}`, status: "final",
            category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs", display: "Vital Signs" }] }],
            code: { coding: [{ system: "http://loinc.org", code: "8867-4", display: "Heart rate" }], text: "Fréquence cardiaque" },
            subject: { reference: `Patient/${patientId}`, display: patientName }, effectiveDateTime: now,
            valueQuantity: { value: heartRate, unit: "beats/minute", system: "http://unitsofmeasure.org", code: "/min" },
            interpretation: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation", code: heartRate < 60 ? "L" : heartRate > 100 ? "H" : "N", display: heartRate < 60 ? "Low" : heartRate > 100 ? "High" : "Normal" }] }]
        });
    }

    if (temperature !== undefined) {
        observations.push({
            resourceType: "Observation", id: `temp-${Date.now()}`, status: "final",
            category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs", display: "Vital Signs" }] }],
            code: { coding: [{ system: "http://loinc.org", code: "8310-5", display: "Body temperature" }], text: "Température corporelle" },
            subject: { reference: `Patient/${patientId}`, display: patientName }, effectiveDateTime: now,
            valueQuantity: { value: temperature, unit: "degree Celsius", system: "http://unitsofmeasure.org", code: "Cel" },
            interpretation: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation", code: temperature > 37.8 ? "H" : "N", display: temperature > 37.8 ? "High" : "Normal" }] }]
        });
    }

    if (spo2 !== undefined) {
        observations.push({
            resourceType: "Observation", id: `spo2-${Date.now()}`, status: "final",
            category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs", display: "Vital Signs" }] }],
            code: { coding: [{ system: "http://loinc.org", code: "2708-6", display: "Oxygen saturation in Arterial blood" }], text: "Saturation en oxygène (SpO2)" },
            subject: { reference: `Patient/${patientId}`, display: patientName }, effectiveDateTime: now,
            valueQuantity: { value: spo2, unit: "%", system: "http://unitsofmeasure.org", code: "%" },
            bodySite: { coding: [{ system: "http://snomed.info/sct", code: "7569003", display: "Finger structure" }] },
            interpretation: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation", code: spo2 < 95 ? "L" : "N", display: spo2 < 95 ? "Low" : "Normal" }] }]
        });
    }

    logActivity(patientId, patientName, 'patient', 'FHIR_EXPORT', true, `Ressources FHIR Observation générées.`);
    res.json({ success: true, observations });
});

// ---------- WebSocket (signalisation WebRTC) ----------
const activeCalls = new Map();

io.on('connection', (socket) => {
    socket.on('register', (data) => {
        socket.userId = data.userId;
        socket.userName = data.userName;
        socket.userRole = data.role;
        activeSessions.set(data.userId, socket.id);
        socket.join(`user-${data.userId}`);
        
        if(data.role === 'admin') {
            socket.join('role-admin');
        }
        
        logActivity(data.userId, data.userName, data.role, 'WS_CONNECT', true, 'Session socket en ligne', socket);
    });

    // APPEL
    socket.on('call:request', (data) => {
        const { appointmentId, patientId, patientName, doctorId, doctorName } = data;
        const callId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
        activeCalls.set(callId, {
            callId, appointmentId, patientId, patientName, doctorId, doctorName,
            initiatorSocketId: socket.id, initiatorRole: socket.userRole, status: 'waiting', startTime: null
        });
        
        const targetId = socket.userRole === 'medecin' ? patientId : doctorId;
        io.to(`user-${targetId}`).emit('call:incoming', {
            callId, appointmentId, patientId, patientName, doctorId, doctorName, fromSocketId: socket.id
        });
        socket.emit('call:requested', { callId });
        logActivity(socket.userId, socket.userName, socket.userRole, 'WEBRTC_CALL_INIT', true, `Initiation d'appel (ID: ${callId})`, socket);
    });

    socket.on('call:accept', (data) => {
        const { callId, doctorId, doctorName, patientSocketId } = data;
        const call = activeCalls.get(callId);
        if (call && call.status === 'waiting') {
            call.status = 'accepted';
            call.acceptorSocketId = socket.id;
            call.startTime = new Date();
            
            io.to(call.initiatorSocketId).emit('call:accepted', { callId, doctorId, doctorName, peerSocketId: socket.id });
            socket.emit('webrtc:ready', { callId, patientId: call.patientId, patientName: call.patientName, peerSocketId: call.initiatorSocketId });
            logActivity(socket.userId, socket.userName, socket.userRole, 'WEBRTC_CALL_ACCEPT', true, `Appel accepté pour la session ${callId}`, socket);
        }
    });

    socket.on('call:reject', (data) => {
        const { callId } = data;
        const call = activeCalls.get(callId);
        if (call) {
            io.to(call.initiatorSocketId).emit('call:rejected', { callId });
            activeCalls.delete(callId);
            logActivity(socket.userId, socket.userName, socket.userRole, 'WEBRTC_CALL_REJECT', true, `Appel refusé pour la session ${callId}`, socket);
        }
    });

    // Signalisation WebRTC
    socket.on('webrtc:offer', (data) => { io.to(data.targetSocketId).emit('webrtc:offer', { offer: data.offer, fromSocketId: socket.id }); });
    socket.on('webrtc:answer', (data) => { io.to(data.targetSocketId).emit('webrtc:answer', { answer: data.answer, fromSocketId: socket.id }); });
    socket.on('webrtc:ice-candidate', (data) => { io.to(data.targetSocketId).emit('webrtc:ice-candidate', { candidate: data.candidate, fromSocketId: socket.id }); });

    // Fin d'appel
    socket.on('call:end', (data) => {
        const call = activeCalls.get(data.callId);
        if (call) {
            consultationHistory.push({
                id: call.callId, patientId: call.patientId, patientName: call.patientName,
                doctorId: call.doctorId, doctorName: call.doctorName, startTime: call.startTime, endTime: new Date(), appointmentId: call.appointmentId
            });
            const appt = appointments.find(a => a.id === call.appointmentId);
            if (appt) appt.status = 'completed';

            if (call.initiatorSocketId) io.to(call.initiatorSocketId).emit('call:ended');
            if (call.acceptorSocketId) io.to(call.acceptorSocketId).emit('call:ended');
            activeCalls.delete(data.callId);
            logActivity(socket.userId, socket.userName, socket.userRole, 'WEBRTC_CALL_END', true, `Fin de téléconsultation (Session ${data.callId})`, socket);
        }
    });

    socket.on('sensor:data', (data) => {
        const call = activeCalls.get(data.callId);
        if (call) {
            if (call.initiatorSocketId) io.to(call.initiatorSocketId).emit('sensor:update', data);
            if (call.acceptorSocketId) io.to(call.acceptorSocketId).emit('sensor:update', data);
        }
    });

    socket.on('disconnect', () => {
        if (socket.userId) {
            activeSessions.delete(socket.userId);
            logActivity(socket.userId, socket.userName, socket.userRole, 'WS_DISCONNECT', true, 'Session déconnectée', socket);
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
    
    // Injection du compte administrateur par défaut
    users.push({
        id: "admin-1337",
        name: "Cyber Admin",
        email: "admin@cyber.fr",
        password: "admincyberpass",
        role: "admin"
    });

    console.log(`\n🔒 Serveur Securisé HTTPS démarré sur https://${ip}:${PORT}`);
    console.log(`🛡️  Fonctionnalités Cyber: CSP, X-Frame-Options, HSTS, 2FA par Questions & Audit Trail actifs.`);
    console.log(`👤 Compte Admin Démo : admin@cyber.fr / admincyberpass\n`);
});