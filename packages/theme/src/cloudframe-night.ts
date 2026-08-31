import { defineTheme } from "@astryxdesign/core/theme";
import { neutralIconRegistry, neutralTheme } from "@astryxdesign/theme-neutral";

const interfaceFont = "Instrument Sans Variable";
const interfaceFallbacks =
  '"Segoe UI Variable", "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif';

export const cloudframeNightTheme = defineTheme({
  name: "cloudframe-night",
  extends: neutralTheme,
  color: {
    accent: ["#2477C9", "#62AFFF"],
    neutralStyle: "cool",
    contrast: "high"
  },
  typography: {
    scale: { base: 15, ratio: 1.2 },
    body: {
      family: interfaceFont,
      fallbacks: interfaceFallbacks
    },
    heading: {
      family: interfaceFont,
      fallbacks: interfaceFallbacks,
      weights: { 1: "semibold", 2: "semibold", 3: "semibold", 4: "semibold" }
    },
    code: {
      family: "ui-monospace",
      fallbacks: '"SFMono-Regular", Consolas, "Liberation Mono", monospace'
    }
  },
  radius: { base: 4, multiplier: 1 },
  motion: { fast: 120, medium: 260, slow: 600, ratio: 0.75 },
  tokens: {
    "--color-background-body": "#0F1217",
    "--color-background-surface": "#181C22",
    "--color-background-card": "#171B21",
    "--color-background-popover": "#1E232B",
    "--color-background-muted": "#13171D",
    "--color-overlay": "#080B10B8",
    "--color-overlay-hover": "#FFFFFF0D",
    "--color-overlay-pressed": "#FFFFFF18",
    "--color-accent": "#62AFFF",
    "--color-accent-muted": "#17324F",
    "--color-on-accent": "#07111F",
    "--color-text-primary": "#F4F1EA",
    "--color-text-secondary": "#AAB4C2",
    "--color-text-disabled": "#6E7783",
    "--color-text-accent": "#8BC4FF",
    "--color-icon-primary": "#F4F1EA",
    "--color-icon-secondary": "#AAB4C2",
    "--color-icon-disabled": "#6E7783",
    "--color-icon-accent": "#8BC4FF",
    "--color-border": "#FFFFFF1F",
    "--color-border-emphasized": "#FFFFFF3D",
    "--color-shadow": "#00000066",
    "--focus-outline-color": "#8BC4FF",
    "--focus-outline-width": "4px",
    "--focus-outline-offset": "3px",
    "--shadow-low": "0 2px 8px #00000052",
    "--shadow-med": "0 8px 24px #00000066",
    "--shadow-high": "0 16px 48px #00000080"
  },
  components: {
    button: {
      base: { fontWeight: "600", minHeight: "var(--spacing-11)" }
    },
    card: {
      base: { borderColor: "var(--color-border)" }
    }
  },
  icons: neutralIconRegistry
});
