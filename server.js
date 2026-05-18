const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const socketIo = require('socket.io');
const os = require('os');

const app = express();
const port = 3443;

// ============================================
// CERTIFICATS SSL
// ============================================
const SSL_KEY_PATH = '/home/iut/certs/key.pem';
const SSL_CERT_PATH = '/home/iut/certs/cert.pem';

let privateKey, certificate;

try {
    privateKey = fs.readFileSync(SSL_KEY_PATH, 'utf8');
    certificate = fs.readFileSync(SSL_CERT_PATH, 'utf8');
    console.log('✅ Certificats SSL chargés');
} catch (error) {
    console.error('❌ Certificats SSL non trouvés !');
    console.error('Générez-les avec:');
    console.log('   mkdir -p ~/certs && cd ~/certs');
    console.log('   openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=192.168.23.129"');
    process.exit(1);
}

const credentials = { key: privateKey, cert: certificate };
const server = https.createServer(credentials, app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['websocket', 'polling']
});

// ============================================
// MIDDLEWARE DE SÉCURITÉ
// ============================================
app.use((req, res, next) => {
    // Headers de sécurité
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self)');
    next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// BASE DE DONNÉES
// ============================================

const users = [];

const doctors = [
    { id: '1', name: 'Dr. Sophie Martin', specialty: 'Médecine générale', avatar: '👩‍⚕️' },
    { id: '2', name: 'Dr. Thomas Durand', specialty: 'Cardiologie', avatar: '👨‍⚕️' },
    { id: '3', name: 'Dr. Claire Petit', specialty: 'Pédiatrie', avatar: '👩‍⚕️' },
    { id: '4', name: 'Dr. Marc Dubois', specialty: 'Dermatologie', avatar: '👨‍⚕️' },
    { id: '5', name: 'Dr. Laura Bernard', specialty: 'Neurologie', avatar: '👩‍⚕️' },
    { id: '6', name: 'Dr. Antoine Rousseau', specialty: 'Rhumatologie', avatar: '👨‍⚕️' },
];

const activeCalls = new Map();

// ============================================
// ROUTES API
// ============================================

app.get('/api/doctors', (req, res) => {
    res.json(doctors);
});

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
    
    console.log(`📝 Nouvel utilisateur: ${name} (${role})`);
    res.status(201).json({ success: true, message: 'Inscription réussie !' });
});

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
// SIGNALISATION WEBSOCKET
// ============================================

io.on('connection', (socket) => {
    console.log('🟢 Client connecté:', socket.id);
    
    socket.on('register-user-name', (data) => {
        socket.userId = data.userId;
        socket.userName = data.userName;
        socket.userRole = data.role;
        console.log(`👤 ${data.userName} (${data.role}) connecté`);
    });
    
    socket.on('call-doctor', (data) => {
        const { patientId, patientName, doctorId, doctorName } = data;
        console.log(`📞 Appel: ${patientName} -> ${doctorName}`);
        
        const callId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        activeCalls.set(callId, {
            callId, patientId, patientName, doctorId, doctorName,
            patientSocketId: socket.id, status: 'waiting'
        });
        
        socket.broadcast.emit('incoming-call', {
            callId, patientId, patientName, doctorId, doctorName, fromSocketId: socket.id
        });
        socket.emit('call-requested', { callId });
    });
    
    socket.on('accept-call', (data) => {
        const { callId, doctorId, doctorName, patientSocketId } = data;
        const call = activeCalls.get(callId);
        
        if (call && call.status === 'waiting') {
            call.status = 'accepted';
            call.doctorSocketId = socket.id;
            call.doctorName = doctorName;
            
            io.to(call.patientSocketId).emit('call-accepted', {
                callId, doctorId, doctorName, doctorSocketId: socket.id
            });
            socket.emit('ready-for-webrtc', {
                callId, patientId: call.patientId, patientName: call.patientName,
                patientSocketId: call.patientSocketId
            });
        }
    });
    
    socket.on('reject-call', (data) => {
        const { callId, patientSocketId } = data;
        io.to(patientSocketId).emit('call-rejected', { message: 'Médecin indisponible' });
        activeCalls.delete(callId);
    });
    
    socket.on('webrtc-offer', (data) => {
        io.to(data.targetSocketId).emit('webrtc-offer', { offer: data.offer, fromSocketId: socket.id });
    });
    
    socket.on('webrtc-answer', (data) => {
        io.to(data.targetSocketId).emit('webrtc-answer', { answer: data.answer, fromSocketId: socket.id });
    });
    
    socket.on('webrtc-ice-candidate', (data) => {
        io.to(data.targetSocketId).emit('webrtc-ice-candidate', { candidate: data.candidate, fromSocketId: socket.id });
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
        io.to(data.targetSocketId).emit('sensor-data', data);
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
// DÉMARRAGE
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
    console.log('🔒 SERVEUR HTTPS AVEC TURN/STUN');
    console.log('========================================');
    console.log(`📍 https://localhost:${port}`);
    console.log(`📍 https://${localIp}:${port}`);
    console.log('========================================');
    console.log('🔐 STUN/TURN:');
    console.log(`   stun:${localIp}:3478`);
    console.log(`   turn:${localIp}:3478 (patient/patient123)`);
    console.log('========================================\n');
});