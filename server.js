const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' }
});

let messages = [];
let onlineUsers = 0;

io.on('connection', (socket) => {

  // JOIN
  socket.on('join', ({ username, role }) => {

    socket.username = username || "Guest";
    socket.role = role || "member";

    onlineUsers++;

    socket.emit('chat history', messages);

    const joinMsg = {
      id: Date.now() + "_" + Math.random(),
      username: socket.username,
      role: "system",
      content: socket.username + " joined the community",
      timestamp: new Date(),
      online: onlineUsers,
      reactions: {}
    };

    messages.push(joinMsg);
    if (messages.length > 200) messages.shift();

    io.emit('chat message', joinMsg);

  });
  
  
  
  
// SEND MESSAGE
socket.on('chat message', (data) => {

  if (!socket.username) return;

  let content;
  let replyTo = null;

  // ✅ Handle both string and object formats
  if (typeof data === "string") {
    content = data.trim();
  } else {
    content = (data.content || "").trim();
    replyTo = data.replyTo || null;
  }

  if (!content) return;

  const msg = {
    id: Date.now() + "_" + Math.random(),
    username: socket.username,
    role: socket.role,
    content: content,
    replyTo: replyTo, // ✅ NEW
    timestamp: new Date(),
    reactions: {}
  };

  messages.push(msg);
  if (messages.length > 200) messages.shift();

  io.emit('chat message', msg);

});
  
  
  

  // DELETE MESSAGE
  socket.on('delete message', (msgId) => {

    const index = messages.findIndex(m => m.id === msgId);

    if (index === -1) return;

    // Only owner or admin can delete
    if (
      messages[index].username === socket.username ||
      socket.role === "Admin"
    ) {
      messages.splice(index, 1);
      io.emit('message deleted', msgId);
    }

  });

  // EDIT MESSAGE
  socket.on('edit message', ({ msgId, newContent }) => {

    const msg = messages.find(m => m.id === msgId);

    if (!msg) return;

    if (msg.username === socket.username) {

      msg.content = newContent;

      io.emit('message edited', {
        msgId,
        newContent
      });

    }

  });
  
 /* socket.on("message edited", (data) => {
  const msgEl = document.getElementById(`msg-${data.msgId}`);

  if (msgEl) {
    const textEl = msgEl.querySelector(".msg-text");

    textEl.innerText = data.newContent;

    // Add edited label if not already there
    if (!msgEl.querySelector(".edited-label")) {
      textEl.insertAdjacentHTML("afterend", '<span class="edited-label">(edited)</span>');
    }
  }
}); 
   */
  
  

  // REACT TO MESSAGE
  socket.on('react', ({ msgId, reaction }) => {

    const msg = messages.find(m => m.id === msgId);

    if (!msg) return;

    if (!msg.reactions[reaction]) {
      msg.reactions[reaction] = [];
    }

    // prevent duplicate reaction from same user
    if (!msg.reactions[reaction].includes(socket.username)) {
      msg.reactions[reaction].push(socket.username);
    }

    io.emit('message reaction', {
      msgId,
      reactions: msg.reactions
    });

  });

  // TYPING
  socket.on("typing", () => {
    if (!socket.username) return;
    socket.broadcast.emit("typing", { username: socket.username });
  });

  socket.on("stop typing", () => {
    if (!socket.username) return;
    socket.broadcast.emit("stop typing", { username: socket.username });
  });

  // DISCONNECT
  socket.on('disconnect', () => {

    onlineUsers = Math.max(onlineUsers - 1, 0);

    if (socket.username) {

      const leaveMsg = {
        id: Date.now() + "_" + Math.random(),
        username: "System",
        role: "system",
        content: socket.username + " left the community",
        timestamp: new Date(),
        online: onlineUsers,
        reactions: {}
      };

      messages.push(leaveMsg);
      if (messages.length > 200) messages.shift();

      io.emit('chat message', leaveMsg);
    }

  });

});

app.get('/', (req, res) => {
  res.send("Smart2z Community Chat Server Running");
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log("Chat server running on port " + PORT);
});