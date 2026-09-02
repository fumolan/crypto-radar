// 📡 加密雷达 — 币安直连实时 + OKX实时/快照兜底
const $ = (id) => document.getElementById(id);
const STABLES = new Set(["USDC", "FDUSD", "TUSD", "BUSD", "DAI", "USDP", "PAXG", "EUR", "GBP",
  "TRY", "BRL", "AEUR", "USD1", "EURI", "XUSD", "USDE", "USTC", "FRAX"]);
const MIN_VOL = 1e6;
const KAICANG = "https://fumolan.github.io/kaicang/?coin=";

const fmtPrice = (p) => p >= 1000 ? p.toLocaleString("en-US", { maximumFractionDigits: 2 })
  : p >= 1 ? (+p.toFixed(4)).toString()
  : String(+p.toFixed(10));
const fmtVol = (v) => v >= 1e9 ? "$" + (v / 1e9).toFixed(2) + "B" : v >= 1e6 ? "$" + (v / 1e6).toFixed(1) + "M" : "$" + (v / 1e3).toFixed(0) + "K";
const fmtPct = (n) => (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
const clsOf = (n) => n >= 0 ? "up" : "down";

// ---------- 币安(实时, 浏览器直连) ----------
const BN_HOSTS = ["https://data-api.binance.vision", "https://api.binance.com", "https://api1.binance.com"];
async function fetchBinance() {
  let data = null, err = null;
  for (const h of BN_HOSTS) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10000);
      const r = await fetch(h + "/api/v3/ticker/24hr", { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error("HTTP " + r.status);
      data = await r.json();
      break;
    } catch (e) { err = e; }
  }
  if (!data) throw err || new Error("币安不可达");
  const rows = [];
  for (const t of data) {
    const s = t.symbol || "";
    if (!s.endsWith("USDT")) continue;
    const base = s.slice(0, -4);
    if (STABLES.has(base) || s.endsWith("UPUSDT") || s.endsWith("DOWNUSDT")) continue;
    const qv = +t.quoteVolume || 0;
    if (qv < MIN_VOL) continue;
    rows.push({ sym: base, price: +t.lastPrice || 0, chg: +t.priceChangePercent || 0, vol: qv });
  }
  rows.sort((a, b) => b.chg - a.chg);
  return rows;
}

// ---------- OKX(先试实时, 失败用Actions快照) ----------
async function fetchOKX() {
  // 1) 实时
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
        rows.push({ sym: base, price: last, chg: (last / open - 1) * 100, vol });
      }
      rows.sort((a, b) => b.chg - a.chg);
      return { rows, live: true, time: null };
    }
  } catch (e) { /* 落到快照 */ }
  // 2) 快照兜底
  const r = await fetch("data.json?v=" + Date.now(), { cache: "no-store" });
  if (!r.ok) throw new Error("OKX实时与快照均不可用");
  const d = await r.json();
  const all = [...(d.up || []), ...(d.down || [])].sort((a, b) => b.chg - a.chg);
  return { rows: all, live: false, time: d.time, ts: d.ts, total: d.total };
}

// ---------- 渲染 ----------
function tableHTML(rows, start = 1) {
  return rows.map((r, i) => `<div class="rk-row" data-sym="${r.sym}">
    <span class="rk-i">${start + i}</span>
    <span class="rk-sym"><b>${r.sym}</b></span>
    <span class="rk-price">${fmtPrice(r.price)}</span>
    <span class="rk-chg ${clsOf(r.chg)}">${fmtPct(r.chg)}</span>
    <span class="rk-vol">${fmtVol(r.vol)}</span>
    <span class="rk-go" title="到开仓页分析">→</span>
  </div>`).join("");
}
function bindRows(el) {
  el.querySelectorAll(".rk-row").forEach(x =>
    x.addEventListener("click", () =>
      window.open(KAICANG + x.dataset.sym + "USDT", "_blank")));
}

function render(bn, okw) {
  const ok = okw.rows;
  const bnUp = bn.slice(0, 10), bnDown = [...bn.slice(-10)].reverse();
  const okUp = ok.slice(0, 10), okDown = [...ok.slice(-10)].reverse();

  $("bnUp").innerHTML = tableHTML(bnUp);
  $("bnDown").innerHTML = tableHTML(bnDown);
  $("okUp").innerHTML = tableHTML(okUp);
  $("okDown").innerHTML = tableHTML(okDown);
  ["bnUp", "bnDown", "okUp", "okDown"].forEach(id => bindRows($(id)));
  $("bnInfo").textContent = `有效${bn.length}对`;

  const okx = $("okxSrc");
  if (okw.live) {
    $("okInfo").textContent = `有效${ok.length}对`;
    okx.textContent = "OKX:实时";
    okx.className = "okx-src live";
  } else {
    $("okInfo").textContent = `有效${okw.total || ok.length}对`;
    const ageMin = okw.ts ? Math.max(0, Math.round((Date.now() / 1000 - okw.ts) / 60)) : "?";
    okx.textContent = `OKX:快照 ${okw.time || ""} (${ageMin}分钟前)`;
    okx.className = "okx-src snap";
  }

  // 双所共振
  const s = (rows) => new Set(rows.map(r => r.sym));
  const resUp = [...s(bnUp).intersection ? s(bnUp) : s(bnUp)].filter(x => s(okUp).has(x));
  const resDown = [...s(bnDown)].filter(x => s(okDown).has(x));
  const rc = $("resCard");
  if (resUp.length || resDown.length) {
    rc.classList.remove("hidden");
    const chip = (sym, up) => {
      const bn = (up ? bnUp : bnDown).find(r => r.sym === sym);
      const okr = (up ? okUp : okDown).find(r => r.sym === sym);
      return `<div class="res-chip ${up ? "rup" : "rdown"}">
        <b>${sym}</b>
        <span>币安${fmtPct(bn ? bn.chg : 0)}</span>
        <span>OKX${fmtPct(okr ? okr.chg : 0)}</span>
        <span class="res-go">→</span>
      </div>`;
    };
    let html = "";
    if (resUp.length) html += `<div class="res-line"><span class="res-tag t-up">同涨共振</span>${resUp.map(x => chip(x, true)).join("")}</div>`;
    if (resDown.length) html += `<div class="res-line"><span class="res-tag t-down">同跌共振</span>${resDown.map(x => chip(x, false)).join("")}</div>`;
    $("resBody").innerHTML = html;
    $("resBody").querySelectorAll(".res-chip").forEach(c =>
      c.addEventListener("click", () => window.open(KAICANG + c.querySelector("b").textContent + "USDT", "_blank")));
  } else {
    rc.classList.add("hidden");
  }
}

// ---------- 刷新调度 ----------
let timer = null, busy = false;
async function scan() {
  if (busy) return;
  busy = true;
  $("statusDot").className = "dot";
  try {
    const [bn, ok] = await Promise.all([
      fetchBinance().catch(e => null),
      fetchOKX().catch(e => null),
    ]);
    if (bn && ok) {
      render(bn, ok);
      $("statusDot").className = "dot ok";
    } else {
      $("statusDot").className = "dot err";
      if (!bn && !ok) $("okxSrc").textContent = "两所均不可达";
      else if (!ok && bn) {
        $("okxSrc").textContent = "OKX不可达";
        render(bn, { rows: bn.slice(0, 20), live: false, time: "--", ts: 0, total: 0 });
      }
    }
    $("lastUpdate").textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
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
