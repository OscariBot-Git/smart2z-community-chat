// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' }
});

console.log("MONGO_URI:", process.env.MONGO_URI);

// =====================
// 🔗 MONGODB CONNECTION
// =====================
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/smart2z_chat';

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB error:", err));

// =====================
// 📦 MESSAGE SCHEMA
// =====================
const messageSchema = new mongoose.Schema({
  id: String,
  username: String,
  role: String,
  type: String,
  content: String,
  replyTo: String,
  timestamp: Date,
  edited: Boolean,
  deleted: Boolean,
  reactions: Object,
  online: Number
});

const Message = mongoose.model('Message', messageSchema);

// =====================
// ⚙️ CONFIG
// =====================
let onlineUsers = 0;
const MAX_MESSAGES = 200;

// =====================
// 🧹 AUTO CLEAN OLD MESSAGES
// =====================
async function trimMessages() {
  const count = await Message.countDocuments();
  if (count > MAX_MESSAGES) {
    const excess = count - MAX_MESSAGES;
    const old = await Message.find().sort({ timestamp: 1 }).limit(excess);
    const ids = old.map(m => m._id);
    await Message.deleteMany({ _id: { $in: ids } });
  }
}

// =====================
// 🔌 SOCKET CONNECTION
// =====================
io.on('connection', (socket) => {

  // =====================
  // 🚪 JOIN
  // =====================
  socket.on('join', async ({ username, role }) => {
    try {
      socket.username = username || "Guest";
      socket.role = role || "member";

      onlineUsers++;

      // Load chat history
      const history = await Message.find()
        .sort({ timestamp: 1 })
        .limit(MAX_MESSAGES);

      socket.emit('chat history', history);

      const joinMsg = {
        id: Date.now() + "_" + Math.random(),
        username: socket.username,
        role: "system",
        type: "user-join",
        content: socket.username + " joined the community",
        timestamp: new Date(),
        online: onlineUsers,
        reactions: {}
      };

      await Message.create(joinMsg);
      await trimMessages();

      io.emit('chat message', joinMsg);

    } catch (err) {
      console.error("JOIN ERROR:", err);
    }
  });

  // =====================
  // 💬 SEND MESSAGE
  // =====================
  socket.on('chat message', async (data) => {
    try {
      if (!socket.username) return;

      let content;
      let replyTo = null;

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
        type: "chat",
        content,
        replyTo,
        timestamp: new Date(),
        edited: false,
        reactions: {}
      };

      await Message.create(msg);
      await trimMessages();

      io.emit('chat message', msg);

    } catch (err) {
      console.error("SEND ERROR:", err);
    }
  });

  // =====================
  // ❌ DELETE MESSAGE
  // =====================
  socket.on('delete message', async (msgId) => {
    try {
      const msg = await Message.findOne({ id: msgId });
      if (!msg) return;

      if (msg.username === socket.username || socket.role === "Admin") {

        const newContent = socket.username + " deleted this message";

        await Message.updateOne(
          { id: msgId },
          {
            content: newContent,
            deleted: true,
            role: "system",
            type: "delete",
            online: onlineUsers
          }
        );

        io.emit('message deleted', {
          id: Date.now() + "_" + Math.random(),
          msgId,
          username: socket.username,
          content: newContent
        });
      }

    } catch (err) {
      console.error("DELETE ERROR:", err);
    }
  });

  // =====================
  // ✏️ EDIT MESSAGE
  // =====================
  socket.on('edit message', async ({ msgId, newContent }) => {
    try {
      let cleaned = (newContent || "").trim();
      if (!cleaned) return;

      const msg = await Message.findOne({ id: msgId });
      if (!msg) return;

      if (msg.username !== socket.username) return;
      if (cleaned === msg.content) return;

      await Message.updateOne(
        { id: msgId },
        {
          content: cleaned,
          edited: true
        }
      );

      io.emit('message edited', {
        msgId,
        newContent: cleaned,
        edited: true
      });

    } catch (err) {
      console.error("EDIT ERROR:", err);
    }
  });

  // =====================
  // 👍 REACTIONS
  // =====================
  socket.on('react', async ({ msgId, reaction }) => {
    try {
      const msg = await Message.findOne({ id: msgId });
      if (!msg) return;

      if (!msg.reactions) msg.reactions = {};

      if (!msg.reactions[reaction]) {
        msg.reactions[reaction] = [];
      }

      if (!msg.reactions[reaction].includes(socket.username)) {
        msg.reactions[reaction].push(socket.username);
      }

      await msg.save();

      io.emit('message reaction', {
        msgId,
        reactions: msg.reactions
      });

    } catch (err) {
      console.error("REACTION ERROR:", err);
    }
  });

  // =====================
  // ⌨️ TYPING
  // =====================
  socket.on("typing", () => {
    if (!socket.username) return;
    socket.broadcast.emit("typing", { username: socket.username });
  });

  socket.on("stop typing", () => {
    if (!socket.username) return;
    socket.broadcast.emit("stop typing", { username: socket.username });
  });

  // =====================
  // 🚪 DISCONNECT
  // =====================
  socket.on('disconnect', async () => {
    try {
      onlineUsers = Math.max(onlineUsers - 1, 0);

      if (socket.username) {
        const leaveMsg = {
          id: Date.now() + "_" + Math.random(),
          username: "System",
          role: "system",
          type: "user-left",
          content: socket.username + " left the community",
          timestamp: new Date(),
          online: onlineUsers,
          reactions: {}
        };

        await Message.create(leaveMsg);
        await trimMessages();

        io.emit('chat message', leaveMsg);
      }

    } catch (err) {
      console.error("DISCONNECT ERROR:", err);
    }
  });

});

// =====================
// 🌐 ROOT ROUTE
// =====================
app.get('/', (req, res) => {
  res.send("Smart2z Community Chat Server Running");
});

// =====================
// 🚀 START SERVER
// =====================
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log("Chat server running on port " + PORT);
});