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
  username: String,
  role: String, // "member", "admin", "moderator", etc.
  type: String, // 🔥 "chat", "announcement", "news", "system", etc.
  content: String,
  title: String, // ✅ for announcements/news
  replyTo: String,
  timestamp: Date,
  edited: Boolean,
  deleted: Boolean,
  reactions: Object,
  online: Number
});

messageSchema.index({ type: 1, timestamp: -1 });

const Message = mongoose.model('Message', messageSchema);

await Message.syncIndexes();



// =====================
// ⚙️ CONFIG
// =====================
let onlineUsers = 0;

function getLimitByType(type) {
  const limits = {
    chat: 300,
    announcement: 50,
    news: 50
  };

  return limits[type] || 100;
}


// =====================
// 🧹 CLEAN OLD MESSAGES 
// =====================
async function trimByType(type, limit) {
  const old = await Message.find({ type })
    .sort({ timestamp: -1 }) // newest first
    .skip(limit)
    .select('_id');

  if (!old.length) return;

  const ids = old.map(m => m._id);
  await Message.deleteMany({ _id: { $in: ids } });
}

// =====================
// 🧹 AUTO CLEAN SCHEDULER
// =====================
const TYPES = ["chat", "announcement", "news"];
setInterval(async () => {
  try {
    for (const type of TYPES) {
      await trimByType(type, getLimitByType(type));
    }
  //  console.log("Trim cycle completed");
  } catch (err) {
    console.error("Trim cycle error:", err);
  }
}, 60000); // 60 seconds




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
        type: "connected",
        content: socket.username + " joined the chat",
        timestamp: new Date(),
        online: onlineUsers,
        reactions: {}
      };

    //  await Message.create(joinMsg);

      io.emit('chat message', joinMsg);
	  
	   // 🔥 Add to newsfeed
    //  addNews(socket.username + " joined the community", "update");


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
	  
      io.emit('chat message', msg);

    } catch (err) {
      console.error("SEND ERROR:", err);
    }
  });


   // =====================
  // 📢 GET CHAT
  // =====================
  socket.on('get chat', async () => {
     const history = await Message.find({type: {"chat" })
		.sort({ timestamp: 1 })
		.limit(MAX_MESSAGES);
	  socket.emit('chat history', history);
	 });


  // =====================
  // 📢 GET ANNOUNCEMENTS
  // =====================
 socket.on('get announcements', async () => {
  const posts = await Message.find({ type: "announcement" })
    .sort({ timestamp: 1 })
    .limit(MAX_MESSAGES);
  socket.emit('announcements', posts);
 });

  // =====================
  // 📰 GET NEWS
  // =====================
  socket.on('get news', async () => {
  const news = await Message.find({ type: "news" })
    .sort({ timestamp: 1 })
    .limit(MAX_MESSAGES);
  socket.emit('news', news);
 });

  // =====================
  // 📢 CREATE ANNOUNCEMENT (ADMIN ONLY)
  // =====================
  socket.on('create announcement', async ({ title, content }) => {
   if (socket.role !== "Admin") return;
	  const msg = {
		id: Date.now() + "_" + Math.random(),
		username: socket.username,
		role: "Admin",
		type: "announcement",
		title,
		content,
		timestamp: new Date(),
		edited: false,
		reactions: {}
	  };

  await Message.create(msg);

  io.emit('new announcement', msg);
 });
 
 // =====================
 // 📰 CREATE NEWS (ADMIN ONLY)
 // =====================
  socket.on('create news', async ({ title, content }) => {
   if (socket.role !== "Admin") return;
	  const msg = {
		id: Date.now() + "_" + Math.random(),
		username: socket.username,
		role: "Admin",
		type: "news",
		title,
		content,
		timestamp: new Date(),
		edited: false,
		reactions: {}
	  };

  await Message.create(msg);

   io.emit('news update', msg);
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
            type: "chat",
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
        msgId, newContent: cleaned, timestamp: msg.timestamp, edited: true});

    } catch (err) {
      console.error("EDIT ERROR:", err);
    }
  });
  

  // =====================
  // 👍 REACTIONS
  // =====================
	socket.on('react', async ({ msgId, reaction }) => { 
	  try {
		if (!socket.username) return;

		const username = socket.username;

		const msg = await Message.findOne({ id: msgId }).select('reactions');
		if (!msg) return;

		if (!msg.reactions) msg.reactions = {};

		const setUpdates = {};
		const unsetUpdates = {};

		// ✅ 🔥 TOGGLE: if user already reacted with same emoji → remove it
		if (msg.reactions[reaction]?.includes(username)) {

		  const filtered = msg.reactions[reaction].filter(
			user => user !== username
		  );

		  if (filtered.length > 0) {
			setUpdates[`reactions.${reaction}`] = filtered;
		  } else {
			unsetUpdates[`reactions.${reaction}`] = "";
		  }

		  const updateOps = {};
		  if (Object.keys(setUpdates).length > 0) updateOps.$set = setUpdates;
		  if (Object.keys(unsetUpdates).length > 0) updateOps.$unset = unsetUpdates;

		  if (Object.keys(updateOps).length > 0) {
			await Message.updateOne({ id: msgId }, updateOps);
		  }

		  const updatedMsg = await Message.findOne({ id: msgId }).select('reactions');

		  return io.emit('message reaction', {
			msgId,
			reactions: updatedMsg.reactions || {}
		  });
		}

		// ✅ Remove user from all other reactions
		for (let emoji in msg.reactions) {
		  if (msg.reactions[emoji].includes(username)) {

			const filtered = msg.reactions[emoji].filter(
			  user => user !== username
			);

			if (filtered.length > 0) {
			  setUpdates[`reactions.${emoji}`] = filtered;
			} else {
			  unsetUpdates[`reactions.${emoji}`] = "";
			}
		  }
		}

		const updateOps = {};
		if (Object.keys(setUpdates).length > 0) updateOps.$set = setUpdates;
		if (Object.keys(unsetUpdates).length > 0) updateOps.$unset = unsetUpdates;

		if (Object.keys(updateOps).length > 0) {
		  await Message.updateOne({ id: msgId }, updateOps);
		}

		// ✅ Add new reaction
		await Message.updateOne(
		  { id: msgId },
		  {
			$addToSet: {
			  [`reactions.${reaction}`]: username
			}
		  }
		);

		// ✅ Emit updated reactions
		const updatedMsg = await Message.findOne({ id: msgId }).select('reactions');

		io.emit('message reaction', {
		  msgId,
		  reactions: updatedMsg.reactions || {}
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
          username: "Smart2z",
          role: "system",
          type: "disconnected",
          content: socket.username + " left the chat",
          timestamp: new Date(),
          online: onlineUsers,
          reactions: {}
        };

      //  await Message.create(leaveMsg);

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