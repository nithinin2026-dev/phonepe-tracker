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
    const dateStr = m[1];
    let detail = m[2].trim();
    const type = m[3].toUpperCase();
    const amount = parseFloat(m[4].replace(/,/g, ""));
    if (!amount) continue;
    let time = "";
    if (i + 1 < lines.length) { const tm = lines[i + 1].match(TIME_RE); if (tm) time = tm[1]; }
    if (/^(Paid to|Received from|Transfer to)$/i.test(detail.trim())) {
      let extras = [];
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const nl = lines[j];
        if (DATE_RE.test(nl)) break;
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

// ─── COLORS ────────────────────────────────────────────────────────────
const TAG_COLORS = ["#E63946","#457B9D","#2A9D8F","#E9C46A","#F4A261","#6A4C93","#1982C4","#8AC926","#FF595E","#6D6875","#264653","#F77F00"];
function getCatColor(cat) { const idx = ALL_CATEGORY_NAMES.indexOf(cat); return idx >= 0 ? TAG_COLORS[idx % TAG_COLORS.length] : "#999"; }
const fmt = n => "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
const font = "'Nunito', sans-serif";

// ─── PAGES ─────────────────────────────────────────────────────────────
const PAGES = { OVERVIEW: "overview", TRANSACTIONS: "transactions", TRENDS: "trends" };

// ─── TopNavBar (same pattern as Focus Maxing) ──────────────────────────
function TopNavBar({ txns, totalSpent, onMenuClick }) {
  const [visible, setVisible] = useState(true);
  const lastScrollY = useRef(0);
  useEffect(() => {
    const handleScroll = () => {
      const currentY = window.scrollY;
      if (currentY > lastScrollY.current && currentY > 60) setVisible(false);
      else setVisible(true);
      lastScrollY.current = currentY;
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const debits = txns.filter(t => t.type === "DEBIT");
  const credits = txns.filter(t => t.type === "CREDIT");
  const totalReceived = credits.reduce((s, t) => s + t.amount, 0);
  const net = totalReceived - totalSpent;

  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0, zIndex: 1000,
      background: "#fff", borderBottom: "1px solid #eee",
      transform: visible ? "translateY(0)" : "translateY(-100%)",
      transition: "transform 0.35s ease",
      padding: "10px 16px",
      display: "flex", alignItems: "center", justifyContent: "space-between",
      fontFamily: font,
      boxShadow: visible ? "0 2px 12px rgba(0,0,0,0.06)" : "none"
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button onClick={onMenuClick} style={{ border: "none", background: "none", cursor: "pointer", padding: 4, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="2.5" strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
        </button>
        <span style={{ fontSize: 13, fontWeight: 700, display: "flex", alignItems: "center", gap: 5 }}>
          <span>💸</span><span>{fmt(totalSpent)}</span>
          <span style={{ fontWeight: 400, fontSize: 10, color: "#999" }}>spent</span>
        </span>
      </div>
      <div style={{ flex: 1, textAlign: "center", fontSize: 13, fontWeight: 700, color: "#333", fontStyle: "italic", padding: "0 12px", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
        "Track every rupee"
      </div>
      <div style={{
        display: "flex", alignItems: "center", gap: 5,
        background: net >= 0 ? "#2A9D8F" : "#E63946",
        color: "#fff",
        padding: "6px 14px", borderRadius: 30,
        fontSize: 13, fontWeight: 700
      }}>
        <span style={{ fontSize: 14 }}>{net >= 0 ? "↑" : "↓"}</span>
        <span>{fmt(Math.abs(net))}</span>
        <span style={{ fontWeight: 400, fontSize: 10, opacity: 0.8 }}>{net >= 0 ? "surplus" : "deficit"}</span>
      </div>
    </div>
  );
}

// ─── Sidebar (same pattern as Focus Maxing) ────────────────────────────
function Sidebar({ open, onClose, page, setPage, txns }) {
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
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 2000, opacity: open ? 1 : 0, pointerEvents: open ? "auto" : "none", transition: "opacity 0.3s ease" }} />
      <div style={{
        position: "fixed", top: 0, left: 0, bottom: 0, width: 260, zIndex: 2001,
        background: "#fff", boxShadow: "4px 0 24px rgba(0,0,0,0.12)",
        transform: open ? "translateX(0)" : "translateX(-100%)",
        transition: "transform 0.3s ease",
        display: "flex", flexDirection: "column", fontFamily: font
      }}>
        <div style={{ padding: "24px 20px 16px", borderBottom: "1px solid #eee" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
            <span style={{ fontSize: 18, fontWeight: 800, letterSpacing: "-0.02em" }}>
              <span style={{ color: "#E63946" }}>₹</span> SpendScope
            </span>
            <button onClick={onClose} style={{ border: "none", background: "none", cursor: "pointer", fontSize: 20, color: "#999", padding: 0 }}>✕</button>
          </div>
          <div style={{ display: "flex", gap: 16, fontSize: 12 }}>
            <div><div style={{ fontSize: 16, fontWeight: 700, color: "#E63946" }}>{fmt(totalSpent)}</div><div style={{ color: "#999", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>Spent</div></div>
            <div><div style={{ fontSize: 16, fontWeight: 700, color: "#2A9D8F" }}>{fmt(totalReceived)}</div><div style={{ color: "#999", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>Received</div></div>
          </div>
        </div>
        <div style={{ flex: 1, padding: "12px 0", overflowY: "auto" }}>
          {items.map(i => {
            const active = page === i.key;
            return (
              <button key={i.key} onClick={() => { setPage(i.key); onClose(); }} style={{
                display: "flex", alignItems: "center", gap: 12, width: "100%",
                padding: "14px 24px", border: "none", cursor: "pointer",
                background: active ? "#f0f0f0" : "transparent",
                color: "#000", fontSize: 14, fontWeight: active ? 700 : 500,
                fontFamily: font, textAlign: "left", transition: "background 0.15s ease",
                borderLeft: active ? "3px solid #000" : "3px solid transparent"
              }}>
                <span style={{ fontSize: 18 }}>{i.icon}</span>
                <span>{i.label}</span>
              </button>
            );
          })}
        </div>
        <div style={{ padding: "16px 20px", borderTop: "1px solid #eee" }}>
          <div style={{ fontSize: 11, color: "#ccc", textAlign: "center", fontFamily: font }}>
            Vibe coded by Nithin Chowdary ❤️
          </div>
        </div>
      </div>
    </>
  );
}

// ─── SectionHeader ─────────────────────────────────────────────────────
function SectionHeader({ children }) {
  return <div style={{ fontSize: 11, fontFamily: font, textTransform: "uppercase", letterSpacing: "0.15em", color: "#999", marginBottom: 14, fontWeight: 600, marginTop: 40 }}>{children}</div>;
}

// ─── StatPill (Focus Maxing style stat cards) ──────────────────────────
function StatPill({ label, value, sub, icon }) {
  return (
    <div style={{ background: "#f6f6f6", borderRadius: 10, padding: "16px 20px", flex: "1 1 140px", minWidth: 140, fontFamily: font }}>
      <div style={{ fontSize: 10, color: "#999", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>{icon && <span style={{ marginRight: 4 }}>{icon}</span>}{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#999", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// ─── CategoryBars (Focus Maxing bar chart style) ───────────────────────
function CategoryBarsCustom({ data }) {
  if (data.length === 0) return null;
  const maxVal = data[0].value;
  const barH = 160;
  return (
    <div style={{ overflowX: "auto", paddingBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 6, minWidth: data.length * 64, height: barH + 40, paddingTop: 20 }}>
        {data.map(d => {
          const h = maxVal > 0 ? (d.value / maxVal) * barH : 0;
          return (
            <div key={d.name} style={{ flex: 1, minWidth: 48, maxWidth: 80, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", height: barH + 40 }}>
              <span style={{ fontSize: 11, fontFamily: font, fontWeight: 700, marginBottom: 4, color: d.color }}>{fmt(d.value)}</span>
              <div style={{ width: "100%", height: h, background: d.color, borderRadius: "4px 4px 0 0", transition: "height 0.4s ease", minHeight: d.value > 0 ? 6 : 0 }} />
              <span style={{ fontSize: 9, fontFamily: font, marginTop: 6, textAlign: "center", color: "#666", maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", width: "100%" }}>{d.name}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Upload Page (Focus Maxing Auth style) ─────────────────────────────
function UploadPage({ onFile, fileRef, loading, error, debugInfo }) {
  return (
    <div style={{ maxWidth: 400, margin: "0 auto", padding: "80px 24px", minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: font }}>
      <div style={{ marginBottom: 40, textAlign: "center" }}>
        <div style={{ fontSize: 32, fontWeight: 800, letterSpacing: "-0.02em", marginBottom: 4 }}>
          <span style={{ color: "#E63946" }}>₹</span> SpendScope
        </div>
        <div style={{ fontSize: 12, color: "#999", textTransform: "uppercase", letterSpacing: "0.15em", fontWeight: 600 }}>PhonePe Statement Analyzer</div>
      </div>
      <div style={{ width: "100%", maxWidth: 320, textAlign: "center" }}>
        <div style={{ fontSize: 48, marginBottom: 20 }}>📄</div>
        <div style={{ fontSize: 14, color: "#666", lineHeight: 1.6, marginBottom: 24 }}>
          Download your statement from PhonePe app and upload the PDF here.
        </div>
        <button onClick={() => fileRef.current?.click()} disabled={loading} style={{
          width: "100%", padding: "14px 0", border: "2px solid #000", background: "#000", color: "#fff",
          fontSize: 13, fontFamily: font, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase",
          cursor: loading ? "default" : "pointer", opacity: loading ? 0.5 : 1
        }}>
          {loading ? "Parsing..." : "Upload PDF"}
        </button>
        <input ref={fileRef} type="file" accept=".pdf" onChange={onFile} style={{ display: "none" }} />
        {error && <div style={{ fontSize: 12, color: "#E63946", fontFamily: font, fontWeight: 600, padding: "12px 0", textAlign: "center" }}>{error}</div>}
        {debugInfo && <pre style={{ fontSize: 10, color: "#999", marginTop: 12, whiteSpace: "pre-wrap", maxHeight: 200, overflow: "auto", textAlign: "left", background: "#f6f6f6", padding: 12, borderRadius: 6 }}>{debugInfo}</pre>}
        <div style={{ marginTop: 32, display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
          {["Categories", "Trends", "Merchants", "Transactions"].map(f => (
            <span key={f} style={{ padding: "6px 12px", background: "#f6f6f6", borderRadius: 6, fontSize: 11, color: "#999", fontWeight: 600 }}>{f}</span>
          ))}
        </div>
      </div>
      <div style={{ marginTop: 60, fontSize: 12, color: "#ccc", fontFamily: font, textAlign: "center" }}>Vibe coded by Nithin Chowdary ❤️</div>
    </div>
  );
}

// ─── Overview Page ─────────────────────────────────────────────────────
function OverviewPage({ txns, setTxns, categoryData, totalSpent, totalReceived, dailyData, weeklyData, topMerchants, avgDaily, topTxn }) {
  const net = totalReceived - totalSpent;
  const debits = txns.filter(t => t.type === "DEBIT");
  const credits = txns.filter(t => t.type === "CREDIT");
  const ttStyle = { background: "#fff", border: "1px solid #eee", borderRadius: 8, fontSize: 12, color: "#000", fontFamily: font };

  return (
    <div>
      <SectionHeader>Summary</SectionHeader>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 24 }}>
        <StatPill label="Total Spent" value={fmt(totalSpent)} icon="↑" sub={`${debits.length} debits`} />
        <StatPill label="Received" value={fmt(totalReceived)} icon="↓" sub={`${credits.length} credits`} />
        <StatPill label="Net Flow" value={fmt(Math.abs(net))} sub={net >= 0 ? "Surplus" : "Deficit"} />
        <StatPill label="Avg / Day" value={fmt(avgDaily)} icon="◷" sub={topTxn ? `Biggest: ${fmt(topTxn.amount)}` : ""} />
      </div>

      <SectionHeader>Spending by Category</SectionHeader>
      <CategoryBarsCustom data={categoryData} />

      {/* Pie chart */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 24, background: "#f6f6f6", borderRadius: 10, padding: 20 }}>
        <ResponsiveContainer width="48%" height={180}>
          <PieChart><Pie data={categoryData} dataKey="value" cx="50%" cy="50%" innerRadius={40} outerRadius={75} strokeWidth={2} stroke="#fff">{categoryData.map((d, i) => <Cell key={i} fill={d.color} />)}</Pie><Tooltip contentStyle={ttStyle} formatter={v => fmt(v)} /></PieChart>
        </ResponsiveContainer>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, fontFamily: font }}>
          {categoryData.slice(0, 7).map(d => (
            <div key={d.name} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
              <div style={{ width: 8, height: 8, borderRadius: 2, background: d.color, flexShrink: 0 }} />
              <span style={{ color: "#666", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</span>
              <span style={{ fontWeight: 700, fontSize: 11 }}>{d.pct.toFixed(0)}%</span>
            </div>
          ))}
        </div>
      </div>

      {/* Daily spending area chart */}
      <SectionHeader>Daily Spending</SectionHeader>
      <div style={{ background: "#f6f6f6", borderRadius: 10, padding: "16px 8px" }}>
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={dailyData}>
            <defs><linearGradient id="gS" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#000" stopOpacity={0.15} /><stop offset="95%" stopColor="#000" stopOpacity={0} /></linearGradient></defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#999", fontFamily: font }} tickFormatter={v => { const d = new Date(v); return `${d.getDate()}/${d.getMonth()+1}`; }} />
            <YAxis tick={{ fontSize: 10, fill: "#999", fontFamily: font }} tickFormatter={v => `₹${(v/1000).toFixed(0)}k`} />
            <Tooltip contentStyle={ttStyle} formatter={v => fmt(v)} />
            <Area type="monotone" dataKey="spent" stroke="#000" fill="url(#gS)" strokeWidth={2} name="Spent" />
            <Area type="monotone" dataKey="received" stroke="#2A9D8F" fill="none" strokeWidth={2} strokeDasharray="5 5" name="Received" />
            <Legend wrapperStyle={{ fontSize: 11, fontFamily: font }} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Top merchants */}
      <SectionHeader>Top Merchants</SectionHeader>
      {topMerchants.map((m, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: "1px solid #f0f0f0", fontFamily: font, fontSize: 14 }}>
          <span style={{ width: 24, height: 24, borderRadius: 6, background: "#f0f0f0", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, flexShrink: 0, color: "#666" }}>{i + 1}</span>
          <span style={{ flex: 1, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span>
          <span style={{ color: "#999", fontSize: 12 }}>{m.count}x</span>
          <span style={{ fontWeight: 700, fontSize: 13 }}>{fmt(m.total)}</span>
        </div>
      ))}

      {/* Weekly bar chart */}
      <SectionHeader>Weekly Spending</SectionHeader>
      <div style={{ background: "#f6f6f6", borderRadius: 10, padding: "16px 8px" }}>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={weeklyData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
            <XAxis dataKey="week" tick={{ fontSize: 10, fill: "#999", fontFamily: font }} />
            <YAxis tick={{ fontSize: 10, fill: "#999", fontFamily: font }} tickFormatter={v => `₹${(v/1000).toFixed(0)}k`} />
            <Tooltip contentStyle={ttStyle} formatter={v => fmt(v)} />
            <Bar dataKey="spent" fill="#000" radius={[4, 4, 0, 0]} name="Spent" />
            <Bar dataKey="received" fill="#2A9D8F" radius={[4, 4, 0, 0]} name="Received" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ─── Transactions Page ─────────────────────────────────────────────────
function TransactionsPage({ txns, setTxns }) {
  const [catFilter, setCatFilter] = useState("All");
  const [typeFilter, setTypeFilter] = useState("All");
  const [searchQ, setSearchQ] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editCat, setEditCat] = useState("");

  const categories = useMemo(() => ["All", ...new Set(txns.map(t => t.category))], [txns]);
  const filtered = useMemo(() => txns.filter(t => {
    if (catFilter !== "All" && t.category !== catFilter) return false;
    if (typeFilter !== "All" && t.type !== typeFilter) return false;
    if (searchQ && !t.detail.toLowerCase().includes(searchQ.toLowerCase())) return false;
    return true;
  }), [txns, catFilter, typeFilter, searchQ]);

  const deleteTxn = (id) => setTxns(prev => prev.filter(t => t.id !== id));
  const saveCategory = (id) => {
    setTxns(prev => prev.map(t => t.id === id ? { ...t, category: editCat } : t));
    setEditingId(null);
  };

  return (
    <div>
      <SectionHeader>Transactions ({filtered.length})</SectionHeader>
      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap", alignItems: "center" }}>
        <input placeholder="Search..." value={searchQ} onChange={e => setSearchQ(e.target.value)} style={{ border: "2px solid #000", padding: "10px 14px", fontSize: 13, fontFamily: font, flex: 1, minWidth: 140, background: "transparent", outline: "none", fontWeight: 600 }} />
        <select value={catFilter} onChange={e => setCatFilter(e.target.value)} style={{ border: "2px solid #000", padding: "10px 12px", fontSize: 13, fontFamily: font, fontWeight: 600, background: "#fff", outline: "none", cursor: "pointer" }}>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} style={{ border: "2px solid #000", padding: "10px 12px", fontSize: 13, fontFamily: font, fontWeight: 600, background: "#fff", outline: "none", cursor: "pointer" }}>
          <option value="All">All Types</option><option value="DEBIT">Debits</option><option value="CREDIT">Credits</option>
        </select>
      </div>

      {/* Table header */}
      <div style={{ display: "grid", gridTemplateColumns: "80px 1fr 110px 55px 85px 30px", padding: "8px 0", borderBottom: "2px solid #000", fontFamily: font, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "#999" }}>
        <span>Date</span><span>Details</span><span>Category</span><span>Type</span><span style={{ textAlign: "right" }}>Amount</span><span></span>
      </div>

      {filtered.length === 0 && <div style={{ textAlign: "center", color: "#ccc", fontFamily: font, fontSize: 13, padding: "30px 0" }}>No transactions found</div>}

      {filtered.map(t => (
        <div key={t.id} style={{ display: "grid", gridTemplateColumns: "80px 1fr 110px 55px 85px 30px", padding: "10px 0", borderBottom: "1px solid #f0f0f0", fontFamily: font, fontSize: 13, alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "#999" }}>
            {t.dateObj.toLocaleDateString("en-IN", { month: "short", day: "numeric" })}
            {t.time && <><br/><span style={{ fontSize: 9 }}>{t.time}</span></>}
          </span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 8, fontWeight: 600 }}>{t.detail}</span>
          <span>
            {editingId === t.id ? (
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <select value={editCat} onChange={e => setEditCat(e.target.value)} style={{ border: "1px solid #ccc", padding: "3px 4px", fontSize: 10, fontFamily: font, outline: "none", maxWidth: 80 }}>
                  {ALL_CATEGORY_NAMES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <button onClick={() => saveCategory(t.id)} style={{ border: "none", background: "#000", color: "#fff", padding: "3px 6px", fontSize: 9, fontFamily: font, fontWeight: 700, cursor: "pointer", borderRadius: 3 }}>✓</button>
              </div>
            ) : (
              <span onClick={() => { setEditingId(t.id); setEditCat(t.category); }} style={{ fontSize: 10, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4, color: getCatColor(t.category), fontWeight: 600 }} title="Click to change category">
                <span style={{ width: 6, height: 6, borderRadius: 2, background: getCatColor(t.category), display: "inline-block" }} />
                {t.category}
              </span>
            )}
          </span>
          <span style={{ fontSize: 10, fontWeight: 700, color: t.type === "CREDIT" ? "#2A9D8F" : "#E63946" }}>{t.type}</span>
          <span style={{ textAlign: "right", fontWeight: 700, fontSize: 13, color: t.type === "CREDIT" ? "#2A9D8F" : "#000" }}>{t.type === "CREDIT" ? "+" : "-"}{fmt(t.amount)}</span>
          <button onClick={() => deleteTxn(t.id)} style={{ border: "none", background: "none", cursor: "pointer", color: "#ccc", fontSize: 16, padding: 0, lineHeight: 1 }} title="Delete">✕</button>
        </div>
      ))}
    </div>
  );
}

// ─── Trends Page ───────────────────────────────────────────────────────
function TrendsPage({ txns, dailyData, categoryData, topMerchants, topTxn }) {
  const debits = useMemo(() => txns.filter(t => t.type === "DEBIT"), [txns]);
  const ttStyle = { background: "#fff", border: "1px solid #eee", borderRadius: 8, fontSize: 12, color: "#000", fontFamily: font };

  return (
    <div>
      {/* Cumulative spending */}
      <SectionHeader>Cumulative Spending</SectionHeader>
      <div style={{ background: "#f6f6f6", borderRadius: 10, padding: "16px 8px" }}>
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={(() => { let c = 0; return dailyData.map(d => { c += d.spent; return { ...d, cumulative: c }; }); })()}>
            <defs><linearGradient id="gC" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#E63946" stopOpacity={0.15} /><stop offset="95%" stopColor="#E63946" stopOpacity={0} /></linearGradient></defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#999", fontFamily: font }} tickFormatter={v => { const d = new Date(v); return `${d.getDate()}/${d.getMonth()+1}`; }} />
            <YAxis tick={{ fontSize: 10, fill: "#999", fontFamily: font }} tickFormatter={v => `₹${(v/1000).toFixed(0)}k`} />
            <Tooltip contentStyle={ttStyle} formatter={v => fmt(v)} />
            <Area type="monotone" dataKey="cumulative" stroke="#E63946" fill="url(#gC)" strokeWidth={2.5} name="Total Spent" />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* By day of week */}
      <SectionHeader>By Day of Week</SectionHeader>
      <div style={{ background: "#f6f6f6", borderRadius: 10, padding: "16px 8px" }}>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={(() => { const d = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(x => ({ day: x, amount: 0 })); debits.forEach(t => d[t.dateObj.getDay()].amount += t.amount); return d; })()}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" /><XAxis dataKey="day" tick={{ fontSize: 10, fill: "#999", fontFamily: font }} /><YAxis tick={{ fontSize: 10, fill: "#999", fontFamily: font }} tickFormatter={v => `₹${(v/1000).toFixed(0)}k`} /><Tooltip contentStyle={ttStyle} formatter={v => fmt(v)} /><Bar dataKey="amount" fill="#000" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* By time of day */}
      <SectionHeader>By Time of Day</SectionHeader>
      <div style={{ background: "#f6f6f6", borderRadius: 10, padding: "16px 8px" }}>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={(() => { const s = [{slot:"Morning",amount:0},{slot:"Afternoon",amount:0},{slot:"Evening",amount:0},{slot:"Night",amount:0}]; debits.forEach(t => { const h=t.dateObj.getHours(); if(h>=6&&h<12)s[0].amount+=t.amount; else if(h>=12&&h<17)s[1].amount+=t.amount; else if(h>=17&&h<21)s[2].amount+=t.amount; else s[3].amount+=t.amount; }); return s; })()}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" /><XAxis dataKey="slot" tick={{ fontSize: 10, fill: "#999", fontFamily: font }} /><YAxis tick={{ fontSize: 10, fill: "#999", fontFamily: font }} tickFormatter={v => `₹${(v/1000).toFixed(0)}k`} /><Tooltip contentStyle={ttStyle} formatter={v => fmt(v)} /><Bar dataKey="amount" fill="#2A9D8F" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Quick Insights */}
      <SectionHeader>Quick Insights</SectionHeader>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontFamily: font }}>
        {[
          { icon: "🔥", title: "Biggest Spend Day", value: dailyData.length ? (() => { const d = dailyData.reduce((a, b) => a.spent > b.spent ? a : b); return `${d.date} — ${fmt(d.spent)}`; })() : "—" },
          { icon: "💰", title: "Biggest Transaction", value: topTxn ? `${topTxn.detail.substring(0, 18)}… — ${fmt(topTxn.amount)}` : "—" },
          { icon: "📊", title: "Top Category", value: categoryData[0] ? `${categoryData[0].name} (${categoryData[0].count} txns)` : "—" },
          { icon: "🏪", title: "Most Visited", value: topMerchants[0] ? `${topMerchants[0].name.substring(0, 18)} (${topMerchants[0].count}x)` : "—" },
          { icon: "📈", title: "Investments", value: fmt(txns.filter(t => t.type === "DEBIT" && t.category === "Investments").reduce((s, t) => s + t.amount, 0)) },
          { icon: "🍔", title: "Food & Dining", value: fmt(txns.filter(t => t.type === "DEBIT" && t.category === "Food & Dining").reduce((s, t) => s + t.amount, 0)) },
        ].map((ins, i) => (
          <div key={i} style={{ background: "#f6f6f6", borderRadius: 10, padding: "14px 16px" }}>
            <div style={{ fontSize: 18, marginBottom: 4 }}>{ins.icon}</div>
            <div style={{ fontSize: 10, color: "#999", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 3 }}>{ins.title}</div>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{ins.value}</div>
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [dateRange, setDateRange] = useState(null);
  const fileRef = useRef();

  const handleFile = useCallback(async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
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
      if (parsed.length === 0) { setError("Could not parse transactions. See debug info below."); }
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

  if (!hasData) return (
    <>
      <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      <UploadPage onFile={handleFile} fileRef={fileRef} loading={loading} error={error} debugInfo={debugInfo} />
    </>
  );

  return (
    <div style={{ maxWidth: 600, margin: "0 auto", padding: "60px 20px 60px", minHeight: "100vh", background: "#fff", color: "#000", fontFamily: font }}>
      <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      <TopNavBar txns={txns} totalSpent={totalSpent} onMenuClick={() => setSidebarOpen(true)} />
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} page={page} setPage={setPage} txns={txns} />

      {/* Upload another — small strip */}
      <div style={{ background: "#f6f6f6", borderRadius: 10, padding: "12px 14px", marginBottom: 20, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "#666" }}>
          📄 {txns.length} transactions · {dateRange?.min.toLocaleDateString("en-IN", { month: "short", day: "numeric" })} – {dateRange?.max.toLocaleDateString("en-IN", { month: "short", day: "numeric", year: "numeric" })}
        </span>
        <button onClick={() => fileRef.current?.click()} style={{ border: "2px solid #000", background: "#000", color: "#fff", padding: "6px 14px", fontSize: 11, fontFamily: font, fontWeight: 700, cursor: "pointer", letterSpacing: "0.04em", textTransform: "uppercase" }}>Upload New</button>
        <input ref={fileRef} type="file" accept=".pdf" onChange={handleFile} style={{ display: "none" }} />
      </div>

      {page === PAGES.OVERVIEW && <OverviewPage txns={txns} setTxns={setTxns} categoryData={categoryData} totalSpent={totalSpent} totalReceived={totalReceived} dailyData={dailyData} weeklyData={weeklyData} topMerchants={topMerchants} avgDaily={avgDaily} topTxn={topTxn} />}
      {page === PAGES.TRANSACTIONS && <TransactionsPage txns={txns} setTxns={setTxns} />}
      {page === PAGES.TRENDS && <TrendsPage txns={txns} dailyData={dailyData} categoryData={categoryData} topMerchants={topMerchants} topTxn={topTxn} />}

      {/* Footer */}
      <div style={{ marginTop: 48, padding: "14px 20px", borderRadius: 12, background: "#E8F4FD", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "#4A5568", letterSpacing: "0.01em" }}>
          Vibe coded by Nithin Chowdary <span style={{ color: "#E53E3E", fontSize: 15 }}>❤️</span>
        </span>
      </div>
    </div>
  );
}