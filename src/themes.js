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
  headerBg:   "rgba(5,5,8,0.95)",
  headerBorder:"rgba(255,255,255,0.06)",

  // ── Borders ───────────────────────────────────────────────────────────────
  border:     "rgba(255,255,255,0.06)",
  borderHi:   "rgba(255,255,255,0.13)",

  // ── Text ──────────────────────────────────────────────────────────────────
  text:       "#E2E8F0",
  muted:      "#64748B",
  faint:      "#1E293B",
  subtleBg:   "#1E293B",

  // ── Primary CTA accent ────────────────────────────────────────────────────
  accent:      "#E8C27A",
  accentDim:   "rgba(232,194,122,0.10)",
  accentBorder:"rgba(232,194,122,0.24)",
  accentText:  "#050508",
  gold:        "#E8C27A",
  goldDim:     "rgba(232,194,122,0.10)",
  goldBorder:  "rgba(232,194,122,0.24)",

  // ── Semantic market colours ───────────────────────────────────────────────
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

  bg:         "#eeeade",
  surface:    "#f2ede4",
  surfaceHi:  "#f7f2ea",
  cardBg:     "#f5f0e6",
  modalBg:    "#f2ede4",
  inputBg:    "#f7f2ea",

  headerBg:   "rgba(238,234,222,0.96)",
  headerBorder:"#d8d4c8",

  border:     "#d8d4c8",
  borderHi:   "#c6c0b2",

  text:       "#141413",
  muted:      "#5c5b55",
  faint:      "#d4d1c7",
  subtleBg:   "#e8e6dc",

  accent:      "#c96442",
  accentDim:   "rgba(201,100,66,0.10)",
  accentBorder:"rgba(201,100,66,0.30)",
  accentText:  "#ffffff",
  gold:        "#c96442",
  goldDim:     "rgba(201,100,66,0.10)",
  goldBorder:  "rgba(201,100,66,0.30)",

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

  accent:      "#a78bfa",
  accentDim:   "rgba(167,139,250,0.12)",
  accentBorder:"rgba(167,139,250,0.30)",
  accentText:  "#0d1117",
  gold:        "#a78bfa",
  goldDim:     "rgba(167,139,250,0.12)",
  goldBorder:  "rgba(167,139,250,0.30)",

  green:       "#22c55e",
  greenDim:    "rgba(34,197,94,0.12)",
  blue:        "#38bdf8",
  blueDim:     "rgba(56,189,248,0.10)",
  purple:      "#fb923c",
  purpleDim:   "rgba(251,146,60,0.10)",
  radar:       "#22d3ee",
  radarDim:    "rgba(34,211,238,0.10)",
  radarBorder: "rgba(34,211,238,0.28)",
  edge:        "#f59e0b",
  edgeDim:     "rgba(245,158,11,0.10)",
  edgeBorder:  "rgba(245,158,11,0.28)",
  red:         "#f87171",
  redDim:      "rgba(248,113,113,0.10)",
  amber:       "#f59e0b",
  amberDim:    "rgba(245,158,11,0.10)",
  orange:      "#fb923c",
  orangeDim:   "rgba(251,146,60,0.10)",
  dc:          "#f472b6",
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
//  NEW: THEME_MILK — Fade milk minimal
//  Off-white canvas, never bright. Jet black text. Surgical precision.
//  Think: a printed research report on quality paper.
// ─────────────────────────────────────────────────────────────────────────────

export const THEME_MILK = {
  id: "milk", name: "Milk", emoji: "🥛",
  desc: "Off-white canvas, jet black type, obsessive minimalism",

  // Milk tones — warm whites, never harsh
  bg:         "#f4f1ec",          // warm milk — softly beige, never bright
  surface:    "#f8f6f2",          // cream surface, barely lifted
  surfaceHi:  "#faf9f6",          // near-white for hovers
  cardBg:     "#f8f6f2",
  modalBg:    "#f4f1ec",
  inputBg:    "#ffffff",          // inputs go pure white for clarity

  headerBg:   "rgba(244,241,236,0.97)",
  headerBorder:"rgba(0,0,0,0.07)",

  border:     "rgba(0,0,0,0.07)",
  borderHi:   "rgba(0,0,0,0.14)",

  // Text — jet black hierarchy, serious and sharp
  text:       "#0a0a0a",          // near-true black
  muted:      "#5a5a5a",          // mid grey — ~6:1 on milk bg
  faint:      "rgba(0,0,0,0.05)",
  subtleBg:   "rgba(0,0,0,0.04)",

  // Accent — single pure black. No colour pollution.
  accent:      "#0a0a0a",
  accentDim:   "rgba(10,10,10,0.06)",
  accentBorder:"rgba(10,10,10,0.20)",
  accentText:  "#f4f1ec",         // milk text on black button
  gold:        "#0a0a0a",
  goldDim:     "rgba(10,10,10,0.06)",
  goldBorder:  "rgba(10,10,10,0.20)",

  // Market colours — deeply muted, desaturated on light background
  // Still readable, but not loud — data, not decoration
  green:       "#1a5c38",
  greenDim:    "rgba(26,92,56,0.08)",
  blue:        "#1a3a6b",
  blueDim:     "rgba(26,58,107,0.08)",
  purple:      "#4c2d8a",
  purpleDim:   "rgba(76,45,138,0.08)",
  orange:      "#8a3a10",
  orangeDim:   "rgba(138,58,16,0.08)",
  radar:       "#0a5e58",
  radarDim:    "rgba(10,94,88,0.08)",
  radarBorder: "rgba(10,94,88,0.20)",
  edge:        "#6b4c10",
  edgeDim:     "rgba(107,76,16,0.08)",
  edgeBorder:  "rgba(107,76,16,0.20)",
  red:         "#8a1a1a",
  redDim:      "rgba(138,26,26,0.08)",
  amber:       "#6b4c10",
  amberDim:    "rgba(107,76,16,0.08)",
  dc:          "#7a1a4a",
  dcDim:       "rgba(122,26,74,0.08)",
  silver:      "#888888",
  silverDim:   "rgba(136,136,136,0.08)",

  track:       "rgba(0,0,0,0.06)",
  skeleton:    "rgba(0,0,0,0.05)",
  skeletonHi:  "rgba(0,0,0,0.09)",

  // Typeface: editorial grotesque — Aktiv or Helvetica spirit
  font:        '"Helvetica Neue","Arial",sans-serif',
  btnRadius:   3,               // almost square — precise, Swiss
  cardRadius:  4,
  scrollThumb: "rgba(0,0,0,0.15)",
};

// ─────────────────────────────────────────────────────────────────────────────
//  NEW: THEME_CUPERTINO — What if Apple designed GRM Pro
//  Not "Apple-looking" — Apple THINKING: invisible UI, content is everything.
//  SF Pro rhythm. Vibrancy layers. Hairline borders. Chromatic minimalism.
//  One accent: pure system blue. Everything else recedes.
// ─────────────────────────────────────────────────────────────────────────────

export const THEME_CUPERTINO = {
  id: "cupertino", name: "Cupertino", emoji: "🔵",
  desc: "System blue, vibrancy layers, hairline precision — invisible UI",

  // Base: platinum cool white — not warm, not grey — the Apple neutral
  bg:         "#f2f2f7",          // iOS systemGroupedBackground
  surface:    "#ffffff",          // iOS secondarySystemGroupedBackground
  surfaceHi:  "#f9f9fb",
  cardBg:     "#ffffff",
  modalBg:    "#f2f2f7",
  inputBg:    "#ffffff",

  headerBg:   "rgba(242,242,247,0.82)",   // true vibrancy feel
  headerBorder:"rgba(60,60,67,0.12)",      // iOS separator

  border:     "rgba(60,60,67,0.12)",       // iOS opaqueSeparator
  borderHi:   "rgba(60,60,67,0.22)",

  // Text: Apple's exact label hierarchy
  text:       "#000000",                   // iOS label (primary)
  muted:      "rgba(60,60,67,0.60)",       // iOS secondaryLabel — 4.5:1+
  faint:      "rgba(60,60,67,0.06)",
  subtleBg:   "rgba(60,60,67,0.05)",

  // One accent. Pure. System blue.
  accent:      "#007aff",
  accentDim:   "rgba(0,122,255,0.10)",
  accentBorder:"rgba(0,122,255,0.30)",
  accentText:  "#ffffff",
  gold:        "#007aff",
  goldDim:     "rgba(0,122,255,0.10)",
  goldBorder:  "rgba(0,122,255,0.30)",

  // Market colours — Apple HIG semantic colours, pure system values
  green:       "#34c759",         // systemGreen
  greenDim:    "rgba(52,199,89,0.10)",
  blue:        "#007aff",         // systemBlue
  blueDim:     "rgba(0,122,255,0.10)",
  purple:      "#af52de",         // systemPurple
  purpleDim:   "rgba(175,82,222,0.10)",
  orange:      "#ff9500",         // systemOrange
  orangeDim:   "rgba(255,149,0,0.10)",
  radar:       "#5ac8fa",         // systemTeal
  radarDim:    "rgba(90,200,250,0.10)",
  radarBorder: "rgba(90,200,250,0.28)",
  edge:        "#ff9500",         // systemOrange reused for edge/signal
  edgeDim:     "rgba(255,149,0,0.10)",
  edgeBorder:  "rgba(255,149,0,0.28)",
  red:         "#ff3b30",         // systemRed
  redDim:      "rgba(255,59,48,0.09)",
  amber:       "#ff9f0a",         // systemYellow (dark)
  amberDim:    "rgba(255,159,10,0.09)",
  dc:          "#ff2d55",         // systemPink
  dcDim:       "rgba(255,45,85,0.09)",
  silver:      "rgba(60,60,67,0.42)",   // tertiaryLabel
  silverDim:   "rgba(60,60,67,0.05)",

  track:       "rgba(60,60,67,0.10)",
  skeleton:    "rgba(60,60,67,0.07)",
  skeletonHi:  "rgba(60,60,67,0.03)",

  // SF Pro Rounded — the Apple design system font
  font:        '"SF Pro Rounded","SF Pro Display",-apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif',
  btnRadius:   10,              // iOS default button corner
  cardRadius:  12,              // iOS card corner
  scrollThumb: "rgba(0,0,0,0.20)",
};

// ─────────────────────────────────────────────────────────────────────────────
//  NEW: THEME_VELOCI — Bugatti × Luxury Data
//  Carbon black base. Bugatti Racing Blue (#001A6B deep, #0033A0 brand).
//  Agence gold. The car does 0-60 in 2.3s — the UI should feel that fast.
//  Razor border lines. No clutter. Performance is the aesthetic.
// ─────────────────────────────────────────────────────────────────────────────

export const THEME_VELOCI = {
  id: "veloci", name: "Veyron", emoji: "🏎️",
  desc: "Carbon black, Bugatti blue, Agence gold — pure performance",

  // Carbon fiber: ultra deep, not pure black — has structure
  bg:         "#08090c",          // carbon void
  surface:    "#0f1218",          // carbon weave surface
  surfaceHi:  "#161b24",          // lifted panel
  cardBg:     "#0f1218",
  modalBg:    "#08090c",
  inputBg:    "#0f1218",

  headerBg:   "rgba(8,9,12,0.98)",
  headerBorder:"rgba(0,51,160,0.40)",   // blue hairline — signature

  border:     "rgba(255,255,255,0.07)",
  borderHi:   "rgba(0,51,160,0.50)",    // Bugatti blue border on hover

  // Text: pure white hierarchy — no warmth, clinical precision
  text:       "#f0f2f5",
  muted:      "#7a8399",
  faint:      "rgba(240,242,245,0.05)",
  subtleBg:   "#0f1218",

  // Dual accent system: blue (primary) + gold (signal/highlight)
  // Bugatti uses blue as brand, gold as trim — we mirror that
  accent:      "#0033a0",         // Bugatti Racing Blue
  accentDim:   "rgba(0,51,160,0.15)",
  accentBorder:"rgba(0,51,160,0.50)",
  accentText:  "#ffffff",
  gold:        "#c8a96e",         // Agence gold — the trim
  goldDim:     "rgba(200,169,110,0.12)",
  goldBorder:  "rgba(200,169,110,0.35)",

  // Market colours — vivid on carbon, chosen to complement blue/gold palette
  green:       "#00d68f",         // telemetry green — sector time
  greenDim:    "rgba(0,214,143,0.10)",
  blue:        "#4d9fff",         // brightened Bugatti blue for data
  blueDim:     "rgba(77,159,255,0.10)",
  purple:      "#a78bfa",
  purpleDim:   "rgba(167,139,250,0.10)",
  orange:      "#ff7b00",         // pit lane orange
  orangeDim:   "rgba(255,123,0,0.10)",
  radar:       "#00bcd4",
  radarDim:    "rgba(0,188,212,0.10)",
  radarBorder: "rgba(0,188,212,0.30)",
  edge:        "#c8a96e",         // gold is the edge signal
  edgeDim:     "rgba(200,169,110,0.12)",
  edgeBorder:  "rgba(200,169,110,0.35)",
  red:         "#ff3d55",
  redDim:      "rgba(255,61,85,0.10)",
  amber:       "#c8a96e",
  amberDim:    "rgba(200,169,110,0.12)",
  dc:          "#ff6eb4",
  dcDim:       "rgba(255,110,180,0.09)",
  silver:      "#7a8399",
  silverDim:   "rgba(122,131,153,0.08)",

  track:       "#0f1218",
  skeleton:    "rgba(240,242,245,0.05)",
  skeletonHi:  "rgba(240,242,245,0.10)",

  // Typeface: tight grotesque — engineered, not designed
  font:        '"Barlow Condensed","Barlow","Franklin Gothic Medium","Arial Narrow",sans-serif',
  btnRadius:   2,               // almost zero — machined, not rounded
  cardRadius:  3,
  scrollThumb: "#1a2035",
};

// ─────────────────────────────────────────────────────────────────────────────
//  Registry & helpers
// ─────────────────────────────────────────────────────────────────────────────

export const THEMES    = [THEME_DARK, THEME_CLAUDE, THEME_OPENCODE, THEME_GRM, THEME_MILK, THEME_CUPERTINO, THEME_VELOCI];
export const THEME_MAP = {
  dark:       THEME_DARK,
  claude:     THEME_CLAUDE,
  opencode:   THEME_OPENCODE,
  grm:        THEME_GRM,
  milk:       THEME_MILK,
  cupertino:  THEME_CUPERTINO,
  veloci:     THEME_VELOCI,
};

const LS_KEY = "grm_theme_v1";

export function loadSavedTheme() {
  try { return THEME_MAP[localStorage.getItem(LS_KEY)] || THEME_GRM; }
  catch { return THEME_GRM; }
}

export function saveTheme(id) {
  try { localStorage.setItem(LS_KEY, id); } catch {}
}

// Clamp pill/button radius — Veyron uses 2px which is fine, Apple uses 10
export const clampR = (r, max = 30) => Math.min(r, max);
