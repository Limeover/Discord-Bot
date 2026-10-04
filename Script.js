require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const CALLBACK_URL = process.env.CALLBACK_URL || 'http://localhost:3000/auth/discord/callback';

// Konfigurasi Multer untuk handling upload file
const upload = multer({ dest: 'uploads/' });

// Konfigurasi Session
app.use(session({
    secret: 'rahasia-discord-studio-secret-key-ganti-kalau-bisa',
    resave: false,
    saveUninitialized: false,
}));

app.use(passport.initialize());
app.use(passport.session());

// Konfigurasi Passport Discord Strategy
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(obj));

passport.use(new DiscordStrategy({
    clientID: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    callbackURL: CALLBACK_URL,
    scope: ['identify', 'guilds']
}, (accessToken, refreshToken, profile, done) => {
    return done(null, profile);
}));

// Middleware Cek Login
function checkAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.status(401).json({ error: 'Unauthorized. Silakan login terlebih dahulu.' });
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- ROUTE UTAMA & FILE STATIS (DIPERBAIKI) ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));
// ----------------------------------------------

// Inisialisasi Bot Discord
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent 
    ]
});

client.once('ready', () => {
    console.log(`Bot berhasil login sebagai ${client.user.tag}`);
});

// --- ROUTE AUTENTIKASI DISCORD OAUTH2 ---
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', {
    failureRedirect: '/'
}), (req, res) => {
    res.redirect('/');
});

app.get('/logout', (req, res) => {
    req.logout(() => {
        res.redirect('/');
    });
});

// Endpoint Cek Status Sesi User
app.get('/api/user', (req, res) => {
    if (!req.isAuthenticated()) {
        return res.json({ loggedIn: false });
    }
    res.json({
        loggedIn: true,
        username: req.user.username,
        id: req.user.id,
        avatar: req.user.avatar ? `https://cdn.discordapp.com/avatars/${req.user.id}/${req.user.avatar}.png` : null
    });
});

// Ambil Server (Difilter Berdasarkan Hak Akses Administrator & Keberadaan Bot)
app.get('/api/guilds', checkAuth, (req, res) => {
    try {
        const userGuilds = req.user.guilds; 
        const commonGuilds = userGuilds.filter(guild => {
            const isAdmin = (guild.permissions & 0x8) === 0x8 || guild.owner;
            const botHasGuild = client.guilds.cache.has(guild.id);
            return isAdmin && botHasGuild;
        }).map(guild => ({
            id: guild.id,
            name: guild.name
        }));

        res.json(commonGuilds);
    } catch (error) {
        res.status(500).json({ error: 'Gagal mengambil daftar server' });
    }
});

// Ambil Channel
app.get('/api/channels/:guildId', checkAuth, async (req, res) => {
    try {
        const guild = await client.guilds.fetch(req.params.guildId);
        const channels = guild.channels.cache
            .filter(c => c.type === 0)
            .map(c => ({
                id: c.id,
                name: c.name
            }));
        res.json(channels);
    } catch (error) {
        res.status(500).json({ error: 'Gagal mengambil daftar channel' });
    }
});

// --- FITUR SETTING.JSON (PENYIMPANAN BAHASA) ---
const settingsFilePath = path.join(__dirname, 'setting.json');

function getSettings() {
    if (!fs.existsSync(settingsFilePath)) {
        return {};
    }
    try {
        const data = fs.readFileSync(settingsFilePath, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        return {};
    }
}

function saveSettings(settings) {
    fs.writeFileSync(settingsFilePath, JSON.stringify(settings, null, 2), 'utf8');
}

app.get('/api/settings/:guildId', checkAuth, (req, res) => {
    const { guildId } = req.params;
    const settings = getSettings();
    const guildSettings = settings[guildId] || { language: 'id' };
    res.json(guildSettings);
});

app.post('/api/settings', checkAuth, (req, res) => {
    const { guildId, language } = req.body;

    if (!guildId || !language) {
        return res.status(400).json({ success: false, message: 'Guild ID dan bahasa wajib diisi!' });
    }

    const validLanguages = ['en', 'id', 'ja'];
    if (!validLanguages.includes(language)) {
        return res.status(400).json({ success: false, message: 'Pilihan bahasa tidak valid!' });
    }

    try {
        const settings = getSettings();
        if (!settings[guildId]) {
            settings[guildId] = {};
        }
        settings[guildId].language = language;

        saveSettings(settings);
        res.json({ success: true, message: 'Pengaturan berhasil disimpan!' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Gagal menyimpan ke file setting.json' });
    }
});
// ----------------------------------------------

// Kirim Embed Message
app.post('/api/send-embed', checkAuth, upload.single('imageFile'), async (req, res) => {
    const { channelId, title, description, color } = req.body;
    const file = req.file;

    if (!channelId || !description) {
        if (file) fs.unlinkSync(file.path);
        return res.status(400).json({ success: false, message: 'Channel dan Deskripsi harus diisi!' });
    }

    try {
        const channel = await client.channels.fetch(channelId);
        
        const embed = new EmbedBuilder()
            .setDescription(description)
            .setColor(color || '#00e5ff');

        if (title) embed.setTitle(title);

        const sendPayload = { embeds: [embed] };

        if (file) {
            const attachment = new AttachmentBuilder(file.path, { name: file.originalname });
            embed.setImage(`attachment://${file.originalname}`);
            sendPayload.files = [attachment];
        }

        await channel.send(sendPayload);
        if (file) fs.unlinkSync(file.path);

        res.json({ success: true, message: 'Pesan embed berhasil dikirim!' });
    } catch (error) {
        console.error(error);
        if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
        res.status(500).json({ success: false, message: 'Gagal mengirim pesan embed.' });
    }
});

// Info Server
app.get('/api/server-info/:guildId', checkAuth, async (req, res) => {
    try {
        const guildId = req.params.guildId;
        const guild = client.guilds.cache.get(guildId);
        
        if (!guild) {
            return res.status(404).json({ error: 'Server tidak ditemukan' });
        }

        res.json({
            name: guild.name,
            icon: guild.iconURL({ dynamic: true }),
            memberCount: guild.memberCount,
            channelsCount: guild.channels.cache.size,
            rolesCount: guild.roles.cache.size
        });
    } catch (error) {
        res.status(500).json({ error: 'Gagal mengambil informasi server' });
    }
});

// Info Bot
app.get('/api/bot-info', (req, res) => {
    try {
        if (!client.user) {
            return res.status(500).json({ error: 'Bot belum siap' });
        }
        res.json({
            username: client.user.username,
            avatar: client.user.displayAvatarURL(),
            servers: client.guilds.cache.size,
            ping: Math.round(client.ws.ping)
        });
    } catch (error) {
        res.status(500).json({ error: 'Gagal mengambil informasi bot' });
    }
});

// Kamus terjemahan teks bot
const translations = {
    en: { successEmbed: "Embed message sent successfully!" },
    id: { successEmbed: "Pesan embed berhasil dikirim!" },
    ja: { successEmbed: "埋め込みメッセージが正常に送信されました！" }
};

function getBotMessage(guildId, key) {
    const settings = getSettings();
    const lang = settings[guildId]?.language || 'id';
    return translations[lang][key] || translations['id'][key];
}

// --- FITUR AUTO MODERATION ---
const automodFilePath = path.join(__dirname, 'automod.json');

function getAutoModSettings() {
    if (!fs.existsSync(automodFilePath)) return {};
    try {
        return JSON.parse(fs.readFileSync(automodFilePath, 'utf8'));
    } catch (err) {
        return {};
    }
}

function saveAutoModSettings(settings) {
    fs.writeFileSync(automodFilePath, JSON.stringify(settings, null, 2), 'utf8');
}

app.get('/api/automod/:guildId', checkAuth, (req, res) => {
    const { guildId } = req.params;
    const settings = getAutoModSettings();
    const guildSettings = settings[guildId] || { antiLink: false, antiBadWords: false, badWordsList: 'anjing, babi, anj' };
    res.json(guildSettings);
});

app.post('/api/automod', checkAuth, (req, res) => {
    const { guildId, antiLink, antiBadWords, badWordsList } = req.body;

    if (!guildId) {
        return res.status(400).json({ success: false, message: 'Guild ID wajib diisi!' });
    }

    try {
        const settings = getAutoModSettings();
        settings[guildId] = {
            antiLink: Boolean(antiLink),
            antiBadWords: Boolean(antiBadWords),
            badWordsList: badWordsList || ''
        };

        saveAutoModSettings(settings);
        res.json({ success: true, message: 'Pengaturan Auto Mod berhasil disimpan!' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Gagal menyimpan pengaturan Auto Mod' });
    }
});

// --- FITUR MUSIC PLAYER CONTROL ---
const musicQueue = {};

app.get('/api/music/:guildId', checkAuth, (req, res) => {
    const { guildId } = req.params;
    const status = musicQueue[guildId] || { currentSong: 'Tidak ada lagu yang diputar', isPlaying: false };
    res.json(status);
});

app.post('/api/music/control', checkAuth, (req, res) => {
    const { guildId, action, query } = req.body;

    if (!guildId || !action) {
        return res.status(400).json({ success: false, message: 'Guild ID dan action wajib diisi!' });
    }

    if (!musicQueue[guildId]) {
        musicQueue[guildId] = { currentSong: 'Tidak ada lagu yang diputar', isPlaying: false };
    }

    const serverMusic = musicQueue[guildId];

    switch (action) {
        case 'play':
            if (!query) return res.status(400).json({ success: false, message: 'Judul/Link lagu wajib diisi!' });
            serverMusic.currentSong = query;
            serverMusic.isPlaying = true;
            break;
        case 'pause':
            serverMusic.isPlaying = false;
            break;
        case 'resume':
            serverMusic.isPlaying = true;
            break;
        case 'skip':
            serverMusic.currentSong = 'Lagu berikutnya (Antrean kosong)';
            serverMusic.isPlaying = true;
            break;
        case 'stop':
            serverMusic.currentSong = 'Tidak ada lagu yang diputar';
            serverMusic.isPlaying = false;
            break;
        default:
            return res.status(400).json({ success: false, message: 'Aksi tidak dikenal!' });
    }

    res.json({ success: true, message: `Berhasil menjalankan aksi: ${action}`, data: serverMusic });
});
// ----------------------------------

client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    const settings = getAutoModSettings();
    const guildSettings = settings[message.guild.id];
    if (!guildSettings) return;

    let isViolation = false;

    if (guildSettings.antiLink) {
        const linkRegex = /(https?:\/\/[^\s]+|discord\.gg\/[^\s]+)/gi;
        if (linkRegex.test(message.content)) {
            isViolation = true;
        }
    }

    if (guildSettings.antiBadWords && guildSettings.badWordsList) {
        const badWords = guildSettings.badWordsList.split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
        const contentLower = message.content.toLowerCase();
        
        for (const word of badWords) {
            if (contentLower.includes(word)) {
                isViolation = true;
                break;
            }
        }
    }

    if (isViolation) {
        try {
            await message.delete();
            const warning = await message.channel.send(`⚠️ Peringatan <@${message.author.id}>, pesan Anda dihapus karena melanggar aturan Auto Moderation.`);
            setTimeout(() => warning.delete().catch(() => {}), 5000);
        } catch (err) {
            console.error('Gagal menghapus pesan automod:', err);
        }
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server berjalan di port ${PORT}`);
});
