import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, AreaChart, Area } from "recharts";

// ─── PDF.JS LOADER ─────────────────────────────────────────────────────
const loadPdfJs = () => new Promise((resolve, reject) => {
  if (window.pdfjsLib) return resolve(window.pdfjsLib);
  const s = document.createElement("script");
  s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
  s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"; resolve(window.pdfjsLib); };
  s.onerror = reject; document.head.appendChild(s);
});

async function extractLines(pdf) {
  const allLines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p); const tc = await page.getTextContent();
    const items = tc.items.filter(it => it.str.trim()); if (!items.length) continue;
    const groups = {};
    items.forEach(item => { const y = Math.round(item.transform[5]); const x = item.transform[4]; let key = Object.keys(groups).find(k => Math.abs(Number(k) - y) < 3); if (!key) { key = String(y); groups[key] = []; } groups[key].push({ x, text: item.str }); });
    Object.keys(groups).sort((a, b) => Number(b) - Number(a)).forEach(y => { const line = groups[y].sort((a, b) => a.x - b.x).map(it => it.text).join(" ").replace(/\s+/g, " ").trim(); if (line) allLines.push(line); });
  }
  return allLines;
}

// ─── CATEGORIZATION ────────────────────────────────────────────────────
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
  for (const [cat, keywords] of Object.entries(CATEGORIES)) { if (keywords.some(k => lower.includes(k))) return cat; }
  if (lower.includes("transfer to") || lower.includes("transfer from")) return "Self Transfer";
  return "Transfers & Others";
}

// ─── PARSER ────────────────────────────────────────────────────────────
const TXN_RE = /^((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4})\s+(.+?)\s+(DEBIT|CREDIT)\s+₹\s*([\d,.]+)/i;
const DATE_RE = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4}/i;
const TIME_RE = /^(\d{1,2}:\d{2}\s*(?:AM|PM))/i;

function parseLines(lines) {
  const txns = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TXN_RE); if (!m) continue;
    const dateStr = m[1]; let detail = m[2].trim(); const type = m[3].toUpperCase(); const amount = parseFloat(m[4].replace(/,/g, "")); if (!amount) continue;
    let time = ""; if (i + 1 < lines.length) { const tm = lines[i + 1].match(TIME_RE); if (tm) time = tm[1]; }
    if (/^(Paid to|Received from|Transfer to)$/i.test(detail.trim())) {
      let extras = [];
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) { const nl = lines[j]; if (DATE_RE.test(nl)) break; if (/^(Transaction ID|UTR No|Paid by|Credited to|Page \d|This is)/i.test(nl)) continue; if (TIME_RE.test(nl)) { const at = nl.replace(TIME_RE, "").trim(); if (at && !/^Transaction/i.test(at)) extras.push(at); continue; } extras.push(nl.trim()); }
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
  const txns = []; const re = /((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4})\s+((?:Paid to|Received from|Transfer to|Transfer from)\s+.+?)\s+(DEBIT|CREDIT)\s+₹\s*([\d,.]+)/gi;
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

// ─── UTILS ─────────────────────────────────────────────────────────────
const TAG_COLORS = ["#E63946","#457B9D","#2A9D8F","#E9C46A","#F4A261","#6A4C93","#1982C4","#8AC926","#FF595E","#6D6875","#264653","#F77F00"];
function getCatColor(cat) { const idx = ALL_CATEGORY_NAMES.indexOf(cat); return idx >= 0 ? TAG_COLORS[idx % TAG_COLORS.length] : "#999"; }
const fmt = n => "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
const F = "'Nunito', sans-serif";
const PAGES = { OVERVIEW: "overview", TRANSACTIONS: "transactions", TRENDS: "trends", CALENDAR: "calendar" };
const SW = 200;

function SH({ children }) { return <div style={{ fontSize: 11, fontFamily: F, textTransform: "uppercase", letterSpacing: "0.15em", color: "#999", marginBottom: 14, fontWeight: 600, marginTop: 36 }}>{children}</div>; }

function StatPill({ label, value, sub, icon, color }) {
  return (
    <div style={{ background: "#f6f6f6", borderRadius: 10, padding: "12px 14px", flex: "1 1 100px", minWidth: 100, fontFamily: F }}>
      <div style={{ fontSize: 10, color: "#999", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>{icon && <span style={{ marginRight: 4 }}>{icon}</span>}{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: color || "#000" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#999", marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

function CategoryBarsCustom({ data }) {
  if (!data.length) return null;
  const maxVal = data[0].value; const barH = 130;
  return (
    <div style={{ overflowX: "auto", paddingBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 4, minWidth: data.length * 52, height: barH + 36, paddingTop: 16 }}>
        {data.map(d => { const h = maxVal > 0 ? (d.value / maxVal) * barH : 0; return (
          <div key={d.name} style={{ flex: 1, minWidth: 40, maxWidth: 64, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", height: barH + 36 }}>
            <span style={{ fontSize: 9, fontFamily: F, fontWeight: 700, marginBottom: 3, color: d.color }}>{fmt(d.value)}</span>
            <div style={{ width: "100%", height: h, background: d.color, borderRadius: "4px 4px 0 0", transition: "height 0.4s ease", minHeight: d.value > 0 ? 6 : 0 }} />
            <span style={{ fontSize: 7, fontFamily: F, marginTop: 5, textAlign: "center", color: "#666", maxWidth: 64, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", width: "100%" }}>{d.name}</span>
          </div>
        ); })}
      </div>
    </div>
  );
}

// ─── Upload Page ───────────────────────────────────────────────────────
function UploadPage({ onFile, fileRef, loading, error, debugInfo }) {
  const [showSteps, setShowSteps] = useState(false);
  useEffect(() => {
    document.documentElement.style.background = "#fff"; document.body.style.background = "#fff";
    document.documentElement.style.color = "#000"; document.body.style.color = "#000"; document.body.style.margin = "0";
    let meta = document.querySelector('meta[name="color-scheme"]');
    if (!meta) { meta = document.createElement("meta"); meta.name = "color-scheme"; document.head.appendChild(meta); }
    meta.content = "light only";
  }, []);
  const steps = [
    { num: "1", text: "Open PhonePe app on your phone" },
    { num: "2", text: "Go to History (clock icon at bottom)" },
    { num: "3", text: "Tap on \"My Statements\" at the top" },
    { num: "4", text: "Select date range (e.g. current month)" },
    { num: "5", text: "Download the PDF statement" },
    { num: "6", text: "Upload the PDF here!" },
  ];
  return (
    <div style={{ maxWidth: 400, margin: "0 auto", padding: "60px 20px", minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: F }}>
      <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      <div style={{ marginBottom: 32, textAlign: "center" }}>
        <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: "-0.02em", marginBottom: 4 }}><span style={{ color: "#6739B7" }}>📱</span> PhonePe Tracker</div>
        <div style={{ fontSize: 11, color: "#999", textTransform: "uppercase", letterSpacing: "0.15em", fontWeight: 600 }}>Offline Statement Analyzer</div>
      </div>
      <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8, padding: "10px 16px", marginBottom: 24, textAlign: "center", fontSize: 11, color: "#166534", fontWeight: 600, lineHeight: 1.5, width: "100%", maxWidth: 320 }}>
        🔒 100% offline — your data never leaves your device.
      </div>
      <div style={{ width: "100%", maxWidth: 320, textAlign: "center" }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>📄</div>
        <div style={{ fontSize: 14, color: "#666", lineHeight: 1.6, marginBottom: 20 }}>Download your statement from PhonePe and upload the PDF here.</div>
        <button onClick={() => fileRef.current?.click()} disabled={loading} style={{ width: "100%", padding: "14px 0", border: "2px solid #000", background: "#000", color: "#fff", fontSize: 13, fontFamily: F, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", cursor: loading ? "default" : "pointer", opacity: loading ? 0.5 : 1, marginBottom: 12 }}>
          {loading ? "Parsing..." : "Upload PDF"}
        </button>
        <input ref={fileRef} type="file" accept=".pdf" onChange={onFile} style={{ display: "none" }} />
        {error && <div style={{ fontSize: 12, color: "#E63946", fontWeight: 600, padding: "8px 0" }}>{error}</div>}
        {debugInfo && <pre style={{ fontSize: 10, color: "#999", marginTop: 8, whiteSpace: "pre-wrap", maxHeight: 180, overflow: "auto", textAlign: "left", background: "#f6f6f6", padding: 10, borderRadius: 6 }}>{debugInfo}</pre>}
        <button onClick={() => setShowSteps(!showSteps)} style={{ border: "2px solid #000", background: showSteps ? "#000" : "transparent", color: showSteps ? "#fff" : "#000", padding: "10px 24px", fontSize: 12, fontFamily: F, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", cursor: "pointer", marginTop: 8, display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ display: "inline-block", transition: "transform 0.3s", transform: showSteps ? "rotate(180deg)" : "rotate(0deg)", fontSize: 10 }}>▼</span>
          {showSteps ? "Hide Steps" : "How to Use"}
        </button>
        <div style={{ maxHeight: showSteps ? 400 : 0, overflow: "hidden", transition: "max-height 0.4s ease, opacity 0.3s ease", opacity: showSteps ? 1 : 0, marginTop: showSteps ? 16 : 0 }}>
          <div style={{ background: "#f6f6f6", borderRadius: 10, padding: "16px 20px", textAlign: "left" }}>
            {steps.map((s, i) => (
              <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "10px 0", borderBottom: i < steps.length - 1 ? "1px solid #eee" : "none" }}>
                <div style={{ width: 26, height: 26, borderRadius: "50%", background: "#000", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, flexShrink: 0 }}>{s.num}</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#333", paddingTop: 3 }}>{s.text}</div>
              </div>
            ))}
          </div>
        </div>
        <div style={{ marginTop: 24, display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
          {["Categories", "Trends", "Calendar", "Transactions"].map(f => (
            <span key={f} style={{ padding: "6px 12px", background: "#f6f6f6", borderRadius: 6, fontSize: 11, color: "#999", fontWeight: 600 }}>{f}</span>
          ))}
        </div>
      </div>
      <div style={{ marginTop: 48, fontSize: 12, color: "#ccc", textAlign: "center" }}>Vibe coded by Nithin Chowdary ❤️</div>
    </div>
  );
}

// ─── Collapsible Sidebar ───────────────────────────────────────────────
function Sidebar({ page, setPage, txns, fileRef, onFile, open, setOpen }) {
  const items = [
    { key: PAGES.OVERVIEW, label: "Overview", icon: "📊" },
    { key: PAGES.CALENDAR, label: "Calendar", icon: "📅" },
    { key: PAGES.TRANSACTIONS, label: "Txns", icon: "📋" },
    { key: PAGES.TRENDS, label: "Trends", icon: "📈" },
  ];
  const debits = txns.filter(t => t.type === "DEBIT");
  const credits = txns.filter(t => t.type === "CREDIT");
  const totalSpent = debits.reduce((s, t) => s + t.amount, 0);
  const totalReceived = credits.reduce((s, t) => s + t.amount, 0);
  return (
    <>
      {/* Overlay for mobile / when open */}
      {open && <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.2)", zIndex: 99, transition: "opacity 0.2s" }} />}
      <div style={{
        position: "fixed", top: 0, left: 0, bottom: 0, width: SW, zIndex: 100,
        background: "#fff", borderRight: "1px solid #eee",
        display: "flex", flexDirection: "column", fontFamily: F, overflowY: "auto",
        transform: open ? "translateX(0)" : `translateX(-${SW}px)`,
        transition: "transform 0.25s ease",
      }}>
        <div style={{ padding: "14px 14px 10px", borderBottom: "1px solid #eee", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: "-0.02em", marginBottom: 8 }}><span style={{ color: "#6739B7" }}>📱</span> PhonePe Tracker</div>
            <div style={{ display: "flex", gap: 12, fontSize: 11 }}>
              <div><div style={{ fontSize: 12, fontWeight: 700, color: "#E63946" }}>{fmt(totalSpent)}</div><div style={{ color: "#999", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em" }}>Spent</div></div>
              <div><div style={{ fontSize: 12, fontWeight: 700, color: "#2A9D8F" }}>{fmt(totalReceived)}</div><div style={{ color: "#999", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em" }}>Received</div></div>
            </div>
          </div>
          <button onClick={() => setOpen(false)} style={{ border: "none", background: "none", fontSize: 18, cursor: "pointer", color: "#999", padding: 4, lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ flex: 1, padding: "4px 0" }}>
          {items.map(i => { const active = page === i.key; return (
            <button key={i.key} onClick={() => { setPage(i.key); setOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 16px", border: "none", cursor: "pointer", background: active ? "#f0f0f0" : "transparent", color: "#000", fontSize: 13, fontWeight: active ? 700 : 500, fontFamily: F, textAlign: "left", transition: "background 0.15s ease", borderLeft: active ? "3px solid #000" : "3px solid transparent" }}>
              <span style={{ fontSize: 14 }}>{i.icon}</span><span>{i.label}</span>
            </button>
          ); })}
        </div>
        <div style={{ padding: "8px 14px", fontSize: 9, color: "#2A9D8F", fontWeight: 600, textAlign: "center", lineHeight: 1.4 }}>🔒 100% offline</div>
        <div style={{ padding: "8px 14px", borderTop: "1px solid #eee" }}>
          <button onClick={() => fileRef.current?.click()} style={{ width: "100%", padding: "7px 0", border: "2px solid #000", background: "#000", color: "#fff", fontSize: 10, fontFamily: F, fontWeight: 700, cursor: "pointer", letterSpacing: "0.06em", textTransform: "uppercase", borderRadius: 4 }}>Upload New PDF</button>
          <input ref={fileRef} type="file" accept=".pdf" onChange={onFile} style={{ display: "none" }} />
        </div>
        <div style={{ padding: "6px 14px 10px", borderTop: "1px solid #eee" }}>
          <div style={{ fontSize: 10, color: "#ccc", textAlign: "center" }}>Vibe coded by Nithin Chowdary ❤️</div>
        </div>
      </div>
    </>
  );
}

// ─── Hamburger Button ──────────────────────────────────────────────────
function HamburgerBtn({ onClick, pageName }) {
  return (
    <div style={{ position: "sticky", top: 0, zIndex: 50, background: "#fff", borderBottom: "1px solid #eee", padding: "10px 16px", display: "flex", alignItems: "center", gap: 12, fontFamily: F, marginBottom: 4 }}>
      <button onClick={onClick} style={{ border: "2px solid #000", background: "#000", color: "#fff", width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", borderRadius: 4, fontSize: 16, lineHeight: 1, padding: 0 }}>☰</button>
      <span style={{ fontSize: 14, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.06em" }}>{pageName}</span>
    </div>
  );
}

// ─── Threshold Analysis ────────────────────────────────────────────────
function ThresholdAnalysis({ txns, mode, setMode, threshold, setThreshold, inputVal, setInputVal }) {
  const dailyMap = useMemo(() => { const m = {}; txns.forEach(t => { const k = t.date; if (!m[k]) m[k] = { spent: 0, received: 0 }; if (t.type === "DEBIT") m[k].spent += t.amount; else m[k].received += t.amount; }); return m; }, [txns]);
  const totalDays = Object.keys(dailyMap).length;
  const spentDays = Object.values(dailyMap).filter(d => d.spent > 0).length;
  const receivedDays = Object.values(dailyMap).filter(d => d.received > 0).length;
  const thresholdDays = useMemo(() => Object.values(dailyMap).filter(d => { const val = mode === "spent" ? d.spent : d.received; return val > 0 && val >= threshold; }).length, [dailyMap, threshold, mode]);
  const handleInput = (val) => { setInputVal(val); const n = parseInt(val); if (!isNaN(n) && n >= 0) setThreshold(n); };
  const maxAmount = useMemo(() => Math.max(...Object.values(dailyMap).map(d => mode === "spent" ? d.spent : d.received), 1), [dailyMap, mode]);
  return (
    <div style={{ background: "#f6f6f6", borderRadius: 10, padding: "14px 16px", fontFamily: F }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 80, background: "#fff", borderRadius: 8, padding: "8px 10px", border: "1px solid #eee" }}>
          <div style={{ fontSize: 9, color: "#999", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>Spent Days</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#E63946" }}>{spentDays}<span style={{ fontSize: 11, color: "#999", fontWeight: 500 }}>/{totalDays}</span></div>
        </div>
        <div style={{ flex: 1, minWidth: 80, background: "#fff", borderRadius: 8, padding: "8px 10px", border: "1px solid #eee" }}>
          <div style={{ fontSize: 9, color: "#999", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>Received Days</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#2A9D8F" }}>{receivedDays}<span style={{ fontSize: 11, color: "#999", fontWeight: 500 }}>/{totalDays}</span></div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
        {["spent", "received"].map(m => (<button key={m} onClick={() => setMode(m)} style={{ padding: "5px 12px", border: "2px solid #000", cursor: "pointer", background: mode === m ? "#000" : "transparent", color: mode === m ? "#fff" : "#000", fontSize: 10, fontFamily: F, fontWeight: 700, textTransform: "uppercase" }}>{m}</button>))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "#666" }}>≥ ₹</span>
        <input value={inputVal} onChange={e => handleInput(e.target.value)} type="number" min="0" style={{ border: "2px solid #000", padding: "5px 8px", fontSize: 13, fontFamily: F, fontWeight: 700, width: 80, background: "transparent", outline: "none", textAlign: "center" }} />
        <input type="range" min="0" max={Math.max(maxAmount, 5000)} step="100" value={threshold} onChange={e => { setThreshold(Number(e.target.value)); setInputVal(e.target.value); }} style={{ flex: 1, accentColor: "#000", cursor: "pointer" }} />
      </div>
      <div style={{ background: "#fff", borderRadius: 8, padding: "10px 12px", border: "1px solid #eee", textAlign: "center" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "#333" }}>
          You {mode === "spent" ? "spent" : "received"} <span style={{ color: mode === "spent" ? "#E63946" : "#2A9D8F", fontWeight: 800 }}>≥{fmt(threshold)}</span> on{" "}
          <span style={{ fontSize: 20, fontWeight: 800 }}>{thresholdDays}</span> <span style={{ color: "#999" }}>out of {totalDays} days</span>
        </span>
        {totalDays > 0 && <div style={{ marginTop: 8, height: 6, background: "#eee", borderRadius: 3, overflow: "hidden" }}><div style={{ height: "100%", width: `${(thresholdDays / totalDays) * 100}%`, background: mode === "spent" ? "#E63946" : "#2A9D8F", borderRadius: 3, transition: "width 0.3s ease" }} /></div>}
      </div>
    </div>
  );
}

// ─── Overview Page ─────────────────────────────────────────────────────
function OverviewPage({ txns, categoryData, totalSpent, totalReceived, dailyData, weeklyData, topMerchants, avgDaily, topTxn, dateRange }) {
  const net = totalReceived - totalSpent;
  const debits = txns.filter(t => t.type === "DEBIT");
  const credits = txns.filter(t => t.type === "CREDIT");
  const ttStyle = { background: "#fff", border: "1px solid #eee", borderRadius: 8, fontSize: 11, color: "#000", fontFamily: F };
  const maxSpent = useMemo(() => debits.length ? debits.reduce((a, b) => a.amount > b.amount ? a : b) : null, [debits]);
  const minSpent = useMemo(() => debits.length ? debits.reduce((a, b) => a.amount < b.amount ? a : b) : null, [debits]);
  const maxReceived = useMemo(() => credits.length ? credits.reduce((a, b) => a.amount > b.amount ? a : b) : null, [credits]);
  const minReceived = useMemo(() => credits.length ? credits.reduce((a, b) => a.amount < b.amount ? a : b) : null, [credits]);
  return (
    <div>
      <div style={{ background: "#f6f6f6", borderRadius: 10, padding: "8px 12px", marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "space-between", fontFamily: F, fontSize: 11, fontWeight: 700, color: "#666" }}>
        <span>📄 {txns.length} transactions</span>
        <span>{dateRange?.min.toLocaleDateString("en-IN", { month: "short", day: "numeric" })} – {dateRange?.max.toLocaleDateString("en-IN", { month: "short", day: "numeric", year: "numeric" })}</span>
      </div>
      <SH>Summary</SH>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 18 }}>
        <StatPill label="Total Spent" value={fmt(totalSpent)} icon="↑" color="#E63946" sub={`${debits.length} debits`} />
        <StatPill label="Received" value={fmt(totalReceived)} icon="↓" color="#2A9D8F" sub={`${credits.length} credits`} />
        <StatPill label="Net Flow" value={fmt(Math.abs(net))} color={net >= 0 ? "#2A9D8F" : "#E63946"} sub={net >= 0 ? "Surplus" : "Deficit"} />
        <StatPill label="Avg / Day" value={fmt(avgDaily)} icon="◷" />
      </div>
      <SH>Extremes</SH>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontFamily: F }}>
        {[
          { label: "Max Spent", data: maxSpent, color: "#E63946", bg: "#fff0f0", border: "#fdd" },
          { label: "Max Received", data: maxReceived, color: "#2A9D8F", bg: "#f0fff4", border: "#c6f6d5" },
          { label: "Min Spent", data: minSpent, color: "#F4A261", bg: "#fff8f0", border: "#fde" },
          { label: "Min Received", data: minReceived, color: "#457B9D", bg: "#f0f8ff", border: "#bee3f8" },
        ].map(e => (
          <div key={e.label} style={{ background: e.bg, borderRadius: 8, padding: "10px 12px", border: `1px solid ${e.border}` }}>
            <div style={{ fontSize: 9, color: e.color, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>{e.label}</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: e.color }}>{e.data ? fmt(e.data.amount) : "—"}</div>
            {e.data && <div style={{ fontSize: 9, color: "#999", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.data.detail}</div>}
          </div>
        ))}
      </div>
      <SH>Spending by Category</SH>
      <CategoryBarsCustom data={categoryData} />
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 18, background: "#f6f6f6", borderRadius: 10, padding: 14 }}>
        <ResponsiveContainer width="48%" height={150}><PieChart><Pie data={categoryData} dataKey="value" cx="50%" cy="50%" innerRadius={32} outerRadius={60} strokeWidth={2} stroke="#fff">{categoryData.map((d, i) => <Cell key={i} fill={d.color} />)}</Pie><Tooltip contentStyle={ttStyle} formatter={v => fmt(v)} /></PieChart></ResponsiveContainer>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4, fontFamily: F }}>
          {categoryData.slice(0, 6).map(d => (<div key={d.name} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10 }}><div style={{ width: 6, height: 6, borderRadius: 2, background: d.color, flexShrink: 0 }} /><span style={{ color: "#666", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</span><span style={{ fontWeight: 700, fontSize: 10 }}>{d.pct.toFixed(0)}%</span></div>))}
        </div>
      </div>
      <SH>Daily Spending</SH>
      <div style={{ background: "#f6f6f6", borderRadius: 10, padding: "12px 4px" }}>
        <ResponsiveContainer width="100%" height={180}><AreaChart data={dailyData}><defs><linearGradient id="gS" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#000" stopOpacity={0.15} /><stop offset="95%" stopColor="#000" stopOpacity={0} /></linearGradient></defs><CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" /><XAxis dataKey="date" tick={{ fontSize: 8, fill: "#999", fontFamily: F }} tickFormatter={v => { const d = new Date(v); return `${d.getDate()}/${d.getMonth()+1}`; }} /><YAxis tick={{ fontSize: 8, fill: "#999", fontFamily: F }} tickFormatter={v => `₹${(v/1000).toFixed(0)}k`} width={40} /><Tooltip contentStyle={ttStyle} formatter={v => fmt(v)} /><Area type="monotone" dataKey="spent" stroke="#000" fill="url(#gS)" strokeWidth={2} name="Spent" /><Area type="monotone" dataKey="received" stroke="#2A9D8F" fill="none" strokeWidth={2} strokeDasharray="5 5" name="Received" /><Legend wrapperStyle={{ fontSize: 10, fontFamily: F }} /></AreaChart></ResponsiveContainer>
      </div>
      <SH>Top Merchants</SH>
      {topMerchants.map((m, i) => (<div key={i} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 0", borderBottom: "1px solid #f0f0f0", fontFamily: F, fontSize: 12 }}><span style={{ width: 20, height: 20, borderRadius: 4, background: "#f0f0f0", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, flexShrink: 0, color: "#666" }}>{i + 1}</span><span style={{ flex: 1, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span><span style={{ color: "#999", fontSize: 10 }}>{m.count}x</span><span style={{ fontWeight: 700, fontSize: 11 }}>{fmt(m.total)}</span></div>))}
      <SH>Weekly Spending</SH>
      <div style={{ background: "#f6f6f6", borderRadius: 10, padding: "12px 4px" }}>
        <ResponsiveContainer width="100%" height={160}><BarChart data={weeklyData}><CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" /><XAxis dataKey="week" tick={{ fontSize: 8, fill: "#999", fontFamily: F }} /><YAxis tick={{ fontSize: 8, fill: "#999", fontFamily: F }} tickFormatter={v => `₹${(v/1000).toFixed(0)}k`} width={40} /><Tooltip contentStyle={{ background: "#fff", border: "1px solid #eee", borderRadius: 8, fontSize: 11, fontFamily: F }} formatter={v => fmt(v)} /><Bar dataKey="spent" fill="#000" radius={[4, 4, 0, 0]} name="Spent" /><Bar dataKey="received" fill="#2A9D8F" radius={[4, 4, 0, 0]} name="Received" /></BarChart></ResponsiveContainer>
      </div>
    </div>
  );
}

// ─── Transactions Page (sortable — FIXED) ──────────────────────────────
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
    let list = txns.filter(t => { if (catFilter !== "All" && t.category !== catFilter) return false; if (typeFilter !== "All" && t.type !== typeFilter) return false; if (searchQ && !t.detail.toLowerCase().includes(searchQ.toLowerCase())) return false; return true; });
    list = [...list].sort((a, b) => {
      let c = 0;
      if (sortBy === "date") {
        c = (a.dateObj?.getTime?.() || 0) - (b.dateObj?.getTime?.() || 0);
      } else if (sortBy === "amount") {
        c = a.amount - b.amount;
      } else if (sortBy === "category") {
        c = (a.category || "").localeCompare(b.category || "");
      } else if (sortBy === "type") {
        c = (a.type || "").localeCompare(b.type || "");
      }
      // Tiebreaker: by amount then by id for stable sort
      if (c === 0 && sortBy !== "amount") c = a.amount - b.amount;
      if (c === 0) c = (a.id || 0) - (b.id || 0);
      return sortDir === "desc" ? -c : c;
    });
    return list;
  }, [txns, catFilter, typeFilter, searchQ, sortBy, sortDir]);
  const deleteTxn = (id) => setTxns(prev => prev.filter(t => t.id !== id));
  const saveCategory = (id) => { setTxns(prev => prev.map(t => t.id === id ? { ...t, category: editCat } : t)); setEditingId(null); };
  const toggleSort = (col) => { if (sortBy === col) setSortDir(d => d === "asc" ? "desc" : "asc"); else { setSortBy(col); setSortDir("desc"); } };
  const sortIcon = (col) => sortBy !== col ? <span style={{ opacity: 0.3, fontSize: 9 }}>⇅</span> : <span style={{ fontSize: 9, fontWeight: 800 }}>{sortDir === "asc" ? "↑" : "↓"}</span>;
  const hS = { fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#999", cursor: "pointer", display: "flex", alignItems: "center", gap: 3, userSelect: "none" };
  return (
    <div>
      <SH>Transactions ({filtered.length})</SH>
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        <input placeholder="Search..." value={searchQ} onChange={e => setSearchQ(e.target.value)} style={{ border: "2px solid #000", padding: "7px 10px", fontSize: 12, fontFamily: F, flex: 1, minWidth: 100, background: "transparent", outline: "none", fontWeight: 600 }} />
        <select value={catFilter} onChange={e => setCatFilter(e.target.value)} style={{ border: "2px solid #000", padding: "7px 8px", fontSize: 11, fontFamily: F, fontWeight: 600, background: "#fff", outline: "none", cursor: "pointer", maxWidth: 130 }}>{categories.map(c => <option key={c} value={c}>{c}</option>)}</select>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} style={{ border: "2px solid #000", padding: "7px 8px", fontSize: 11, fontFamily: F, fontWeight: 600, background: "#fff", outline: "none", cursor: "pointer" }}><option value="All">All</option><option value="DEBIT">Debits</option><option value="CREDIT">Credits</option></select>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "64px 1fr 90px 44px 72px 22px", padding: "6px 0", borderBottom: "2px solid #000", fontFamily: F, gap: 2 }}>
        <span style={hS} onClick={() => toggleSort("date")}>Date {sortIcon("date")}</span><span style={{ ...hS, cursor: "default" }}>Details</span><span style={hS} onClick={() => toggleSort("category")}>Category {sortIcon("category")}</span><span style={hS} onClick={() => toggleSort("type")}>Type {sortIcon("type")}</span><span style={{ ...hS, justifyContent: "flex-end" }} onClick={() => toggleSort("amount")}>Amt {sortIcon("amount")}</span><span></span>
      </div>
      {filtered.length === 0 && <div style={{ textAlign: "center", color: "#ccc", fontFamily: F, fontSize: 13, padding: "30px 0" }}>No transactions found</div>}
      <div style={{ maxHeight: "calc(100vh - 220px)", overflowY: "auto" }}>
        {filtered.map(t => (
          <div key={t.id} style={{ display: "grid", gridTemplateColumns: "64px 1fr 90px 44px 72px 22px", padding: "8px 0", borderBottom: "1px solid #f0f0f0", fontFamily: F, fontSize: 11, alignItems: "center", gap: 2 }}>
            <span style={{ fontSize: 10, color: "#999" }}>{t.dateObj.toLocaleDateString("en-IN", { month: "short", day: "numeric" })}{t.time && <><br/><span style={{ fontSize: 8 }}>{t.time}</span></>}</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 4, fontWeight: 600 }}>{t.detail}</span>
            <span>{editingId === t.id ? (<div style={{ display: "flex", gap: 2, alignItems: "center" }}><select value={editCat} onChange={e => setEditCat(e.target.value)} style={{ border: "1px solid #ccc", padding: "2px 2px", fontSize: 8, fontFamily: F, outline: "none", maxWidth: 64 }}>{ALL_CATEGORY_NAMES.map(c => <option key={c} value={c}>{c}</option>)}</select><button onClick={() => saveCategory(t.id)} style={{ border: "none", background: "#000", color: "#fff", padding: "2px 4px", fontSize: 8, fontFamily: F, fontWeight: 700, cursor: "pointer", borderRadius: 2 }}>✓</button></div>) : (<span onClick={() => { setEditingId(t.id); setEditCat(t.category); }} style={{ fontSize: 8, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 2, color: getCatColor(t.category), fontWeight: 600 }} title="Click to change"><span style={{ width: 5, height: 5, borderRadius: 2, background: getCatColor(t.category), display: "inline-block" }} />{t.category}</span>)}</span>
            <span style={{ fontSize: 8, fontWeight: 700, color: t.type === "CREDIT" ? "#2A9D8F" : "#E63946" }}>{t.type === "CREDIT" ? "CR" : "DR"}</span>
            <span style={{ textAlign: "right", fontWeight: 700, fontSize: 11, color: t.type === "CREDIT" ? "#2A9D8F" : "#000" }}>{t.type === "CREDIT" ? "+" : "-"}{fmt(t.amount)}</span>
            <button onClick={() => deleteTxn(t.id)} style={{ border: "none", background: "none", cursor: "pointer", color: "#ccc", fontSize: 13, padding: 0, lineHeight: 1 }} title="Delete">✕</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Trends Page ───────────────────────────────────────────────────────
function TrendsPage({ txns, dailyData, categoryData, topMerchants, topTxn }) {
  const debits = useMemo(() => txns.filter(t => t.type === "DEBIT"), [txns]);
  const ttStyle = { background: "#fff", border: "1px solid #eee", borderRadius: 8, fontSize: 11, color: "#000", fontFamily: F };

  const weekAnalysis = useMemo(() => {
    if (!txns.length) return [];
    const dates = txns.map(t => t.dateObj);
    const minD = new Date(Math.min(...dates));
    const year = minD.getFullYear(); const month = minD.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const ranges = [
      { label: "W1", sub: "1–7", start: 1, end: 7 },
      { label: "W2", sub: "8–14", start: 8, end: 14 },
      { label: "W3", sub: "15–21", start: 15, end: 21 },
      { label: "W4", sub: "22–28", start: 22, end: 28 },
    ];
    if (daysInMonth > 28) ranges.push({ label: "W5", sub: `29–${daysInMonth}`, start: 29, end: daysInMonth });

    const dailyMap = {};
    debits.forEach(t => { const k = t.date; dailyMap[k] = (dailyMap[k] || 0) + t.amount; });

    return ranges.map(r => {
      let weekdayTotal = 0, weekdayCount = 0, weekendTotal = 0, weekendCount = 0, total = 0;
      for (let d = r.start; d <= Math.min(r.end, daysInMonth); d++) {
        const dayObj = new Date(year, month, d);
        const dayOfWeek = dayObj.getDay();
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 5 || dayOfWeek === 6;
        const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        const matchedAmt = dailyMap[key] || Object.entries(dailyMap).find(([k]) => {
          try { const pd = new Date(k + " 12:00 PM"); return pd.getDate() === d && pd.getMonth() === month && pd.getFullYear() === year; } catch { return false; }
        })?.[1] || 0;
        total += matchedAmt;
        if (isWeekend) { weekendTotal += matchedAmt; weekendCount++; }
        else { weekdayTotal += matchedAmt; weekdayCount++; }
      }
      return { ...r, total, weekdayTotal, weekdayCount, weekendTotal, weekendCount };
    });
  }, [txns, debits]);

  const totalWeekday = weekAnalysis.reduce((s, w) => s + w.weekdayTotal, 0);
  const totalWeekend = weekAnalysis.reduce((s, w) => s + w.weekendTotal, 0);
  const tCell = { padding: "6px 8px", fontSize: 11, fontFamily: F, borderBottom: "1px solid #eee" };
  const tHdr = { ...tCell, fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#999", background: "#f6f6f6", borderBottom: "2px solid #000" };

  return (
    <div>
      <SH>Weekday vs Weekend (Fri-Sun)</SH>
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <StatPill label="Weekday" value={fmt(totalWeekday)} color="#457B9D" />
        <StatPill label="Weekend" value={fmt(totalWeekend)} color="#E63946" />
      </div>
      <div style={{ borderRadius: 10, overflow: "hidden", border: "1px solid #eee", marginBottom: 28 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: F }}>
          <thead>
            <tr>
              <td style={tHdr}>Wk</td><td style={tHdr}>Days</td><td style={{ ...tHdr, textAlign: "right" }}>Total</td><td style={{ ...tHdr, textAlign: "right", color: "#457B9D" }}>Wkday</td><td style={{ ...tHdr, textAlign: "right", color: "#E63946" }}>Wkend</td>
            </tr>
          </thead>
          <tbody>
            {weekAnalysis.map((w, i) => (
              <tr key={i} style={{ background: i % 2 === 0 ? "#fff" : "#fafafa" }}>
                <td style={{ ...tCell, fontWeight: 700 }}>{w.label}</td>
                <td style={{ ...tCell, color: "#999", fontSize: 10 }}>{w.sub}</td>
                <td style={{ ...tCell, textAlign: "right", fontWeight: 700 }}>{fmt(w.total)}</td>
                <td style={{ ...tCell, textAlign: "right", color: "#457B9D", fontWeight: 600 }}>{fmt(w.weekdayTotal)}<br/><span style={{ fontSize: 8, color: "#999" }}>{w.weekdayCount}d</span></td>
                <td style={{ ...tCell, textAlign: "right", color: "#E63946", fontWeight: 600 }}>{fmt(w.weekendTotal)}<br/><span style={{ fontSize: 8, color: "#999" }}>{w.weekendCount}d</span></td>
              </tr>
            ))}
            <tr style={{ background: "#f6f6f6" }}>
              <td style={{ ...tCell, fontWeight: 800, borderBottom: "none" }} colSpan={2}>TOTAL</td>
              <td style={{ ...tCell, textAlign: "right", fontWeight: 800, borderBottom: "none" }}>{fmt(totalWeekday + totalWeekend)}</td>
              <td style={{ ...tCell, textAlign: "right", fontWeight: 800, color: "#457B9D", borderBottom: "none" }}>{fmt(totalWeekday)}</td>
              <td style={{ ...tCell, textAlign: "right", fontWeight: 800, color: "#E63946", borderBottom: "none" }}>{fmt(totalWeekend)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <SH>Cumulative Spending</SH>
      <div style={{ background: "#f6f6f6", borderRadius: 10, padding: "12px 4px" }}>
        <ResponsiveContainer width="100%" height={180}><AreaChart data={(() => { let c = 0; return dailyData.map(d => { c += d.spent; return { ...d, cumulative: c }; }); })()}><defs><linearGradient id="gC" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#E63946" stopOpacity={0.15} /><stop offset="95%" stopColor="#E63946" stopOpacity={0} /></linearGradient></defs><CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" /><XAxis dataKey="date" tick={{ fontSize: 8, fill: "#999", fontFamily: F }} tickFormatter={v => { const d = new Date(v); return `${d.getDate()}/${d.getMonth()+1}`; }} /><YAxis tick={{ fontSize: 8, fill: "#999", fontFamily: F }} tickFormatter={v => `₹${(v/1000).toFixed(0)}k`} width={40} /><Tooltip contentStyle={ttStyle} formatter={v => fmt(v)} /><Area type="monotone" dataKey="cumulative" stroke="#E63946" fill="url(#gC)" strokeWidth={2.5} name="Total Spent" /></AreaChart></ResponsiveContainer>
      </div>
      <SH>By Day of Week</SH>
      <div style={{ background: "#f6f6f6", borderRadius: 10, padding: "12px 4px" }}>
        <ResponsiveContainer width="100%" height={160}><BarChart data={(() => { const d = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(x => ({ day: x, amount: 0 })); debits.forEach(t => d[t.dateObj.getDay()].amount += t.amount); return d; })()}><CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" /><XAxis dataKey="day" tick={{ fontSize: 9, fill: "#999", fontFamily: F }} /><YAxis tick={{ fontSize: 8, fill: "#999", fontFamily: F }} tickFormatter={v => `₹${(v/1000).toFixed(0)}k`} width={40} /><Tooltip contentStyle={ttStyle} formatter={v => fmt(v)} /><Bar dataKey="amount" fill="#000" radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer>
      </div>
      <SH>By Time of Day</SH>
      <div style={{ background: "#f6f6f6", borderRadius: 10, padding: "12px 4px" }}>
        <ResponsiveContainer width="100%" height={160}><BarChart data={(() => { const s = [{slot:"Morning",amount:0},{slot:"Afternoon",amount:0},{slot:"Evening",amount:0},{slot:"Night",amount:0}]; debits.forEach(t => { const h=t.dateObj.getHours(); if(h>=6&&h<12)s[0].amount+=t.amount; else if(h>=12&&h<17)s[1].amount+=t.amount; else if(h>=17&&h<21)s[2].amount+=t.amount; else s[3].amount+=t.amount; }); return s; })()}><CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" /><XAxis dataKey="slot" tick={{ fontSize: 9, fill: "#999", fontFamily: F }} /><YAxis tick={{ fontSize: 8, fill: "#999", fontFamily: F }} tickFormatter={v => `₹${(v/1000).toFixed(0)}k`} width={40} /><Tooltip contentStyle={ttStyle} formatter={v => fmt(v)} /><Bar dataKey="amount" fill="#2A9D8F" radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer>
      </div>
      <SH>Quick Insights</SH>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontFamily: F }}>
        {[
          { icon: "🔥", title: "Biggest Spend Day", value: dailyData.length ? (() => { const d = dailyData.reduce((a, b) => a.spent > b.spent ? a : b); return `${d.date} — ${fmt(d.spent)}`; })() : "—" },
          { icon: "💰", title: "Biggest Txn", value: topTxn ? `${topTxn.detail.substring(0, 14)}… ${fmt(topTxn.amount)}` : "—" },
          { icon: "📊", title: "Top Category", value: categoryData[0] ? `${categoryData[0].name} (${categoryData[0].count}x)` : "—" },
          { icon: "🏪", title: "Most Visited", value: topMerchants[0] ? `${topMerchants[0].name.substring(0, 14)} (${topMerchants[0].count}x)` : "—" },
          { icon: "📈", title: "Investments", value: fmt(debits.filter(t => t.category === "Investments").reduce((s, t) => s + t.amount, 0)) },
          { icon: "🍔", title: "Food & Dining", value: fmt(debits.filter(t => t.category === "Food & Dining").reduce((s, t) => s + t.amount, 0)) },
        ].map((ins, i) => (<div key={i} style={{ background: "#f6f6f6", borderRadius: 10, padding: "10px 12px" }}><div style={{ fontSize: 14, marginBottom: 2 }}>{ins.icon}</div><div style={{ fontSize: 8, color: "#999", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 2 }}>{ins.title}</div><div style={{ fontSize: 11, fontWeight: 700 }}>{ins.value}</div></div>))}
      </div>
    </div>
  );
}

// ─── Calendar Page ─────────────────────────────────────────────────────
function CalendarPage({ txns }) {
  const [mode, setMode] = useState("spent");
  const [threshold, setThreshold] = useState(500);
  const [inputVal, setInputVal] = useState("500");

  const dates = txns.map(t => t.dateObj);
  const refDate = dates.length ? new Date(Math.max(...dates)) : new Date();
  const [viewYear, setViewYear] = useState(refDate.getFullYear());
  const [viewMonth, setViewMonth] = useState(refDate.getMonth());
  const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const dayHeaders = ["M", "T", "W", "T", "F", "S", "S"];

  const dailyMap = useMemo(() => {
    const m = {};
    txns.forEach(t => {
      const d = t.dateObj;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      if (!m[key]) m[key] = { spent: 0, received: 0 };
      if (t.type === "DEBIT") m[key].spent += t.amount; else m[key].received += t.amount;
    });
    return m;
  }, [txns]);

  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstDayMon = (new Date(viewYear, viewMonth, 1).getDay() + 6) % 7;
  const cells = [];
  for (let i = 0; i < firstDayMon; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const todayKey = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  const isSpentMode = mode === "spent";

  const monthAmounts = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const dm = dailyMap[key];
    const val = dm ? (isSpentMode ? dm.spent : dm.received) : 0;
    if (val > 0) monthAmounts.push(val);
  }
  const maxAmt = monthAmounts.length ? Math.max(...monthAmounts) : 1;

  let monthTotal = 0, activeDays = 0, inactiveDays = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const dm = dailyMap[key];
    const val = dm ? (isSpentMode ? dm.spent : dm.received) : 0;
    monthTotal += val;
    if (val > 0) activeDays++; else if (key <= todayKey) inactiveDays++;
  }
  const avgPerDay = daysInMonth > 0 ? Math.round(monthTotal / daysInMonth) : 0;

  const shiftMonth = (dir) => { let m = viewMonth + dir, y = viewYear; if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; } setViewYear(y); setViewMonth(m); };

  function getCellColor(val, isFuture) {
    if (isFuture) return "#fff";
    if (isSpentMode) {
      if (val <= 0) return "#d4edda";
      const t = Math.min(val / maxAmt, 1);
      return `rgb(230, ${Math.round(200 - t * 155)}, ${Math.round(200 - t * 140)})`;
    } else {
      if (val <= 0) return "#fff0f0";
      const t = Math.min(val / maxAmt, 1);
      return `rgb(${Math.round(210 - t * 170)}, ${Math.round(230 - t * 30)}, ${Math.round(210 - t * 80)})`;
    }
  }
  function getTextColor(val, isFuture) {
    if (isFuture) return "#ccc";
    if (isSpentMode) return val > 0 ? "#7c1d1d" : "#166534";
    else return val > 0 ? "#166534" : "#991b1b";
  }

  const activeLabel = isSpentMode ? "Spent Days" : "Received Days";
  const activeColor = isSpentMode ? "#E63946" : "#2A9D8F";

  return (
    <div style={{ fontFamily: F, maxWidth: 480 }}>
      <SH>Detailed Analysis</SH>
      <ThresholdAnalysis txns={txns} mode={mode} setMode={setMode} threshold={threshold} setThreshold={setThreshold} inputVal={inputVal} setInputVal={setInputVal} />

      <SH>Monthly Calendar — {isSpentMode ? "Spending" : "Received"}</SH>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 16, marginBottom: 10 }}>
        <button onClick={() => shiftMonth(-1)} style={{ border: "none", background: "none", fontSize: 16, cursor: "pointer" }}>←</button>
        <span style={{ fontSize: 14, fontWeight: 800, minWidth: 140, textAlign: "center" }}>{monthNames[viewMonth]} {viewYear}</span>
        <button onClick={() => shiftMonth(1)} style={{ border: "none", background: "none", fontSize: 16, cursor: "pointer" }}>→</button>
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
        <StatPill label="Month Total" value={fmt(monthTotal)} color={activeColor} />
        <StatPill label="Avg / Day" value={fmt(avgPerDay)} />
        <StatPill label={activeLabel} value={String(activeDays)} color={activeColor} sub={`${inactiveDays} inactive`} />
      </div>

      <div style={{ borderRadius: 8, overflow: "hidden", border: "1px solid #ddd", maxWidth: 380 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)" }}>
          {dayHeaders.map((d, i) => (
            <div key={i} style={{ height: 22, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700, color: "#666", background: "#f0f0f0", borderBottom: "2px solid #000", borderRight: i < 6 ? "1px solid #ddd" : "none" }}>{d}</div>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)" }}>
          {cells.map((day, i) => {
            if (day === null) return <div key={`e${i}`} style={{ height: 32, borderBottom: "1px solid #eee", borderRight: i % 7 < 6 ? "1px solid #eee" : "none", background: "#fafafa" }} />;
            const key = `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
            const dm = dailyMap[key];
            const val = dm ? (isSpentMode ? dm.spent : dm.received) : 0;
            const isToday = key === todayKey;
            const isFuture = key > todayKey;
            const meetsThreshold = val > 0 && val >= threshold;
            const bg = getCellColor(val, isFuture);
            const color = getTextColor(val, isFuture);
            return (
              <div key={i} title={`${key} — ${val > 0 ? fmt(val) : (isSpentMode ? "No spend" : "No receive")}`} style={{
                height: 32, borderBottom: "1px solid #eee", borderRight: i % 7 < 6 ? "1px solid #eee" : "none",
                background: bg, display: "flex", alignItems: "center", justifyContent: "center", gap: 1,
                outline: isToday ? "2.5px solid #000" : meetsThreshold && !isFuture ? `1.5px solid ${activeColor}` : "none",
                outlineOffset: "-1px", position: "relative", zIndex: isToday ? 2 : 1, cursor: "default"
              }}>
                <span style={{ fontSize: 9, fontWeight: isToday ? 900 : 600, color, lineHeight: 1 }}>{day}</span>
                {val > 0 && !isFuture && <span style={{ fontSize: 6, fontWeight: 700, color, lineHeight: 1 }}>{val >= 1000 ? `${(val / 1000).toFixed(1)}k` : val}</span>}
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "center", gap: 10, fontSize: 9, color: "#555", marginTop: 8, fontWeight: 600, flexWrap: "wrap" }}>
        {isSpentMode ? (<>
          <span style={{ display: "flex", alignItems: "center", gap: 3 }}><span style={{ width: 10, height: 10, background: "#d4edda", border: "1px solid #aaa", display: "inline-block", borderRadius: 2 }} /> No spend</span>
          <span style={{ display: "flex", alignItems: "center", gap: 3 }}><span style={{ width: 10, height: 10, background: "rgb(230,170,170)", border: "1px solid #aaa", display: "inline-block", borderRadius: 2 }} /> Low</span>
          <span style={{ display: "flex", alignItems: "center", gap: 3 }}><span style={{ width: 10, height: 10, background: "rgb(230,50,50)", border: "1px solid #aaa", display: "inline-block", borderRadius: 2 }} /> High</span>
        </>) : (<>
          <span style={{ display: "flex", alignItems: "center", gap: 3 }}><span style={{ width: 10, height: 10, background: "#fff0f0", border: "1px solid #aaa", display: "inline-block", borderRadius: 2 }} /> No receive</span>
          <span style={{ display: "flex", alignItems: "center", gap: 3 }}><span style={{ width: 10, height: 10, background: "rgb(180,220,180)", border: "1px solid #aaa", display: "inline-block", borderRadius: 2 }} /> Low</span>
          <span style={{ display: "flex", alignItems: "center", gap: 3 }}><span style={{ width: 10, height: 10, background: "rgb(40,160,80)", border: "1px solid #aaa", display: "inline-block", borderRadius: 2 }} /> High</span>
        </>)}
        <span style={{ display: "flex", alignItems: "center", gap: 3 }}><span style={{ width: 10, height: 10, background: "#fff", border: "1px solid #aaa", display: "inline-block", borderRadius: 2 }} /> Future</span>
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
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
      const pdfjsLib = await loadPdfJs(); const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      const lines = await extractLines(pdf); let parsed = parseLines(lines);
      if (parsed.length < 3) {
        let rawText = ""; for (let p = 1; p <= pdf.numPages; p++) { const pg = await pdf.getPage(p); const tc = await pg.getTextContent(); rawText += tc.items.map(it => it.str).join(" ") + " "; }
        const fallback = parseFallback(rawText); if (fallback.length > parsed.length) parsed = fallback;
        if (parsed.length < 3) setDebugInfo(`Extracted ${lines.length} lines. First 10:\n${lines.slice(0, 10).join("\n")}\n\nRaw (500ch): ${rawText.substring(0, 500)}`);
      }
      if (parsed.length === 0) { setError("Could not parse transactions."); }
      else { parsed.sort((a, b) => b.dateObj - a.dateObj); setTxns(parsed); setPage(PAGES.OVERVIEW); const d = parsed.map(t => t.dateObj); setDateRange({ min: new Date(Math.min(...d)), max: new Date(Math.max(...d)) }); setError(""); }
    } catch (err) { setError("PDF parsing failed: " + err.message); }
    setLoading(false);
  }, []);

  const debits = useMemo(() => txns.filter(t => t.type === "DEBIT"), [txns]);
  const credits = useMemo(() => txns.filter(t => t.type === "CREDIT"), [txns]);
  const totalSpent = useMemo(() => debits.reduce((s, t) => s + t.amount, 0), [debits]);
  const totalReceived = useMemo(() => credits.reduce((s, t) => s + t.amount, 0), [credits]);
  const avgDaily = useMemo(() => { if (!dateRange) return 0; return totalSpent / Math.max(1, Math.ceil((dateRange.max - dateRange.min) / 86400000)); }, [totalSpent, dateRange]);
  const topTxn = useMemo(() => debits.length ? debits.reduce((a, b) => a.amount > b.amount ? a : b) : null, [debits]);
  const categoryData = useMemo(() => { const map = {}; debits.forEach(t => { if (!map[t.category]) map[t.category] = { total: 0, count: 0 }; map[t.category].total += t.amount; map[t.category].count++; }); const arr = Object.entries(map).map(([name, d]) => ({ name, value: d.total, count: d.count, color: getCatColor(name) })).sort((a, b) => b.value - a.value); arr.forEach(d => (d.pct = totalSpent > 0 ? (d.value / totalSpent) * 100 : 0)); return arr; }, [debits, totalSpent]);
  const dailyData = useMemo(() => { const map = {}; txns.forEach(t => { const k = t.date; if (!map[k]) map[k] = { date: k, dateObj: t.dateObj, spent: 0, received: 0 }; if (t.type === "DEBIT") map[k].spent += t.amount; else map[k].received += t.amount; }); return Object.values(map).sort((a, b) => a.dateObj - b.dateObj); }, [txns]);
  const weeklyData = useMemo(() => { const map = {}; txns.forEach(t => { const d = t.dateObj; const sow = new Date(d); sow.setDate(d.getDate() - d.getDay()); const k = sow.toLocaleDateString("en-IN", { month: "short", day: "numeric" }); if (!map[k]) map[k] = { week: k, dateObj: sow, spent: 0, received: 0 }; if (t.type === "DEBIT") map[k].spent += t.amount; else map[k].received += t.amount; }); return Object.values(map).sort((a, b) => a.dateObj - b.dateObj); }, [txns]);
  const topMerchants = useMemo(() => { const map = {}; debits.forEach(t => { const n = t.detail.substring(0, 40); if (!map[n]) map[n] = { name: n, total: 0, count: 0 }; map[n].total += t.amount; map[n].count++; }); return Object.values(map).sort((a, b) => b.total - a.total).slice(0, 10); }, [debits]);

  const pageNames = { [PAGES.OVERVIEW]: "Overview", [PAGES.CALENDAR]: "Calendar", [PAGES.TRANSACTIONS]: "Transactions", [PAGES.TRENDS]: "Trends" };

  if (!txns.length) return <UploadPage onFile={handleFile} fileRef={fileRef} loading={loading} error={error} debugInfo={debugInfo} />;

  return (
    <div style={{ minHeight: "100vh", background: "#fff", color: "#000", fontFamily: F }}>
      <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      <Sidebar page={page} setPage={setPage} txns={txns} fileRef={fileRef} onFile={handleFile} open={sidebarOpen} setOpen={setSidebarOpen} />
      <HamburgerBtn onClick={() => setSidebarOpen(true)} pageName={pageNames[page]} />
      <div style={{ padding: "8px 20px 50px", maxWidth: 600, margin: "0 auto" }}>
        {page === PAGES.OVERVIEW && <OverviewPage txns={txns} categoryData={categoryData} totalSpent={totalSpent} totalReceived={totalReceived} dailyData={dailyData} weeklyData={weeklyData} topMerchants={topMerchants} avgDaily={avgDaily} topTxn={topTxn} dateRange={dateRange} />}
        {page === PAGES.CALENDAR && <CalendarPage txns={txns} />}
        {page === PAGES.TRANSACTIONS && <TransactionsPage txns={txns} setTxns={setTxns} />}
        {page === PAGES.TRENDS && <TrendsPage txns={txns} dailyData={dailyData} categoryData={categoryData} topMerchants={topMerchants} topTxn={topTxn} />}
        <div style={{ marginTop: 40, padding: "12px 16px", borderRadius: 10, background: "#E8F4FD", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "#4A5568" }}>Vibe coded by Nithin Chowdary <span style={{ color: "#E53E3E", fontSize: 14 }}>❤️</span></span>
        </div>
      </div>
    </div>
  );
}