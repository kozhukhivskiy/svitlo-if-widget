// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: orange; icon-glyph: bolt;

// Svitlo IF loader. Installed in Scriptable once.
// The widget code (widget.js) comes from the LATEST RELEASE of REPOSITORY,
// so new commits reach people only after a release is published.
// Queue and name live in each widget's Parameter, so updates never touch them.

const REPOSITORY = "kozhukhivskiy/svitlo-if-widget";
const MODULE_HEADER = "// Svitlo IF widget module (API 1)\n";
const CHECK_INTERVAL = 3 * 60 * 60 * 1000; // widgets check for updates at most once every 3 hours
const MAX_SIZE = 300000;

const fm = FileManager.local();
const dir = fm.joinPath(fm.libraryDirectory(), "svitlo-if-loader");
const statePath = fm.joinPath(dir, "state.json");
const fileOf = name => fm.joinPath(dir, name);
const TAG_RE = /^[A-Za-z0-9._-]{1,40}$/;
const isModuleFile = name =>
  typeof name === "string" && /^widget-[A-Za-z0-9._-]{1,40}\.js$/.test(name) && fm.fileExists(fileOf(name));

function readState() {
  const empty = { current: null, previous: null, tag: null, checkedAt: 0, lastError: null };
  try {
    if (!fm.fileExists(statePath)) return empty;
    const s = JSON.parse(fm.readString(statePath));
    return {
      current: isModuleFile(s.current) ? s.current : null,
      previous: isModuleFile(s.previous) ? s.previous : null,
      tag: typeof s.tag === "string" ? s.tag : null,
      checkedAt: Number.isFinite(s.checkedAt) ? s.checkedAt : 0,
      lastError: typeof s.lastError === "string" ? s.lastError : null
    };
  } catch (_) {
    return empty;
  }
}

function writeState(state) {
  try {
    fm.createDirectory(dir, true);
    fm.writeString(statePath, JSON.stringify(state));
  } catch (e) {
    console.log(`Loader state: ${e.message}`);
  }
}

function load(name) {
  const core = importModule(fileOf(name));
  if (!core || core.apiVersion !== 1 || typeof core.widget !== "function" || typeof core.app !== "function") {
    throw new Error("Несумісна версія модуля");
  }
  return core;
}

async function checkUpdate(state) {
  state.checkedAt = Date.now();
  const api = new Request(`https://api.github.com/repos/${REPOSITORY}/releases/latest`);
  api.timeoutInterval = 8;
  api.headers = { "Accept": "application/vnd.github+json" };
  let release = null;
  try { release = await api.loadJSON(); } catch (_) { /* the status is checked below */ }
  const status = api.response && api.response.statusCode;
  if (status === 404) throw new Error("У репозиторії ще немає релізу");
  if (status !== 200) throw new Error(`GitHub недоступний${status ? ` (HTTP ${status})` : ""}`);
  const tag = release && release.tag_name;
  if (typeof tag !== "string" || !TAG_RE.test(tag)) throw new Error("Некоректний тег релізу");

  const name = `widget-${tag}.js`;
  if (state.current === name && isModuleFile(name)) return false;

  // Take the file from this exact tag, not from a branch, so everyone gets the same code.
  const request = new Request(`https://raw.githubusercontent.com/${REPOSITORY}/${encodeURIComponent(tag)}/widget.js`);
  request.timeoutInterval = 10;
  const code = await request.loadString();
  if (!request.response || request.response.statusCode !== 200) throw new Error("Не вдалося завантажити widget.js");
  if (typeof code !== "string" || code.length > MAX_SIZE || !code.startsWith(MODULE_HEADER)) {
    throw new Error("Файл релізу не схожий на модуль віджета");
  }

  fm.createDirectory(dir, true);
  fm.writeString(fileOf(name), code);
  try {
    load(name);
  } catch (e) {
    try { fm.remove(fileOf(name)); } catch (_) {}
    throw e;
  }
  // Keep one previous version for rollback and delete older ones.
  if (state.current && state.current !== name) {
    if (state.previous && state.previous !== state.current && isModuleFile(state.previous)) {
      try { fm.remove(fileOf(state.previous)); } catch (_) {}
    }
    state.previous = state.current;
  }
  state.current = name;
  state.tag = tag;
  return true;
}

function fallbackWidget(state) {
  const w = new ListWidget();
  w.url = `scriptable:///run?scriptName=${encodeURIComponent(Script.name())}`;
  w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
  const family = config.widgetFamily || "medium";
  const title = w.addText(family.startsWith("accessory") ? "Світло: потрібне завантаження" : "Потрібне перше завантаження");
  title.font = Font.semiboldSystemFont(family.startsWith("accessory") ? 12 : 16);
  title.lineLimit = 2;
  if (!family.startsWith("accessory")) {
    w.backgroundColor = new Color("161D2A");
    title.textColor = Color.white();
    w.addSpacer(6);
    const detail = w.addText(state.lastError || "Підключись до інтернету й запусти «Світло ІФ» у Scriptable.");
    detail.font = Font.systemFont(12);
    detail.textColor = new Color("94A3B8");
    detail.lineLimit = 3;
  }
  return w;
}

const state = readState();
const now = Date.now();
const due = config.runsInApp || !state.current || now < state.checkedAt || now - state.checkedAt >= CHECK_INTERVAL;
if (due) {
  try {
    await checkUpdate(state);
    state.lastError = null;
  } catch (e) {
    state.lastError = String(e.message || e);
    console.log(`Update: ${state.lastError}`);
  }
  writeState(state);
}

const candidates = [...new Set([state.current, state.previous])].filter(isModuleFile);

if (config.runsInWidget) {
  let widget = null;
  for (const name of candidates) {
    try {
      widget = await load(name).widget();
      if (name !== state.current) { // the new version failed, so stay on the previous one
        state.current = name;
        state.previous = null;
        state.tag = name.slice("widget-".length, -".js".length);
        writeState(state);
      }
      break;
    } catch (e) {
      console.log(`Module ${name}: ${e.message}`);
    }
  }
  Script.setWidget(widget || fallbackWidget(state));
} else {
  let core = null;
  for (const name of candidates) {
    try { core = load(name); break; } catch (e) { console.log(`Module ${name}: ${e.message}`); }
  }
  if (core) {
    await core.app({ tag: state.tag, updateError: state.lastError });
  } else {
    const a = new Alert();
    a.title = "Не вдалося завантажити віджет";
    a.message = state.lastError || "Перевір інтернет і спробуй ще раз.";
    a.addAction("OK");
    await a.presentAlert();
  }
}
Script.complete();
