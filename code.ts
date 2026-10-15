type DtcgToken = {
  $value: unknown;
  $type?: string;
  $description?: string;
  $extensions?: Record<string, unknown>;
};

interface DtcgTree {
  [key: string]: DtcgTree | DtcgToken;
}

type PluginLanguage = "en" | "pt";

type PluginSettings = {
  language: PluginLanguage;
  singleFileName: string;
};

type UiMessage =
  | {
      type: "refresh-tokens";
      options?: {
        includeCollectionOrCategoryRoot?: boolean;
        splitByCollectionOrCategory?: boolean;
        enabledGroups?: string[];
      };
    }
  | {
      type: "update-settings";
      settings?: {
        language?: PluginLanguage;
        singleFileName?: string;
      };
    }
  | { type: "close-plugin" };

type TokenFile = {
  name: string;
  filename: string;
  json: string;
};

type GeneratedPayload =
  | {
      mode: "single";
      file: TokenFile;
      availableGroups: string[];
      selectedGroups: string[];
      settings: PluginSettings;
    }
  | {
      mode: "split";
      files: TokenFile[];
      availableGroups: string[];
      selectedGroups: string[];
      settings: PluginSettings;
    };

const DTCG_SCHEMA_URL =
  "https://www.designtokens.org/schemas/2025.10/format.json";

figma.showUI(__html__, {
  width: 760,
  height: 640,
  themeColors: true,
});

let includeCollectionOrCategoryRoot = true;
let splitByCollectionOrCategory = false;
let enabledGroups: string[] | null = null;
let language: PluginLanguage = "en";
let singleFileName = "tokens.json";

function normalizeSingleFileName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "tokens.json";
  return trimmed.endsWith(".json") ? trimmed : `${trimmed}.json`;
}

function normalizeNameSegment(segment: string): string {
  const normalized = segment.trim().replace(/\s+/g, "-");
  return normalized.length > 0 ? normalized : "unnamed";
}

function splitTokenPath(path: string): string[] {
  return path
    .split("/")
    .map((segment) => normalizeNameSegment(segment))
    .filter(Boolean);
}

function setToken(tree: DtcgTree, path: string, token: DtcgToken): void {
  const segments = splitTokenPath(path);
  if (segments.length === 0) {
    return;
  }

  let current: DtcgTree = tree;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    const next = current[segment];
    if (!next || "$value" in next) {
      current[segment] = {};
    }
    current = current[segment] as DtcgTree;
  }
  current[segments[segments.length - 1]] = token;
}

function isTokenNode(node: DtcgTree | DtcgToken): node is DtcgToken {
  return "$value" in node;
}

function mergeDtcgTrees(base: DtcgTree, incoming: DtcgTree): DtcgTree {
  const merged: DtcgTree = { ...base };

  for (const key of Object.keys(incoming)) {
    const existingNode = merged[key];
    const incomingNode = incoming[key];

    if (!existingNode) {
      merged[key] = incomingNode;
      continue;
    }

    if (isTokenNode(existingNode) || isTokenNode(incomingNode)) {
      // On exact path collision, last writer wins to keep deterministic output.
      merged[key] = incomingNode;
      continue;
    }

    merged[key] = mergeDtcgTrees(existingNode, incomingNode);
  }

  return merged;
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

function toHexByte(value: number): string {
  const hex = Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16);
  return hex.length === 1 ? `0${hex}` : hex;
}

function colorToHex(color: RGB, opacity = 1): string {
  const alpha = Math.max(0, Math.min(1, opacity));
  const base = `#${toHexByte(color.r)}${toHexByte(color.g)}${toHexByte(color.b)}`;
  return alpha < 1 ? `${base}${toHexByte(alpha)}` : base;
}

function colorToDtcgColor(color: RGB, alpha = 1): { colorSpace: "srgb"; components: [number, number, number]; alpha?: number } {
  const normalizedAlpha = Math.max(0, Math.min(1, alpha));
  const output: { colorSpace: "srgb"; components: [number, number, number]; alpha?: number } = {
    colorSpace: "srgb",
    components: [round4(color.r), round4(color.g), round4(color.b)],
  };
  if (normalizedAlpha < 1) {
    output.alpha = round4(normalizedAlpha);
  }
  return output;
}

function colorToModeExtension(color: RGB, alpha = 1): {
  colorSpace: "srgb";
  components: [number, number, number];
  alpha: number;
  hex: string;
} {
  return {
    colorSpace: "srgb",
    components: [round4(color.r), round4(color.g), round4(color.b)],
    alpha: round4(Math.max(0, Math.min(1, alpha))),
    hex: colorToHex(color, alpha),
  };
}

function numberWithUnit(value: number, unit: string): { value: number; unit: string } {
  return {
    value: round4(value),
    unit,
  };
}

function valueToReference(path: string): string {
  return `{${splitTokenPath(path).join(".")}}`;
}

function toFileSafeName(name: string, fallback = "tokens"): string {
  const safe = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-");
  return safe.replace(/^-|-$/g, "") || fallback;
}

// Sanitized names can collide ("Light"/"light", non-Latin names), so later files
// get a numeric suffix instead of silently overwriting earlier ones in the zip.
function makeFilenamesUnique(files: TokenFile[]): TokenFile[] {
  const used = new Set<string>();
  return files.map((file) => {
    const base = file.filename.replace(/\.json$/, "");
    let filename = file.filename;
    for (let n = 2; used.has(filename); n += 1) {
      filename = `${base}-${n}.json`;
    }
    used.add(filename);
    return { ...file, filename };
  });
}

async function getLocalCollections(): Promise<VariableCollection[]> {
  return figma.variables.getLocalVariableCollectionsAsync();
}

async function getLocalVariablesById(): Promise<Map<string, Variable>> {
  const variables = await figma.variables.getLocalVariablesAsync();
  return new Map(variables.map((variable) => [variable.id, variable]));
}

async function getPaintStyles(): Promise<PaintStyle[]> {
  return figma.getLocalPaintStylesAsync();
}

async function getTextStyles(): Promise<TextStyle[]> {
  return figma.getLocalTextStylesAsync();
}

async function getEffectStyles(): Promise<EffectStyle[]> {
  return figma.getLocalEffectStylesAsync();
}

async function getGridStyles(): Promise<GridStyle[]> {
  return figma.getLocalGridStylesAsync();
}

function mapVariableTypeToDtcgType(variableType: VariableResolvedDataType): string {
  if (variableType === "COLOR") return "color";
  if (variableType === "FLOAT") return "number";
  if (variableType === "STRING") return "string";
  if (variableType === "BOOLEAN") return "boolean";
  return "string";
}

function convertVariableValue(
  value: VariableValue,
  variableType: VariableResolvedDataType,
  fallbackPath?: string
): unknown {
  if (typeof value === "object" && value !== null && "type" in value && value.type === "VARIABLE_ALIAS") {
    if (fallbackPath) {
      return valueToReference(fallbackPath);
    }
    return `{alias-missing.${value.id}}`;
  }

  if (variableType === "COLOR" && typeof value === "object" && value !== null && "r" in value) {
    const colorValue = value as RGBA;
    return colorToDtcgColor(colorValue, colorValue.a);
  }

  return value;
}

// DTCG lineHeight is a unitless multiplier of fontSize, so pixel line heights
// are divided by the font size. Figma's AUTO has no numeric equivalent, so it
// approximates the typical default of most fonts.
const AUTO_LINE_HEIGHT = 1.2;
const DEFAULT_FONT_WEIGHT = 400;

function textLineHeightToDtcg(lineHeight: LineHeight, fontSize: number): number {
  if (lineHeight.unit === "AUTO") return AUTO_LINE_HEIGHT;
  if (lineHeight.unit === "PIXELS") {
    return fontSize > 0 ? round4(lineHeight.value / fontSize) : AUTO_LINE_HEIGHT;
  }
  return round4(lineHeight.value / 100);
}

const FONT_WEIGHT_BY_NAME: Record<string, number> = {
  thin: 100,
  hairline: 100,
  extralight: 200,
  ultralight: 200,
  light: 300,
  normal: 400,
  regular: 400,
  book: 400,
  medium: 500,
  semibold: 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  ultrabold: 800,
  black: 900,
  heavy: 900,
  extrablack: 950,
  ultrablack: 950,
};

// Figma font styles ("Bold", "SemiBold Italic") map onto DTCG numeric weights.
// Italic is a separate axis with no DTCG typography sub-value, so it is dropped.
function fontStyleToDtcgWeight(fontStyle: string): number {
  const normalized = fontStyle
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
    .replace(/italic|oblique/g, "");

  // Own-property check keeps inherited keys ("constructor") from leaking through.
  // Unmapped styles (e.g. "Condensed") fall back to regular so the value stays numeric.
  return Object.prototype.hasOwnProperty.call(FONT_WEIGHT_BY_NAME, normalized)
    ? FONT_WEIGHT_BY_NAME[normalized]
    : DEFAULT_FONT_WEIGHT;
}

function textLetterSpacingToDtcg(
  letterSpacing: LetterSpacing,
  fontSize: number
): { value: number; unit: "px" } {
  if (letterSpacing.unit === "PIXELS") {
    return {
      value: round4(letterSpacing.value),
      unit: "px",
    };
  }

  const pxValue = (fontSize * letterSpacing.value) / 100;
  return {
    value: round4(pxValue),
    unit: "px",
  };
}

function firstVisiblePaint(paints: ReadonlyArray<Paint>): Paint | null {
  return paints.find((paint) => paint.visible !== false) ?? paints[0] ?? null;
}

type VariablePathIndex = Record<string, string>;

function aliasToReference(
  alias: VariableAlias | undefined,
  variablePaths: VariablePathIndex
): string | null {
  if (!alias) return null;

  const path = variablePaths[alias.id];
  // Library variables are not in the local index; fall back to the raw value.
  return path ? valueToReference(path) : null;
}

function convertPaintToToken(style: PaintStyle, variablePaths: VariablePathIndex): DtcgToken {
  const paint = firstVisiblePaint(style.paints);
  if (!paint) {
    return {
      $type: "color",
      $value: colorToDtcgColor({ r: 0, g: 0, b: 0 }, 0),
      $description: style.description || undefined,
    };
  }

  if (paint.type === "SOLID") {
    return {
      $type: "color",
      $value:
        aliasToReference(paint.boundVariables?.color, variablePaths) ??
        colorToDtcgColor(paint.color, paint.opacity ?? 1),
      $description: style.description || undefined,
    };
  }

  if (
    paint.type === "GRADIENT_LINEAR" ||
    paint.type === "GRADIENT_RADIAL" ||
    paint.type === "GRADIENT_ANGULAR" ||
    paint.type === "GRADIENT_DIAMOND"
  ) {
    return {
      $type: "gradient",
      $value: paint.gradientStops.map((stop: ColorStop) => ({
        color:
          aliasToReference(stop.boundVariables?.color, variablePaths) ??
          colorToDtcgColor(stop.color, stop.color.a),
        position: Number(stop.position.toFixed(4)),
      })),
      $description: style.description || undefined,
      $extensions: {
        figmaGradientType: paint.type,
      },
    };
  }

  return {
    $type: "string",
    $value: paint.type,
    $description: style.description || undefined,
    $extensions: {
      figmaPaint: paint,
    },
  };
}

function boundVariableReference(
  style: TextStyle,
  field: VariableBindableTextField,
  variablePaths: VariablePathIndex
): string | null {
  const boundVariables = style.boundVariables as
    | { [key in VariableBindableTextField]?: VariableAlias }
    | undefined;
  return aliasToReference(boundVariables?.[field], variablePaths);
}

function convertTextToToken(style: TextStyle, variablePaths: VariablePathIndex): DtcgToken {
  const fontName = typeof style.fontName === "symbol" ? null : style.fontName;
  const ref = (field: VariableBindableTextField) =>
    boundVariableReference(style, field, variablePaths);

  // DTCG typography allows exactly these five sub-values, all required.
  return {
    $type: "typography",
    $value: {
      fontFamily: ref("fontFamily") ?? fontName?.family ?? "Unknown",
      fontSize: ref("fontSize") ?? numberWithUnit(style.fontSize, "px"),
      fontWeight:
        ref("fontWeight") ??
        ref("fontStyle") ??
        fontStyleToDtcgWeight(fontName?.style ?? "regular"),
      letterSpacing:
        ref("letterSpacing") ?? textLetterSpacingToDtcg(style.letterSpacing, style.fontSize),
      lineHeight: ref("lineHeight") ?? textLineHeightToDtcg(style.lineHeight, style.fontSize),
    },
    $description: style.description || undefined,
  };
}

function convertEffectsToToken(style: EffectStyle): DtcgToken {
  const shadows = style.effects
    .filter(
      (effect): effect is DropShadowEffect | InnerShadowEffect =>
        effect.visible !== false && (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW")
    )
    .map((effect) => ({
      color: colorToDtcgColor(effect.color, effect.color.a),
      offsetX: numberWithUnit(effect.offset.x, "px"),
      offsetY: numberWithUnit(effect.offset.y, "px"),
      blur: numberWithUnit(effect.radius, "px"),
      spread: numberWithUnit(effect.spread ?? 0, "px"),
      inset: effect.type === "INNER_SHADOW",
    }));

  if (shadows.length > 0) {
    return {
      $type: "shadow",
      $value: shadows.length === 1 ? shadows[0] : shadows,
      $description: style.description || undefined,
    };
  }

  return {
    $type: "string",
    $value: style.effects.map((effect) => effect.type).join(", "),
    $description: style.description || undefined,
    $extensions: {
      figmaEffects: style.effects,
    },
  };
}

function convertGridToToken(style: GridStyle): DtcgToken {
  return {
    $type: "string",
    $value: "grid-style",
    $description: style.description || undefined,
    $extensions: {
      figmaLayoutGrids: style.layoutGrids,
    },
  };
}

function variableTokenPath(
  collectionName: string,
  variableName: string,
  includeRoot: boolean
): string {
  return includeRoot ? `${collectionName}/${variableName}` : variableName;
}

function styleTokenPath(category: string, styleName: string, includeRoot: boolean): string {
  return includeRoot ? `${category}/${styleName}` : styleName;
}

function buildVariablePathIndex(
  collections: VariableCollection[],
  variablesById: Map<string, Variable>,
  includeRoot: boolean
): VariablePathIndex {
  const pathByVariableId: VariablePathIndex = {};

  for (const collection of collections) {
    for (const variableId of collection.variableIds) {
      const variable = variablesById.get(variableId);
      if (!variable) continue;

      pathByVariableId[variable.id] = variableTokenPath(
        collection.name,
        variable.name,
        includeRoot
      );
    }
  }

  return pathByVariableId;
}

type BundleMode = {
  id: string;
  name: string;
  // Position in the collection's mode list, used to keep Figma's mode order.
  index: number;
  isDefault: boolean;
};

// A bundle is one output document: a group (collection or style category) at one
// mode. `mode` is null when the source has no meaningful modes — style categories,
// single-mode collections, and every collection in single-file output — which keeps
// those files named `<group>.tokens.json`.
type TokenBundle = {
  group: string;
  mode: BundleMode | null;
  tree: DtcgTree;
};

function isVariableAliasValue(value: VariableValue | undefined): value is VariableAlias {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "VARIABLE_ALIAS"
  );
}

function convertVariableModeValue(
  rawValue: VariableValue,
  variable: Variable,
  pathByVariableId: VariablePathIndex
): unknown {
  const aliasSource = isVariableAliasValue(rawValue) ? pathByVariableId[rawValue.id] : undefined;
  return convertVariableValue(rawValue, variable.resolvedType, aliasSource);
}

function variableExtensions(variable: Variable, collection: VariableCollection): Record<string, unknown> {
  return {
    figmaVariableId: variable.id,
    figmaCollectionId: collection.id,
    figmaScopes: variable.scopes,
  };
}

// Single-file output: one tree per collection with the default mode as $value and
// every mode under $extensions.mode, so references from other groups still resolve.
function buildCombinedCollectionTree(
  collection: VariableCollection,
  variablesById: Map<string, Variable>,
  includeRoot: boolean,
  pathByVariableId: VariablePathIndex
): DtcgTree {
  const tree: DtcgTree = {};
  const hasMultipleModes = collection.modes.length > 1;

  for (const variableId of collection.variableIds) {
    const variable = variablesById.get(variableId);
    if (!variable) continue;

    const defaultRawValue = variable.valuesByMode[collection.defaultModeId];
    if (defaultRawValue === undefined) continue;

    const extensions = variableExtensions(variable, collection);
    if (hasMultipleModes) {
      const modeValues: Record<string, unknown> = {};
      for (const mode of collection.modes) {
        const rawValue = variable.valuesByMode[mode.modeId];
        if (rawValue === undefined) continue;

        if (variable.resolvedType === "COLOR" && typeof rawValue === "object" && "r" in rawValue) {
          const rgba = rawValue as RGBA;
          modeValues[mode.name] = colorToModeExtension(rgba, rgba.a);
        } else {
          modeValues[mode.name] = convertVariableModeValue(rawValue, variable, pathByVariableId);
        }
      }
      extensions.mode = modeValues;
    }

    setToken(tree, variableTokenPath(collection.name, variable.name, includeRoot), {
      $type: mapVariableTypeToDtcgType(variable.resolvedType),
      $value: convertVariableModeValue(defaultRawValue, variable, pathByVariableId),
      $description: variable.description || undefined,
      $extensions: extensions,
    });
  }

  return tree;
}

// Split output: one tree per mode. Aliases stay plain path references — Figma
// resolves a cross-collection alias with whatever mode the consumer picks for the
// target collection, so pairing one mode file per collection reproduces that.
function buildModeTrees(
  collection: VariableCollection,
  variablesById: Map<string, Variable>,
  includeRoot: boolean,
  pathByVariableId: VariablePathIndex
): DtcgTree[] {
  const trees: DtcgTree[] = collection.modes.map(() => ({}));

  for (const variableId of collection.variableIds) {
    const variable = variablesById.get(variableId);
    if (!variable) continue;

    const tokenPath = variableTokenPath(collection.name, variable.name, includeRoot);
    collection.modes.forEach((mode, index) => {
      const rawValue =
        variable.valuesByMode[mode.modeId] ?? variable.valuesByMode[collection.defaultModeId];
      if (rawValue === undefined) return;

      setToken(trees[index], tokenPath, {
        $type: mapVariableTypeToDtcgType(variable.resolvedType),
        $value: convertVariableModeValue(rawValue, variable, pathByVariableId),
        $description: variable.description || undefined,
        $extensions: variableExtensions(variable, collection),
      });
    });
  }

  return trees;
}

function buildVariableBundles(
  collections: VariableCollection[],
  variablesById: Map<string, Variable>,
  includeRoot: boolean,
  pathByVariableId: VariablePathIndex,
  splitModes: boolean
): TokenBundle[] {
  const bundles: TokenBundle[] = [];

  for (const collection of collections) {
    // Single-mode collections stay mode-less so their filenames don't change.
    if (!splitModes || collection.modes.length <= 1) {
      bundles.push({
        group: collection.name,
        mode: null,
        tree: buildCombinedCollectionTree(collection, variablesById, includeRoot, pathByVariableId),
      });
      continue;
    }

    const trees = buildModeTrees(collection, variablesById, includeRoot, pathByVariableId);
    collection.modes.forEach((mode, index) => {
      bundles.push({
        group: collection.name,
        mode: {
          id: mode.modeId,
          name: mode.name,
          index,
          isDefault: mode.modeId === collection.defaultModeId,
        },
        tree: trees[index],
      });
    });
  }

  return bundles;
}

async function buildStyleTokensByCategory(
  includeRoot: boolean,
  variablePaths: VariablePathIndex
): Promise<Record<string, DtcgTree>> {
  const styleGroups: Record<string, DtcgTree> = {
    color: {},
    typography: {},
    effects: {},
    grid: {},
  };

  const [paintStyles, textStyles, effectStyles, gridStyles] = await Promise.all([
    getPaintStyles(),
    getTextStyles(),
    getEffectStyles(),
    getGridStyles(),
  ]);

  for (const style of paintStyles) {
    setToken(
      styleGroups.color,
      styleTokenPath("color", style.name, includeRoot),
      convertPaintToToken(style, variablePaths)
    );
  }

  for (const style of textStyles) {
    setToken(
      styleGroups.typography,
      styleTokenPath("typography", style.name, includeRoot),
      convertTextToToken(style, variablePaths)
    );
  }

  for (const style of effectStyles) {
    setToken(styleGroups.effects, styleTokenPath("effects", style.name, includeRoot), convertEffectsToToken(style));
  }

  for (const style of gridStyles) {
    setToken(styleGroups.grid, styleTokenPath("grid", style.name, includeRoot), convertGridToToken(style));
  }

  return styleGroups;
}

async function buildStyleBundles(
  includeRoot: boolean,
  variablePaths: VariablePathIndex
): Promise<TokenBundle[]> {
  const styleGroups = await buildStyleTokensByCategory(includeRoot, variablePaths);
  return Object.keys(styleGroups).map((group) => ({
    group,
    mode: null,
    tree: styleGroups[group],
  }));
}

function createDtcgPayload(
  tokens: DtcgTree,
  generatedAt: string,
  mode?: { collection: string; mode: BundleMode }
) {
  return {
    $schema: DTCG_SCHEMA_URL,
    $metadata: {
      tokenFormat: "DTCG",
      tokenFormatVersion: "2025.10",
      generator: "dtcg-tokens-figma-plugin",
      generatedAt,
      ...(mode
        ? {
            collection: mode.collection,
            mode: mode.mode.name,
            modeId: mode.mode.id,
            isDefaultMode: mode.mode.isDefault,
          }
        : {}),
    },
    ...tokens,
  };
}

function bundleKey(bundle: TokenBundle): string {
  // NUL separator: group and mode IDs cannot contain it.
  return `${bundle.group}\u0000${bundle.mode?.id ?? ""}`;
}

// Bundles sharing a group *and* a mode are merged, so a style category and a
// mode-less collection with the same name still land in one document.
function mergeBundles(bundles: TokenBundle[]): TokenBundle[] {
  const byKey = new Map<string, TokenBundle>();

  for (const bundle of bundles) {
    const key = bundleKey(bundle);
    const existing = byKey.get(key);
    if (existing) {
      existing.tree = mergeDtcgTrees(existing.tree, bundle.tree);
    } else {
      byKey.set(key, { group: bundle.group, mode: bundle.mode, tree: bundle.tree });
    }
  }

  // Groups are alphabetical; modes keep the collection's order (default first in Figma).
  const merged = Array.from(byKey.values());
  merged.sort((a, b) => {
    if (a.group !== b.group) return a.group < b.group ? -1 : 1;
    return (a.mode ? a.mode.index : -1) - (b.mode ? b.mode.index : -1);
  });
  return merged;
}

function bundleToFile(bundle: TokenBundle, generatedAt: string): TokenFile {
  if (bundle.mode === null) {
    return {
      name: bundle.group,
      filename: `${toFileSafeName(bundle.group)}.tokens.json`,
      json: JSON.stringify(createDtcgPayload(bundle.tree, generatedAt), null, 2),
    };
  }

  const modeFileName = toFileSafeName(bundle.mode.name, `mode-${bundle.mode.index + 1}`);
  return {
    name: `${bundle.group} / ${bundle.mode.name}`,
    filename: `${toFileSafeName(bundle.group)}.${modeFileName}.json`,
    json: JSON.stringify(
      createDtcgPayload(bundle.tree, generatedAt, {
        collection: bundle.group,
        mode: bundle.mode,
      }),
      null,
      2
    ),
  };
}

async function generateTokens(): Promise<GeneratedPayload> {
  const generatedAt = new Date().toISOString();
  const [collections, variablesById] = await Promise.all([
    getLocalCollections(),
    getLocalVariablesById(),
  ]);
  const variablePaths = buildVariablePathIndex(
    collections,
    variablesById,
    includeCollectionOrCategoryRoot
  );
  const variableBundles = buildVariableBundles(
    collections,
    variablesById,
    includeCollectionOrCategoryRoot,
    variablePaths,
    splitByCollectionOrCategory
  );
  const styleBundles = await buildStyleBundles(includeCollectionOrCategoryRoot, variablePaths);

  // Sorted by group, so the Set keeps groups in alphabetical order.
  const bundles = mergeBundles([...variableBundles, ...styleBundles]);
  const availableGroups = Array.from(new Set(bundles.map((bundle) => bundle.group)));

  const selectedGroupSet = new Set(enabledGroups === null ? availableGroups : enabledGroups);
  const selectedGroups = availableGroups.filter((groupName) => selectedGroupSet.has(groupName));
  const selectedBundles = bundles.filter((bundle) => selectedGroupSet.has(bundle.group));

  const settings = { language, singleFileName };

  if (splitByCollectionOrCategory) {
    return {
      mode: "split",
      files: makeFilenamesUnique(selectedBundles.map((bundle) => bundleToFile(bundle, generatedAt))),
      availableGroups,
      selectedGroups,
      settings,
    };
  }

  let mergedTokens: DtcgTree = {};
  for (const bundle of selectedBundles) {
    mergedTokens = mergeDtcgTrees(mergedTokens, bundle.tree);
  }

  return {
    mode: "single",
    file: {
      name: "tokens",
      filename: singleFileName,
      json: JSON.stringify(createDtcgPayload(mergedTokens, generatedAt), null, 2),
    },
    availableGroups,
    selectedGroups,
    settings,
  };
}

async function sendTokensToUi(): Promise<void> {
  try {
    const payload = await generateTokens();
    figma.ui.postMessage({
      type: "tokens-generated",
      payload,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const prefix = language === "pt" ? "Falha ao exportar tokens" : "Token export failed";
    figma.notify(`${prefix}: ${message}`, { error: true });
    figma.ui.postMessage({
      type: "tokens-error",
      error: message,
    });
  }
}

figma.ui.onmessage = async (msg: UiMessage) => {
  if (msg.type === "refresh-tokens") {
    includeCollectionOrCategoryRoot =
      msg.options?.includeCollectionOrCategoryRoot ?? includeCollectionOrCategoryRoot;
    splitByCollectionOrCategory =
      msg.options?.splitByCollectionOrCategory ?? splitByCollectionOrCategory;
    if (msg.options && "enabledGroups" in msg.options) {
      enabledGroups = msg.options.enabledGroups ?? null;
    }
    await sendTokensToUi();
    return;
  }

  if (msg.type === "update-settings") {
    const nextLanguage = msg.settings?.language;
    if (nextLanguage === "en" || nextLanguage === "pt") {
      language = nextLanguage;
    }

    if (typeof msg.settings?.singleFileName === "string") {
      singleFileName = normalizeSingleFileName(msg.settings.singleFileName);
    }

    await sendTokensToUi();
    return;
  }

  if (msg.type === "close-plugin") {
    figma.closePlugin();
  }
};

void sendTokensToUi();
