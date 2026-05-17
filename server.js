const express = require('express');
const http = require('http');
const path = require('path');
const socketIo = require('socket.io');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const port = 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// BASE DE DONNÉES EN MÉMOIRE
// ============================================

const users = [];

// Annuaire des médecins
const doctors = [
    { id: '1', name: 'Dr. Sophie Martin', specialty: 'Médecine générale', avatar: '👩‍⚕️', disponible: true },
    { id: '2', name: 'Dr. Thomas Durand', specialty: 'Cardiologie', avatar: '👨‍⚕️', disponible: true },
    { id: '3', name: 'Dr. Claire Petit', specialty: 'Pédiatrie', avatar: '👩‍⚕️', disponible: true },
    { id: '4', name: 'Dr. Marc Dubois', specialty: 'Dermatologie', avatar: '👨‍⚕️', disponible: true },
    { id: '5', name: 'Dr. Laura Bernard', specialty: 'Neurologie', avatar: '👩‍⚕️', disponible: true },
    { id: '6', name: 'Dr. Antoine Rousseau', specialty: 'Rhumatologie', avatar: '👨‍⚕️', disponible: true },
];

// Suivi des appels actifs
const activeCalls = new Map();

// ============================================
// ROUTES API
// ============================================

// Récupérer la liste des médecins
app.get('/api/doctors', (req, res) => {
    res.json(doctors);
});

// Inscription
app.post('/api/register', (req, res) => {
    const { name, email, password, role } = req.body;
    
    if (!name || !email || !password || !role) {
        return res.status(400).json({ success: false, message: 'Tous les champs sont requis.' });
    }
    
    if (role !== 'patient' && role !== 'medecin') {
        return res.status(400).json({ success: false, message: 'Rôle invalide.' });
    }
    
    const existingUser = users.find(u => u.email === email);
    if (existingUser) {
        return res.status(409).json({ success: false, message: 'Cet email est déjà utilisé.' });
    }
    
    const newUser = {
        id: Date.now().toString(),
        name,
        email,
        password,
        role
    };
    users.push(newUser);
    
    console.log(`📝 Nouvel utilisateur: ${name} (${role}) - ID: ${newUser.id}`);
    res.status(201).json({ success: true, message: 'Inscription réussie !' });
});

// Connexion
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    const user = users.find(u => u.email === email && u.password === password);
    
    if (!user) {
        return res.status(401).json({ success: false, message: 'Email ou mot de passe invalide.' });
    }
    
    console.log(`🔐 Connexion: ${user.name} (${user.role})`);
    res.json({
        success: true,
        user: {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role
        }
    });
});

// ============================================
// SIGNALISATION WEBSOCKET (Socket.IO)
// ============================================

io.on('connection', (socket) => {
    console.log('🟢 Nouveau client connecté:', socket.id);
    
    socket.on('register-user-name', (data) => {
        socket.userId = data.userId;
        socket.userName = data.userName;
        socket.userRole = data.role;
        console.log(`👤 ${data.userName} (${data.role}) connecté`);
    });
    
    // Patient demande un appel
    socket.on('call-doctor', (data) => {
        const { patientId, patientName, doctorId, doctorName } = data;
        console.log(`📞 Appel demandé: ${patientName} -> ${doctorName}`);
        
        const callId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        activeCalls.set(callId, {
            callId,
            patientId,
            patientName,
            doctorId,
            doctorName,
            patientSocketId: socket.id,
            status: 'waiting'
        });
        
        socket.broadcast.emit('incoming-call', {
            callId,
            patientId,
            patientName,
            doctorId,
            doctorName,
            fromSocketId: socket.id
        });
        
        socket.emit('call-requested', { callId, status: 'waiting' });
    });
    
    // Médecin accepte l'appel
    socket.on('accept-call', (data) => {
        const { callId, doctorId, doctorName, patientSocketId } = data;
        const call = activeCalls.get(callId);
        
        if (call && call.status === 'waiting') {
            call.status = 'accepted';
            call.doctorSocketId = socket.id;
            call.doctorName = doctorName;
            
            io.to(call.patientSocketId).emit('call-accepted', {
                callId,
                doctorId,
                doctorName,
                doctorSocketId: socket.id
            });
            
            socket.emit('ready-for-webrtc', {
                callId,
                patientId: call.patientId,
                patientName: call.patientName,
                patientSocketId: call.patientSocketId
            });
        }
    });
    
    socket.on('reject-call', (data) => {
        const { callId, patientSocketId } = data;
        io.to(patientSocketId).emit('call-rejected', { message: 'Le médecin n\'est pas disponible' });
        activeCalls.delete(callId);
    });
    
    // WebRTC Signalisation
    socket.on('webrtc-offer', (data) => {
        io.to(data.targetSocketId).emit('webrtc-offer', {
            offer: data.offer,
            fromSocketId: socket.id
        });
    });
    
    socket.on('webrtc-answer', (data) => {
        io.to(data.targetSocketId).emit('webrtc-answer', {
            answer: data.answer,
            fromSocketId: socket.id
        });
    });
    
    socket.on('webrtc-ice-candidate', (data) => {
        io.to(data.targetSocketId).emit('webrtc-ice-candidate', {
            candidate: data.candidate,
            fromSocketId: socket.id
        });
    });
    
    socket.on('end-call', (data) => {
        const call = activeCalls.get(data.callId);
        if (call) {
            if (call.patientSocketId) io.to(call.patientSocketId).emit('call-ended');
            if (call.doctorSocketId) io.to(call.doctorSocketId).emit('call-ended');
            activeCalls.delete(data.callId);
        }
    });
    
    socket.on('sensor-data', (data) => {
        io.to(data.targetSocketId).emit('sensor-data', {
            sensorType: data.sensorType,
            value: data.value,
            unit: data.unit,
            timestamp: data.timestamp,
            fhirResource: data.fhirResource
        });
    });
    
    socket.on('disconnect', () => {
        console.log('🔴 Client déconnecté:', socket.id);
        for (const [callId, call] of activeCalls.entries()) {
            if (call.patientSocketId === socket.id || call.doctorSocketId === socket.id) {
                activeCalls.delete(callId);
            }
        }
    });
});

// ============================================
// DÉMARRAGE DU SERVEUR
// ============================================

function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const net of interfaces[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                return net.address;
            }
        }
    }
    return 'localhost';
}

server.listen(port, '0.0.0.0', () => {
    const localIp = getLocalIp();
    console.log('\n========================================');
    console.log('🚀 SERVEUR DÉMARRÉ AVEC SUCCÈS !');
    console.log('========================================');
    console.log(`📍 Accès local : http://localhost:${port}`);
    console.log(`📍 Sur le réseau : http://${localIp}:${port}`);
    console.log('========================================\n');
});