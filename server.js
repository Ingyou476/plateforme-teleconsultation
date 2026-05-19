const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const socketIo = require('socket.io');
const os = require('os');

const app = express();
const PORT = 3443;

// Certificats SSL (modifie le chemin si ton utilisateur n'est pas 'iut')
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
// DONNÉES EN MÉMOIRE
// ============================================
const users = [];               // { id, name, email, password, role }
const doctors = [];             // { id, userId, name, specialty, description, exceptions: [date] }
const appointments = [];        // { id, patientId, patientName, doctorId, doctorName, start, end, status }
const activeSessions = new Map(); // userId -> socketId

// ============================================
// FONCTIONS UTILES
// ============================================
function findDoctorByUserId(userId) {
    return doctors.find(d => d.userId === userId);
}

// Génère les créneaux disponibles pour un médecin à une date donnée
function getAvailableSlotsForDate(doctorId, dateStr) {
    const doctor = doctors.find(d => d.id === doctorId);
    if (!doctor) return [];

    // Vérifier exception (indisponibilité totale)
    if (doctor.exceptions && doctor.exceptions.includes(dateStr)) {
        return [];
    }

    // Par défaut : jours ouvrés lun-ven 9h-18h, créneaux de 30 min
    const targetDate = new Date(dateStr);
    const dayOfWeek = targetDate.getDay(); // 0 dimanche, 1 lundi...
    if (dayOfWeek === 0 || dayOfWeek === 6) return []; // weekend

    const slots = [];
    const startHour = 9, startMin = 0;
    const endHour = 18, endMin = 0;
    let current = new Date(targetDate);
    current.setHours(startHour, startMin, 0, 0);
    const end = new Date(targetDate);
    end.setHours(endHour, endMin, 0, 0);

    while (current < end) {
        const slotStart = new Date(current);
        const slotEnd = new Date(current.getTime() + 30 * 60000);
        if (slotEnd <= end) {
            // Vérifier si déjà réservé
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
        current = new Date(current.getTime() + 30 * 60000);
    }
    return slots;
}

// ============================================
// API ROUTES
// ============================================

// 1. Inscription
app.post('/api/register', (req, res) => {
    const { name, email, password, role, specialty, description } = req.body;
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
        doctors.push({
            id: Date.now().toString(),
            userId: newUser.id,
            name: newUser.name,
            specialty,
            description: description || '',
            exceptions: []   // liste des dates "YYYY-MM-DD" où le médecin est indisponible
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

    // Déconnexion de l'ancienne session
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

// 3. Liste des médecins
app.get('/api/doctors', (req, res) => {
    const list = doctors.map(d => ({
        id: d.id,
        name: d.name,
        specialty: d.specialty,
        description: d.description
    }));
    res.json(list);
});

// 4. Créneaux disponibles pour un médecin à une date
app.get('/api/doctors/:doctorId/slots', (req, res) => {
    const { doctorId } = req.params;
    const { date } = req.query;
    if (!date) return res.status(400).json({ success: false, message: 'Date manquante' });
    const slots = getAvailableSlotsForDate(doctorId, date);
    res.json(slots);
});

// 5. Prendre rendez-vous
app.post('/api/appointments', (req, res) => {
    const { patientId, patientName, doctorId, doctorName, start, end } = req.body;
    // Vérifier doublon
    const existing = appointments.find(a => a.doctorId === doctorId && a.start === start);
    if (existing) {
        return res.status(409).json({ success: false, message: 'Créneau déjà réservé' });
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

// 6. Rendez-vous d'un patient
app.get('/api/patients/:patientId/appointments', (req, res) => {
    const { patientId } = req.params;
    const patientAppointments = appointments.filter(a => a.patientId === patientId);
    res.json(patientAppointments);
});

// 7. Rendez-vous d'un médecin
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

// 9. Ajouter une exception (indisponibilité) pour un médecin
app.post('/api/doctors/:doctorId/exceptions', (req, res) => {
    const { doctorId } = req.params;
    const { date } = req.body;
    const doctor = doctors.find(d => d.id === doctorId);
    if (!doctor) return res.status(404).json({ success: false });
    if (!doctor.exceptions.includes(date)) {
        doctor.exceptions.push(date);
    }
    res.json({ success: true });
});

// ============================================
// WEBSOCKET (Signalisation WebRTC)
// ============================================
const activeCalls = new Map();

io.on('connection', (socket) => {
    console.log('🟢 Client connecté', socket.id);

    socket.on('register', (data) => {
        const { userId, userName, role } = data;
        socket.userId = userId;
        socket.userName = userName;
        socket.userRole = role;
        activeSessions.set(userId, socket.id);
        socket.join(`user-${userId}`);
        console.log(`✅ ${userName} (${role}) enregistré`);
    });

    // Patient demande un appel pour un rendez-vous
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
    console.log(`📅 Calendrier, prise de RDV, WebRTC avec TURN actif.\n`);
});