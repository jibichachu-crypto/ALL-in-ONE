const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const socketio = require('socket.io');
const path = require('path');
const axios = require('axios');

const app = express();

// ---------- SSL Certificate ----------
let sslOptions = null;
try {
    sslOptions = {
        key: fs.readFileSync('localhost-key.pem'),
        cert: fs.readFileSync('localhost.pem')
    };
    console.log('✅ SSL Certificate loaded successfully');
} catch (err) {
    console.log('⚠️ SSL Certificate not found. Running without HTTPS (HTTP only)');
}

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ---------- ROOT ROUTE ----------
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ---------- Custom Routes ----------
app.get('/register.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'register.html'));
});

app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/game.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'game.html'));
});

// ---------- Database ----------
const DB_FILE = path.join(__dirname, 'users.json');

function readUsers() {
    try {
        const data = fs.readFileSync(DB_FILE, 'utf8');
        return JSON.parse(data);
    } catch {
        return {};
    }
}

function writeUsers(users) {
    fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2));
}

// ---------- Auth Routes ----------

// Secret Key for reCAPTCHA
const SECRET_KEY = '6LemA5gtAAAAAHGOjMlgYfmsmn1zbj01uTcpBva4';

// Temporary OTP Store (In-memory)
const otpStore = {};

// 1. Send OTP Endpoint
app.post('/send-otp', (req, res) => {
    const { phone } = req.body;
    if (!phone) {
        return res.status(400).json({ success: false, message: 'Phone number is required' });
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    
    // NOTE: Here you should integrate your SMS API (e.g., Twilio, MSG91).
    // For testing, we print it to the console.
    console.log(`OTP for ${phone} is: ${otp}`);

    // Save OTP with 5-minute expiry
    otpStore[phone] = { otp, expires: Date.now() + 300000 };

    res.json({ success: true, message: 'OTP sent successfully' });
});

// 2. Register Endpoint
app.post('/register', (req, res) => {
    const { firstName, lastName, email, phone, password } = req.body;

    // Validate required fields
    if (!firstName || !lastName || !email || !phone || !password) {
        return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    // Read existing users
    const users = readUsers();
    
    // Check if username already exists (Using email as unique username)
    if (users[email]) {
        return res.status(400).json({ success: false, message: 'Email already registered' });
    }

    // Save new user to database
    users[email] = {
        firstName: firstName,
        lastName: lastName,
        email: email,
        phone: phone,
        password: password,
        balance: 1000,
        loginStreak: 0,
        lastLoginDate: null,
        createdAt: new Date().toISOString()
    };
    writeUsers(users);

    res.json({ success: true, message: 'Registration successful!' });
});

// 3. Login Endpoint (Updated with reCAPTCHA)
app.post('/login', async (req, res) => {
    const { email, username, password, captchaResponse } = req.body;
    const identifier = email || username;
    
    if (!identifier || !password) {
        return res.status(400).json({ success: false, message: 'Login ID and password required' });
    }

    // reCAPTCHA validation
    if (!captchaResponse) {
        return res.status(400).json({ success: false, message: 'Please complete the CAPTCHA' });
    }

    // Google reCAPTCHA server side validation
    const verifyUrl = `https://www.google.com/recaptcha/api/siteverify?secret=${SECRET_KEY}&response=${captchaResponse}`;
    const verifyRes = await axios.post(verifyUrl);
    
    if (!verifyRes.data.success) {
        return res.status(400).json({ success: false, message: 'CAPTCHA verification failed' });
    }

    const users = readUsers();
    
    // Check by email or username
    const user = users[identifier]; 
    
    if (!user || user.password !== password) {
        return res.status(401).json({ success: false, message: 'Invalid login ID or password' });
    }
    res.json({ success: true, message: 'Login successful!', email: identifier });
});

// 4. Google Login Route
app.get('/auth/google', (req, res) => {
    // ഇത് പ്രവർത്തിക്കാൻ, നിങ്ങൾക്ക് ഒരു പ്രൊഫഷണൽ OAuth 2.0 ലോഗിൻ സിസ്റ്റം ആവശ്യമാണ്.
    // ഇത് ചെയ്യാൻ, നിങ്ങൾക്ക് ഒരു Google OAuth Client ID ആവശ്യമാണ്.
    // ഇത് ചെയ്യാൻ, നിങ്ങൾക്ക് ഒരു Google OAuth Client ID ആവശ്യമാണ്.
});

// ---------- Game State ----------
const players = {};
const DEFAULT_BALANCE = 1000;
const ROUND_TIME = 60;
const gameLogs = [];

function shufflePuzzle() {
    let arr = [1, 2, 3, 4, 5, 6, 7, 8, 0];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    let inversions = 0;
    for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
            if (arr[i] && arr[j] && arr[i] > arr[j]) inversions++;
        }
    }
    if (inversions % 2 !== 0) {
        const idx1 = arr.findIndex(v => v !== 0);
        const idx2 = arr.findIndex((v, i) => v !== 0 && i > idx1);
        if (idx1 !== -1 && idx2 !== -1) {
            [arr[idx1], arr[idx2]] = [arr[idx2], arr[idx1]];
        }
    }
    return arr;
}

function getDailyBonus(player) {
    const today = new Date().toDateString();
    const lastLogin = player.lastLoginDate || null;
    if (lastLogin === today) return 0;
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toDateString();
    if (lastLogin === yesterdayStr) {
        player.loginStreak = Math.min((player.loginStreak || 0) + 1, 7);
    } else {
        player.loginStreak = 1;
    }
    const bonusMap = [1, 2, 3, 4, 5, 6, 10];
    const bonus = bonusMap[player.loginStreak - 1] || 1;
    player.balance += bonus;
    player.lastLoginDate = today;
    return bonus;
}

function broadcastGameState(io) {
    const allPlayers = {};
    let currentTurn = null;
    for (const id in players) {
        const p = players[id];
        allPlayers[id] = {
            balance: p.balance,
            bet: p.bet,
            puzzle: p.puzzle,
            gameActive: p.gameActive,
            moves: p.moves || 0,
            timer: p.timer || ROUND_TIME,
            loginStreak: p.loginStreak || 0,
            difficulty: p.difficulty || 'easy',
            username: p.username || id.slice(0,6)
        };
        if (p.isTurn) currentTurn = id;
    }
    io.emit('gameState', { players: allPlayers, logs: gameLogs.slice(-20), currentTurn });
}

function addLog(io, message) {
    const entry = { time: new Date().toLocaleTimeString(), message };
    gameLogs.push(entry);
    if (gameLogs.length > 100) gameLogs.shift();
    io.emit('newLog', entry);
}

const timers = {};

function startTimer(io, playerId) {
    if (timers[playerId]) clearInterval(timers[playerId]);
    timers[playerId] = setInterval(() => {
        const player = players[playerId];
        if (!player || !player.gameActive) {
            clearInterval(timers[playerId]);
            return;
        }
        player.timer = (player.timer || ROUND_TIME) - 1;
        if (player.timer <= 0) {
            player.gameActive = false;
            clearInterval(timers[playerId]);
            const refund = Math.floor(player.bet / 2);
            player.balance += refund;
            addLog(io, `⏰ ${player.username || playerId.slice(0,6)} ran out of time! Refunded ₿${refund}`);
            io.emit('gameUpdate', { type: 'timeout', playerId, refund });
            broadcastGameState(io);
        } else {
            io.emit('timerUpdate', { playerId, timer: player.timer });
        }
    }, 1000);
}

function clearTimer(playerId) {
    if (timers[playerId]) {
        clearInterval(timers[playerId]);
        delete timers[playerId];
    }
}

function setupSocket(io) {
    io.on('connection', (socket) => {
        console.log(`🟢 Player connected: ${socket.id}`);
        const username = socket.handshake.query.username || socket.id.slice(0,6);
        const users = readUsers();
        const userData = users[username] || { balance: DEFAULT_BALANCE, loginStreak: 0, lastLoginDate: null };

        players[socket.id] = {
            username: username,
            balance: userData.balance || DEFAULT_BALANCE,
            bet: 2,
            puzzle: shufflePuzzle(),
            gameActive: false,
            moves: 0,
            timer: ROUND_TIME,
            lastLoginDate: userData.lastLoginDate || null,
            loginStreak: userData.loginStreak || 0,
            difficulty: 'easy',
            isTurn: false
        };

        const bonus = getDailyBonus(players[socket.id]);
        if (bonus > 0) {
            addLog(io, `🎁 ${username} got daily bonus: ${bonus} GEM`);
            socket.emit('dailyBonus', { bonus, streak: players[socket.id].loginStreak });
            userData.balance = players[socket.id].balance;
            userData.loginStreak = players[socket.id].loginStreak;
            userData.lastLoginDate = players[socket.id].lastLoginDate;
            writeUsers(users);
        }

        socket.emit('init', {
            balance: players[socket.id].balance,
            id: socket.id,
            loginStreak: players[socket.id].loginStreak,
            username: username
        });

        broadcastGameState(io);

        socket.on('setTurn', (data) => {
            const playerId = data.playerId;
            for (const id in players) players[id].isTurn = false;
            if (players[playerId]) {
                players[playerId].isTurn = true;
                addLog(io, `🎯 ${players[playerId].username} selected as current player`);
                io.emit('gameUpdate', { type: 'turn', playerId });
                broadcastGameState(io);
            }
        });

        socket.on('placeBet', (data) => {
            const player = players[socket.id];
            if (!player) return;
            const betAmount = data.bet || 2;
            if (player.balance < betAmount) {
                socket.emit('error', { message: 'Insufficient balance!' });
                return;
            }
            for (const id in players) players[id].isTurn = false;
            player.isTurn = true;
            player.balance -= betAmount;
            player.bet = betAmount;
            player.gameActive = true;
            player.puzzle = shufflePuzzle();
            player.moves = 0;
            player.difficulty = data.difficulty || 'easy';
            const diffTimes = { easy: 60, medium: 120, hard: 180 };
            player.timer = diffTimes[player.difficulty] || 60;
            startTimer(io, socket.id);
            addLog(io, `💰 ${player.username} placed bet: ₿${betAmount} (${player.difficulty})`);
            io.emit('gameUpdate', { type: 'turn', playerId: socket.id });
            broadcastGameState(io);
            const users = readUsers();
            if (users[player.username]) {
                users[player.username].balance = player.balance;
                writeUsers(users);
            }
        });

        socket.on('puzzleMove', (data) => {
            const player = players[socket.id];
            if (!player || !player.gameActive) return;
            if (!player.isTurn) {
                socket.emit('error', { message: 'Not your turn!' });
                return;
            }
            player.puzzle = data.puzzle;
            player.moves = (player.moves || 0) + 1;
            const solved = [1, 2, 3, 4, 5, 6, 7, 8, 0];
            if (JSON.stringify(player.puzzle) === JSON.stringify(solved)) {
                const multipliers = { easy: 2, medium: 3, hard: 4 };
                const multiplier = multipliers[player.difficulty] || 2;
                const winAmount = player.bet * multiplier;
                player.balance += winAmount;
                player.gameActive = false;
                clearTimer(socket.id);
                addLog(io, `🎉 ${player.username} won ₿${winAmount} in ${player.moves} moves! (${player.difficulty})`);
                broadcastGameState(io);
                io.emit('gameUpdate', { type: 'win', playerId: socket.id, win: winAmount, moves: player.moves, difficulty: player.difficulty });
                const users = readUsers();
                if (users[player.username]) {
                    users[player.username].balance = player.balance;
                    writeUsers(users);
                }
            } else {
                broadcastGameState(io);
            }
        });

        socket.on('timeUp', () => {
            const player = players[socket.id];
            if (player && player.gameActive) {
                player.gameActive = false;
                clearTimer(socket.id);
                broadcastGameState(io);
            }
        });

        socket.on('resetGame', () => {
            const player = players[socket.id];
            if (player) {
                player.balance = DEFAULT_BALANCE;
                player.gameActive = false;
                player.puzzle = shufflePuzzle();
                player.moves = 0;
                player.timer = ROUND_TIME;
                player.isTurn = false;
                clearTimer(socket.id);
                socket.emit('balanceUpdate', { playerId: socket.id, balance: player.balance });
                const users = readUsers();
                if (users[player.username]) {
                    users[player.username].balance = player.balance;
                    writeUsers(users);
                }
            }
            addLog(io, `🔄 ${player.username} reset game`);
            broadcastGameState(io);
        });

        socket.on('disconnect', () => {
            console.log(`🔴 Player disconnected: ${socket.id}`);
            clearTimer(socket.id);
            delete players[socket.id];
            addLog(io, `🔴 ${socket.id.slice(0,6)} left the game`);
            broadcastGameState(io);
        });
    });
}

// ---------- Start Server ----------
const PORT = process.env.PORT || 3002;

if (sslOptions) {
    const server = https.createServer(sslOptions, app);
    const io = new socketio.Server(server);
    setupSocket(io);
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 HTTPS Server running on https://localhost:${PORT}`);
        console.log('💎 All in One · Multiplayer Betting Game (Secure)');
    });
} else {
    const server = http.createServer(app);
    const io = new socketio.Server(server);
    setupSocket(io);
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 HTTP Server running on http://localhost:${PORT}`);
        console.log('💎 All in One · Multiplayer Betting Game');
    });
}