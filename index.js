import express from "express";
import * as actualApi from "@actual-app/api";
import { readFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env
const envPath = join(__dirname, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const [key, ...rest] = trimmed.split("=");
      if (key && rest.length) process.env[key.trim()] = rest.join("=").trim();
    }
  }
}

const {
  ACTUAL_SERVER_URL = "http://localhost:5006",
  ACTUAL_PASSWORD = "",
  ACTUAL_SYNC_ID = "",
  ACTUAL_ENCRYPTION_PASSWORD,
  PORT = "3100",
} = process.env;

let initialized = false;

async function ensureConnected() {
  if (!initialized) {
    const dataDir = "/tmp/actual-widget-api-data";
    mkdirSync(dataDir, { recursive: true });
    await actualApi.init({ serverURL: ACTUAL_SERVER_URL, password: ACTUAL_PASSWORD, dataDir });
    await actualApi.downloadBudget(ACTUAL_SYNC_ID, {
      password: ACTUAL_ENCRYPTION_PASSWORD || undefined,
    });
    initialized = true;
    console.log("Connected to Actual Budget");
    return; // downloadBudget already syncs
  }
  try { await actualApi.sync(); } catch (e) { console.log("Sync skipped:", e.message); }
}

function getCurrentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

const { API_TOKEN = "" } = process.env;

const app = express();
app.use(express.json());

// Bearer token auth middleware
function requireToken(req, res, next) {
  if (!API_TOKEN) return next(); // no token configured = open access
  const auth = req.headers.authorization;
  if (auth === `Bearer ${API_TOKEN}`) return next();
  res.status(401).json({ error: "Unauthorized" });
}

// GET /api/budget — returns all categories with budgeted/spent/balance for current month
app.get("/api/budget", async (_req, res) => {
  try {
    await ensureConnected();
    const month = _req.query.month || getCurrentMonth();
    const budget = await actualApi.getBudgetMonth(month);
    const categories = await actualApi.getCategories();

    const catMeta = {};
    for (const c of categories) catMeta[c.id] = c;

    const result = [];
    for (const group of budget.categoryGroups) {
      for (const cat of group.categories) {
        const meta = catMeta[cat.id];
        if (meta?.is_income) continue;

        const budgeted = (cat.budgeted || 0) / 100;
        const spent = Math.abs(cat.spent || 0) / 100;
        const balance = (cat.balance || 0) / 100;

        // Skip categories with no budget and no spending
        if (budgeted === 0 && spent === 0) continue;

        result.push({
          id: cat.id,
          name: cat.name,
          group: group.name,
          budgeted,
          spent,
          balance,
        });
      }
    }

    // Sort by spent descending (most active categories first)
    result.sort((a, b) => b.spent - a.spent);

    res.json({
      month,
      categories: result,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/budget/summary — lightweight summary for widget
app.get("/api/budget/summary", async (_req, res) => {
  try {
    await ensureConnected();
    const month = _req.query.month || getCurrentMonth();
    const budget = await actualApi.getBudgetMonth(month);
    const categories = await actualApi.getCategories();

    const catMeta = {};
    for (const c of categories) catMeta[c.id] = c;

    let totalBudgeted = 0;
    let totalSpent = 0;

    const cats = [];
    for (const group of budget.categoryGroups) {
      for (const cat of group.categories) {
        const meta = catMeta[cat.id];
        if (meta?.is_income) continue;

        const budgeted = (cat.budgeted || 0) / 100;
        const spent = Math.abs(cat.spent || 0) / 100;
        const balance = (cat.balance || 0) / 100;

        totalBudgeted += budgeted;
        totalSpent += spent;

        if (budgeted === 0 && spent === 0) continue;

        cats.push({ id: cat.id, name: cat.name, group: group.name, budgeted, spent, balance });
      }
    }

    cats.sort((a, b) => b.spent - a.spent);

    res.json({
      month,
      totalBudgeted: Math.round(totalBudgeted * 100) / 100,
      totalSpent: Math.round(totalSpent * 100) / 100,
      totalRemaining: Math.round((totalBudgeted - totalSpent) * 100) / 100,
      categoryCount: cats.length,
      categories: cats,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/age-of-money — YNAB-style age of money calculation
// Uses pre-window balance carry-forward to avoid age collapse when large
// inflows roll out of the lookback window.
app.get("/api/age-of-money", async (_req, res) => {
  try {
    await ensureConnected();
    const lookbackDays = parseInt(_req.query.days) || 90;

    const accounts = await actualApi.getAccounts();
    const endDate = new Date().toISOString().split("T")[0];
    const windowStart = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
    const startDate = windowStart.toISOString().split("T")[0];

    // Fetch all transactions (pre-window + window) to carry forward old money
    let preWindowBalance = 0;
    const inflows = [];
    const outflows = [];

    for (const account of accounts) {
      if (account.closed) continue;
      const txs = await actualApi.getTransactions(account.id, "2000-01-01", endDate);
      for (const tx of txs) {
        if (tx.transfer_id) continue;
        const amount = tx.amount || 0;
        if (tx.date < startDate) {
          // Accumulate pre-window net balance
          preWindowBalance += amount;
        } else {
          const date = new Date(tx.date);
          if (amount > 0) {
            inflows.push({ date, amount, remaining: amount });
          } else if (amount < 0) {
            outflows.push({ date, amount: Math.abs(amount) });
          }
        }
      }
    }

    // Inject synthetic inflow at window start for money that predates the window
    if (preWindowBalance > 0) {
      inflows.push({ date: windowStart, amount: preWindowBalance, remaining: preWindowBalance });
    }

    inflows.sort((a, b) => a.date.getTime() - b.date.getTime());
    outflows.sort((a, b) => a.date.getTime() - b.date.getTime());

    if (inflows.length === 0 || outflows.length === 0) {
      return res.json({ averageAge: 0, recentAge: 0, updatedAt: new Date().toISOString() });
    }

    // FIFO matching: for each outflow, consume from oldest inflows
    const ages = [];
    let inflowIndex = 0;

    for (const outflow of outflows) {
      let amountToMatch = outflow.amount;

      while (amountToMatch > 0 && inflowIndex < inflows.length) {
        const inflow = inflows[inflowIndex];
        if (inflow.remaining <= 0) { inflowIndex++; continue; }

        const matchAmount = Math.min(amountToMatch, inflow.remaining);
        const ageDays = Math.floor((outflow.date.getTime() - inflow.date.getTime()) / (1000 * 60 * 60 * 24));

        if (ageDays >= 0) {
          for (let i = 0; i < Math.ceil(matchAmount / 100); i++) {
            ages.push(ageDays);
          }
        }

        inflow.remaining -= matchAmount;
        amountToMatch -= matchAmount;
        if (inflow.remaining <= 0) inflowIndex++;
      }
    }

    const averageAge = ages.length > 0
      ? Math.round(ages.reduce((sum, a) => sum + a, 0) / ages.length)
      : 0;

    const recentAges = ages.slice(-100);
    const recentAge = recentAges.length > 0
      ? Math.round(recentAges.reduce((sum, a) => sum + a, 0) / recentAges.length)
      : 0;

    res.json({
      averageAge,
      recentAge,
      lookbackDays,
      inflowCount: inflows.length,
      outflowCount: outflows.length,
      preWindowBalance: preWindowBalance / 100,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/payees — list all payees
app.get("/api/payees", requireToken, async (_req, res) => {
  try {
    await ensureConnected();
    const payees = await actualApi.getPayees();
    const result = payees.map((p) => ({
      id: p.id,
      name: p.name,
      transfer_acct: p.transfer_acct || null,
    }));
    res.json({ payees: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/accounts — list non-closed accounts
app.get("/api/accounts", requireToken, async (_req, res) => {
  try {
    await ensureConnected();
    const accounts = await actualApi.getAccounts();
    const result = accounts
      .filter((a) => !a.closed)
      .map((a) => ({ id: a.id, name: a.name }));
    res.json({ accounts: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/categories — list non-income categories grouped
app.get("/api/categories", requireToken, async (_req, res) => {
  try {
    await ensureConnected();
    const categories = await actualApi.getCategories();
    const groups = await actualApi.getCategoryGroups();

    const groupMap = {};
    for (const g of groups) groupMap[g.id] = g.name;

    const result = categories
      .filter((c) => !c.is_income && !c.hidden)
      .map((c) => ({ id: c.id, name: c.name, group: groupMap[c.group_id] || "" }));
    res.json({ categories: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/transactions — add a transaction
app.post("/api/transactions", requireToken, async (req, res) => {
  try {
    await ensureConnected();
    const { accountId, date, amount, payee, categoryId, notes } = req.body;

    if (!accountId || !date || amount === undefined || !payee) {
      return res.status(400).json({ error: "accountId, date, amount, and payee are required" });
    }

    const amountCents = Math.round(amount * 100);

    const tx = {
      account: accountId,
      date,
      amount: amountCents,
      payee_name: payee,
      notes: notes || undefined,
      category: categoryId || undefined,
    };

    const id = await actualApi.addTransactions(accountId, [tx]);
    await actualApi.sync();

    res.json({ ok: true, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(Number(PORT), () => {
  console.log(`Actual Widget API running on port ${PORT}`);
});
