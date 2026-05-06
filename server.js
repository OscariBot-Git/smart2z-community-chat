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
   /* await Message.syncIndexes(); // ✅ TURN ON ONCE WHEN SCHEMA CHANGE 
    await Meta.updateOne(
	  { key: "users_version" },
	  { $setOnInsert: { value: 1 } },
	  { upsert: true }
	); */
   
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
  role: {type: String, default: "member" } // "member", "admin", "moderator", etc.
});
const User = mongoose.model('User', userSchema);


// =====================
// VERSION SCHEMA
// =====================
const MetaSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  value: { type: Number, default: 1 }
});
const Meta = mongoose.model("Meta", MetaSchema);


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
  socket.on('join', async (username, clientVersion, lastMsgId) => {
  try {
    if (!username) return;

    socket.username = username;
    onlineUsers++;
	let user;
	
	if (clientVersion === 0) {
      user = await User.findOneAndUpdate(
        { username },
        { $setOnInsert: { username, avatar: "", role: "member" } },
        { upsert: true, new: true }
      ).lean();
    } else {
      user = await User.findOne(
        { username },
        { role: 1 }
      ).lean();
    }

    socket.role = user?.role || "member";
			
	 
       // Get global version
    const meta1 = await Meta.findOne({ key: "users_version" });
    const usersVersion = meta1?.value || 1;
	
		// Get news version
    const meta2 = await Meta.findOne({ key: "news_version" });
    const newsVersion = meta2?.value || 1;
	 
	 // Get news version
    const meta3 = await Meta.findOne({ key: "announcement_version" });
    const announcementVersion = meta3?.value || 1;


    let users = [];

    if (clientVersion !== usersVersion) {
      users = await User.find({},{ username: 1, avatar: 1, role: 1 }).lean();
    }

   // Fetch messages history
		let query = {
		  type: { $in: ["chat", "delete"] }
		};

		// returning user → only fetch new messages
		if (lastMsgId) {
		  query._id = { $gt: lastMsgId };
		}

		const history = await Message.find(query)
		  .sort({ timestamp: 1 })
		  .limit(400)
		  .lean();

    socket.emit('initial data', {
      users,
      usersVersion,
	  newsVersion,
	  announcementVersion,
      history,
      onlineUsers
    });

   const joinMsg = {
        role: "system",
        type: "connected",
        content: socket.username + " joined the chat",
        timestamp: new Date(),
        online: onlineUsers
      };

     // notify others users
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

    await User.updateOne(
      { username },
      { $set: { avatar } }
    );

    // 👇 increment + return updated version
    const meta = await Meta.findOneAndUpdate(
      { key: "users_version" },
      { $inc: { value: 1 } },
      { new: true, upsert: true }
    );

    const newversion = meta.value;

    io.emit("avatar updated", {username, avatar, newversion});

  } catch (err) {
    console.error("AVATAR UPDATE ERROR:", err);
  }
});

  // =====================
  // 🚪 UPDATE ROLE
  // =====================	  
	socket.on("save role", async ({ username, newrole }) => {
	  try {
		// ✅ Only Admin can update roles
		if (socket.role !== "Admin") return;
		


		// ✅ Update role correctly
		await User.updateOne(
		  { username },
		  { $set: { role: newrole } }
		);

		// ✅ Increment global users version
		const meta = await Meta.findOneAndUpdate(
		  { key: "users_version" },
		  { $inc: { value: 1 } },
		  { new: true, upsert: true }
		);

		const newversion = meta.value;

		// ✅ Emit correct data
		io.emit("role updated", {
		  username,
		  role: newrole,
		  newversion
		});

	  } catch (err) {
		console.error("ROLE UPDATE ERROR:", err);
	  }
	});
	

  // =====================
  // 📢 CREATE ANNOUNCEMENT (ADMIN ONLY)
  // =====================
  socket.on('create announcement', async ({ title, content }) => {
  try {
    if (socket.role !== "Admin") return;

    // 🔼 Increment version
    const meta = await Meta.findOneAndUpdate(
      { key: "announcement_version" },
      { $inc: { value: 1 } },
      { new: true, upsert: true }
    );

    const newVersion = meta.value;

    const msg = {
      username: socket.username,
      type: "news",
      title,
      content,
      timestamp: new Date(),
      edited: false,
      reactions: {}
    };

    const saved = await Message.create(msg);

  io.emit('announcement update', {version: newVersion, data: saved});
  } catch (err) {
    console.error("Create news error:", err);
  }
});


 // =====================
 // 📰 GET ANNOUNCEMENT
 // =====================
socket.on('get announcement', async ({ lastMsgId, clientVersion }) => {
  try {
    const meta = await Meta.findOne({ key: "announcement_version" });
    const serverVersion = meta?.value || 1;

    if (clientVersion === serverVersion) {
      return socket.emit('more news', {
        newversion: serverVersion,
        messages: []
      });
    }

    let query = { type: "announcement" };

    if (lastMsgId) {
      query._id = { $gt: lastMsgId };
    }

    const newannoucement = await Message.find(query)
      .sort({ timestamp: 1 })
      .limit(400)
      .lean();

    socket.emit('more announcement', {
      newversion: serverVersion,
      messages: newannoucement
    });

  } catch (err) {
    console.error("Get news error:", err);
  }
});
 
 
  // =====================
  // 📢 CREATE NEWS (ADMIN ONLY)
  // =====================
socket.on('create news', async ({ title, content }) => {
  try {
    if (socket.role !== "Admin") return;

    // 🔼 Increment version
    const meta = await Meta.findOneAndUpdate(
      { key: "news_version" },
      { $inc: { value: 1 } },
      { new: true, upsert: true }
    );

    const newVersion = meta.value;

    const msg = {
      username: socket.username,
      type: "news",
      title,
      content,
      timestamp: new Date(),
      edited: false,
      reactions: {}
    };

    const saved = await Message.create(msg);

  io.emit('news update', {version: newVersion, data: saved});
  } catch (err) {
    console.error("Create news error:", err);
  }
});

 
 // =====================
 // 📰 GET NEWS
 // =====================
socket.on('get news', async ({ lastMsgId, clientVersion }) => {
  try {
    const meta = await Meta.findOne({ key: "news_version" });
    const serverVersion = meta?.value || 1;

    if (clientVersion === serverVersion) {
      return socket.emit('more news', {
        newversion: serverVersion,
        messages: []
      });
    }

    let query = { type: "news" };

    if (lastMsgId) {
      query._id = { $gt: lastMsgId };
    }

    const newnews = await Message.find(query)
      .sort({ timestamp: 1 })
      .limit(400)
      .lean();

    socket.emit('more news', {
      newversion: serverVersion,
      messages: newnews
    });

  } catch (err) {
    console.error("Get news error:", err);
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
			  $set: {
				content: newContent,
				deleted: true,
				type: "delete"
			  }
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