// ─────────────────────────────────────────────────────────────────────────────
//  themes.js  —  GRM Pro design system
//  Semantic tokens: every key describes PURPOSE, not appearance.
//  App.jsx uses C.xxx everywhere — themes.js maps those to the right value
//  per theme so light/dark surfaces always have readable contrast.
// ─────────────────────────────────────────────────────────────────────────────

export const THEME_DARK = {
  id: "dark", name: "Dark Mode", emoji: "🌙",
  desc: "Deep space, gold accents, desaturated jewel tones",

  bg:         "#050508",
  surface:    "rgba(255,255,255,0.025)",
  surfaceHi:  "rgba(255,255,255,0.045)",
  cardBg:     "rgba(255,255,255,0.03)",
  modalBg:    "#0d1117",
  inputBg:    "rgba(0,0,0,0.35)",

  headerBg:   "rgba(5,5,8,0.95)",
  headerBorder:"rgba(255,255,255,0.06)",

  border:     "rgba(255,255,255,0.06)",
  borderHi:   "rgba(255,255,255,0.13)",

  text:       "#E2E8F0",
  muted:      "#64748B",
  faint:      "#1E293B",
  subtleBg:   "#1E293B",

  accent:      "#E8C27A",
  accentDim:   "rgba(232,194,122,0.10)",
  accentBorder:"rgba(232,194,122,0.24)",
  accentText:  "#050508",
  gold:        "#E8C27A",
  goldDim:     "rgba(232,194,122,0.10)",
  goldBorder:  "rgba(232,194,122,0.24)",

  green:       "#2FAE7A",
  greenDim:    "rgba(47,174,122,0.10)",
  blue:        "#5B8DC7",
  blueDim:     "rgba(91,141,199,0.10)",
  purple:      "#9683C9",
  purpleDim:   "rgba(150,131,201,0.10)",
  orange:      "#C97A45",
  orangeDim:   "rgba(201,122,69,0.10)",
  radar:       "#3D9E90",
  radarDim:    "rgba(61,158,144,0.10)",
  radarBorder: "rgba(61,158,144,0.28)",
  edge:        "#7C86B0",
  edgeDim:     "rgba(124,134,176,0.12)",
  edgeBorder:  "rgba(124,134,176,0.28)",
  red:         "#CC5F5A",
  redDim:      "rgba(204,95,90,0.10)",
  amber:       "#C7A052",
  amberDim:    "rgba(199,160,82,0.10)",
  dc:          "#BD6E92",
  dcDim:       "rgba(189,110,146,0.10)",
  silver:      "#94A3B8",
  silverDim:   "rgba(148,163,184,0.07)",

  track:       "#1E293B",
  skeleton:    "rgba(255,255,255,0.06)",
  skeletonHi:  "rgba(255,255,255,0.13)",

  font:        '"JetBrains Mono","Fira Code",monospace',
  btnRadius:   8,
  cardRadius:  12,
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

export const THEME_GRM = {
  id: "grm", name: "GRM Pitch", emoji: "⚽",
  desc: "Stadium black, deep turf green, violet accent — refined, built for the model",

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

  green:       "#3C8F5C",
  greenDim:    "rgba(60,143,92,0.12)",
  blue:        "#4E86AD",
  blueDim:     "rgba(78,134,173,0.10)",
  purple:      "#7C5C9E",
  purpleDim:   "rgba(124,92,158,0.10)",
  radar:       "#3D8F94",
  radarDim:    "rgba(61,143,148,0.10)",
  radarBorder: "rgba(61,143,148,0.28)",
  edge:        "#B0894A",
  edgeDim:     "rgba(176,137,74,0.10)",
  edgeBorder:  "rgba(176,137,74,0.28)",
  red:         "#BD5B5B",
  redDim:      "rgba(189,91,91,0.10)",
  amber:       "#B0894A",
  amberDim:    "rgba(176,137,74,0.10)",
  orange:      "#B87540",
  orangeDim:   "rgba(184,117,64,0.10)",
  dc:          "#A96888",
  dcDim:       "rgba(169,104,136,0.09)",
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
//  THEME_MONO — Monochrome Luxury
//  Base: warm off-white (#F5F4EF) — not clinical white, a breath of linen
//  Text: near-black (#0D0D0D) — ink, not grey
//  Accent: pure black gradient pill — surgical, no colour needed
//  Vibe: Apple Design Language meets a private bank. Silence as a luxury good.
//  Font: "DM Sans" — optical precision, slightly humanist. Clean but not cold.
//  Gradient: used ONLY in accent button — linear #0D0D0D → #2D2D2D
// ─────────────────────────────────────────────────────────────────────────────

export const THEME_MONO = {
  id: "mono", name: "Monochrome", emoji: "◼",
  desc: "Warm linen, ink black, gradient accents — luxury through restraint",

  bg:         "#F5F4EF",          // warm off-white — linen, not clinical
  surface:    "#EEEEE8",          // slightly cooler lift
  surfaceHi:  "#E6E6E0",          // pressed / hovered surface
  cardBg:     "#EEEEE8",
  modalBg:    "#F5F4EF",
  inputBg:    "#EBEBE4",          // very slightly off-surface

  headerBg:   "rgba(245,244,239,0.97)",
  headerBorder:"rgba(0,0,0,0.08)",

  border:     "rgba(0,0,0,0.09)",
  borderHi:   "rgba(0,0,0,0.20)",

  text:       "#0D0D0D",          // ink black
  muted:      "#6B6B6B",          // mid-grey — readable, not faint
  faint:      "rgba(0,0,0,0.05)",
  subtleBg:   "#EEEEE8",

  // The ONE luxury touch: gradient accent
  accent:      "#0D0D0D",
  accentGrad:  "linear-gradient(135deg,#0D0D0D 0%,#3A3A3A 100%)",
  accentDim:   "rgba(13,13,13,0.08)",
  accentBorder:"rgba(13,13,13,0.20)",
  accentText:  "#FFFFFF",
  gold:        "#0D0D0D",
  goldDim:     "rgba(13,13,13,0.07)",
  goldBorder:  "rgba(13,13,13,0.18)",

  // Market colours — desaturated, premium, still distinct
  green:       "#1A7A4A",
  greenDim:    "rgba(26,122,74,0.10)",
  blue:        "#1A4FA8",
  blueDim:     "rgba(26,79,168,0.10)",
  purple:      "#5B3FB5",
  purpleDim:   "rgba(91,63,181,0.10)",
  orange:      "#B85C1A",
  orangeDim:   "rgba(184,92,26,0.10)",
  radar:       "#0D7A72",
  radarDim:    "rgba(13,122,114,0.10)",
  radarBorder: "rgba(13,122,114,0.28)",
  edge:        "#8A6B00",
  edgeDim:     "rgba(138,107,0,0.10)",
  edgeBorder:  "rgba(138,107,0,0.28)",
  red:         "#B51C1C",
  redDim:      "rgba(181,28,28,0.10)",
  amber:       "#8A6B00",
  amberDim:    "rgba(138,107,0,0.10)",
  dc:          "#8C1A5C",
  dcDim:       "rgba(140,26,92,0.09)",
  silver:      "#8A8A84",
  silverDim:   "rgba(138,138,132,0.09)",

  track:       "#EEEEE8",
  skeleton:    "rgba(0,0,0,0.07)",
  skeletonHi:  "rgba(0,0,0,0.13)",

  font:        '"DM Sans","SF Pro Display",-apple-system,BlinkMacSystemFont,sans-serif',
  btnRadius:   10,
  cardRadius:  12,
  scrollThumb: "#C8C8C2",
};

// ─────────────────────────────────────────────────────────────────────────────
//  THEME_ASH — Slate Editorial
//  Base: cold blue-slate (#141922) — not black, deep ocean at midnight
//  Accent: glacial silver (#C8D6E8) — premium fintech. Light from ice.
//  The only warmth is the accent; everything else is precision-cold.
//  Vibe: Revolut Private × Bloomberg terminal × Dior backstage.
//  Font: "Syne" — geometric, editorial, slight tension in every letterform.
// ─────────────────────────────────────────────────────────────────────────────

export const THEME_ASH = {
  id: "ash", name: "Ash", emoji: "❄",
  desc: "Cold slate, glacial silver — fintech editorial precision",

  bg:         "#0F1419",          // deep cold slate — ocean floor
  surface:    "#18202C",          // lifted slate
  surfaceHi:  "#1F2A3A",          // highlight — still cold, more present
  cardBg:     "#18202C",
  modalBg:    "#0F1419",
  inputBg:    "#18202C",

  headerBg:   "rgba(15,20,25,0.97)",
  headerBorder:"rgba(200,214,232,0.10)",  // silver hairline

  border:     "rgba(200,214,232,0.08)",
  borderHi:   "rgba(200,214,232,0.22)",

  text:       "#E8EEF5",          // cold white — precision
  muted:      "#6B7A8F",          // slate-grey — not warm
  faint:      "rgba(232,238,245,0.05)",
  subtleBg:   "#18202C",

  accent:      "#C8D6E8",         // glacial silver
  accentGrad:  "linear-gradient(135deg,#C8D6E8 0%,#8FA8C4 100%)",
  accentDim:   "rgba(200,214,232,0.10)",
  accentBorder:"rgba(200,214,232,0.28)",
  accentText:  "#0F1419",         // dark on silver — sharp
  gold:        "#C8D6E8",
  goldDim:     "rgba(200,214,232,0.10)",
  goldBorder:  "rgba(200,214,232,0.28)",

  // Market colours — vivid against cold slate
  green:       "#22D47A",
  greenDim:    "rgba(34,212,122,0.10)",
  blue:        "#4DB0FF",
  blueDim:     "rgba(77,176,255,0.10)",
  purple:      "#A580F5",
  purpleDim:   "rgba(165,128,245,0.10)",
  orange:      "#FF7A40",
  orangeDim:   "rgba(255,122,64,0.10)",
  radar:       "#00D4C8",
  radarDim:    "rgba(0,212,200,0.10)",
  radarBorder: "rgba(0,212,200,0.28)",
  edge:        "#F5D45A",
  edgeDim:     "rgba(245,212,90,0.10)",
  edgeBorder:  "rgba(245,212,90,0.28)",
  red:         "#FF5060",
  redDim:      "rgba(255,80,96,0.10)",
  amber:       "#F5A623",
  amberDim:    "rgba(245,166,35,0.10)",
  dc:          "#F06EAE",
  dcDim:       "rgba(240,110,174,0.09)",
  silver:      "#6B7A8F",
  silverDim:   "rgba(107,122,143,0.08)",

  track:       "#18202C",
  skeleton:    "rgba(232,238,245,0.05)",
  skeletonHi:  "rgba(232,238,245,0.10)",

  font:        '"Syne","DM Sans","Helvetica Neue",sans-serif',
  btnRadius:   6,
  cardRadius:  8,
  scrollThumb: "#2A3545",
};


// ─────────────────────────────────────────────────────────────────────────────
//  Registry & helpers
// ─────────────────────────────────────────────────────────────────────────────

export const THEMES    = [THEME_DARK, THEME_CLAUDE, THEME_GRM, THEME_MONO, THEME_ASH];
export const THEME_MAP = {
  dark:     THEME_DARK,
  claude:   THEME_CLAUDE,
  grm:      THEME_GRM,
  mono:     THEME_MONO,
  ash:      THEME_ASH,
};

const LS_KEY = "grm_theme_v1";

export function loadSavedTheme() {
  // DEFAULT-THEME-FIX: Ash is now the default for first-time / no-localStorage
  // sessions. Anyone with an existing grm_theme_v1 value keeps their saved
  // choice — this only changes the fallback, not stored preferences.
  try { return THEME_MAP[localStorage.getItem(LS_KEY)] || THEME_ASH; }
  catch { return THEME_ASH; }
}

export function saveTheme(id) {
  try { localStorage.setItem(LS_KEY, id); } catch {}
}

export const clampR = (r, max = 30) => Math.min(r, max);
