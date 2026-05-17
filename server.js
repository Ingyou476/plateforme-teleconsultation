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
    
    // Stocker le userId associé à ce socket
    socket.on('register-user', (userId) => {
        socket.userId = userId;
        socket.userName = null;
        console.log(`👤 Utilisateur ${userId} associé au socket ${socket.id}`);
    });
    
    // Enregistrer le nom de l'utilisateur
    socket.on('register-user-name', (data) => {
        socket.userId = data.userId;
        socket.userName = data.userName;
        socket.userRole = data.role;
        console.log(`👤 ${data.userName} (${data.role}) connecté avec socket ${socket.id}`);
    });
    
    // Patient demande un appel avec un médecin
    socket.on('call-doctor', (data) => {
        const { patientId, patientName, doctorId, doctorName } = data;
        console.log(`📞 Appel demandé: ${patientName} (${patientId}) -> ${doctorName} (${doctorId})`);
        
        // Stocker l'appel
        const callId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        activeCalls.set(callId, {
            callId,
            patientId,
            patientName,
            doctorId,
            doctorName,
            patientSocketId: socket.id,
            status: 'waiting',
            createdAt: new Date()
        });
        
        // Diffuser la demande à tous les médecins (ou spécifique)
        socket.broadcast.emit('incoming-call', {
            callId,
            patientId,
            patientName,
            doctorId,
            doctorName,
            fromSocketId: socket.id
        });
        
        // Confirmer au patient que la demande est envoyée
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
            
            console.log(`✅ Appel accepté: ${call.patientName} par ${doctorName}`);
            
            // Informer le patient que le médecin a accepté
            io.to(call.patientSocketId).emit('call-accepted', {
                callId,
                doctorId,
                doctorName,
                doctorSocketId: socket.id
            });
            
            // Informer le médecin qu'il peut procéder
            socket.emit('ready-for-webrtc', {
                callId,
                patientId: call.patientId,
                patientName: call.patientName,
                patientSocketId: call.patientSocketId
            });
        } else {
            socket.emit('call-error', { message: 'Appel plus disponible' });
        }
    });
    
    // Médecin refuse l'appel
    socket.on('reject-call', (data) => {
        const { callId, patientSocketId } = data;
        const call = activeCalls.get(callId);
        
        if (call) {
            io.to(patientSocketId).emit('call-rejected', { message: 'Le médecin n\'est pas disponible' });
            activeCalls.delete(callId);
        }
    });
    
    // --- OFFRE WebRTC (SDP) ---
    socket.on('webrtc-offer', (data) => {
        const { targetSocketId, offer } = data;
        console.log(`📤 Offer de ${socket.id} vers ${targetSocketId}`);
        io.to(targetSocketId).emit('webrtc-offer', {
            offer,
            fromSocketId: socket.id
        });
    });
    
    // --- RÉPONSE WebRTC (SDP Answer) ---
    socket.on('webrtc-answer', (data) => {
        const { targetSocketId, answer } = data;
        console.log(`📥 Answer de ${socket.id} vers ${targetSocketId}`);
        io.to(targetSocketId).emit('webrtc-answer', {
            answer,
            fromSocketId: socket.id
        });
    });
    
    // --- CANDIDAT ICE (pour traverser NAT/firewall) ---
    socket.on('webrtc-ice-candidate', (data) => {
        const { targetSocketId, candidate } = data;
        console.log(`🧊 ICE candidate de ${socket.id} vers ${targetSocketId}`);
        io.to(targetSocketId).emit('webrtc-ice-candidate', {
            candidate,
            fromSocketId: socket.id
        });
    });
    
    // Fin d'appel
    socket.on('end-call', (data) => {
        const { callId } = data;
        const call = activeCalls.get(callId);
        if (call) {
            console.log(`📞 Fin d'appel: ${call.patientName} - ${call.doctorName}`);
            if (call.patientSocketId) {
                io.to(call.patientSocketId).emit('call-ended');
            }
            if (call.doctorSocketId) {
                io.to(call.doctorSocketId).emit('call-ended');
            }
            activeCalls.delete(callId);
        }
    });
    
    // Envoi de données du capteur (télésurveillance)
    socket.on('sensor-data', (data) => {
        const { targetSocketId, sensorType, value, unit, timestamp } = data;
        io.to(targetSocketId).emit('sensor-data', {
            sensorType,
            value,
            unit,
            timestamp
        });
    });
    
    socket.on('disconnect', () => {
        console.log('🔴 Client déconnecté:', socket.id);
        // Nettoyer les appels en attente ou actifs
        for (const [callId, call] of activeCalls.entries()) {
            if (call.patientSocketId === socket.id || call.doctorSocketId === socket.id) {
                console.log(`🧹 Nettoyage appel ${callId}`);
                if (call.patientSocketId && call.patientSocketId !== socket.id) {
                    io.to(call.patientSocketId).emit('call-ended');
                }
                if (call.doctorSocketId && call.doctorSocketId !== socket.id) {
                    io.to(call.doctorSocketId).emit('call-ended');
                }
                activeCalls.delete(callId);
            }
        }
    });
});

// ============================================
// DÉMARRAGE DU SERVEUR
// ============================================

// Fonction pour obtenir l'IP locale
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
    console.log('========================================');
    console.log('📋 Pour tester entre deux ordinateurs :');
    console.log(`   1. Lancez ce serveur sur l\'ordinateur principal`);
    console.log(`   2. Sur l\'autre ordinateur, ouvrez http://${localIp}:${port}`);
    console.log(`   3. Connectez-vous (Patient sur un PC, Médecin sur l'autre)`);
    console.log(`   4. Lancez la consultation !`);
    console.log('========================================\n');
});