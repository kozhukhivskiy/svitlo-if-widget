// Svitlo IF widget module (API 1)
// Svitlo IF: power outage schedule for the Ivano-Frankivsk region (svitlo.oe.if.ua).
// This file is a module: loader.js downloads it from GitHub releases. It is not installed in Scriptable directly.
// Keep the first line unchanged: loader.js uses it to recognise the module. Bump VERSION before each release.
// Shows the SCHEDULE, not whether the power is actually on.
//
// Queue and name come from the widget Parameter (long-press the widget → Edit Widget → Parameter):
//   4.2 Квартира   — queue 4.2 labelled "Квартира"
//   4.2            — no label
// Every widget has its own Parameter, so two widgets can show two queues.
// Tapping the widget does whatever its "When Interacting" setting says.
// Size: medium only for now. Other sizes show a placeholder.

const VERSION = "1.0.1";
const API = "https://be-svitlo.oe.if.ua/schedule-by-queue";
const REFRESH_MS = 15 * 60 * 1000;

const P = {
  bg: "#161D2A",
  white: "#FFFFFF",
  muted: "#94A3B8",
  on: "#4ADE80",
  off: "#FB7185",
  maybe: "#FACC15",
  unknown: "#475569"
};

const color = (hex, alpha = 1) => new Color(hex, alpha);
const pad = n => String(n).padStart(2, "0");
const hhmm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dateKey = d => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
const startOfDay = (d, plusDays = 0) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + plusDays);
const str = v => (typeof v === "string" ? v : null);

function label(parent, value, size, hex, bold = false, alpha = 1) {
  const t = parent.addText(String(value));
  t.font = bold ? Font.boldSystemFont(size) : Font.systemFont(size);
  t.textColor = color(hex, alpha);
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.6;
  return t;
}

// ---------- Widget parameter ----------

// "4.2 Квартира", "4,2", "4.2 | Ліфт" → {queue, name}; otherwise null.
function parseParam(raw) {
  const m = String(raw || "").trim().match(/^(\d{1,2})[.,](\d{1,2})\s*[|,;:·—–-]?\s*(.*)$/);
  return m ? { queue: `${m[1]}.${m[2]}`, name: m[3].trim().slice(0, 24) } : null;
}

// ---------- Data ----------

const TIME_RE = /^\d{1,2}:\d{2}$/;
const DATE_RE = /^\d{2}\.\d{2}\.\d{4}$/;

function toDate(dateStr, time) {
  const [d, m, y] = dateStr.split(".").map(Number);
  const [h, min] = time.split(":").map(Number);
  return new Date(y, m - 1, d, h, min);
}

async function fetchDays(queue) {
  const request = new Request(`${API}?queue=${encodeURIComponent(queue)}`);
  request.timeoutInterval = 15;
  request.headers = { "Accept": "application/json" };
  const raw = await request.loadString();
  const code = request.response && request.response.statusCode;
  if (code >= 400) throw new Error(`Сервер відповів HTTP ${code}`);

  let json;
  try { json = JSON.parse(raw); } catch (_) { throw new Error("Сервер повернув не JSON"); }
  if (!Array.isArray(json)) throw new Error("Неочікуваний формат відповіді");

  // The server returns an array of days: [{eventDate, queues: {"4.2": [{from, to, status}]}, ...}]
  const byDate = new Map();
  for (const item of json) {
    if (!item || !DATE_RE.test(str(item.eventDate) || "")) continue;
    const list = item.queues && Array.isArray(item.queues[queue]) ? item.queues[queue] : [];
    const slots = list
      .filter(s => s && TIME_RE.test(str(s.from) || "") && TIME_RE.test(str(s.to) || ""))
      .map(s => ({ from: s.from, to: s.to, status: s.status }));
    byDate.set(item.eventDate, {
      date: item.eventDate,
      slots,
      createdAt: str(item.createdAt),
      approvedSince: str(item.scheduleApprovedSince)
    });
  }
  return [...byDate.values()];
}

const fm = FileManager.local();
const cacheDir = fm.joinPath(fm.libraryDirectory(), "svitlo-if");
const cachePath = queue => fm.joinPath(cacheDir, `queue-${queue.replace(/\D/g, "_")}.json`);

async function loadData(queue) {
  const path = cachePath(queue);
  try {
    const days = await fetchDays(queue);
    const fetchedAt = Date.now();
    try {
      fm.createDirectory(cacheDir, true);
      fm.writeString(path, JSON.stringify({ days, fetchedAt }));
    } catch (_) { /* the cache is optional */ }
    return { days, fetchedAt, cached: false };
  } catch (error) {
    console.log(`Svitlo IF ${queue}: ${error.message || error}`);
    try {
      if (fm.fileExists(path)) {
        const cache = JSON.parse(fm.readString(path));
        // A schedule covers midnight to midnight: the cache is usable while it still has today.
        const today = dateKey(new Date());
        if (Array.isArray(cache.days) && cache.days.some(d => d && d.date === today)) {
          return { days: cache.days, fetchedAt: cache.fetchedAt, cached: true };
        }
      }
    } catch (_) { /* ignore a corrupted cache */ }
    throw error;
  }
}

// ---------- Schedule model ----------
// status 1 = outage. Any other value is treated as "possible" (yellow)
// until we see what the server actually sends.

function buildModel(days, now) {
  const today = days.find(d => d.date === dateKey(now));
  const tomorrow = days.find(d => d.date === dateKey(startOfDay(now, 1)));

  const raw = [];
  for (const day of [today, tomorrow]) {
    if (!day) continue;
    for (const s of day.slots) {
      const start = toDate(day.date, s.from);
      let end = toDate(day.date, s.to);
      if (end <= start) {
        end = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1,
          end.getHours(), end.getMinutes());
      }
      raw.push({ start, end, kind: Number(s.status) === 1 ? "off" : "maybe" });
    }
  }
  raw.sort((a, b) => a.start - b.start);

  // Merge adjacent intervals (e.g. 22:30–00:00 + 00:00–02:00 → 22:30–02:00).
  const intervals = [];
  for (const it of raw) {
    const last = intervals[intervals.length - 1];
    if (last && last.kind === it.kind && it.start <= last.end) {
      if (it.end > last.end) last.end = it.end;
    } else {
      intervals.push({ ...it });
    }
  }

  const from = today ? startOfDay(now) : null;
  const until = today ? startOfDay(now, tomorrow ? 2 : 1) : null;

  function stateAt(t) {
    if (!from || t < from || t >= until) return "unknown";
    let state = "on";
    for (const it of intervals) {
      if (it.start <= t && t < it.end) {
        if (it.kind === "off") return "off";
        state = "maybe";
      }
    }
    return state;
  }

  return { today, tomorrow, intervals, from, until, stateAt };
}

function nextChange(model, now) {
  const cur = model.stateAt(now);
  if (cur === "unknown") return null;
  const points = [model.until];
  for (const it of model.intervals) points.push(it.start, it.end);
  const future = points.filter(t => t > now).sort((a, b) => a - b);
  for (const t of future) {
    const s = model.stateAt(t);
    if (s === cur) continue;
    if (s === "unknown") return cur === "on" ? null : { at: t, newState: "end" };
    return { at: t, newState: s };
  }
  return null;
}

const upcoming = (model, now, limit) =>
  model.intervals.filter(it => it.end > now).slice(0, limit);

function rangeText(it, now, withDay = true) {
  const tomorrow = withDay && it.start >= startOfDay(now, 1) ? "Завтра " : "";
  return `${tomorrow}${hhmm(it.start)}–${hhmm(it.end)}`;
}

function statusFor(state) {
  if (state === "on") return { text: "Світло є", hex: P.on };
  if (state === "off") return { text: "Світла немає", hex: P.off };
  if (state === "maybe") return { text: "Можливе відключення", hex: P.maybe };
  return { text: "Немає графіка", hex: P.maybe };
}

function refreshDate(change) {
  const desired = Date.now() + REFRESH_MS;
  const t = change ? Math.min(desired, change.at.getTime()) : desired;
  return new Date(Math.max(Date.now() + 60 * 1000, t));
}

// ---------- Drawing ----------

// Medium widget: one continuous bar for today. The past is dimmed, a white line marks now,
// and every switch time is labelled under the bar.
const BAR_W = 308; // drawing width; the image is then fitted to the widget's content width
const LABEL_W = 24; // "22:30" at 8.5 pt is about 23 pt wide: used to keep labels apart
const LABEL_BOX = 40; // drawTextInRect clips text to its rect, so draw into a wider box

function dayBar(model, now) {
  const ctx = new DrawContext();
  ctx.size = new Size(BAR_W, 32);
  ctx.opaque = false;
  ctx.respectScreenScale = true;

  const day0 = model.from;
  const day1 = startOfDay(day0, 1);
  const xAt = t => BAR_W * Math.min(Math.max((t - day0) / (day1 - day0), 0), 1);
  const top = 2.5, h = 13, r = 4;

  const today = model.intervals.filter(it => it.end > day0 && it.start < day1)
    .sort((a, b) => (a.kind === "off") - (b.kind === "off")); // draw "off" over "maybe"
  ctx.setFillColor(color(P.on));
  ctx.fillRect(new Rect(0, top, BAR_W, h));
  for (const it of today) {
    ctx.setFillColor(color(it.kind === "off" ? P.off : P.maybe));
    ctx.fillRect(new Rect(xAt(it.start), top, xAt(it.end) - xAt(it.start), h));
  }
  const nowX = xAt(now);
  ctx.setFillColor(color(P.bg, 0.6));
  ctx.fillRect(new Rect(0, top, nowX, h));

  // Rounded corners: paint the corners over with the widget background colour.
  ctx.setFillColor(color(P.bg));
  for (const [cx, cy, dx, dy] of [[0, top, 1, 1], [BAR_W, top, -1, 1], [0, top + h, 1, -1], [BAR_W, top + h, -1, -1]]) {
    const corner = new Path();
    corner.move(new Point(cx, cy));
    corner.addLine(new Point(cx + dx * r, cy));
    corner.addQuadCurve(new Point(cx, cy + dy * r), new Point(cx, cy));
    corner.closeSubpath();
    ctx.addPath(corner);
    ctx.fillPath();
  }

  ctx.setFillColor(Color.white());
  ctx.fillRect(new Rect(Math.min(Math.max(nowX - 0.75, 0), BAR_W - 1.5), 0, 1.5, 18));

  // Switch-time labels. DrawContext cannot measure text, so a label that would overlap an
  // already placed one is skipped; future switches are placed first, then past ones.
  // ponytail: switches closer than ~2 h lose one label; the full times are in the list on the right.
  const times = [...new Set(today.flatMap(it => [it.start.getTime(), it.end.getTime()]))]
    .filter(ms => ms > day0.getTime() && ms < day1.getTime()).sort((a, b) => a - b);
  const ordered = [...times.filter(ms => ms > now.getTime()), ...times.filter(ms => ms <= now.getTime()).reverse()];
  const placed = [];
  for (const ms of ordered) {
    const cx = Math.min(Math.max(xAt(new Date(ms)), LABEL_W / 2), BAR_W - LABEL_W / 2);
    if (placed.some(p => Math.abs(p.cx - cx) < LABEL_W + 1)) continue;
    placed.push({ cx, text: hhmm(new Date(ms)) });
  }
  ctx.setFont(Font.semiboldSystemFont(8.5));
  ctx.setTextColor(color(P.white));
  ctx.setTextAlignedCenter();
  for (const p of placed) ctx.drawTextInRect(p.text, new Rect(p.cx - LABEL_BOX / 2, 19, LABEL_BOX, 12));
  if (!placed.some(p => p.cx < LABEL_W * 1.5 + 1)) { // "00:00" spans 0…LABEL_W
    ctx.setFont(Font.systemFont(8.5));
    ctx.setTextColor(color(P.muted));
    ctx.setTextAlignedLeft();
    ctx.drawTextInRect("00:00", new Rect(0, 19, LABEL_BOX, 12));
  }
  return ctx.getImage();
}

// ---------- Widgets ----------

function header(w, cfg) {
  const head = w.addStack();
  head.centerAlignContent();
  label(head, `⚡ ${(cfg.name || "Світло").toUpperCase()}`, 12, P.white, true);
  head.addSpacer();
  label(head, cfg.name ? `ЧЕРГА ${cfg.queue}` : `ІВ.-ФРАНКІВСЬК · ${cfg.queue}`, 10, P.muted, true);
}

// "Графік від 17:17" (with the date if approved on another day) · "Оновлено 13:10" or a yellow "Кеш 13:10".
function footer(w, model, data) {
  const f = w.addStack();
  f.centerAlignContent();
  const since = model.today && (model.today.approvedSince || model.today.createdAt);
  const m = since && since.match(/^(\d{2}\.\d{2})\.\d{4} (\d{1,2}:\d{2})$/);
  if (m) label(f, `Графік від ${m[1] === model.today.date.slice(0, 5) ? m[2] : `${m[1]} ${m[2]}`}`, 9, P.muted);
  f.addSpacer();
  label(f, `${data.cached ? "Кеш" : "Оновлено"} ${hhmm(new Date(data.fetchedAt))}`, 9,
    data.cached ? P.maybe : P.muted);
}

// Caption above the countdown to the next change (keyed by newState from nextChange).
const CHANGE_CAPTION = {
  off: "вимкнуть через",
  on: "дадуть через",
  maybe: "можливе вимкнення через",
  end: "до кінця графіка"
};

function makeMedium(cfg, model, data, now) {
  const w = new ListWidget();
  w.backgroundColor = color(P.bg);
  w.setPadding(12, 15, 10, 15);
  header(w, cfg);
  w.addSpacer(7);

  const cur = model.stateAt(now);
  const status = statusFor(cur);
  const change = nextChange(model, now);
  const outages = upcoming(model, now, 3);

  const main = w.addStack();
  main.layoutHorizontally();
  main.topAlignContent();

  // Left: state → "вимкнуть через" → live countdown "4 год 30 хв".
  const left = main.addStack();
  left.layoutVertically();
  label(left, status.text, 11, status.hex, true);
  left.addSpacer(3);
  if (change) {
    label(left, CHANGE_CAPTION[change.newState], 10, P.muted);
    const countdown = left.addDate(change.at);
    countdown.applyRelativeStyle(); // iOS formats it ("4 год 30 хв") in the phone's language
    countdown.font = Font.boldSystemFont(26);
    countdown.textColor = color(P.white);
    countdown.lineLimit = 1;
    countdown.minimumScaleFactor = 0.6;
  } else if (cur === "on") {
    label(left, model.tomorrow ? "до кінця завтра" : "до кінця дня", 19, P.white, true);
  } else {
    label(left, cur === "unknown" ? "ще не опубліковано" : "час зміни невідомий", 10, P.muted);
  }

  // Right: up to three nearest outages, including the current one.
  main.addSpacer();
  const right = main.addStack();
  right.layoutVertically();
  label(right, "ВІДКЛЮЧЕННЯ", 9, P.muted, true);
  right.addSpacer(5);
  if (outages.length) {
    for (const it of outages) {
      label(right, `● ${rangeText(it, now)}`, 11, it.kind === "off" ? P.off : P.maybe, true);
      right.addSpacer(3);
    }
  } else {
    label(right, model.today ? "Без відключень" : "—", 10, P.muted);
  }

  w.addSpacer();
  if (model.today) {
    const image = w.addImage(dayBar(model, now));
    image.resizable = true;
    image.applyFittingContentMode(); // stretch to the content width, which differs between iPhones
    w.addSpacer(4);
  }
  footer(w, model, data);
  w.refreshAfterDate = refreshDate(change);
  return w;
}

// Sizes not implemented yet: small and lock screen.
function makeUnsupported() {
  const w = new ListWidget();
  w.addText("Світло ІФ: поки є лише середній розмір");
  return w;
}

function makeError(cfg, error) {
  const w = new ListWidget();
  w.refreshAfterDate = new Date(Date.now() + 10 * 60 * 1000);
  w.backgroundColor = color(P.bg);
  w.setPadding(12, 15, 11, 15);
  header(w, cfg);
  w.addSpacer();
  label(w, "Графік недоступний", 17, P.maybe, true);
  w.addSpacer(6);
  const t = w.addText(String((error && error.message) || error));
  t.font = Font.systemFont(11);
  t.textColor = color(P.muted);
  t.lineLimit = 2;
  w.addSpacer();
  return w;
}

async function buildWidget(cfg) {
  const now = new Date();
  try {
    const data = await loadData(cfg.queue);
    return makeMedium(cfg, buildModel(data.days, now), data, now);
  } catch (error) {
    return makeError(cfg, error);
  }
}

// Parameter is empty or unreadable: show a hint and do not fetch the schedule.
function makeSetup() {
  const w = new ListWidget();
  w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);
  w.backgroundColor = color(P.bg);
  w.setPadding(12, 15, 11, 15);
  label(w, "⚡ СВІТЛО", 12, P.white, true);
  w.addSpacer();
  label(w, "Вкажи чергу", 16, P.maybe, true);
  w.addSpacer(6);
  const t = w.addText("Утримай віджет → «Редагувати віджет» → Parameter: черга і, за бажанням, назва через пробіл.\nНапр.: 4.2 Квартира");
  t.font = Font.systemFont(11);
  t.textColor = color(P.muted);
  t.lineLimit = 6;
  t.minimumScaleFactor = 0.8;
  w.addSpacer();
  return w;
}

// ---------- Running in the app: hint and preview ----------

async function app(info = {}) {
  let warning = "";
  for (;;) {
    const a = new Alert();
    a.title = "Світло ІФ";
    a.message = warning +
      "Чергу вкажи у віджеті: утримай віджет → «Редагувати віджет» → Parameter. " +
      "Черга обов'язкова, назва за бажанням через пробіл: «4.2 Квартира» або «4.2»." +
      "\n\nЩоб подивитися віджет тут, впиши параметр і натисни «Показати віджет»." +
      `\n\nВерсія ${VERSION}` + (info.updateError ? `\n⚠︎ Оновлення: ${info.updateError}` : "");
    a.addTextField("4.2 Квартира", args.widgetParameter || "4.2");
    a.addAction("Показати віджет");
    a.addCancelAction("Готово");
    if (await a.presentAlert() < 0) return;
    const cfg = parseParam(a.textFieldValue(0));
    if (!cfg) {
      warning = "⚠︎ Не вдалося прочитати чергу. Потрібно так: 4.2 Квартира\n\n";
      continue;
    }
    await (await buildWidget(cfg)).presentMedium();
    return;
  }
}

// ---------- Module interface for loader.js ----------

module.exports = {
  apiVersion: 1,
  version: VERSION,
  // Widget for the current size and parameter.
  widget: async () => {
    if ((config.widgetFamily || "medium") !== "medium") return makeUnsupported();
    const cfg = parseParam(args.widgetParameter);
    return cfg ? await buildWidget(cfg) : makeSetup();
  },
  app
};
