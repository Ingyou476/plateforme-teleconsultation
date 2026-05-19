const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const socketIo = require('socket.io');
const os = require('os');

const app = express();
const PORT = 3443;

// Certificats SSL (à adapter si ton utilisateur n'est pas 'iut')
const SSL_KEY_PATH = '/home/iut/certs/key.pem';
const SSL_CERT_PATH = '/home/iut/certs/cert.pem';

try {
    fs.accessSync(SSL_KEY_PATH, fs.constants.R_OK);
    fs.accessSync(SSL_CERT_PATH, fs.constants.R_OK);
} catch (err) {
    console.error('❌ Certificats SSL non trouvés. Générez-les avec :');
    console.error('mkdir -p ~/certs && cd ~/certs');
    console.error('openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=192.168.23.129"');
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

// ============================================
// DONNÉES EN MÉMOIRE (simule une base)
// ============================================
const users = [];               // { id, name, email, password, role }
const doctors = [];             // { id, userId, name, specialty, description, defaultSchedule: { monday: [], tuesday: [], ... }, exceptions: [] }
const appointments = [];        // { id, patientId, patientName, doctorId, doctorName, start, end, status }
const activeSessions = new Map(); // userId -> socketId

// ============================================
// FONCTIONS UTILES
// ============================================
function findDoctorByUserId(userId) {
    return doctors.find(d => d.userId === userId);
}

function generateSlotsFromSchedule(doctorId, startDate, endDate) {
    // Pour simplifier : on génère des créneaux de 30 min sur les jours ouvrés 9h-18h
    // Côté front-end on affichera un calendrier ; ici on va plutôt créer des créneaux à la demande
    // pour éviter de stocker des millions de slots. On utilisera une fonction utilitaire.
    return []; // sera implémenté dans l'API
}

// ============================================
// API ROUTES
// ============================================

// 1. Inscription (patient ou médecin)
app.post('/api/register', (req, res) => {
    const { name, email, password, role, specialty, description, schedule } = req.body;
    if (!name || !email || !password || !role) {
        return res.status(400).json({ success: false, message: 'Champs manquants' });
    }
    if (users.find(u => u.email === email)) {
        return res.status(409).json({ success: false, message: 'Email déjà utilisé' });
    }
    const newUser = {
        id: Date.now().toString(),
        name, email, password, role
    };
    users.push(newUser);

    if (role === 'medecin') {
        if (!specialty) {
            return res.status(400).json({ success: false, message: 'Spécialité requise' });
        }
        // Structure par défaut des disponibilités (lundi-vendredi 9h-18h)
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
            defaultSchedule: schedule || defaultSchedule,
            exceptions: []  // liste de { date: 'YYYY-MM-DD', allDay: false, slots: [] } ou allDay: true
        });
    }

    console.log(`📝 Inscription: ${name} (${role})`);
    res.json({ success: true, message: 'Inscription réussie' });
});

// 2. Connexion
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    const user = users.find(u => u.email === email && u.password === password);
    if (!user) return res.status(401).json({ success: false, message: 'Identifiants invalides' });

    // Déconnexion de l'ancienne session si elle existe
    const oldSocketId = activeSessions.get(user.id);
    if (oldSocketId) {
        const oldSocket = io.sockets.sockets.get(oldSocketId);
        if (oldSocket) oldSocket.emit('force-logout', { message: 'Quelqu\'un s\'est connecté avec votre compte' });
        activeSessions.delete(user.id);
    }

    let doctorInfo = null;
    if (user.role === 'medecin') {
        doctorInfo = findDoctorByUserId(user.id);
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

// 3. Récupérer tous les médecins
app.get('/api/doctors', (req, res) => {
    const list = doctors.map(d => ({
        id: d.id,
        name: d.name,
        specialty: d.specialty,
        description: d.description
    }));
    res.json(list);
});

// 4. Récupérer les créneaux disponibles d'un médecin pour une date donnée
app.get('/api/doctors/:doctorId/slots', (req, res) => {
    const { doctorId } = req.params;
    const { date } = req.query; // format YYYY-MM-DD
    if (!date) return res.status(400).json({ success: false, message: 'Date manquante' });

    const doctor = doctors.find(d => d.id === doctorId);
    if (!doctor) return res.status(404).json({ success: false, message: 'Médecin introuvable' });

    const targetDate = new Date(date);
    const dayOfWeek = targetDate.toLocaleDateString('en-US', { weekday: 'lowercase' }); // 'monday', etc.
    const schedule = doctor.defaultSchedule[dayOfWeek];
    if (!schedule || !schedule.enabled) {
        return res.json([]); // pas de créneaux ce jour
    }

    // Vérifier si le médecin a une exception pour cette date
    const exception = doctor.exceptions.find(e => e.date === date);
    if (exception) {
        if (exception.allDay) return res.json([]);
        // si exception partielle, on ne gère pas ici pour simplifier (on pourrait affiner)
    }

    // Générer les créneaux de 30 min entre start et end
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
            // Vérifier si ce créneau n'est pas déjà réservé
            const alreadyBooked = appointments.some(a =>
                a.doctorId === doctorId &&
                a.start === slotStart.toISOString()
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

// 5. Prendre rendez-vous
app.post('/api/appointments', (req, res) => {
    const { patientId, patientName, doctorId, doctorName, start, end } = req.body;
    // Vérifier doublon
    const existing = appointments.find(a => a.doctorId === doctorId && a.start === start);
    if (existing) {
        return res.status(409).json({ success: false, message: 'Créneau déjà pris' });
    }
    const newAppointment = {
        id: Date.now().toString(),
        patientId,
        patientName,
        doctorId,
        doctorName,
        start,
        end,
        status: 'upcoming'
    };
    appointments.push(newAppointment);
    res.json({ success: true, appointment: newAppointment });
});

// 6. Récupérer les rendez-vous d'un patient
app.get('/api/patients/:patientId/appointments', (req, res) => {
    const { patientId } = req.params;
    const userAppointments = appointments.filter(a => a.patientId === patientId);
    res.json(userAppointments);
});

// 7. Récupérer les rendez-vous d'un médecin
app.get('/api/doctors/:doctorId/appointments', (req, res) => {
    const { doctorId } = req.params;
    const doctorAppointments = appointments.filter(a => a.doctorId === doctorId);
    res.json(doctorAppointments);
});

// 8. Annuler un rendez-vous
app.delete('/api/appointments/:appointmentId', (req, res) => {
    const { appointmentId } = req.params;
    const index = appointments.findIndex(a => a.id === appointmentId);
    if (index === -1) return res.status(404).json({ success: false });
    appointments.splice(index, 1);
    res.json({ success: true });
});

// 9. Mettre à jour les disponibilités du médecin (exceptions)
app.post('/api/doctors/:doctorId/exceptions', (req, res) => {
    const { doctorId } = req.params;
    const { date, allDay } = req.body;
    const doctor = doctors.find(d => d.id === doctorId);
    if (!doctor) return res.status(404).json({ success: false });
    if (!doctor.exceptions.find(e => e.date === date)) {
        doctor.exceptions.push({ date, allDay: allDay || false });
    }
    res.json({ success: true });
});

// ============================================
// WEBSOCKET (Signalisation WebRTC)
// ============================================
const activeCalls = new Map();

io.use((socket, next) => {
    // On peut ajouter une auth plus tard
    next();
});

io.on('connection', (socket) => {
    console.log('🟢 Client connecté', socket.id);

    socket.on('register', (data) => {
        const { userId, userName, role } = data;
        socket.userId = userId;
        socket.userName = userName;
        socket.userRole = role;
        // Enregistrer la session
        activeSessions.set(userId, socket.id);
        socket.join(`user-${userId}`);
        console.log(`✅ ${userName} (${role}) enregistré (socket ${socket.id})`);
    });

    // Patient demande un appel pour un rendez-vous spécifique
    socket.on('call:request', (data) => {
        const { appointmentId, patientId, patientName, doctorId, doctorName } = data;
        const callId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
        activeCalls.set(callId, {
            callId, appointmentId, patientId, patientName, doctorId, doctorName,
            patientSocketId: socket.id, status: 'waiting'
        });
        // Envoyer au médecin (à tous ses sockets, mais il n'y en a qu'un)
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
                callId, patientId: call.patientId, patientName: call.patientName,
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
        if (socket.userId) activeSessions.delete(socket.userId);
        // Nettoyer les appels en attente
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

// ============================================
// DÉMARRAGE
// ============================================
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