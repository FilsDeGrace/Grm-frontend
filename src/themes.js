// ─────────────────────────────────────────────────────────────────────────────
//  themes.js  —  GRM Pro design system
//  Semantic tokens: every key describes PURPOSE, not appearance.
//  App.jsx uses C.xxx everywhere — themes.js maps those to the right value
//  per theme so light/dark surfaces always have readable contrast.
// ─────────────────────────────────────────────────────────────────────────────

export const THEME_DARK = {
  id: "dark", name: "Dark Mode", emoji: "🌙",
  desc: "Original — deep space, gold accents",

  // ── Surfaces ──────────────────────────────────────────────────────────────
  bg:         "#050508",
  surface:    "rgba(255,255,255,0.025)",
  surfaceHi:  "rgba(255,255,255,0.045)",
  cardBg:     "rgba(255,255,255,0.03)",
  modalBg:    "#0d1117",
  inputBg:    "rgba(0,0,0,0.35)",

  // ── Header (sticky) ───────────────────────────────────────────────────────
  headerBg:   "rgba(5,5,8,0.95)",       // near-black frosted
  headerBorder:"rgba(255,255,255,0.06)",

  // ── Borders ───────────────────────────────────────────────────────────────
  border:     "rgba(255,255,255,0.06)",
  borderHi:   "rgba(255,255,255,0.13)",

  // ── Text ──────────────────────────────────────────────────────────────────
  text:       "#E2E8F0",
  muted:      "#64748B",
  faint:      "#1E293B",
  subtleBg:   "#1E293B",                // used for track, skeleton base

  // ── Primary CTA accent (replaces gold everywhere) ─────────────────────────
  accent:      "#E8C27A",
  accentDim:   "rgba(232,194,122,0.10)",
  accentBorder:"rgba(232,194,122,0.24)",
  accentText:  "#050508",               // text ON the accent button
  // legacy aliases — old code using C.gold still works
  gold:        "#E8C27A",
  goldDim:     "rgba(232,194,122,0.10)",
  goldBorder:  "rgba(232,194,122,0.24)",

  // ── Semantic market colours — vivid, work on dark surface ─────────────────
  green:       "#34D399",
  greenDim:    "rgba(52,211,153,0.10)",
  blue:        "#60A5FA",
  blueDim:     "rgba(96,165,250,0.10)",
  purple:      "#A78BFA",
  purpleDim:   "rgba(167,139,250,0.10)",
  orange:      "#FB923C",
  orangeDim:   "rgba(251,146,60,0.10)",
  radar:       "#2DD4BF",
  radarDim:    "rgba(45,212,191,0.10)",
  radarBorder: "rgba(45,212,191,0.28)",
  edge:        "#818CF8",
  edgeDim:     "rgba(129,140,248,0.12)",
  edgeBorder:  "rgba(129,140,248,0.28)",
  red:         "#F87171",
  redDim:      "rgba(248,113,113,0.10)",
  amber:       "#FBBF24",
  amberDim:    "rgba(251,191,36,0.10)",
  dc:          "#F472B6",
  dcDim:       "rgba(244,114,182,0.10)",
  silver:      "#94A3B8",
  silverDim:   "rgba(148,163,184,0.07)",

  // ── Progress / skeleton ───────────────────────────────────────────────────
  track:       "#1E293B",
  skeleton:    "rgba(255,255,255,0.06)",
  skeletonHi:  "rgba(255,255,255,0.13)",

  // ── Typography & shape ────────────────────────────────────────────────────
  font:        '"JetBrains Mono","Fira Code",monospace',
  btnRadius:   8,
  cardRadius:  12,

  // ── Scrollbar ─────────────────────────────────────────────────────────────
  scrollThumb: "#1E293B",
};

// ─────────────────────────────────────────────────────────────────────────────

export const THEME_CLAUDE = {
  id: "claude", name: "Claude Warm", emoji: "☀️",
  desc: "Parchment canvas, terracotta, editorial",

  bg:         "#eeeade",          // was #f5f4ed — deeper warm parchment
  surface:    "#f2ede4",          // was #faf9f5
  surfaceHi:  "#f7f2ea",          // was #ffffff
  cardBg:     "#f5f0e6",          // was #ffffff — cards no longer blinding white
  modalBg:    "#f2ede4",
  inputBg:    "#f7f2ea",

  headerBg:   "rgba(238,234,222,0.96)",
  headerBorder:"#d8d4c8",

  border:     "#d8d4c8",          // slightly more defined
  borderHi:   "#c6c0b2",

  text:       "#141413",
  muted:      "#5c5b55",   // was #87867f — 3.8:1 fail → now ~6.2:1 on parchment
  faint:      "#d4d1c7",
  subtleBg:   "#e8e6dc",

  accent:      "#c96442",
  accentDim:   "rgba(201,100,66,0.10)",
  accentBorder:"rgba(201,100,66,0.30)",
  accentText:  "#ffffff",
  gold:        "#c96442",
  goldDim:     "rgba(201,100,66,0.10)",
  goldBorder:  "rgba(201,100,66,0.30)",

  // Market colours — darker/more saturated so they pop on light cards
  green:       "#1a6b41",
  greenDim:    "rgba(26,107,65,0.12)",
  blue:        "#1a5fb4",
  blueDim:     "rgba(26,95,180,0.12)",
  purple:      "#6d28d9",
  purpleDim:   "rgba(109,40,217,0.10)",
  orange:      "#c96442",
  orangeDim:   "rgba(201,100,66,0.10)",
  radar:       "#0d7b72",
  radarDim:    "rgba(13,123,114,0.12)",
  radarBorder: "rgba(13,123,114,0.35)",
  edge:        "#4338ca",
  edgeDim:     "rgba(67,56,202,0.10)",
  edgeBorder:  "rgba(67,56,202,0.30)",
  red:         "#b91c1c",
  redDim:      "rgba(185,28,28,0.10)",
  amber:       "#92400e",
  amberDim:    "rgba(146,64,14,0.10)",
  dc:          "#9d174d",
  dcDim:       "rgba(157,23,77,0.10)",
  silver:      "#87867f",
  silverDim:   "rgba(135,134,127,0.10)",

  track:       "#e8e6dc",
  skeleton:    "#e0ddd5",
  skeletonHi:  "#eceae3",

  font:        '"Georgia","Times New Roman",serif',
  btnRadius:   12,
  cardRadius:  10,
  scrollThumb: "#d4d1c7",
};


// ─────────────────────────────────────────────────────────────────────────────

export const THEME_APPLE = {
  id: "apple", name: "Apple Glass", emoji: "🍎",
  desc: "Parchment tiles, single blue accent, SF Pro",

  bg:         "#e8e8ec",          // was #f5f5f7 — deeper cool grey
  surface:    "#f0f0f4",          // was #ffffff
  surfaceHi:  "#f5f5f8",          // was #fafafc
  cardBg:     "#ededf1",          // was #ffffff — no blinding white
  modalBg:    "#e8e8ec",
  inputBg:    "#f0f0f4",

  headerBg:   "rgba(232,232,236,0.92)",
  headerBorder:"rgba(0,0,0,0.12)",

  border:     "rgba(0,0,0,0.11)",
  borderHi:   "rgba(0,0,0,0.20)",

  text:       "#1d1d1f",
  muted:      "rgba(0,0,0,0.62)",  // was 0.50 — ~4.0:1 fail → now ~5.2:1 on #f5f5f7
  faint:      "rgba(0,0,0,0.08)",
  subtleBg:   "rgba(0,0,0,0.07)",

  accent:      "#0066cc",
  accentDim:   "rgba(0,102,204,0.09)",
  accentBorder:"rgba(0,102,204,0.30)",
  accentText:  "#ffffff",
  gold:        "#0066cc",
  goldDim:     "rgba(0,102,204,0.09)",
  goldBorder:  "rgba(0,102,204,0.30)",

  // Market colours — enough contrast on white surface
  green:       "#1a6b41",
  greenDim:    "rgba(26,107,65,0.10)",
  blue:        "#0066cc",
  blueDim:     "rgba(0,102,204,0.10)",
  purple:      "#6d28d9",
  purpleDim:   "rgba(109,40,217,0.09)",
  orange:      "#bf4800",
  orangeDim:   "rgba(191,72,0,0.09)",
  radar:       "#0a7a70",
  radarDim:    "rgba(10,122,112,0.10)",
  radarBorder: "rgba(10,122,112,0.30)",
  edge:        "#272729",
  edgeDim:     "rgba(39,39,41,0.08)",
  edgeBorder:  "rgba(39,39,41,0.25)",
  red:         "#cc0000",
  redDim:      "rgba(204,0,0,0.08)",
  amber:       "#8a5700",
  amberDim:    "rgba(138,87,0,0.08)",
  dc:          "#a3005e",
  dcDim:       "rgba(163,0,94,0.08)",
  silver:      "rgba(0,0,0,0.62)",  // matched to muted fix
  silverDim:   "rgba(0,0,0,0.05)",

  track:       "rgba(0,0,0,0.08)",
  skeleton:    "rgba(0,0,0,0.07)",
  skeletonHi:  "rgba(0,0,0,0.03)",

  font:        'system-ui,-apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif',
  btnRadius:   980,
  cardRadius:  18,
  scrollThumb: "rgba(0,0,0,0.18)",
};


// ─────────────────────────────────────────────────────────────────────────────

export const THEME_OPENCODE = {
  id: "opencode", name: "OpenCode Terminal", emoji: "⌨️",
  desc: "Warm near-black, monospace, Apple HIG semantic colours",

  bg:         "#201d1d",
  surface:    "#302c2c",
  surfaceHi:  "#3a3535",
  cardBg:     "#302c2c",
  modalBg:    "#201d1d",
  inputBg:    "#302c2c",

  headerBg:   "rgba(32,29,29,0.98)",
  headerBorder:"rgba(253,252,252,0.10)",

  border:     "rgba(253,252,252,0.10)",
  borderHi:   "rgba(253,252,252,0.20)",

  text:       "#fdfcfc",
  muted:      "#9a9898",
  faint:      "rgba(253,252,252,0.07)",
  subtleBg:   "#302c2c",

  accent:      "#007aff",
  accentDim:   "rgba(0,122,255,0.15)",
  accentBorder:"rgba(0,122,255,0.35)",
  accentText:  "#fdfcfc",
  gold:        "#007aff",
  goldDim:     "rgba(0,122,255,0.15)",
  goldBorder:  "rgba(0,122,255,0.35)",

  green:       "#30d158",
  greenDim:    "rgba(48,209,88,0.12)",
  blue:        "#007aff",
  blueDim:     "rgba(0,122,255,0.12)",
  purple:      "#bf5af2",
  purpleDim:   "rgba(191,90,242,0.10)",
  orange:      "#ff9f0a",
  orangeDim:   "rgba(255,159,10,0.10)",
  radar:       "#5ac8fa",
  radarDim:    "rgba(90,200,250,0.10)",
  radarBorder: "rgba(90,200,250,0.28)",
  edge:        "#007aff",
  edgeDim:     "rgba(0,122,255,0.12)",
  edgeBorder:  "rgba(0,122,255,0.30)",
  red:         "#ff3b30",
  redDim:      "rgba(255,59,48,0.12)",
  amber:       "#ff9f0a",
  amberDim:    "rgba(255,159,10,0.12)",
  dc:          "#ff6b6b",
  dcDim:       "rgba(255,107,107,0.10)",
  silver:      "#9a9898",
  silverDim:   "rgba(154,152,152,0.10)",

  track:       "#302c2c",
  skeleton:    "rgba(253,252,252,0.06)",
  skeletonHi:  "rgba(253,252,252,0.12)",

  font:        '"Berkeley Mono","IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace',
  btnRadius:   4,
  cardRadius:  4,
  scrollThumb: "#646262",
};

// ─────────────────────────────────────────────────────────────────────────────

export const THEME_GRM = {
  id: "grm", name: "GRM Pitch", emoji: "⚽",
  desc: "Stadium black, turf green, violet accent — built for the model",

  bg:         "#0d1117",
  surface:    "#161b22",
  surfaceHi:  "#1c2330",
  cardBg:     "#161b22",
  modalBg:    "#0d1117",
  inputBg:    "#161b22",

  headerBg:   "rgba(13,17,23,0.97)",
  headerBorder:"rgba(255,255,255,0.08)",

  border:     "rgba(255,255,255,0.08)",
  borderHi:   "rgba(255,255,255,0.16)",

  text:       "#e6edf3",
  muted:      "#7d8590",
  faint:      "rgba(230,237,243,0.06)",
  subtleBg:   "#161b22",

  accent:      "#a78bfa",           // Violet — unique across all themes
  accentDim:   "rgba(167,139,250,0.12)",
  accentBorder:"rgba(167,139,250,0.30)",
  accentText:  "#0d1117",
  gold:        "#a78bfa",
  goldDim:     "rgba(167,139,250,0.12)",
  goldBorder:  "rgba(167,139,250,0.30)",

  green:       "#22c55e",           // Turf green — The Read / Over / wins
  greenDim:    "rgba(34,197,94,0.12)",
  blue:        "#38bdf8",           // Sky blue — Under / defensive
  blueDim:     "rgba(56,189,248,0.10)",
  purple:      "#fb923c",           // Match ball orange — BTTS
  purpleDim:   "rgba(251,146,60,0.10)",
  radar:       "#22d3ee",           // Cyan — Goal Radar (unchanged)
  radarDim:    "rgba(34,211,238,0.10)",
  radarBorder: "rgba(34,211,238,0.28)",
  edge:        "#f59e0b",           // Signal amber — The Edge / value alert
  edgeDim:     "rgba(245,158,11,0.10)",
  edgeBorder:  "rgba(245,158,11,0.28)",
  red:         "#f87171",
  redDim:      "rgba(248,113,113,0.10)",
  amber:       "#f59e0b",
  amberDim:    "rgba(245,158,11,0.10)",
  orange:      "#fb923c",
  orangeDim:   "rgba(251,146,60,0.10)",
  dc:          "#f472b6",           // Muted rose — DC secondary pick
  dcDim:       "rgba(244,114,182,0.09)",
  silver:      "#7d8590",
  silverDim:   "rgba(125,133,144,0.08)",

  track:       "#161b22",
  skeleton:    "rgba(230,237,243,0.05)",
  skeletonHi:  "rgba(230,237,243,0.10)",

  font:        '"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace',
  btnRadius:   6,
  cardRadius:  6,
  scrollThumb: "#30363d",
};

// ─────────────────────────────────────────────────────────────────────────────
//  Registry & helpers
// ─────────────────────────────────────────────────────────────────────────────

export const THEMES    = [THEME_DARK, THEME_CLAUDE, THEME_APPLE, THEME_OPENCODE, THEME_GRM];
export const THEME_MAP = { dark:THEME_DARK, claude:THEME_CLAUDE, apple:THEME_APPLE, opencode:THEME_OPENCODE, grm:THEME_GRM };

const LS_KEY = "grm_theme_v1";

export function loadSavedTheme() {
  try { return THEME_MAP[localStorage.getItem(LS_KEY)] || THEME_GRM; }
  catch { return THEME_GRM; }
}

export function saveTheme(id) {
  try { localStorage.setItem(LS_KEY, id); } catch {}
}

// Clamp pill/button radius — Apple uses 980 which is fine for big buttons
// but small inline buttons need a cap so they don't look broken
export const clampR = (r, max = 30) => Math.min(r, max);
