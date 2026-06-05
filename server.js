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
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/smart2z_chat";
mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log("✅ MongoDB connected");

    // =====================
    // INIT META KEYS
    // =====================
    await Meta.findOneAndUpdate(
      { key: "chat_version" },
      { $setOnInsert: { value: 0 } },
      { upsert: true }
    );

    await Meta.findOneAndUpdate(
      { key: "users_version" },
      { $setOnInsert: { value: 0 } },
      { upsert: true }
    );

    await Meta.findOneAndUpdate(
      { key: "oldest_available_version" },
      { $setOnInsert: { value: 0 } },
      { upsert: true }
    );

    // =====================
    // CLEANUP ON START
    // =====================
    for (const type of TYPES) {
      await trimByType(type, getLimitByType(type));
    }

    // OPTIONAL: recompute oldest version after cleanup
    const oldest = await Message.findOne()
      .sort({ version: 1 })
      .select("version")
      .lean();

    await Meta.findOneAndUpdate(
      { key: "oldest_available_version" },
      { value: oldest?.version ?? 0 },
      { upsert: true }
    );

  })
  .catch(err => console.error("❌ MongoDB error:", err));


// =====================
// ⚙️ CONFIG
// =====================
const onlineUsers = new Set();

let chatlimit = 300;
let postlimit = 50;
let newslimit = 50;
let totallimit = chatlimit + postlimit + newslimit;

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
    .select("_id");

  if (!old.length) return;

  const ids = old.map(m => m._id);

  await Message.deleteMany({ _id: { $in: ids } });

  // update oldest version AFTER cleanup
  const oldest = await Message.findOne()
    .sort({ version: 1 })
    .select("version")
    .lean();

  await Meta.findOneAndUpdate(
    { key: "oldest_available_version" },
    { value: oldest?.version ?? 0 },
    { upsert: true }
  );
}


// =====================
// 🧹 AUTO CLEANER
// =====================
const TYPES = ["chat", "announcement", "news"];
setInterval(async () => {
  try {
    for (const type of TYPES) {
      await trimByType(type, getLimitByType(type));
    }
    console.log("Hourly trim cycle completed");
  } catch (err) {
    console.error("Trim cycle error:", err);
  }
}, 60 * 60 * 1000);



// =====================
// 📦 CHAT SCHEMA
// =====================
const messageSchema = new mongoose.Schema({
  id: String, username: String,
  type: { type: String, enum: ["chat", "news", "announcement", "system", "delete"]},
  content: String,
  title: String,
  replyTo: String,
  timestamp: {type: Date, default: Date.now, index: true},
  edited: {type: Boolean,default: false},
  deleted: {type: Boolean,default: false},
  reactions: {type: Object,default: {}},
  version: {type: Number,index: true,required: true}
});
messageSchema.index({ version: 1 });
const Message = mongoose.model("Message", messageSchema);


// =====================
// USERS SCHEMA
// =====================
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  avatar: { type: String, default: "" },
  role: { type: String, default: "member" },
  lastSeen: { type: Date, default: null }
});
const User = mongoose.model("User", userSchema);

// =====================
// GLOBAL VERSION SCHEMA
// =====================
const MetaSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  value: { type: Number, default: 0 }
});
const Meta = mongoose.model("Meta", MetaSchema);

// =====================
// VERSION HELPER
// =====================
async function nextChatVersion() {
  const meta = await Meta.findOneAndUpdate(
    { key: "chat_version" },
    { $inc: { value: 1 } },
    { new: true, upsert: true }
  );
  return meta.value;
}

// =====================
// OLD VERSION HELPER
// =====================
async function getOldestAvailableVersion() {
  const meta = await Meta.findOne({
    key: "oldest_available_version"
  }).lean();

  return meta?.value ?? 0;
}



// =====================
//  SOCKET CONNECTION
// =====================	
io.on("connection", (socket) => {
	
  // =====================
  //  JOIN
  // ===================== 
  socket.on("join", async (username, clientChatVersion, clientUsersVersion) => {
    try {
      if (!username) return;

      socket.username = username;
      onlineUsers.add(username);

      // =====================
      // USER LOAD / CREATE
      // =====================
      let user = await User.findOne({ username });
      let isNewUser = false;
	  
      if (!user) {
        user = await User.create({
          username,
          avatar: "",
          role: "member"
        });
		
		isNewUser = true;
		
		  // increment users version
		  await Meta.findOneAndUpdate(
			{ key: "users_version" },
			{ $inc: { value: 1 } },
			{ upsert: true }
		  );
		}
      
      socket.role = user.role;

      // =====================
      // META LOAD
      // =====================
      const chatMeta = await Meta.findOne({ key: "chat_version" }).lean();
      const usersMeta = await Meta.findOne({ key: "users_version" }).lean();

      const chatVersion = chatMeta?.value ?? 0;
      const usersVersion = usersMeta?.value ?? 0;

      const oldestAvailableVersion = await getOldestAvailableVersion();	  

      // =====================
      // USERS SYNC
      // =====================
      let users = [];

       if (!clientUsersVersion || clientUsersVersion !== usersVersion) {
		  users = await User.find(
			{},
			{ username: 1, avatar: 1, role: 1, lastSeen: 1 }
		  ).lean();
        }


      // =====================
      // MESSAGE SYNC 
      // =====================
      let messages = [];
      let isFreshBoot = false;
      if (!clientChatVersion || clientChatVersion < oldestAvailableVersion) {
        // FULL BOOTSTRAP
        messages = await Message.find({})
          .sort({ version: 1 })
          .limit(totallimit)
          .lean();
		 isFreshBoot = true;
      } else {
        // DELTA SYNC
        messages = await Message.find({
          version: { $gt: Number(clientChatVersion) }
        })
          .sort({ version: 1 })
          .limit(totallimit)
          .lean();
      }


    // =====================
    // RESPONSE
    // =====================
    socket.emit("initial data", {
      users,
      usersVersion,
      chatVersion,
      messages,
      online: onlineUsers.size,
	  isFreshBoot
	  
    });

    // =====================
    // JOIN EVENT
    // =====================
    const joinMsg = {
      id: Date.now() + "_" + Math.random(),
      type: "system",
      content: `${username} joined the chat`,
      timestamp: new Date(),
      online: onlineUsers.size
    };

    // only send user data if a NEW user was created
    if (isNewUser) {
      joinMsg.newuser = username;
      joinMsg.newuserrole = user.role;
      joinMsg.usersVersion = usersVersion;
    }

    socket.broadcast.emit("join chat", joinMsg);

    } catch (err) {
      console.error("JOIN ERROR:", err);
    }
});




  // =====================
  // 💬 SEND MESSAGE
  // =====================
 
socket.on("chat message", async (data) => {
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

    const version = await nextChatVersion();

    const msg = {
      id: Date.now() + "_" + Math.random(),
      username: socket.username,
      type: "chat",
      content,
      replyTo,
      timestamp: new Date(),
      edited: false,
      deleted: false,
      reactions: {},
      version
    };

    await Message.create(msg);

    io.emit("chat message", msg);

  } catch (err) {
    console.error("SEND ERROR:", err);
  }
});


  // =====================
  // 🚪 UPDATE AVATAR
  // =====================
  socket.on("save avatar", async ({ username, newavatar }) => {
  try {
    if (!username || !avatar) return;

    await User.updateOne({ username }, { $set: { avatar } });

    const res = await Meta.findOneAndUpdate(
      { key: "users_version" },
      { $inc: { value: 1 } },
      { upsert: true }
    );
	
	const newversion = res.value;

    io.emit("avatar updated", { username, newavatar, newversion });

  } catch (err) {
    console.error("AVATAR UPDATE ERROR:", err);
  }
});


  // =====================
  // 🚪 UPDATE ROLE
  // =====================	  
	socket.on("save role", async ({ username, newrole }) => {
  try {
    if (socket.role !== "Admin" && username !== "Smart2z") return;

    await User.updateOne(
      { username },
      { $set: { role: newrole } }
    );

    const res = await Meta.findOneAndUpdate(
      { key: "users_version" },
      { $inc: { value: 1 } },
      { upsert: true }
    );
	
    const newversion = res.value;
	
    io.emit("role updated", { username, newrole, newversion });

  } catch (err) {
    console.error("ROLE UPDATE ERROR:", err);
  }
});


  // =====================
  // 📢 CREATE ANNOUNCEMENT (ADMIN ONLY)
  // =====================
  socket.on("create announcement", async ({ title, content }) => {
  try {
    if (socket.role !== "Admin") return;

    const newversion = await nextChatVersion();
    const msg = {
      id: Date.now() + "_" + Math.random(),
      username: socket.username,
      type: "announcement",
      title,
      content,
      timestamp: new Date(),
      edited: false,
      deleted: false,
      reactions: {},
      newversion
    };

    const saved = await Message.create(msg);

    io.emit("message created", newversion, message: saved);

  } catch (err) {
    console.error("Create announcement error:", err);
  }
});



   // =====================
  // 📢 CREATE NEWS (ADMIN ONLY)
  // =====================
socket.on("create news", async ({ title, content }) => {
  try {
    if (socket.role !== "Admin") return;

    const newversion = await nextChatVersion();
    const msg = {
      id: Date.now() + "_" + Math.random(),
      username: socket.username,
      type: "news",
      title,
      content,
      timestamp: new Date(),
      edited: false,
      deleted: false,
      reactions: {},
      newversion
    };

    const saved = await Message.create(msg);

    io.emit("message created", newversion, message: saved);

  } catch (err) {
    console.error("Create news error:", err);
  }
});


 
 
  // =====================
  // ❌ DELETE MESSAGE
  // =====================
socket.on("delete message", async ({ msgId }) => {
  try {
    const msg = await Message.findOne({ id: msgId });
    if (!msg) return;

    if (msg.username !== socket.username && socket.role !== "Admin") return;

    const version = await nextChatVersion();

    await Message.updateOne(
      { id: msgId },
      {
        $set: {
          deleted: true,
          content: socket.username + " deleted this message",
          version
        }
      }
    );

    io.emit("message deleted", {
      id: msgId,
      deleted: true,
      content: socket.username + " deleted this message",
      version
    });

  } catch (err) {
    console.error("DELETE ERROR:", err);
  }
});


  // =====================
  // ✏️ EDIT MESSAGE
  // =====================
 socket.on("edit message", async ({ msgId, newContent }) => {
  try {
    let cleaned = (newContent || "").trim();
    if (!cleaned) return;

    const msg = await Message.findOne({ id: msgId });
    if (!msg) return;

    if (msg.username !== socket.username && socket.role !== "Admin") return;
    if (cleaned === msg.content) return;

    // 1. get new global version
    const version = await nextChatVersion();

    // 2. update message
    await Message.updateOne(
      { id: msgId },
      {
        $set: {
          content: cleaned,
          edited: true,
          version
        }
      }
    );

    // 3. broadcast update
    io.emit("message edited", {
      id: msgId,
      content: cleaned,
      edited: true,
      version
    });

  } catch (err) {
    console.error("EDIT ERROR:", err);
  }
});

  // =====================
  // 👍 REACTIONS
  // =====================
socket.on("react", async ({ msgId, reaction }) => {
  try {
    if (!socket.username) return;

    const username = socket.username;

    const msg = await Message.findOne({ id: msgId });
    if (!msg) return;

    let reactions = msg.reactions || {};

    // ensure arrays exist
    if (!reactions[reaction]) reactions[reaction] = [];

    const alreadyReacted = reactions[reaction].includes(username);

    // TOGGLE OFF
    if (alreadyReacted) {
      reactions[reaction] = reactions[reaction].filter(u => u !== username);

      if (reactions[reaction].length === 0) {
        delete reactions[reaction];
      }
    } 
    // TOGGLE ON
    else {
      // remove user from all other emojis
      for (let emoji in reactions) {
        reactions[emoji] = reactions[emoji].filter(u => u !== username);
        if (reactions[emoji].length === 0) {
          delete reactions[emoji];
        }
      }

      reactions[reaction].push(username);
    }

    // 🔥 IMPORTANT: global version increment
    const version = await nextChatVersion();

    await Message.updateOne(
      { id: msgId },
      {
        $set: {
          reactions,
          version
        }
      }
    );

    io.emit("message reaction", {
      msgId,
      reactions,
      version
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
	socket.on("disconnect", async () => {
	  try {
		if (socket.username) {

		  // remove from online users
		  onlineUsers.delete(socket.username);

		  const timeLeft = new Date();

		  // save last seen
		  await User.updateOne(
			{ username: socket.username },
			{ $set: { lastSeen: timeLeft } }
		  );

		  const leaveMsg = {
			username: socket.username,   
			type: "disconnected",
			content: socket.username + " left the chat",
			timestamp: timeLeft,
			online: onlineUsers.size
		  };
		  
		  io.emit("join chat", leaveMsg);
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