const express = require('express');
const twilio = require('twilio');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const readline = require('readline');
const { execSync, exec, spawn } = require('child_process');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─── CONFIG (self-updating) ───────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    try { return JSON.parse(fs.readFileSync(CONFIG_PATH)); } catch(e) {}
  }
  const defaults = {
    twilio: {
      accountSid: process.env.TWILIO_ACCOUNT_SID || '',
      authToken: process.env.TWILIO_AUTH_TOKEN || '',
      sandboxNumber: process.env.TWILIO_SANDBOX_NUMBER || 'whatsapp:+14155238886',
    },
    claude: {
      apiKey: process.env.ANTHROPIC_API_KEY || '',
    },
    notion: { apiKey: process.env.NOTION_API_KEY || '' },
    ghl: { apiKey: process.env.GHL_API_KEY || '', locationId: process.env.GHL_LOCATION_ID || '', calendarId: process.env.GHL_CALENDAR_ID || '' },
    fathom: { apiKey: process.env.FATHOM_API_KEY || '' },
    frameio: { apiKey: '', clientId: process.env.FRAMEIO_CLIENT_ID || '', clientSecret: process.env.FRAMEIO_CLIENT_SECRET || '', redirect: process.env.FRAMEIO_REDIRECT || '' },
    owner: {
      name: 'Jackson',
      whatsapp: process.env.OWNER_WHATSAPP || 'whatsapp:+61478105927',
      agency: 'JT Visuals',
      timezone: 'Australia/Brisbane',
    },
    schedule: {
      briefingHour: 5,
      briefingMinute: 0,
      middayHour: 12,
      middayMinute: 0,
      eodHour: 18,
      eodMinute: 0,
      weeklyReviewHour: 17,
      weeklyReviewMinute: 0,
    }
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2));
  return defaults;
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

let CONFIG = loadConfig();

// ─── MODEL TIERS ──────────────────────────────────────────────────────────────
const MODEL_HIGH = 'claude-opus-4-6';              // main agent loop — complex reasoning
const MODEL_MID  = 'claude-sonnet-4-6';            // briefings, email drafts, call analysis
const MODEL_LOW  = 'claude-haiku-4-5-20251001';    // content gen, short messages, simple tasks

// ─── SELF-UPDATE SYSTEM ───────────────────────────────────────────────────────
function updateConfig(key, value) {
  const keys = key.split('.');
  let obj = CONFIG;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!obj[keys[i]]) obj[keys[i]] = {};
    obj = obj[keys[i]];
  }
  obj[keys[keys.length - 1]] = value;
  saveConfig(CONFIG);
  return `Config updated: ${key} = ${value}`;
}

function restartServer() {
  console.log('Restarting server...');
  setTimeout(() => {
    const child = spawn('npm', ['start'], { cwd: __dirname, detached: true, stdio: 'ignore' });
    child.unref();
    process.exit(0);
  }, 2000);
}

// ─── WHATSAPP DB READER ───────────────────────────────────────────────────────
const WA_DB = path.join(process.env.HOME, 'Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite');

function queryWhatsApp(sql) {
  try {
    const result = execSync(`sqlite3 "${WA_DB}" "${sql}" 2>/dev/null`, { encoding: 'utf8' });
    return result.trim();
  } catch(e) { return ''; }
}

function getMyRecentMessages(limit = 100) {
  const sql = `SELECT ZPUSHNAME, ZTEXT, ZMESSAGEDATE FROM ZWAMESSAGE WHERE ZISFROMME=1 AND ZTEXT IS NOT NULL AND ZTEXT != '' ORDER BY ZMESSAGEDATE DESC LIMIT ${limit};`;
  const raw = queryWhatsApp(sql);
  if (!raw) return 'No messages found.';
  return raw.split('\n').slice(0, 50).map(line => {
    const parts = line.split('|');
    return `[To: ${parts[0] || 'Unknown'}]: ${parts[1] || ''}`;
  }).join('\n');
}

function getRecentInboundMessages(hours = 24) {
  const cutoff = (Date.now() / 1000) - (hours * 3600) - 978307200;
  const sql = `SELECT COALESCE(s.ZPARTNERNAME, m.ZPUSHNAME, 'Unknown') as name, m.ZTEXT FROM ZWAMESSAGE m LEFT JOIN ZWACHATSESSION s ON m.ZCHATSESSION = s.Z_PK WHERE m.ZISFROMME=0 AND m.ZTEXT IS NOT NULL AND m.ZTEXT != '' AND m.ZMESSAGEDATE > ${cutoff} ORDER BY m.ZMESSAGEDATE DESC LIMIT 20;`;
  const raw = queryWhatsApp(sql);
  if (!raw) return 'No recent inbound messages.';
  return raw.split('\n').map(line => {
    const parts = line.split('|');
    return `• ${parts[0]}: "${(parts[1] || '').substring(0, 100)}"`;
  }).join('\n');
}

function getUnansweredMessages() {
  const sql = `SELECT DISTINCT COALESCE(NULLIF(s.ZPARTNERNAME,''), 'Unknown') as name FROM ZWAMESSAGE m LEFT JOIN ZWACHATSESSION s ON m.ZCHATSESSION = s.Z_PK WHERE m.ZISFROMME=0 AND m.ZTEXT IS NOT NULL AND m.ZTEXT != '' AND m.ZMESSAGEDATE = (SELECT MAX(ZMESSAGEDATE) FROM ZWAMESSAGE m2 WHERE m2.ZCHATSESSION=m.ZCHATSESSION) AND s.ZPARTNERNAME IS NOT NULL AND s.ZPARTNERNAME != '' AND s.ZPARTNERNAME NOT LIKE '%==%' AND s.ZPARTNERNAME NOT LIKE '%Noosa%' AND s.ZPARTNERNAME NOT LIKE '%Townsville%' AND s.ZPARTNERNAME NOT LIKE '%SAAD%' ORDER BY m.ZMESSAGEDATE DESC LIMIT 15;`;
  const raw = queryWhatsApp(sql);
  if (!raw) return 'No unanswered messages.';
  const names = raw.split('\n')
    .map(line => line.trim())
    .filter(name => name && name !== 'Unknown' && !name.includes('IAA=') && !name.includes('=='))
    .filter((name, index, self) => self.indexOf(name) === index);
  if (!names.length) return 'No unanswered messages.';
  return names.map(n => `• ${n}`).join('\n');
}

function getJacksonWritingStyle() {
  const stylePath = path.join(__dirname, 'writing-style.json');
  if (fs.existsSync(stylePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(stylePath));
      return data.profile || '';
    } catch(e) {}
  }
  // Fallback to live messages if profile not built yet
  const sql = `SELECT ZTEXT FROM ZWAMESSAGE WHERE ZISFROMME=1 AND ZTEXT IS NOT NULL AND LENGTH(ZTEXT) > 10 ORDER BY ZMESSAGEDATE DESC LIMIT 50;`;
  const raw = queryWhatsApp(sql);
  if (!raw) return '';
  return raw.split('\n').slice(0, 30).join('\n');
}

// ─── JT VISUALS ACTIVE CLIENTS ────────────────────────────────────────────────
const JT_BUSINESS_CLIENTS = [
  { name: 'Alpha Physiques', niche: 'fitness coaching', package: '24 videos/month + in-app education', value: '$4,000/month' },
  { name: 'Hattie (Flex Method)', niche: 'fitness coaching', package: '20 videos/month + YouTube + weekly podcast', value: '$4,000/month' },
  { name: 'Cade', niche: 'fitness coaching', package: '28 videos/month + YouTube', value: '$4,200/month' },
  { name: 'Jese Smith', niche: 'fitness coaching', package: '2x YouTube + 15x short form/month + scripting', value: '$5,000/month' },
  { name: 'Sarah', niche: 'fitness coaching', package: '24x short form/month + website & in-app education', value: '$4,000/month' },
  { name: 'Raw Reality', niche: 'podcast', package: '2x podcast + 8x short form per week', value: '$550/week' },
  { name: 'Jess Richards', niche: 'podcast/content', package: '1x podcast/week + 1x reel', value: '$1,000/month' },
  { name: 'CoreCoach', niche: 'fitness app', package: '24x short form/month', value: '$3,900/month' },
  { name: 'Morgan', niche: 'podcast', package: '1x podcast/week', value: '$350/week' },
  { name: 'Kingbodies', niche: 'fitness coaching', package: '15 short form videos/month', value: '$2,700/month' },
  { name: 'Harry Drew', niche: 'fitness coaching', package: '10 short form videos/month', value: '$1,900/month' },
  { name: 'Pantry Girl', niche: 'organisation and cleaning service', package: '10 short form videos/month', value: '$2,200/month' },
];

// ─── WIN TRACKER ──────────────────────────────────────────────────────────────
const WINS_PATH = path.join(__dirname, 'wins.json');

function loadWins() {
  if (fs.existsSync(WINS_PATH)) {
    try { return JSON.parse(fs.readFileSync(WINS_PATH)); } catch(e) { return []; }
  }
  return [];
}

function saveWin(clientName, packageDetails, value, notes = '') {
  const wins = loadWins();
  const win = { id: Date.now(), date: new Date().toISOString(), client: clientName, package: packageDetails, value, notes };
  wins.unshift(win);
  fs.writeFileSync(WINS_PATH, JSON.stringify(wins, null, 2));
  return win;
}

function getWinsSummary() {
  const wins = loadWins();
  if (!wins.length) return 'No wins logged yet Boss. Say "log win: [client], [package], [value]" to start tracking.';
  const thisMonth = wins.filter(w => {
    const d = new Date(w.date); const now = new Date();
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });
  const thisYear = wins.filter(w => new Date(w.date).getFullYear() === new Date().getFullYear());
  const totalValue = wins.reduce((sum, w) => {
    const num = parseFloat((w.value || '0').replace(/[$,]/g, '').replace(/[^0-9.]/g, ''));
    return sum + (isNaN(num) ? 0 : num);
  }, 0);
  const lines = [
    `Win Tracker — ${wins.length} total clients signed`,
    `This month: ${thisMonth.length} | This year: ${thisYear.length}`,
    `All-time monthly value: $${totalValue.toLocaleString()}`,
    ``,
    `Recent wins:`
  ];
  wins.slice(0, 10).forEach(w => {
    const d = new Date(w.date).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
    lines.push(`• ${d} — ${w.client} — ${w.package} — ${w.value}`);
  });
  return lines.join('\n');
}

// ─── CLIENT CHECK-IN TRACKER ──────────────────────────────────────────────────
const CHECKINS_PATH = path.join(__dirname, 'checkins.json');

function loadCheckIns() {
  if (fs.existsSync(CHECKINS_PATH)) {
    try { return JSON.parse(fs.readFileSync(CHECKINS_PATH)); } catch(e) { return {}; }
  }
  return {};
}

function markCheckInDone(clientName) {
  const checkins = loadCheckIns();
  const key = Object.keys(checkins).find(k => k.toLowerCase().includes(clientName.toLowerCase())) || clientName;
  checkins[key] = { lastCheckin: new Date().toISOString(), clientName: key };
  fs.writeFileSync(CHECKINS_PATH, JSON.stringify(checkins, null, 2));
  return `Check-in logged for ${key}`;
}

function getClientsNeedingCheckin() {
  const checkins = loadCheckIns();
  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
  const overdue = [];
  JT_BUSINESS_CLIENTS.forEach(c => {
    const record = Object.values(checkins).find(r => r.clientName && r.clientName.toLowerCase().includes(c.name.toLowerCase()));
    if (!record || !record.lastCheckin || new Date(record.lastCheckin).getTime() < thirtyDaysAgo) {
      const daysSince = record && record.lastCheckin
        ? Math.floor((Date.now() - new Date(record.lastCheckin).getTime()) / (1000 * 60 * 60 * 24))
        : null;
      overdue.push({ name: c.name, daysSince, value: c.value });
    }
  });
  return overdue;
}

// ─── SHOOT TRACKER ────────────────────────────────────────────────────────────
async function getTodayShootBriefing() {
  const auth = getGoogleAuth();
  let shootToday = null;

  if (auth) {
    try {
      const calendar = google.calendar({ version: 'v3', auth });
      const now = new Date();
      const end = new Date(); end.setHours(23, 59, 59);
      const res = await calendar.events.list({
        calendarId: 'primary', timeMin: now.toISOString(), timeMax: end.toISOString(),
        singleEvents: true, orderBy: 'startTime',
      });
      const events = res.data.items || [];
      shootToday = events.find(e =>
        e.summary && (e.summary.toLowerCase().includes('shoot') || e.summary.toLowerCase().includes('film') || e.summary.toLowerCase().includes('record'))
      );
    } catch(e) {}
  }

  if (!shootToday) return null;

  const clientMatch = JT_BUSINESS_CLIENTS.find(c =>
    shootToday.summary.toLowerCase().includes(c.name.split(' ')[0].toLowerCase())
  );

  const startTime = shootToday.start.dateTime
    ? new Date(shootToday.start.dateTime).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', timeZone: CONFIG.owner.timezone })
    : 'All day';

  let briefing = `SHOOT DAY BRIEFING\n\n${shootToday.summary} — ${startTime}\n`;
  if (clientMatch) {
    briefing += `Client: ${clientMatch.name} (${clientMatch.niche})\nPackage: ${clientMatch.package}\nValue: ${clientMatch.value}\n`;
  }
  briefing += `\nWhat to capture:\n`;
  if (clientMatch && clientMatch.package.includes('short form')) briefing += `• Short form content (15-60 sec hooks + talking heads)\n`;
  if (clientMatch && clientMatch.package.includes('YouTube')) briefing += `• YouTube long-form footage (A-roll + B-roll)\n`;
  if (clientMatch && clientMatch.package.includes('podcast')) briefing += `• Podcast recording (multi-cam setup)\n`;
  briefing += `• B-roll cutaways\n• Thumbnail shots\n`;
  briefing += `\nPost-shoot: back up footage, brief editor, message client`;
  return briefing;
}

function getPostShootChecklist(clientName) {
  const client = JT_BUSINESS_CLIENTS.find(c => c.name.toLowerCase().includes((clientName || '').toLowerCase())) || { name: clientName || 'client', package: 'content' };
  return `Post-shoot checklist — ${client.name}

[ ] Footage backed up to hard drive
[ ] Footage uploaded to Frame.io
[ ] Editor briefed with shot list & notes
[ ] Client messaged: "Shoot done, editing starts now — first version in 48hrs"
[ ] Check if b-roll needed from client
[ ] If b-roll needed: request from client now
[ ] Shoot logged in system
[ ] Invoice raised (if once-off)

Package: ${client.package}
Delivery: 24hr internal, 48hr to client, 72hr final`;
}

// ─── EDITOR DEADLINE TRACKER ──────────────────────────────────────────────────
const DEADLINES_PATH = path.join(__dirname, 'deadlines.json');

function loadDeadlines() {
  if (fs.existsSync(DEADLINES_PATH)) {
    try { return JSON.parse(fs.readFileSync(DEADLINES_PATH)); } catch(e) { return []; }
  }
  return [];
}

function addEditorDeadline(clientName, shootDate, editorName = '') {
  const deadlines = loadDeadlines();
  const shoot = new Date(shootDate);
  const internalDeadline = new Date(shoot.getTime() + 24 * 60 * 60 * 1000);
  const clientDeadline = new Date(shoot.getTime() + 48 * 60 * 60 * 1000);
  const deadline = {
    id: Date.now(), client: clientName, editor: editorName,
    shootDate: shoot.toISOString(), internalDeadline: internalDeadline.toISOString(),
    clientDeadline: clientDeadline.toISOString(),
    internalDone: false, clientDone: false, createdAt: new Date().toISOString()
  };
  deadlines.unshift(deadline);
  fs.writeFileSync(DEADLINES_PATH, JSON.stringify(deadlines, null, 2));
  return deadline;
}

function checkUpcomingDeadlines() {
  const deadlines = loadDeadlines();
  const now = Date.now();
  const twoHours = 2 * 60 * 60 * 1000;
  const alerts = [];

  deadlines.filter(d => !d.clientDone).forEach(d => {
    const internalMs = new Date(d.internalDeadline).getTime() - now;
    const clientMs = new Date(d.clientDeadline).getTime() - now;

    if (internalMs > 0 && internalMs < twoHours && !d.internalAlerted && !d.internalDone) {
      alerts.push(`${d.client} — editor cut due in ${Math.round(internalMs/60000)} mins${d.editor ? ' (' + d.editor + ')' : ''}`);
      d.internalAlerted = true;
    }
    if (clientMs > 0 && clientMs < twoHours && !d.clientAlerted) {
      alerts.push(`${d.client} — CLIENT delivery due in ${Math.round(clientMs/60000)} mins`);
      d.clientAlerted = true;
    }
  });

  if (alerts.length) fs.writeFileSync(DEADLINES_PATH, JSON.stringify(deadlines, null, 2));
  return alerts;
}

function getActiveDeadlines() {
  const deadlines = loadDeadlines();
  const active = deadlines.filter(d => !d.clientDone).slice(0, 8);
  if (!active.length) return 'No active editor deadlines.';
  return active.map(d => {
    const internal = new Date(d.internalDeadline).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const client = new Date(d.clientDeadline).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    return `• ${d.client} — Editor: ${d.internalDone ? '✅' : '⏳'} ${internal} | Client: ${d.clientDone ? '✅' : '⏳'} ${client}`;
  }).join('\n');
}

// ─── QUOTE GENERATOR ─────────────────────────────────────────────────────────
const QUOTES_PATH = path.join(__dirname, 'quotes.json');

function loadQuotes() {
  if (fs.existsSync(QUOTES_PATH)) {
    try { return JSON.parse(fs.readFileSync(QUOTES_PATH)); } catch(e) { return []; }
  }
  return [];
}

async function generateQuoteDraft(leadName, contactDetails, videosPerMonth, contractLength, addOns = '', notes = '') {
  let basePrice = 0;
  const vids = parseInt(videosPerMonth) || 12;
  const months = parseInt(contractLength) || 3;

  if (vids <= 12) basePrice = months === 12 ? 1870 : months === 6 ? 1980 : 2200;
  else if (vids <= 16) basePrice = months === 12 ? 2448 : months === 6 ? 2592 : 2880;
  else if (vids <= 20) basePrice = months === 12 ? 2975 : months === 6 ? 3150 : 3500;
  else if (vids <= 24) basePrice = months === 12 ? 3468 : months === 6 ? 3672 : 4080;
  else basePrice = months === 12 ? 3927 : months === 6 ? 4158 : 4620;

  const discount = months === 12 ? '15% off (12-month)' : months === 6 ? '10% off (6-month)' : 'Standard (3-month)';
  const perVideo = Math.round(basePrice / vids);

  const quote = { id: Date.now(), leadName, contactDetails, videosPerMonth: vids, contractLength: months, basePrice, perVideo, discount, addOns, notes, status: 'draft', createdAt: new Date().toISOString() };
  const quotes = loadQuotes();
  quotes.unshift(quote);
  fs.writeFileSync(QUOTES_PATH, JSON.stringify(quotes, null, 2));

  return `QUOTE DRAFT — ${leadName}

Package: ${vids} videos/month
Contract: ${months} months (${discount})
Monthly: $${basePrice.toLocaleString()}/month ($${perVideo}/video)
${addOns ? 'Add-ons: ' + addOns : ''}
Total contract value: $${(basePrice * months).toLocaleString()}

Includes: VIP onboarding, Notion dashboard, monthly strategy call, unlimited revisions
Delivery: First version 48hrs, final 72hrs
${notes ? 'Notes: ' + notes : ''}

Status: DRAFT — review before sending to ${leadName}
Quote ID: ${quote.id}`;
}

function getPendingQuotes() {
  const quotes = loadQuotes();
  const pending = quotes.filter(q => q.status === 'draft').slice(0, 5);
  if (!pending.length) return 'No pending quotes.';
  return pending.map(q => `• ${q.leadName} — $${q.basePrice}/month (${q.videosPerMonth} vids, ${q.contractLength}m) — ${new Date(q.createdAt).toLocaleDateString('en-AU')}`).join('\n');
}

// ─── COLD LEAD FOLLOW-UP ──────────────────────────────────────────────────────
const COLD_LEADS_PATH = path.join(__dirname, 'cold-leads.json');

function loadColdLeads() {
  if (fs.existsSync(COLD_LEADS_PATH)) {
    try { return JSON.parse(fs.readFileSync(COLD_LEADS_PATH)); } catch(e) { return []; }
  }
  return [];
}

function addColdLead(name, contactDetails, lastContactDate, notes = '') {
  const leads = loadColdLeads();
  const lead = { id: Date.now(), name, contactDetails, lastContact: lastContactDate || new Date().toISOString(), notes, followUps: [], status: 'active', createdAt: new Date().toISOString() };
  leads.unshift(lead);
  fs.writeFileSync(COLD_LEADS_PATH, JSON.stringify(leads, null, 2));
  return `Cold lead added: ${name}. Follow-ups scheduled for day 3, 7, and 14.`;
}

async function getColdLeadFollowUps() {
  const leads = loadColdLeads().filter(l => l.status === 'active');
  const now = Date.now();
  const due = [];

  for (const lead of leads) {
    const daysSince = Math.floor((now - new Date(lead.lastContact).getTime()) / (1000 * 60 * 60 * 24));
    for (const day of [3, 7, 14]) {
      if (daysSince >= day && !lead.followUps.includes(day)) {
        due.push({ lead, daysSince, followUpDay: day });
        break;
      }
    }
  }

  if (!due.length) return null;

  const messages = [];
  for (const { lead, daysSince, followUpDay } of due) {
    const followUpNum = followUpDay === 3 ? 1 : followUpDay === 7 ? 2 : 3;
    const prompt = `Draft a short follow-up WhatsApp message from Jackson Edwards (JT Visuals) to ${lead.name}, a potential client who hasn't responded in ${daysSince} days. Follow-up #${followUpNum} of 3.
Notes: ${lead.notes || 'fitness coach or online coach'}
JT Visuals: premium videography for fitness coaches, retainers from $2,200/month.
Casual, no pressure, genuine. Under 3 sentences. Australian tone.`;

    const r = await axios.post('https://api.anthropic.com/v1/messages',
      { model: MODEL_LOW, max_tokens: 150, messages: [{ role: 'user', content: prompt }] },
      { headers: { 'x-api-key': CONFIG.claude.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });

    messages.push(`Follow-up for ${lead.name} (day ${daysSince}):\n"${r.data.content[0].text}"`);
    lead.followUps.push(followUpDay);
  }

  const allLeads = loadColdLeads();
  for (const l of allLeads) {
    const updated = due.find(d => d.lead.id === l.id);
    if (updated) l.followUps = updated.lead.followUps;
  }
  fs.writeFileSync(COLD_LEADS_PATH, JSON.stringify(allLeads, null, 2));

  return messages.join('\n\n');
}

// ─── BRIEFING LEARNING SYSTEM ─────────────────────────────────────────────────
const USAGE_PATH = path.join(__dirname, 'usage-tracking.json');

function loadUsageTracking() {
  if (fs.existsSync(USAGE_PATH)) {
    try { return JSON.parse(fs.readFileSync(USAGE_PATH)); } catch(e) { return { commands: {} }; }
  }
  return { commands: {} };
}

function trackCommand(command) {
  const usage = loadUsageTracking();
  const key = command.toLowerCase().trim().substring(0, 50);
  if (!usage.commands[key]) usage.commands[key] = { count: 0, lastUsed: null };
  usage.commands[key].count++;
  usage.commands[key].lastUsed = new Date().toISOString();
  fs.writeFileSync(USAGE_PATH, JSON.stringify(usage, null, 2));
}

function getUsageInsights() {
  const usage = loadUsageTracking();
  const commands = Object.entries(usage.commands).sort((a, b) => b[1].count - a[1].count).slice(0, 10);
  if (!commands.length) return 'No usage data yet Boss.';
  return `Most used commands Boss:\n` + commands.map(([cmd, data]) => `• "${cmd}" — ${data.count}x`).join('\n');
}

// ─── JT VISUALS PRICING KNOWLEDGE ────────────────────────────────────────────
const JT_PRICING = `
RETAINER PRICING: 12 vids=$170/ea, 16=$165, 20=$160, 24=$155, 28+=$150
3 MONTH: 12vids=$2,200/m | 16=$2,880 | 20=$3,500 | 24=$4,080 | 28=$4,620
6 MONTH (10% off): 12=$1,980 | 16=$2,592 | 20=$3,150 | 24=$3,672 | 28=$4,158
12 MONTH (15% off): 12=$1,870 | 16=$2,448 | 20=$2,975 | 24=$3,468 | 28=$3,927
SCRIPTS ADD-ON: <10 vids=$100/script | 10-20=$75 | 20+=$50
ONCE-OFF: $250/video. Travel: $100 for 20km, $1/km after.
ALL RETAINERS INCLUDE: VIP onboarding, Notion dashboard, monthly strategy call.
HOT LEAD: fitness/online coach, $2k+/month budget. WARM: $1-2k. PASS: under $1k.
ALWAYS check with Jackson before sending any quote.
`;

// ─── CLOSE RATE TRACKER ───────────────────────────────────────────────────────
const SALES_PATH = path.join(__dirname, 'sales-pipeline.json');

function loadSales() {
  if (fs.existsSync(SALES_PATH)) { try { return JSON.parse(fs.readFileSync(SALES_PATH)); } catch(e) {} }
  return { calls: [] };
}

function logSalesCall(name, outcome, value, reason, notes) {
  const data = loadSales();
  data.calls.unshift({ id: Date.now(), date: new Date().toISOString(), name, outcome, value: value || '', reason: reason || '', notes: notes || '' });
  fs.writeFileSync(SALES_PATH, JSON.stringify(data, null, 2));
  return outcome === 'closed'
    ? `Win logged Boss! ${name} closed${value ? ' at ' + value : ''}. Log it as a win too with "log win".`
    : `Loss logged. ${name} — reason: ${reason || 'not specified'}.`;
}

function getCloseRateReport() {
  const data = loadSales();
  if (!data.calls.length) return 'No sales calls logged yet Boss. Use "log close" or "log lost" to start tracking.';
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recent = data.calls.filter(c => new Date(c.date) > thirtyDaysAgo);
  const all = data.calls;
  const calcRate = (calls) => {
    const closed = calls.filter(c => c.outcome === 'closed').length;
    return calls.length ? `${Math.round(closed / calls.length * 100)}% (${closed}/${calls.length})` : 'No data';
  };
  const reasons = all.filter(c => c.outcome === 'lost' && c.reason).reduce((acc, c) => {
    acc[c.reason] = (acc[c.reason] || 0) + 1; return acc;
  }, {});
  const topReasons = Object.entries(reasons).sort((a,b) => b[1]-a[1]).slice(0,3).map(([r,n]) => `${r} (${n}x)`).join(', ');
  return `Sales pipeline Boss:\n\nLast 30 days: ${calcRate(recent)}\nAll time: ${calcRate(all)}\n\nTop loss reasons: ${topReasons || 'None logged'}\n\nRecent calls:\n${recent.slice(0,5).map(c => `• ${c.name} — ${c.outcome === 'closed' ? '✅ ' + (c.value||'closed') : '❌ ' + (c.reason||'lost')}`).join('\n')}`;
}

// ─── CLIENT RENEWAL TRACKER ───────────────────────────────────────────────────
const RENEWALS_PATH = path.join(__dirname, 'renewals.json');

function loadRenewals() {
  if (fs.existsSync(RENEWALS_PATH)) { try { return JSON.parse(fs.readFileSync(RENEWALS_PATH)); } catch(e) {} }
  return {};
}

function setRenewal(clientName, dateStr) {
  const renewals = loadRenewals();
  const client = JT_BUSINESS_CLIENTS.find(c => c.name.toLowerCase().includes(clientName.toLowerCase())) || { name: clientName };
  renewals[client.name] = { date: dateStr, clientName: client.name, setAt: new Date().toISOString() };
  fs.writeFileSync(RENEWALS_PATH, JSON.stringify(renewals, null, 2));
  return `Renewal set for ${client.name} on ${dateStr}.`;
}

function getRenewals() {
  const renewals = loadRenewals();
  const entries = Object.values(renewals);
  if (!entries.length) return 'No renewal dates set yet Boss. Use "set renewal: [client], [date]".';
  const now = Date.now();
  const sorted = entries.map(r => ({ ...r, daysUntil: Math.ceil((new Date(r.date) - now) / 86400000) }))
    .sort((a,b) => a.daysUntil - b.daysUntil);
  return 'Client renewals Boss:\n\n' + sorted.map(r => {
    const flag = r.daysUntil <= 7 ? '🔴' : r.daysUntil <= 30 ? '🟡' : '✅';
    return `${flag} ${r.clientName}: ${r.date} (${r.daysUntil > 0 ? r.daysUntil + ' days' : 'OVERDUE'})`;
  }).join('\n');
}

async function checkRenewalAlerts() {
  const renewals = loadRenewals();
  const now = Date.now();
  for (const r of Object.values(renewals)) {
    const daysUntil = Math.ceil((new Date(r.date) - now) / 86400000);
    if (daysUntil === 30) await sendToJackson(`Renewal reminder Boss: ${r.clientName} renews in 30 days (${r.date}). Time to check in and lock them in.`);
    if (daysUntil === 7) await sendToJackson(`Renewal alert Boss: ${r.clientName} renews in 7 days (${r.date}). Get this confirmed now.`);
    if (daysUntil === 1) await sendToJackson(`Renewal tomorrow Boss: ${r.clientName} is up for renewal tomorrow (${r.date}).`);
  }
}

// ─── PRE-PRODUCTION CHECKLIST ─────────────────────────────────────────────────
const PREPROD_PATH = path.join(__dirname, 'preprod-checklists.json');

function loadPreprod() {
  if (fs.existsSync(PREPROD_PATH)) { try { return JSON.parse(fs.readFileSync(PREPROD_PATH)); } catch(e) {} }
  return {};
}

function createPreprodChecklist(clientName, shootDate, notes) {
  const preprod = loadPreprod();
  const id = `${clientName}-${shootDate}`.replace(/\s+/g, '-').toLowerCase();
  const client = JT_BUSINESS_CLIENTS.find(c => c.name.toLowerCase().includes(clientName.toLowerCase())) || { name: clientName, package: 'content' };
  preprod[id] = {
    id, clientName: client.name, shootDate, notes: notes || '',
    createdAt: new Date().toISOString(),
    assetsReceived: false, briefReceived: false, locationConfirmed: false, callBooked: false
  };
  fs.writeFileSync(PREPROD_PATH, JSON.stringify(preprod, null, 2));

  const checklist = `Pre-production checklist — ${client.name} (${shootDate}):

Please send through before the shoot:
1. Key talking points or scripts for this shoot
2. Any B-roll or reference footage you want matched
3. Brand assets (logo, colours) if not already supplied
4. Location confirmation and access details
5. Any specific requests or changes from last shoot

Reply here when each is ready and we will get everything set up for a smooth shoot day.`;

  return { message: `Checklist created for ${client.name} on ${shootDate}. Send this to client:`, checklist };
}

async function checkOverduePreprod() {
  const preprod = loadPreprod();
  const now = Date.now();
  for (const item of Object.values(preprod)) {
    if (item.assetsReceived) continue;
    const shootMs = new Date(item.shootDate).getTime();
    const hoursUntil = (shootMs - now) / 3600000;
    if (hoursUntil <= 48 && hoursUntil > 0) {
      await sendToJackson(`Pre-production alert Boss: ${item.clientName} shoot is in ${Math.round(hoursUntil)}h and assets haven't been marked as received. Chase them up now.`);
    }
  }
}

// ─── LEAD NURTURE TRACKER ─────────────────────────────────────────────────────
const NURTURE_PATH = path.join(__dirname, 'lead-nurture.json');

function loadNurture() {
  if (fs.existsSync(NURTURE_PATH)) { try { return JSON.parse(fs.readFileSync(NURTURE_PATH)); } catch(e) {} }
  return [];
}

function addNurtureLead(name, contact, niche, budget, source, notes) {
  const leads = loadNurture();
  const lead = {
    id: Date.now(), name, contact: contact || '', niche: niche || '', budget: budget || '',
    source: source || '', notes: notes || '', status: 'active',
    createdAt: new Date().toISOString(), lastContact: new Date().toISOString(),
    touchpoints: [], nextFollowUp: null
  };
  leads.unshift(lead);
  fs.writeFileSync(NURTURE_PATH, JSON.stringify(leads, null, 2));

  // Schedule follow-ups at day 1, 3, 7, 14, 30
  const qualification = budget && (budget.includes('2k') || budget.includes('3k') || budget.includes('4k') || budget.includes('5k') || parseInt(budget.replace(/\D/g,'')) >= 2000) ? 'HOT' : 'WARM';
  return `Lead added Boss: ${name} (${qualification}). Follow-up sequence started — day 1, 3, 7, 14, 30.`;
}

async function checkNurtureFollowUps() {
  const leads = loadNurture().filter(l => l.status === 'active');
  const now = Date.now();
  const sequence = [1, 3, 7, 14, 30];

  for (const lead of leads) {
    const daysSince = Math.floor((now - new Date(lead.lastContact).getTime()) / 86400000);
    for (const day of sequence) {
      if (daysSince >= day && !lead.touchpoints.includes(day)) {
        const touchNum = sequence.indexOf(day) + 1;
        const prompt = `Draft a short follow-up WhatsApp/text message from Jackson Edwards (JT Visuals Gold Coast) to ${lead.name}, a potential client who hasn't responded in ${daysSince} days.
Niche: ${lead.niche || 'business owner'}. Budget: ${lead.budget || 'unknown'}. Source: ${lead.source || 'inbound'}.
Notes: ${lead.notes || 'Interested in video content retainer'}
This is follow-up #${touchNum} of 5. JT Visuals does premium video content from $2,200/month.
Casual, no pressure, value-focused. Australian tone. Under 3 sentences. Just the message, nothing else.`;
        const r = await axios.post('https://api.anthropic.com/v1/messages',
          { model: MODEL_LOW, max_tokens: 150, messages: [{ role: 'user', content: prompt }] },
          { headers: { 'x-api-key': CONFIG.claude.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
        await sendToJackson(`Lead follow-up due Boss — ${lead.name} (day ${daysSince}):\n\n"${r.data.content[0].text}"\n\nSend this to ${lead.contact || 'them'} or reply "nurture done ${lead.id}" to mark as contacted.`);
        lead.touchpoints.push(day);
        break;
      }
    }
    if (daysSince >= 30 && lead.touchpoints.length >= sequence.length) lead.status = 'inactive';
  }
  const updated = loadNurture().map(l => { const u = leads.find(x => x.id === l.id); return u || l; });
  fs.writeFileSync(NURTURE_PATH, JSON.stringify(updated, null, 2));
}

function getNurtureLeads() {
  const leads = loadNurture();
  const active = leads.filter(l => l.status === 'active');
  if (!active.length) return 'No active leads in nurture sequence Boss.';
  return 'Active leads in nurture:\n\n' + active.map(l => {
    const days = Math.floor((Date.now() - new Date(l.createdAt).getTime()) / 86400000);
    return `• ${l.name} (${l.niche || 'unknown'}, ${l.budget || 'budget unknown'}) — day ${days}, ${l.touchpoints.length} touchpoints`;
  }).join('\n');
}

// ─── ANALYTICS DASHBOARD (METRICOOL) ──────────────────────────────────────────
function metricoolParams(extra = {}) {
  const mc = CONFIG.metricool || {};
  return { userId: mc.userId, blogId: mc.blogId, ...extra };
}
function metricoolHeaders() {
  return { 'X-Mc-Auth': CONFIG.metricool?.userToken || '', 'Content-Type': 'application/json' };
}
function metricoolDates(days) {
  const end = new Date();
  const start = new Date(Date.now() - days * 86400000);
  const fmt = d => d.toISOString().slice(0,10).replace(/-/g,'');
  return { start: fmt(start), end: fmt(end) };
}

async function getInstagramAnalytics(days = 7) {
  try {
    const mc = CONFIG.metricool;
    if (!mc?.userToken) return '❌ Metricool not connected — send me your Metricool userToken, userId, and blogId';
    const { start, end } = metricoolDates(days);
    const base = 'https://app.metricool.com/api';
    const params = metricoolParams({ start, end });
    const headers = metricoolHeaders();

    // Fetch metrics in parallel
    const [followersRes, reachRes, impressionsRes, profileViewsRes, engagementRes, postsRes, reelsRes] = await Promise.allSettled([
      axios.get(`${base}/stats/timeline/igFollowers`,      { params, headers }),
      axios.get(`${base}/stats/timeline/igreach`,          { params, headers }),
      axios.get(`${base}/stats/timeline/igimpressions`,    { params, headers }),
      axios.get(`${base}/stats/timeline/igprofile_views`,  { params, headers }),
      axios.get(`${base}/stats/timeline/igEngagement`,     { params, headers }),
      axios.get(`${base}/stats/instagram/posts`,           { params: metricoolParams({ start, end, sortBy: 'reach', sortOrder: 'desc', limit: 5 }), headers }),
      axios.get(`${base}/stats/instagram/reels`,           { params: metricoolParams({ start, end, sortBy: 'reach', sortOrder: 'desc', limit: 5 }), headers }),
    ]);

    const lastVal = (res) => {
      if (res.status !== 'fulfilled') return 0;
      const d = res.value.data;
      if (Array.isArray(d) && d.length) return d[d.length - 1][1] || 0;
      return 0;
    };
    const sumVal = (res) => {
      if (res.status !== 'fulfilled') return 0;
      const d = res.value.data;
      if (Array.isArray(d)) return d.reduce((s, row) => s + (parseFloat(row[1]) || 0), 0);
      return 0;
    };

    const followers = lastVal(followersRes);
    const reach = Math.round(sumVal(reachRes));
    const impressions = Math.round(sumVal(impressionsRes));
    const profileViews = Math.round(sumVal(profileViewsRes));
    const engagement = (sumVal(engagementRes) / days).toFixed(2);

    let out = `📊 *Instagram Analytics — Last ${days} Days*\n\n`;
    out += `👥 Followers: ${followers.toLocaleString()}\n`;
    out += `👁️ Reach: ${reach.toLocaleString()}\n`;
    out += `📣 Impressions: ${impressions.toLocaleString()}\n`;
    out += `🔍 Profile Views: ${profileViews.toLocaleString()}\n`;
    out += `💥 Avg Engagement/day: ${engagement}%\n`;

    // Top posts
    const posts = postsRes.status === 'fulfilled' ? (postsRes.value.data?.data || postsRes.value.data || []) : [];
    const reels = reelsRes.status === 'fulfilled' ? (reelsRes.value.data?.data || reelsRes.value.data || []) : [];
    const allContent = [...posts, ...reels]
      .sort((a, b) => (b.reach || 0) - (a.reach || 0))
      .slice(0, 3);

    if (allContent.length) {
      out += `\n*Top content this period:*\n`;
      allContent.forEach((p, i) => {
        const caption = (p.text || p.caption || '').substring(0, 55).replace(/\n/g, ' ');
        const type = p.type === 'REEL' || p.reel ? '🎬' : '📸';
        out += `${i + 1}. ${type} ${caption || '(no caption)'}...\n`;
        out += `   ❤️ ${p.likes || 0} | 💬 ${p.comments || 0} | 👁️ ${(p.reach || 0).toLocaleString()} reach\n`;
      });
    }
    return out;
  } catch (e) {
    if (e.response?.status === 401) return '❌ Metricool token invalid — re-send your userToken';
    return `Instagram analytics error: ${e.message}`;
  }
}

async function getTikTokAnalytics(days = 7) {
  try {
    const mc = CONFIG.metricool;
    if (!mc?.userToken) return '❌ Metricool not connected';
    const { start, end } = metricoolDates(days);
    const base = 'https://app.metricool.com/api';
    const params = metricoolParams({ start, end });
    const headers = metricoolHeaders();

    const [followersRes, viewsRes, likesRes] = await Promise.allSettled([
      axios.get(`${base}/stats/timeline/tkFollowers`,   { params, headers }),
      axios.get(`${base}/stats/timeline/tkVideoViews`,  { params, headers }),
      axios.get(`${base}/stats/timeline/tkLikes`,       { params, headers }),
    ]);

    const lastVal = (res) => {
      if (res.status !== 'fulfilled') return 0;
      const d = res.value.data;
      if (Array.isArray(d) && d.length) return d[d.length - 1][1] || 0;
      return 0;
    };
    const sumVal = (res) => {
      if (res.status !== 'fulfilled') return 0;
      const d = res.value.data;
      if (Array.isArray(d)) return d.reduce((s, row) => s + (parseFloat(row[1]) || 0), 0);
      return 0;
    };

    const followers = lastVal(followersRes);
    const views = Math.round(sumVal(viewsRes));
    const likes = Math.round(sumVal(likesRes));

    if (!followers && !views && !likes) return '📱 *TikTok* — No data yet. Make sure TikTok is connected in Metricool.';

    let out = `📱 *TikTok Analytics — Last ${days} Days*\n\n`;
    out += `👥 Followers: ${followers.toLocaleString()}\n`;
    out += `▶️ Video Views: ${views.toLocaleString()}\n`;
    out += `❤️ Likes: ${likes.toLocaleString()}\n`;
    return out;
  } catch (e) { return `TikTok analytics error: ${e.message}`; }
}

async function getYouTubeAnalytics(days = 7) {
  try {
    const mc = CONFIG.metricool;
    if (!mc?.userToken) return '❌ Metricool not connected';
    const { start, end } = metricoolDates(days);
    const base = 'https://app.metricool.com/api';
    const params = metricoolParams({ start, end });
    const headers = metricoolHeaders();

    const [subsRes, viewsRes] = await Promise.allSettled([
      axios.get(`${base}/stats/timeline/yttotalSubscribers`, { params, headers }),
      axios.get(`${base}/stats/timeline/ytviews`,            { params, headers }),
    ]);

    const lastVal = (res) => {
      if (res.status !== 'fulfilled') return 0;
      const d = res.value.data;
      if (Array.isArray(d) && d.length) return d[d.length - 1][1] || 0;
      return 0;
    };
    const sumVal = (res) => {
      if (res.status !== 'fulfilled') return 0;
      const d = res.value.data;
      if (Array.isArray(d)) return d.reduce((s, row) => s + (parseFloat(row[1]) || 0), 0);
      return 0;
    };

    const subs = lastVal(subsRes);
    const views = Math.round(sumVal(viewsRes));

    if (!subs && !views) return null; // skip if no YouTube connected

    let out = `🎥 *YouTube Analytics — Last ${days} Days*\n\n`;
    out += `👥 Subscribers: ${subs.toLocaleString()}\n`;
    out += `▶️ Views: ${views.toLocaleString()}\n`;
    return out;
  } catch (e) { return null; }
}

async function getFullAnalyticsDashboard(days = 7) {
  const [ig, tt, yt] = await Promise.allSettled([
    getInstagramAnalytics(days),
    getTikTokAnalytics(days),
    getYouTubeAnalytics(days),
  ]);
  const parts = [];
  if (ig.status === 'fulfilled' && ig.value) parts.push(ig.value);
  if (tt.status === 'fulfilled' && tt.value) parts.push(tt.value);
  if (yt.status === 'fulfilled' && yt.value) parts.push(yt.value);
  return parts.join('\n\n─────────────────\n\n') || 'No analytics data available.';
}

async function sendWeeklyAnalyticsReport() {
  try {
    const report = await getFullAnalyticsDashboard(7);
    const date = new Date().toLocaleDateString('en-AU', { timeZone: CONFIG.owner.timezone, weekday: 'long', day: 'numeric', month: 'long' });
    await sendWhatsApp(`📊 *Weekly Analytics — ${date}*\n\n${report}`);
  } catch (e) { console.error('Weekly analytics report error:', e.message); }
}

// ─── PDF & GOOGLE SHEETS GENERATION ──────────────────────────────────────────
const PDFDocument = require('pdfkit');
const EXPORTS_PATH = path.join(__dirname, 'exports');
if (!fs.existsSync(EXPORTS_PATH)) fs.mkdirSync(EXPORTS_PATH);

// ── PDF helpers ───────────────────────────────────────────────────────────────
function createPDFDoc(filename) {
  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  const filePath = path.join(EXPORTS_PATH, filename);
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);
  return { doc, filePath, stream };
}

function pdfHeader(doc, title, subtitle = '') {
  doc.fontSize(22).font('Helvetica-Bold').text('JT VISUALS', 50, 50);
  doc.fontSize(10).font('Helvetica').fillColor('#888888').text('jtvissuals.com.au  |  Gold Coast, Australia', 50, 78);
  doc.moveTo(50, 95).lineTo(545, 95).strokeColor('#cccccc').stroke();
  doc.moveDown(1.5).fillColor('#000000').fontSize(18).font('Helvetica-Bold').text(title);
  if (subtitle) doc.fontSize(11).font('Helvetica').fillColor('#555555').text(subtitle).moveDown(0.5);
  doc.fillColor('#000000').moveDown(0.5);
}

function pdfSectionTitle(doc, text) {
  doc.moveDown(0.8).fontSize(12).font('Helvetica-Bold').fillColor('#1a1a2e').text(text.toUpperCase());
  doc.moveTo(50, doc.y + 2).lineTo(545, doc.y + 2).strokeColor('#e0e0e0').stroke().moveDown(0.5);
  doc.fillColor('#000000');
}

function pdfRow(doc, label, value, highlight = false) {
  if (highlight) doc.rect(48, doc.y - 2, 497, 18).fill('#f5f5f5').fillColor('#000000');
  doc.fontSize(10).font('Helvetica-Bold').text(label, 52, doc.y, { continued: true, width: 250 });
  doc.font('Helvetica').text(value, { align: 'right' }).moveDown(0.2);
}

function finalisePDF(doc, stream, filePath) {
  return new Promise(resolve => {
    stream.on('finish', () => resolve(filePath));
    doc.end();
  });
}

// ── Quote / Proposal PDF ──────────────────────────────────────────────────────
async function generateQuotePDF({ clientName, clientEmail = '', packages = [], notes = '', validDays = 14 }) {
  const filename = `quote_${clientName.replace(/\s+/g,'_')}_${Date.now()}.pdf`;
  const { doc, filePath, stream } = createPDFDoc(filename);
  const date = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
  const validUntil = new Date(Date.now() + validDays * 86400000).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });

  pdfHeader(doc, 'SERVICE PROPOSAL', `Prepared for ${clientName}  |  ${date}`);
  if (clientEmail) doc.fontSize(10).text(`Contact: ${clientEmail}`).moveDown(0.5);

  pdfSectionTitle(doc, 'Package Details');
  let total = 0;
  packages.forEach((pkg, i) => {
    const amt = parseFloat(String(pkg.price || 0).replace(/[^0-9.]/g,'')) || 0;
    total += amt;
    pdfRow(doc, pkg.name, `$${amt.toLocaleString('en-AU', {minimumFractionDigits:2})}`, i % 2 === 0);
    if (pkg.description) doc.fontSize(9).fillColor('#666').text(`  ${pkg.description}`, 52).fillColor('#000').moveDown(0.1);
  });

  doc.moveDown(0.3).moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#000').stroke().moveDown(0.5);
  doc.fontSize(13).font('Helvetica-Bold').text('TOTAL (per month)', { continued: true }).text(`$${total.toLocaleString('en-AU', {minimumFractionDigits:2})}`, { align: 'right' });

  if (notes) {
    pdfSectionTitle(doc, 'Notes');
    doc.fontSize(10).font('Helvetica').text(notes);
  }

  pdfSectionTitle(doc, 'Terms');
  doc.fontSize(10).font('Helvetica').text(`• This proposal is valid until ${validUntil}`);
  doc.text('• 50% deposit required to commence. Balance due on delivery.');
  doc.text('• Revisions included as per agreed package scope.');
  doc.text('• Content calendar and shoot schedule provided upon confirmation.');
  doc.moveDown(2).fontSize(10).fillColor('#888').text('To accept, simply reply to confirm and we will get started.', { align: 'center' });

  return finalisePDF(doc, stream, filePath);
}

// ── Invoice PDF ───────────────────────────────────────────────────────────────
async function generateInvoicePDF({ clientName, clientEmail = '', invoiceNumber, items = [], dueDate = '', notes = '' }) {
  const filename = `invoice_${(invoiceNumber||Date.now()).toString().replace(/\s+/g,'_')}.pdf`;
  const { doc, filePath, stream } = createPDFDoc(filename);
  const date = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
  const due = dueDate ? new Date(dueDate).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }) : '14 days from invoice date';

  pdfHeader(doc, `INVOICE #${invoiceNumber || 'INV-' + Date.now().toString().slice(-5)}`, date);

  doc.fontSize(10).font('Helvetica-Bold').text('Bill To:').font('Helvetica').text(clientName);
  if (clientEmail) doc.text(clientEmail);
  doc.moveDown(0.3).font('Helvetica-Bold').text('Due Date: ', { continued: true }).font('Helvetica').text(due).moveDown(1);

  pdfSectionTitle(doc, 'Services');
  let subtotal = 0;
  items.forEach((item, i) => {
    const amt = parseFloat(String(item.amount || 0).replace(/[^0-9.]/g,'')) || 0;
    subtotal += amt;
    pdfRow(doc, item.description, `$${amt.toLocaleString('en-AU', {minimumFractionDigits:2})}`, i % 2 === 0);
  });

  const gst = subtotal * 0.1;
  const total = subtotal + gst;
  doc.moveDown(0.5);
  pdfRow(doc, 'Subtotal', `$${subtotal.toLocaleString('en-AU', {minimumFractionDigits:2})}`);
  pdfRow(doc, 'GST (10%)', `$${gst.toLocaleString('en-AU', {minimumFractionDigits:2})}`);
  doc.moveDown(0.3).moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#000').stroke().moveDown(0.5);
  doc.fontSize(13).font('Helvetica-Bold').text('TOTAL DUE', { continued: true }).text(`$${total.toLocaleString('en-AU', {minimumFractionDigits:2})}`, { align: 'right' });

  pdfSectionTitle(doc, 'Payment Details');
  doc.fontSize(10).font('Helvetica').text('BSB: [Your BSB]').text('Account: [Your Account Number]').text('Reference: ' + (invoiceNumber || clientName));
  if (notes) { doc.moveDown(0.5).font('Helvetica-Bold').text('Notes:').font('Helvetica').text(notes); }

  return finalisePDF(doc, stream, filePath);
}

// ── Weekly Report PDF ─────────────────────────────────────────────────────────
async function generateWeeklyReportPDF() {
  const filename = `weekly_report_${new Date().toISOString().slice(0,10)}.pdf`;
  const { doc, filePath, stream } = createPDFDoc(filename);
  const date = new Date().toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  pdfHeader(doc, 'WEEKLY BUSINESS REPORT', date);

  pdfSectionTitle(doc, 'Revenue');
  const mrr = getMRR();
  doc.fontSize(10).font('Helvetica').text(mrr);

  try {
    pdfSectionTitle(doc, 'Calendar — This Week');
    const cal = await getCalendarEvents();
    doc.fontSize(10).font('Helvetica').text(cal.replace(/•/g, '-'));
  } catch(e) {}

  try {
    pdfSectionTitle(doc, 'Open Monday Tasks');
    const tasks = await getAllMondayTasks();
    doc.fontSize(10).font('Helvetica').text(tasks.replace(/[*•]/g,'-').substring(0,1500));
  } catch(e) {}

  try {
    pdfSectionTitle(doc, 'Active Leads');
    const leads = await getStaleGHLLeads();
    doc.fontSize(10).font('Helvetica').text(leads.replace(/•/g,'-'));
  } catch(e) {}

  doc.moveDown(2).fontSize(9).fillColor('#aaa').text('Generated by JT Visuals Chief of Staff', { align: 'center' });
  return finalisePDF(doc, stream, filePath);
}

// ── Google Sheets helpers ─────────────────────────────────────────────────────
async function createSheet(title, data, sheetName = 'Sheet1') {
  const auth = getGoogleAuth();
  if (!auth) throw new Error('Google not connected.');
  const sheets = google.sheets({ version: 'v4', auth });
  const drive  = google.drive({ version: 'v3', auth });

  // Create spreadsheet
  const ss = await sheets.spreadsheets.create({
    resource: { properties: { title }, sheets: [{ properties: { title: sheetName } }] }
  });
  const ssId = ss.data.spreadsheetId;
  const ssUrl = `https://docs.google.com/spreadsheets/d/${ssId}`;

  // Write data
  if (data.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: ssId, range: `${sheetName}!A1`,
      valueInputOption: 'USER_ENTERED', resource: { values: data }
    });
    // Bold the header row
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: ssId, resource: { requests: [{
      repeatCell: { range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.1, green: 0.1, blue: 0.18 }, horizontalAlignment: 'CENTER' } },
        fields: 'userEnteredFormat(textFormat,backgroundColor,horizontalAlignment)' }
    }] } });
  }

  // Make it viewable by link
  await drive.permissions.create({ fileId: ssId, resource: { role: 'reader', type: 'anyone' } }).catch(() => {});
  return ssUrl;
}

async function generateContentCalendarSheet(clientName, weeks = 4) {
  const client = ACTIVE_CLIENTS_MRR.find(c => c.name.toLowerCase().includes(clientName.toLowerCase())) || { name: clientName };
  const today = new Date();
  const rows = [['Week', 'Date', 'Platform', 'Content Type', 'Topic / Hook', 'Caption Status', 'Filmed', 'Edited', 'Published', 'Notes']];
  const platforms = ['Instagram Reel', 'TikTok', 'Instagram Reel', 'YouTube Short', 'Instagram Reel'];
  const types = ['Educational', 'Behind the Scenes', 'Client Transformation', 'Trending Hook', 'Talking Head'];
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 5; d++) {
      const date = new Date(today); date.setDate(today.getDate() + w * 7 + d);
      rows.push([
        `Week ${w+1}`,
        date.toLocaleDateString('en-AU'),
        platforms[d % platforms.length],
        types[d % types.length],
        '', '', '☐', '☐', '☐', ''
      ]);
    }
  }
  return createSheet(`${client.name} — Content Calendar ${today.toLocaleDateString('en-AU')}`, rows, 'Content Calendar');
}

async function generateProductionScheduleSheet() {
  const rows = [['Client', 'Shoot Date', 'Editor', 'Files Uploaded', 'Edit Started', 'Internal Review', 'Client Review', 'Delivered', 'Status', 'Notes']];
  for (const client of ACTIVE_CLIENTS_MRR) {
    rows.push([client.name, '', '', '☐', '☐', '☐', '☐', '☐', 'Pending', '']);
  }
  return createSheet(`JT Visuals — Production Schedule ${new Date().toLocaleDateString('en-AU')}`, rows, 'Production');
}

async function generateExpenseSheet(months = 3) {
  const rows = [['Date', 'Category', 'Vendor / Description', 'Amount (AUD)', 'GST', 'Total inc. GST', 'Notes', 'Billable to Client']];
  const categories = ['Software', 'Wages', 'Equipment', 'Marketing', 'Travel', 'Other'];
  // Blank rows ready to fill
  for (let i = 0; i < 30; i++) rows.push(['', categories[i % categories.length], '', '', '', '', '', '']);
  const url = await createSheet(`JT Visuals — Expenses ${new Date().toLocaleDateString('en-AU')}`, rows, 'Expenses');
  return url;
}

async function generatePnLSheet() {
  const rows = [
    ['JT VISUALS — P&L TRACKER', '', '', '', ''],
    ['', '', '', '', ''],
    ['INCOME', 'Jan', 'Feb', 'Mar', 'Total'],
  ];
  for (const c of ACTIVE_CLIENTS_MRR) rows.push([c.name, c.mrr, c.mrr, c.mrr, `=B${rows.length+1}+C${rows.length+1}+D${rows.length+1}`]);
  rows.push(['TOTAL INCOME', `=SUM(B4:B${rows.length})`, `=SUM(C4:C${rows.length})`, `=SUM(D4:D${rows.length})`, `=SUM(E4:E${rows.length})`]);
  rows.push(['', '', '', '', '']);
  rows.push(['EXPENSES', '', '', '', '']);
  const expenseRows = [['Wages - Anthony', '', '', '', ''], ['Wages - Anik', '', '', '', ''], ['Wages - Tina', '', '', '', ''], ['Software & Subscriptions', '', '', '', ''], ['Equipment', '', '', '', ''], ['Marketing', '', '', '', ''], ['Other', '', '', '', '']];
  expenseRows.forEach(r => rows.push(r));
  const expStart = rows.length - expenseRows.length + 1;
  rows.push(['TOTAL EXPENSES', `=SUM(B${expStart}:B${rows.length})`, `=SUM(C${expStart}:C${rows.length})`, `=SUM(D${expStart}:D${rows.length})`, `=SUM(E${expStart}:E${rows.length})`]);
  rows.push(['', '', '', '', '']);
  rows.push(['NET PROFIT', `=B${expenseRows.length+5}-B${rows.length-1}`, `=C${expenseRows.length+5}-C${rows.length-1}`, `=D${expenseRows.length+5}-D${rows.length-1}`, `=E${expenseRows.length+5}-E${rows.length-1}`]);
  return createSheet('JT Visuals — P&L Tracker', rows, 'P&L');
}

async function uploadPDFToDrive(filePath, filename) {
  try {
    const auth = getGoogleAuth();
    if (!auth) return null;
    const drive = google.drive({ version: 'v3', auth });
    const res = await drive.files.create({
      resource: { name: filename, mimeType: 'application/pdf' },
      media: { mimeType: 'application/pdf', body: fs.createReadStream(filePath) },
      fields: 'id,webViewLink'
    });
    await drive.permissions.create({ fileId: res.data.id, resource: { role: 'reader', type: 'anyone' } });
    return res.data.webViewLink;
  } catch(e) { console.error('Drive upload error:', e.message); return null; }
}

// ─── MONDAY.COM ───────────────────────────────────────────────────────────────
const MONDAY_BOARD_NAMES = {
  jackson: 'Jackson Tasks',
  anthony: 'Anthony (Editor)',
  alik:    'Alik (Editor)',
  tina:    'Tina (PA)',
  projects: 'Projects P&L',
  expenses: 'Expenses Ledger',
};

function mondayQuery(query, variables = {}) {
  return axios.post('https://api.monday.com/v2',
    { query, variables },
    { headers: { 'Authorization': CONFIG.monday?.apiKey || '', 'Content-Type': 'application/json', 'API-Version': '2024-01' } }
  );
}

async function getMondayTasks(boardKey) {
  try {
    const boards = CONFIG.monday?.boards || {};
    const boardId = boards[boardKey] || boards.jackson;
    const res = await mondayQuery(`{
      boards(ids: [${boardId}]) {
        name
        items_page(limit: 50) {
          items {
            id name state
            column_values { id text }
          }
        }
      }
    }`);
    const board = res.data?.data?.boards?.[0];
    if (!board) return `No board found for ${boardKey}.`;
    const items = board.items_page.items.filter(i => i.state === 'active');
    if (!items.length) return `No active tasks on ${board.name}.`;
    const lines = items.map(item => {
      const status = item.column_values.find(c => c.id === 'status')?.text || '';
      const priority = item.column_values.find(c => c.id === 'color_mky8z6q8' || c.id === 'color_mky8z6q8')?.text || '';
      const date = item.column_values.find(c => c.id === 'date4' || c.id === 'date_mky81jvr')?.text || '';
      const parts = [item.name];
      if (status) parts.push(`[${status}]`);
      if (priority) parts.push(`(${priority})`);
      if (date) parts.push(`due ${date}`);
      return `• ${parts.join(' ')}`;
    });
    return `*${board.name}* — ${items.length} tasks:\n\n${lines.join('\n')}`;
  } catch (e) { return `Monday.com error: ${e.message}`; }
}

async function getAllMondayTasks() {
  try {
    const boards = CONFIG.monday?.boards || {};
    const ids = [boards.jackson, boards.anthony, boards.alik, boards.tina].filter(Boolean);
    const res = await mondayQuery(`{
      boards(ids: [${ids.join(',')}]) {
        id name
        items_page(limit: 50) {
          items { id name state column_values { id text } }
        }
      }
    }`);
    const allBoards = res.data?.data?.boards || [];
    let out = [];
    for (const board of allBoards) {
      const active = board.items_page.items.filter(i => i.state === 'active');
      if (!active.length) continue;
      const lines = active.map(item => {
        const status = item.column_values.find(c => c.id === 'status')?.text || '';
        const priority = item.column_values.find(c => c.id === 'color_mky8z6q8')?.text || '';
        const date = item.column_values.find(c => c.id === 'date4' || c.id === 'date_mky81jvr')?.text || '';
        const parts = [item.name];
        if (status && status !== 'Not Started') parts.push(`[${status}]`);
        if (priority) parts.push(`(${priority})`);
        if (date) parts.push(`due ${date}`);
        return `  • ${parts.join(' ')}`;
      });
      out.push(`*${board.name}* (${active.length}):\n${lines.join('\n')}`);
    }
    return out.length ? out.join('\n\n') : 'No active tasks across boards.';
  } catch (e) { return `Monday.com error: ${e.message}`; }
}

async function createMondayTask(boardKey, taskName, statusText = '', priorityText = '', dueDate = '') {
  try {
    const boards = CONFIG.monday?.boards || {};
    const boardId = boards[boardKey] || boards.jackson;
    // First create the item
    const createRes = await mondayQuery(
      `mutation ($boardId: ID!, $itemName: String!) { create_item(board_id: $boardId, item_name: $itemName) { id } }`,
      { boardId: String(boardId), itemName: taskName }
    );
    const itemId = createRes.data?.data?.create_item?.id;
    if (!itemId) return `Failed to create task on Monday.com`;
    // Update column values if provided
    const colVals = {};
    if (statusText) colVals['status'] = { label: statusText };
    if (dueDate) {
      // Try both date column IDs
      colVals['date4'] = { date: dueDate };
      colVals['date_mky81jvr'] = { date: dueDate };
    }
    if (Object.keys(colVals).length) {
      await mondayQuery(
        `mutation ($boardId: ID!, $itemId: ID!, $vals: JSON!) { change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $vals) { id } }`,
        { boardId: String(boardId), itemId: String(itemId), vals: JSON.stringify(colVals) }
      );
    }
    return `✅ Task created on ${MONDAY_BOARD_NAMES[boardKey] || boardKey}: "${taskName}"${dueDate ? ` due ${dueDate}` : ''}`;
  } catch (e) { return `Monday.com error: ${e.message}`; }
}

async function updateMondayTaskStatus(itemId, statusLabel) {
  try {
    const res = await mondayQuery(
      `mutation ($itemId: ID!, $boardId: ID!, $val: JSON!) { change_column_value(item_id: $itemId, board_id: $boardId, column_id: "status", value: $val) { id } }`,
      { itemId: String(itemId), boardId: '5025841409', val: JSON.stringify({ label: statusLabel }) }
    );
    if (res.data?.data?.change_column_value?.id) return `✅ Status updated to "${statusLabel}"`;
    return `Update may have failed — check Monday.com`;
  } catch (e) { return `Monday.com error: ${e.message}`; }
}

async function searchMondayTask(boardKey, searchTerm) {
  try {
    const boards = CONFIG.monday?.boards || {};
    const boardId = boards[boardKey] || boards.jackson;
    const res = await mondayQuery(`{
      boards(ids: [${boardId}]) {
        items_page(limit: 100) {
          items { id name state column_values { id text } }
        }
      }
    }`);
    const items = res.data?.data?.boards?.[0]?.items_page?.items || [];
    const matches = items.filter(i => i.state === 'active' && i.name.toLowerCase().includes(searchTerm.toLowerCase()));
    if (!matches.length) return `No tasks matching "${searchTerm}" found.`;
    return matches.map(i => `• [ID: ${i.id}] ${i.name}`).join('\n');
  } catch (e) { return `Monday.com error: ${e.message}`; }
}

// ─── FIREFLIES ────────────────────────────────────────────────────────────────
function firefliesQuery(query, variables = {}) {
  return axios.post('https://api.fireflies.ai/graphql',
    { query, variables },
    { headers: { 'Authorization': `Bearer ${CONFIG.fireflies?.apiKey || ''}`, 'Content-Type': 'application/json' } }
  );
}

async function getFirefliesCalls(limit = 10) {
  try {
    const res = await firefliesQuery(`{
      transcripts(limit: ${limit}) {
        id title date duration
        summary { overview action_items keywords }
        sentences { text speaker_name }
      }
    }`);
    return res.data?.data?.transcripts || [];
  } catch(e) { console.error('Fireflies error:', e.response?.data || e.message); return []; }
}

async function getFirefliesTranscript(id) {
  try {
    const res = await firefliesQuery(`{
      transcript(id: "${id}") {
        id title date duration
        summary { overview action_items keywords }
        sentences { text speaker_name }
      }
    }`);
    return res.data?.data?.transcript || null;
  } catch(e) { return null; }
}

async function analysePastCalls() {
  const calls = await getFirefliesCalls(10);
  if (!calls.length) return 'No Fireflies calls found Boss. Make sure Fireflies is connected to your calendar.';

  const callData = calls.map(c => {
    const overview = c.summary?.overview || '';
    const transcript = (c.sentences || []).slice(0, 40).map(s => `${s.speaker_name}: ${s.text}`).join(' ');
    return `CALL: ${c.title} (${new Date(c.date).toLocaleDateString('en-AU')})\nSUMMARY: ${overview}\nTRANSCRIPT: ${transcript}`;
  }).join('\n\n');

  const prompt = `Analyse these sales calls for Jackson Edwards, JT Visuals videography agency Gold Coast.
${JT_PRICING}
CALLS:
${callData}

Give Boss:
1) Which packages came up most
2) Top 3 objections and how to handle them
3) What specifically closes deals
4) Win vs loss patterns
5) One thing to do differently on next call
Plain text, no markdown, max 8 lines.`;

  const r = await axios.post('https://api.anthropic.com/v1/messages',
    { model: MODEL_MID, max_tokens: 600, messages: [{ role: 'user', content: prompt }] },
    { headers: { 'x-api-key': CONFIG.claude.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
  return r.data.content[0].text;
}

async function analyseFirefliesCall(transcript) {
  const overview = transcript.summary?.overview || '';
  const sentences = (transcript.sentences || []).map(s => `${s.speaker_name}: ${s.text}`).join('\n');
  const actionItems = transcript.summary?.action_items || '';

  const prompt = `Jackson Edwards just finished a sales call. Analyse it and give him a debrief.
CALL: ${transcript.title}
SUMMARY: ${overview}
ACTION ITEMS: ${actionItems}
TRANSCRIPT:
${sentences.substring(0, 3000)}

JT VISUALS PRICING:
${JT_PRICING}

Give Boss:
1) Did they close or not — why
2) Key objections raised
3) Best package to follow up with and why
4) Exact follow-up message to send (WhatsApp style, casual, under 3 sentences)
5) One thing Jackson handled well, one to improve
Plain text, no markdown, max 10 lines.`;

  const r = await axios.post('https://api.anthropic.com/v1/messages',
    { model: MODEL_MID, max_tokens: 600, messages: [{ role: 'user', content: prompt }] },
    { headers: { 'x-api-key': CONFIG.claude.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
  return r.data.content[0].text;
}

async function liveCallAssist(clientInfo) {
  const prompt = `Jackson is on a LIVE sales call RIGHT NOW. Instant pricing guidance.
CLIENT: ${clientInfo}
PRICING: 12vids/m: 3M=$2,200 6M=$1,980 12M=$1,870 | 16vids: 3M=$2,880 6M=$2,592 12M=$2,448 | 20vids: 3M=$3,500 6M=$3,150 12M=$2,975 | 24vids: 3M=$4,080 6M=$3,672 12M=$3,468 | Scripts: <10=$100ea 10-20=$75 20+=$50
Give: 1) Exact package to pitch 2) One value point 3) Closing line. MAX 4 lines. Address as Boss.`;
  const r = await axios.post('https://api.anthropic.com/v1/messages',
    { model: MODEL_HIGH, max_tokens: 300, messages: [{ role: 'user', content: prompt }] },
    { headers: { 'x-api-key': CONFIG.claude.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
  return r.data.content[0].text;
}

const JT_BUSINESS = { shooting_days: ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'], active_clients: JT_BUSINESS_CLIENTS };

function getClientContext() {
  return JT_BUSINESS_CLIENTS.map(c => `• ${c.name} (${c.niche}): ${c.package} — ${c.value}`).join('\n');
}

async function generateReelIdeas(clientName, count = 8) {
  const client = JT_BUSINESS_CLIENTS.find(c => c.name.toLowerCase().includes(clientName.toLowerCase())) || { name: clientName, niche: 'fitness coaching', package: 'content creation' };
  const prompt = `Generate ${count} specific scroll-stopping reel ideas for ${client.name}, a ${client.niche} creator. Package: ${client.package}. Each idea: hook first, then brief description. Specific to fitness/coaching niche 2026. Numbered list only.`;
  const r = await axios.post('https://api.anthropic.com/v1/messages',
    { model: MODEL_LOW, max_tokens: 500, messages: [{ role: 'user', content: prompt }] },
    { headers: { 'x-api-key': CONFIG.claude.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
  return r.data.content[0].text;
}

async function generateHooks(topic, count = 8) {
  const prompt = `Generate ${count} high-performing video hooks for fitness/coaching content about: "${topic}". Under 10 words each. No generic openers. Specific, punchy, scroll-stopping. For Instagram Reels and TikTok 2026. Numbered list only.`;
  const r = await axios.post('https://api.anthropic.com/v1/messages',
    { model: MODEL_LOW, max_tokens: 300, messages: [{ role: 'user', content: prompt }] },
    { headers: { 'x-api-key': CONFIG.claude.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
  return r.data.content[0].text;
}

async function generateCaption(topic, clientName) {
  const client = JT_BUSINESS_CLIENTS.find(c => c.name.toLowerCase().includes((clientName||'').toLowerCase())) || { name: clientName||'fitness coach', niche: 'fitness coaching' };
  const prompt = `Write an Instagram caption for ${client.name} (${client.niche}) about: "${topic}". Conversational, authentic, not salesy. Hook + 3-4 lines + CTA + 5-8 hashtags. Australian audience. Real person tone.`;
  const r = await axios.post('https://api.anthropic.com/v1/messages',
    { model: MODEL_LOW, max_tokens: 400, messages: [{ role: 'user', content: prompt }] },
    { headers: { 'x-api-key': CONFIG.claude.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
  return r.data.content[0].text;
}

async function generateContentCalendar(clientName) {
  const client = JT_BUSINESS_CLIENTS.find(c => c.name.toLowerCase().includes(clientName.toLowerCase())) || { name: clientName, niche: 'fitness coaching', package: 'content creation' };
  const prompt = `4-week content calendar for ${client.name} (${client.niche}). Package: ${client.package}. 4 ideas per week with content type + topic + hook. Specific to their niche. Clean format. Under 600 chars total.`;
  const r = await axios.post('https://api.anthropic.com/v1/messages',
    { model: MODEL_LOW, max_tokens: 500, messages: [{ role: 'user', content: prompt }] },
    { headers: { 'x-api-key': CONFIG.claude.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
  return r.data.content[0].text;
}

const JT_BRAND = {
  voice: "Premium videography agency. Cinematic, ads, and organic content. Professional but personable.",
  turnaround: { internal_edit: "24 hours", client_delivery: "48 hours", final_delivery: "72 hours", revision_policy: "Unlimited revisions until 100% happy" },
  common_questions: {
    "where are my videos": "Our editors are working on it now. First version lands with you in 48 hours — we do an internal review before sending.",
    "how long until videos are ready": "48 hours for your first version. We review internally before sending, then unlimited revisions until you're 100% happy.",
    "do you have a timeline": "First version in 48 hours. We do an internal review so the quality is already there. Then we refine until it's perfect.",
    "when will my content be ready": "You'll have your first version within 48 hours. From there, unlimited revisions until everything is exactly right."
  }
};

async function draftClientReply(clientName, question) {
  const client = JT_BUSINESS_CLIENTS.find(c => c.name.toLowerCase().includes((clientName || '').toLowerCase())) || { name: clientName || 'the client', niche: 'fitness coaching' };
  const commonQ = Object.keys(JT_BRAND.common_questions).find(q => question.toLowerCase().includes(q.toLowerCase()));
  const baseAnswer = commonQ ? JT_BRAND.common_questions[commonQ] : null;
  const prompt = `Draft a WhatsApp reply from Jackson Edwards (JT Visuals) to ${client.name}.
Their message: "${question}"
Brand voice: ${JT_BRAND.voice}
Turnaround: ${JSON.stringify(JT_BRAND.turnaround)}
${baseAnswer ? 'Suggested answer: ' + baseAnswer : ''}
Write ONLY the reply. Warm, professional, concise. 2-3 sentences. Sound like a real person.`;
  const r = await axios.post('https://api.anthropic.com/v1/messages',
    { model: MODEL_LOW, max_tokens: 200, messages: [{ role: 'user', content: prompt }] },
    { headers: { 'x-api-key': CONFIG.claude.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
  return r.data.content[0].text;
}

async function webSearch(query, deep = false) {
  const prompt = `You are a research assistant for Jackson Edwards, owner of JT Visuals (videography agency, Gold Coast, Australia).

Research query: "${query}"

${deep
  ? 'Do a thorough search. Summarise findings clearly with bullet points, key stats, and any actionable takeaways relevant to a videography business.'
  : 'Give a concise, direct answer. Max 4-5 bullet points or 3 short paragraphs. Facts and specifics only — no padding.'
}`;
  const r = await axios.post('https://api.anthropic.com/v1/messages',
    {
      model: deep ? MODEL_MID : MODEL_LOW,
      max_tokens: deep ? 1200 : 500,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }]
    },
    { headers: { 'x-api-key': CONFIG.claude.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'web-search-2025-03-05', 'content-type': 'application/json' } }
  );
  const text = r.data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  return text || 'Could not find that information Boss.';
}

// Keep alias for backward compatibility
async function webSearchFallback(query) { return webSearch(query, false); }

// ─── XERO FINANCIAL ANALYSIS (CSV-BASED) ──────────────────────────────────────
const XERO_UPLOADS_PATH = path.join(__dirname, 'xero-uploads');
if (!fs.existsSync(XERO_UPLOADS_PATH)) fs.mkdirSync(XERO_UPLOADS_PATH);

const XERO_TOKEN_PATH = path.join(__dirname, 'xero-token.json');
const XERO_API = 'https://api.xero.com/api.xro/2.0';
const XERO_SCOPES = 'offline_access openid profile accounting.reports.read accounting.reports.profitandloss.read accounting.invoices.read accounting.banktransactions.read accounting.payments.read accounting.accounts.read accounting.contacts';

function loadXeroToken() {
  if (fs.existsSync(XERO_TOKEN_PATH)) {
    try { return JSON.parse(fs.readFileSync(XERO_TOKEN_PATH)); } catch(e) {}
  }
  return null;
}

function saveXeroToken(data) {
  fs.writeFileSync(XERO_TOKEN_PATH, JSON.stringify(data, null, 2));
}

async function getValidXeroToken() {
  const t = loadXeroToken();
  if (!t) throw new Error('Xero not connected. Ask Jackson to run "connect xero".');

  // Refresh if expired or within 5 min of expiry
  if (Date.now() >= t.expiresAt - 300000) {
    const xero = CONFIG.xero || {};
    const r = await axios.post('https://identity.xero.com/connect/token',
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refreshToken, client_id: xero.clientId, client_secret: xero.clientSecret }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const fresh = {
      accessToken: r.data.access_token,
      refreshToken: r.data.refresh_token,
      expiresAt: Date.now() + r.data.expires_in * 1000,
      tenantId: t.tenantId,
    };
    saveXeroToken(fresh);
    return fresh;
  }
  return t;
}

async function xeroAPI(endpoint, params = {}) {
  const token = await getValidXeroToken();
  const r = await axios.get(`${XERO_API}${endpoint}`, {
    params,
    headers: {
      'Authorization': `Bearer ${token.accessToken}`,
      'Xero-Tenant-Id': token.tenantId,
      'Accept': 'application/json',
    }
  });
  return r.data;
}

async function getXeroPnL(months = 3) {
  try {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth() - months, 1);
    const fmt = d => d.toISOString().slice(0,10);
    const data = await xeroAPI('/Reports/ProfitAndLoss', {
      fromDate: fmt(from),
      toDate: fmt(now),
      standardLayout: true
    });

    const report = data.Reports?.[0];
    if (!report) return 'No P&L data found.';

    let income = 0, expenses = 0;
    const expenseLines = [];

    for (const section of report.Rows || []) {
      if (!section.Rows) continue;
      const sectionTitle = section.Title || '';
      for (const row of section.Rows) {
        if (row.RowType === 'Row' && row.Cells) {
          const name = row.Cells[0]?.Value || '';
          const amount = parseFloat(row.Cells[1]?.Value?.replace(/,/g,'') || '0');
          if (!isNaN(amount) && amount !== 0) {
            if (sectionTitle.toLowerCase().includes('income') || sectionTitle.toLowerCase().includes('revenue')) {
              income += amount;
            } else if (sectionTitle.toLowerCase().includes('expense') || sectionTitle.toLowerCase().includes('cost')) {
              expenses += amount;
              if (name) expenseLines.push({ name, amount });
            }
          }
        }
        if (row.RowType === 'SummaryRow' && row.Cells) {
          const label = row.Cells[0]?.Value?.toLowerCase() || '';
          const val = parseFloat(row.Cells[1]?.Value?.replace(/,/g,'') || '0');
          if (label.includes('total income') || label.includes('total revenue')) income = val;
          if (label.includes('total operating') || label.includes('total expenses')) expenses = val;
        }
      }
    }

    const profit = income - expenses;
    const margin = income > 0 ? ((profit / income) * 100).toFixed(1) : 0;

    let out = `💰 *P&L Summary — Last ${months} Months*\n\n`;
    out += `📈 Revenue: $${income.toLocaleString('en-AU', {minimumFractionDigits:2,maximumFractionDigits:2})}\n`;
    out += `📉 Expenses: $${expenses.toLocaleString('en-AU', {minimumFractionDigits:2,maximumFractionDigits:2})}\n`;
    out += `💵 Net Profit: $${profit.toLocaleString('en-AU', {minimumFractionDigits:2,maximumFractionDigits:2})}\n`;
    out += `📊 Profit Margin: ${margin}%\n`;

    if (expenseLines.length) {
      const sorted = expenseLines.sort((a,b) => b.amount - a.amount);
      out += `\n*Top expenses:*\n`;
      sorted.slice(0,8).forEach(e => {
        const pct = income > 0 ? ((e.amount/income)*100).toFixed(1) : '—';
        out += `• ${e.name}: $${e.amount.toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})} (${pct}% of revenue)\n`;
      });
    }
    return out;
  } catch (e) {
    if (e.message.includes('not connected')) return e.message;
    return `Xero P&L error: ${e.response?.data?.Detail || e.message}`;
  }
}

async function getXeroExpenses(days = 30) {
  try {
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0,10);
    const data = await xeroAPI('/BankTransactions', {
      Type: 'SPEND',
      where: `Date >= DateTime(${since.replace(/-/g,'/')})`,
      order: 'Date DESC'
    });

    const txns = data.BankTransactions || [];
    if (!txns.length) return `No expense transactions found in the last ${days} days.`;

    // Group by contact/description
    const grouped = {};
    let total = 0;
    for (const t of txns) {
      const key = t.Contact?.Name || t.Reference || 'Unknown';
      if (!grouped[key]) grouped[key] = 0;
      grouped[key] += t.Total || 0;
      total += t.Total || 0;
    }

    const sorted = Object.entries(grouped).sort((a,b) => b[1]-a[1]);
    let out = `💳 *Expenses — Last ${days} Days*\n\n`;
    out += `Total spend: $${total.toLocaleString('en-AU',{minimumFractionDigits:2})}\n`;
    out += `Transactions: ${txns.length}\n\n`;
    out += `*By vendor:*\n`;
    sorted.slice(0,10).forEach(([name, amt]) => {
      out += `• ${name}: $${amt.toLocaleString('en-AU',{minimumFractionDigits:2})}\n`;
    });
    return out;
  } catch (e) {
    if (e.message.includes('not connected')) return e.message;
    return `Xero expenses error: ${e.response?.data?.Detail || e.message}`;
  }
}

async function analyseXeroFinancials(months = 3) {
  try {
    const [pnl, expenses] = await Promise.all([
      getXeroPnL(months),
      getXeroExpenses(months * 30)
    ]);

    const businessCtx = getBusinessContext();
    const mrr = getMRR();

    const prompt = `You are a financial advisor reviewing the books for JT Visuals, a videography agency in Gold Coast Australia.

CURRENT MRR: ${mrr}
P&L DATA:
${pnl}

EXPENSE DETAIL:
${expenses}

BUSINESS CONTEXT:
- Team: Jackson (owner), Tina (PA), Anthony (editor, France), Anik (editor)
- Target: $1M revenue in 2026
- Current MRR: ~$36,800

Provide a sharp financial analysis covering:
1. Profit margin assessment — is it healthy for an agency this size? (industry benchmark is 20-35%)
2. Top 3 expense categories that are too high or questionable — be specific
3. Quick wins — costs to cut or renegotiate immediately
4. Structural improvements — pricing, billing cycles, wage efficiency
5. One revenue lever to improve margin without more clients

Be direct and specific. No fluff. Use dollar amounts where possible.`;

    const r = await axios.post('https://api.anthropic.com/v1/messages',
      { model: MODEL_HIGH, max_tokens: 1000, messages: [{ role: 'user', content: prompt }] },
      { headers: { 'x-api-key': CONFIG.claude.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
    );
    const analysis = r.data.content[0]?.text || 'Could not generate analysis.';
    return `${pnl}\n\n─────────────────\n\n🧠 *Financial Analysis:*\n\n${analysis}`;
  } catch (e) { return `Analysis error: ${e.message}`; }
}

async function getXeroInvoices(status = 'AUTHORISED', days = 30) {
  try {
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0,10);
    const data = await xeroAPI('/Invoices', {
      Statuses: status,
      where: `Date >= DateTime(${since.replace(/-/g,'/')})`,
      order: 'DueDate ASC'
    });
    const invoices = data.Invoices || [];
    if (!invoices.length) return `No ${status.toLowerCase()} invoices in the last ${days} days.`;

    let out = `🧾 *Invoices (${status}) — Last ${days} Days*\n\n`;
    let total = 0;
    invoices.forEach(inv => {
      const due = inv.DueDate ? new Date(inv.DueDate.replace(/\/Date\((\d+)[+-]/,'$1')).toLocaleDateString('en-AU') : '—';
      const amt = inv.Total || 0;
      total += amt;
      const overdue = inv.IsOverdue ? ' ⚠️ OVERDUE' : '';
      out += `• ${inv.Contact?.Name || 'Unknown'} — $${amt.toLocaleString('en-AU',{minimumFractionDigits:2})} due ${due}${overdue}\n`;
    });
    out += `\nTotal: $${total.toLocaleString('en-AU',{minimumFractionDigits:2})}`;
    return out;
  } catch (e) {
    if (e.message.includes('not connected')) return e.message;
    return `Xero invoices error: ${e.response?.data?.Detail || e.message}`;
  }
}

function parseXeroCSV(csvText) {
  const lines = csvText.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split(',').map(h => h.replace(/"/g,'').trim());
  return lines.slice(1).map(line => {
    // Handle quoted commas
    const cols = [];
    let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
    cols.push(cur.trim());
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (cols[i] || '').replace(/"/g,'').trim(); });
    return obj;
  });
}

function getLatestXeroFile(type = 'any') {
  // type: 'pnl', 'transactions', 'any'
  const files = fs.readdirSync(XERO_UPLOADS_PATH)
    .filter(f => f.endsWith('.csv'))
    .filter(f => type === 'any' || f.toLowerCase().includes(type))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(XERO_UPLOADS_PATH, f)).mtime }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? path.join(XERO_UPLOADS_PATH, files[0].name) : null;
}

async function analyseXeroCSV(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const rows = parseXeroCSV(raw);
    if (!rows.length) return 'CSV appears empty or unreadable.';

    // Detect file type by headers
    const headers = Object.keys(rows[0]).map(h => h.toLowerCase());
    const isPnL = headers.some(h => h.includes('account type') || h.includes('gross profit') || h.includes('net profit'));
    const isTransactions = headers.some(h => h.includes('amount') && h.includes('description'));

    const businessCtx = getBusinessContext();
    const mrr = getMRR();

    let dataStr = '';
    if (isPnL) {
      // P&L: summarise by section
      dataStr = `P&L REPORT:\n${raw.substring(0, 6000)}`;
    } else if (isTransactions) {
      // Transactions: group by payee and sum
      const grouped = {};
      let totalSpend = 0;
      for (const row of rows) {
        const amt = parseFloat((row['Amount'] || row['Net Amount'] || row['Debit'] || '0').replace(/[$,()]/g,'')) || 0;
        const name = row['Description'] || row['Payee'] || row['Contact'] || row['Merchant'] || 'Unknown';
        if (amt > 0) {
          grouped[name] = (grouped[name] || 0) + amt;
          totalSpend += amt;
        }
      }
      const sorted = Object.entries(grouped).sort((a,b) => b[1]-a[1]);
      dataStr = `EXPENSE TRANSACTIONS (${rows.length} rows, total $${totalSpend.toFixed(2)}):\n`;
      sorted.slice(0, 30).forEach(([k,v]) => { dataStr += `${k}: $${v.toFixed(2)}\n`; });
    } else {
      dataStr = `RAW DATA (${rows.length} rows):\n${raw.substring(0, 5000)}`;
    }

    const prompt = `You are a no-bullshit financial advisor reviewing the books for JT Visuals — a videography agency run by Jackson Edwards in Gold Coast, Australia.

CURRENT MRR: ${mrr}
TARGET: $1M revenue in 2026

TEAM COSTS: Jackson (owner/director), Tina (PA, Australia), Anthony (full-time editor, France), Anik (editor, part-time)

${dataStr}

Provide a sharp financial analysis:

1. **Margin health** — What is the current profit margin? Is it acceptable for a creative agency (benchmark: 20–35% net)? Be direct.

2. **Top cost concerns** — Which specific line items are too high or suspicious? Give dollar amounts.

3. **Cut immediately** — 3 expenses to cancel or reduce right now. Be specific with names and amounts.

4. **Renegotiate** — What should be renegotiated (software, wages, subscriptions)?

5. **Revenue lever** — One thing to do this month to improve margin without adding clients.

6. **Wage efficiency** — Are staff costs proportionate to revenue? Flag anything out of line.

Be direct, use numbers, give specific actions. No vague advice.`;

    const r = await axios.post('https://api.anthropic.com/v1/messages',
      { model: MODEL_HIGH, max_tokens: 1200, messages: [{ role: 'user', content: prompt }] },
      { headers: { 'x-api-key': CONFIG.claude.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
    );
    return r.data.content[0]?.text || 'Analysis failed.';
  } catch (e) { return `Analysis error: ${e.message}`; }
}

async function getXeroUploadStatus() {
  const files = fs.readdirSync(XERO_UPLOADS_PATH).filter(f => f.endsWith('.csv'));
  if (!files.length) return '📂 No Xero files uploaded yet.\n\nTo get started:\n1. In Xero → Reports → Profit & Loss → Export as CSV\n2. Also export: Accounting → Bank Transactions → Export CSV\n3. Upload both files to: https://nonvalidly-unbudgeted-theresa.ngrok-free.dev/xero-upload';

  const details = files.map(f => {
    const stat = fs.statSync(path.join(XERO_UPLOADS_PATH, f));
    return `• ${f} (${(stat.size/1024).toFixed(0)}KB, uploaded ${stat.mtime.toLocaleDateString('en-AU')})`;
  });
  return `📂 Xero files on file:\n${details.join('\n')}\n\nSay "analyse my finances" to run the analysis.`;
}

// ─── MEMORY ───────────────────────────────────────────────────────────────────
const MEMORY_PATH = path.join(__dirname, 'memory.json');

function loadMemory() {
  if (fs.existsSync(MEMORY_PATH)) {
    try { return JSON.parse(fs.readFileSync(MEMORY_PATH)); } catch(e) { return []; }
  }
  return [];
}

function saveMemory(messages) {
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(messages.slice(-30), null, 2));
}

// ─── GOOGLE AUTH ──────────────────────────────────────────────────────────────
const SCOPES = ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file'];
const TOKEN_PATH = path.join(__dirname, 'google-token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'google-credentials.json');

let _googleAuth = null;

function getGoogleAuth() {
  if (!fs.existsSync(CREDENTIALS_PATH) || !fs.existsSync(TOKEN_PATH)) return null;
  if (_googleAuth) return _googleAuth;

  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH)));

  // When the library auto-refreshes an expired access token, persist the new token to disk
  oAuth2Client.on('tokens', (tokens) => {
    const current = fs.existsSync(TOKEN_PATH) ? JSON.parse(fs.readFileSync(TOKEN_PATH)) : {};
    fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...current, ...tokens }, null, 2));
    console.log('Google token refreshed and saved.');
  });

  _googleAuth = oAuth2Client;
  return _googleAuth;
}

function getGoogleAuthURL() {
  if (!fs.existsSync(CREDENTIALS_PATH)) return null;
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const { client_secret, client_id } = credentials.installed;
  const redirectUri = `https://nonvalidly-unbudgeted-theresa.ngrok-free.dev/google-callback`;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);
  return { url: oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' }), client_id, client_secret, redirectUri };
}

async function authorizeGoogle() {
  const result = getGoogleAuthURL();
  if (!result) return;
  console.log('\nAuthorize Google:\n', result.url);
}

// ─── CALENDAR ─────────────────────────────────────────────────────────────────
async function getCalendarEvents() {
  const auth = getGoogleAuth();
  if (!auth) return 'Google Calendar not connected.';
  const calendar = google.calendar({ version: 'v3', auth });
  const now = new Date(); const end = new Date(); end.setHours(23, 59, 59);
  const res = await calendar.events.list({ calendarId: 'primary', timeMin: now.toISOString(), timeMax: end.toISOString(), singleEvents: true, orderBy: 'startTime' });
  const events = res.data.items;
  if (!events || !events.length) return 'No events today.';
  return events.map(e => {
    const s = e.start.dateTime || e.start.date;
    const time = new Date(s).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', timeZone: CONFIG.owner.timezone });
    return `• ${time} — ${e.summary}`;
  }).join('\n');
}

async function getYesterdayEvents() {
  const auth = getGoogleAuth();
  if (!auth) return '';
  const calendar = google.calendar({ version: 'v3', auth });
  const start = new Date(); start.setDate(start.getDate() - 1); start.setHours(0,0,0,0);
  const end = new Date(start); end.setHours(23,59,59);
  const res = await calendar.events.list({ calendarId: 'primary', timeMin: start.toISOString(), timeMax: end.toISOString(), singleEvents: true, orderBy: 'startTime' });
  const events = res.data.items;
  if (!events || !events.length) return 'Nothing from yesterday.';
  return events.map(e => `• ${e.summary}`).join('\n');
}

async function createCalendarEvent(summary, startTime, endTime, description = '') {
  const auth = getGoogleAuth();
  if (!auth) return 'Google Calendar not connected.';
  const calendar = google.calendar({ version: 'v3', auth });
  const res = await calendar.events.insert({ calendarId: 'primary', resource: { summary, description, start: { dateTime: startTime, timeZone: CONFIG.owner.timezone }, end: { dateTime: endTime, timeZone: CONFIG.owner.timezone } } });
  return `Event created: ${res.data.summary}`;
}

async function deleteCalendarEvent(searchTerm, date = null) {
  try {
    const auth = getGoogleAuth();
    if (!auth) return 'Google Calendar not connected.';
    const calendar = google.calendar({ version: 'v3', auth });
    const timeMin = date ? new Date(date + 'T00:00:00') : new Date();
    timeMin.setDate(timeMin.getDate() - 7); // search back 7 days by default
    const timeMax = new Date(timeMin); timeMax.setDate(timeMax.getDate() + 60);
    const res = await calendar.events.list({
      calendarId: 'primary', timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(),
      q: searchTerm, singleEvents: true, maxResults: 10
    });
    const events = res.data.items || [];
    if (!events.length) return `No events found matching "${searchTerm}".`;
    if (events.length === 1) {
      await calendar.events.delete({ calendarId: 'primary', eventId: events[0].id });
      return `✅ Deleted: "${events[0].summary}"`;
    }
    // Multiple matches — delete the closest one
    const sorted = events.sort((a,b) => new Date(a.start.dateTime||a.start.date) - new Date(b.start.dateTime||b.start.date));
    await calendar.events.delete({ calendarId: 'primary', eventId: sorted[0].id });
    return `✅ Deleted: "${sorted[0].summary}" on ${new Date(sorted[0].start.dateTime||sorted[0].start.date).toLocaleDateString('en-AU')}`;
  } catch(e) { return `Calendar delete error: ${e.message}`; }
}

// ─── GMAIL ────────────────────────────────────────────────────────────────────
async function getUnreadEmails(max = 8) {
  const auth = getGoogleAuth();
  if (!auth) return 'Gmail not connected.';
  const gmail = google.gmail({ version: 'v1', auth });
  const res = await gmail.users.messages.list({ userId: 'me', q: 'is:unread is:inbox', maxResults: max });
  const messages = res.data.messages;
  if (!messages || !messages.length) return 'No unread emails.';
  const details = await Promise.all(messages.slice(0, 8).map(async m => {
    const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From', 'Subject'] });
    const h = msg.data.payload.headers;
    const from = h.find(x => x.name === 'From')?.value?.split('<')[0]?.trim() || 'Unknown';
    const subject = h.find(x => x.name === 'Subject')?.value || 'No subject';
    return `• ${from} — "${subject}"`;
  }));
  return details.join('\n');
}

async function getUnreadEmailsWithBodies(max = 5) {
  const auth = getGoogleAuth();
  if (!auth) return 'Gmail not connected.';
  const gmail = google.gmail({ version: 'v1', auth });
  const res = await gmail.users.messages.list({ userId: 'me', q: 'is:unread is:inbox', maxResults: max });
  const messages = res.data.messages;
  if (!messages || !messages.length) return [];
  const details = await Promise.all(messages.slice(0, 5).map(async m => {
    const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
    const h = msg.data.payload.headers;
    const from = h.find(x => x.name === 'From')?.value || 'Unknown';
    const subject = h.find(x => x.name === 'Subject')?.value || 'No subject';
    const parts = msg.data.payload.parts || [msg.data.payload];
    let body = '';
    for (const part of parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) { body = Buffer.from(part.body.data, 'base64').toString('utf8').substring(0, 800); break; }
    }
    if (!body) body = msg.data.snippet || '';
    return { id: m.id, from, subject, body };
  }));
  return details;
}

async function getSentEmailStyle(max = 20) {
  const auth = getGoogleAuth();
  if (!auth) return '';
  const gmail = google.gmail({ version: 'v1', auth });
  const res = await gmail.users.messages.list({ userId: 'me', q: 'in:sent', maxResults: max });
  const messages = res.data.messages;
  if (!messages || !messages.length) return '';
  const samples = await Promise.all(messages.slice(0, 12).map(async m => {
    const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
    const h = msg.data.payload.headers;
    const to = h.find(x => x.name === 'To')?.value || '';
    const subject = h.find(x => x.name === 'Subject')?.value || '';
    const parts = msg.data.payload.parts || [msg.data.payload];
    let body = '';
    for (const part of parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) { body = Buffer.from(part.body.data, 'base64').toString('utf8').substring(0, 300); break; }
    }
    if (!body) body = msg.data.snippet || '';
    return `To: ${to}\nSubject: ${subject}\n${body}`;
  }));
  return samples.filter(Boolean).join('\n---\n');
}

function getEmailStyle() {
  const stylePath = path.join(__dirname, 'writing-style.json');
  if (fs.existsSync(stylePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(stylePath));
      return data.emailProfile || '';
    } catch(e) {}
  }
  return '';
}

async function draftEmailReply(fromEmail, subject, emailBody) {
  const emailStyle = getEmailStyle();
  const waStyle = getJacksonWritingStyle();
  const prompt = `Draft an email reply on behalf of Jackson Edwards, JT Visuals (info@jtvissuals.com.au), Gold Coast Australia.

JACKSON'S EMAIL STYLE PROFILE:
${emailStyle.substring(0, 2000)}

JACKSON'S WHATSAPP TONE (for reference):
${waStyle.substring(0, 400)}

EMAIL TO REPLY TO:
FROM: ${fromEmail}
SUBJECT: ${subject}
EMAIL: ${emailBody}

Rules:
- Open with "Hey [first name]!" unless it's formal/complaint — then "Hey [first name],"
- Short paragraphs, get to the point fast
- Sign off with just "Jackson"
- No "Kind regards", no filler openers like "Hope you're well"
- Sound like him, not like a corporate email bot
- Write ONLY the email body, nothing else`;

  const response = await axios.post('https://api.anthropic.com/v1/messages',
    { model: MODEL_MID, max_tokens: 600, messages: [{ role: 'user', content: prompt }] },
    { headers: { 'x-api-key': CONFIG.claude.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
  return response.data.content[0].text;
}

async function draftAllUnreadReplies() {
  const emails = await getUnreadEmailsWithBodies(5);
  if (typeof emails === 'string') return emails;
  if (!emails.length) return 'No unread emails to reply to.';
  const drafts = [];
  for (const email of emails) {
    const draft = await draftEmailReply(email.from, email.subject, email.body);
    drafts.push(`EMAIL FROM: ${email.from.split('<')[0].trim()}\nSUBJECT: Re: ${email.subject}\n\n${draft}\n\n${'─'.repeat(20)}`);
  }
  return drafts.join('\n\n');
}

async function sendEmail(to, subject, body) {
  const auth = getGoogleAuth();
  if (!auth) return 'Gmail not connected.';
  const gmail = google.gmail({ version: 'v1', auth });
  const message = [`To: ${to}`, `From: info@jtvissuals.com.au`, `Subject: ${subject}`, '', body].join('\n');
  const encoded = Buffer.from(message).toString('base64').replace(/\+/g,'-').replace(/\//g,'_');
  await gmail.users.messages.send({ userId: 'me', resource: { raw: encoded } });
  return `Email sent to ${to}`;
}

// ─── NOTION ───────────────────────────────────────────────────────────────────
async function getNotionTasks() {
  try {
    const res = await axios.post('https://api.notion.com/v1/search', { filter: { value: 'database', property: 'object' } }, { headers: { 'Authorization': `Bearer ${CONFIG.notion.apiKey}`, 'Notion-Version': '2022-06-28' } });
    if (!res.data.results.length) return 'No Notion databases found.';
    const tasks = await axios.post(`https://api.notion.com/v1/databases/${res.data.results[0].id}/query`, {}, { headers: { 'Authorization': `Bearer ${CONFIG.notion.apiKey}`, 'Notion-Version': '2022-06-28' } });
    const items = tasks.data.results.slice(0, 15);
    if (!items.length) return 'No tasks in Notion.';
    return items.map(t => {
      const title = t.properties?.Name?.title?.[0]?.plain_text || 'Untitled';
      const status = t.properties?.Status?.status?.name || t.properties?.Status?.select?.name || '';
      return `• ${title}${status ? ' ['+status+']' : ''}`;
    }).join('\n');
  } catch(e) { return 'Notion error: ' + e.message; }
}

async function addNotionTask(taskName, notes = '') {
  try {
    const res = await axios.post('https://api.notion.com/v1/search', { filter: { value: 'database', property: 'object' } }, { headers: { 'Authorization': `Bearer ${CONFIG.notion.apiKey}`, 'Notion-Version': '2022-06-28' } });
    const dbId = res.data.results[0]?.id;
    if (!dbId) return 'No Notion database found.';
    await axios.post('https://api.notion.com/v1/pages',
      { parent: { database_id: dbId }, properties: { Name: { title: [{ text: { content: taskName } }] } }, children: notes ? [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: notes } }] } }] : [] },
      { headers: { 'Authorization': `Bearer ${CONFIG.notion.apiKey}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' } });
    return `Task added: ${taskName}`;
  } catch(e) { return 'Notion error: ' + e.message; }
}

// ─── GHL ─────────────────────────────────────────────────────────────────────
async function getStaleGHLLeads() {
  try {
    const res = await axios.get(`https://services.leadconnectorhq.com/contacts/?locationId=${CONFIG.ghl.locationId}&limit=25`, { headers: { 'Authorization': `Bearer ${CONFIG.ghl.apiKey}`, 'Version': '2021-07-28' } });
    const contacts = res.data.contacts || [];
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const stale = contacts.filter(c => new Date(c.dateUpdated || c.dateAdded) < cutoff).slice(0, 8);
    if (!stale.length) return 'All leads followed up.';
    return stale.map(c => `• ${c.firstName || 'Unknown'} ${c.lastName || ''} — ${new Date(c.dateUpdated || c.dateAdded).toLocaleDateString('en-AU')}`).join('\n');
  } catch(e) { return 'GHL error: ' + e.message; }
}

async function createGHLLead(name, phone, type, budget) {
  try {
    await axios.post(`https://services.leadconnectorhq.com/contacts/?locationId=${CONFIG.ghl.locationId}`, { firstName: name, phone, tags: ['Chief of Staff', type], source: 'WhatsApp' }, { headers: { 'Authorization': `Bearer ${CONFIG.ghl.apiKey}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' } });
    return `Lead added: ${name} — ${type} — ${budget}`;
  } catch(e) { return 'GHL error: ' + e.message; }
}

async function getGHLCalendars() {
  try {
    const res = await axios.get(`https://services.leadconnectorhq.com/calendars/?locationId=${CONFIG.ghl.locationId}`, { headers: { 'Authorization': `Bearer ${CONFIG.ghl.apiKey}`, 'Version': '2021-07-28' } });
    return res.data.calendars || [];
  } catch(e) { return []; }
}

async function findOrCreateGHLContact(name, phone, email) {
  const headers = { 'Authorization': `Bearer ${CONFIG.ghl.apiKey}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' };
  // Search by name
  try {
    const res = await axios.get(`https://services.leadconnectorhq.com/contacts/`, {
      headers,
      params: { locationId: CONFIG.ghl.locationId, query: name, limit: 5 }
    });
    const contacts = res.data?.contacts || [];
    if (contacts.length > 0) {
      console.log('GHL contact found:', contacts[0].id, contacts[0].firstName);
      return contacts[0].id;
    }
  } catch(e) { console.error('GHL contact search error:', e.response?.data || e.message); }

  // Create contact
  try {
    const body = { locationId: CONFIG.ghl.locationId, firstName: name.split(' ')[0], lastName: name.split(' ').slice(1).join(' ') || '' };
    if (phone) body.phone = phone;
    if (email) body.email = email;
    const res = await axios.post('https://services.leadconnectorhq.com/contacts/', body, { headers });
    const id = res.data?.contact?.id || res.data?.id;
    console.log('GHL contact created:', id);
    return id || null;
  } catch(e) {
    console.error('GHL contact create error:', e.response?.data || e.message);
    return null;
  }
}

async function getGHLUserId() {
  if (CONFIG.ghl.userId) return CONFIG.ghl.userId;
  try {
    const res = await axios.get(`https://services.leadconnectorhq.com/users/?locationId=${CONFIG.ghl.locationId}`, {
      headers: { 'Authorization': `Bearer ${CONFIG.ghl.apiKey}`, 'Version': '2021-07-28' }
    });
    const users = res.data?.users || [];
    if (users.length) {
      CONFIG.ghl.userId = users[0].id;
      saveConfig(CONFIG);
      console.log('GHL userId cached:', CONFIG.ghl.userId);
      return CONFIG.ghl.userId;
    }
  } catch(e) { console.error('GHL user fetch error:', e.response?.data || e.message); }
  return null;
}


async function addGHLContactNote(contactId, note) {
  try {
    await axios.post(`https://services.leadconnectorhq.com/contacts/${contactId}/notes`, { body: note }, {
      headers: { 'Authorization': `Bearer ${CONFIG.ghl.apiKey}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' }
    });
    console.log('GHL note added to contact:', contactId);
  } catch(e) {
    console.error('GHL note error:', e.response?.data || e.message);
  }
}

const GHL_PIPELINES = {
  sales:   { id: 'EE1U9nWnxfuXgivFcSXe', name: 'Sales Pipeline',     stages: { 'new lead': '95c24930-e6db-42da-8553-e40dd6ef72a0', 'call booked': '258b2bd3-066d-4685-8a6b-29e52fca19d5', 'paid': '4e1dc721-492c-41fa-8b5e-97d3da518bc2', 'shoot booked': 'bb7bf228-615e-43e4-a9d0-3dd53753b4ec', 'lost': 'f9262368-6424-47c5-9003-9f56e6c0b7df' } },
  editing: { id: 'wXoVKnrp4kBQxwtIwdlS', name: 'Editing/Production', stages: { 'shoot booked': 'b1ddbed4-4ba9-46a7-8b32-63c8de5a28e9', 'files uploaded': 'c514ccf7-516c-41b8-a7d3-7d1d71ddf467', 'editing started': '79a014d1-5464-4b28-9276-61a8801ad037', '50% complete': 'df5fc2f9-7cfd-4e69-94d8-2cc093b98436', 'internal review': '56bc4baa-e5cc-4716-ac37-ec4353e89fe3', 'ready for review': 'f0b40d2e-5627-47d0-a04b-5123e260358d', 'editor revisions': '94c6284c-b200-40dc-b238-c1cc006b1ddf', 'completed': 'f0ef4bb5-bbe1-4585-a466-0076f7b1f383' } },
};

async function createGHLOpportunity(contactName, contactPhone, title, pipeline, stage, value) {
  try {
    const headers = { 'Authorization': `Bearer ${CONFIG.ghl.apiKey}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' };
    const pipeKey = pipeline?.toLowerCase().includes('edit') ? 'editing' : 'sales';
    const pip = GHL_PIPELINES[pipeKey];
    const stageKey = (stage || '').toLowerCase();
    const stageId = pip.stages[stageKey] || pip.stages['new lead'] || Object.values(pip.stages)[0];
    const contactId = await findOrCreateGHLContact(contactName, contactPhone || '', '');

    const body = {
      pipelineId: pip.id,
      locationId: CONFIG.ghl.locationId,
      name: title || `${contactName} — ${pip.name}`,
      pipelineStageId: stageId,
      status: 'open',
    };
    if (contactId) body.contactId = contactId;
    if (value) body.monetaryValue = parseFloat(String(value).replace(/[^0-9.]/g,'')) || 0;

    const res = await axios.post('https://services.leadconnectorhq.com/opportunities/', body, { headers });
    const opp = res.data?.opportunity || res.data;
    return `✅ Opportunity created in GHL!\n\n*${body.name}*\nPipeline: ${pip.name}\nStage: ${stage || 'New Lead'}${value ? `\nValue: $${body.monetaryValue.toLocaleString()}` : ''}`;
  } catch(e) { return `GHL opportunity error: ${e.response?.data?.message || e.message}`; }
}

// ─── SMS ──────────────────────────────────────────────────────────────────────
async function sendSMS(to, message) {
  try {
    const fromNumber = CONFIG.twilio?.smsNumber;
    if (!fromNumber) return '❌ No SMS number configured. Add twilio.smsNumber to config.json (your Twilio phone number, e.g. +61412345678).';
    const toFormatted = to.startsWith('+') ? to : `+61${to.replace(/^0/,'')}`;
    const client = require('twilio')(CONFIG.twilio.accountSid, CONFIG.twilio.authToken);
    const msg = await client.messages.create({ body: message, from: fromNumber, to: toFormatted });
    return `✅ SMS sent to ${toFormatted} (SID: ${msg.sid})`;
  } catch(e) { return `SMS error: ${e.message}`; }
}

// ─── VOICE TRANSCRIPTION ──────────────────────────────────────────────────────
async function transcribeAudio(mediaUrl) {
  try {
    const deepgramKey = CONFIG.deepgram?.apiKey;
    if (!deepgramKey) return null;
    // Download audio from Twilio (needs auth)
    const audioRes = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      auth: { username: CONFIG.twilio.accountSid, password: CONFIG.twilio.authToken }
    });
    const audioBuffer = Buffer.from(audioRes.data);
    // Send to Deepgram
    const res = await axios.post(
      'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&language=en-AU',
      audioBuffer,
      { headers: { 'Authorization': `Token ${deepgramKey}`, 'Content-Type': audioRes.headers['content-type'] || 'audio/ogg' } }
    );
    return res.data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || null;
  } catch(e) { console.error('Transcription error:', e.message); return null; }
}

// ─── FRAME.IO V4 OAuth ────────────────────────────────────────────────────────
const FRAMEIO_CLIENT_ID = process.env.FRAMEIO_CLIENT_ID || CONFIG.frameio?.clientId || '';
const FRAMEIO_CLIENT_SECRET = process.env.FRAMEIO_CLIENT_SECRET || CONFIG.frameio?.clientSecret || '';
const FRAMEIO_REDIRECT = process.env.FRAMEIO_REDIRECT || CONFIG.frameio?.redirect || '';
let frameioTokens = null;

function loadFrameIOTokens() {
  const p = path.join(__dirname, 'frameio-token.json');
  if (fs.existsSync(p)) { try { frameioTokens = JSON.parse(fs.readFileSync(p)); console.log('Frame.io token loaded — will reauth if 401 occurs.'); } catch(e) {} }
}

function saveFrameIOTokens(tokens) {
  frameioTokens = tokens;
  fs.writeFileSync(path.join(__dirname, 'frameio-token.json'), JSON.stringify(tokens, null, 2));
}

async function refreshFrameIOToken() {
  if (!frameioTokens?.refresh_token) return false;
  try {
    const res = await axios.post('https://ims-na1.adobelogin.com/ims/token/v3', new URLSearchParams({ grant_type: 'refresh_token', client_id: FRAMEIO_CLIENT_ID, client_secret: FRAMEIO_CLIENT_SECRET, refresh_token: frameioTokens.refresh_token }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    saveFrameIOTokens({ ...res.data, created_at: Date.now() });
    console.log('Frame.io token refreshed.');
    return true;
  } catch(e) {
    console.log('Frame.io refresh failed:', e.message);
    frameioTokens = null;
    return false;
  }
}

async function getFrameIOHeaders() {
  if (!frameioTokens) return null;
  // Refresh proactively if within 5 mins of expiry
  if (frameioTokens.expires_in && Date.now() > (frameioTokens.created_at + (frameioTokens.expires_in - 300) * 1000)) {
    const refreshed = await refreshFrameIOToken();
    if (!refreshed) return null;
  }
  return frameioTokens?.access_token ? { 'Authorization': `Bearer ${frameioTokens.access_token}` } : null;
}

async function getRecentFrameIOUploads() {
  let headers = await getFrameIOHeaders();
  if (!headers) return 'Frame.io not connected Boss. Say "connect frameio" to reauthorise.';
  try {
    const me = await axios.get('https://api.frame.io/v4/accounts', { headers });
    const accountId = me.data?.data?.[0]?.id;
    if (!accountId) return 'Frame.io: no account found.';
    const projects = await axios.get(`https://api.frame.io/v4/accounts/${accountId}/projects?page_size=5`, { headers });
    const recentFiles = [];
    for (const project of (projects.data?.data || []).slice(0, 4)) {
      const assets = await axios.get(`https://api.frame.io/v4/projects/${project.id}/assets?page_size=3`, { headers });
      for (const asset of (assets.data?.data || []).slice(0, 2)) recentFiles.push(`• [${project.name}] ${asset.name}`);
    }
    return recentFiles.length ? recentFiles.join('\n') : 'No recent uploads.';
  } catch(e) {
    // If 401, clear tokens and prompt reauth
    if (e.response?.status === 401) {
      frameioTokens = null;
      const tokenFile = path.join(__dirname, 'frameio-token.json');
      if (fs.existsSync(tokenFile)) fs.unlinkSync(tokenFile);
      return 'Frame.io session expired Boss. Say "connect frameio" to reauthorise.';
    }
    return 'Frame.io error: ' + e.message;
  }
}

// ─── SEND WHATSAPP ────────────────────────────────────────────────────────────
async function sendToJackson(message) {
  const client = twilio(CONFIG.twilio.accountSid, CONFIG.twilio.authToken);
  const trimmed = message.length > 1500 ? message.substring(0, 1450) + '...' : message;
  await client.messages.create({ from: CONFIG.twilio.sandboxNumber, to: CONFIG.owner.whatsapp, body: trimmed });
}

// ─── CLAUDE ───────────────────────────────────────────────────────────────────
async function askClaude(userMessage, systemOverride = null, model = MODEL_MID) {
  const writingStyle = getJacksonWritingStyle();
  const memoryContext = getMemoryContext();
  const system = systemOverride || `You are the AI Chief of Staff for Jackson Edwards, owner of JT Visuals videography agency in Gold Coast, Australia.

JACKSON'S WRITING STYLE:
${writingStyle ? writingStyle.substring(0, 800) : 'Casual, direct, professional but friendly.'}

JT VISUALS PRICING:
${JT_PRICING}

ACTIVE CLIENTS (these are the ONLY 12 clients — never invent others):
Alpha Physiques, Hattie (Flex Method), Cade, Jese Smith, Sarah, Raw Reality, Jess Richards, CoreCoach, Morgan, Kingbodies, Harry Drew, Pantry Girl

STRICT RULES — violating any of these is a failure:
- Always call Jackson "Boss". Never "Jackson" in replies.
- Maximum 2-3 sentences unless Boss asks for more detail.
- NEVER use markdown. No ## headers. No ** bold**. No bullet dashes in prose. Plain text and emoji only. Any markdown in your response is a failure.
- Max 1 emoji per message.
- Never invent client names, data, or facts not provided to you.
- When listing clients, ONLY use the 9 active clients listed above. Never fabricate others.
- When asked for a list, return ONLY the list items — no preamble.
- Never add filler phrases like "Great question" or "Of course".
- Never count how many times Boss has run a command.
- Never tell Boss to stop doing something or start doing something.
- Never use phrases like: analysis paralysis, stop scanning, make money, burn daylight, productivity, optimise, leverage.
- Never lecture Jackson. Never give unsolicited advice on his behaviour or habits.
- Never comment on how often he checks things. Just report the data.
- Just report facts. No opinions on his behaviour or choices.
- Professional but warm — trusted EA, not a robot and not a life coach.
${memoryContext ? '\n' + memoryContext : ''}`;

  const history = loadMemory();
  history.push({ role: 'user', content: userMessage });
  const response = await axios.post('https://api.anthropic.com/v1/messages',
    { model, max_tokens: 500, system, messages: history },
    { headers: { 'x-api-key': CONFIG.claude.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
  const reply = response.data.content[0].text;
  history.push({ role: 'assistant', content: reply });
  saveMemory(history);
  return reply;
}

// ─── MARKET RESEARCH ──────────────────────────────────────────────────────────
async function doMarketResearch() {
  const response = await axios.post('https://api.anthropic.com/v1/messages',
    { model: MODEL_MID, max_tokens: 800, tools: [{ type: 'web_search_20250305', name: 'web_search' }], messages: [{ role: 'user', content: 'Research current social media trends for a videography agency in Gold Coast Australia working with fitness coaches. Find: 1) Top performing video formats on Instagram Reels and TikTok for fitness content right now 2) What ads are working for online fitness coaches 3) Trending audio in fitness content. Concise bullet points, max 3 per category.' }] },
    { headers: { 'x-api-key': CONFIG.claude.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
  const text = response.data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  return text || 'Could not fetch trends right now.';
}

// ─── AGENT TOOLS ──────────────────────────────────────────────────────────────
const TOOLS = [
  { name: 'get_mrr',                 description: 'Get current MRR breakdown across all active clients', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'log_sales_call',          description: 'Log a sales call outcome — closed or lost',
    input_schema: { type: 'object', required: ['name','outcome'], properties: { name: { type: 'string' }, outcome: { type: 'string', description: '"closed" or "lost"' }, value: { type: 'string', description: 'e.g. $3,500/month' }, reason: { type: 'string', description: 'Why they lost or won' }, notes: { type: 'string' } } }
  },
  { name: 'get_close_rate',          description: 'Get sales close rate report and pipeline breakdown', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'set_renewal',             description: 'Set a client renewal date',
    input_schema: { type: 'object', required: ['client','date'], properties: { client: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD' } } }
  },
  { name: 'get_renewals',            description: 'Get all client renewal dates and alerts', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'create_preprod',          description: 'Create a pre-production checklist for an upcoming shoot',
    input_schema: { type: 'object', required: ['client','shoot_date'], properties: { client: { type: 'string' }, shoot_date: { type: 'string', description: 'YYYY-MM-DD' }, notes: { type: 'string' } } }
  },
  { name: 'add_nurture_lead',        description: 'Add a lead to the nurture follow-up sequence (day 1, 3, 7, 14, 30)',
    input_schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, contact: { type: 'string' }, niche: { type: 'string' }, budget: { type: 'string' }, source: { type: 'string' }, notes: { type: 'string' } } }
  },
  { name: 'get_nurture_leads',       description: 'Get all active leads in the nurture sequence', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'get_monday_tasks',        description: 'Get tasks from Monday.com boards — Jackson, Anthony, Alik, or Tina',
    input_schema: { type: 'object', properties: { board: { type: 'string', description: '"jackson", "anthony", "alik", "tina", "all", "projects", "expenses"' } }, required: [] }
  },
  { name: 'create_monday_task',      description: 'Create a new task on a Monday.com board',
    input_schema: { type: 'object', required: ['task_name'], properties: { board: { type: 'string', description: '"jackson", "anthony", "alik", "tina" — default jackson' }, task_name: { type: 'string' }, status: { type: 'string', description: 'e.g. "Working on it", "Done", "Not Started"' }, due_date: { type: 'string', description: 'YYYY-MM-DD' } } }
  },
  { name: 'update_monday_status',    description: 'Update the status of a Monday.com task by item ID',
    input_schema: { type: 'object', required: ['item_id','status'], properties: { item_id: { type: 'string' }, status: { type: 'string', description: '"Done", "Working on it", "Stuck", "Not Started"' }, board: { type: 'string' } } }
  },
  { name: 'search_monday_task',      description: 'Search for a task by name on a Monday.com board to get its ID',
    input_schema: { type: 'object', required: ['search'], properties: { search: { type: 'string' }, board: { type: 'string', description: 'default jackson' } } }
  },
  { name: 'analyse_calls',           description: 'Analyse recent Fireflies sales calls for patterns, objections, and what closes deals', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'get_response_times',      description: 'Get WhatsApp response time report for all active clients', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'get_group_tasks',         description: 'Get open action items detected from client WhatsApp groups', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'scan_group_tasks',        description: 'Rescan all client WhatsApp groups for new action items right now', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'get_calendar',            description: "Get today's calendar events", input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'get_yesterday_events',    description: "Get yesterday's calendar events", input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'schedule_appointment',    description: 'Schedule a call or appointment — books in GHL CRM and Google Calendar simultaneously. Use this for any "schedule a call", "book a meeting", "set up a time" request.',
    input_schema: { type: 'object', required: ['title','start','end'], properties: {
      title:        { type: 'string', description: 'e.g. "Sales call with John Smith"' },
      start:        { type: 'string', description: 'ISO 8601 datetime e.g. 2026-03-11T10:00:00' },
      end:          { type: 'string', description: 'ISO 8601 datetime' },
      contact_name: { type: 'string', description: 'Name of the person the call is with' },
      contact_phone:{ type: 'string' },
      notes:        { type: 'string' }
    }}
  },
  { name: 'create_calendar_event',   description: 'Create a Google Calendar event. Only use this if Boss explicitly says "add to Google Calendar". For all calls, shoots, and client meetings use schedule_appointment instead.',
    input_schema: { type: 'object', required: ['summary','start','end'], properties: {
      summary:     { type: 'string' },
      start:       { type: 'string', description: 'ISO 8601 datetime e.g. 2026-03-11T10:00:00' },
      end:         { type: 'string', description: 'ISO 8601 datetime' },
      description: { type: 'string' }
    }}
  },
  { name: 'get_emails',              description: 'Get unread Gmail inbox emails', input_schema: { type: 'object', properties: { max: { type: 'number' } }, required: [] } },
  { name: 'draft_email_replies',     description: "Draft replies to all unread emails in Jackson's style", input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'send_email',              description: 'Send an email from Jackson\'s Gmail. Confirm with Boss before calling.',
    input_schema: { type: 'object', required: ['to','subject','body'], properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } } }
  },
  { name: 'get_notion_tasks',        description: 'Fetch open tasks from Notion', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'add_notion_task',         description: 'Add a task to Notion',
    input_schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, notes: { type: 'string' } } }
  },
  { name: 'get_stale_leads',         description: 'Get GHL leads with no contact in 48h+', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'add_lead',                description: 'Add a new lead to GHL CRM',
    input_schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, phone: { type: 'string' }, type: { type: 'string' }, budget: { type: 'string' } } }
  },
  { name: 'get_whatsapp_inbound',    description: 'Get recent inbound WhatsApp messages (last 24h)', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'get_unanswered_whatsapp', description: 'Get people waiting for a reply from Jackson on WhatsApp', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'get_frameio_uploads',     description: 'Get recent Frame.io uploads across projects', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'get_wins',                description: 'Get the win tracker summary', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'log_win',                 description: 'Log a new client win',
    input_schema: { type: 'object', required: ['client','package','value'], properties: { client: { type: 'string' }, package: { type: 'string' }, value: { type: 'string' }, notes: { type: 'string' } } }
  },
  { name: 'get_quotes',              description: 'Get pending draft quotes', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'generate_quote',          description: 'Generate a pricing quote draft for a lead',
    input_schema: { type: 'object', required: ['lead'], properties: { lead: { type: 'string' }, contact: { type: 'string' }, videos: { type: 'number' }, months: { type: 'number' }, addons: { type: 'string' }, notes: { type: 'string' } } }
  },
  { name: 'get_deadlines',           description: 'Get active editor deadlines', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'add_deadline',            description: 'Track a new editor deadline after a shoot',
    input_schema: { type: 'object', required: ['client','shoot_date'], properties: { client: { type: 'string' }, shoot_date: { type: 'string', description: 'YYYY-MM-DD' }, editor: { type: 'string' } } }
  },
  { name: 'mark_deadline_done',      description: 'Mark an editor deadline as complete',
    input_schema: { type: 'object', required: ['client','type'], properties: { client: { type: 'string' }, type: { type: 'string', description: '"internal" = editor cut done, "client" = full delivery done' } } }
  },
  { name: 'get_checkins',            description: 'Get clients overdue for a 30-day check-in', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'mark_checkin',            description: 'Mark a client check-in as done', input_schema: { type: 'object', required: ['client'], properties: { client: { type: 'string' } } } },
  { name: 'get_cold_leads',          description: 'Get cold leads with follow-ups due (day 3, 7, or 14)', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'add_cold_lead',           description: 'Track a new cold lead for follow-up sequence',
    input_schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, contact: { type: 'string' }, notes: { type: 'string' } } }
  },
  { name: 'get_shoot_briefing',      description: "Get today's shoot briefing from calendar", input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'post_shoot_checklist',    description: 'Get the post-shoot checklist for a client', input_schema: { type: 'object', required: ['client'], properties: { client: { type: 'string' } } } },
  { name: 'draft_client_reply',      description: "Draft a WhatsApp reply to a client in Jackson's voice",
    input_schema: { type: 'object', required: ['client','question'], properties: { client: { type: 'string' }, question: { type: 'string', description: "The client's message" } } }
  },
  { name: 'generate_reel_ideas',     description: 'Generate reel content ideas for a client',
    input_schema: { type: 'object', required: ['client'], properties: { client: { type: 'string' }, count: { type: 'number' } } }
  },
  { name: 'generate_hooks',          description: 'Generate video hook lines for a topic',
    input_schema: { type: 'object', required: ['topic'], properties: { topic: { type: 'string' }, count: { type: 'number' } } }
  },
  { name: 'analyse_xero_financials', description: 'Analyse uploaded Xero CSV files — P&L, expenses, profit margin — with AI recommendations to cut costs and improve margins. Use when Jackson asks about finances, expenses, profit, or money.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  { name: 'get_xero_status',         description: 'Check what Xero CSV files have been uploaded and when',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  { name: 'generate_quote_pdf',      description: 'Generate a professional PDF proposal/quote for a client and upload to Google Drive',
    input_schema: { type: 'object', required: ['client_name','packages'], properties: {
      client_name:  { type: 'string' },
      client_email: { type: 'string' },
      packages:     { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, price: { type: 'string' }, description: { type: 'string' } } }, description: 'List of packages/line items with name, price, and optional description' },
      notes:        { type: 'string', description: 'Any additional notes to include' },
      valid_days:   { type: 'number', description: 'Days until proposal expires (default 14)' }
    }}
  },
  { name: 'generate_weekly_report_pdf', description: 'Generate a weekly business report PDF covering MRR, calendar, tasks, and leads',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  { name: 'generate_content_calendar_sheet', description: 'Create a Google Sheets content calendar for a client with weeks of planned posts',
    input_schema: { type: 'object', required: ['client'], properties: { client: { type: 'string' }, weeks: { type: 'number', description: 'Number of weeks (default 4)' } } }
  },
  { name: 'generate_production_schedule_sheet', description: 'Create a Google Sheets production schedule for all active clients',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  { name: 'generate_expense_sheet',  description: 'Create a blank Google Sheets expense tracker ready to fill in',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  { name: 'generate_pnl_sheet',      description: 'Create a Google Sheets P&L tracker pre-filled with all client MRR and expense categories',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  { name: 'connect_google',          description: 'Generate a Google OAuth link to connect or reconnect Google (Calendar, Gmail, Sheets)',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  { name: 'delete_calendar_event',   description: 'Delete a Google Calendar event by searching for it by name or keyword',
    input_schema: { type: 'object', required: ['search'], properties: { search: { type: 'string', description: 'Name or keyword of the event to delete' }, date: { type: 'string', description: 'Optional: date to narrow search (YYYY-MM-DD)' } } }
  },
  { name: 'send_sms',                description: 'Send an SMS text message to any phone number via Twilio',
    input_schema: { type: 'object', required: ['to','message'], properties: { to: { type: 'string', description: 'Phone number e.g. 0412345678 or +61412345678' }, message: { type: 'string', description: 'The SMS message to send' } } }
  },
  { name: 'create_ghl_opportunity',  description: 'Create a new opportunity/deal in GoHighLevel CRM — use for new leads or production jobs',
    input_schema: { type: 'object', required: ['contact_name','title'], properties: {
      contact_name:  { type: 'string', description: 'Name of the contact/client' },
      contact_phone: { type: 'string', description: 'Phone number (optional, used to find/create contact)' },
      title:         { type: 'string', description: 'Opportunity title e.g. "Alpha Physiques — Monthly Retainer"' },
      pipeline:      { type: 'string', description: '"sales" or "editing" — default sales' },
      stage:         { type: 'string', description: 'Sales: "new lead", "call booked", "paid", "shoot booked", "lost" | Editing: "shoot booked", "files uploaded", "editing started", "50% complete", "internal review", "ready for review", "editor revisions", "completed"' },
      value:         { type: 'string', description: 'Monetary value e.g. "3500" or "$3,500/month"' }
    }}
  },
  { name: 'web_research',            description: 'Search the web to research anything — competitor pricing, industry trends, platform changes, lead intel, tools, news. Use this whenever Jackson asks to look something up, research a topic, or find information you don\'t know.',
    input_schema: { type: 'object', required: ['query'], properties: {
      query: { type: 'string', description: 'What to search for' },
      deep:  { type: 'boolean', description: 'true for thorough research with bullet points and analysis, false (default) for a quick direct answer' }
    }}
  },
  { name: 'get_analytics',           description: 'Get Instagram and TikTok analytics dashboard — follower count, reach, impressions, top posts',
    input_schema: { type: 'object', properties: { days: { type: 'number', description: 'Number of days to look back (default 7)' }, platform: { type: 'string', description: '"instagram", "tiktok", or "all" (default all)' } }, required: [] }
  },
  { name: 'connect_metricool',       description: 'Save Metricool credentials (userToken, userId, blogId) to enable analytics',
    input_schema: { type: 'object', required: ['user_token','user_id','blog_id'], properties: { user_token: { type: 'string' }, user_id: { type: 'string' }, blog_id: { type: 'string' } } }
  },
  { name: 'generate_caption',        description: 'Write an Instagram caption for a client',
    input_schema: { type: 'object', required: ['topic'], properties: { topic: { type: 'string' }, client: { type: 'string' } } }
  },
  { name: 'generate_content_calendar', description: 'Generate a 4-week content calendar for a client', input_schema: { type: 'object', required: ['client'], properties: { client: { type: 'string' } } } },
  { name: 'full_scan',               description: 'Full status scan: calendar, email, tasks, leads, WhatsApp, Frame.io, deadlines, check-ins', input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'update_config',           description: 'Update a config value (dot-notation key)',
    input_schema: { type: 'object', required: ['key','value'], properties: { key: { type: 'string', description: 'e.g. "schedule.briefingHour"' }, value: { type: 'string' } } }
  },
];

// ─── TOOL EXECUTOR ────────────────────────────────────────────────────────────
async function executeTool(name, input) {
  switch (name) {
    case 'get_mrr':                   return getMRR();
    case 'log_sales_call':            return logSalesCall(input.name, input.outcome, input.value||'', input.reason||'', input.notes||'');
    case 'get_close_rate':            return getCloseRateReport();
    case 'set_renewal':               return setRenewal(input.client, input.date);
    case 'get_renewals':              return getRenewals();
    case 'create_preprod': {
      const result = createPreprodChecklist(input.client, input.shoot_date, input.notes||'');
      return `${result.message}\n\n${result.checklist}`;
    }
    case 'add_nurture_lead':          return addNurtureLead(input.name, input.contact||'', input.niche||'', input.budget||'', input.source||'', input.notes||'');
    case 'get_nurture_leads':         return getNurtureLeads();
    case 'get_monday_tasks':          return input.board === 'all' ? await getAllMondayTasks() : await getMondayTasks(input.board || 'jackson');
    case 'create_monday_task':        return await createMondayTask(input.board || 'jackson', input.task_name, input.status || '', '', input.due_date || '');
    case 'update_monday_status':      return await updateMondayTaskStatus(input.item_id, input.status);
    case 'search_monday_task':        return await searchMondayTask(input.board || 'jackson', input.search);
    case 'analyse_calls':             return await analysePastCalls();
    case 'get_response_times':        return getResponseTimeReport();
    case 'get_group_tasks':           return await getOpenGroupTasks();
    case 'scan_group_tasks':          await checkClientGroupTasks(); return 'Scan complete.';
    case 'get_calendar':              return await getCalendarEvents();
    case 'get_yesterday_events':      return await getYesterdayEvents();
    case 'schedule_appointment': {
      const contactId = input.contact_name ? await findOrCreateGHLContact(input.contact_name, input.contact_phone || '', '') : null;
      const calResult = await createCalendarEvent(input.title, input.start, input.end, input.notes || '');
      if (contactId) {
        const readableTime = new Date(input.start).toLocaleString('en-AU', { timeZone: CONFIG.owner.timezone, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hour12: true });
        await addGHLContactNote(contactId, `📅 Call scheduled: ${input.title} on ${readableTime}`);
      }
      return `Booked: ${input.title} at ${input.start}. Added to Google Calendar${contactId ? ' and noted on GHL contact' : ''}.`;
    }
    case 'create_calendar_event':
      return await createCalendarEvent(input.summary, input.start, input.end, input.description || '');
    case 'get_emails':                return await getUnreadEmails(input.max || 8);
    case 'draft_email_replies':       return await draftAllUnreadReplies();
    case 'send_email': {
      const id = queueApproval('send_email',
        { to: input.to, subject: input.subject, body: input.body },
        `EMAIL TO: ${input.to}\nSUBJECT: ${input.subject}\n\n${input.body.substring(0, 300)}`
      );
      return `Queued for approval [ID: ${id}]\n\nTo: ${input.to}\nSubject: ${input.subject}\n\n${input.body.substring(0, 200)}\n\nReply "approve ${id}" to send or "deny ${id}" to cancel.`;
    }
    case 'get_notion_tasks':          return await getNotionTasks();
    case 'add_notion_task':           return await addNotionTask(input.name, input.notes || '');
    case 'get_stale_leads':           return await getStaleGHLLeads();
    case 'add_lead': {
      const id = queueApproval('add_lead',
        { name: input.name, phone: input.phone || '', type: input.type || '', budget: input.budget || '' },
        `NEW LEAD: ${input.name} | ${input.type || 'type unknown'} | ${input.budget || 'budget unknown'}`
      );
      return `Queued for approval [ID: ${id}]\n\nAdd to GHL: ${input.name} (${input.type || 'no type'}, ${input.budget || 'no budget'})\n\nReply "approve ${id}" to add or "deny ${id}" to cancel.`;
    }
    case 'get_whatsapp_inbound':      return getRecentInboundMessages(24);
    case 'get_unanswered_whatsapp':   return getUnansweredMessages();
    case 'get_frameio_uploads':       return await getRecentFrameIOUploads();
    case 'get_wins':                  return getWinsSummary();
    case 'log_win':                   saveWin(input.client, input.package, input.value, input.notes || ''); return `Win logged: ${input.client} — ${input.package} — ${input.value} 🏆`;
    case 'get_quotes':                return getPendingQuotes();
    case 'generate_quote':            return await generateQuoteDraft(input.lead, input.contact || '', input.videos || 20, input.months || 3, input.addons || '', input.notes || '');
    case 'get_deadlines':             return getActiveDeadlines();
    case 'add_deadline': {
      const d = addEditorDeadline(input.client, input.shoot_date, input.editor || '');
      return `Deadline tracked for ${input.client}. Editor due: ${new Date(d.internalDeadline).toLocaleDateString('en-AU', {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}`;
    }
    case 'mark_deadline_done': {
      const deadlines = loadDeadlines();
      const dl = deadlines.find(d => d.client.toLowerCase().includes((input.client||'').toLowerCase()) && !d.clientDone);
      if (!dl) return `No active deadline found for ${input.client}.`;
      if (input.type === 'internal') dl.internalDone = true;
      else { dl.internalDone = true; dl.clientDone = true; }
      fs.writeFileSync(DEADLINES_PATH, JSON.stringify(deadlines, null, 2));
      return `${input.client} ${input.type} deadline marked done ✅`;
    }
    case 'get_checkins': {
      const overdue = getClientsNeedingCheckin();
      if (!overdue.length) return 'All clients checked in within 30 days.';
      return 'Check-ins due:\n' + overdue.map(c => `${c.name} (${c.value})${c.daysSince ? ' — ' + c.daysSince + 'd ago' : ' — never'}`).join('\n');
    }
    case 'mark_checkin':              return markCheckInDone(input.client);
    case 'get_cold_leads':            return (await getColdLeadFollowUps()) || 'No cold lead follow-ups due.';
    case 'add_cold_lead':             return addColdLead(input.name, input.contact || '', null, input.notes || '');
    case 'get_shoot_briefing':        return (await getTodayShootBriefing()) || 'No shoot in your calendar today.';
    case 'post_shoot_checklist':      return getPostShootChecklist(input.client);
    case 'draft_client_reply':        return await draftClientReply(input.client, input.question);
    case 'generate_reel_ideas':       return await generateReelIdeas(input.client, input.count || 8);
    case 'generate_hooks':            return await generateHooks(input.topic, input.count || 8);
    case 'analyse_xero_financials': {
      const filePath = getLatestXeroFile('any');
      if (!filePath) return '❌ No Xero CSV uploaded yet. Go to:\nhttps://nonvalidly-unbudgeted-theresa.ngrok-free.dev/xero-upload\n\nExport your P&L or transactions from Xero → Reports → Export CSV, then upload it there.';
      return await analyseXeroCSV(filePath);
    }
    case 'get_xero_status':           return await getXeroUploadStatus();
    case 'generate_quote_pdf': {
      const filePath = await generateQuotePDF({ clientName: input.client_name, clientEmail: input.client_email || '', packages: input.packages || [], notes: input.notes || '', validDays: input.valid_days || 14 });
      const driveUrl = await uploadPDFToDrive(filePath, path.basename(filePath));
      return driveUrl ? `✅ Quote PDF ready Boss!\n\n📄 ${driveUrl}` : `✅ Quote saved locally: ${filePath}`;
    }
    case 'generate_weekly_report_pdf': {
      const filePath = await generateWeeklyReportPDF();
      const driveUrl = await uploadPDFToDrive(filePath, path.basename(filePath));
      return driveUrl ? `✅ Weekly report ready!\n\n📄 ${driveUrl}` : `✅ Report saved locally: ${filePath}`;
    }
    case 'generate_content_calendar_sheet': {
      const url = await generateContentCalendarSheet(input.client, input.weeks || 4);
      return `✅ Content calendar created!\n\n📊 ${url}`;
    }
    case 'generate_production_schedule_sheet': {
      const url = await generateProductionScheduleSheet();
      return `✅ Production schedule created!\n\n📊 ${url}`;
    }
    case 'generate_expense_sheet': {
      const url = await generateExpenseSheet();
      return `✅ Expense tracker created!\n\n📊 ${url}`;
    }
    case 'generate_pnl_sheet': {
      const url = await generatePnLSheet();
      return `✅ P&L tracker created!\n\n📊 ${url}`;
    }
    case 'connect_google':            return `Open this link to connect Google Boss:\nhttps://nonvalidly-unbudgeted-theresa.ngrok-free.dev/google-auth\n\nSign in and approve all permissions. I'll message you when it's done.`;
    case 'delete_calendar_event':     return await deleteCalendarEvent(input.search, input.date || null);
    case 'send_sms':                  return await sendSMS(input.to, input.message);
    case 'create_ghl_opportunity':    return await createGHLOpportunity(input.contact_name, input.contact_phone || '', input.title, input.pipeline || 'sales', input.stage || 'new lead', input.value || '');
    case 'get_xero_pnl':              return await getXeroPnL(input.months || 3);
    case 'get_xero_expenses':         return await getXeroExpenses(input.days || 30);
    case 'get_xero_invoices':         return await getXeroInvoices(input.status || 'AUTHORISED', input.days || 30);
    case 'web_research':              return await webSearch(input.query, input.deep || false);
    case 'get_analytics': {
      const days = input.days || 7;
      const platform = (input.platform || 'all').toLowerCase();
      if (platform === 'instagram') return await getInstagramAnalytics(days);
      if (platform === 'tiktok') return await getTikTokAnalytics();
      return await getFullAnalyticsDashboard(days);
    }
    case 'connect_metricool': {
      CONFIG.metricool = { userToken: input.user_token, userId: input.user_id, blogId: input.blog_id };
      fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(CONFIG, null, 2));
      const test = await getInstagramAnalytics(7);
      if (test.includes('❌')) return `Credentials saved but test failed: ${test}`;
      return `✅ Metricool connected! Analytics are live. Try "show my analytics"`;
    }
    case 'generate_caption':          return await generateCaption(input.topic, input.client || '');
    case 'generate_content_calendar': return await generateContentCalendar(input.client);
    case 'update_config':             return updateConfig(input.key, input.value);
    case 'full_scan': {
      const [cal, emails, tasks, leads, unanswered, frameio] = await Promise.all([
        getCalendarEvents(), getUnreadEmails(5), getNotionTasks(), getStaleGHLLeads(),
        Promise.resolve(getUnansweredMessages()), getRecentFrameIOUploads()
      ]);
      const checkins = getClientsNeedingCheckin();
      const deadlines = getActiveDeadlines();
      return `CALENDAR:\n${cal}\n\nEMAILS:\n${emails}\n\nTASKS:\n${tasks}\n\nSTALE LEADS:\n${leads}\n\nUNANSWERED WHATSAPP:\n${unanswered}\n\nFRAME.IO:\n${frameio}\n\nEDITOR DEADLINES:\n${deadlines}\n\nCHECK-INS DUE:\n${checkins.length ? checkins.map(c=>c.name).join('\n') : 'All good'}`;
    }
    default: return `Unknown tool: ${name}`;
  }
}

// ─── AGENT LOOP ───────────────────────────────────────────────────────────────
function getBusinessContext() {
  const p = path.join(__dirname, 'business-context.json');
  if (fs.existsSync(p)) { try { return JSON.parse(fs.readFileSync(p)); } catch(e) {} }
  return {};
}

async function runAgentLoop(userMessage) {
  const writingStyle = getJacksonWritingStyle();
  const memoryContext = getMemoryContext();
  const biz = getBusinessContext();
  const nowBrisbane = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date());
  const system = `You are the AI Chief of Staff for Jackson Edwards, owner of JT Visuals videography agency in Gold Coast, Australia.

CURRENT DATE/TIME (Brisbane): ${nowBrisbane}
When scheduling anything, always use this as "now" and calculate dates from it. Never guess the year.

BUSINESS CONTEXT:
Revenue target: $1,000,000/year. Current MRR: $36,800/month. Short-term target: $12,000/month minimum, $15,000/month PT package side.
Lead sources: referrals, website inbound, social media. No close rate tracked yet.
Ideal clients: fitness coaches, online PTs, construction, real estate — on retainer, organised, growth-focused.

TEAM:
- Tina (PA): backend systems, admin, calendar, client profiles, dashboards
- Anthony (Editor, France): post-production, daily editing tasks, content delivery
- Anik (Editor): post-production, daily editing tasks, EOD delivery

DELIVERY PROCESS: Pre-production → Shoot → Frame.io upload → Editor assigns → Internal review → Revisions → Client review → Final delivery
Biggest bottleneck: missing files/B-roll not supplied right after shoot.

TOOLS STACK: Frame.io, Monday.com, Dropbox, Slack, Zapier, Pixieset, Adobe Premiere Pro, GHL, Notion, Google Calendar, Tally.so

AUTOMATION PRIORITIES: client follow-up, task handoff, analytics reporting, caption QC, meeting notes, Notion page creation, production bottleneck reduction.

JACKSON'S WRITING STYLE:
${writingStyle ? writingStyle.substring(0, 800) : 'Casual, direct, professional but friendly.'}

JT VISUALS PRICING:
${JT_PRICING}

ACTIVE CLIENTS (these are the ONLY 12 clients — never invent others):
Alpha Physiques, Hattie (Flex Method), Cade, Jese Smith, Sarah, Raw Reality, Jess Richards, CoreCoach, Morgan, Kingbodies, Harry Drew, Pantry Girl

STRICT RULES — violating any of these is a failure:
- Always call Jackson "Boss". Never "Jackson" in replies.
- Maximum 2-3 sentences unless Boss asks for more detail.
- NEVER use markdown. No ## headers. No ** bold**. No bullet dashes in prose. Plain text and emoji only. Any markdown in your response is a failure.
- Max 1 emoji per message.
- Never invent client names, data, or facts not provided to you.
- When listing clients, ONLY use the 9 active clients listed above. Never fabricate others.
- When asked for a list, return ONLY the list items — no preamble.
- Never add filler phrases like "Great question" or "Of course".
- Never count how many times Boss has run a command.
- Never use phrases like: analysis paralysis, stop scanning, make money, burn daylight, productivity, optimise, leverage.
- Never lecture Jackson. Never give unsolicited advice on his behaviour or habits.
- Never comment on how often he checks things. Just report the data.
- Just report facts. No opinions on his behaviour or choices.
- Professional but warm — trusted EA, not a robot and not a life coach.
- Use tools to fetch live data before answering questions about calendar, emails, tasks, leads, etc. Never make up data.
- For multi-step requests, chain tools in sequence without asking for confirmation between steps — except before send_email.
- When Boss asks to schedule or book anything, call schedule_appointment IMMEDIATELY with the time Boss specified. NEVER check calendar availability first. NEVER say a time is busy. Just book it.
${memoryContext ? '\n' + memoryContext : ''}`;

  const history = loadMemory();
  history.push({ role: 'user', content: userMessage });

  // messages tracks the full in-flight exchange including tool_use/tool_result blocks
  // history tracks only clean user/assistant text pairs for persistent memory
  const messages = [...history];
  const MAX_STEPS = 10;

  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: MODEL_HIGH,
      max_tokens: 1024,
      system,
      tools: TOOLS,
      messages,
    }, { headers: { 'x-api-key': CONFIG.claude.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });

    const { stop_reason, content } = response.data;
    messages.push({ role: 'assistant', content });

    if (stop_reason === 'end_turn') {
      const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      history.push({ role: 'assistant', content: text || 'Done.' });
      saveMemory(history);
      return text || 'Done Boss.';
    }

    if (stop_reason === 'tool_use') {
      const toolUseBlocks = content.filter(b => b.type === 'tool_use');
      const toolResults = [];
      for (const block of toolUseBlocks) {
        console.log(`Agent → ${block.name}`, JSON.stringify(block.input));
        let result;
        try { result = await executeTool(block.name, block.input); }
        catch (e) { result = `Error running ${block.name}: ${e.message}`; }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: String(result) });
      }
      messages.push({ role: 'user', content: toolResults });
    }
  }

  saveMemory(history);
  return 'Ran into too many steps Boss — try rephrasing.';
}

// ─── BRIEFINGS ────────────────────────────────────────────────────────────────
async function send5amBriefing() {
  console.log('Sending 5am briefing...');
  try {
    const [calendar, yesterday, emails, tasks, leads, unanswered, frameio] = await Promise.all([
      getCalendarEvents(), getYesterdayEvents(), getUnreadEmails(6),
      getNotionTasks(), getStaleGHLLeads(), Promise.resolve(getUnansweredMessages()), getRecentFrameIOUploads()
    ]);
    const shootBriefing = await getTodayShootBriefing();
    const deadlines = getActiveDeadlines();
    const checkins = getClientsNeedingCheckin();
    const coldFollowUps = await getColdLeadFollowUps();
    const today = new Date().toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: CONFIG.owner.timezone });

    const prompt = `5am briefing for Jackson Edwards, JT Visuals Gold Coast. Sharp, punchy, plain text only — no markdown headers, no bold, no asterisks.

DATE: ${today}
CALENDAR: ${calendar}
YESTERDAY: ${yesterday}
EMAILS: ${emails}
TASKS: ${tasks}
STALE LEADS: ${leads}
UNANSWERED WHATSAPP: ${unanswered}
FRAME.IO: ${frameio}
DEADLINES: ${deadlines}
CHECK-INS DUE: ${checkins.length ? checkins.slice(0,3).map(c=>c.name).join(', ') : 'None'}
${shootBriefing ? 'SHOOT TODAY: ' + shootBriefing.substring(0,300) : ''}
${coldFollowUps ? 'COLD FOLLOW-UPS DUE: ' + coldFollowUps.substring(0,200) : ''}

Start with: Good morning Boss! ☀️ [date]
Then cover: top priorities, schedule, emails, unanswered WhatsApp, stale leads, open tasks, check-ins if any.
Plain text only. Call him Boss. Never lecture. Never comment on how often he scans. Max 25 lines.`;

    const briefing = await askClaude(prompt, 'You write sharp morning briefings in plain text — no markdown, no headers, no bold, no asterisks. Direct and actionable. Call him Boss. Never lecture.');
    await sendToJackson(briefing);
    console.log('5am briefing sent!');
  } catch(e) {
    console.error('Briefing error:', e.message);
    await sendToJackson(`Morning Boss! Briefing error: ${e.message}. Say "full scan" for priorities.`);
  }
}

async function sendMiddayReminder() {
  try {
    const [leads, unanswered] = await Promise.all([getStaleGHLLeads(), Promise.resolve(getUnansweredMessages())]);
    const deadlineAlerts = checkUpcomingDeadlines();
    if (deadlineAlerts.length) await sendToJackson('Deadline alert Boss!\n\n' + deadlineAlerts.join('\n'));
    const prompt = `Quick midday check-in for Jackson Edwards, JT Visuals Gold Coast. 3-4 lines. Start "Midday check Boss 👋". Plain text only, no markdown.
Pending leads: ${leads} | Unanswered WhatsApp: ${unanswered}`;
    await sendToJackson(await askClaude(prompt, 'Write a brief midday nudge. 4 lines max. Plain text only.', MODEL_LOW));
  } catch(e) { console.error('Midday error:', e.message); }
}

async function sendEODWrap() {
  try {
    const [tasks, leads, unanswered] = await Promise.all([getNotionTasks(), getStaleGHLLeads(), Promise.resolve(getUnansweredMessages())]);
    const deadlineAlerts = checkUpcomingDeadlines();
    const prompt = `EOD wrap for Jackson Edwards, JT Visuals. 5-6 lines. Start "EOD wrap Boss 🎬". Plain text only, no markdown.
Tasks: ${tasks} | Leads: ${leads} | Unanswered: ${unanswered}
${deadlineAlerts.length ? 'DEADLINE ALERTS: ' + deadlineAlerts.join(', ') : ''}
Top 2 priorities for tomorrow.`;
    await sendToJackson(await askClaude(prompt, 'Write a brief EOD summary. 6 lines max. Plain text only.', MODEL_LOW));
  } catch(e) { console.error('EOD error:', e.message); }
}

async function sendWeeklyReview() {
  console.log('Sending weekly review...');
  try {
    const [tasks, leads, unanswered] = await Promise.all([getNotionTasks(), getStaleGHLLeads(), Promise.resolve(getUnansweredMessages())]);
    const wins = loadWins();
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const thisWeek = wins.filter(w => new Date(w.date) > weekAgo);
    const usage = loadUsageTracking();
    const topCommands = Object.entries(usage.commands).sort((a,b)=>b[1].count-a[1].count).slice(0,5).map(([cmd,data])=>`${cmd} (${data.count}x)`).join(', ');
    const coldFollowUps = await getColdLeadFollowUps();
    const checkins = getClientsNeedingCheckin();
    const deadlines = getActiveDeadlines();

    const prompt = `Sunday weekly review for Jackson Edwards, JT Visuals. Sharp, personal, actionable. Plain text only — no markdown, no bold, no headers with ##.

WINS THIS WEEK: ${thisWeek.length ? thisWeek.map(w=>`${w.client} — ${w.value}`).join(', ') : 'No wins logged this week'}
OPEN TASKS: ${tasks}
PENDING LEADS: ${leads}
UNANSWERED WHATSAPP: ${unanswered}
DEADLINES: ${deadlines}
CHECK-INS DUE: ${checkins.length ? checkins.map(c=>c.name).join(', ') : 'All good'}
COLD FOLLOW-UPS: ${coldFollowUps || 'None'}
MOST USED THIS WEEK: ${topCommands || 'Not enough data'}

Cover: wins, still pending, priorities this week, client check-ins, one honest insight.
Keep it real. Max 20 lines. Call him Boss. Plain text only.`;

    await sendToJackson(await askClaude(prompt, 'Write sharp weekly business reviews. Direct, no fluff. Plain text only — no markdown, no bold, no ## headers.'));
    console.log('Weekly review sent!');
  } catch(e) { console.error('Weekly review error:', e.message); }
}

async function sendCheckinPrompts() {
  const overdue = getClientsNeedingCheckin();
  if (!overdue.length) return;
  const lines = overdue.map(c => `${c.name} (${c.value})${c.daysSince ? ' — ' + c.daysSince + 'd since last check-in' : ' — never checked in'}`);
  await sendToJackson(`30-day check-ins due Boss 👥\n\n${lines.join('\n')}\n\nSay "checked in with [name]" to mark done.`);
}

// ─── UNANSWERED CLIENT MESSAGE CHECKER (every 5 mins) ────────────────────────
const ALERTED_MESSAGES_PATH = path.join(__dirname, 'alerted-messages.json');

function loadAlertedMessages() {
  if (fs.existsSync(ALERTED_MESSAGES_PATH)) {
    try { return new Set(JSON.parse(fs.readFileSync(ALERTED_MESSAGES_PATH))); } catch(e) {}
  }
  return new Set();
}

function saveAlertedMessages(set) {
  // Keep only last 500 to prevent file bloat
  const arr = [...set].slice(-500);
  fs.writeFileSync(ALERTED_MESSAGES_PATH, JSON.stringify(arr));
}

function getUnansweredClientMessages() {
  const oneHourAgoCoreData = (Date.now() / 1000 - 3600) - 978307200;
  const twoDaysAgoCoreData = (Date.now() / 1000 - 172800) - 978307200;

  // Get last message in each chat — flag ones where last msg is FROM them, older than 1hr
  const sql = `SELECT m.Z_PK, COALESCE(s.ZPARTNERNAME, m.ZPUSHNAME, '') as name, m.ZTEXT, m.ZMESSAGEDATE
    FROM ZWAMESSAGE m
    LEFT JOIN ZWACHATSESSION s ON m.ZCHATSESSION = s.Z_PK
    WHERE m.ZMESSAGEDATE = (SELECT MAX(ZMESSAGEDATE) FROM ZWAMESSAGE m2 WHERE m2.ZCHATSESSION = m.ZCHATSESSION)
    AND m.ZISFROMME = 0
    AND m.ZTEXT IS NOT NULL AND m.ZTEXT != ''
    AND m.ZMESSAGEDATE < ${oneHourAgoCoreData}
    AND m.ZMESSAGEDATE > ${twoDaysAgoCoreData}
    ORDER BY m.ZMESSAGEDATE DESC LIMIT 30;`;

  const raw = queryWhatsApp(sql);
  if (!raw) return [];

  const clientNames = JT_BUSINESS_CLIENTS.map(c => c.name.toLowerCase());

  return raw.split('\n').map(line => {
    const parts = line.split('|');
    return { pk: parts[0]?.trim(), name: parts[1]?.trim(), text: parts[2]?.trim(), ts: parseFloat(parts[3]) };
  }).filter(m => {
    if (!m.name || !m.text || !m.pk) return false;
    const nameLower = m.name.toLowerCase();
    return clientNames.some(cn => nameLower.includes(cn.split(' ')[0].toLowerCase()));
  });
}

async function checkUnansweredClientMessages() {
  try {
    const messages = getUnansweredClientMessages();
    if (!messages.length) return;

    const alerted = loadAlertedMessages();
    const newMessages = messages.filter(m => !alerted.has(m.pk));
    if (!newMessages.length) return;

    const writingStyle = getJacksonWritingStyle();

    for (const msg of newMessages) {
      const client = JT_BUSINESS_CLIENTS.find(c => msg.name.toLowerCase().includes(c.name.split(' ')[0].toLowerCase()));
      const hoursAgo = Math.round((Date.now() / 1000 - (msg.ts + 978307200)) / 3600 * 10) / 10;

      const prompt = `Draft a short WhatsApp reply from Jackson Edwards to ${msg.name} (${client?.niche || 'client'}, package: ${client?.package || 'content creation'}).
Their message: "${msg.text}"
Jackson's writing style (recent messages): ${writingStyle ? writingStyle.substring(0, 400) : 'Casual, direct, friendly'}
Rules: Sound exactly like Jackson. Casual Australian tone. Under 2 sentences. No emojis unless Jackson uses them. Just the reply text, nothing else.`;

      const r = await axios.post('https://api.anthropic.com/v1/messages',
        { model: MODEL_LOW, max_tokens: 150, messages: [{ role: 'user', content: prompt }] },
        { headers: { 'x-api-key': CONFIG.claude.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });

      const draft = r.data.content[0].text;
      await sendToJackson(`${msg.name} (${hoursAgo}h ago): "${msg.text}"\n\nDraft reply:\n${draft}`);

      alerted.add(msg.pk);
    }

    saveAlertedMessages(alerted);
  } catch(e) {
    console.error('Unanswered message checker error:', e.message);
  }
}

function startUnansweredChecker() {
  setInterval(checkUnansweredClientMessages, 5 * 60 * 1000);
  console.log('Unanswered client message checker running every 5 mins');
}

// ─── EMAIL CHECKER (every 5 mins) ────────────────────────────────────────────
const ALERTED_EMAILS_PATH = path.join(__dirname, 'alerted-emails.json');

function loadAlertedEmails() {
  if (fs.existsSync(ALERTED_EMAILS_PATH)) {
    try { return new Set(JSON.parse(fs.readFileSync(ALERTED_EMAILS_PATH))); } catch(e) {}
  }
  return new Set();
}

function saveAlertedEmails(set) {
  fs.writeFileSync(ALERTED_EMAILS_PATH, JSON.stringify([...set].slice(-500)));
}

async function checkUnansweredEmails() {
  try {
    const auth = getGoogleAuth();
    if (!auth) return;
    const gmail = google.gmail({ version: 'v1', auth });

    // Get emails older than 1 hour that are still unread
    const oneHourAgo = Math.floor((Date.now() - 3600000) / 1000);
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: `is:unread is:inbox before:${oneHourAgo}`,
      maxResults: 10
    });

    const messages = res.data.messages || [];
    if (!messages.length) return;

    const alerted = loadAlertedEmails();
    const newMessages = messages.filter(m => !alerted.has(m.id));
    if (!newMessages.length) return;

    const emailStyle = getEmailStyle();

    for (const m of newMessages.slice(0, 3)) {
      try {
        const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
        const h = msg.data.payload.headers;
        const from = h.find(x => x.name === 'From')?.value || 'Unknown';
        const subject = h.find(x => x.name === 'Subject')?.value || '(no subject)';
        const date = h.find(x => x.name === 'Date')?.value || '';

        let body = '';
        const parts = msg.data.payload.parts || [msg.data.payload];
        for (const part of parts) {
          if (part.mimeType === 'text/plain' && part.body?.data) {
            body = Buffer.from(part.body.data, 'base64').toString('utf8').substring(0, 600);
            break;
          }
        }
        if (!body) body = msg.data.snippet || '';

        const hoursAgo = Math.round((Date.now() - new Date(date).getTime()) / 3600000 * 10) / 10;

        const draft = await draftEmailReply(from, subject, body);
        const fromName = from.split('<')[0].trim().replace(/"/g, '');
        await sendToJackson(`Email (${hoursAgo}h ago) from ${fromName}:\nSubject: ${subject}\n\nDraft reply:\n${draft}`);

        alerted.add(m.id);
      } catch(e) { console.error('Email checker item error:', e.message); }
    }

    saveAlertedEmails(alerted);
  } catch(e) {
    console.error('Email checker error:', e.message);
  }
}

function startEmailChecker() {
  setInterval(checkUnansweredEmails, 5 * 60 * 1000);
  console.log('Unanswered email checker running every 5 mins');
}

// ─── RESPONSE TIME REPORT ─────────────────────────────────────────────────────
function getResponseTimeReport() {
  const clientNames = JT_BUSINESS_CLIENTS.map(c => c.name);
  const twoDaysAgoCoreData = (Date.now() / 1000 - 172800) - 978307200;
  const results = [];

  for (const client of clientNames) {
    const firstName = client.split(' ')[0];
    // Get all messages in this client's chat from last 48h, ordered by time
    const sql = `SELECT m.ZISFROMME, m.ZMESSAGEDATE FROM ZWAMESSAGE m
      LEFT JOIN ZWACHATSESSION s ON m.ZCHATSESSION = s.Z_PK
      WHERE (s.ZPARTNERNAME LIKE '%${firstName}%')
      AND m.ZTEXT IS NOT NULL AND m.ZTEXT != ''
      AND m.ZMESSAGEDATE > ${twoDaysAgoCoreData}
      ORDER BY m.ZMESSAGEDATE ASC;`;

    const raw = queryWhatsApp(sql);
    if (!raw) continue;

    const msgs = raw.split('\n').map(line => {
      const parts = line.split('|');
      return { fromMe: parts[0]?.trim() === '1', ts: parseFloat(parts[1]) };
    }).filter(m => !isNaN(m.ts));

    if (msgs.length < 2) continue;

    // Find response times: time between their message and Jackson's next reply
    const responseTimes = [];
    for (let i = 0; i < msgs.length - 1; i++) {
      if (!msgs[i].fromMe) {
        // Find next message from Jackson
        for (let j = i + 1; j < msgs.length; j++) {
          if (msgs[j].fromMe) {
            const mins = Math.round((msgs[j].ts - msgs[i].ts) / 60);
            if (mins > 0 && mins < 1440) responseTimes.push(mins); // ignore >24hr gaps
            break;
          }
        }
      }
    }

    if (responseTimes.length) {
      const avg = Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length);
      const avgStr = avg < 60 ? `${avg}m` : `${Math.round(avg / 60 * 10) / 10}h`;
      results.push({ name: client, avg, avgStr, count: responseTimes.length });
    }
  }

  if (!results.length) return 'No response data in the last 48h Boss.';

  results.sort((a, b) => b.avg - a.avg);
  const overallAvg = Math.round(results.reduce((s, r) => s + r.avg, 0) / results.length);
  const overallStr = overallAvg < 60 ? `${overallAvg}m` : `${Math.round(overallAvg / 60 * 10) / 10}h`;

  const lines = results.map(r => {
    const flag = r.avg > 120 ? ' ⚠️' : r.avg > 60 ? ' 🟡' : ' ✅';
    return `${r.name}: ${r.avgStr}${flag}`;
  });

  return `Response times (last 48h) Boss\nAverage: ${overallStr}\n\n${lines.join('\n')}`;
}

async function sendDailyResponseReport() {
  try {
    const report = getResponseTimeReport();
    await sendToJackson(report);
  } catch(e) { console.error('Response report error:', e.message); }
}

// ─── CLIENT GROUP TASK SCANNER ───────────────────────────────────────────────
const CLIENT_GROUPS = [
  // Client groups
  { name: 'Alpha Physiques', jid: '120363404692586938@g.us' },
  { name: 'Hattie (Flex Method)', jid: '120363406476336157@g.us' },
  { name: 'Jese Smith', jid: '120363422043939750@g.us' },
  { name: 'CoreCoach', jid: '120363423161635535@g.us' },
  { name: 'Kingbodies', jid: '120363402284858924@g.us' },
  { name: 'Pantry Girl', jid: '120363407843193014@g.us' },
  { name: 'Raw Reality', jid: '120363407442656440@g.us' },
  { name: 'Jess Richards', jid: '120363423326751113@g.us' },
  { name: 'Morgan', jid: '120363423867050524@g.us' },
  { name: 'Harry Drew', jid: '120363426032270324@g.us' },
  { name: 'NLP', jid: '120363402438874395@g.us' },
  // Team group
  { name: 'JT Team', jid: '120363420205328440@g.us' },
  // Staff (individual chats)
  { name: 'Tina (PA)', jid: '61414340284@s.whatsapp.net' },
  { name: 'Anthony Legeay', jid: '33625953533@s.whatsapp.net' },
  { name: 'Anik', jid: '191547018604728@lid' },
];

const GROUP_TASKS_PATH = path.join(__dirname, 'group-tasks.json');

function loadGroupTasks() {
  if (fs.existsSync(GROUP_TASKS_PATH)) {
    try { return JSON.parse(fs.readFileSync(GROUP_TASKS_PATH)); } catch(e) {}
  }
  return {};
}

function saveGroupTasks(tasks) {
  fs.writeFileSync(GROUP_TASKS_PATH, JSON.stringify(tasks, null, 2));
}

function getGroupMessages(jid, hours = 48) {
  const cutoff = (Date.now() / 1000 - hours * 3600) - 978307200;
  const sql = `SELECT m.ZISFROMME, COALESCE(m.ZPUSHNAME, 'Unknown') as sender, m.ZTEXT, m.ZMESSAGEDATE
    FROM ZWAMESSAGE m
    LEFT JOIN ZWACHATSESSION s ON m.ZCHATSESSION = s.Z_PK
    WHERE s.ZCONTACTJID = '${jid}'
    AND m.ZTEXT IS NOT NULL AND m.ZTEXT != ''
    AND m.ZMESSAGEDATE > ${cutoff}
    ORDER BY m.ZMESSAGEDATE ASC;`;
  const raw = queryWhatsApp(sql);
  if (!raw) return [];
  return raw.split('\n').map(line => {
    const parts = line.split('|');
    return {
      fromMe: parts[0]?.trim() === '1',
      sender: parts[1]?.trim(),
      text: parts[2]?.trim(),
      ts: parseFloat(parts[3])
    };
  }).filter(m => m.text && !isNaN(m.ts));
}

async function scanGroupForTasks(group) {
  const messages = getGroupMessages(group.jid, 48);
  if (messages.length < 2) return [];

  const transcript = messages.map(m =>
    `[${m.fromMe ? 'Jackson' : m.sender}]: ${m.text}`
  ).join('\n');

  const prompt = `Analyse this WhatsApp group conversation between Jackson Edwards (JT Visuals) and client ${group.name}.

CONVERSATION (last 48h):
${transcript.substring(0, 3000)}

Identify ONLY concrete action items that Jackson needs to do — things that were requested, agreed to, or are clearly expected of him.
Ignore general chat, compliments, questions already answered, or things Jackson already confirmed doing.

Return a JSON array like:
[{"task": "Send edited reels by Friday", "urgency": "high|medium|low", "from": "who asked"}]

If there are no action items for Jackson, return [].
Return ONLY the JSON array, nothing else.`;

  try {
    const r = await axios.post('https://api.anthropic.com/v1/messages',
      { model: MODEL_LOW, max_tokens: 400, messages: [{ role: 'user', content: prompt }] },
      { headers: { 'x-api-key': CONFIG.claude.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
    const text = r.data.content[0].text.trim();
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    return JSON.parse(match[0]).map(t => ({ ...t, group: group.name, detectedAt: new Date().toISOString() }));
  } catch(e) { return []; }
}

async function checkClientGroupTasks() {
  try {
    const allTasks = loadGroupTasks();
    const newTasks = [];

    for (const group of CLIENT_GROUPS) {
      const tasks = await scanGroupForTasks(group);
      for (const task of tasks) {
        // Deduplicate by task text similarity
        const key = `${group.name}:${task.task.substring(0, 50).toLowerCase().replace(/\s+/g, ' ')}`;
        if (!allTasks[key]) {
          allTasks[key] = { ...task, alertedAt: new Date().toISOString(), done: false };
          newTasks.push(task);
        }
      }
    }

    saveGroupTasks(allTasks);

    if (newTasks.length) {
      const urgent = newTasks.filter(t => t.urgency === 'high');
      const rest = newTasks.filter(t => t.urgency !== 'high');
      let msg = `Tasks from client groups Boss:\n\n`;
      if (urgent.length) msg += urgent.map(t => `🔴 ${t.group}: ${t.task}`).join('\n') + '\n\n';
      if (rest.length) msg += rest.map(t => `• ${t.group}: ${t.task}`).join('\n');
      await sendToJackson(msg.trim());
    }
  } catch(e) { console.error('Group task scanner error:', e.message); }
}

async function getOpenGroupTasks() {
  const allTasks = loadGroupTasks();
  const open = Object.values(allTasks).filter(t => !t.done);
  if (!open.open) {
    // Re-scan if no tasks found
    await checkClientGroupTasks();
    return;
  }
  if (!open.length) return 'No open tasks from client groups Boss.';
  const urgent = open.filter(t => t.urgency === 'high');
  const rest = open.filter(t => t.urgency !== 'high');
  let msg = 'Open tasks from client groups Boss:\n\n';
  if (urgent.length) msg += urgent.map(t => `🔴 ${t.group}: ${t.task}`).join('\n') + '\n\n';
  if (rest.length) msg += rest.map(t => `• ${t.group}: ${t.task}`).join('\n');
  return msg.trim();
}

// ─── DEADLINE CHECKER (every 30 mins) ────────────────────────────────────────
function startDeadlineChecker() {
  setInterval(async () => {
    try {
      const alerts = checkUpcomingDeadlines();
      if (alerts.length) await sendToJackson('Deadline alert Boss! \n\n' + alerts.join('\n'));
    } catch(e) {}
  }, 30 * 60 * 1000);
  console.log('Deadline checker running every 30 mins');
}

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────

const ACTIVE_CLIENTS_MRR = [
  { name: "Alpha Physiques", mrr: 4000 },
  { name: "Hattie", mrr: 4000 },
  { name: "Cade", mrr: 4200 },
  { name: "Jese Smith", mrr: 5000 },
  { name: "Sarah", mrr: 4000 },
  { name: "Raw Reality", mrr: 2383 },  // $550/week × 52/12
  { name: "Jess Richards", mrr: 1000 },
  { name: "CoreCoach", mrr: 3900 },
  { name: "Morgan", mrr: 1517 },        // $350/week × 52/12
  { name: "Kingbodies", mrr: 2700 },
  { name: "Harry Drew", mrr: 1900 },
  { name: "Pantry Girl", mrr: 2200 },
];
function getMRR() {
  const mrr = ACTIVE_CLIENTS_MRR.reduce((sum, c) => sum + c.mrr, 0);
  const list = ACTIVE_CLIENTS_MRR.map(c => "- " + c.name + ": $" + c.mrr.toLocaleString()).join("\n");
  return "Current MRR: $" + mrr.toLocaleString() + "/month Boss\n" + list;
}

const LONGTERM_MEMORY_PATH = path.join(__dirname, 'longterm-memory.json');

function saveLongtermMemory(fact) {
  let data = [];
  try { data = JSON.parse(fs.readFileSync(LONGTERM_MEMORY_PATH)); } catch(e) {}
  data.push({ fact: fact, date: new Date().toISOString() });
  fs.writeFileSync(LONGTERM_MEMORY_PATH, JSON.stringify(data, null, 2));
  return 'Got it Boss, I will remember that.';
}

function getLongtermMemory() {
  try {
    const data = JSON.parse(fs.readFileSync(LONGTERM_MEMORY_PATH));
    if (!data.length) return 'No saved memories yet Boss.';
    return 'What I remember Boss:\n' + data.map(m => '- ' + m.fact + ' (' + m.date.substring(0,10) + ')').join('\n');
  } catch(e) { return 'No saved memories yet Boss.'; }
}

function getMemoryContext() {
  try {
    const data = JSON.parse(fs.readFileSync(LONGTERM_MEMORY_PATH));
    if (!data.length) return '';
    return 'Long-term memory:\n' + data.map(m => '- ' + m.fact).join('\n');
  } catch(e) { return ''; }
}
// ─── PENDING APPROVALS ────────────────────────────────────────────────────────
const PENDING_PATH = path.join(__dirname, 'pending-approvals.json');

function loadPending() {
  try { return JSON.parse(fs.readFileSync(PENDING_PATH)); } catch(e) { return []; }
}

function queueApproval(type, data, preview) {
  const pending = loadPending();
  const id = String(Date.now()).slice(-5); // short 5-digit ID easy to type
  pending.push({ id, type, data, preview, createdAt: new Date().toISOString() });
  fs.writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2));
  return id;
}

function getApproval(id) {
  const pending = loadPending();
  if (id) return pending.find(p => p.id === String(id));
  return pending[pending.length - 1] || null;
}

function removeApproval(id) {
  const pending = loadPending().filter(p => p.id !== String(id));
  fs.writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2));
}

function listPending() {
  const pending = loadPending();
  if (!pending.length) return 'No pending approvals Boss.';
  return 'Pending approvals:\n' + pending.map(p => `• [${p.id}] ${p.type}: ${p.preview.split('\n')[0]}`).join('\n');
}

async function executeApproval(item) {
  switch (item.type) {
    case 'send_email':             return await sendEmail(item.data.to, item.data.subject, item.data.body);
    case 'create_calendar_event':  return await createCalendarEvent(item.data.summary, item.data.start, item.data.end, item.data.description || '');
    case 'add_lead':               return await createGHLLead(item.data.name, item.data.phone || '', item.data.type || '', item.data.budget || '');
    case 'dev_task':               return await runDevTask(item.data.instruction);
    default:                       return `Unknown action type: ${item.type}`;
  }
}

// ─── DEV MODE ─────────────────────────────────────────────────────────────────
async function runDevTask(instruction) {
  let query;
  try { ({ query } = require('@anthropic-ai/claude-agent-sdk')); }
  catch(e) { return 'Claude Code SDK not installed Boss. Run: npm install @anthropic-ai/claude-agent-sdk'; }

  // Auto-restart after code changes
  const needsRestart = /install|npm|package|require|new feature|add.*tool|implement/i.test(instruction);

  let output = '';
  const toolsUsed = new Set();

  for await (const message of query({
    prompt: `You are autonomously improving the JT Visuals Chief of Staff server (${path.join(__dirname, 'server.js')}).
Working directory: ${__dirname}
Task: ${instruction}

Rules:
- If the task requires an npm package, run: npm install <package> --save
- If you need to research something, use WebSearch or WebFetch to find the best approach
- Read the existing server.js first to understand the patterns before editing
- Be surgical — only change what is needed
- After completing, summarise what you changed in 2-3 plain text sentences. No markdown.`,
    options: {
      cwd: __dirname,
      allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'],
      permissionMode: 'acceptEdits',
      allowDangerouslySkipPermissions: true,
      env: { ANTHROPIC_API_KEY: CONFIG.claude.apiKey, ...process.env },
    }
  })) {
    if (message.type === 'assistant') {
      for (const block of message.message?.content || []) {
        if ('text' in block && block.text) output += block.text;
        if ('name' in block) toolsUsed.add(block.name);
      }
    }
  }

  const summary = output.trim().substring(0, 900);
  const tools = toolsUsed.size ? `\nTools used: ${[...toolsUsed].join(', ')}` : '';
  const result = (summary || 'Done Boss.') + tools;

  // Auto-restart if packages were installed or code was changed significantly
  if (needsRestart) {
    setTimeout(() => restartServer(), 3000);
    return result + '\n\nRestarting server to apply changes...';
  }
  return result;
}

app.post('/chief', async (req, res) => {
  const signature = req.headers['x-twilio-signature'] || '';
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = `${proto}://${host}${req.originalUrl}`;
  if (!twilio.validateRequest(CONFIG.twilio.authToken, signature, url, req.body)) {
    console.warn('Rejected request: invalid Twilio signature from', req.ip);
    return res.status(403).send('Forbidden');
  }
  res.status(200).send('OK');
  try {
    let incomingMsg = req.body.Body;
    const senderNumber = req.body.From;
    if (senderNumber !== CONFIG.owner.whatsapp) return;

    // ── Voice message transcription ───────────────────────────────────────────
    if (!incomingMsg && parseInt(req.body.NumMedia || '0') > 0) {
      const mediaType = req.body.MediaContentType0 || '';
      const mediaUrl  = req.body.MediaUrl0 || '';
      if (mediaType.startsWith('audio/') && mediaUrl) {
        if (!CONFIG.deepgram?.apiKey) {
          await sendToJackson('🎤 Voice message received but Deepgram not connected. Add deepgram.apiKey to config to enable transcription.');
          return;
        }
        await sendToJackson('🎤 Transcribing voice message...');
        const transcript = await transcribeAudio(mediaUrl);
        if (!transcript) { await sendToJackson('Could not transcribe that voice message Boss.'); return; }
        await sendToJackson(`🎤 *Transcription:* "${transcript}"`);
        incomingMsg = transcript; // treat transcript as text command
      } else {
        return; // non-audio media, ignore
      }
    }

    if (!incomingMsg) return;

    const msgLower = incomingMsg.toLowerCase().trim();
    if (msgLower === "mrr" || msgLower === "revenue" || msgLower === "monthly revenue") { await sendToJackson(getMRR()); return; }
    console.log(`Jackson: ${incomingMsg}`);

    trackCommand(msgLower.substring(0, 50));

    if (msgLower === 'restart') {
      await sendToJackson('Restarting Chief of Staff...');
      restartServer();
      return;
    }

    // ── Direct handlers ───────────────────────────────────────────────────────

    if (msgLower.includes('market research') || msgLower.includes('whats trending') || msgLower.includes("what's trending") || msgLower.includes('content trends')) {
      await sendToJackson('Searching trends now Boss...');
      await sendToJackson(await doMarketResearch());
      return;
    }
    if (msgLower.includes('connect frameio') || msgLower.includes('connect frame.io')) {
      await sendToJackson('Visit this link Boss: ' + FRAMEIO_REDIRECT.replace('/callback', '/auth'));
      return;
    }
    if (msgLower.startsWith('on a call') || msgLower.startsWith("i'm on a call") || msgLower.startsWith('im on a call') || msgLower.startsWith('call with') || msgLower.startsWith('live call')) {
      await sendToJackson(await liveCallAssist(incomingMsg));
      return;
    }
    if (msgLower.includes('analyse my calls') || msgLower.includes('analyze my calls') || msgLower.includes('fathom calls')) {
      await sendToJackson('Pulling your Fathom calls Boss...');
      await sendToJackson(await analysePastCalls());
      return;
    }
    if (msgLower.startsWith('reply to') || msgLower.startsWith('draft reply to')) {
      const parts = incomingMsg.replace(/draft reply to|reply to/gi,'').trim();
      const colonIdx = parts.indexOf(':');
      const clientName = colonIdx > -1 ? parts.substring(0, colonIdx).trim() : parts;
      const question = colonIdx > -1 ? parts.substring(colonIdx + 1).trim() : parts;
      await sendToJackson('Drafting reply Boss...');
      await sendToJackson(await draftClientReply(clientName, question));
      return;
    }
    if (msgLower.startsWith('search for') || msgLower.startsWith('look up') || msgLower.startsWith('find out')) {
      const query = incomingMsg.replace(/search for|look up|find out/gi,'').trim();
      await sendToJackson('Searching Boss...');
      await sendToJackson(await webSearchFallback(query || incomingMsg));
      return;
    }
    if (msgLower.startsWith('reel ideas for') || msgLower.startsWith('ideas for')) {
      const cn = incomingMsg.replace(/reel ideas for|ideas for/gi,'').trim();
      await sendToJackson(await generateReelIdeas(cn));
      return;
    }
    if (msgLower.startsWith('hooks for') || msgLower.startsWith('hook ideas for')) {
      const topic = incomingMsg.replace(/hooks for|hook ideas for/gi,'').trim();
      await sendToJackson(await generateHooks(topic));
      return;
    }
    if (msgLower.startsWith('caption for') || msgLower.startsWith('write a caption')) {
      const topic = incomingMsg.replace(/caption for|write a caption for|write a caption/gi,'').trim();
      await sendToJackson(await generateCaption(topic, ''));
      return;
    }
    if (msgLower.startsWith('content calendar for') || msgLower.startsWith('calendar for')) {
      const cn = incomingMsg.replace(/content calendar for|calendar for/gi,'').trim();
      await sendToJackson(await generateContentCalendar(cn));
      return;
    }
    if (msgLower.includes('my clients') || msgLower.includes('active clients') || msgLower.includes('who are my clients')) {
      await sendToJackson('Your active clients Boss:\n' + getClientContext());
      return;
    }
    if (msgLower.includes("hasn't replied") || msgLower.includes("unanswered") || msgLower.includes("who to reply") || msgLower.includes("waiting for your reply")) {
      await sendToJackson('People waiting on you Boss:\n' + getUnansweredMessages());
      return;
    }

    // ── NEW FEATURES ──────────────────────────────────────────────────────────

    // Win tracker
    if (msgLower === 'wins' || msgLower === 'my wins' || msgLower === 'win tracker') {
      await sendToJackson(getWinsSummary()); return;
    }
    if (msgLower.startsWith('log win:') || msgLower.startsWith('new win:') || msgLower.startsWith('won:')) {
      const details = incomingMsg.replace(/log win:|new win:|won:/gi,'').trim();
      const parts = details.split(',').map(s => s.trim());
      saveWin(parts[0] || 'Unknown', parts[1] || 'retainer', parts[2] || '');
      await sendToJackson(`Win logged Boss! ${parts[0]} — ${parts[1] || 'retainer'}${parts[2] ? ' — ' + parts[2] : ''} 🏆`);
      return;
    }

    // Quote generator
    if (msgLower.startsWith('quote for') || msgLower.startsWith('generate quote') || msgLower.startsWith('build quote')) {
      const details = incomingMsg.replace(/quote for|generate quote for|generate quote|build quote for|build quote/gi,'').trim();
      const parts = details.split(',').map(s => s.trim());
      const leadName = parts[0] || 'Lead';
      const vidsMatch = details.match(/(\d+)\s*vid/i);
      const monthsMatch = details.match(/(\d+)\s*month/i);
      await sendToJackson('Building quote draft Boss...');
      await sendToJackson(await generateQuoteDraft(leadName, '', vidsMatch ? vidsMatch[1] : '20', monthsMatch ? monthsMatch[1] : '3', '', details));
      return;
    }
    if (msgLower === 'my quotes' || msgLower === 'pending quotes') {
      await sendToJackson(getPendingQuotes()); return;
    }

    // Editor deadlines
    if (msgLower === 'deadlines' || msgLower === 'editor deadlines' || msgLower === 'my deadlines') {
      await sendToJackson(getActiveDeadlines()); return;
    }
    if (msgLower.startsWith('add deadline') || msgLower.startsWith('track deadline')) {
      const details = incomingMsg.replace(/add deadline|track deadline/gi,'').trim();
      const parts = details.split(',').map(s => s.trim());
      const d = addEditorDeadline(parts[0] || 'Unknown', parts[1] || new Date().toISOString().split('T')[0], parts[2] || '');
      await sendToJackson(`Deadline tracked for ${parts[0]} Boss. Editor due ${new Date(d.internalDeadline).toLocaleDateString('en-AU', {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}`);
      return;
    }
    if (msgLower.startsWith('done editing') || msgLower.startsWith('editing done') || msgLower.startsWith('mark done')) {
      const client = incomingMsg.replace(/done editing|editing done|mark done/gi,'').trim();
      const deadlines = loadDeadlines();
      const dl = deadlines.find(d => d.client.toLowerCase().includes(client.toLowerCase()) && !d.clientDone);
      if (dl) { dl.clientDone = true; dl.internalDone = true; fs.writeFileSync(DEADLINES_PATH, JSON.stringify(deadlines, null, 2)); await sendToJackson(`${client} fully delivered Boss ✅`); }
      else await sendToJackson(`No active deadline found for ${client} Boss.`);
      return;
    }

    // Client check-ins
    if (msgLower === 'check-ins' || msgLower === 'client check-ins' || msgLower.includes('who needs a check in') || msgLower.includes('check in due')) {
      const overdue = getClientsNeedingCheckin();
      if (!overdue.length) { await sendToJackson('All clients checked in within 30 days Boss 👍'); return; }
      await sendToJackson('Check-ins due Boss:\n' + overdue.map(c => `${c.name} (${c.value})${c.daysSince ? ' — ' + c.daysSince + 'd ago' : ''}`).join('\n'));
      return;
    }
    if (msgLower.startsWith('checked in with') || msgLower.startsWith('check in done')) {
      const client = incomingMsg.replace(/checked in with|check in done with|check in done/gi,'').trim();
      await sendToJackson(markCheckInDone(client) + ' ✅');
      return;
    }

    // Cold leads
    if (msgLower === 'cold leads' || msgLower === 'follow ups' || msgLower === 'cold lead follow ups') {
      const due = await getColdLeadFollowUps();
      await sendToJackson(due || 'No cold lead follow-ups due Boss.');
      return;
    }
    if (msgLower.startsWith('add cold lead:') || msgLower.startsWith('track lead:')) {
      const details = incomingMsg.replace(/add cold lead:|track lead:/gi,'').trim();
      const parts = details.split(',').map(s => s.trim());
      await sendToJackson(addColdLead(parts[0], parts[1] || '', null, parts.slice(2).join(', ')));
      return;
    }

    // Shoot briefing
    if (msgLower === 'shoot briefing' || msgLower === "today's shoot" || msgLower === 'shoot today') {
      await sendToJackson((await getTodayShootBriefing()) || 'No shoot in your calendar today Boss.');
      return;
    }
    if (msgLower.startsWith('post shoot') || msgLower.startsWith('post-shoot') || msgLower.startsWith('shoot checklist')) {
      const client = incomingMsg.replace(/post[\s-]shoot checklist for|post[\s-]shoot|shoot checklist for|shoot checklist/gi,'').trim();
      await sendToJackson(getPostShootChecklist(client));
      return;
    }

    // Weekly review manual trigger
    if (msgLower === 'weekly review' || msgLower === 'send weekly review') {
      await sendToJackson('Running weekly review Boss...');
      await sendWeeklyReview();
      return;
    }

    // Usage insights
    if (msgLower === 'usage' || msgLower === 'what do i use most' || msgLower === 'usage stats') {
      await sendToJackson(getUsageInsights()); return;
    }

    // Long-term memory
    if (msgLower.startsWith('remember ') || msgLower.startsWith('remember:')) {
      const fact = incomingMsg.replace(/^remember:?\s*/i, '').trim();
      await sendToJackson(saveLongtermMemory(fact));
      return;
    }
    if (msgLower === 'what do you remember' || msgLower === 'my memory' || msgLower === 'memory') {
      await sendToJackson(getLongtermMemory());
      return;
    }

    // ── Pending approvals ─────────────────────────────────────────────────────
    if (msgLower === 'pending' || msgLower === 'approvals' || msgLower === 'pending approvals') {
      await sendToJackson(listPending()); return;
    }
    if (msgLower.startsWith('approve') || msgLower === 'yes' || msgLower === 'confirm') {
      const idMatch = incomingMsg.match(/\d{5}/);
      const item = getApproval(idMatch ? idMatch[0] : null);
      if (!item) { await sendToJackson('No pending approval found Boss.'); return; }
      await sendToJackson(`Executing [${item.id}]...`);
      try {
        const result = await executeApproval(item);
        removeApproval(item.id);
        await sendToJackson(result);
      } catch(e) { await sendToJackson('Execution failed Boss: ' + e.message); }
      return;
    }
    if (msgLower.startsWith('deny') || msgLower === 'no' || msgLower === 'cancel') {
      const idMatch = incomingMsg.match(/\d{5}/);
      const item = getApproval(idMatch ? idMatch[0] : null);
      if (!item) { await sendToJackson('No pending approval found Boss.'); return; }
      removeApproval(item.id);
      await sendToJackson(`Cancelled [${item.id}] — ${item.preview.split('\n')[0]}`);
      return;
    }

    // ── Dev mode ──────────────────────────────────────────────────────────────
    if (msgLower.startsWith('update:') || msgLower.startsWith('dev:') || msgLower.startsWith('build:')) {
      const instruction = incomingMsg.replace(/^(update|dev|build):\s*/i, '').trim();
      const id = queueApproval('dev_task', { instruction }, `CODE CHANGE: ${instruction.substring(0, 80)}`);
      await sendToJackson(`Ready to make this change Boss [ID: ${id}]:\n\n"${instruction}"\n\nReply "approve ${id}" to proceed or "deny ${id}" to cancel.`);
      return;
    }

    // ── Agent loop ────────────────────────────────────────────────────────────
    const reply = await runAgentLoop(incomingMsg);
    console.log(`Reply: ${reply.substring(0, 80)}...`);
    await sendToJackson(reply);

  } catch(e) {
    console.error('Webhook error:', e.message);
    try { await sendToJackson('Hit an error Boss, try again!'); } catch(x) {}
  }
});

app.get('/', (req, res) => res.send('JT Visuals Chief of Staff v4'));

// ─── FIREFLIES WEBHOOK ────────────────────────────────────────────────────────
app.post('/fireflies-webhook', async (req, res) => {
  res.status(200).send('OK');
  try {
    const { meetingId, title } = req.body;
    if (!meetingId) return;
    console.log('Fireflies webhook received:', meetingId, title);

    // Small delay to let Fireflies finish processing
    await new Promise(r => setTimeout(r, 5000));

    const transcript = await getFirefliesTranscript(meetingId);
    if (!transcript) {
      await sendToJackson(`Call finished: ${title || meetingId}. Transcript not ready yet — try "analyse my calls" in a few minutes.`);
      return;
    }

    await sendToJackson(`Call debrief — ${transcript.title || title}:`);
    const analysis = await analyseFirefliesCall(transcript);
    await sendToJackson(analysis);
  } catch(e) {
    console.error('Fireflies webhook error:', e.message);
  }
});

app.get('/frameio/auth', (req, res) => {
  const url = `https://ims-na1.adobelogin.com/ims/authorize/v2?client_id=${FRAMEIO_CLIENT_ID}&redirect_uri=${encodeURIComponent(FRAMEIO_REDIRECT)}&scope=openid,email,profile,offline_access&response_type=code`;
  res.redirect(url);
});

app.get('/frameio/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send('No code received.');
  try {
    const tokenRes = await axios.post('https://ims-na1.adobelogin.com/ims/token/v3',
      new URLSearchParams({ grant_type: 'authorization_code', client_id: FRAMEIO_CLIENT_ID, client_secret: FRAMEIO_CLIENT_SECRET, redirect_uri: FRAMEIO_REDIRECT, code }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    saveFrameIOTokens({ ...tokenRes.data, created_at: Date.now() });
    await sendToJackson('Frame.io connected Boss! 🎬');
    res.send('<h2>Frame.io Connected!</h2><p>Close this tab and check WhatsApp.</p>');
  } catch(e) { res.send('Error: ' + e.message); }
});

// ─── GOOGLE AUTH ROUTES ───────────────────────────────────────────────────────
app.get('/google-auth', (req, res) => {
  const result = getGoogleAuthURL();
  if (!result) return res.send('google-credentials.json not found on server.');
  res.redirect(result.url);
});

app.get('/google-callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`Google auth error: ${error}`);
  if (!code) return res.send('No code received.');
  try {
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
    const { client_secret, client_id } = credentials.installed;
    const redirectUri = `https://nonvalidly-unbudgeted-theresa.ngrok-free.dev/google-callback`;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    _googleAuth = null; // force reload on next use
    await sendToJackson('✅ Google reconnected Boss! Calendar, Gmail, and Sheets are all live.');
    res.send('<h2>✅ Google Connected!</h2><p>Close this tab and check WhatsApp.</p>');
  } catch(e) {
    res.send('Error: ' + e.message);
  }
});

// ─── XERO FILE UPLOAD ─────────────────────────────────────────────────────────
app.get('/xero-upload', (req, res) => {
  const files = fs.existsSync(XERO_UPLOADS_PATH)
    ? fs.readdirSync(XERO_UPLOADS_PATH).filter(f => f.endsWith('.csv'))
    : [];
  const fileList = files.length
    ? `<p style="color:#6c757d;font-size:14px">Files on file: ${files.join(', ')}</p>`
    : `<p style="color:#6c757d;font-size:14px">No files uploaded yet.</p>`;

  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Upload Xero Export — JT Visuals</title>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 520px; margin: 60px auto; padding: 20px; background: #f8f9fa; }
    h2 { color: #1a1a2e; margin-bottom: 4px; }
    p { color: #555; font-size: 15px; margin-top: 0; }
    .card { background: white; border-radius: 12px; padding: 28px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
    .steps { background: #f0f4ff; border-radius: 8px; padding: 16px 20px; margin: 16px 0; font-size: 14px; line-height: 1.9; }
    input[type=file] { display: block; margin: 16px 0; font-size: 15px; }
    button { background: #4f46e5; color: white; border: none; padding: 12px 28px; border-radius: 8px; font-size: 16px; cursor: pointer; width: 100%; }
    button:hover { background: #4338ca; }
    .success { color: #16a34a; font-weight: 600; }
    .note { font-size: 13px; color: #888; margin-top: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>📊 Xero Financial Upload</h2>
    <p>Upload your Xero export for financial analysis via WhatsApp.</p>
    <div class="steps">
      <strong>How to export from Xero:</strong><br>
      1. Xero → <b>Accounting → Reports → Profit & Loss</b><br>
      2. Set date range → click <b>Export → CSV</b><br>
      3. Also export: <b>Accounting → Bank Accounts → [account] → Export</b><br>
      4. Upload both files below
    </div>
    <form action="/xero-upload" method="POST" enctype="multipart/form-data">
      <input type="file" name="xeroFile" accept=".csv" multiple required>
      <button type="submit">Upload & Analyse</button>
    </form>
    ${fileList}
    <p class="note">Files are stored locally on your Mac only. Then message the bot: "analyse my finances"</p>
  </div>
</body>
</html>`);
});

app.post('/xero-upload', express.raw({ type: '*/*', limit: '20mb' }), async (req, res) => {
  // Parse multipart manually using boundary
  try {
    const contentType = req.headers['content-type'] || '';
    const boundary = contentType.split('boundary=')[1];
    if (!boundary) return res.status(400).send('Bad request');

    const body = req.body.toString('binary');
    const parts = body.split(`--${boundary}`).filter(p => p.includes('filename='));
    const saved = [];

    for (const part of parts) {
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd === -1) continue;
      const headers = part.substring(0, headerEnd);
      const filenameMatch = headers.match(/filename="([^"]+)"/);
      if (!filenameMatch) continue;
      const filename = filenameMatch[1].replace(/[^a-zA-Z0-9._-]/g, '_');
      const content = part.substring(headerEnd + 4).replace(/\r\n--.*$/s, '');
      const savePath = path.join(XERO_UPLOADS_PATH, `${Date.now()}_${filename}`);
      fs.writeFileSync(savePath, content, 'binary');
      saved.push(filename);
    }

    if (!saved.length) return res.status(400).send('No valid CSV files found in upload.');

    await sendToJackson(`✅ Xero file${saved.length > 1 ? 's' : ''} uploaded: ${saved.join(', ')}\n\nSay "analyse my finances" to get your full financial report.`);
    res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:500px;margin:60px auto;padding:20px;text-align:center">
      <h2 style="color:#16a34a">✅ Uploaded!</h2>
      <p>Got: <strong>${saved.join(', ')}</strong></p>
      <p>Check WhatsApp — say "analyse my finances" to get your report.</p>
      <a href="/xero-upload" style="color:#4f46e5">Upload another file</a>
    </body></html>`);
  } catch(e) {
    console.error('Xero upload error:', e.message);
    res.status(500).send('Upload error: ' + e.message);
  }
});

// ─── XERO AUTH ROUTES ─────────────────────────────────────────────────────────
app.get('/xero-auth', (req, res) => {
  const xero = CONFIG.xero || {};
  if (!xero.clientId) return res.send('Xero clientId not set in config.json');
  const state = Math.random().toString(36).slice(2);
  const url = `https://login.xero.com/identity/connect/authorize?` +
    `client_id=${xero.clientId}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(XERO_SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(xero.redirectUri)}` +
    `&state=${state}`;
  res.redirect(url);
});

app.get('/xero-callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`Xero auth error: ${error}`);
  if (!code) return res.send('No code received.');
  try {
    const xero = CONFIG.xero || {};
    // Exchange code for tokens
    const tokenRes = await axios.post('https://identity.xero.com/connect/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: xero.redirectUri,
        client_id: xero.clientId,
        client_secret: xero.clientSecret
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    // Get tenant (organisation) ID
    const connRes = await axios.get('https://api.xero.com/connections', {
      headers: { 'Authorization': `Bearer ${tokenRes.data.access_token}`, 'Content-Type': 'application/json' }
    });
    const tenant = connRes.data?.[0];
    if (!tenant) { res.send('No Xero organisations found.'); return; }

    saveXeroToken({
      accessToken: tokenRes.data.access_token,
      refreshToken: tokenRes.data.refresh_token,
      expiresAt: Date.now() + tokenRes.data.expires_in * 1000,
      tenantId: tenant.tenantId,
      orgName: tenant.tenantName,
    });

    await sendToJackson(`✅ Xero connected! Organisation: *${tenant.tenantName}*\n\nYou can now ask:\n• "show my P&L"\n• "analyse my expenses"\n• "show outstanding invoices"`);
    res.send('<h2>✅ Xero Connected!</h2><p>Close this tab and check WhatsApp.</p>');
  } catch(e) {
    console.error('Xero callback error:', e.response?.data || e.message);
    res.send('Error connecting Xero: ' + (e.response?.data?.error_description || e.message));
  }
});

// ─── SCHEDULER ────────────────────────────────────────────────────────────────
function scheduleDaily(getHour, getMinute, fn, label) {
  function msUntilNext() {
    const tz = CONFIG.owner.timezone;
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-AU', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).formatToParts(now);
    const tzHour = parseInt(parts.find(p => p.type === 'hour').value);
    const tzMin  = parseInt(parts.find(p => p.type === 'minute').value);
    const tzSec  = parseInt(parts.find(p => p.type === 'second').value);
    let secsUntil = (getHour() * 3600 + getMinute() * 60) - (tzHour * 3600 + tzMin * 60 + tzSec);
    if (secsUntil <= 0) secsUntil += 24 * 3600;
    return secsUntil * 1000;
  }
  function run() { fn(); setTimeout(run, msUntilNext()); }
  setTimeout(run, msUntilNext());
  console.log(`Scheduled: ${label} at ${getHour()}:${String(getMinute()).padStart(2,'0')} ${CONFIG.owner.timezone} daily`);
}

function scheduleWeekly(dayOfWeek, hour, minute, fn, label) {
  function msUntilNext() {
    const tz = CONFIG.owner.timezone;
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-AU', {
      timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).formatToParts(now);
    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const tzDayName = parts.find(p => p.type === 'weekday').value.substring(0, 3);
    const tzDay  = dayNames.findIndex(d => tzDayName.startsWith(d.substring(0, 3)));
    const tzHour = parseInt(parts.find(p => p.type === 'hour').value);
    const tzMin  = parseInt(parts.find(p => p.type === 'minute').value);
    const tzSec  = parseInt(parts.find(p => p.type === 'second').value);
    const currentSecsIntoWeek = ((tzDay * 24 + tzHour) * 3600) + tzMin * 60 + tzSec;
    const targetSecsIntoWeek  = (dayOfWeek * 24 + hour) * 3600 + minute * 60;
    let secsUntil = targetSecsIntoWeek - currentSecsIntoWeek;
    if (secsUntil <= 0) secsUntil += 7 * 24 * 3600;
    return secsUntil * 1000;
  }
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  function run() { fn(); setTimeout(run, msUntilNext()); }
  setTimeout(run, msUntilNext());
  console.log(`Scheduled: ${label} weekly ${dayNames[dayOfWeek]} at ${hour}:${String(minute).padStart(2,'0')} ${CONFIG.owner.timezone}`);
}

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = 3000;
app.listen(PORT, async () => {
  loadFrameIOTokens();
  CONFIG = loadConfig();
  console.log(`\nJT Visuals Chief of Staff v4 running on port ${PORT}`);

  if (fs.existsSync(CREDENTIALS_PATH) && !fs.existsSync(TOKEN_PATH)) {
    await authorizeGoogle();
  } else if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.log('Add google-credentials.json to enable Calendar + Gmail');
  } else {
    console.log('Google connected');
  }

  const testMsg = queryWhatsApp('SELECT COUNT(*) FROM ZWAMESSAGE;');
  console.log(`WhatsApp DB: ${testMsg || 'not accessible'} messages`);

  scheduleDaily(() => CONFIG.schedule.briefingHour, () => CONFIG.schedule.briefingMinute, send5amBriefing, '5am Briefing');
  scheduleDaily(() => CONFIG.schedule.middayHour, () => CONFIG.schedule.middayMinute, sendMiddayReminder, 'Midday Reminder');
  scheduleDaily(() => CONFIG.schedule.eodHour, () => CONFIG.schedule.eodMinute, sendEODWrap, 'EOD Wrap');
  scheduleWeekly(0, CONFIG.schedule.weeklyReviewHour || 17, CONFIG.schedule.weeklyReviewMinute || 0, sendWeeklyReview, 'Sunday Weekly Review');
  scheduleDaily(() => 9, () => 0, async () => { const overdue = getClientsNeedingCheckin(); if (overdue.length > 0) await sendCheckinPrompts(); }, 'Daily Check-in Checker');

  startDeadlineChecker();
  startUnansweredChecker();
  startEmailChecker();
  scheduleDaily(() => 17, () => 0, sendDailyResponseReport, 'Daily Response Time Report');
  scheduleDaily(() => 8, () => 0, checkClientGroupTasks, 'Morning Group Task Scan');
  scheduleDaily(() => 8, () => 30, checkRenewalAlerts, 'Renewal Alerts');
  scheduleDaily(() => 8, () => 30, checkNurtureFollowUps, 'Lead Nurture Follow-ups');
  scheduleDaily(() => 8, () => 30, checkOverduePreprod, 'Pre-production Asset Check');
  scheduleDaily(() => 13, () => 0, checkClientGroupTasks, 'Afternoon Group Task Scan');
  scheduleDaily(() => 17, () => 0, checkClientGroupTasks, 'Evening Group Task Scan');
  scheduleDaily(() => 21, () => 0, checkClientGroupTasks, 'Night Group Task Scan');

  // Weekly analytics report — every Monday at 8am
  scheduleDaily(() => 8, () => 0, async () => {
    if (new Date().getDay() === 1) await sendWeeklyAnalyticsReport();
  }, 'Weekly Analytics Report (Monday)');

  console.log('\nChief of Staff v4 ready!');
  console.log('NEW: wins | log win: Client, package, $value');
  console.log('NEW: quote for [name], [X] videos, [Y] months');
  console.log('NEW: deadlines | add deadline: Client, YYYY-MM-DD');
  console.log('NEW: check-ins | checked in with [client]');
  console.log('NEW: cold leads | add cold lead: Name, contact, notes');
  console.log('NEW: shoot briefing | post shoot [client]');
  console.log('NEW: weekly review | usage\n');
});
