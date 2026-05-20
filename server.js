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
    res.setHeader("X-Frame-Options", "DENY"); 
    res.setHeader("X-Content-Type-Options", "nosniff"); 
    res.setHeader("X-XSS-Protection", "1; mode=block"); 
    res.setHeader("Content-Security-Policy", "default-src 'self' https://stun.l.google.com:19302; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss: https:; video-src 'self' blob:; font-src 'self';");
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains"); 
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
const consultationHistory = []; [cite: 130]
const activeSessions = new Map();
const securityLogs = [];

// ---------- Réponses Configuration 2FA Admin ----------
const ADMIN_2FA_ANSWERS = {
    q1: "yaziz",
    q2: "pure",
    q3: "abon"
};

function logActivity(userId, username, role, action, status, details, reqOrSocket = null) {
    let ip = "0.0.0.0";
    if (reqOrSocket) {
        if (reqOrSocket.handshake) {
            ip = reqOrSocket.handshake.address || "0.0.0.0";
        } else {
            ip = reqOrSocket.headers['x-forwarded-for'] || reqOrSocket.socket.remoteAddress || "0.0.0.0";
        }
        if (ip.substr(0, 7) == "::ffff:") ip = ip.substr(7); 
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
    securityLogs.unshift(logEntry); 
    if (securityLogs.length > 500) securityLogs.pop(); 

    io.to('role-admin').emit('admin:new-log', logEntry);
}

// ---------- Routes API ----------

// INSCRIPTION [cite: 19, 21]
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

// CONNEXION ÉTAPE 1 [cite: 19, 22]
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    const user = users.find(u => u.email === email && u.password === password);
    
    if (!user) {
        logActivity(null, email, 'Inconnu', 'CONNEXION', false, 'Identifiants erronés ou tentative malveillante', req);
        return res.status(401).json({ success: false, message: 'Identifiants invalides' });
    }

    // Si c'est l'administrateur, déclencher l'exigence du second facteur (2FA)
    if (user.role === 'admin') {
        logActivity(user.id, user.name, user.role, '2FA_REQUIS', true, 'Première étape validée, en attente du second facteur de sécurité', req);
        return res.json({ success: true, requires2FA: true, userId: user.id });
    }

    completeSessionCreation(user, req, res);
});

// CONNEXION ÉTAPE 2 (Vérification des questions secrètes de l'admin)
app.post('/api/login/verify-2fa', (req, res) => {
    const { userId, answer1, answer2, answer3 } = req.body;
    const user = users.find(u => u.id === userId);

    if (!user || user.role !== 'admin') {
        return res.status(400).json({ success: false, message: 'Requête d\'authentification invalide' });
    }

    const formatAns = (str) => String(str || '').trim().toLowerCase();

    if (formatAns(answer1) === ADMIN_2FA_ANSWERS.q1 &&
        formatAns(answer2) === ADMIN_2FA_ANSWERS.q2 &&
        formatAns(answer3) === ADMIN_2FA_ANSWERS.q3) {
        
        logActivity(user.id, user.name, user.role, '2FA_SUCCESS', true, 'Double authentification validée avec succès', req);
        completeSessionCreation(user, req, res);
    } else {
        logActivity(user.id, user.name, user.role, '2FA_FAILED', false, 'Échec de la validation 2FA : réponses incorrectes', req);
        res.status(401).json({ success: false, message: 'Réponses aux questions de sécurité incorrectes.' });
    }
});

function completeSessionCreation(user, req, res) {
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

    logActivity(user.id, user.name, user.role, 'CONNEXION', true, 'Authentification complète réussie', req);
    
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
app.get('/api/admin/logs', (req, res) => res.json(securityLogs));
app.get('/api/admin/users', (req, res) => res.json(users.map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role }))));

// LISTE DES MÉDECINS [cite: 28, 30]
app.get('/api/doctors', (req, res) => {
    res.json(doctors.map(d => ({ id: d.id, name: d.name, specialty: d.specialty, description: d.description })));
});

// CRÉNEAUX DISPONIBLES
app.get('/api/doctors/:doctorId/slots', (req, res) => {
    const { doctorId } = req.params; const { date } = req.query;
    if (!date) return res.status(400).json({ success: false, message: 'Date manquante' });
    const doctor = doctors.find(d => d.id === doctorId);
    if (!doctor) return res.status(404).json([]);

    const targetDate = new Date(date);
    const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const dayOfWeek = dayNames[targetDate.getDay()];
    const schedule = doctor.defaultSchedule[dayOfWeek];
    if (!schedule || !schedule.enabled) return res.json([]);

    const slots = [];
    const [startHour, startMin] = schedule.start.split(':').map(Number);
    const [endHour, endMin] = schedule.end.split(':').map(Number);
    let current = new Date(targetDate); current.setHours(startHour, startMin, 0, 0);
    const end = new Date(targetDate); end.setHours(endHour, endMin, 0, 0);

    while (current < end) {
        const slotStart = new Date(current);
        const slotEnd = new Date(current.getTime() + schedule.slotDuration * 60000);
        if (slotEnd <= end) {
            const alreadyBooked = appointments.some(a => a.doctorId === doctorId && a.start === slotStart.toISOString() && a.status !== 'cancelled');
            if (!alreadyBooked) {
                slots.push({
                    start: slotStart.toISOString(), end: slotEnd.toISOString(),
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
    const newAppointment = { id: Date.now().toString(), patientId, patientName, doctorId, doctorName, start, end, status: 'upcoming' };
    appointments.push(newAppointment);
    logActivity(patientId, patientName, 'patient', 'RDV_CREATE', true, `Rendez-vous pris avec le Dr. ${doctorName}`);
    res.json({ success: true, appointment: newAppointment });
});

app.get('/api/patients/:patientId/appointments', (req, res) => res.json(appointments.filter(a => a.patientId === req.params.patientId)));
app.get('/api/doctors/:doctorId/appointments', (req, res) => res.json(appointments.filter(a => a.doctorId === req.params.doctorId)));

// ENDPOINT FHIR Observation [cite: 56, 58]
app.post('/api/fhir/observation', (req, res) => {
    const { patientId, patientName, heartRate, temperature, spo2 } = req.body;
    const now = new Date().toISOString(); const observations = [];

    if (heartRate !== undefined) {
        observations.push({
            resourceType: "Observation", id: `hr-${Date.now()}`, status: "final",
            category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs", display: "Vital Signs" }] }],
            code: { coding: [{ system: "http://loinc.org", code: "8867-4", display: "Heart rate" }], text: "Fréquence cardiaque" }, [cite: 59]
            subject: { reference: `Patient/${patientId}`, display: patientName }, effectiveDateTime: now,
            valueQuantity: { value: heartRate, unit: "beats/minute", system: "http://unitsofmeasure.org", code: "/min" },
            interpretation: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation", code: heartRate < 60 ? "L" : heartRate > 100 ? "H" : "N", display: heartRate < 60 ? "Low" : heartRate > 100 ? "High" : "Normal" }] }]
        });
    }
    if (temperature !== undefined) {
        observations.push({
            resourceType: "Observation", id: `temp-${Date.now()}`, status: "final",
            category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs", display: "Vital Signs" }] }],
            code: { coding: [{ system: "http://loinc.org", code: "8310-5", display: "Body temperature" }], text: "Température corporelle" }, [cite: 59]
            subject: { reference: `Patient/${patientId}`, display: patientName }, effectiveDateTime: now,
            valueQuantity: { value: temperature, unit: "degree Celsius", system: "http://unitsofmeasure.org", code: "Cel" },
            interpretation: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation", code: temperature > 37.8 ? "H" : "N", display: temperature > 37.8 ? "High" : "Normal" }] }]
        });
    }
    if (spo2 !== undefined) {
        observations.push({
            resourceType: "Observation", id: `spo2-${Date.now()}`, status: "final",
            category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs", display: "Vital Signs" }] }],
            code: { coding: [{ system: "http://loinc.org", code: "2708-6", display: "Oxygen saturation in Arterial blood" }], text: "Saturation en oxygène (SpO2)" }, [cite: 59]
            subject: { reference: `Patient/${patientId}`, display: patientName }, effectiveDateTime: now,
            valueQuantity: { value: spo2, unit: "%", system: "http://unitsofmeasure.org", code: "%" },
            bodySite: { coding: [{ system: "http://snomed.info/sct", code: "7569003", display: "Finger structure" }] }, [cite: 59]
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
        socket.userId = data.userId; socket.userName = data.userName; socket.userRole = data.role;
        activeSessions.set(data.userId, socket.id); socket.join(`user-${data.userId}`);
        if(data.role === 'admin') socket.join('role-admin');
        logActivity(data.userId, data.userName, data.role, 'WS_CONNECT', true, 'Session socket en ligne', socket);
    });

    socket.on('call:request', (data) => {
        const { appointmentId, patientId, patientName, doctorId, doctorName } = data;
        const callId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
        activeCalls.set(callId, { callId, appointmentId, patientId, patientName, doctorId, doctorName, initiatorSocketId: socket.id, initiatorRole: socket.userRole, status: 'waiting', startTime: null });
        const targetId = socket.userRole === 'medecin' ? patientId : doctorId;
        io.to(`user-${targetId}`).emit('call:incoming', { callId, appointmentId, patientId, patientName, doctorId, doctorName, fromSocketId: socket.id });
        socket.emit('call:requested', { callId });
        logActivity(socket.userId, socket.userName, socket.userRole, 'WEBRTC_CALL_INIT', true, `Initiation d'appel (ID: ${callId})`, socket);
    });

    socket.on('call:accept', (data) => {
        const { callId, doctorId, doctorName, patientSocketId } = data; const call = activeCalls.get(callId);
        if (call && call.status === 'waiting') {
            call.status = 'accepted'; call.acceptorSocketId = socket.id; call.startTime = new Date();
            io.to(call.initiatorSocketId).emit('call:accepted', { callId, doctorId, doctorName, peerSocketId: socket.id });
            socket.emit('webrtc:ready', { callId, patientId: call.patientId, patientName: call.patientName, peerSocketId: call.initiatorSocketId });
            logActivity(socket.userId, socket.userName, socket.userRole, 'WEBRTC_CALL_ACCEPT', true, `Appel accepté pour la session ${callId}`, socket);
        }
    });

    socket.on('call:reject', (data) => {
        const call = activeCalls.get(data.callId);
        if (call) {
            io.to(call.initiatorSocketId).emit('call:rejected', { callId: data.callId }); activeCalls.delete(data.callId);
            logActivity(socket.userId, socket.userName, socket.userRole, 'WEBRTC_CALL_REJECT', true, `Appel refusé (Session ${data.callId})`, socket);
        }
    });

    socket.on('webrtc:offer', (data) => { io.to(data.targetSocketId).emit('webrtc:offer', { offer: data.offer, fromSocketId: socket.id }); });
    socket.on('webrtc:answer', (data) => { io.to(data.targetSocketId).emit('webrtc:answer', { answer: data.answer, fromSocketId: socket.id }); });
    socket.on('webrtc:ice-candidate', (data) => { io.to(data.targetSocketId).emit('webrtc:ice-candidate', { candidate: data.candidate, fromSocketId: socket.id }); });

    socket.on('call:end', (data) => {
        const call = activeCalls.get(data.callId);
        if (call) {
            consultationHistory.push({ id: call.callId, patientId: call.patientId, patientName: call.patientName, doctorId: call.doctorId, doctorName: call.doctorName, startTime: call.startTime, endTime: new Date(), appointmentId: call.appointmentId });
            const appt = appointments.find(a => a.id === call.appointmentId); if (appt) appt.status = 'completed';
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
    users.push({ id: "admin-1337", name: "Cyber Admin", email: "admin@cyber.fr", password: "admincyberpass", role: "admin" });
    console.log(`\n🔒 Serveur Sécurisé HTTPS démarré sur https://${ip}:${PORT}`);
    console.log(`🛡️  Double authentification (2FA Questions) & Audit Trail synchronisés.`);
});