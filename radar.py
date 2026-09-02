#!/usr/bin/env python3
# OKX快照生成器: 供雷达页兜底(国内浏览器直连OKX不通, Actions每10分钟刷新data.json)
import json
import urllib.request
import datetime

STABLES = {"USDC", "FDUSD", "TUSD", "BUSD", "DAI", "USDP", "PAXG", "EUR", "GBP", "TRY", "BRL",
           "AEUR", "USD1", "EURI", "XUSD", "USDE", "USTC", "FRAX"}
MIN_VOL = 1_000_000

req = urllib.request.Request("https://www.okx.com/api/v5/market/tickers?instType=SPOT",
                              headers={"User-Agent": "Mozilla/5.0 radar/1.0"})
data = json.loads(urllib.request.urlopen(req, timeout=20).read().decode())
if data.get("code") != "0":
    raise SystemExit("OKX code=%s" % data.get("code"))

rows = []
for t in data.get("data", []):
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
    rows.append({"sym": base, "price": last, "chg": (last / open24 - 1) * 100, "vol": vol})

rows.sort(key=lambda x: -x["chg"])
now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
out = {
    "time": now.strftime("%Y-%m-%d %H:%M:%S"), "ts": int(now.timestamp()), "total": len(rows),
    "up": rows[:10], "down": list(reversed(rows[-10:])),
}
with open("data.json", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
print("OKX快照OK %d对 %s" % (len(rows), out["time"]))
