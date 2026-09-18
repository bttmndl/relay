// ==================================================================
// RELAY — board themes
// Pure visual presets: UI chrome colors + canvas palette + a
// `boardStyle` id that RelayGame's renderer uses to draw a distinct
// classic board design (frame, corner motifs, table markings).
// No theme touches game rules, physics, or player identity.
// ==================================================================

export const THEMES = [
  {
    id: "carrom",
    name: "Classic Carrom",
    tagline: "Wooden rail, corner arrows, center spot",
    boardStyle: "carrom",
    ui: {
      board: "#241408", boardDeep: "#140A04", panel: "#2E1A0D", line: "#4A2E18",
      text: "#F3E3C8", dim: "#B08A63", hot: "#FFF3DD",
    },
    accent: "#D8A34D",
    neutral: "#C9AD86",
    players: ["#F5EEDD", "#8B1E2B"],
    canvas: {
      surfaceTop: "#C79A5B", surfaceBottom: "#A97D42",
      rail: "#5C3A1E", railDeep: "#3B240F",
      holeInner: "#140A05", holeMid: "#2A160A",
      puckHot: "#6B4426", puckCold: "#4A2E18", puckDeep: "#20120A",
      liveGlow: "#FFD27A", queen: "#C81E3A",
    },
    swatch: ["#A97D42", "#F5EEDD", "#8B1E2B"],
  },
  {
    id: "felt",
    name: "Championship Felt",
    tagline: "Green baize, gold rail diamonds",
    boardStyle: "felt",
    ui: {
      board: "#0B2318", boardDeep: "#051209", panel: "#123321", line: "#1E4A30",
      text: "#EAF7EE", dim: "#7FB899", hot: "#FFFFFF",
    },
    accent: "#E3B341",
    neutral: "#8FBFA0",
    players: ["#F4EFD8", "#1B3B6F"],
    canvas: {
      surfaceTop: "#0E4A2E", surfaceBottom: "#052A19",
      rail: "#4A2A16", railDeep: "#2E1A0D",
      holeInner: "#050302", holeMid: "#1A0F08",
      puckHot: "#1F5C3B", puckCold: "#164630", puckDeep: "#052014",
      liveGlow: "#FFE58A", queen: "#D6203F",
    },
    swatch: ["#0E4A2E", "#F4EFD8", "#1B3B6F"],
  },
  {
    id: "deco",
    name: "Deco Marble",
    tagline: "Onyx & gold Art Deco lattice",
    boardStyle: "deco",
    ui: {
      board: "#15151A", boardDeep: "#08080B", panel: "#1E1E24", line: "#34343D",
      text: "#F0EFF4", dim: "#93939E", hot: "#FFFFFF",
    },
    accent: "#D4AF37",
    neutral: "#A9A9B4",
    players: ["#E9C46A", "#D6D9E0"],
    canvas: {
      surfaceTop: "#26262E", surfaceBottom: "#0F0F13",
      rail: "#1A1A20", railDeep: "#0A0A0C",
      holeInner: "#000000", holeMid: "#1C1C22",
      puckHot: "#3A3A44", puckCold: "#26262E", puckDeep: "#0A0A0C",
      liveGlow: "#FFE9A8", queen: "#E23E57",
    },
    swatch: ["#15151A", "#E9C46A", "#D6D9E0"],
  },
];

export const DEFAULT_THEME_ID = "carrom";
const THEME_STORAGE_KEY = "relay-board-theme";

export function getTheme(id) {
  return THEMES.find((t) => t.id === id) || THEMES[0];
}

export function loadStoredThemeId() {
  try {
    const id = localStorage.getItem(THEME_STORAGE_KEY);
    return id && THEMES.some((t) => t.id === id) ? id : DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

export function storeThemeId(id) {
  try { localStorage.setItem(THEME_STORAGE_KEY, id); } catch { /* private mode etc */ }
}

// hex "#rgb" | "#rrggbb" -> {r,g,b}
export function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
