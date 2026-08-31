import postcss from "postcss";

const THEME_ROOT = '[data-astryx-theme="cloudframe-night"]';
const NAMED_COLORS = new Map([
  ["black", [0, 0, 0, 1]],
  ["white", [255, 255, 255, 1]],
  ["transparent", [0, 0, 0, 0]],
  ["red", [255, 0, 0, 1]],
  ["blue", [0, 0, 255, 1]]
]);

export function resolveDarkFunctions(value) {
  return replaceFunction(value, "light-dark", body => {
    const parts = splitTopLevel(body, ",");
    if (parts.length !== 2 || parts.some(part => part.trim() === "")) {
      throw new Error(`Invalid light-dark() expression: light-dark(${body})`);
    }
    return resolveDarkFunctions(parts[1].trim());
  });
}

export function unScopeThemeCss(css, themeRoot = THEME_ROOT) {
  const root = postcss.parse(css);
  root.walkAtRules("scope", rule => {
    if (!isCloudframeThemeScope(rule.params)) {
      throw new Error(`Unsupported @scope boundary: ${rule.params}`);
    }
    rule.walkRules(child => {
      child.selector = splitTopLevel(child.selector, ",")
        .map(selector => prefixScopedSelector(selector.trim(), themeRoot))
        .join(", ");
    });
    rule.replaceWith(...(rule.nodes ?? []));
  });
  return root.toString();
}

export function transformTvAstryxCss({ coreCss, themeCss }) {
  const coreRoot = postcss.parse(coreCss);
  coreRoot.walkDecls(declaration => {
    declaration.value = resolveDarkFunctions(declaration.value);
  });

  const unscopedTheme = unScopeThemeCss(themeCss, THEME_ROOT);
  const themeRoot = postcss.parse(unscopedTheme);
  themeRoot.walkDecls(declaration => {
    declaration.value = resolveDarkFunctions(declaration.value);
  });
  rootThemeGlobals(themeRoot, THEME_ROOT);

  const tokens = collectRootTokens(coreRoot, themeRoot, THEME_ROOT);
  const combined = postcss.root();
  combined.append(...coreRoot.nodes.map(node => node.clone()));
  combined.append(postcss.comment({ text: "Cloudframe Night theme" }));
  combined.append(...themeRoot.nodes.map(node => node.clone()));
  combined.walkDecls(declaration => {
    declaration.value = resolveColorMixFunctions(declaration.value, tokens);
  });

  const output = `${combined.toString().trimEnd()}\n`;
  const residueRoot = postcss.parse(output);
  let residue = null;
  residueRoot.walkAtRules("scope", () => { residue ??= "@scope"; });
  residueRoot.walkDecls(declaration => {
    const value = declaration.value.toLowerCase();
    if (value.includes("light-dark(")) residue ??= "light-dark(";
    if (value.includes("color-mix(")) residue ??= "color-mix(";
  });
  if (residue) {
    throw new Error(`Unsupported CSS remains after TV transform: ${residue}`);
  }
  return output;
}

function collectRootTokens(coreRoot, themeRoot, themeSelector) {
  const tokens = new Map();
  coreRoot.walkRules(rule => {
    if (splitTopLevel(rule.selector, ",").some(selector => selector.trim() === ":root")) {
      collectDeclarations(rule, tokens);
    }
  });
  themeRoot.walkRules(rule => {
    if (splitTopLevel(rule.selector, ",").some(selector => selector.trim() === themeSelector)) {
      collectDeclarations(rule, tokens);
    }
  });
  return tokens;
}

function rootThemeGlobals(root, themeRoot) {
  root.walkRules(rule => {
    const selectors = splitTopLevel(rule.selector, ",").map(selector => selector.trim());
    const rewritten = [];
    for (const selector of selectors) {
      if (selector === ":root") {
        rewritten.push(themeRoot);
      } else if (/^html\[data-theme=(?:"dark"|'dark')\]$/i.test(selector)) {
        rewritten.push(themeRoot);
      } else if (/^html\[data-theme=(?:"light"|'light')\]$/i.test(selector)) {
        continue;
      } else {
        rewritten.push(selector);
      }
    }
    if (rewritten.length === 0) rule.remove();
    else rule.selector = [...new Set(rewritten)].join(", ");
  });
}

function collectDeclarations(rule, tokens) {
  for (const node of rule.nodes ?? []) {
    if (node.type === "decl" && node.prop.startsWith("--")) {
      tokens.set(node.prop, node.value.trim());
    }
  }
}

function resolveColorMixFunctions(value, tokens) {
  return replaceFunction(value, "color-mix", body => mixColor(body, tokens));
}

function mixColor(body, tokens) {
  const parts = splitTopLevel(body, ",");
  if (parts.length !== 3 || parts[0].trim().toLowerCase() !== "in srgb") {
    throw new Error(`Unsupported color-mix() expression: color-mix(${body})`);
  }

  const first = parseColorStop(parts[1]);
  const second = parseColorStop(parts[2]);
  const percentages = normalizePercentages(first.percentage, second.percentage);
  const firstColor = resolveColor(first.color, tokens, new Set());
  const secondColor = resolveColor(second.color, tokens, new Set());
  return serializeColor(interpolatePremultiplied(
    firstColor,
    secondColor,
    percentages.first,
    percentages.second,
    percentages.alphaMultiplier
  ));
}

function parseColorStop(value) {
  const match = value.trim().match(/^(.*?)(?:\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+)%))?$/);
  if (!match || !match[1].trim()) throw new Error(`Invalid color stop: ${value}`);
  return {
    color: match[1].trim(),
    percentage: match[2] === undefined ? null : Number.parseFloat(match[2]) / 100
  };
}

function normalizePercentages(first, second) {
  let left = first;
  let right = second;
  if (left === null && right === null) {
    left = 0.5;
    right = 0.5;
  } else if (left === null) {
    left = 1 - right;
  } else if (right === null) {
    right = 1 - left;
  }
  if (!Number.isFinite(left) || !Number.isFinite(right) || left < 0 || right < 0) {
    throw new Error("Invalid color-mix() percentages");
  }
  const total = left + right;
  if (total <= 0) throw new Error("color-mix() percentages sum to zero");
  return {
    first: left / total,
    second: right / total,
    alphaMultiplier: total < 1 ? total : 1
  };
}

function resolveColor(value, tokens, seen) {
  const normalized = resolveDarkFunctions(value.trim());
  const variable = normalized.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  if (variable) {
    const name = variable[1];
    if (seen.has(name)) throw new Error(`Circular color token reference: ${name}`);
    const token = tokens.get(name);
    if (!token) throw new Error(`Unable to resolve color token ${name}`);
    const nextSeen = new Set(seen);
    nextSeen.add(name);
    return resolveColor(token, tokens, nextSeen);
  }

  const named = NAMED_COLORS.get(normalized.toLowerCase());
  if (named) return named;
  if (normalized.startsWith("#")) return parseHexColor(normalized);
  if (/^rgba?\(/i.test(normalized)) return parseRgbColor(normalized);
  throw new Error(`Unable to resolve color value ${normalized}`);
}

function parseHexColor(value) {
  const hex = value.slice(1);
  if (![3, 4, 6, 8].includes(hex.length) || !/^[\da-f]+$/i.test(hex)) {
    throw new Error(`Invalid hex color ${value}`);
  }
  const expanded = hex.length <= 4
    ? [...hex].map(character => character + character).join("")
    : hex;
  const alpha = expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1;
  return [
    Number.parseInt(expanded.slice(0, 2), 16),
    Number.parseInt(expanded.slice(2, 4), 16),
    Number.parseInt(expanded.slice(4, 6), 16),
    alpha
  ];
}

function parseRgbColor(value) {
  const match = value.match(/^rgba?\((.*)\)$/i);
  if (!match) throw new Error(`Invalid RGB color ${value}`);
  const parts = splitTopLevel(match[1], ",").map(part => part.trim());
  if (parts.length !== 3 && parts.length !== 4) {
    throw new Error(`Unsupported RGB color ${value}`);
  }
  const channels = parts.slice(0, 3).map(part => parseRgbChannel(part, value));
  const alpha = parts[3] === undefined ? 1 : parseAlpha(parts[3], value);
  return [...channels, alpha];
}

function parseRgbChannel(value, source) {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)%?$/.test(value)) {
    throw new Error(`Invalid RGB color ${source}`);
  }
  const number = value.endsWith("%")
    ? Number(value.slice(0, -1)) * 2.55
    : Number(value);
  if (!Number.isFinite(number)) throw new Error(`Invalid RGB color ${source}`);
  return clamp(number, 0, 255);
}

function parseAlpha(value, source) {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)%?$/.test(value)) {
    throw new Error(`Invalid RGB color ${source}`);
  }
  const number = value.endsWith("%")
    ? Number(value.slice(0, -1)) / 100
    : Number(value);
  if (!Number.isFinite(number)) throw new Error(`Invalid RGB color ${source}`);
  return clamp(number, 0, 1);
}

function interpolatePremultiplied(first, second, firstWeight, secondWeight, alphaMultiplier) {
  const alpha = (first[3] * firstWeight + second[3] * secondWeight) * alphaMultiplier;
  if (alpha === 0) return [0, 0, 0, 0];
  const denominator = first[3] * firstWeight + second[3] * secondWeight;
  const channel = index => denominator === 0
    ? 0
    : (first[index] * first[3] * firstWeight + second[index] * second[3] * secondWeight) / denominator;
  return [channel(0), channel(1), channel(2), alpha];
}

function serializeColor([red, green, blue, alpha]) {
  const bytes = [red, green, blue, alpha * 255].map(value =>
    Math.round(clamp(value, 0, 255)).toString(16).padStart(2, "0").toUpperCase()
  );
  return `#${bytes.slice(0, alpha >= 1 - Number.EPSILON ? 3 : 4).join("")}`;
}

function prefixScopedSelector(selector, themeRoot) {
  if (selector.includes(":scope")) {
    return selector.replace(/:scope\b/g, themeRoot);
  }
  if (selector === themeRoot || selector.startsWith(`${themeRoot} `)) return selector;
  return `${themeRoot} ${selector}`;
}

function isCloudframeThemeScope(params) {
  return /^\(\s*\[data-astryx-theme=(?:"cloudframe-night"|'cloudframe-night')\]\s*\)\s+to\s+\(\s*\[data-astryx-theme\]\s*\)$/i
    .test(params.trim());
}

function replaceFunction(value, name, replacer) {
  let output = value;
  const expression = new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, "i");
  while (true) {
    const match = expression.exec(output);
    if (!match) return output;
    const open = output.indexOf("(", match.index);
    const close = findClosingParenthesis(output, open);
    if (close < 0) throw new Error(`Unclosed ${name}() expression in ${value}`);
    const replacement = replacer(output.slice(open + 1, close));
    output = `${output.slice(0, match.index)}${replacement}${output.slice(close + 1)}`;
  }
}

function findClosingParenthesis(value, open) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = open; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")" && --depth === 0) return index;
  }
  return -1;
}

function splitTopLevel(value, separator) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(" || character === "[") depth += 1;
    else if (character === ")" || character === "]") depth -= 1;
    else if (character === separator && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
