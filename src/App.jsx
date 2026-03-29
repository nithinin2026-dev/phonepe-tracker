import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, AreaChart, Area } from "recharts";

// ─── PDF.JS LOADER ─────────────────────────────────────────────────────
const loadPdfJs = () => new Promise((resolve, reject) => {
  if (window.pdfjsLib) return resolve(window.pdfjsLib);
  const s = document.createElement("script");
  s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
  s.onload = () => {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    resolve(window.pdfjsLib);
  };
  s.onerror = reject;
  document.head.appendChild(s);
});

// ─── POSITION-AWARE TEXT EXTRACTION ────────────────────────────────────
async function extractLines(pdf) {
  const allLines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const items = tc.items.filter(it => it.str.trim());
    if (!items.length) continue;
    const groups = {};
    items.forEach(item => {
      const y = Math.round(item.transform[5]);
      const x = item.transform[4];
      let key = Object.keys(groups).find(k => Math.abs(Number(k) - y) < 3);
      if (!key) { key = String(y); groups[key] = []; }
      groups[key].push({ x, text: item.str });
    });
    Object.keys(groups)
      .sort((a, b) => Number(b) - Number(a))
      .forEach(y => {
        const line = groups[y].sort((a, b) => a.x - b.x).map(it => it.text).join(" ").replace(/\s+/g, " ").trim();
        if (line) allLines.push(line);
      });
  }
  return allLines;
}

// ─── CATEGORIZATION (generic keywords only) ────────────────────────────
const CATEGORIES = {
  "Food & Dining": ["swiggy","zomato","food","restaurant","cafe","hotel","biryani","chicken","shawarma","pizza","burger","tea","chai","coffee","juice","bakery","sweets","drinks","bar","pub","dining","eatery","dhaba","canteen","mess","tiffin"],
  "Groceries": ["grocery","supermarket","bigbasket","dmart","kirana","general store","vegetables","fruits","provisions"],
  "Investments": ["zerodha","groww","upstox","broking","mutual fund","stocks","trading","indmoney"],
  "Transport": ["uber","rapido","ola","metro","irctc","cab","auto","bus","train","flight","travel"],
  "Shopping": ["amazon","flipkart","myntra","blinkit","meesho","shopping","mall","store","online order"],
  "Bills & Recharges": ["airtel","jio","bsnl","electricity","broadband","internet","recharge","bill pay","water bill","gas bill"],
  "Rent & Housing": ["rent","hostel","pg ","co living","co-living","accommodation","flat","apartment"],
  "Health": ["pharmacy","medical","hospital","doctor","clinic","health","medicine","lab test","diagnostic"],
  "Personal Care": ["salon","saloon","barber","spa","beauty","grooming","haircut"],
};
const ALL_CATEGORY_NAMES = [...Object.keys(CATEGORIES), "Self Transfer", "Transfers & Others"];

function categorize(detail) {
  const lower = detail.toLowerCase();
  for (const [cat, keywords] of Object.entries(CATEGORIES)) {
    if (keywords.some(k => lower.includes(k))) return cat;
  }
  if (lower.includes("transfer to") || lower.includes("transfer from")) return "Self Transfer";
  return "Transfers & Others";
}

// ─── TRANSACTION PARSER ────────────────────────────────────────────────
const TXN_RE = /^((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4})\s+(.+?)\s+(DEBIT|CREDIT)\s+₹\s*([\d,.]+)/i;
const DATE_RE = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4}/i;
const TIME_RE = /^(\d{1,2}:\d{2}\s*(?:AM|PM))/i;

function parseLines(lines) {
  const txns = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TXN_RE);
    if (!m) continue;
    const dateStr = m[1]; let detail = m[2].trim(); const type = m[3].toUpperCase(); const amount = parseFloat(m[4].replace(/,/g, "")); if (!amount) continue;
    let time = "";
    if (i + 1 < lines.length) { const tm = lines[i + 1].match(TIME_RE); if (tm) time = tm[1]; }
    if (/^(Paid to|Received from|Transfer to)$/i.test(detail.trim())) {
      let extras = [];
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const nl = lines[j]; if (DATE_RE.test(nl)) break;
        if (/^(Transaction ID|UTR No|Paid by|Credited to|Page \d|This is)/i.test(nl)) continue;
        if (TIME_RE.test(nl)) { const afterTime = nl.replace(TIME_RE, "").trim(); if (afterTime && !/^Transaction/i.test(afterTime)) extras.push(afterTime); continue; }
        extras.push(nl.trim());
      }
      if (extras.length) detail = detail + " " + extras.join(" ");
    }
    let cleanDetail = detail.replace(/^Paid to\s*/i, "").replace(/^Received from\s*/i, "").replace(/^Transfer to\s*/i, "Transfer to ").replace(/^Transfer from\s*/i, "Transfer from ").trim();
    if (!cleanDetail) cleanDetail = detail.trim();
    const dateObj = new Date(`${dateStr} ${time || "12:00 PM"}`);
    txns.push({ id: Date.now() + Math.random(), date: dateStr, time, dateObj: isNaN(dateObj.getTime()) ? new Date(dateStr) : dateObj, detail: cleanDetail, type, amount, category: categorize(cleanDetail + " " + detail) });
  }
  return txns;
}

function parseFallback(rawText) {
  const txns = [];
  const re = /((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4})\s+((?:Paid to|Received from|Transfer to|Transfer from)\s+.+?)\s+(DEBIT|CREDIT)\s+₹\s*([\d,.]+)/gi;
  let match;
  while ((match = re.exec(rawText)) !== null) {
    const dateStr = match[1]; let detail = match[2].trim(); const type = match[3].toUpperCase(); const amount = parseFloat(match[4].replace(/,/g, "")); if (!amount) continue;
    const after = rawText.substring(match.index + match[0].length, match.index + match[0].length + 100);
    const tm = after.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i); const time = tm ? tm[1] : "";
    let cleanDetail = detail.replace(/^Paid to\s*/i, "").replace(/^Received from\s*/i, "").replace(/^Transfer to\s*/i, "Transfer to ").trim();
    const dateObj = new Date(`${dateStr} ${time || "12:00 PM"}`);
    txns.push({ id: Date.now() + Math.random(), date: dateStr, time, dateObj: isNaN(dateObj.getTime()) ? new Date(dateStr) : dateObj, detail: cleanDetail || detail, type, amount, category: categorize(cleanDetail || detail) });
  }
  return txns;
}

// ─── COLORS & UTILS ────────────────────────────────────────────────────
const TAG_COLORS = ["#E63946","#457B9D","#2A9D8F","#E9C46A","#F4A261","#6A4C93","#1982C4","#8AC926","#FF595E","#6D6875","#264653","#F77F00"];
function getCatColor(cat) { const idx = ALL_CATEGORY_NAMES.indexOf(cat); return idx >= 0 ? TAG_COLORS[idx % TAG_COLORS.length] : "#999"; }
const fmt = n => "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
const font = "'Nunito', sans-serif";
const PAGES = { OVERVIEW: "overview", TRANSACTIONS: "transactions", TRENDS: "trends" };
const SIDEBAR_W = 220;

// ─── SectionHeader ─────────────────────────────────────────────────────
function SectionHeader({ children }) {
  return <div style={{ fontSize: 11, fontFamily: font, textTransform: "uppercase", letterSpacing: "0.15em", color: "#999", marginBottom: 14, fontWeight: 600, marginTop: 36 }}>{children}</div>;
}

// ─── StatPill ──────────────────────────────────────────────────────────
function StatPill({ label, value, sub, icon, color }) {
  return (
    <div style={{ background: "#f6f6f6", borderRadius: 10, padding: "14px 16px", flex: "1 1 120px", minWidth: 120, fontFamily: font }}>
      <div style={{ fontSize: 10, color: "#999", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>{icon && <span style={{ marginRight: 4 }}>{icon}</span>}{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: color || "#000" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#999", marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

// ─── CategoryBars ──────────────────────────────────────────────────────
function CategoryBarsCustom({ data }) {
  if (data.length === 0) return null;
  const maxVal = data[0].value; const barH = 150;
  return (
    <div style={{ overflowX: "auto", paddingBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 6, minWidth: data.length * 64, height: barH + 40, paddingTop: 20 }}>
        {data.map(d => {
          const h = maxVal > 0 ? (d.value / maxVal) * barH : 0;
          return (
            <div key={d.name} style={{ flex: 1, minWidth: 48, maxWidth: 80, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", height: barH + 40 }}>
              <span style={{ fontSize: 10, fontFamily: font, fontWeight: 700, marginBottom: 4, color: d.color }}>{fmt(d.value)}</span>
              <div style={{ width: "100%", height: h, background: d.color, borderRadius: "4px 4px 0 0", transition: "height 0.4s ease", minHeight: d.value > 0 ? 6 : 0 }} />
              <span style={{ fontSize: 8, fontFamily: font, marginTop: 6, textAlign: "center", color: "#666", maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", width: "100%" }}>{d.name}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Upload Page ───────────────────────────────────────────────────────
function UploadPage({ onFile, fileRef, loading, error, debugInfo }) {
  useEffect(() => {
    document.documentElement.style.background = "#fff"; document.body.style.background = "#fff";
    document.documentElement.style.color = "#000"; document.body.style.color = "#000"; document.body.style.margin = "0";
    let meta = document.querySelector('meta[name="color-scheme"]');
    if (!meta) { meta = document.createElement("meta"); meta.name = "color-scheme"; document.head.appendChild(meta); }
    meta.content = "light only";
  }, []);
  return (
    <div style={{ maxWidth: 400, margin: "0 auto", padding: "80px 24px", minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: font }}>
      <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      <div style={{ marginBottom: 40, textAlign: "center" }}>
        <div style={{ fontSize: 32, fontWeight: 800, letterSpacing: "-0.02em", marginBottom: 4 }}><span style={{ color: "#E63946" }}>₹</span> SpendScope</div>
        <div style={{ fontSize: 12, color: "#999", textTransform: "uppercase", letterSpacing: "0.15em", fontWeight: 600 }}>PhonePe Statement Analyzer</div>
      </div>
      <div style={{ width: "100%", maxWidth: 320, textAlign: "center" }}>
        <div style={{ fontSize: 48, marginBottom: 20 }}>📄</div>
        <div style={{ fontSize: 14, color: "#666", lineHeight: 1.6, marginBottom: 24 }}>Download your statement from PhonePe app and upload the PDF here.</div>
        <button onClick={() => fileRef.current?.click()} disabled={loading} style={{ width: "100%", padding: "14px 0", border: "2px solid #000", background: "#000", color: "#fff", fontSize: 13, fontFamily: font, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", cursor: loading ? "default" : "pointer", opacity: loading ? 0.5 : 1 }}>{loading ? "Parsing..." : "Upload PDF"}</button>
        <input ref={fileRef} type="file" accept=".pdf" onChange={onFile} style={{ display: "none" }} />
        {error && <div style={{ fontSize: 12, color: "#E63946", fontWeight: 600, padding: "12px 0" }}>{error}</div>}
        {debugInfo && <pre style={{ fontSize: 10, color: "#999", marginTop: 12, whiteSpace: "pre-wrap", maxHeight: 200, overflow: "auto", textAlign: "left", background: "#f6f6f6", padding: 12, borderRadius: 6 }}>{debugInfo}</pre>}
        <div style={{ marginTop: 32, display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
          {["Categories", "Trends", "Merchants", "Transactions"].map(f => (
            <span key={f} style={{ padding: "6px 12px", background: "#f6f6f6", borderRadius: 6, fontSize: 11, color: "#999", fontWeight: 600 }}>{f}</span>
          ))}
        </div>
      </div>
      <div style={{ marginTop: 60, fontSize: 12, color: "#ccc", textAlign: "center" }}>Vibe coded by Nithin Chowdary ❤️</div>
    </div>
  );
}

// ─── Static Sidebar (always visible) ───────────────────────────────────
function StaticSidebar({ page, setPage, txns, fileRef, onFile }) {
  const items = [
    { key: PAGES.OVERVIEW, label: "Overview", icon: "📊" },
    { key: PAGES.TRANSACTIONS, label: "Transactions", icon: "📋" },
    { key: PAGES.TRENDS, label: "Trends", icon: "📈" },
  ];
  const debits = txns.filter(t => t.type === "DEBIT");
  const credits = txns.filter(t => t.type === "CREDIT");
  const totalSpent = debits.reduce((s, t) => s + t.amount, 0);
  const totalReceived = credits.reduce((s, t) => s + t.amount, 0);

  return (
    <div style={{
      position: "fixed", top: 0, left: 0, bottom: 0, width: SIDEBAR_W, zIndex: 100,
      background: "#fff", borderRight: "1px solid #eee",
      display: "flex", flexDirection: "column", fontFamily: font, overflowY: "auto"
    }}>
      <div style={{ padding: "20px 16px 14px", borderBottom: "1px solid #eee" }}>
        <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: "-0.02em", marginBottom: 12 }}>
          <span style={{ color: "#E63946" }}>₹</span> SpendScope
        </div>
        <div style={{ display: "flex", gap: 12, fontSize: 11 }}>
          <div><div style={{ fontSize: 14, fontWeight: 700, color: "#E63946" }}>{fmt(totalSpent)}</div><div style={{ color: "#999", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em" }}>Spent</div></div>
          <div><div style={{ fontSize: 14, fontWeight: 700, color: "#2A9D8F" }}>{fmt(totalReceived)}</div><div style={{ color: "#999", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em" }}>Received</div></div>
        </div>
      </div>
      <div style={{ flex: 1, padding: "8px 0" }}>
        {items.map(i => {
          const active = page === i.key;
          return (
            <button key={i.key} onClick={() => setPage(i.key)} style={{
              display: "flex", alignItems: "center", gap: 10, width: "100%",
              padding: "12px 18px", border: "none", cursor: "pointer",
              background: active ? "#f0f0f0" : "transparent",
              color: "#000", fontSize: 13, fontWeight: active ? 700 : 500,
              fontFamily: font, textAlign: "left", transition: "background 0.15s ease",
              borderLeft: active ? "3px solid #000" : "3px solid transparent"
            }}>
              <span style={{ fontSize: 16 }}>{i.icon}</span><span>{i.label}</span>
            </button>
          );
        })}
      </div>
      <div style={{ padding: "12px 16px", borderTop: "1px solid #eee" }}>
        <button onClick={() => fileRef.current?.click()} style={{
          width: "100%", padding: "9px 0", border: "2px solid #000", background: "#000", color: "#fff",
          fontSize: 10, fontFamily: font, fontWeight: 700, cursor: "pointer",
          letterSpacing: "0.06em", textTransform: "uppercase", borderRadius: 4
        }}>Upload New PDF</button>
        <input ref={fileRef} type="file" accept=".pdf" onChange={onFile} style={{ display: "none" }} />
      </div>
      <div style={{ padding: "10px 16px", borderTop: "1px solid #eee" }}>
        <div style={{ fontSize: 10, color: "#ccc", textAlign: "center" }}>Vibe coded by Nithin Chowdary ❤️</div>
      </div>
    </div>
  );
}

// ─── Threshold Analysis Widget ─────────────────────────────────────────
function ThresholdAnalysis({ txns }) {
  const [threshold, setThreshold] = useState(500);
  const [inputVal, setInputVal] = useState("500");
  const [mode, setMode] = useState("spent");

  const dailyMap = useMemo(() => {
    const m = {};
    txns.forEach(t => {
      const key = t.date;
      if (!m[key]) m[key] = { spent: 0, received: 0 };
      if (t.type === "DEBIT") m[key].spent += t.amount; else m[key].received += t.amount;
    });
    return m;
  }, [txns]);

  const totalDays = Object.keys(dailyMap).length;
  const spentDays = Object.values(dailyMap).filter(d => d.spent > 0).length;
  const receivedDays = Object.values(dailyMap).filter(d => d.received > 0).length;
  const thresholdDays = useMemo(() => Object.values(dailyMap).filter(d => mode === "spent" ? d.spent >= threshold : d.received >= threshold).length, [dailyMap, threshold, mode]);
  const handleInput = (val) => { setInputVal(val); const n = parseInt(val); if (!isNaN(n) && n >= 0) setThreshold(n); };
  const maxAmount = useMemo(() => Math.max(...Object.values(dailyMap).map(d => mode === "spent" ? d.spent : d.received), 1), [dailyMap, mode]);

  return (
    <div style={{ background: "#f6f6f6", borderRadius: 10, padding: "16px 18px", fontFamily: font }}>
      <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 90, background: "#fff", borderRadius: 8, padding: "10px 12px", border: "1px solid #eee" }}>
          <div style={{ fontSize: 9, color: "#999", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>Spent Days</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#E63946" }}>{spentDays}<span style={{ fontSize: 12, color: "#999", fontWeight: 500 }}>/{totalDays}</span></div>
        </div>
        <div style={{ flex: 1, minWidth: 90, background: "#fff", borderRadius: 8, padding: "10px 12px", border: "1px solid #eee" }}>
          <div style={{ fontSize: 9, color: "#999", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>Received Days</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#2A9D8F" }}>{receivedDays}<span style={{ fontSize: 12, color: "#999", fontWeight: 500 }}>/{totalDays}</span></div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
        {["spent", "received"].map(m => (
          <button key={m} onClick={() => setMode(m)} style={{
            padding: "5px 12px", border: "2px solid #000", cursor: "pointer",
            background: mode === m ? "#000" : "transparent", color: mode === m ? "#fff" : "#000",
            fontSize: 10, fontFamily: font, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em"
          }}>{m}</button>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "#666" }}>≥ ₹</span>
        <input value={inputVal} onChange={e => handleInput(e.target.value)} type="number" min="0" style={{ border: "2px solid #000", padding: "5px 8px", fontSize: 13, fontFamily: font, fontWeight: 700, width: 80, background: "transparent", outline: "none", textAlign: "center" }} />
        <input type="range" min="0" max={Math.max(maxAmount, 5000)} step="100" value={threshold} onChange={e => { setThreshold(Number(e.target.value)); setInputVal(e.target.value); }} style={{ flex: 1, accentColor: "#000", cursor: "pointer" }} />
      </div>
      <div style={{ background: "#fff", borderRadius: 8, padding: "12px 14px", border: "1px solid #eee", textAlign: "center" }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "#333" }}>
          You {mode === "spent" ? "spent" : "received"} <span style={{ color: mode === "spent" ? "#E63946" : "#2A9D8F", fontWeight: 800 }}>≥{fmt(threshold)}</span> on{" "}
          <span style={{ fontSize: 22, fontWeight: 800, color: "#000" }}>{thresholdDays}</span>{" "}
          <span style={{ color: "#999" }}>out of {totalDays} days</span>
        </span>
        {totalDays > 0 && (
          <div style={{ marginTop: 8, height: 6, background: "#eee", borderRadius: 3, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${(thresholdDays / totalDays) * 100}%`, background: mode === "spent" ? "#E63946" : "#2A9D8F", borderRadius: 3, transition: "width 0.3s ease" }} />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Overview Page ─────────────────────────────────────────────────────
function OverviewPage({ txns, categoryData, totalSpent, totalReceived, dailyData, weeklyData, topMerchants, avgDaily, topTxn, dateRange }) {
  const net = totalReceived - totalSpent;
  const debits = txns.filter(t => t.type === "DEBIT");
  const credits = txns.filter(t => t.type === "CREDIT");
  const ttStyle = { background: "#fff", border: "1px solid #eee", borderRadius: 8, fontSize: 12, color: "#000", fontFamily: font };
  const maxSpent = useMemo(() => debits.length ? debits.reduce((a, b) => a.amount > b.amount ? a : b) : null, [debits]);
  const minSpent = useMemo(() => debits.length ? debits.reduce((a, b) => a.amount < b.amount ? a : b) : null, [debits]);
  const maxReceived = useMemo(() => credits.length ? credits.reduce((a, b) => a.amount > b.amount ? a : b) : null, [credits]);
  const minReceived = useMemo(() => credits.length ? credits.reduce((a, b) => a.amount < b.amount ? a : b) : null, [credits]);

  return (
    <div>
      <div style={{ background: "#f6f6f6", borderRadius: 10, padding: "10px 14px", marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "space-between", fontFamily: font, fontSize: 12, fontWeight: 700, color: "#666" }}>
        <span>📄 {txns.length} transactions</span>
        <span>{dateRange?.min.toLocaleDateString("en-IN", { month: "short", day: "numeric" })} – {dateRange?.max.toLocaleDateString("en-IN", { month: "short", day: "numeric", year: "numeric" })}</span>
      </div>

      <SectionHeader>Summary</SectionHeader>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
        <StatPill label="Total Spent" value={fmt(totalSpent)} icon="↑" color="#E63946" sub={`${debits.length} debits`} />
        <StatPill label="Received" value={fmt(totalReceived)} icon="↓" color="#2A9D8F" sub={`${credits.length} credits`} />
        <StatPill label="Net Flow" value={fmt(Math.abs(net))} color={net >= 0 ? "#2A9D8F" : "#E63946"} sub={net >= 0 ? "Surplus" : "Deficit"} />
        <StatPill label="Avg / Day" value={fmt(avgDaily)} icon="◷" />
      </div>

      <SectionHeader>Extremes</SectionHeader>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontFamily: font }}>
        <div style={{ background: "#fff0f0", borderRadius: 8, padding: "12px 14px", border: "1px solid #fdd" }}>
          <div style={{ fontSize: 9, color: "#E63946", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>Max Spent</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: "#E63946" }}>{maxSpent ? fmt(maxSpent.amount) : "—"}</div>
          {maxSpent && <div style={{ fontSize: 10, color: "#999", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{maxSpent.detail}</div>}
        </div>
        <div style={{ background: "#f0fff4", borderRadius: 8, padding: "12px 14px", border: "1px solid #c6f6d5" }}>
          <div style={{ fontSize: 9, color: "#2A9D8F", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>Max Received</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: "#2A9D8F" }}>{maxReceived ? fmt(maxReceived.amount) : "—"}</div>
          {maxReceived && <div style={{ fontSize: 10, color: "#999", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{maxReceived.detail}</div>}
        </div>
        <div style={{ background: "#fff8f0", borderRadius: 8, padding: "12px 14px", border: "1px solid #fde" }}>
          <div style={{ fontSize: 9, color: "#F4A261", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>Min Spent</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: "#F4A261" }}>{minSpent ? fmt(minSpent.amount) : "—"}</div>
          {minSpent && <div style={{ fontSize: 10, color: "#999", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{minSpent.detail}</div>}
        </div>
        <div style={{ background: "#f0f8ff", borderRadius: 8, padding: "12px 14px", border: "1px solid #bee3f8" }}>
          <div style={{ fontSize: 9, color: "#457B9D", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>Min Received</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: "#457B9D" }}>{minReceived ? fmt(minReceived.amount) : "—"}</div>
          {minReceived && <div style={{ fontSize: 10, color: "#999", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{minReceived.detail}</div>}
        </div>
      </div>

      <SectionHeader>Detailed Analysis</SectionHeader>
      <ThresholdAnalysis txns={txns} />

      <SectionHeader>Spending by Category</SectionHeader>
      <CategoryBarsCustom data={categoryData} />

      <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 20, background: "#f6f6f6", borderRadius: 10, padding: 18 }}>
        <ResponsiveContainer width="48%" height={170}>
          <PieChart><Pie data={categoryData} dataKey="value" cx="50%" cy="50%" innerRadius={38} outerRadius={70} strokeWidth={2} stroke="#fff">{categoryData.map((d, i) => <Cell key={i} fill={d.color} />)}</Pie><Tooltip contentStyle={ttStyle} formatter={v => fmt(v)} /></PieChart>
        </ResponsiveContainer>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 5, fontFamily: font }}>
          {categoryData.slice(0, 7).map(d => (
            <div key={d.name} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
              <div style={{ width: 7, height: 7, borderRadius: 2, background: d.color, flexShrink: 0 }} />
              <span style={{ color: "#666", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</span>
              <span style={{ fontWeight: 700, fontSize: 10 }}>{d.pct.toFixed(0)}%</span>
            </div>
          ))}
        </div>
      </div>

      <SectionHeader>Daily Spending</SectionHeader>
      <div style={{ background: "#f6f6f6", borderRadius: 10, padding: "14px 6px" }}>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={dailyData}>
            <defs><linearGradient id="gS" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#000" stopOpacity={0.15} /><stop offset="95%" stopColor="#000" stopOpacity={0} /></linearGradient></defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
            <XAxis dataKey="date" tick={{ fontSize: 9, fill: "#999", fontFamily: font }} tickFormatter={v => { const d = new Date(v); return `${d.getDate()}/${d.getMonth()+1}`; }} />
            <YAxis tick={{ fontSize: 9, fill: "#999", fontFamily: font }} tickFormatter={v => `₹${(v/1000).toFixed(0)}k`} />
            <Tooltip contentStyle={ttStyle} formatter={v => fmt(v)} />
            <Area type="monotone" dataKey="spent" stroke="#000" fill="url(#gS)" strokeWidth={2} name="Spent" />
            <Area type="monotone" dataKey="received" stroke="#2A9D8F" fill="none" strokeWidth={2} strokeDasharray="5 5" name="Received" />
            <Legend wrapperStyle={{ fontSize: 10, fontFamily: font }} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <SectionHeader>Top Merchants</SectionHeader>
      {topMerchants.map((m, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: "1px solid #f0f0f0", fontFamily: font, fontSize: 13 }}>
          <span style={{ width: 22, height: 22, borderRadius: 5, background: "#f0f0f0", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, flexShrink: 0, color: "#666" }}>{i + 1}</span>
          <span style={{ flex: 1, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span>
          <span style={{ color: "#999", fontSize: 11 }}>{m.count}x</span>
          <span style={{ fontWeight: 700, fontSize: 12 }}>{fmt(m.total)}</span>
        </div>
      ))}

      <SectionHeader>Weekly Spending</SectionHeader>
      <div style={{ background: "#f6f6f6", borderRadius: 10, padding: "14px 6px" }}>
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={weeklyData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
            <XAxis dataKey="week" tick={{ fontSize: 9, fill: "#999", fontFamily: font }} />
            <YAxis tick={{ fontSize: 9, fill: "#999", fontFamily: font }} tickFormatter={v => `₹${(v/1000).toFixed(0)}k`} />
            <Tooltip contentStyle={ttStyle} formatter={v => fmt(v)} />
            <Bar dataKey="spent" fill="#000" radius={[4, 4, 0, 0]} name="Spent" />
            <Bar dataKey="received" fill="#2A9D8F" radius={[4, 4, 0, 0]} name="Received" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ─── Transactions Page (sortable) ──────────────────────────────────────
function TransactionsPage({ txns, setTxns }) {
  const [catFilter, setCatFilter] = useState("All");
  const [typeFilter, setTypeFilter] = useState("All");
  const [searchQ, setSearchQ] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editCat, setEditCat] = useState("");
  const [sortBy, setSortBy] = useState("date");
  const [sortDir, setSortDir] = useState("desc");

  const categories = useMemo(() => ["All", ...new Set(txns.map(t => t.category))], [txns]);
  const filtered = useMemo(() => {
    let list = txns.filter(t => {
      if (catFilter !== "All" && t.category !== catFilter) return false;
      if (typeFilter !== "All" && t.type !== typeFilter) return false;
      if (searchQ && !t.detail.toLowerCase().includes(searchQ.toLowerCase())) return false;
      return true;
    });
    list = [...list].sort((a, b) => {
      let cmp = 0;
      if (sortBy === "date") cmp = a.dateObj - b.dateObj;
      else if (sortBy === "amount") cmp = a.amount - b.amount;
      else if (sortBy === "category") cmp = a.category.localeCompare(b.category);
      else if (sortBy === "type") cmp = a.type.localeCompare(b.type);
      return sortDir === "desc" ? -cmp : cmp;
    });
    return list;
  }, [txns, catFilter, typeFilter, searchQ, sortBy, sortDir]);

  const deleteTxn = (id) => setTxns(prev => prev.filter(t => t.id !== id));
  const saveCategory = (id) => { setTxns(prev => prev.map(t => t.id === id ? { ...t, category: editCat } : t)); setEditingId(null); };
  const toggleSort = (col) => { if (sortBy === col) setSortDir(d => d === "asc" ? "desc" : "asc"); else { setSortBy(col); setSortDir("desc"); } };
  const sortIcon = (col) => sortBy !== col ? <span style={{ opacity: 0.3, fontSize: 8 }}>⇅</span> : <span style={{ fontSize: 8 }}>{sortDir === "asc" ? "↑" : "↓"}</span>;
  const hdrStyle = { fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#999", cursor: "pointer", display: "flex", alignItems: "center", gap: 3, userSelect: "none" };

  return (
    <div>
      <SectionHeader>Transactions ({filtered.length})</SectionHeader>
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <input placeholder="Search..." value={searchQ} onChange={e => setSearchQ(e.target.value)} style={{ border: "2px solid #000", padding: "8px 12px", fontSize: 12, fontFamily: font, flex: 1, minWidth: 120, background: "transparent", outline: "none", fontWeight: 600 }} />
        <select value={catFilter} onChange={e => setCatFilter(e.target.value)} style={{ border: "2px solid #000", padding: "8px 10px", fontSize: 12, fontFamily: font, fontWeight: 600, background: "#fff", outline: "none", cursor: "pointer" }}>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} style={{ border: "2px solid #000", padding: "8px 10px", fontSize: 12, fontFamily: font, fontWeight: 600, background: "#fff", outline: "none", cursor: "pointer" }}>
          <option value="All">All Types</option><option value="DEBIT">Debits</option><option value="CREDIT">Credits</option>
        </select>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "74px 1fr 100px 50px 80px 26px", padding: "8px 0", borderBottom: "2px solid #000", fontFamily: font }}>
        <span style={hdrStyle} onClick={() => toggleSort("date")}>Date {sortIcon("date")}</span>
        <span style={{ ...hdrStyle, cursor: "default" }}>Details</span>
        <span style={hdrStyle} onClick={() => toggleSort("category")}>Category {sortIcon("category")}</span>
        <span style={hdrStyle} onClick={() => toggleSort("type")}>Type {sortIcon("type")}</span>
        <span style={{ ...hdrStyle, justifyContent: "flex-end" }} onClick={() => toggleSort("amount")}>Amount {sortIcon("amount")}</span>
        <span></span>
      </div>

      {filtered.length === 0 && <div style={{ textAlign: "center", color: "#ccc", fontFamily: font, fontSize: 13, padding: "30px 0" }}>No transactions found</div>}

      <div style={{ maxHeight: "calc(100vh - 220px)", overflowY: "auto" }}>
        {filtered.map(t => (
          <div key={t.id} style={{ display: "grid", gridTemplateColumns: "74px 1fr 100px 50px 80px 26px", padding: "9px 0", borderBottom: "1px solid #f0f0f0", fontFamily: font, fontSize: 12, alignItems: "center" }}>
            <span style={{ fontSize: 10, color: "#999" }}>
              {t.dateObj.toLocaleDateString("en-IN", { month: "short", day: "numeric" })}
              {t.time && <><br/><span style={{ fontSize: 8 }}>{t.time}</span></>}
            </span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 6, fontWeight: 600 }}>{t.detail}</span>
            <span>
              {editingId === t.id ? (
                <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
                  <select value={editCat} onChange={e => setEditCat(e.target.value)} style={{ border: "1px solid #ccc", padding: "2px 3px", fontSize: 9, fontFamily: font, outline: "none", maxWidth: 72 }}>
                    {ALL_CATEGORY_NAMES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <button onClick={() => saveCategory(t.id)} style={{ border: "none", background: "#000", color: "#fff", padding: "2px 5px", fontSize: 8, fontFamily: font, fontWeight: 700, cursor: "pointer", borderRadius: 2 }}>✓</button>
                </div>
              ) : (
                <span onClick={() => { setEditingId(t.id); setEditCat(t.category); }} style={{ fontSize: 9, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 3, color: getCatColor(t.category), fontWeight: 600 }} title="Click to change">
                  <span style={{ width: 5, height: 5, borderRadius: 2, background: getCatColor(t.category), display: "inline-block" }} />{t.category}
                </span>
              )}
            </span>
            <span style={{ fontSize: 9, fontWeight: 700, color: t.type === "CREDIT" ? "#2A9D8F" : "#E63946" }}>{t.type}</span>
            <span style={{ textAlign: "right", fontWeight: 700, fontSize: 12, color: t.type === "CREDIT" ? "#2A9D8F" : "#000" }}>{t.type === "CREDIT" ? "+" : "-"}{fmt(t.amount)}</span>
            <button onClick={() => deleteTxn(t.id)} style={{ border: "none", background: "none", cursor: "pointer", color: "#ccc", fontSize: 14, padding: 0, lineHeight: 1 }} title="Delete">✕</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Trends Page ───────────────────────────────────────────────────────
function TrendsPage({ txns, dailyData, categoryData, topMerchants, topTxn }) {
  const debits = useMemo(() => txns.filter(t => t.type === "DEBIT"), [txns]);
  const ttStyle = { background: "#fff", border: "1px solid #eee", borderRadius: 8, fontSize: 12, color: "#000", fontFamily: font };
  return (
    <div>
      <SectionHeader>Cumulative Spending</SectionHeader>
      <div style={{ background: "#f6f6f6", borderRadius: 10, padding: "14px 6px" }}>
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={(() => { let c = 0; return dailyData.map(d => { c += d.spent; return { ...d, cumulative: c }; }); })()}>
            <defs><linearGradient id="gC" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#E63946" stopOpacity={0.15} /><stop offset="95%" stopColor="#E63946" stopOpacity={0} /></linearGradient></defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
            <XAxis dataKey="date" tick={{ fontSize: 9, fill: "#999", fontFamily: font }} tickFormatter={v => { const d = new Date(v); return `${d.getDate()}/${d.getMonth()+1}`; }} />
            <YAxis tick={{ fontSize: 9, fill: "#999", fontFamily: font }} tickFormatter={v => `₹${(v/1000).toFixed(0)}k`} />
            <Tooltip contentStyle={ttStyle} formatter={v => fmt(v)} />
            <Area type="monotone" dataKey="cumulative" stroke="#E63946" fill="url(#gC)" strokeWidth={2.5} name="Total Spent" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <SectionHeader>By Day of Week</SectionHeader>
      <div style={{ background: "#f6f6f6", borderRadius: 10, padding: "14px 6px" }}>
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={(() => { const d = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(x => ({ day: x, amount: 0 })); debits.forEach(t => d[t.dateObj.getDay()].amount += t.amount); return d; })()}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" /><XAxis dataKey="day" tick={{ fontSize: 9, fill: "#999", fontFamily: font }} /><YAxis tick={{ fontSize: 9, fill: "#999", fontFamily: font }} tickFormatter={v => `₹${(v/1000).toFixed(0)}k`} /><Tooltip contentStyle={ttStyle} formatter={v => fmt(v)} /><Bar dataKey="amount" fill="#000" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <SectionHeader>By Time of Day</SectionHeader>
      <div style={{ background: "#f6f6f6", borderRadius: 10, padding: "14px 6px" }}>
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={(() => { const s = [{slot:"Morning",amount:0},{slot:"Afternoon",amount:0},{slot:"Evening",amount:0},{slot:"Night",amount:0}]; debits.forEach(t => { const h=t.dateObj.getHours(); if(h>=6&&h<12)s[0].amount+=t.amount; else if(h>=12&&h<17)s[1].amount+=t.amount; else if(h>=17&&h<21)s[2].amount+=t.amount; else s[3].amount+=t.amount; }); return s; })()}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" /><XAxis dataKey="slot" tick={{ fontSize: 9, fill: "#999", fontFamily: font }} /><YAxis tick={{ fontSize: 9, fill: "#999", fontFamily: font }} tickFormatter={v => `₹${(v/1000).toFixed(0)}k`} /><Tooltip contentStyle={ttStyle} formatter={v => fmt(v)} /><Bar dataKey="amount" fill="#2A9D8F" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <SectionHeader>Quick Insights</SectionHeader>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontFamily: font }}>
        {[
          { icon: "🔥", title: "Biggest Spend Day", value: dailyData.length ? (() => { const d = dailyData.reduce((a, b) => a.spent > b.spent ? a : b); return `${d.date} — ${fmt(d.spent)}`; })() : "—" },
          { icon: "💰", title: "Biggest Txn", value: topTxn ? `${topTxn.detail.substring(0, 16)}… ${fmt(topTxn.amount)}` : "—" },
          { icon: "📊", title: "Top Category", value: categoryData[0] ? `${categoryData[0].name} (${categoryData[0].count}x)` : "—" },
          { icon: "🏪", title: "Most Visited", value: topMerchants[0] ? `${topMerchants[0].name.substring(0, 16)} (${topMerchants[0].count}x)` : "—" },
          { icon: "📈", title: "Investments", value: fmt(debits.filter(t => t.category === "Investments").reduce((s, t) => s + t.amount, 0)) },
          { icon: "🍔", title: "Food & Dining", value: fmt(debits.filter(t => t.category === "Food & Dining").reduce((s, t) => s + t.amount, 0)) },
        ].map((ins, i) => (
          <div key={i} style={{ background: "#f6f6f6", borderRadius: 10, padding: "12px 14px" }}>
            <div style={{ fontSize: 16, marginBottom: 3 }}>{ins.icon}</div>
            <div style={{ fontSize: 9, color: "#999", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 2 }}>{ins.title}</div>
            <div style={{ fontSize: 12, fontWeight: 700 }}>{ins.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
// ─── MAIN APP ───
// ═══════════════════════════════════════════
export default function App() {
  const [txns, setTxns] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [debugInfo, setDebugInfo] = useState("");
  const [page, setPage] = useState(PAGES.OVERVIEW);
  const [dateRange, setDateRange] = useState(null);
  const fileRef = useRef();

  useEffect(() => {
    document.documentElement.style.background = "#fff"; document.body.style.background = "#fff";
    document.documentElement.style.color = "#000"; document.body.style.color = "#000"; document.body.style.margin = "0";
    let meta = document.querySelector('meta[name="color-scheme"]');
    if (!meta) { meta = document.createElement("meta"); meta.name = "color-scheme"; document.head.appendChild(meta); }
    meta.content = "light only";
  }, []);

  const handleFile = useCallback(async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    setLoading(true); setError(""); setDebugInfo("");
    try {
      const pdfjsLib = await loadPdfJs();
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      const lines = await extractLines(pdf);
      let parsed = parseLines(lines);
      if (parsed.length < 3) {
        let rawText = "";
        for (let p = 1; p <= pdf.numPages; p++) { const pg = await pdf.getPage(p); const tc = await pg.getTextContent(); rawText += tc.items.map(it => it.str).join(" ") + " "; }
        const fallback = parseFallback(rawText);
        if (fallback.length > parsed.length) parsed = fallback;
        if (parsed.length < 3) setDebugInfo(`Extracted ${lines.length} lines. First 10:\n${lines.slice(0, 10).join("\n")}\n\nRaw (500ch): ${rawText.substring(0, 500)}`);
      }
      if (parsed.length === 0) { setError("Could not parse transactions."); }
      else {
        parsed.sort((a, b) => b.dateObj - a.dateObj);
        setTxns(parsed); setPage(PAGES.OVERVIEW);
        const dates = parsed.map(t => t.dateObj);
        setDateRange({ min: new Date(Math.min(...dates)), max: new Date(Math.max(...dates)) });
        setError("");
      }
    } catch (err) { setError("PDF parsing failed: " + err.message); }
    setLoading(false);
  }, []);

  const debits = useMemo(() => txns.filter(t => t.type === "DEBIT"), [txns]);
  const credits = useMemo(() => txns.filter(t => t.type === "CREDIT"), [txns]);
  const totalSpent = useMemo(() => debits.reduce((s, t) => s + t.amount, 0), [debits]);
  const totalReceived = useMemo(() => credits.reduce((s, t) => s + t.amount, 0), [credits]);
  const avgDaily = useMemo(() => { if (!dateRange) return 0; return totalSpent / Math.max(1, Math.ceil((dateRange.max - dateRange.min) / 86400000)); }, [totalSpent, dateRange]);
  const topTxn = useMemo(() => debits.length ? debits.reduce((a, b) => a.amount > b.amount ? a : b) : null, [debits]);
  const categoryData = useMemo(() => {
    const map = {};
    debits.forEach(t => { if (!map[t.category]) map[t.category] = { total: 0, count: 0 }; map[t.category].total += t.amount; map[t.category].count++; });
    const arr = Object.entries(map).map(([name, d]) => ({ name, value: d.total, count: d.count, color: getCatColor(name) })).sort((a, b) => b.value - a.value);
    arr.forEach(d => (d.pct = totalSpent > 0 ? (d.value / totalSpent) * 100 : 0));
    return arr;
  }, [debits, totalSpent]);
  const dailyData = useMemo(() => {
    const map = {};
    txns.forEach(t => { const key = t.date; if (!map[key]) map[key] = { date: key, dateObj: t.dateObj, spent: 0, received: 0 }; if (t.type === "DEBIT") map[key].spent += t.amount; else map[key].received += t.amount; });
    return Object.values(map).sort((a, b) => a.dateObj - b.dateObj);
  }, [txns]);
  const weeklyData = useMemo(() => {
    const map = {};
    txns.forEach(t => { const d = t.dateObj; const sow = new Date(d); sow.setDate(d.getDate() - d.getDay()); const key = sow.toLocaleDateString("en-IN", { month: "short", day: "numeric" }); if (!map[key]) map[key] = { week: key, dateObj: sow, spent: 0, received: 0 }; if (t.type === "DEBIT") map[key].spent += t.amount; else map[key].received += t.amount; });
    return Object.values(map).sort((a, b) => a.dateObj - b.dateObj);
  }, [txns]);
  const topMerchants = useMemo(() => {
    const map = {};
    debits.forEach(t => { const name = t.detail.substring(0, 40); if (!map[name]) map[name] = { name, total: 0, count: 0 }; map[name].total += t.amount; map[name].count++; });
    return Object.values(map).sort((a, b) => b.total - a.total).slice(0, 10);
  }, [debits]);

  const hasData = txns.length > 0;
  if (!hasData) return <UploadPage onFile={handleFile} fileRef={fileRef} loading={loading} error={error} debugInfo={debugInfo} />;

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "#fff", color: "#000", fontFamily: font }}>
      <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      <StaticSidebar page={page} setPage={setPage} txns={txns} fileRef={fileRef} onFile={handleFile} />
      <div style={{ marginLeft: SIDEBAR_W, flex: 1, padding: "24px 28px 60px", maxWidth: 800 }}>
        {page === PAGES.OVERVIEW && <OverviewPage txns={txns} categoryData={categoryData} totalSpent={totalSpent} totalReceived={totalReceived} dailyData={dailyData} weeklyData={weeklyData} topMerchants={topMerchants} avgDaily={avgDaily} topTxn={topTxn} dateRange={dateRange} />}
        {page === PAGES.TRANSACTIONS && <TransactionsPage txns={txns} setTxns={setTxns} />}
        {page === PAGES.TRENDS && <TrendsPage txns={txns} dailyData={dailyData} categoryData={categoryData} topMerchants={topMerchants} topTxn={topTxn} />}
        <div style={{ marginTop: 48, padding: "14px 20px", borderRadius: 12, background: "#E8F4FD", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "#4A5568" }}>Vibe coded by Nithin Chowdary <span style={{ color: "#E53E3E", fontSize: 15 }}>❤️</span></span>
        </div>
      </div>
    </div>
  );
}