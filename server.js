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
  .then(async () => {
    console.log("✅ MongoDB connected");
	// 🔥 clean old messages once at startup
    for (const type of TYPES) {
      await trimByType(type, getLimitByType(type));
    }
   await Message.syncIndexes(); // ✅ TURN ON ONCE WHEN SCHEMA CHANGE 
  })
  .catch(err => console.error("❌ MongoDB error:", err));



// =====================
// 📦 MESSAGE SCHEMA
// =====================

const messageSchema = new mongoose.Schema({
  id: String,
  username: String,
  type: String, // 🔥 "chat", "announcement", "news", "system", etc.
  content: String,
  title: String, // ✅ for announcements/news
  replyTo: String,
  timestamp: Date,
  edited: Boolean,
  deleted: Boolean,
  reactions: Object
});

messageSchema.index({ type: 1, timestamp: -1 });
const Message = mongoose.model('Message', messageSchema);


// =====================
// AVATAR SCHEMA
// =====================
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  avatar: {type: String, default: "" },
  role: {type: String, default: "member" }, // "member", "admin", "moderator", etc.
  level: { type: Number, default: 0 },
  activity: { type: String, default: '' },
  rank: { type: String, default: "Beginner" },
  star: { type: Number, default: 0 },
  progress: { type: Number, default: 0 }

});

const User = mongoose.model('User', userSchema);

// =====================
// ⚙️ CONFIG
// =====================
let onlineUsers = 0;
let chatlimit = 300;
let postlimit = 50;
let newslimit = 50;

function getLimitByType(type) {
  const limits = {
    chat: chatlimit,
    announcement: postlimit,
    news: newslimit
  };

  return limits[type] ?? 100;
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
    console.log("Trim cycle completed");
  } catch (err) {
    console.error("Trim cycle error:", err);
  }
}, 20 * 60 * 1000); // 20 minutes




// =====================
// 🔌 SOCKET CONNECTION
// =====================
io.on('connection', (socket) => {
	
	

  // =====================
  // 🚪 JOIN
  // ===================== 
  socket.on('join', async (profile) => {
  try {
    if (!profile || !profile.username) return;
	
	const username = profile.username;
		socket.role = profile.role;
		socket.username = username;
		onlineUsers++;

    // =========================
    // 1. UPSERT FULL PROFILE
    // =========================
    await User.findOneAndUpdate(
      { username },
      {
        $set: {
          username: profile.username,
          role: profile.role,
          level: profile.level || 1,
          rank: profile.rank || "Beginner",
          activity: profile.activity || 0,
          star: profile.star || 0,
          progress: profile.progress || 0,
        }
      },
      { upsert: true, new: true }
    );

    // =========================
    // 2. LOAD ALL USERS (FULL PROFILE)
    // =========================
    const users = await User.find({});

    // =========================
    // 3. LOAD CHAT HISTORY
    // =========================
    const history = await Message.find()
      .sort({ timestamp: 1 })
      .limit(400);

    // =========================
    // 4. SEND INITIAL DATA
    // =========================
    socket.emit('initial data', {
      users,
      messages: history,
      online: onlineUsers
    });

    // =========================
    // 5. BROADCAST JOIN EVENT
    // =========================
    const joinMsg = {
     // role: "system",
      type: "connected",
      content: socket.username + " joined the chat",
      timestamp: new Date(),
      online: onlineUsers
    };

    socket.broadcast.emit('chat message', joinMsg);

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
     //   role: socket.role,
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
  // 🚪 UPDATE AVATAR
  // =====================
   socket.on("save avatar", async ({ username, avatar }) => {
	  try {
		if (!username || !avatar) return;

		// Update only avatar in DB
		await User.updateOne(
		  { username },
		  { $set: { avatar } }
		);

		// Broadcast only avatar update
		io.emit("avatar updated", {
		  username,
		  avatar
		});

	  } catch (err) {
		console.error("AVATAR UPDATE ERROR:", err);
	  }
});



  // =====================
  // 📢 CREATE ANNOUNCEMENT (ADMIN ONLY)
  // =====================
  socket.on('create announcement', async ({ title, content }) => {
   if (socket.role !== "Admin") return;
	  const msg = {
		id: Date.now() + "_" + Math.random(),
		username: socket.username,
	  //role: "Admin",
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
	//	role: "Admin",
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
          //  role: "system",
            type: "delete"
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
         // role: "system",
          type: "disconnected",
          content: socket.username + " left the chat",
          timestamp: new Date(),
		  online: onlineUsers
        };

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