const COLOR_MODES = new Set(["light", "dark"]);
const FORMATS = new Set(["wide", "portrait"]);
const ACCENTS = new Set(["celadon-cobalt", "emerald-cobalt", "mist-blue"]);
const TEXTURES = new Set(["mineral-glass", "frosted-acrylic", "soft-paper"]);
const CONTACT_VISUAL_ASSETS = new Set([
  "contact-card",
  "avatar-medallion",
  "primary-action",
  "secondary-action",
  "brand-flourish",
]);

const BASE_PROMPT = [
  "Create a premium abstract application background for a private relationship-care workspace.",
  "Use a restrained macOS-inspired material language without copying any Apple product, logo, wallpaper, or trademarked interface.",
  "The image is decorative only: no text, no letters, no numerals, no icons, no people, no faces, no chat bubbles, no QR codes, no logos, and no UI screenshots.",
  "Keep the central reading area quiet and low-contrast so real semantic HTML controls remain legible above it.",
  "Use layered translucent mineral glass, subtle depth, soft edge lighting, natural bloom, and a calm editorial composition.",
].join(" ");

const MODE_COPY = Object.freeze({
  light: "Pearlescent warm-white ground, pale translucent layers, soft graphite shadows, high-key but not stark.",
  dark: "Smoked graphite and deep blue-black ground, restrained luminous edges, low glare, no crushed blacks.",
});

const FORMAT_COPY = Object.freeze({
  wide: "Landscape 16:10 composition. Put visual activity near the outer corners and preserve a broad quiet center.",
  portrait: "Portrait mobile composition. Keep the upper two-thirds quiet and place the strongest color movement in the lower third.",
});

const ACCENT_COPY = Object.freeze({
  "celadon-cobalt": "A single flowing ribbon moves from pale celadon through clear cobalt blue.",
  "emerald-cobalt": "A restrained ribbon moves from deep emerald through luminous cobalt blue.",
  "mist-blue": "Use only mist blue and translucent silver-blue accents.",
});

const TEXTURE_COPY = Object.freeze({
  "mineral-glass": "Materials resemble polished mineral glass with very fine pearlescent grain.",
  "frosted-acrylic": "Materials resemble frosted acrylic with smooth diffusion and clean optical edges.",
  "soft-paper": "Add a nearly invisible tactile paper grain beneath the translucent layers.",
});

const CONTACT_VISUAL_COPY = Object.freeze({
  "contact-card": [
    "Create one reusable blank wide personal-correspondence card for a private relationship-care directory.",
    "Use pearl-white mineral glass, mist aqua, restrained pale-cobalt edge accents, a quiet low-contrast center, and faint concentric echo rings near the upper-right.",
    "Keep all visual activity at the edges so real dark Chinese interface text remains legible at every responsive crop.",
    "No text, letters, numbers, people, faces, avatars, buttons, checkboxes, chat bubbles, logos, watermarks, or mock interface elements.",
  ].join(" "),
  "avatar-medallion": [
    "Create one reusable empty circular avatar medallion frame on a genuinely transparent background.",
    "Use a double-layer pearl mineral-glass ring with mist-aqua and pale-cobalt highlights, a clean transparent center for a real DOM monogram, and a quiet lower-right notch for a separate semantic status mark.",
    "No face, person, initials, letters, numbers, text, emoji, icon glyph, logo, watermark, or square plate.",
  ].join(" "),
  "primary-action": [
    "Create one reusable blank primary-action skin on a genuinely transparent background.",
    "Use a horizontal three-to-one rounded rectangle with pale-cobalt to mist-aqua mineral glass, a fine inner highlight, subtle offset depth, and a clear quiet center for real DOM text.",
    "No text, letters, numbers, icons, logos, watermarks, extra controls, surrounding panels, glow halos, or baked interaction states.",
  ].join(" "),
  "secondary-action": [
    "Create one reusable blank secondary-action skin on a genuinely transparent background.",
    "Use a horizontal three-to-one pearl-white mineral-glass rounded rectangle with a mist-aqua edge, thin inner highlight, subtle offset depth, and a clear quiet center for real DOM text.",
    "No text, letters, numbers, icons, logos, watermarks, extra controls, surrounding panels, glow halos, or baked interaction states.",
  ].join(" "),
  "brand-flourish": [
    "Create one reusable non-text brand flourish on a genuinely transparent background for a Chinese relationship-care product title.",
    "Combine a restrained East Asian brush-tail gesture, two faint concentric echo rings, and a small translucent mineral accent in pearl white, mist aqua, pale cobalt, and a trace of ink teal.",
    "No Chinese characters, letters, words, numbers, calligraphy glyphs, logos, watermarks, people, or interface panels.",
  ].join(" "),
});

const CONTACT_PROMPT_PRIVACY_BOUNDARY = [
  "Build this request only from the closed asset type above.",
  "Never include contact names, message text, WeChat identifiers, filesystem paths, access tokens, database content, or any other user data.",
  "The artwork is decorative only; all identity, status, copy, and interaction remain real semantic HTML.",
].join(" ");

function choose(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

/**
 * Builds a contact-data-free visual prompt from closed enumerations only.
 * Free-form user text is deliberately unsupported so names and messages cannot
 * accidentally enter an external image-generation request.
 */
export function buildBackgroundPrompt({
  colorMode = "light",
  format = "wide",
  accent = colorMode === "dark" ? "emerald-cobalt" : "celadon-cobalt",
  texture = "mineral-glass",
} = {}) {
  const safeMode = choose(colorMode, COLOR_MODES, "light");
  const safeFormat = choose(format, FORMATS, "wide");
  const safeAccent = choose(accent, ACCENTS, safeMode === "dark" ? "emerald-cobalt" : "celadon-cobalt");
  const safeTexture = choose(texture, TEXTURES, "mineral-glass");
  return [
    BASE_PROMPT,
    MODE_COPY[safeMode],
    FORMAT_COPY[safeFormat],
    ACCENT_COPY[safeAccent],
    TEXTURE_COPY[safeTexture],
    "Finish as a refined abstract background with generous negative space and no baked-in interface elements.",
  ].join(" ");
}

/**
 * Returns a data-free prompt for one of the five bundled contact visuals.
 * Unknown values and every extra free-form field collapse to the safe card
 * prompt so local contact data can never be interpolated into generation.
 */
export function buildContactVisualPrompt({ asset = "contact-card" } = {}) {
  const safeAsset = choose(asset, CONTACT_VISUAL_ASSETS, "contact-card");
  return [CONTACT_VISUAL_COPY[safeAsset], CONTACT_PROMPT_PRIVACY_BOUNDARY].join(" ");
}

export const BUNDLED_APPEARANCE_ASSETS = Object.freeze({
  lightWide: "./assets/appearance/backgrounds/echo-glass-light-wide.webp",
  darkWide: "./assets/appearance/backgrounds/echo-glass-dark-wide.webp",
  lightPortrait: "./assets/appearance/backgrounds/echo-glass-light-portrait.webp",
  darkPortrait: "./assets/appearance/backgrounds/echo-glass-dark-portrait.webp",
  primaryControl: "./assets/appearance/skins/control-primary.webp",
  neutralControl: "./assets/appearance/skins/control-neutral.webp",
  contactSourceIllustration: "./assets/appearance/illustrations/contact-source.webp",
  contactCardSurface: "./assets/appearance/contact/contact-card-surface-v2.webp",
  avatarMedallion: "./assets/appearance/contact/avatar-echo-medallion-v2.webp",
  contactPrimaryAction: "./assets/appearance/contact/contact-action-primary-v2.webp",
  contactSecondaryAction: "./assets/appearance/contact/contact-action-secondary-v2.webp",
  brandFlourish: "./assets/appearance/contact/brand-echo-flourish-v2.webp",
});

export const BUNDLED_BACKGROUND_PROMPTS = Object.freeze({
  lightWide: buildBackgroundPrompt({ colorMode: "light", format: "wide", accent: "celadon-cobalt" }),
  darkWide: buildBackgroundPrompt({ colorMode: "dark", format: "wide", accent: "emerald-cobalt" }),
  lightPortrait: buildBackgroundPrompt({ colorMode: "light", format: "portrait", accent: "celadon-cobalt" }),
  darkPortrait: buildBackgroundPrompt({ colorMode: "dark", format: "portrait", accent: "emerald-cobalt" }),
});

export const BUNDLED_CONTACT_VISUAL_PROMPTS = Object.freeze({
  contactCardSurface: buildContactVisualPrompt({ asset: "contact-card" }),
  avatarMedallion: buildContactVisualPrompt({ asset: "avatar-medallion" }),
  contactPrimaryAction: buildContactVisualPrompt({ asset: "primary-action" }),
  contactSecondaryAction: buildContactVisualPrompt({ asset: "secondary-action" }),
  brandFlourish: buildContactVisualPrompt({ asset: "brand-flourish" }),
});
