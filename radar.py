#!/usr/bin/env python3
# OKX快照生成器(Actions每10分钟): data.json(24h榜,兼容旧版) + data-okx.json(全市场四周期)
import json
import urllib.request
import datetime

STABLES = {"USDC", "FDUSD", "TUSD", "BUSD", "DAI", "USDP", "PAXG", "EUR", "GBP", "TRY",
           "BRL", "AEUR", "USD1", "EURI", "XUSD", "USDE", "USTC", "FRAX"}
MIN_VOL = 1_000_000
PROXY = urllib.request.ProxyHandler({"https": "http://127.0.0.1:7890", "http": "http://127.0.0.1:7890"})
OPENER = urllib.request.build_opener(PROXY if False else urllib.request.ProxyHandler({}))  # Actions运行器直连

def get(url, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 radar/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())

def main():
    tick = get("https://www.okx.com/api/v5/market/tickers?instType=SPOT")
    assert tick.get("code") == "0", tick.get("code")
    universe = []
    for t in tick.get("data", []):
        iid = t.get("instId", "")
        if not iid.endswith("-USDT"):
            continue
        base = iid[:-5]
        if base in STABLES:
            continue
        try:
            last, open24, vol = float(t["last"]), float(t["open24h"]), float(t.get("volCcy24h") or 0)
        except (ValueError, TypeError):
            continue
        if open24 <= 0 or vol < MIN_VOL:
            continue
        universe.append({"sym": base, "price": last, "c24": (last / open24 - 1) * 100, "vol24": vol})

    # 每只拉170根1h K线 → 1h/4h/7d窗口涨幅
    import time
    for i, r in enumerate(universe):
        try:
            c = get(f"https://www.okx.com/api/v5/market/candles?instId={r['sym']}-USDT&bar=1H&limit=170")
            kl = c.get("data", [])          # 新→旧: [ts,o,h,l,c,vol,...]
            closes = [float(k[4]) for k in kl][::-1]   # 旧→新
            if len(closes) >= 2:
                r["c1"] = (closes[-1] / closes[-2] - 1) * 100
            if len(closes) >= 5:
                r["c4"] = (closes[-1] / closes[-5] - 1) * 100
            if len(closes) >= 25:
                r["c7"] = (closes[-1] / closes[-25] - 1) * 100
        except Exception:
            pass
        if i % 5 == 4:
            time.sleep(0.3)   # 限速 20req/2s
    for r in universe:
        r.setdefault("c1", 0.0); r.setdefault("c4", 0.0); r.setdefault("c7", 0.0)

    now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
    out = {"time": now.strftime("%Y-%m-%d %H:%M:%S"), "ts": int(now.timestamp()),
           "total": len(universe), "rows": universe}
    with open("data-okx.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    # 兼容旧data.json(24h榜)
    rows = sorted(universe, key=lambda x: -x["c24"])
    legacy = {"time": out["time"], "ts": out["ts"], "total": len(rows),
              "up": rows[:10], "down": list(reversed(rows[-10:]))}
    with open("data.json", "w", encoding="utf-8") as f:
        json.dump(legacy, f, ensure_ascii=False, indent=1)
    filled = sum(1 for r in universe if r.get("c7"))
    print("OKX四周期快照OK %d对(7d窗口覆盖%d) %s" % (len(universe), filled, out["time"]))

if __name__ == "__main__":
    main()
