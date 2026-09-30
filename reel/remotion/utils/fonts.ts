import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadPlayfairDisplay } from "@remotion/google-fonts/PlayfairDisplay";
import { loadFont as loadBebas } from "@remotion/google-fonts/BebasNeue";
import { loadFont as loadSpaceGrotesk } from "@remotion/google-fonts/SpaceGrotesk";
import { loadFont as loadLora } from "@remotion/google-fonts/Lora";
import { loadFont as loadPTSerif } from "@remotion/google-fonts/PTSerif";
import { loadFont as loadMerriweather } from "@remotion/google-fonts/Merriweather";
import { loadFont as loadAnton } from "@remotion/google-fonts/Anton";
import { loadFont as loadArchivoBlack } from "@remotion/google-fonts/ArchivoBlack";
import { loadFont as loadOswald } from "@remotion/google-fonts/Oswald";

// Carica ESPLICITAMENTE i pesi usati (400 corpo, 800 sottotitoli) + i subset
// latin E latin-ext: il default di loadFont() lasciava buchi sui glifi accentati
// a peso 800 → "quadratini" (notdef box) su à/è/é/ì/ò/ù nei sottotitoli italiani.
export const { fontFamily: interFont } = loadInter("normal", {
  weights: ["400", "800"],
  subsets: ["latin", "latin-ext"],
});
export const { fontFamily: playfairFont } = loadPlayfairDisplay();
export const { fontFamily: bebasFont } = loadBebas();
export const { fontFamily: spaceFont } = loadSpaceGrotesk();
// Serif leggibili per i sottotitoli (alternativa al GT Super Display troppo
// sottile/illeggibile a video). Lora = elegante leggibile; PT Serif = Times-like
// (match dell'originale); Merriweather = pensato per schermo, massima leggibilità.
export const { fontFamily: loraFont } = loadLora();
export const { fontFamily: ptSerifFont } = loadPTSerif();
export const { fontFamily: merriweatherFont } = loadMerriweather();

// Display "Impact-style" per kinetic typography: Anton = alternativa libera
// diretta a Impact (ultra-heavy condensed); Archivo Black = grotesque pesante;
// Oswald = condensed più editoriale. latin+latin-ext per gli accenti italiani.
export const { fontFamily: antonFont } = loadAnton("normal", {
  weights: ["400"],
  subsets: ["latin", "latin-ext"],
});
export const { fontFamily: archivoBlackFont } = loadArchivoBlack("normal", {
  weights: ["400"],
  subsets: ["latin", "latin-ext"],
});
export const { fontFamily: oswaldFont } = loadOswald("normal", {
  weights: ["500", "700"],
  subsets: ["latin", "latin-ext"],
});
