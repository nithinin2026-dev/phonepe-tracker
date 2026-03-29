import { useState, useMemo, useCallback, useRef } from "react";
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
// Groups text items by Y coordinate to reconstruct visual lines
async function extractLines(pdf) {
  const allLines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const items = tc.items.filter(it => it.str.trim());
    if (!items.length) continue;

    // Group by Y position (PDF Y is bottom-up). Use tolerance of 3px.
    const groups = {};
    items.forEach(item => {
      const y = Math.round(item.transform[5]);
      const x = item.transform[4];
      // Find existing group within tolerance
      let key = Object.keys(groups).find(k => Math.abs(Number(k) - y) < 3);
      if (!key) { key = String(y); groups[key] = []; }
      groups[key].push({ x, text: item.str });
    });

    // Sort: highest Y first (top of page in PDF coords), items left-to-right
    Object.keys(groups)
      .sort((a, b) => Number(b) - Number(a))
      .forEach(y => {
        const line = groups[y]
          .sort((a, b) => a.x - b.x)
          .map(it => it.text)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (line) allLines.push(line);
      });
  }
  return allLines;
}

// ─── CATEGORIZATION ────────────────────────────────────────────────────
const CATEGORIES = {
  "Food & Dining": [
    "tea cube","mohan sagar tea","cafe chai","sitara hotel","ignite shawarma",
    "swiggy","bharat food point","makong food","keshav reddy sweets",
    "vinayaka tea","raghavendra swami bengulur bakery","vigneshwara juice",
    "food","restaurant","cafe","hotel","biryani","chicken","shawarma",
    "pizza","burger","zomato","tea stall","juice","bakery","sweets",
    "ram reddy chicken","food hub","tea world"
  ],
  "Groceries": [
    "kirana","general store","garlyathri","shree veer teja","sri harshini",
    "grocery","supermarket","bigbasket","dmart"
  ],
  "Investments": ["zerodha","iccl","indmoney","groww","upstox","broking"],
  "Transport": ["uber","rapido","roppen transportation","ola","metro","irctc"],
  "Shopping": ["amazon","flipkart","myntra","blinkit","commerce private","meesho"],
  "Bills & Recharges": ["airtel","jio","vi ","bsnl","electricity","shiva internet","broadband"],
  "Rent & Housing": ["jurys luxury","hostel","rent","pg ","co living","co-living"],
  "Health": ["pharmacy","aushadam","sikdar first aid","medical","hospital","calin soft health"],
  "Personal Care": ["beauty","saloon","salon","barber","spa"],
};

function categorize(detail) {
  const lower = detail.toLowerCase();
  for (const [cat, keywords] of Object.entries(CATEGORIES)) {
    if (keywords.some(k => lower.includes(k))) return cat;
  }
  if (lower.includes("transfer to") || lower.includes("transfer from")) return "Self Transfer";
  return "Transfers & Others";
}

// ─── TRANSACTION PARSER ────────────────────────────────────────────────
// PhonePe PDF lines look like:
//   "Mar 28, 2026 Paid to CHILAKA RAKESH DEBIT ₹100"
//   "07:58 PM Transaction ID T2603281958314066619167"
//   "UTR No. 127717762152"
//   "Paid by XXXXXXXX1153"
// Edge case: "Mar 14, 2026 Paid to DEBIT ₹15" (detail on next line)

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

    // Get time from next line
    let time = "";
    if (i + 1 < lines.length) {
      const tm = lines[i + 1].match(TIME_RE);
      if (tm) time = tm[1];
    }

    // Handle edge case: "Paid to DEBIT ₹15" means detail is on subsequent lines
    if (/^(Paid to|Received from|Transfer to)$/i.test(detail.trim())) {
      let extras = [];
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const nl = lines[j];
        if (DATE_RE.test(nl)) break;
        if (/^(Transaction ID|UTR No|Paid by|Credited to|Page \d|This is)/i.test(nl)) continue;
        if (TIME_RE.test(nl)) {
          // Might have detail after time: "04:33 PM Sri Raghavendra..."
          const afterTime = nl.replace(TIME_RE, "").trim();
          if (afterTime && !/^Transaction/i.test(afterTime)) extras.push(afterTime);
          continue;
        }
        extras.push(nl.trim());
      }
      if (extras.length) detail = detail + " " + extras.join(" ");
    }

    // Clean detail
    let cleanDetail = detail
      .replace(/^Paid to\s*/i, "")
      .replace(/^Received from\s*/i, "")
      .replace(/^Transfer to\s*/i, "Transfer to ")
      .replace(/^Transfer from\s*/i, "Transfer from ")
      .trim();
    if (!cleanDetail) cleanDetail = detail.trim();

    const dateObj = new Date(`${dateStr} ${time || "12:00 PM"}`);

    txns.push({
      date: dateStr, time,
      dateObj: isNaN(dateObj.getTime()) ? new Date(dateStr) : dateObj,
      detail: cleanDetail, type, amount,
      category: categorize(cleanDetail + " " + detail),
    });
  }
  return txns;
}

// Fallback: use raw text with global regex
function parseFallback(rawText) {
  const txns = [];
  const re = /((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4})\s+((?:Paid to|Received from|Transfer to|Transfer from)\s+.+?)\s+(DEBIT|CREDIT)\s+₹\s*([\d,.]+)/gi;
  let match;
  while ((match = re.exec(rawText)) !== null) {
    const dateStr = match[1];
    let detail = match[2].trim();
    const type = match[3].toUpperCase();
    const amount = parseFloat(match[4].replace(/,/g, ""));
    if (!amount) continue;

    const after = rawText.substring(match.index + match[0].length, match.index + match[0].length + 100);
    const tm = after.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
    const time = tm ? tm[1] : "";

    let cleanDetail = detail.replace(/^Paid to\s*/i, "").replace(/^Received from\s*/i, "").replace(/^Transfer to\s*/i, "Transfer to ").trim();
    const dateObj = new Date(`${dateStr} ${time || "12:00 PM"}`);

    txns.push({
      date: dateStr, time,
      dateObj: isNaN(dateObj.getTime()) ? new Date(dateStr) : dateObj,
      detail: cleanDetail || detail, type, amount,
      category: categorize(cleanDetail || detail),
    });
  }
  return txns;
}

// ─── COLORS ────────────────────────────────────────────────────────────
const PALETTE = ["#6366f1","#f43f5e","#10b981","#f59e0b","#3b82f6","#8b5cf6","#ec4899","#14b8a6","#f97316","#06b6d4","#84cc16","#e11d48"];
const CAT_COLORS = {};
[...Object.keys(CATEGORIES), "Self Transfer", "Transfers & Others"].forEach((c, i) => {
  CAT_COLORS[c] = PALETTE[i % PALETTE.length];
});
const fmt = n => "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 0 });

// ─── UI COMPONENTS ─────────────────────────────────────────────────────
function StatCard({ label, value, sub, color, icon }) {
  return (
    <div style={{ background: "var(--card)", borderRadius: 16, padding: "20px 24px", border: "1px solid var(--border)", flex: "1 1 200px", minWidth: 170, position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", top: -20, right: -20, width: 80, height: 80, borderRadius: "50%", background: color || "var(--accent)", opacity: 0.08 }} />
      <div style={{ fontSize: 13, color: "var(--muted)", fontWeight: 500, marginBottom: 6, letterSpacing: 0.3 }}>
        {icon && <span style={{ marginRight: 6 }}>{icon}</span>}{label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color: "var(--text)", letterSpacing: -0.5 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function CategoryBars({ data }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {data.map(d => (
        <div key={d.name}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 500 }}>{d.name}</span>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{fmt(d.value)}</span>
          </div>
          <div style={{ height: 8, background: "var(--border)", borderRadius: 4, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${d.pct}%`, background: d.color, borderRadius: 4, transition: "width 0.6s" }} />
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{d.count} txn{d.count > 1 ? "s" : ""} · {d.pct.toFixed(1)}%</div>
        </div>
      ))}
    </div>
  );
}

// ─── MAIN APP ──────────────────────────────────────────────────────────
export default function App() {
  const [txns, setTxns] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [debugInfo, setDebugInfo] = useState("");
  const [tab, setTab] = useState("overview");
  const [catFilter, setCatFilter] = useState("All");
  const [typeFilter, setTypeFilter] = useState("All");
  const [searchQ, setSearchQ] = useState("");
  const [dateRange, setDateRange] = useState(null);
  const fileRef = useRef();

  const handleFile = useCallback(async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoading(true);
    setError("");
    setDebugInfo("");
    try {
      const pdfjsLib = await loadPdfJs();
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;

      // Method 1: Position-aware line extraction
      const lines = await extractLines(pdf);
      let parsed = parseLines(lines);

      // Method 2 fallback: raw text global regex
      if (parsed.length < 3) {
        let rawText = "";
        for (let p = 1; p <= pdf.numPages; p++) {
          const page = await pdf.getPage(p);
          const tc = await page.getTextContent();
          rawText += tc.items.map(it => it.str).join(" ") + " ";
        }
        const fallback = parseFallback(rawText);
        if (fallback.length > parsed.length) parsed = fallback;

        if (parsed.length < 3) {
          setDebugInfo(`Extracted ${lines.length} lines. First 10:\n${lines.slice(0, 10).join("\n")}\n\nRaw (500ch): ${rawText.substring(0, 500)}`);
        }
      }

      if (parsed.length === 0) {
        setError("Could not parse transactions. See debug info below.");
      } else {
        parsed.sort((a, b) => b.dateObj - a.dateObj);
        setTxns(parsed);
        setTab("overview");
        const dates = parsed.map(t => t.dateObj);
        setDateRange({ min: new Date(Math.min(...dates)), max: new Date(Math.max(...dates)) });
        setError("");
      }
    } catch (err) {
      setError("PDF parsing failed: " + err.message);
    }
    setLoading(false);
  }, []);

  const debits = useMemo(() => txns.filter(t => t.type === "DEBIT"), [txns]);
  const credits = useMemo(() => txns.filter(t => t.type === "CREDIT"), [txns]);
  const totalSpent = useMemo(() => debits.reduce((s, t) => s + t.amount, 0), [debits]);
  const totalReceived = useMemo(() => credits.reduce((s, t) => s + t.amount, 0), [credits]);
  const avgDaily = useMemo(() => {
    if (!dateRange) return 0;
    return totalSpent / Math.max(1, Math.ceil((dateRange.max - dateRange.min) / 86400000));
  }, [totalSpent, dateRange]);
  const topTxn = useMemo(() => debits.length ? debits.reduce((a, b) => a.amount > b.amount ? a : b) : null, [debits]);

  const categoryData = useMemo(() => {
    const map = {};
    debits.forEach(t => {
      if (!map[t.category]) map[t.category] = { total: 0, count: 0 };
      map[t.category].total += t.amount;
      map[t.category].count++;
    });
    const arr = Object.entries(map)
      .map(([name, d]) => ({ name, value: d.total, count: d.count, color: CAT_COLORS[name] || "#94a3b8" }))
      .sort((a, b) => b.value - a.value);
    arr.forEach(d => (d.pct = (d.value / totalSpent) * 100));
    return arr;
  }, [debits, totalSpent]);

  const dailyData = useMemo(() => {
    const map = {};
    txns.forEach(t => {
      const key = t.date;
      if (!map[key]) map[key] = { date: key, dateObj: t.dateObj, spent: 0, received: 0 };
      if (t.type === "DEBIT") map[key].spent += t.amount;
      else map[key].received += t.amount;
    });
    return Object.values(map).sort((a, b) => a.dateObj - b.dateObj);
  }, [txns]);

  const weeklyData = useMemo(() => {
    const map = {};
    txns.forEach(t => {
      const d = t.dateObj;
      const sow = new Date(d); sow.setDate(d.getDate() - d.getDay());
      const key = sow.toLocaleDateString("en-IN", { month: "short", day: "numeric" });
      if (!map[key]) map[key] = { week: key, dateObj: sow, spent: 0, received: 0 };
      if (t.type === "DEBIT") map[key].spent += t.amount;
      else map[key].received += t.amount;
    });
    return Object.values(map).sort((a, b) => a.dateObj - b.dateObj);
  }, [txns]);

  const topMerchants = useMemo(() => {
    const map = {};
    debits.forEach(t => {
      const name = t.detail.substring(0, 40);
      if (!map[name]) map[name] = { name, total: 0, count: 0 };
      map[name].total += t.amount;
      map[name].count++;
    });
    return Object.values(map).sort((a, b) => b.total - a.total).slice(0, 10);
  }, [debits]);

  const filteredTxns = useMemo(() => txns.filter(t => {
    if (catFilter !== "All" && t.category !== catFilter) return false;
    if (typeFilter !== "All" && t.type !== typeFilter) return false;
    if (searchQ && !t.detail.toLowerCase().includes(searchQ.toLowerCase())) return false;
    return true;
  }), [txns, catFilter, typeFilter, searchQ]);

  const categories = useMemo(() => ["All", ...new Set(txns.map(t => t.category))], [txns]);
  const hasData = txns.length > 0;

  const ttStyle = { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, color: "var(--text)" };

  return (
    <div style={{
      "--bg": "#0a0a0f", "--card": "#12121a", "--border": "#1e1e2e",
      "--text": "#e8e8ed", "--muted": "#6b6b80", "--accent": "#6366f1",
      "--accent2": "#f43f5e", "--green": "#10b981", "--surface": "#16161f",
      fontFamily: "'DM Sans', 'Segoe UI', system-ui, sans-serif",
      background: "var(--bg)", color: "var(--text)", minHeight: "100vh",
    }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />

      {/* HEADER */}
      <div style={{ padding: "20px 28px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, background: "linear-gradient(180deg, rgba(99,102,241,0.04) 0%, transparent 100%)" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}><span style={{ color: "var(--accent)" }}>₹</span> SpendScope</h1>
          <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--muted)" }}>PhonePe Statement Analyzer</p>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          {hasData && <span style={{ fontSize: 11, color: "var(--muted)", fontFamily: "'JetBrains Mono'" }}>{txns.length} txns · {dateRange?.min.toLocaleDateString("en-IN", { month: "short", day: "numeric" })} – {dateRange?.max.toLocaleDateString("en-IN", { month: "short", day: "numeric", year: "numeric" })}</span>}
          <button onClick={() => fileRef.current?.click()} style={{ background: "var(--accent)", color: "#fff", border: "none", padding: "10px 20px", borderRadius: 10, cursor: "pointer", fontSize: 13, fontWeight: 600, boxShadow: "0 0 20px rgba(99,102,241,0.25)" }}>
            {hasData ? "Upload Another" : "Upload PDF"}
          </button>
          <input ref={fileRef} type="file" accept=".pdf" onChange={handleFile} style={{ display: "none" }} />
        </div>
      </div>

      {loading && (
        <div style={{ textAlign: "center", padding: 60 }}>
          <div style={{ width: 40, height: 40, border: "3px solid var(--border)", borderTopColor: "var(--accent)", borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 16px" }} />
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          <p style={{ color: "var(--muted)", fontSize: 14 }}>Parsing your statement...</p>
        </div>
      )}

      {error && (
        <div style={{ margin: 24, padding: 16, background: "rgba(244,63,94,0.1)", borderRadius: 12, border: "1px solid rgba(244,63,94,0.2)" }}>
          <p style={{ color: "var(--accent2)", margin: 0, fontSize: 14 }}>{error}</p>
          {debugInfo && <pre style={{ color: "var(--muted)", fontSize: 11, marginTop: 12, whiteSpace: "pre-wrap", maxHeight: 300, overflow: "auto" }}>{debugInfo}</pre>}
        </div>
      )}

      {/* EMPTY STATE */}
      {!hasData && !loading && !error && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "80px 28px", textAlign: "center" }}>
          <div style={{ width: 96, height: 96, borderRadius: 24, background: "var(--surface)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 42, marginBottom: 24, border: "1px solid var(--border)" }}>📄</div>
          <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>Upload your PhonePe Statement</h2>
          <p style={{ color: "var(--muted)", fontSize: 14, maxWidth: 400, lineHeight: 1.6, margin: "0 0 24px" }}>Download your statement from PhonePe app (any date range) and upload the PDF.</p>
          <button onClick={() => fileRef.current?.click()} style={{ background: "var(--accent)", color: "#fff", border: "none", padding: "14px 32px", borderRadius: 12, cursor: "pointer", fontSize: 15, fontWeight: 600, boxShadow: "0 0 30px rgba(99,102,241,0.3)" }}>Choose PDF File</button>
          <div style={{ marginTop: 40, display: "flex", gap: 16, flexWrap: "wrap", justifyContent: "center" }}>
            {["Category Breakdown", "Daily Trends", "Top Merchants", "Transaction Log"].map(f => (
              <div key={f} style={{ padding: "10px 16px", background: "var(--surface)", borderRadius: 10, fontSize: 12, color: "var(--muted)", border: "1px solid var(--border)" }}>{f}</div>
            ))}
          </div>
        </div>
      )}

      {/* DASHBOARD */}
      {hasData && !loading && (
        <div style={{ padding: "20px 28px", maxWidth: 1200, margin: "0 auto" }}>
          <div style={{ display: "flex", gap: 4, marginBottom: 20, background: "var(--surface)", borderRadius: 12, padding: 4, width: "fit-content" }}>
            {["overview", "transactions", "trends"].map(t => (
              <button key={t} onClick={() => setTab(t)} style={{ padding: "8px 18px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 500, textTransform: "capitalize", background: tab === t ? "var(--accent)" : "transparent", color: tab === t ? "#fff" : "var(--muted)" }}>{t}</button>
            ))}
          </div>

          {tab === "overview" && (<>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 24 }}>
              <StatCard label="TOTAL SPENT" value={fmt(totalSpent)} icon="↑" color="#f43f5e" sub={`${debits.length} debits`} />
              <StatCard label="TOTAL RECEIVED" value={fmt(totalReceived)} icon="↓" color="#10b981" sub={`${credits.length} credits`} />
              <StatCard label="NET FLOW" value={fmt(totalReceived - totalSpent)} color={totalReceived - totalSpent >= 0 ? "#10b981" : "#f43f5e"} sub={totalReceived - totalSpent >= 0 ? "Surplus" : "Deficit"} />
              <StatCard label="AVG / DAY" value={fmt(avgDaily)} icon="◷" color="#f59e0b" sub={topTxn ? `Biggest: ${fmt(topTxn.amount)}` : ""} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 18 }}>
              <div style={{ background: "var(--card)", borderRadius: 16, padding: 22, border: "1px solid var(--border)" }}>
                <h3 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 14px" }}>Spending by Category</h3>
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <ResponsiveContainer width="48%" height={200}>
                    <PieChart><Pie data={categoryData} dataKey="value" cx="50%" cy="50%" innerRadius={45} outerRadius={85} strokeWidth={2} stroke="var(--bg)">{categoryData.map((d, i) => <Cell key={i} fill={d.color} />)}</Pie><Tooltip contentStyle={ttStyle} formatter={v => fmt(v)} /></PieChart>
                  </ResponsiveContainer>
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 5 }}>
                    {categoryData.slice(0, 7).map(d => (
                      <div key={d.name} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
                        <div style={{ width: 8, height: 8, borderRadius: 2, background: d.color, flexShrink: 0 }} />
                        <span style={{ color: "var(--muted)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</span>
                        <span style={{ fontWeight: 600, fontFamily: "'JetBrains Mono'", fontSize: 10 }}>{d.pct.toFixed(0)}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div style={{ background: "var(--card)", borderRadius: 16, padding: 22, border: "1px solid var(--border)", maxHeight: 310, overflowY: "auto" }}>
                <h3 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 14px" }}>Category Breakdown</h3>
                <CategoryBars data={categoryData} />
              </div>
              <div style={{ background: "var(--card)", borderRadius: 16, padding: 22, border: "1px solid var(--border)", gridColumn: "1 / -1" }}>
                <h3 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 14px" }}>Daily Spending</h3>
                <ResponsiveContainer width="100%" height={240}>
                  <AreaChart data={dailyData}>
                    <defs><linearGradient id="gS" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} /><stop offset="95%" stopColor="#6366f1" stopOpacity={0} /></linearGradient></defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--muted)" }} tickFormatter={v => { const d = new Date(v); return `${d.getDate()}/${d.getMonth()+1}`; }} />
                    <YAxis tick={{ fontSize: 10, fill: "var(--muted)" }} tickFormatter={v => `₹${(v/1000).toFixed(0)}k`} />
                    <Tooltip contentStyle={ttStyle} formatter={v => fmt(v)} />
                    <Area type="monotone" dataKey="spent" stroke="#6366f1" fill="url(#gS)" strokeWidth={2} name="Spent" />
                    <Area type="monotone" dataKey="received" stroke="#10b981" fill="none" strokeWidth={2} strokeDasharray="5 5" name="Received" />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <div style={{ background: "var(--card)", borderRadius: 16, padding: 22, border: "1px solid var(--border)" }}>
                <h3 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 14px" }}>Top Merchants</h3>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {topMerchants.map((m, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderBottom: "1px solid var(--border)" }}>
                      <span style={{ width: 22, height: 22, borderRadius: 5, background: PALETTE[i % PALETTE.length] + "20", color: PALETTE[i % PALETTE.length], display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, flexShrink: 0 }}>{i + 1}</span>
                      <span style={{ flex: 1, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span>
                      <span style={{ fontSize: 11, color: "var(--muted)", marginRight: 6 }}>{m.count}x</span>
                      <span style={{ fontSize: 12, fontWeight: 600, fontFamily: "'JetBrains Mono'" }}>{fmt(m.total)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ background: "var(--card)", borderRadius: 16, padding: 22, border: "1px solid var(--border)" }}>
                <h3 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 14px" }}>Weekly Spending</h3>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={weeklyData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="week" tick={{ fontSize: 10, fill: "var(--muted)" }} />
                    <YAxis tick={{ fontSize: 10, fill: "var(--muted)" }} tickFormatter={v => `₹${(v/1000).toFixed(0)}k`} />
                    <Tooltip contentStyle={ttStyle} formatter={v => fmt(v)} />
                    <Bar dataKey="spent" fill="#6366f1" radius={[6, 6, 0, 0]} name="Spent" />
                    <Bar dataKey="received" fill="#10b981" radius={[6, 6, 0, 0]} name="Received" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </>)}

          {tab === "transactions" && (
            <div>
              <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
                <input placeholder="Search..." value={searchQ} onChange={e => setSearchQ(e.target.value)} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "9px 14px", color: "var(--text)", fontSize: 13, width: 200, outline: "none" }} />
                <select value={catFilter} onChange={e => setCatFilter(e.target.value)} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "9px 12px", color: "var(--text)", fontSize: 13, outline: "none" }}>
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "9px 12px", color: "var(--text)", fontSize: 13, outline: "none" }}>
                  <option value="All">All Types</option><option value="DEBIT">Debits</option><option value="CREDIT">Credits</option>
                </select>
                <span style={{ fontSize: 12, color: "var(--muted)" }}>{filteredTxns.length} results</span>
              </div>
              <div style={{ background: "var(--card)", borderRadius: 16, border: "1px solid var(--border)", overflow: "hidden" }}>
                <div style={{ display: "grid", gridTemplateColumns: "90px 1fr 120px 60px 95px", padding: "10px 16px", background: "var(--surface)", fontSize: 10, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5 }}>
                  <span>Date</span><span>Details</span><span>Category</span><span>Type</span><span style={{ textAlign: "right" }}>Amount</span>
                </div>
                <div style={{ maxHeight: 500, overflowY: "auto" }}>
                  {filteredTxns.map((t, i) => (
                    <div key={i} style={{ display: "grid", gridTemplateColumns: "90px 1fr 120px 60px 95px", padding: "10px 16px", borderTop: "1px solid var(--border)", fontSize: 12, alignItems: "center" }}>
                      <span style={{ color: "var(--muted)", fontSize: 11, fontFamily: "'JetBrains Mono'" }}>{t.dateObj.toLocaleDateString("en-IN", { month: "short", day: "numeric" })}{t.time && <><br/><span style={{ fontSize: 9 }}>{t.time}</span></>}</span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingRight: 8 }}>{t.detail}</span>
                      <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 5, background: (CAT_COLORS[t.category] || "#94a3b8") + "18", color: CAT_COLORS[t.category] || "#94a3b8", width: "fit-content", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 110 }}>{t.category}</span>
                      <span style={{ fontSize: 10, fontWeight: 600, color: t.type === "CREDIT" ? "var(--green)" : "var(--accent2)" }}>{t.type}</span>
                      <span style={{ textAlign: "right", fontWeight: 600, fontFamily: "'JetBrains Mono'", fontSize: 12, color: t.type === "CREDIT" ? "var(--green)" : "var(--text)" }}>{t.type === "CREDIT" ? "+" : "-"}{fmt(t.amount)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {tab === "trends" && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 18 }}>
              <div style={{ background: "var(--card)", borderRadius: 16, padding: 22, border: "1px solid var(--border)", gridColumn: "1 / -1" }}>
                <h3 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 14px" }}>Cumulative Spending</h3>
                <ResponsiveContainer width="100%" height={260}>
                  <AreaChart data={(() => { let c = 0; return dailyData.map(d => { c += d.spent; return { ...d, cumulative: c }; }); })()}>
                    <defs><linearGradient id="gC" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#f43f5e" stopOpacity={0.2} /><stop offset="95%" stopColor="#f43f5e" stopOpacity={0} /></linearGradient></defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--muted)" }} tickFormatter={v => { const d = new Date(v); return `${d.getDate()}/${d.getMonth()+1}`; }} />
                    <YAxis tick={{ fontSize: 10, fill: "var(--muted)" }} tickFormatter={v => `₹${(v/1000).toFixed(0)}k`} />
                    <Tooltip contentStyle={ttStyle} formatter={v => fmt(v)} />
                    <Area type="monotone" dataKey="cumulative" stroke="#f43f5e" fill="url(#gC)" strokeWidth={2.5} name="Total Spent" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <div style={{ background: "var(--card)", borderRadius: 16, padding: 22, border: "1px solid var(--border)" }}>
                <h3 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 14px" }}>By Day of Week</h3>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={(() => { const d = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(x => ({ day: x, amount: 0 })); debits.forEach(t => d[t.dateObj.getDay()].amount += t.amount); return d; })()}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" /><XAxis dataKey="day" tick={{ fontSize: 10, fill: "var(--muted)" }} /><YAxis tick={{ fontSize: 10, fill: "var(--muted)" }} tickFormatter={v => `₹${(v/1000).toFixed(0)}k`} /><Tooltip contentStyle={ttStyle} formatter={v => fmt(v)} /><Bar dataKey="amount" fill="#8b5cf6" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div style={{ background: "var(--card)", borderRadius: 16, padding: 22, border: "1px solid var(--border)" }}>
                <h3 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 14px" }}>By Time of Day</h3>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={(() => { const s = [{slot:"Morning",amount:0},{slot:"Afternoon",amount:0},{slot:"Evening",amount:0},{slot:"Night",amount:0}]; debits.forEach(t => { const h=t.dateObj.getHours(); if(h>=6&&h<12)s[0].amount+=t.amount; else if(h>=12&&h<17)s[1].amount+=t.amount; else if(h>=17&&h<21)s[2].amount+=t.amount; else s[3].amount+=t.amount; }); return s; })()}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" /><XAxis dataKey="slot" tick={{ fontSize: 10, fill: "var(--muted)" }} /><YAxis tick={{ fontSize: 10, fill: "var(--muted)" }} tickFormatter={v => `₹${(v/1000).toFixed(0)}k`} /><Tooltip contentStyle={ttStyle} formatter={v => fmt(v)} /><Bar dataKey="amount" fill="#14b8a6" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div style={{ background: "var(--card)", borderRadius: 16, padding: 22, border: "1px solid var(--border)", gridColumn: "1 / -1" }}>
                <h3 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 14px" }}>Quick Insights</h3>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
                  {[
                    { icon: "🔥", title: "Biggest Spend Day", value: dailyData.length ? (() => { const d = dailyData.reduce((a, b) => a.spent > b.spent ? a : b); return `${d.date} — ${fmt(d.spent)}`; })() : "—" },
                    { icon: "💰", title: "Biggest Transaction", value: topTxn ? `${topTxn.detail.substring(0, 20)}… — ${fmt(topTxn.amount)}` : "—" },
                    { icon: "📊", title: "Top Category", value: categoryData[0] ? `${categoryData[0].name} (${categoryData[0].count} txns)` : "—" },
                    { icon: "🏪", title: "Most Visited", value: topMerchants[0] ? `${topMerchants[0].name.substring(0, 20)} (${topMerchants[0].count}x)` : "—" },
                    { icon: "📈", title: "Investments", value: fmt(debits.filter(t => t.category === "Investments").reduce((s, t) => s + t.amount, 0)) },
                    { icon: "🍔", title: "Food & Dining", value: fmt(debits.filter(t => t.category === "Food & Dining").reduce((s, t) => s + t.amount, 0)) },
                  ].map((ins, i) => (
                    <div key={i} style={{ padding: "14px 16px", background: "var(--surface)", borderRadius: 10, border: "1px solid var(--border)" }}>
                      <div style={{ fontSize: 18, marginBottom: 4 }}>{ins.icon}</div>
                      <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 3, fontWeight: 500 }}>{ins.title}</div>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{ins.value}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
