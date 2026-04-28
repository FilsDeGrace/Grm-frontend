// ─────────────────────────────────────────────────────────────────────────────
//  themes.js  —  GRM Pro design system
//  Semantic tokens: every key describes PURPOSE, not appearance.
//  App.jsx uses C.xxx everywhere — themes.js maps those to the right value
//  per theme so light/dark surfaces always have readable contrast.
// ─────────────────────────────────────────────────────────────────────────────

export const THEME_DARK = {
  id: "dark", name: "GRM Dark", emoji: "🌙",
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

  bg:         "#f5f4ed",
  surface:    "#faf9f5",
  surfaceHi:  "#ffffff",
  cardBg:     "#ffffff",
  modalBg:    "#faf9f5",
  inputBg:    "#ffffff",

  headerBg:   "rgba(245,244,237,0.96)",
  headerBorder:"#e8e6dc",

  border:     "#e8e6dc",
  borderHi:   "#d4d1c7",

  text:       "#141413",
  muted:      "#87867f",
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

export const THEME_NIKE = {
  id: "nike", name: "Nike Pitch", emoji: "⚫",
  desc: "Monochrome, pill buttons, stadium energy",

  bg:         "#FFFFFF",
  surface:    "#F5F5F5",
  surfaceHi:  "#EBEBEB",
  cardBg:     "#FAFAFA",
  modalBg:    "#FFFFFF",
  inputBg:    "#F5F5F5",

  headerBg:   "rgba(255,255,255,0.97)",
  headerBorder:"#CACACB",

  border:     "#CACACB",
  borderHi:   "#909092",

  text:       "#111111",
  muted:      "#707072",
  faint:      "#E5E5E5",
  subtleBg:   "#E5E5E5",

  accent:      "#111111",
  accentDim:   "rgba(17,17,17,0.07)",
  accentBorder:"rgba(17,17,17,0.25)",
  accentText:  "#FFFFFF",
  gold:        "#111111",
  goldDim:     "rgba(17,17,17,0.07)",
  goldBorder:  "rgba(17,17,17,0.25)",

  // Market colours — high contrast for white surface
  green:       "#005c35",
  greenDim:    "rgba(0,92,53,0.10)",
  blue:        "#0033cc",
  blueDim:     "rgba(0,51,204,0.10)",
  purple:      "#5b00d6",
  purpleDim:   "rgba(91,0,214,0.08)",
  orange:      "#cc3d00",
  orangeDim:   "rgba(204,61,0,0.08)",
  radar:       "#006b75",
  radarDim:    "rgba(0,107,117,0.10)",
  radarBorder: "rgba(0,107,117,0.30)",
  edge:        "#3333aa",
  edgeDim:     "rgba(51,51,170,0.10)",
  edgeBorder:  "rgba(51,51,170,0.28)",
  red:         "#cc0004",
  redDim:      "rgba(204,0,4,0.08)",
  amber:       "#8a5700",
  amberDim:    "rgba(138,87,0,0.08)",
  dc:          "#a3005e",
  dcDim:       "rgba(163,0,94,0.08)",
  silver:      "#707072",
  silverDim:   "rgba(112,112,114,0.08)",

  track:       "#E5E5E5",
  skeleton:    "#EBEBEB",
  skeletonHi:  "#F5F5F5",

  font:        '"Helvetica Neue","Helvetica","Arial",sans-serif',
  btnRadius:   30,
  cardRadius:  20,
  scrollThumb: "#CACACB",
};

// ─────────────────────────────────────────────────────────────────────────────

export const THEME_APPLE = {
  id: "apple", name: "Apple Glass", emoji: "🍎",
  desc: "Parchment tiles, single blue accent, SF Pro",

  bg:         "#f5f5f7",
  surface:    "#ffffff",
  surfaceHi:  "#fafafc",
  cardBg:     "#ffffff",
  modalBg:    "#f5f5f7",
  inputBg:    "#ffffff",

  headerBg:   "rgba(245,245,247,0.92)",
  headerBorder:"rgba(0,0,0,0.10)",

  border:     "rgba(0,0,0,0.09)",
  borderHi:   "rgba(0,0,0,0.18)",

  text:       "#1d1d1f",
  muted:      "rgba(0,0,0,0.50)",
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
  silver:      "rgba(0,0,0,0.50)",
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

export const THEME_VODAFONE = {
  id: "vodafone", name: "Vodafone Red", emoji: "🔴",
  desc: "White editorial canvas, single brand red, charcoal institutions",

  bg:         "#ffffff",
  surface:    "#f2f2f2",
  surfaceHi:  "#ffffff",
  cardBg:     "#ffffff",
  modalBg:    "#f2f2f2",
  inputBg:    "#ffffff",

  headerBg:   "rgba(255,255,255,0.97)",
  headerBorder:"rgba(0,0,0,0.10)",

  border:     "rgba(0,0,0,0.10)",
  borderHi:   "rgba(0,0,0,0.20)",

  text:       "#25282b",
  muted:      "#7e7e7e",
  faint:      "#f2f2f2",
  subtleBg:   "#f2f2f2",

  accent:      "#e60000",
  accentDim:   "rgba(230,0,0,0.09)",
  accentBorder:"rgba(230,0,0,0.30)",
  accentText:  "#ffffff",
  gold:        "#e60000",
  goldDim:     "rgba(230,0,0,0.09)",
  goldBorder:  "rgba(230,0,0,0.30)",

  green:       "#1a6b41",
  greenDim:    "rgba(26,107,65,0.10)",
  blue:        "#3860be",
  blueDim:     "rgba(56,96,190,0.10)",
  purple:      "#6d28d9",
  purpleDim:   "rgba(109,40,217,0.09)",
  orange:      "#cc3d00",
  orangeDim:   "rgba(204,61,0,0.08)",
  radar:       "#006b75",
  radarDim:    "rgba(0,107,117,0.10)",
  radarBorder: "rgba(0,107,117,0.30)",
  edge:        "#25282b",
  edgeDim:     "rgba(37,40,43,0.08)",
  edgeBorder:  "rgba(37,40,43,0.25)",
  red:         "#e60000",
  redDim:      "rgba(230,0,0,0.08)",
  amber:       "#8a5700",
  amberDim:    "rgba(138,87,0,0.08)",
  dc:          "#ac1811",
  dcDim:       "rgba(172,24,17,0.09)",
  silver:      "#7e7e7e",
  silverDim:   "rgba(126,126,126,0.08)",

  track:       "#f2f2f2",
  skeleton:    "#e8e8e8",
  skeletonHi:  "#f2f2f2",

  font:        '"Vodafone","Helvetica Neue",Arial,sans-serif',
  btnRadius:   2,
  cardRadius:  6,
  scrollThumb: "#bebebe",
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

export const THEMES    = [THEME_DARK, THEME_CLAUDE, THEME_NIKE, THEME_APPLE, THEME_VODAFONE, THEME_OPENCODE, THEME_GRM];
export const THEME_MAP = { dark:THEME_DARK, claude:THEME_CLAUDE, nike:THEME_NIKE, apple:THEME_APPLE, vodafone:THEME_VODAFONE, opencode:THEME_OPENCODE, grm:THEME_GRM };

const LS_KEY = "grm_theme_v1";

export function loadSavedTheme() {
  try { return THEME_MAP[localStorage.getItem(LS_KEY)] || THEME_DARK; }
  catch { return THEME_DARK; }
}

export function saveTheme(id) {
  try { localStorage.setItem(LS_KEY, id); } catch {}
}

// Clamp pill/button radius — Apple uses 980 which is fine for big buttons
// but small inline buttons need a cap so they don't look broken
export const clampR = (r, max = 30) => Math.min(r, max);
