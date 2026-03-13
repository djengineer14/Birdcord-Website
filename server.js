const express = require("express");
const { WebSocketServer } = require("ws");
const http = require("http");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());

const ROOM_PASSWORD = process.env.ROOM_PASSWORD || "coolahhchattyapp2026";
const DEV_PASSWORD = "dev_test2014";
const MAX_USERS = 6;
const MONGODB_URI = process.env.MONGODB_URI;

// ═══ MONGOOSE SCHEMA ═════════════════════════════════════════
mongoose.connect(MONGODB_URI)
    .then(() => console.log("🐦 MongoDB connected!"))
    .catch(err => console.error("MongoDB error:", err));

const userSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model("User", userSchema);

// ═══ REST API ════════════════════════════════════════════════

app.get("/", (req, res) => {
    res.send("🐦 Birdcord Server is running!");
});

// Register
app.post("/register", async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.json({ success: false, message: "Username and password required!" });
    }

    if (username.length < 3) {
        return res.json({ success: false, message: "Username must be at least 3 characters!" });
    }

    if (password.length < 6) {
        return res.json({ success: false, message: "Password must be at least 6 characters!" });
    }

    try {
        const existing = await User.findOne({ username: { $regex: new RegExp("^" + username + "$", "i") } });
        if (existing) {
            return res.json({ success: false, message: "Username already taken!" });
        }

        const hashed = await bcrypt.hash(password, 10);
        const user = new User({ username, password: hashed });
        await user.save();

        return res.json({ success: true, message: "Account created! You can now log in." });
    } catch (err) {
        return res.json({ success: false, message: "Server error: " + err.message });
    }
});

// Login
app.post("/login", async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.json({ success: false, message: "Username and password required!" });
    }

    try {
        const user = await User.findOne({ username: { $regex: new RegExp("^" + username + "$", "i") } });
        if (!user) {
            return res.json({ success: false, message: "Account not found!" });
        }

        const match = await bcrypt.compare(password, user.password);
        if (!match) {
            return res.json({ success: false, message: "Wrong password!" });
        }

        return res.json({ success: true, username: user.username });
    } catch (err) {
        return res.json({ success: false, message: "Server error: " + err.message });
    }
});

// ═══ WEBSOCKET ═══════════════════════════════════════════════

const clients = new Map();
let nextId = 1;

wss.on("connection", (ws) => {
    let userId = null;
    let authenticated = false;

    ws.on("message", (data) => {
        let msg;
        try {
            msg = JSON.parse(data);
        } catch {
            ws.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
            return;
        }

        if (msg.type === "auth") {
            // Dev mode auth
            if (msg.password === DEV_PASSWORD) {
                userId = nextId++;
                authenticated = true;
                clients.set(userId, { ws, name: msg.name || "DevUser" });
                ws.send(JSON.stringify({ type: "auth", success: true, userId, dev: true }));
                broadcast(userId, {
                    type: "user-joined",
                    userId,
                    name: clients.get(userId).name,
                    userCount: clients.size
                });
                const existingUsers = [];
                for (const [id, client] of clients) {
                    if (id !== userId) existingUsers.push({ userId: id, name: client.name });
                }
                ws.send(JSON.stringify({ type: "user-list", users: existingUsers }));
                console.log(`🛠 DEV ${clients.get(userId).name} joined!`);
                return;
            }

            // Normal auth — requires room password + logged in username
            if (msg.password !== ROOM_PASSWORD) {
                ws.send(JSON.stringify({ type: "auth", success: false, message: "Wrong room password!" }));
                ws.close();
                return;
            }

            if (!msg.name) {
                ws.send(JSON.stringify({ type: "auth", success: false, message: "No username provided!" }));
                ws.close();
                return;
            }

            if (clients.size >= MAX_USERS) {
                ws.send(JSON.stringify({ type: "error", message: "Server full! Max " + MAX_USERS + " birds allowed." }));
                ws.close();
                return;
            }

            userId = nextId++;
            authenticated = true;
            clients.set(userId, { ws, name: msg.name });

            ws.send(JSON.stringify({ type: "auth", success: true, userId }));

            broadcast(userId, {
                type: "user-joined",
                userId,
                name: clients.get(userId).name,
                userCount: clients.size
            });

            const existingUsers = [];
            for (const [id, client] of clients) {
                if (id !== userId) existingUsers.push({ userId: id, name: client.name });
            }
            ws.send(JSON.stringify({ type: "user-list", users: existingUsers }));
            console.log(`🐦 ${clients.get(userId).name} joined! (${clients.size}/${MAX_USERS})`);
            return;
        }

        if (!authenticated) {
            ws.send(JSON.stringify({ type: "error", message: "Not authenticated!" }));
            return;
        }

        if (msg.type === "offer" || msg.type === "answer" || msg.type === "ice-candidate") {
            const target = clients.get(msg.targetId);
            if (target) {
                target.ws.send(JSON.stringify({ ...msg, fromId: userId }));
            }
            return;
        }

        if (msg.type === "chat") {
            broadcast(null, {
                type: "chat",
                fromId: userId,
                name: clients.get(userId).name,
                message: msg.message
            });
            return;
        }
    });

    ws.on("close", () => {
        if (userId && clients.has(userId)) {
            const name = clients.get(userId).name;
            clients.delete(userId);
            broadcast(null, {
                type: "user-left",
                userId,
                name,
                userCount: clients.size
            });
            console.log(`🐦 ${name} left. (${clients.size}/${MAX_USERS})`);
        }
    });
});

function broadcast(excludeId, msg) {
    for (const [id, client] of clients) {
        if (id !== excludeId && client.ws.readyState === 1) {
            client.ws.send(JSON.stringify(msg));
        }
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🐦 Birdcord Server running on port ${PORT}`);
});
