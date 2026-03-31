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
	  type: "user-join",
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
	type: "chat",
    content: content,
    replyTo: replyTo, // ✅ NEW
    timestamp: new Date(),
	edited: false,
    reactions: {}	
  };

  messages.push(msg);
  if (messages.length > 200) messages.shift();

  io.emit('chat message', msg);

});
	
	
	
	// DELETE MESSAGE
socket.on('delete message', (msgId) => {

  const msg = messages.find(m => m.id === msgId);
  if (!msg) return;

  // Only owner or admin can delete
  if (msg.username === socket.username || socket.role === "Admin") {

    msg.content = socket.username + " deleted this message!"

    const deletedMsg = {
			  id: Date.now() + "_" + Math.random(),
			  msgId: msgId,		
			  msg.deleted = true;
			  username: socket.username,			  
			  content: msg.content
			};

    io.emit('message deleted', deletedMsg);
  }

});
	


  
		// EDIT MESSAGE
	socket.on('edit message', ({ msgId, newContent }) => {

	  const msg = messages.find(m => m.id === msgId);
	  if (!msg) return;

	  // allow only owner to edit
	  if (msg.username === socket.username) {

		let cleaned = (newContent || "").trim();

		// prevent empty message
		if (!cleaned) return;

		// prevent duplicate update
		if (cleaned === msg.content) return;

		// update message
		msg.content = cleaned;

		// mark as edited
		msg.edited = true;

		// emit updated message
		io.emit('message edited', {
		  msgId,
		  newContent: cleaned,
		  edited: true
		});

	  }

	});
	  

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
		type: "user-left",
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