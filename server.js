const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*"
    }
});

app.use(express.static(path.join(__dirname, 'public')));

const users = {};

io.on('connection', (socket) => {

    console.log('Utilisateur connecté :', socket.id);

    socket.on('join-user', (data) => {

        users[socket.id] = {
            name: data.name,
            role: data.role
        };

        io.emit('users-list', users);
    });

    socket.on('call-user', (data) => {

        io.to(data.target).emit('incoming-call', {
            offer: data.offer,
            from: socket.id,
            callerName: data.callerName
        });
    });

    socket.on('answer-call', (data) => {

        io.to(data.target).emit('call-answered', {
            answer: data.answer
        });
    });

    socket.on('ice-candidate', (data) => {

        io.to(data.target).emit('ice-candidate', {
            candidate: data.candidate
        });
    });

    socket.on('sensor-data', (data) => {

        io.emit('sensor-update', data);
    });

    socket.on('disconnect', () => {

        delete users[socket.id];

        io.emit('users-list', users);

        console.log('Utilisateur déconnecté');
    });
});

const PORT = 3000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
});