const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const socketIo = require('socket.io');
const os = require('os');

const app = express();
const PORT = 3443;

// Certificats SSL
const SSL_KEY_PATH = '/home/iut/certs/key.pem';
const SSL_CERT_PATH = '/home/iut/certs/cert.pem';
const credentials = {
    key: fs.readFileSync(SSL_KEY_PATH, 'utf8'),
    cert: fs.readFileSync(SSL_CERT_PATH, 'utf8')
};

const server = https.createServer(credentials, app);
const io = socketIo(server, { cors: { origin: "*" }, transports: ['websocket', 'polling'] });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// BASES DE DONNÉES (mémoire)
// ============================================

const users = [];           // tous les utilisateurs
const doctors = [];         // infos spécifiques médecins (avec userId)
const slots = [];           // créneaux
const appointments = [];    // rendez-vous

// Helper : trouver un médecin par userId
function findDoctorByUserId(userId) {
    return doctors.find(d => d.userId === userId);
}

// Helper : trouver les créneaux d'un médecin
function getSlotsByDoctorId(doctorId) {
    return slots.filter(s => s.doctorId === doctorId);
}

// ============================================
// ROUTES API
// ============================================

// 1. Inscription (patient ou médecin)
app.post('/api/register', (req, res) => {
    const { name, email, password, role, specialty, description } = req.body;
    if (!name || !email || !password || !role) {
        return res.status(400).json({ success: false, message: 'Champs requis' });
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
            description: description || ''
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
    let doctorInfo = null;
    if (user.role === 'medecin') {
        doctorInfo = findDoctorByUserId(user.id);
    }
    res.json({
        success: true,
        user: { id: user.id, name: user.name, email: user.email, role: user.role, doctorId: doctorInfo?.id || null }
    });
});

// 3. Récupérer la liste des médecins (avec leurs spécialités)
app.get('/api/doctors', (req, res) => {
    const doctorList = doctors.map(d => ({
        id: d.id,
        name: d.name,
        specialty: d.specialty,
        description: d.description
    }));
    res.json(doctorList);
});

// 4. Récupérer les créneaux disponibles d'un médecin (non réservés)
app.get('/api/doctors/:doctorId/slots', (req, res) => {
    const { doctorId } = req.params;
    const doctor = doctors.find(d => d.id === doctorId);
    if (!doctor) return res.status(404).json({ success: false, message: 'Médecin non trouvé' });
    const availableSlots = slots.filter(s => s.doctorId === doctorId && !s.isBooked);
    res.json(availableSlots);
});

// 5. Créer un créneau (par le médecin)
app.post('/api/slots', (req, res) => {
    const { doctorId, startTime, durationMinutes } = req.body;
    const doctor = doctors.find(d => d.id === doctorId);
    if (!doctor) return res.status(404).json({ success: false, message: 'Médecin inconnu' });
    const endTime = new Date(new Date(startTime).getTime() + durationMinutes * 60000).toISOString();
    const newSlot = {
        id: Date.now().toString(),
        doctorId,
        startTime,
        endTime,
        isBooked: false,
        patientId: null
    };
    slots.push(newSlot);
    res.json({ success: true, slot: newSlot });
});

// 6. Prendre rendez-vous (patient)
app.post('/api/appointments', (req, res) => {
    const { patientId, patientName, doctorId, slotId } = req.body;
    const slot = slots.find(s => s.id === slotId);
    if (!slot) return res.status(404).json({ success: false, message: 'Créneau inexistant' });
    if (slot.isBooked) return res.status(409).json({ success: false, message: 'Créneau déjà réservé' });
    slot.isBooked = true;
    slot.patientId = patientId;
    const newAppointment = {
        id: Date.now().toString(),
        patientId,
        patientName,
        doctorId,
        slotId,
        startTime: slot.startTime,
        endTime: slot.endTime,
        status: 'upcoming'
    };
    appointments.push(newAppointment);
    res.json({ success: true, appointment: newAppointment });
});

// 7. Récupérer les rendez-vous d'un patient
app.get('/api/patients/:patientId/appointments', (req, res) => {
    const { patientId } = req.params;
    const patientAppointments = appointments.filter(a => a.patientId === patientId);
    res.json(patientAppointments);
});

// 8. Récupérer les rendez-vous d'un médecin
app.get('/api/doctors/:doctorId/appointments', (req, res) => {
    const { doctorId } = req.params;
    const doctorAppointments = appointments.filter(a => a.doctorId === doctorId);
    res.json(doctorAppointments);
});

// 9. Annuler un rendez-vous (patient)
app.delete('/api/appointments/:appointmentId', (req, res) => {
    const { appointmentId } = req.params;
    const index = appointments.findIndex(a => a.id === appointmentId);
    if (index === -1) return res.status(404).json({ success: false });
    const appt = appointments[index];
    const slot = slots.find(s => s.id === appt.slotId);
    if (slot) {
        slot.isBooked = false;
        slot.patientId = null;
    }
    appointments.splice(index, 1);
    res.json({ success: true });
});

// ============================================
// WEBSOCKET (Signalisation WebRTC + appel)
// ============================================

const activeCalls = new Map();

io.on('connection', (socket) => {
    console.log('🟢 Client connecté', socket.id);
    socket.on('register', (data) => {
        socket.userId = data.userId;
        socket.userName = data.userName;
        socket.userRole = data.role;
    });

    // Patient demande un appel pour un rendez-vous spécifique
    socket.on('call:request', (data) => {
        const { appointmentId, patientId, patientName, doctorId, doctorName } = data;
        const callId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
        activeCalls.set(callId, {
            callId, appointmentId, patientId, patientName, doctorId, doctorName,
            patientSocketId: socket.id, status: 'waiting'
        });
        // Notifier le médecin (tous ses sockets)
        socket.broadcast.emit('call:incoming', {
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

    // WebRTC signalisation
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
                activeCalls.delete(callId);
            }
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    const ifaces = os.networkInterfaces();
    let ip = 'localhost';
    Object.keys(ifaces).forEach(ifname => {
        ifaces[ifname].forEach(iface => {
            if (iface.family === 'IPv4' && !iface.internal) ip = iface.address;
        });
    });
    console.log(`\n🔒 Serveur démarré sur https://${ip}:${PORT}\n`);
});