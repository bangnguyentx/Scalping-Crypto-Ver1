const axios = require('axios');

// --- MULTIPLE DATA SOURCES ---
const DATA_SOURCES = [
    {
        name: 'Binance Main',
        klines: (symbol, interval, limit = 500) =>
            `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
        priority: 1
    },
    {
        name: 'Binance Backup 1',
        klines: (symbol, interval, limit = 500) =>
            `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
        priority: 2
    },
    {
        name: 'Bybit Backup',
        klines: (symbol, interval, limit = 500) => {
            const mapping = { '1d': 'D', '4h': '240', '1h': '60', '15m': '15' };
            return `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${mapping[interval] || '60'}&limit=${limit}`;
        },
        priority: 3
    }
];

const TIMEFRAMES = [
    { label: 'D1', interval: '1d', weight: 1.5 },
    { label: 'H4', interval: '4h', weight: 1.3 },
    { label: 'H1', interval: '1h', weight: 1.1 },
    { label: '15M', interval: '15m', weight: 0.8 }
];

// --- SMART CANDLE LOADER WITH MULTI-SOURCE FALLBACK ---
async function loadCandles(symbol, interval, limit = 500) {
    const sources = [...DATA_SOURCES].sort((a,b)=>a.priority - b.priority);
    for (const source of sources) {
        try {
            const url = source.klines(symbol, interval, limit);
            const response = await axios.get(url, {
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; TradingBot/1.0)',
                    'Accept': 'application/json'
                }
            });
            if (response.status === 200 && response.data) {
                let candles;
                if (source.name.includes('Bybit')) {
                    if (response.data && response.data.result && response.data.result.list) {
                        candles = response.data.result.list.map(c => ({
                            open: parseFloat(c[1]),
                            high: parseFloat(c[2]),
                            low: parseFloat(c[3]),
                            close: parseFloat(c[4]),
                            vol: parseFloat(c[5]),
                            t: parseFloat(c[0])
                        })).reverse();
                    } else {
                        throw new Error('Invalid Bybit response');
                    }
                } else {
                    candles = response.data.map(c => ({
                        open: parseFloat(c[1]),
                        high: parseFloat(c[2]),
                        low: parseFloat(c[3]),
                        close: parseFloat(c[4]),
                        vol: parseFloat(c[5]),
                        t: c[0]
                    }));
                }
                if (candles && candles.length > 0) return candles;
            }
        } catch (e) {
            // continue to next source
            // console.warn(`${source.name} failed for ${symbol} ${interval}: ${e.response?.status || e.code || e.message}`);
            if (e.response && (e.response.status === 418 || e.response.status === 429)) {
                await new Promise(r => setTimeout(r, 4000));
            }
            continue;
        }
    }
    throw new Error(`All sources failed for ${symbol} ${interval}`);
}

// --- INDICATORS / HELPERS ---
function calculateATR(candles, period = 14) {
    if (!candles || candles.length < period + 1) return 0;
    const tr = [];
    for (let i = 1; i < candles.length; i++) {
        const v = Math.max(
            candles[i].high - candles[i].low,
            Math.abs(candles[i].high - candles[i-1].close),
            Math.abs(candles[i].low - candles[i-1].close)
        );
        tr.push(v);
    }
    let atr = tr.slice(0, period).reduce((a,b)=>a+b,0) / period;
    for (let i = period; i < tr.length; i++) {
        atr = (atr * (period - 1) + tr[i]) / period;
    }
    return atr;
}

function isSwingHigh(highs, index, lookback = 3) {
    for (let i = 1; i <= lookback; i++) {
        if (index - i >= 0 && highs[index] <= highs[index - i]) return false;
        if (index + i < highs.length && highs[index] <= highs[index + i]) return false;
    }
    return true;
}

function isSwingLow(lows, index, lookback = 3) {
    for (let i = 1; i <= lookback; i++) {
        if (index - i >= 0 && lows[index] >= lows[index - i]) return false;
        if (index + i < lows.length && lows[index] >= lows[index + i]) return false;
    }
    return true;
}

function analyzeAdvancedMarketStructure(candles) {
    if (!candles || candles.length < 10) {
        return { swingHighs: [], swingLows: [], trend: 'neutral', breakOfStructure: false, changeOfCharacter: false };
    }
    const highs = candles.map(c=>c.high);
    const lows  = candles.map(c=>c.low);
    const structure = { swingHighs: [], swingLows: [], trend: 'neutral', breakOfStructure: false, changeOfCharacter: false };
    for (let i = 3; i < candles.length - 3; i++) {
        if (isSwingHigh(highs, i)) structure.swingHighs.push({ index: i, price: highs[i], time: candles[i].t });
        if (isSwingLow(lows, i)) structure.swingLows.push({ index: i, price: lows[i], time: candles[i].t });
    }
    if (structure.swingHighs.length >= 2 && structure.swingLows.length >= 2) {
        const rh = structure.swingHighs.slice(-2);
        const rl = structure.swingLows.slice(-2);
        if (rh[1].price > rh[0].price && rl[1].price > rl[0].price) structure.trend = 'bullish';
        else if (rh[1].price < rh[0].price && rl[1].price < rl[0].price) structure.trend = 'bearish';
    }
    structure.breakOfStructure = detectBreakOfStructure(structure);
    structure.changeOfCharacter = detectChangeOfCharacter(structure);
    return structure;
}

function detectBreakOfStructure(structure) {
    if (structure.swingHighs.length < 3 || structure.swingLows.length < 3) return false;
    const recentHighs = structure.swingHighs.slice(-3);
    const recentLows = structure.swingLows.slice(-3);
    if (structure.trend === 'bullish') return recentHighs[2].price > recentHighs[1].price && recentHighs[1].price > recentHighs[0].price;
    if (structure.trend === 'bearish') return recentLows[2].price < recentLows[1].price && recentLows[1].price < recentLows[0].price;
    return false;
}

function detectChangeOfCharacter(structure) {
    if (structure.swingHighs.length < 3 || structure.swingLows.length < 3) return false;
    const recentHighs = structure.swingHighs.slice(-3);
    const recentLows = structure.swingLows.slice(-3);
    if (structure.trend === 'bullish') return recentLows[2].price > recentLows[1].price && recentLows[1].price < recentLows[0].price;
    if (structure.trend === 'bearish') return recentHighs[2].price < recentHighs[1].price && recentHighs[1].price > recentHighs[0].price;
    return false;
}

function findOrderBlocks(candles) {
    if (!candles || candles.length < 3) return [];
    const blocks = [];
    for (let i = 1; i < candles.length - 1; i++) {
        const cur = candles[i], next = candles[i+1];
        if (cur.close < cur.open && next.close < next.open && Math.abs(next.close - next.open) > Math.abs(cur.close - cur.open) * 1.5) {
            blocks.push({ type: 'bearish', high: cur.high, low: cur.low, time: cur.t, strength: 0.7 });
        }
        if (cur.close > cur.open && next.close > next.open && Math.abs(next.close - next.open) > Math.abs(cur.close - cur.open) * 1.5) {
            blocks.push({ type: 'bullish', high: cur.high, low: cur.low, time: cur.t, strength: 0.7 });
        }
    }
    return blocks.slice(-10);
}

function findFairValueGaps(candles) {
    if (!candles || candles.length < 3) return [];
    const gaps = [];
    for (let i = 1; i < candles.length - 1; i++) {
        const prev = candles[i-1], curr = candles[i], next = candles[i+1];
        if (curr.low > Math.max(prev.high, next.high)) {
            gaps.push({ type: 'bullish', high: Math.min(prev.low, next.low), low: curr.high, time: curr.t, strength: 0.6 });
        }
        if (curr.high < Math.min(prev.low, next.low)) {
            gaps.push({ type: 'bearish', high: curr.low, low: Math.max(prev.high, next.high), time: curr.t, strength: 0.6 });
        }
    }
    return gaps.slice(-8);
}

function analyzeVolumeProfile(candles) {
    if (!candles || candles.length === 0) return { poc: 0, totalVolume: 0, averageVolume: 0, volumeDelta: 1 };
    const volumeByPrice = {};
    let totalVolume = 0;
    for (const candle of candles) {
        const range = candle.high - candle.low;
        if (range === 0) continue;
        const step = range / 10;
        for (let i = 0; i < 10; i++) {
            const priceLevel = (candle.low + step * i).toFixed(2);
            volumeByPrice[priceLevel] = (volumeByPrice[priceLevel] || 0) + (candle.vol / 10);
        }
        totalVolume += candle.vol;
    }
    let poc = 0, maxVol = 0;
    for (const [p, v] of Object.entries(volumeByPrice)) {
        if (v > maxVol) { maxVol = v; poc = parseFloat(p); }
    }
    return { poc, totalVolume, averageVolume: totalVolume / candles.length, volumeDelta: calculateVolumeDelta(candles) };
}

function calculateVolumeDelta(candles) {
    if (!candles || candles.length < 20) return 1;
    const recent = candles.slice(-5).reduce((s,c)=>s+c.vol,0)/5;
    const older  = candles.slice(-20,-5).reduce((s,c)=>s+c.vol,0)/15;
    return older === 0 ? 1 : recent / older;
}

function findLiquidityLevels(candles) {
    if (!candles || candles.length < 10) return [];
    const levels = [];
    const highs = candles.map(c=>c.high), lows = candles.map(c=>c.low);
    for (let i = 5; i < candles.length - 5; i++) {
        if (isSwingHigh(highs, i, 2)) levels.push({ type: 'resistance', price: highs[i], time: candles[i].t, strength: 'strong' });
        if (isSwingLow(lows, i, 2)) levels.push({ type: 'support', price: lows[i], time: candles[i].t, strength: 'strong' });
    }
    return levels.slice(-6);
}

function analyzeTimeframeICT(candles, timeframe) {
    if (!candles || candles.length === 0) return null;
    const price = candles[candles.length - 1].close;
    const marketStructure = analyzeAdvancedMarketStructure(candles);
    const orderBlocks = findOrderBlocks(candles);
    const fairValueGaps = findFairValueGaps(candles);
    const volumeAnalysis = analyzeVolumeProfile(candles);
    const liquidityLevels = findLiquidityLevels(candles);
    const atr = calculateATR(candles);
    return {
        price,
        trend: marketStructure.trend,
        strength: calculateTrendStrength(marketStructure),
        marketStructure,
        orderBlocks: filterRelevantLevels(orderBlocks, price),
        fairValueGaps: filterRelevantLevels(fairValueGaps, price),
        volumeAnalysis,
        liquidityLevels: filterRelevantLevels(liquidityLevels, price),
        atr,
        confidence: calculateTimeframeConfidence(marketStructure, volumeAnalysis, orderBlocks.length)
    };
}

function calculateTrendStrength(marketStructure) {
    if (!marketStructure || marketStructure.swingHighs.length < 2 || marketStructure.swingLows.length < 2) return 0;
    const rh = marketStructure.swingHighs.slice(-2), rl = marketStructure.swingLows.slice(-2);
    const highSlope = (rh[1].price - rh[0].price) / (rh[1].index - rh[0].index);
    const lowSlope  = (rl[1].price - rl[0].price) / (rl[1].index - rl[0].index);
    return Math.abs(highSlope + lowSlope) / 2;
}

function filterRelevantLevels(levels, currentPrice) {
    if (!levels || levels.length === 0) return [];
    return levels.filter(l => Math.abs(l.price - currentPrice) / currentPrice < 0.05);
}

function calculateTimeframeConfidence(marketStructure, volumeAnalysis, obCount) {
    let confidence = 50;
    if (marketStructure.trend !== 'neutral') confidence += 20;
    if (volumeAnalysis.volumeDelta > 1.2) confidence += 15;
    if (obCount > 0) confidence += 10;
    return Math.min(95, confidence);
}

function calculateRealConfidence(results) {
    let totalScore = 0, maxScore = 0;
    for (const [tf, data] of Object.entries(results.timeframes)) {
        if (!data.analysis) continue;
        const weight = getTimeframeWeight(tf);
        const tfScore = calculateTFScoreICT(data.analysis);
        totalScore += tfScore * weight;
        maxScore += 100 * weight;
    }
    if (maxScore === 0) return 0;
    const confluenceBonus = calculateConfluenceBonus(results);
    totalScore += confluenceBonus;
    return Math.min(100, (totalScore / maxScore) * 100);
}

function getTimeframeWeight(tf) {
    const weights = { 'D1': 1.5, 'H4': 1.3, 'H1': 1.1, '15M': 0.8 };
    return weights[tf] || 1.0;
}

function calculateTFScoreICT(analysis) {
    if (!analysis) return 0;
    let score = 0;
    score += analysis.marketStructure.trend !== 'neutral' ? 25 : 0;
    score += analysis.marketStructure.breakOfStructure ? 15 : 0;
    score += analysis.marketStructure.changeOfCharacter ? 8 : 0;
    if (analysis.volumeAnalysis.volumeDelta) score += Math.min(30, (analysis.volumeAnalysis.volumeDelta - 1) * 60);
    score += Math.min(25, analysis.orderBlocks.length * 4);
    score += Math.min(20, analysis.fairValueGaps.length * 3);
    if (analysis.liquidityLevels.length > 0) {
        score += 15;
        const nearLiquidity = analysis.liquidityLevels.some(level => Math.abs(analysis.price - level.price) < analysis.atr * 0.5);
        if (nearLiquidity) score += 15;
    }
    return Math.min(100, score);
}

function calculateConfluenceBonus(results) {
    let bonus = 0;
    const timeframes = Object.values(results.timeframes).filter(tf => tf.analysis);
    const bullishSignals = timeframes.filter(tf => tf.analysis.trend === 'bullish' && tf.analysis.orderBlocks.some(ob => ob.type === 'bullish')).length;
    const bearishSignals = timeframes.filter(tf => tf.analysis.trend === 'bearish' && tf.analysis.orderBlocks.some(ob => ob.type === 'bearish')).length;
    const confluence = Math.max(bullishSignals, bearishSignals);
    bonus = confluence * 8;
    return Math.min(30, bonus);
}

function calculateMultiTFBias(timeframes) {
    let bias = 0;
    timeframes.forEach((tf, index) => {
        if (!tf.analysis) return;
        const weight = TIMEFRAMES[index].weight;
        const analysis = tf.analysis;
        if (analysis.trend === 'bullish') bias += weight;
        else if (analysis.trend === 'bearish') bias -= weight;
        if (analysis.marketStructure.breakOfStructure) {
            if (analysis.marketStructure.trend === 'bullish') bias += weight * 0.5;
            else if (analysis.marketStructure.trend === 'bearish') bias -= weight * 0.5;
        }
    });
    return bias;
}

// --- SMART ENTRY / SL / TP helpers (RR bounds enforced 1.5 - 2.5) ---
function findOptimalLongEntry(currentPrice, analysis, multiTimeframeAnalysis) {
    const relevantOBs = analysis.orderBlocks.filter(ob => ob.type === 'bullish' && currentPrice > ob.low && currentPrice < ob.high * 1.02);
    if (relevantOBs.length > 0) {
        const bestOB = relevantOBs.reduce((best, cur) => cur.strength > best.strength ? cur : best);
        return bestOB.low * 0.998;
    }
    const relevantFVGs = analysis.fairValueGaps.filter(fvg => fvg.type === 'bullish' && currentPrice > fvg.low && currentPrice < fvg.high);
    if (relevantFVGs.length > 0) {
        const bestFVG = relevantFVGs[0];
        return Math.max(bestFVG.low, currentPrice * 0.995);
    }
    const supports = analysis.liquidityLevels.filter(l => l.type === 'support').map(l => l.price).filter(p => p < currentPrice).sort((a,b)=>b-a);
    if (supports.length > 0) return supports[0] * 1.001;
    return currentPrice * 0.998;
}

function findOptimalShortEntry(currentPrice, analysis, multiTimeframeAnalysis) {
    const relevantOBs = analysis.orderBlocks.filter(ob => ob.type === 'bearish' && currentPrice < ob.high && currentPrice > ob.low * 0.98);
    if (relevantOBs.length > 0) {
        const bestOB = relevantOBs.reduce((best, cur) => cur.strength > best.strength ? cur : best);
        return bestOB.high * 1.002;
    }
    const relevantFVGs = analysis.fairValueGaps.filter(fvg => fvg.type === 'bearish' && currentPrice < fvg.high && currentPrice > fvg.low);
    if (relevantFVGs.length > 0) {
        const bestFVG = relevantFVGs[0];
        return Math.min(bestFVG.high, currentPrice * 1.005);
    }
    const resistances = analysis.liquidityLevels.filter(l => l.type === 'resistance').map(l => l.price).filter(p => p > currentPrice).sort((a,b)=>a-b);
    if (resistances.length > 0) return resistances[0] * 0.999;
    return currentPrice * 1.002;
}

// SL calculation uses ATR (analysis.atr)
function calculateSmartStopLoss(entry, direction, analysis, multiTimeframeAnalysis) {
    const atr = (analysis && analysis.atr) ? analysis.atr : 0.0001;
    if (direction === 'LONG') {
        const supports = analysis.liquidityLevels.filter(l => l.type === 'support').map(l => l.price).filter(price => price < entry && price >= entry - (atr * 1.5)).sort((a,b)=>b-a);
        if (supports.length > 0) {
            const nearestSupport = supports[0];
            const atrSL = entry - (atr * 0.6);
            return Math.min(nearestSupport, atrSL);
        }
        return entry - (atr * 0.8);
    } else {
        const resistances = analysis.liquidityLevels.filter(l => l.type === 'resistance').map(l => l.price).filter(price => price > entry && price <= entry + (atr * 1.5)).sort((a,b)=>a-b);
        if (resistances.length > 0) {
            const nearestResistance = resistances[0];
            const atrSL = entry + (atr * 0.6);
            return Math.max(nearestResistance, atrSL);
        }
        return entry + (atr * 0.8);
    }
}

function calculateSmartTakeProfit(entry, sl, direction, analysis, multiTimeframeAnalysis) {
    const risk = Math.abs(entry - sl);
    const atr = (analysis && analysis.atr) ? analysis.atr : Math.max(Math.abs(entry*0.01), 0.0001);
    if (direction === 'LONG') {
        const nearbyResistances = analysis.liquidityLevels.filter(l => l.type === 'resistance').map(l => l.price).filter(price => price > entry && price <= entry + (atr * 1.2)).sort((a,b)=>a-b);
        let tp = nearbyResistances.length > 0 ? nearbyResistances[0] : entry + (atr * 0.8);
        // Bound TP using RR rules min 1.5 - max 2.5
        const minTP = entry + risk * 1.5;
        const maxTP = entry + risk * 2.5;
        tp = Math.max(tp, minTP);
        tp = Math.min(tp, maxTP);
        return tp;
    } else {
        const nearbySupports = analysis.liquidityLevels.filter(l => l.type === 'support').map(l => l.price).filter(price => price < entry && price >= entry - (atr * 1.2)).sort((a,b)=>b-a);
        let tp = nearbySupports.length > 0 ? nearbySupports[0] : entry - (atr * 0.8);
        const minTP = entry - risk * 1.5;
        const maxTP = entry - risk * 2.5;
        tp = Math.min(tp, minTP);
        tp = Math.max(tp, maxTP);
        return tp;
    }
}

// validateLevels ensures rr between 1.5 and 2.5
function validateLevels(entry, sl, tp, currentPrice, atr) {
    if (!atr || atr <= 0) atr = Math.abs(entry - sl) || 1;
    // Ensure SL not too far (bounded by atr*2.5)
    const maxDistance = atr * 2.5;
    if (Math.abs(entry - sl) > maxDistance) {
        if (entry > sl) sl = entry - (atr * 1.0);
        else sl = entry + (atr * 1.0);
    }
    // Ensure TP not too far
    if (Math.abs(entry - tp) > maxDistance) {
        if (entry < tp) tp = entry + (atr * 1.5);
        else tp = entry - (atr * 1.5);
    }

    let rr = Math.abs(tp - entry) / Math.abs(entry - sl);
    // enforce rr bounds 1.5 - 2.5
    if (rr < 1.5) {
        // expand TP to minimum
        if (entry < tp) tp = entry + Math.abs(entry - sl) * 1.5;
        else tp = entry - Math.abs(entry - sl) * 1.5;
        rr = Math.abs(tp - entry) / Math.abs(entry - sl);
    } else if (rr > 2.5) {
        // shrink TP to maximum
        if (entry < tp) tp = entry + Math.abs(entry - sl) * 2.5;
        else tp = entry - Math.abs(entry - sl) * 2.5;
        rr = Math.abs(tp - entry) / Math.abs(entry - sl);
    }

    return { entry, sl, tp, rr: rr.toFixed(2) };
}

function calculateSmartLevels(direction, currentPrice, analysis, multiTimeframeAnalysis) {
    const atr = (analysis && analysis.atr) ? analysis.atr : 0.0001;
    if (direction === 'LONG') {
        const entry = findOptimalLongEntry(currentPrice, analysis, multiTimeframeAnalysis);
        let sl = calculateSmartStopLoss(entry, direction, analysis, multiTimeframeAnalysis);
        let tp = calculateSmartTakeProfit(entry, sl, direction, analysis, multiTimeframeAnalysis);
        const validated = validateLevels(entry, sl, tp, currentPrice, atr);
        return { entry: validated.entry, sl: validated.sl, tp: validated.tp, rr: validated.rr };
    } else {
        const entry = findOptimalShortEntry(currentPrice, analysis, multiTimeframeAnalysis);
        let sl = calculateSmartStopLoss(entry, direction, analysis, multiTimeframeAnalysis);
        let tp = calculateSmartTakeProfit(entry, sl, direction, analysis, multiTimeframeAnalysis);
        const validated = validateLevels(entry, sl, tp, currentPrice, atr);
        return { entry: validated.entry, sl: validated.sl, tp: validated.tp, rr: validated.rr };
    }
}

function calculatePositionSize(riskPercent, accountBalance, entry, sl, direction) {
    const riskAmount = accountBalance * (riskPercent / 100);
    const riskPerUnit = Math.abs(entry - sl);
    const size = riskPerUnit === 0 ? 0 : (riskAmount / riskPerUnit).toFixed(4);
    return { size: size, maxLoss: riskAmount.toFixed(2) };
}

// --- MAIN analyzeSymbol ---
async function analyzeSymbol(symbol) {
    try {
        const results = { timeframes: {}, marketStructure: {}, volumeAnalysis: {}, signals: {}, ictConcepts: {} };

        // load multiple timeframes with fallback
        for (const tf of TIMEFRAMES) {
            try {
                const candles = await loadCandles(symbol, tf.interval, 300);
                if (candles && candles.length > 0) {
                    results.timeframes[tf.label] = {
                        candles,
                        price: candles[candles.length - 1].close,
                        analysis: analyzeTimeframeICT(candles, tf.label)
                    };
                }
            } catch (e) {
                // skip tf if error
            }
        }

        const tfs = Object.values(results.timeframes);
        if (tfs.length === 0) {
            return { symbol, direction: 'NO_TRADE', confidence: 0, reason: 'No data' };
        }

        const currentPrice = tfs[0].price;
        const bias = calculateMultiTFBias(tfs);
        const confidence = Math.round(calculateRealConfidence(results));

        if (confidence < 60) {
            return { symbol, direction: 'NO_TRADE', confidence, reason: `Confidence ${confidence}% < 60%` };
        }

        const direction = bias > 0.5 ? 'LONG' : bias < -0.5 ? 'SHORT' : 'NEUTRAL';
        if (direction === 'NEUTRAL') {
            return { symbol, direction: 'NEUTRAL', confidence, reason: 'No clear bias' };
        }

        const primary = tfs.find(tf => tf.analysis && tf.analysis.confidence > 70) || tfs[0];
        if (!primary.analysis) return { symbol, direction: 'NO_TRADE', confidence: 0, reason: 'No valid primary analysis' };

        const levels = calculateSmartLevels(direction, currentPrice, primary.analysis, results);
        const pos = calculatePositionSize(2, 1000, parseFloat(levels.entry), parseFloat(levels.sl), direction);

        return {
            symbol,
            direction,
            confidence,
            entry: parseFloat(levels.entry).toFixed(4),
            sl: parseFloat(levels.sl).toFixed(4),
            tp: parseFloat(levels.tp).toFixed(4),
            rr: levels.rr,
            positionSize: pos.size,
            maxLoss: pos.maxLoss
        };

    } catch (e) {
        console.error(`Analysis error for ${symbol}:`, e.message || e);
        return { symbol, direction: 'NO_TRADE', confidence: 0, reason: `Analysis error: ${e.message || e}` };
    }
}

module.exports = { analyzeSymbol };
