const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*'
  }
});


let messages = [];
const MAX_MESSAGE_LENGTH = 300;
let onlineUsers = 0;

io.on('connection', (socket) => {
  //console.log('User connected:', socket.id);
  

	  socket.on('join', ({ username, role }) => {
		  socket.username = username || "Guest";
		  socket.role = role || "member";
		  
			onlineUsers++;

		  // Send history first
		  socket.emit('chat history', messages);

		  const joinMsg = {
			username: username,
			role: "system",
			content: socket.username + " joined the community",
			timestamp: new Date(),
			online: onlineUsers
		  };

		  messages.push(joinMsg);
			  if (messages.length > 50) {
			  messages.shift();
			  }

		  // Broadcast to everyone
		  io.emit('chat message', joinMsg);

	});



	socket.on('chat message', (content) => {

		  if (!socket.username) return;

		  if (!content || content.length > MAX_MESSAGE_LENGTH) {
			return;
		  }

		  const msg = {
			username: socket.username,
			role: socket.role,
			content: content,
			timestamp: new Date()
		  };

		  messages.push(msg);

		  if (messages.length > 50) {
			messages.shift();
		  }

		  io.emit('chat message', msg);

	});
		
		
	socket.on("typing", () => {
		  socket.broadcast.emit("typing", {
			username: socket.username
		  });

	});

	socket.on("stop typing", () => {
		  socket.broadcast.emit("stop typing", {
			username: socket.username
		  });

	});
				

	socket.on('disconnect', () => {
		  
	  onlineUsers = Math.max(onlineUsers - 1, 0);  

	  if (socket.username) {

		const leaveMsg = {
		  username: "System",
		  role: "system",
		  content: socket.username + " left the community",
		  timestamp: new Date(),
		  online: onlineUsers
		};

		messages.push(leaveMsg);
			if (messages.length > 200) {
				 messages.shift();
			}

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