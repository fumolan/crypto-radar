// 📡 加密雷达 — 四周期(1h/4h/24h/7d)热点扫描 + 共性画像
const $ = (id) => document.getElementById(id);
const STABLES = new Set(["USDC", "FDUSD", "TUSD", "BUSD", "DAI", "USDP", "PAXG", "EUR", "GBP",
  "TRY", "BRL", "AEUR", "USD1", "EURI", "XUSD", "USDE", "USTC", "FRAX"]);
const MIN_VOL = 1e6;
const KAICANG = "https://fumolan.github.io/kaicang/?coin=";
const WINDOWS = ["1h", "4h", "7d"];

const fmtPrice = (p) => p >= 1000 ? p.toLocaleString("en-US", { maximumFractionDigits: 2 })
  : p >= 1 ? (+p.toFixed(4)).toString() : String(+p.toFixed(10));
const fmtVol = (v) => v >= 1e9 ? "$" + (v / 1e9).toFixed(2) + "B" : v >= 1e6 ? "$" + (v / 1e6).toFixed(1) + "M" : "$" + (v / 1e3).toFixed(0) + "K";
const pct = (n) => (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
const clsOf = (n) => n >= 0 ? "up" : "down";

// ---------- 币安 ----------
const BN_HOSTS = ["https://data-api.binance.vision", "https://api.binance.com", "https://api1.binance.com"];
let bnHost = BN_HOSTS[0];

async function bnFetch(path) {
  for (let i = 0; i < BN_HOSTS.length; i++) {
    const h = BN_HOSTS[(BN_HOSTS.indexOf(bnHost) + i) % BN_HOSTS.length];
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000);
      const r = await fetch(h + path, { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      bnHost = h;
      return j;
    } catch (e) { /* 换主机 */ }
  }
  throw new Error("币安不可达");
}

// 24h全市场 → 有效池(USDT对·非稳定/杠杆·成交额>$1M)
async function fetchUniverse() {
  const data = await bnFetch("/api/v3/ticker/24hr");
  const rows = [];
  for (const t of data) {
    const s = t.symbol || "";
    if (!s.endsWith("USDT")) continue;
    const base = s.slice(0, -4);
    if (STABLES.has(base) || s.endsWith("UPUSDT") || s.endsWith("DOWNUSDT")) continue;
    const qv = +t.quoteVolume || 0;
    if (qv < MIN_VOL) continue;
    rows.push({ sym: base, price: +t.lastPrice || 0, chg24: +t.priceChangePercent || 0, vol24: qv });
  }
  return rows;
}

// 滚动窗口涨跌幅(1h/4h/7d): symbols分批100个
async function fetchWindowMap(symbols, win) {
  const out = {};
  for (let i = 0; i < symbols.length; i += 100) {
    const batch = symbols.slice(i, i + 100);
    const q = encodeURIComponent(JSON.stringify(batch.map(s => s + "USDT")));
    const data = await bnFetch(`/api/v3/ticker?symbols=${q}&windowSize=${win}`);
    for (const t of data) out[t.symbol.slice(0, -4)] = +t.priceChangePercent || 0;
  }
  return out;
}

// ---------- OKX(24h, 实时优先/快照兜底) ----------
async function fetchOKX() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch("https://www.okx.com/api/v5/market/tickers?instType=SPOT", { signal: ctrl.signal });
    clearTimeout(t);
    const d = await r.json();
    if (d.code === "0" && Array.isArray(d.data)) {
      const rows = [];
      for (const x of d.data) {
        const iid = x.instId || "";
        if (!iid.endsWith("-USDT")) continue;
        const base = iid.slice(0, -5);
        if (STABLES.has(base)) continue;
        const open = +x.open24h, last = +x.last, vol = +x.volCcy24h || 0;
        if (!(open > 0) || vol < MIN_VOL) continue;
        rows.push({ sym: base, chg: (last / open - 1) * 100, vol });
      }
      rows.sort((a, b) => b.chg - a.chg);
      return { rows, live: true, ts: Date.now() / 1000 };
    }
  } catch (e) { /* 快照 */ }
  const r = await fetch("data.json?v=" + Date.now(), { cache: "no-store" });
  if (!r.ok) throw new Error("OKX不可用");
  const d = await r.json();
  const all = [...(d.up || []), ...(d.down || [])].sort((a, b) => b.chg - a.chg);
  return { rows: all, live: false, time: d.time, ts: d.ts };
}

// ---------- 热度与结构 ----------
function percentileRanks(vals) {
  const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(vals.length);
  idx.forEach(([, i], rank) => { out[i] = rank / Math.max(1, vals.length - 1) * 100; });
  return out;
}
function classify(r) {
  const { c1, c4, chg24, c7 } = r;
  if (c1 > 0 && c4 > 0 && chg24 > 0 && c7 > 0) return { tag: "四周期共振", cls: "t-all" };
  if (c1 > 0 && c4 > 0 && (chg24 <= 0 || c7 <= 0)) return { tag: "短周期启动", cls: "t-short" };
  if (c7 > 0 && chg24 > 0 && (c1 <= 0 || c4 <= 0)) return { tag: "趋势回调", cls: "t-pull" };
  if (c7 < 0 && chg24 <= 0 && c1 > 0) return { tag: "超跌反弹", cls: "t-reb" };
  return { tag: "混合", cls: "t-mix" };
}

// ---------- 渲染 ----------
let sortDim = "heat";
function hotTable(rows) {
  const label = { c1: "1小时", c4: "4小时", chg24: "24小时", c7: "7天", heat: "热度" };
  const sorted = [...rows].sort((a, b) => (b[sortDim] ?? -1e9) - (a[sortDim] ?? -1e9));
  const th = (d) => `<th class="sortable ${sortDim === d ? "on" : ""}" data-dim="${d}">${label[d]}↓</th>`;
  $("hotHead").innerHTML = `<tr><th>#</th><th>币种</th>${th("c1")}${th("c4")}${th("chg24")}${th("c7")}${th("heat")}<th>结构</th><th>24h额</th><th></th></tr>`;
  $("hotBody").innerHTML = sorted.slice(0, 30).map((r, i) => {
    const k = classify(r);
    const td = (v) => `<td class="num ${clsOf(v)}">${pct(v)}</td>`;
    return `<tr class="hrow" data-sym="${r.sym}">
      <td class="dim">${i + 1}</td><td class="sym"><b>${r.sym}</b></td>
      ${td(r.c1)}${td(r.c4)}${td(r.chg24)}${td(r.c7)}
      <td class="num heat">${Math.round(r.heat)}</td>
      <td><span class="stag ${k.cls}">${k.tag}</span></td>
      <td class="dim">${fmtVol(r.vol24)}</td><td class="go">→</td>
    </tr>`;
  }).join("");
  $("hotHead").querySelectorAll("th.sortable").forEach(el =>
    el.addEventListener("click", () => { sortDim = el.dataset.dim; hotTable(rows); }));
  $("hotBody").querySelectorAll("tr").forEach(el =>
    el.addEventListener("click", () => window.open(KAICANG + el.dataset.sym + "USDT", "_blank")));
}

function insights(rows, ok) {
  const top = [...rows].sort((a, b) => b.heat - a.heat).slice(0, 20);
  const kinds = top.map(r => classify(r).tag);
  const cnt = (t) => kinds.filter(x => x === t).length;
  const vols = top.map(r => r.vol24).sort((a, b) => a - b);
  const med = vols[Math.floor(vols.length / 2)] || 0;
  const rich = top.filter(r => r.vol24 > 1e7).length;
  const accel = top.filter(r => r.c1 > r.c7 / 168).length;
  const allUp = cnt("四周期共振");
  const okSet = new Set((ok.rows || []).slice(0, 30).map(r => r.sym));
  const dual = top.filter(r => okSet.has(r.sym));
  const pulse = top.filter(r => r.c1 > 5).length;

  const item = (icon, html) => `<div class="ins-row">${icon} ${html}</div>`;
  let html = "";
  html += item("🧭", `<b>结构分布(TOP20)</b>: <span class="t-all">四周期共振 ${allUp}只</span> · <span class="t-short">短周期启动 ${cnt("短周期启动")}只</span> · <span class="t-pull">趋势回调 ${cnt("趋势回调")}只</span> · <span class="t-reb">超跌反弹 ${cnt("超跌反弹")}只</span> — ${allUp >= kinds.length / 2 ? "普涨式热点(趋势市)" : "结构性热点(分化市)"}`);
  html += item("💰", `<b>量能共性</b>: 24h成交额中位数 <b>${fmtVol(med)}</b>, ${rich}/${top.length} 只超$10M — ${rich > top.length * 0.7 ? "热点均有真实量能配合" : "部分热点缩量, 警惕假突破"}`);
  html += item("🚀", `<b>加速特征</b>: ${accel}/${top.length} 只 1小时涨幅已超 7天均速 — ${accel > top.length / 2 ? "热点普遍正在加速(追高风险与空间并存)" : "热点多为匀速趋势, 短期未过热"}`);
  html += item("⚡", `<b>短线脉冲</b>: ${pulse}/${top.length} 只近1小时涨幅>5% — ${pulse > 8 ? "盘中正在集中爆发" : "无集中脉冲, 热点偏趋势型"}`);
  if (dual.length) {
    html += item("🤝", `<b>双所印证</b>: ${dual.map(r => `<span class="dual">${r.sym}</span>`).join(" ")} 同在OKX 24h强势区`);
  }
  $("insBody").innerHTML = html;
}

function renderOKX(ok) {
  const okx = $("okxSrc");
  const up = ok.rows.slice(0, 10), down = [...ok.rows.slice(-10)].reverse();
  const row = (r, i) => `<div class="rk-row" data-sym="${r.sym}">
    <span class="rk-i">${i + 1}</span><span class="rk-sym"><b>${r.sym}</b></span>
    <span class="rk-chg ${clsOf(r.chg)}">${pct(r.chg)}</span>
    <span class="rk-vol">${fmtVol(r.vol)}</span><span class="rk-go">→</span></div>`;
  $("okUp").innerHTML = up.map(row).join("");
  $("okDown").innerHTML = down.map((r, i) => row(r, i)).join("");
  ["okUp", "okDown"].forEach(id => $(id).querySelectorAll(".rk-row").forEach(el =>
    el.addEventListener("click", () => window.open(KAICANG + el.dataset.sym + "USDT", "_blank"))));
  if (ok.live) { okx.textContent = "OKX:实时"; okx.className = "okx-src live"; $("okInfo").textContent = `有效${ok.rows.length}对`; }
  else {
    const ageMin = ok.ts ? Math.max(0, Math.round((Date.now() / 1000 - ok.ts) / 60)) : "?";
    okx.textContent = `OKX:快照 ${ok.time || ""} (${ageMin}分钟前)`;
    okx.className = "okx-src snap";
    $("okInfo").textContent = "";
  }
}

// ---------- 扫描 ----------
let timer = null, busy = false;
async function scan() {
  if (busy) return;
  busy = true;
  $("statusDot").className = "dot";
  try {
    const uni = await fetchUniverse();
    const syms = uni.map(r => r.sym);
    const maps = await Promise.all(WINDOWS.map(w => fetchWindowMap(syms, w)));
    uni.forEach(r => {
      r.c1 = maps[0][r.sym] ?? 0;
      r.c4 = maps[1][r.sym] ?? 0;
      r.c7 = maps[2][r.sym] ?? 0;
    });
    const p1 = percentileRanks(uni.map(r => r.c1));
    const p4 = percentileRanks(uni.map(r => r.c4));
    const p24 = percentileRanks(uni.map(r => r.chg24));
    const p7 = percentileRanks(uni.map(r => r.c7));
    uni.forEach((r, i) => { r.heat = (p1[i] + p4[i] + p24[i] + p7[i]) / 4; });

    const ok = await fetchOKX().catch(() => null);
    hotTable(uni);
    insights(uni, ok || { rows: [] });
    if (ok) renderOKX(ok);
    $("bnInfo").textContent = `有效${uni.length}对 · 币安四周期`;
    $("statusDot").className = "dot ok";
    $("lastUpdate").textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  } catch (e) {
    $("statusDot").className = "dot err";
    console.error(e);
  } finally { busy = false; }
}
function startTimer() {
  clearInterval(timer);
  const sec = +$("intervalSel").value;
  if (sec > 0) timer = setInterval(scan, sec * 1000);
}
$("intervalSel").addEventListener("change", startTimer);
$("refreshBtn").addEventListener("click", scan);

scan();
startTimer();
