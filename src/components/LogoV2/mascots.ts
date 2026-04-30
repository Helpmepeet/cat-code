import { stringWidth } from '../../ink/stringWidth.js'

export type AsciiArt = {
  lines: string[]   // Each row of the art
  width: number     // Pre-measured max column width (validated with stringWidth())
  height: number    // Number of rows
  name: string      // For debugging
}

// ── ASCII Art Definitions ──────────────────────────────────────────────────

// Helper to measure max line width across all lines
function measureWidth(lines: string[]): number {
  return lines.reduce((max, line) => Math.max(max, stringWidth(line)), 0)
}

// #1 — Sitting Fancy Cat — Large
const SITTING_FANCY_LINES = [
  '            .                .                    ',
  '            :"-.          .-";                    ',
  '            |:`.`.__..__.\'.\';|                    ',
  '            || :-"      "-; ||                    ',
  '            :;              :;                    ',
  '            /  .==.    .==.  \\                    ',
  '           :      _.--._      ;                   ',
  "           ; .--.' `--' `.--. :                   ",
  "          :   __;`      ':__   ;                  ",
  "          ;  '  '-._:;_.-'  '  :                  ",
  "          '.       `--'       .'                  ",
  '           ."-._          _.-".                   ',
  '         .\'     ""------""     `.                 ',
  "        /`-                    -'\\                ",
  "       /`-                      -'\\               ",
  "      :`-   .'              `.   -';              ",
  '      ;    /                  \\    :              ',
  '     :    :                    ;    ;             ',
  '     ;    ;                    :    :             ',
  "     ':_:.'                    '.;_;'             ",
  '        :_                      _;                ',
  '        ; "-._                -" :`-.     _.._    ',
  '        :_          ()          _;   "--::__. `.  ',
  '         \\"-                  -"/`._           :  ',
  '        .-"-.                 -"-.  ""--..____.\' ',
  '       /         .__  __.         \\               ',
  "      : / ,       / \"\" \\       . \\ ;           ",
  '       "-:___..--"      "--..___;-"               ',
]

// #2 — Running Cat — Medium
const RUNNING_CAT_LINES = [
  "    _                ___       _.--. ",
  "    \\`.|\\.\\.----...-'`   `-._.-'_.-'`",
  "    /  ' `         ,       __.--'",
  "    )/' _/     \\   `-_,   /",
  "    `-'\" `\"\\_  ,_.-;_.-\\_ ',    ",
  "        _.-'_./   {_.'   ; /",
  "       {_.-``-'         {_/",
]

// #3 — Sitting Cat with Tail — Large
const SITTING_TAIL_LINES = [
  '                 ._',
  "              .-'  `-.",
  "           .-'        \\",
  "          ;    .'-\\    ;",
  "          `._.'    ;   |",
  '                   |   |',
  '                   ;   :',
  '                  ;   :',
  '                  ;   :',
  '                 /   /',
  '                ;   :                   ,',
  '                ;   |               .-"7|',
  "              .-'\"  :            .-' .' :",
  "           .-'       \\         .'  .'   `.",
  '         .\'           `-. ""-.-\'`""    `",`-._..--"7',
  '         ;    .          `-.J `-,    ;"`.;|,_,    ;',
  "       _.'    |         `\"\" `. .\"\"\"--.  o \\:.-. _.'",
  '    .""       :            ,--;   ,  `--/}o,\' ;',
  "    ;   .___.'        /     ,--.`-. `-..7_.-  /_",
  "     \\   :   `..__.._;    .'__;    `---..__.-'-.\`\"-,",
  "     .'   `--. |   \\_;    \\\'   `-._.-\")     \\\\  `-,",
  '     `.   -.`_):      `.   `-""\"\\`.   ;__.\' ;/ ;   "',
  '       `-.__7"  `-..._.\'"7     -._;\'  ``"-\'\'',
  "                         `--.,__.'              ",
]

// #4 — Cat Facing Right — Medium
const CAT_RIGHT_LINES = [
  '            ,',
  '                 \\)\\_ ',
  "                /    '. .---._",
  "              =P ^     `      '.",
  "               `--.       /     \\",
  "               .-'(       \\      |",
  "              (.-'   )-..__>   , ;",
  "              (_.--``    (__.-/ /",
  "                      .-.__.-'.'",
  "                     '-...-'",
]

// #5 — Cat Facing Left — Medium
const CAT_LEFT_LINES = [
  '                          ,',
  '                          _/((',
  "                 _.---. .'   `\\",
  "               .'      `     ^ T=",
  "              /     \\       .--'",
  "             |      /       )'-.",
  "             ; ,   <__..-(   '-.)   ",
  "              \\ \\-.__)    ``--._)",
  "               '.'-.__.-. ",
  "                 '-...-'",
]

// ── Build and export MASCOTS array ─────────────────────────────────────────

function makeMascot(name: string, lines: string[]): AsciiArt {
  return {
    lines,
    width: measureWidth(lines),
    height: lines.length,
    name,
  }
}

export const MASCOTS: AsciiArt[] = [
  makeMascot('sitting-fancy', SITTING_FANCY_LINES),
  makeMascot('running', RUNNING_CAT_LINES),
  makeMascot('sitting-tail', SITTING_TAIL_LINES),
  makeMascot('cat-right', CAT_RIGHT_LINES),
  makeMascot('cat-left', CAT_LEFT_LINES),
]

// Small mascots only (for compact two-col layout)
export const SMALL_MASCOTS: AsciiArt[] = [
  makeMascot('running', RUNNING_CAT_LINES),
  makeMascot('cat-right', CAT_RIGHT_LINES),
  makeMascot('cat-left', CAT_LEFT_LINES),
]

// ── Mascot Selection ──────────────────────────────────────────────────────

// ── Helpers ───────────────────────────────────────────────────────────────

function getEligibleMascots(columns: number): AsciiArt[] {
  const inner = columns - 2  // subtract border chars
  // Width budget: 2 dividers + 2 paddingX sides = 4
  const chrome = 4
  const middleCol = 38  // fixed info panel width
  const minRightCol = 30  // minimum for accounts panel

  // mascot must leave room for info + accounts + chrome
  const maxMascotWidth = inner - chrome - middleCol - minRightCol

  const eligible = MASCOTS.filter((m) => m.width <= maxMascotWidth)
  // If none fit three-col, allow any mascot (stacked layout handles it)
  return eligible.length > 0 ? eligible : MASCOTS
}

/**
 * Selects a random mascot appropriate for the terminal width.
 * Prefers mascots that fit in three-col layout; falls back to any mascot
 * (stacked layout will be used) if none fit.
 */
export function selectMascot(columns: number): AsciiArt {
  const eligible = getEligibleMascots(columns)
  return eligible[Math.floor(Math.random() * eligible.length)]!
}

/**
 * Selects a mascot using a pre-generated seed (0–1), so the choice is stable
 * across re-renders while still responding to terminal width changes.
 */
export function selectMascotWithSeed(columns: number, seed: number): AsciiArt {
  const eligible = getEligibleMascots(columns)
  return eligible[Math.floor(seed * eligible.length)]!
}
