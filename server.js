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
    ghl: { apiKey: process.env.GHL_API_KEY || '', locationId: process.env.GHL_LOCATION_ID || '' },
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

// ─── FATHOM ───────────────────────────────────────────────────────────────────
const FATHOM_API_KEY = process.env.FATHOM_API_KEY || CONFIG.fathom?.apiKey || '';

async function getFathomMeetings(limit = 20) {
  try {
    const res = await axios.get('https://api.fathom.video/v1/calls', {
      headers: { 'Authorization': `Bearer ${FATHOM_API_KEY}` }, params: { limit }
    });
    return res.data?.calls || res.data?.data || res.data || [];
  } catch(e) { return []; }
}

async function getFathomTranscript(callId) {
  try {
    const res = await axios.get(`https://api.fathom.video/v1/calls/${callId}/transcript`, {
      headers: { 'Authorization': `Bearer ${FATHOM_API_KEY}` }
    });
    return res.data;
  } catch(e) { return null; }
}

async function analysePastCalls() {
  const meetings = await getFathomMeetings(30);
  if (!meetings.length) return 'No Fathom calls found Boss. Make sure Fathom is recording your sales calls.';
  const transcripts = [];
  for (const meeting of meetings.slice(0, 8)) {
    const t = await getFathomTranscript(meeting.id);
    if (t) transcripts.push({
      title: meeting.title || meeting.name || 'Untitled',
      date: meeting.started_at || meeting.created_at,
      summary: meeting.summary || '',
      transcript: (typeof t === 'string' ? t : JSON.stringify(t)).substring(0, 600)
    });
  }
  if (!transcripts.length) return 'Recent calls:\n' + meetings.slice(0, 8).map(m => `• ${m.title || 'Untitled'} — ${new Date(m.started_at || m.created_at).toLocaleDateString('en-AU')}`).join('\n');
  const prompt = `Analyse these sales calls for Jackson Edwards, JT Visuals videography agency Gold Coast.
Calls: ${transcripts.map(t => `${t.title} (${new Date(t.date).toLocaleDateString('en-AU')}): ${t.summary} ${t.transcript}`).join(' | ')}
Tell Boss: 1) Most discussed packages 2) Common objections 3) What closes deals 4) Patterns in wins vs losses. Max 5 lines.`;
  const r = await axios.post('https://api.anthropic.com/v1/messages',
    { model: MODEL_MID, max_tokens: 400, messages: [{ role: 'user', content: prompt }] },
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

async function webSearchFallback(query) {
  const prompt = `Search the web and answer this for Jackson Edwards, JT Visuals Gold Coast: "${query}". Concise — max 3 sentences.`;
  const r = await axios.post('https://api.anthropic.com/v1/messages',
    { model: MODEL_LOW, max_tokens: 300, tools: [{ type: 'web_search_20250305', name: 'web_search' }], messages: [{ role: 'user', content: prompt }] },
    { headers: { 'x-api-key': CONFIG.claude.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
  const text = r.data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  return text || 'Could not find that information Boss.';
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
const SCOPES = ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'];
const TOKEN_PATH = path.join(__dirname, 'google-token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'google-credentials.json');

function getGoogleAuth() {
  if (!fs.existsSync(CREDENTIALS_PATH)) return null;
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  if (fs.existsSync(TOKEN_PATH)) {
    oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH)));
    return oAuth2Client;
  }
  return null;
}

async function authorizeGoogle() {
  if (!fs.existsSync(CREDENTIALS_PATH)) return;
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  const authUrl = oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
  console.log('\nAuthorize Google:\n', authUrl);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('\nEnter code: ', async (code) => {
    rl.close();
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    console.log('Google token saved! Restart.');
    process.exit(0);
  });
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

async function draftEmailReply(fromEmail, subject, emailBody) {
  const sentStyle = await getSentEmailStyle(15);
  const waStyle = getJacksonWritingStyle();
  const prompt = `Draft an email reply on behalf of Jackson Edwards, JT Visuals (info@jtvissuals.com.au), Gold Coast.
JACKSON'S EMAIL STYLE:\n${sentStyle.substring(0, 1000)}
JACKSON'S TONE (WhatsApp):\n${waStyle.substring(0, 300)}
Reply to:
FROM: ${fromEmail}
SUBJECT: ${subject}
EMAIL: ${emailBody}
Write ONLY the email body. Sign off as Jackson Edwards, JT Visuals. Professional but warm.`;
  const response = await axios.post('https://api.anthropic.com/v1/messages',
    { model: MODEL_MID, max_tokens: 500, messages: [{ role: 'user', content: prompt }] },
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

ACTIVE CLIENTS (these are the ONLY 9 clients — never invent others):
Alpha Physiques, Hattie (Flex Method), Cade, Jese Smith, Sarah, Raw Reality, Jess Richards, CoreCoach, Morgan

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
  { name: 'get_calendar',            description: "Get today's calendar events", input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'get_yesterday_events',    description: "Get yesterday's calendar events", input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'create_calendar_event',   description: 'Create a Google Calendar event',
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
    case 'get_calendar':              return await getCalendarEvents();
    case 'get_yesterday_events':      return await getYesterdayEvents();
    case 'create_calendar_event': {
      const id = queueApproval('create_calendar_event',
        { summary: input.summary, start: input.start, end: input.end, description: input.description || '' },
        `EVENT: ${input.summary}\nSTART: ${input.start}\nEND: ${input.end}`
      );
      return `Queued for approval [ID: ${id}]\n\nCalendar event: ${input.summary}\nStart: ${input.start}\nEnd: ${input.end}\n\nReply "approve ${id}" to create or "deny ${id}" to cancel.`;
    }
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
async function runAgentLoop(userMessage) {
  const writingStyle = getJacksonWritingStyle();
  const memoryContext = getMemoryContext();
  const system = `You are the AI Chief of Staff for Jackson Edwards, owner of JT Visuals videography agency in Gold Coast, Australia.

JACKSON'S WRITING STYLE:
${writingStyle ? writingStyle.substring(0, 800) : 'Casual, direct, professional but friendly.'}

JT VISUALS PRICING:
${JT_PRICING}

ACTIVE CLIENTS (these are the ONLY 9 clients — never invent others):
Alpha Physiques, Hattie (Flex Method), Cade, Jese Smith, Sarah, Raw Reality, Jess Richards, CoreCoach, Morgan

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
  { name: "Raw Reality", mrr: 2200 },
  { name: "Jess Richards", mrr: 1000 },
  { name: "CoreCoach", mrr: 3900 },
  { name: "Morgan", mrr: 1400 },
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

  let output = '';
  const toolsUsed = new Set();

  for await (const message of query({
    prompt: `You are modifying the JT Visuals Chief of Staff server (${path.join(__dirname, 'server.js')}).
Task: ${instruction}
Be surgical — only change what is needed. After making changes, summarise what you changed in 2-3 plain text sentences. No markdown.`,
    options: {
      cwd: __dirname,
      allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
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
  const tools = toolsUsed.size ? `\nFiles touched via: ${[...toolsUsed].join(', ')}` : '';
  return (summary || 'Done Boss.') + tools;
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
    const incomingMsg = req.body.Body;
    const senderNumber = req.body.From;
    if (!incomingMsg || senderNumber !== CONFIG.owner.whatsapp) return;

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

  console.log('\nChief of Staff v4 ready!');
  console.log('NEW: wins | log win: Client, package, $value');
  console.log('NEW: quote for [name], [X] videos, [Y] months');
  console.log('NEW: deadlines | add deadline: Client, YYYY-MM-DD');
  console.log('NEW: check-ins | checked in with [client]');
  console.log('NEW: cold leads | add cold lead: Name, contact, notes');
  console.log('NEW: shoot briefing | post shoot [client]');
  console.log('NEW: weekly review | usage\n');
});
