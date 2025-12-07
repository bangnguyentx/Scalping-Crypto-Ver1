require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const moment = require('moment-timezone');
const express = require('express');
const { analyzeSymbol } = require('./analysis');

// --- CẤU HÌNH ---
const token = process.env.TELEGRAM_BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN_HERE';

// --- BOT POLLING ---
const bot = new TelegramBot(token, {
    polling: {
        interval: 300,
        autoStart: true,
        params: {
            timeout: 10
        }
    }
});

// Bắt lỗi polling để không crash app
bot.on("polling_error", (err) => {
    console.log(`[Polling Error] ${err.code || ''}: ${err.message || err}`);
});

const app = express();
const PORT = process.env.PORT || 3000;

// TARGET_COINS - cập nhật theo yêu cầu
const TARGET_COINS = [
    'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
    'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'TRXUSDT', 'LINKUSDT',
    'MATICUSDT', 'LTCUSDT', 'ATOMUSDT', 'ETCUSDT', 'XLMUSDT',
    'BCHUSDT', 'FILUSDT', 'ALGOUSDT', 'NEARUSDT', 'UNIUSDT',
    'DOGEUSDT', 'ZECUSDT', '1000PEPEUSDT', 'ZENUSDT', 'HYPEUSDT',
    'WIFUSDT', 'MEMEUSDT', 'BOMEUSDT', 'POPCATUSDT', 'MYROUSDT',
    'TOSHIUSDT', 'TURBOUSDT', 'NFPUSDT', 'PEOPLEUSDT', 'ARCUSDT',
    'BTCDOMUSDT', 'TRUMPUSDT', 'DASHUSDT', 'APTUSDT', 'ARBUSDT',
    'OPUSDT', 'SUIUSDT', 'SEIUSDT', 'TIAUSDT', 'INJUSDT',
    'RNDRUSDT', 'FETUSDT', 'AGIXUSDT', 'OCEANUSDT', 'JASMYUSDT',
    'GALAUSDT', 'SANDUSDT', 'MANAUSDT', 'ENJUSDT', 'CHZUSDT',
    'APEUSDT', 'GMTUSDT', 'LDOUSDT'
];

// subscribedUsers map: chatId -> { userInfo, activatedAt }
const subscribedUsers = new Map();

// --- TRẠNG THÁI ---
let signalCountToday = 0;
let isAutoAnalysisRunning = false;
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 5;

// --- SERVER EXPRESS (KEEP-ALIVE) ---
app.get('/', (req, res) => {
    res.json({
        status: 'AI Trading Bot is Running...',
        subscribers: subscribedUsers.size,
        lastSignalCount: signalCountToday
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        uptime: process.uptime(),
        users: subscribedUsers.size,
        signals: signalCountToday
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});

// --- HÀM TIỆN ÍCH ---
function getVietnamTime() {
    return moment().tz("Asia/Ho_Chi_Minh");
}

function fmtNumForMsg(num) {
    if (num === undefined || num === null) return 'N/A';
    const n = parseFloat(num);
    if (isNaN(n)) return 'N/A';
    return n > 10 ? n.toFixed(2) : n.toFixed(4);
}

function formatSignalMessage(data, signalIndex) {
    const icon = data.direction === 'LONG' ? '🟢' : '🔴';
    const base = `🤖 Tín hiệu [${signalIndex} trong ngày]\n#${data.symbol.replace('USDT','')} – [${data.direction}] 📌\n\n` +
        `${icon} Entry: ${fmtNumForMsg(data.entry)}\n` +
        `🆗 Take Profit: ${fmtNumForMsg(data.tp)}\n` +
        `🙅‍♂️ Stop-Loss: ${fmtNumForMsg(data.sl)}\n` +
        `🪙 Tỉ lệ RR: ${data.rr} (Conf: ${data.confidence}%)\n\n` +
        `⚠️ Tuân thủ quản lý rủi ro – Đi tối đa 1-2% risk. Bot chỉ để tham khảo.`;
    return base;
}

// Broadcast with retries and prune blocked users
async function broadcastToAllUsers(message) {
    let success = 0, fail = 0;
    for (const [chatId, userData] of subscribedUsers) {
        let sent = false;
        let retries = 0;
        while (!sent && retries < 3) {
            try {
                await bot.sendMessage(chatId, message);
                success++;
                sent = true;
                // small delay
                await new Promise(r => setTimeout(r, 120));
            } catch (e) {
                retries++;
                console.warn(`Failed to send to ${chatId} attempt ${retries}: ${e.message}`);
                if (e.response && (e.response.statusCode === 403 || e.response.statusCode === 410)) {
                    // user blocked or chat not found - remove
                    subscribedUsers.delete(chatId);
                    console.log(`Removed blocked user ${chatId}`);
                    sent = true; // stop retrying for this user
                    fail++;
                    break;
                }
                if (retries >= 3) {
                    fail++;
                } else {
                    await new Promise(r => setTimeout(r, 1000 * retries));
                }
            }
        }
    }
    console.log(`📤 Broadcast result: success=${success}, fail=${fail}`);
    return { success, fail };
}

// --- AUTO ANALYSIS ---
async function runAutoAnalysis() {
    if (isAutoAnalysisRunning) {
        console.log('⏳ Auto analysis already running, skipping this cycle.');
        return;
    }

    // circuit breaker
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.log('🚨 Circuit breaker active. Skipping analysis cycle.');
        return;
    }

    const now = getVietnamTime();
    const hour = now.hours();
    const minute = now.minutes();

    // keep same operating hours 04:00 - 23:30
    if (hour < 4 || (hour === 23 && minute > 30)) {
        console.log('💤 Out of operating hours (04:00 - 23:30). Skipping.');
        return;
    }

    if (subscribedUsers.size === 0) {
        console.log('👥 No subscribers. Skipping auto analysis.');
        return;
    }

    isAutoAnalysisRunning = true;
    console.log(`🔄 Starting Auto Analysis at ${now.format('HH:mm')} - ${subscribedUsers.size} users`);

    let signalsFound = 0;
    let analyzedCount = 0;

    try {
        for (const coin of TARGET_COINS) {
            analyzedCount++;
            // polite dynamic delay to avoid rate-limits
            const delayMs = 8000 + (Math.floor(analyzedCount / 10) * 1000) + Math.random() * 2000;
            await new Promise(r => setTimeout(r, delayMs));

            try {
                console.log(`🔍 Analyzing ${coin} (${analyzedCount}/${TARGET_COINS.length})`);
                const result = await analyzeSymbol(coin);

                if (result && result.direction && result.direction !== 'NO_TRADE' && result.direction !== 'NEUTRAL') {
                    const conf = result.confidence || 0;
                    if (conf >= 60 && conf <= 100) {
                        signalCountToday++;
                        signalsFound++;
                        const msg = formatSignalMessage(result, signalCountToday);
                        console.log(`✅ Signal: ${coin} ${result.direction} conf=${conf}%`);
                        await broadcastToAllUsers(msg);
                        // small delay after sending
                        await new Promise(r => setTimeout(r, 2500));
                    } else {
                        console.log(`⏭️ Skip ${coin}: confidence ${conf}%`);
                    }
                } else {
                    console.log(`➖ No signal for ${coin}: ${result?.direction || result?.reason || 'NO_TRADE'}`);
                }
            } catch (coinErr) {
                console.error(`❌ Error analyzing ${coin}:`, coinErr.message || coinErr);
                const m = String(coinErr.message || coinErr);
                if (m.includes('418') || m.includes('429')) {
                    consecutiveErrors++;
                    console.log(`🚨 Consecutive errors: ${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}`);
                    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                        console.log('🔌 Circuit breaker triggered. Cooling down 10 minutes...');
                        setTimeout(() => {
                            consecutiveErrors = 0;
                            console.log('🔋 Circuit breaker reset');
                        }, 10 * 60 * 1000);
                        break;
                    }
                } else {
                    // reset on other errors
                    consecutiveErrors = 0;
                }
            }
        }

        console.log(`🎯 Auto analysis finished — signalsFound=${signalsFound}`);

    } catch (err) {
        console.error('💥 Critical error in runAutoAnalysis:', err);
    } finally {
        isAutoAnalysisRunning = false;
    }
}

// Reset daily count & morning greeting at 04:00
function checkDailyGreeting() {
    const now = getVietnamTime();
    if (now.hours() === 4 && now.minutes() === 0) {
        signalCountToday = 0;
        const greeting = "🌞 Chào ngày mới! AI Trading Bot sẵn sàng săn cơ hội. Chúc 1 ngày thắng lợi!";
        broadcastToAllUsers(greeting);
        console.log('🌞 Sent morning greeting and reset counters');
    }
}

// Scheduling
const ANALYSIS_INTERVAL = 2 * 60 * 60 * 1000; // 2 hours
setInterval(runAutoAnalysis, ANALYSIS_INTERVAL);
setInterval(checkDailyGreeting, 60 * 1000);
setTimeout(() => { runAutoAnalysis(); }, 10000);

// --- BOT COMMANDS ---

// /start - đăng ký nhận tin (không cần key)
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const user = msg.from;

    const userInfo = {
        id: user.id,
        username: user.username || null,
        first_name: user.first_name || null,
        last_name: user.last_name || null
    };

    const userData = {
        userInfo,
        activatedAt: new Date()
    };
    subscribedUsers.set(chatId, userData);

    const welcomeMsg = `👋 Chào ${user.first_name || 'Trader'}!\nBạn đã được đăng ký nhận tín hiệu tự động từ AI Trading Bot.\n\nCác lệnh hỗ trợ:\n/analyzesymbol <SYMBOL>\n/analyzeall\n/users\n/stop\n/ping\n\n⚠️ Bot chỉ gửi tín hiệu tham khảo — luôn tuân thủ quản lý rủi ro.`;
    bot.sendMessage(chatId, welcomeMsg);
    console.log(`✅ Subscribed user ${chatId} (${user.username || user.first_name})`);
});

// /stop - hủy đăng ký
bot.onText(/\/stop/, (msg) => {
    const chatId = msg.chat.id;
    if (subscribedUsers.has(chatId)) {
        subscribedUsers.delete(chatId);
        bot.sendMessage(chatId, '🗑️ Bạn đã hủy đăng ký nhận tín hiệu. Gõ /start để đăng ký lại.');
        console.log(`User unsubscribed ${chatId}`);
    } else {
        bot.sendMessage(chatId, 'Bạn chưa đăng ký nhận tín hiệu. Gõ /start để đăng ký.');
    }
});

// /ping - kiểm tra bot hoạt động
bot.onText(/\/ping/, (msg) => {
    const chatId = msg.chat.id;
    const now = getVietnamTime();
    const reply = {
        text: `🏓 PONG — Bot đang hoạt động\nThời gian server (VN): ${now.format('YYYY-MM-DD HH:mm:ss')}\nSubscribers: ${subscribedUsers.size}\nSignals hôm nay: ${signalCountToday}`,
    };
    bot.sendMessage(chatId, reply.text);
});

// /analyzesymbol SYMBOL - phân tích thủ công
bot.onText(/\/analyzesymbol (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    let symbol = match[1].toUpperCase().trim();
    if (!symbol.endsWith('USDT')) symbol = `${symbol}USDT`;

    const processing = await bot.sendMessage(chatId, `⏳ Đang phân tích ${symbol}...`);
    try {
        const result = await analyzeSymbol(symbol);
        if (result && result.direction && result.direction !== 'NO_TRADE' && result.direction !== 'NEUTRAL') {
            const content = formatSignalMessage(result, 'MANUAL');
            await bot.deleteMessage(chatId, processing.message_id).catch(()=>{});
            await bot.sendMessage(chatId, content);
        } else {
            await bot.editMessageText(`❌ Không tìm thấy tín hiệu cho ${symbol}\nReason: ${result?.reason || 'No trade'}`, {
                chat_id: chatId,
                message_id: processing.message_id
            });
        }
    } catch (e) {
        console.error('/analyzesymbol error:', e.message || e);
        try { await bot.sendMessage(chatId, `❌ Lỗi phân tích ${symbol}: ${e.message || e}`); } catch {}
    }
});

// /analyzeall - phân tích toàn bộ TARGET_COINS
bot.onText(/\/analyzeall/, async (msg) => {
    const chatId = msg.chat.id;
    const processing = await bot.sendMessage(chatId, `⏳ Đang phân tích ${TARGET_COINS.length} coins... Vui lòng chờ.`);
    try {
        let results = [];
        for (let i = 0; i < TARGET_COINS.length; i++) {
            const coin = TARGET_COINS[i];
            try {
                const res = await analyzeSymbol(coin);
                if (res && res.direction && res.direction !== 'NO_TRADE' && (res.confidence || 0) >= 60) {
                    results.push(res);
                }
            } catch (e) {
                console.warn(`Analyze ${coin} failed: ${e.message || e}`);
            }
            await new Promise(r => setTimeout(r, 1200));
        }
        await bot.deleteMessage(chatId, processing.message_id).catch(()=>{});
        if (results.length === 0) {
            await bot.sendMessage(chatId, '❌ Không tìm thấy tín hiệu (confidence ≥ 60%) trên toàn bộ danh sách.');
        } else {
            results = results.sort((a,b)=>(b.confidence||0)-(a.confidence||0)).slice(0, 20);
            let text = `🔍 KẾT QUẢ PHÂN TÍCH TOÀN BỘ (${results.length} tín hiệu)\n\n`;
            for (const r of results) {
                text += `#${r.symbol.replace('USDT','')} - ${r.direction} - Conf: ${r.confidence}%\nEntry: ${fmtNumForMsg(r.entry)} | SL: ${fmtNumForMsg(r.sl)} | TP: ${fmtNumForMsg(r.tp)}\n\n`;
            }
            await bot.sendMessage(chatId, text);
        }
    } catch (e) {
        console.error('/analyzeall error:', e.message || e);
        try { await bot.sendMessage(chatId, `❌ Lỗi khi phân tích toàn bộ: ${e.message || e}`); } catch {}
    }
});

// /users - list subscribers (open)
bot.onText(/\/users/, (msg) => {
    const chatId = msg.chat.id;
    let text = `📊 Subscribers: ${subscribedUsers.size}\n\n`;
    let i = 0;
    for (const [id, info] of subscribedUsers) {
        if (i >= 100) break;
        text += `- ${id} ${info.userInfo.username ? `(@${info.userInfo.username})` : ''} added: ${moment(info.activatedAt).format('DD/MM HH:mm')}\n`;
        i++;
    }
    bot.sendMessage(chatId, text);
});

console.log('🤖 Bot is running.');
console.log(`⏰ Auto analysis every ${ANALYSIS_INTERVAL/(60*60*1000)} hours (active window 04:00-23:30)`);
console.log(`🎯 Min confidence: 60% | Target coins: ${TARGET_COINS.length}`);
