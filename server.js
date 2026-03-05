const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

let messages = [];

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join', ({ username, role }) => {
    socket.username = username;
    socket.role = role || 'member';
    socket.emit('chat history', messages);
  });

  socket.on('chat message', (msgContent) => {
    const msg = {
      username: socket.username,
      role: socket.role,
      content: msgContent,
      timestamp: new Date()
    };
    messages.push(msg);
    io.emit('chat message', msg);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

// IMPORTANT: use dynamic port for deployment
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Chat server running on port ${PORT}`));