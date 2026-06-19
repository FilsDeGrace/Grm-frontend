// ─────────────────────────────────────────────────────────────────────────────
//  themes.js  —  GRM Pro design system
//  Semantic tokens: every key describes PURPOSE, not appearance.
//  App.jsx uses C.xxx everywhere — themes.js maps those to the right value
//  per theme so light/dark surfaces always have readable contrast.
// ─────────────────────────────────────────────────────────────────────────────

export const THEME_DARK = {
  id: "dark", name: "Dark Mode", emoji: "🌙",
  desc: "Original — deep space, gold accents",

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
//  THEME_NOIR — Cold crimson editorial
//  Base: near-black charcoal with a faint purple undertone (#141018)
//  Accent: arterial crimson (#c0292b) — one color, used surgically
//  Vibe: Bloomberg terminal crossed with a fashion magazine. Dangerous calm.
//  Font: Tight grotesque — compressed, editorial, no warmth
// ─────────────────────────────────────────────────────────────────────────────

export const THEME_NOIR = {
  id: "noir", name: "Noir Rouge", emoji: "🔴",
  desc: "Charcoal base, cold crimson accent — editorial danger",

  bg:         "#141018",          // near-black, purple undertone
  surface:    "#1c1820",          // lifted dark with same undertone
  surfaceHi:  "#231f2a",
  cardBg:     "#1c1820",
  modalBg:    "#141018",
  inputBg:    "#1c1820",

  headerBg:   "rgba(20,16,24,0.97)",
  headerBorder:"rgba(192,41,43,0.20)",   // crimson hairline in header

  border:     "rgba(255,255,255,0.07)",
  borderHi:   "rgba(192,41,43,0.35)",    // crimson on hover

  text:       "#ece8f0",                  // cool white with purple tinge
  muted:      "#8a8492",
  faint:      "rgba(236,232,240,0.05)",
  subtleBg:   "#1c1820",

  accent:      "#c0292b",         // arterial crimson
  accentDim:   "rgba(192,41,43,0.12)",
  accentBorder:"rgba(192,41,43,0.40)",
  accentText:  "#ece8f0",
  gold:        "#c0292b",
  goldDim:     "rgba(192,41,43,0.12)",
  goldBorder:  "rgba(192,41,43,0.40)",

  // Market colours — vivid enough to read on dark purple-charcoal
  green:       "#2ecc71",
  greenDim:    "rgba(46,204,113,0.10)",
  blue:        "#5b9cf6",
  blueDim:     "rgba(91,156,246,0.10)",
  purple:      "#b57bee",
  purpleDim:   "rgba(181,123,238,0.10)",
  orange:      "#e8852a",
  orangeDim:   "rgba(232,133,42,0.10)",
  radar:       "#1abccd",
  radarDim:    "rgba(26,188,205,0.10)",
  radarBorder: "rgba(26,188,205,0.28)",
  edge:        "#f0c040",
  edgeDim:     "rgba(240,192,64,0.10)",
  edgeBorder:  "rgba(240,192,64,0.28)",
  red:         "#c0292b",         // red IS the accent here — consistent
  redDim:      "rgba(192,41,43,0.12)",
  amber:       "#e8852a",
  amberDim:    "rgba(232,133,42,0.10)",
  dc:          "#e05a8a",
  dcDim:       "rgba(224,90,138,0.09)",
  silver:      "#8a8492",
  silverDim:   "rgba(138,132,146,0.08)",

  track:       "#1c1820",
  skeleton:    "rgba(236,232,240,0.05)",
  skeletonHi:  "rgba(236,232,240,0.10)",

  font:        '"Barlow Semi Condensed","Barlow","Trebuchet MS",sans-serif',
  btnRadius:   4,
  cardRadius:  6,
  scrollThumb: "#2e2830",
};

// ─────────────────────────────────────────────────────────────────────────────
//  THEME_DUSK — Blue-slate stadium hour
//  Base: deep blue-slate (#141c2e) — the colour of a stadium at 7:30pm,
//  floodlights just fired, sky not fully dark. Full of electricity.
//  Accent: neon coral (#ff5e3a) — live match energy, urgent, kinetic
//  Vibe: Sky Sports dashboard if it had taste. Athletic. Present tense.
// ─────────────────────────────────────────────────────────────────────────────

export const THEME_DUSK = {
  id: "dusk", name: "Dusk", emoji: "🌆",
  desc: "Blue-slate stadium hour, neon coral — live match energy",

  bg:         "#111827",          // deep blue-charcoal — Tailwind gray-900 territory
  surface:    "#1a2235",          // true blue-slate lift
  surfaceHi:  "#202c42",
  cardBg:     "#1a2235",
  modalBg:    "#111827",
  inputBg:    "#1a2235",

  headerBg:   "rgba(17,24,39,0.97)",
  headerBorder:"rgba(255,94,58,0.18)",   // coral hairline

  border:     "rgba(255,255,255,0.08)",
  borderHi:   "rgba(255,94,58,0.40)",    // coral on active

  text:       "#e8edf5",
  muted:      "#7e8da8",
  faint:      "rgba(232,237,245,0.05)",
  subtleBg:   "#1a2235",

  accent:      "#ff5e3a",         // neon coral — live, urgent
  accentDim:   "rgba(255,94,58,0.12)",
  accentBorder:"rgba(255,94,58,0.38)",
  accentText:  "#ffffff",
  gold:        "#ff5e3a",
  goldDim:     "rgba(255,94,58,0.12)",
  goldBorder:  "rgba(255,94,58,0.38)",

  // Market colours — punchy against blue-slate
  green:       "#00e676",         // electric green — full signal
  greenDim:    "rgba(0,230,118,0.10)",
  blue:        "#40a9ff",         // sky blue — complementary
  blueDim:     "rgba(64,169,255,0.10)",
  purple:      "#c084fc",
  purpleDim:   "rgba(192,132,252,0.10)",
  orange:      "#ff5e3a",         // accent reuse — orange IS coral here
  orangeDim:   "rgba(255,94,58,0.10)",
  radar:       "#00d4e0",
  radarDim:    "rgba(0,212,224,0.10)",
  radarBorder: "rgba(0,212,224,0.28)",
  edge:        "#ffd60a",         // signal yellow on slate is sharp
  edgeDim:     "rgba(255,214,10,0.10)",
  edgeBorder:  "rgba(255,214,10,0.28)",
  red:         "#ff4757",
  redDim:      "rgba(255,71,87,0.10)",
  amber:       "#ffab00",
  amberDim:    "rgba(255,171,0,0.10)",
  dc:          "#f472b6",
  dcDim:       "rgba(244,114,182,0.09)",
  silver:      "#7e8da8",
  silverDim:   "rgba(126,141,168,0.08)",

  track:       "#1a2235",
  skeleton:    "rgba(232,237,245,0.05)",
  skeletonHi:  "rgba(232,237,245,0.10)",

  font:        '"Inter","DM Sans","Helvetica Neue",sans-serif',
  btnRadius:   8,
  cardRadius:  10,
  scrollThumb: "#2a3650",
};

// ─────────────────────────────────────────────────────────────────────────────
//  THEME_OBSIDIAN — Private members club analytics
//  Base: warm obsidian (#13100e) — volcanic, rich, not cold-grey-boring
//  Accent: molten gold (#d4a843) — not yellow, not bronze — molten
//  Card borders get a gold hairline treatment. Feels like wealth and privacy.
//  Vibe: If a hedge fund's internal analytics tool had a night mode
//  Font: Didot-adjacent serif — old money editorial
// ─────────────────────────────────────────────────────────────────────────────

export const THEME_OBSIDIAN = {
  id: "obsidian", name: "Obsidian", emoji: "✦",
  desc: "Warm volcanic black, molten gold — private club precision",

  bg:         "#0e0c0a",          // warm obsidian — almost black, brown undertone
  surface:    "#171410",          // lifted volcanic
  surfaceHi:  "#1f1b16",
  cardBg:     "#171410",
  modalBg:    "#0e0c0a",
  inputBg:    "#171410",

  headerBg:   "rgba(14,12,10,0.98)",
  headerBorder:"rgba(212,168,67,0.25)",  // gold hairline — restrained luxury

  border:     "rgba(255,255,255,0.06)",
  borderHi:   "rgba(212,168,67,0.35)",   // gold activates on interaction

  text:       "#f0ebe3",                  // warm white — ivory, not cold
  muted:      "#9a8f80",
  faint:      "rgba(240,235,227,0.05)",
  subtleBg:   "#171410",

  accent:      "#d4a843",         // molten gold
  accentDim:   "rgba(212,168,67,0.12)",
  accentBorder:"rgba(212,168,67,0.38)",
  accentText:  "#0e0c0a",         // obsidian text on gold button
  gold:        "#d4a843",
  goldDim:     "rgba(212,168,67,0.12)",
  goldBorder:  "rgba(212,168,67,0.38)",

  // Market colours — warm-shifted palette to match obsidian base
  green:       "#4ade80",
  greenDim:    "rgba(74,222,128,0.10)",
  blue:        "#7db8f7",
  blueDim:     "rgba(125,184,247,0.10)",
  purple:      "#c4a8fa",
  purpleDim:   "rgba(196,168,250,0.10)",
  orange:      "#fb9b3a",
  orangeDim:   "rgba(251,155,58,0.10)",
  radar:       "#34d4c0",
  radarDim:    "rgba(52,212,192,0.10)",
  radarBorder: "rgba(52,212,192,0.28)",
  edge:        "#d4a843",         // gold IS the edge signal — unified
  edgeDim:     "rgba(212,168,67,0.12)",
  edgeBorder:  "rgba(212,168,67,0.35)",
  red:         "#f87171",
  redDim:      "rgba(248,113,113,0.10)",
  amber:       "#d4a843",
  amberDim:    "rgba(212,168,67,0.12)",
  dc:          "#f4a0c8",
  dcDim:       "rgba(244,160,200,0.09)",
  silver:      "#9a8f80",
  silverDim:   "rgba(154,143,128,0.08)",

  track:       "#171410",
  skeleton:    "rgba(240,235,227,0.05)",
  skeletonHi:  "rgba(240,235,227,0.10)",

  // High-contrast serif with old-money weight
  font:        '"Playfair Display","Georgia","Times New Roman",serif',
  btnRadius:   2,               // hard edge — machined, not soft
  cardRadius:  4,
  scrollThumb: "#2a2318",
};

// ─────────────────────────────────────────────────────────────────────────────
//  Registry & helpers
// ─────────────────────────────────────────────────────────────────────────────

export const THEMES    = [THEME_DARK, THEME_CLAUDE, THEME_GRM, THEME_NOIR, THEME_DUSK, THEME_OBSIDIAN];
export const THEME_MAP = {
  dark:     THEME_DARK,
  claude:   THEME_CLAUDE,
  grm:      THEME_GRM,
  noir:     THEME_NOIR,
  dusk:     THEME_DUSK,
  obsidian: THEME_OBSIDIAN,
};

const LS_KEY = "grm_theme_v1";

export function loadSavedTheme() {
  try { return THEME_MAP[localStorage.getItem(LS_KEY)] || THEME_GRM; }
  catch { return THEME_GRM; }
}

export function saveTheme(id) {
  try { localStorage.setItem(LS_KEY, id); } catch {}
}

export const clampR = (r, max = 30) => Math.min(r, max);
