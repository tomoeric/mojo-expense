/**
 * What makes a purchase a FUEL purchase, in one place.
 *
 * It was in the auto-category sweep alone, which meant the rule that
 * FLAGS a miscategorised fuel receipt and the automation that FIXES one
 * were asking different questions. The rule asked only whether the note
 * said "gas"; the automation asked that AND for a witness on the paper.
 * So a $114.40 invoice from a cleaning-systems supplier for two foam
 * tires and two caps — note: "Replacing gas powered pressure washer
 * wheels" — was flagged "Fuel Category Is Wrong" and then, correctly,
 * left alone by the automation. The flag was noise and the gap between
 * the two numbers was unexplainable.
 *
 * A note is the submitter's words about a purchase, not evidence of what
 * was bought. "Gas powered pressure washer", "gas line repair", "gas
 * grill" all say gas and none of them is fuel. The receipt and the
 * merchant are evidence, so the question a rule should be able to ask is
 * theirs, not the note's.
 */

/**
 * A fuel line as a forecourt prints one.
 *
 * Word-bounded throughout: a substring match on "gal" finds "galvanised"
 * and on "def" finds "defrost", and both are things a maintenance team
 * actually buys.
 */
export const FUEL_LINE = new RegExp([
  // Named grades and pump furniture.
  String.raw`\b(unleaded|unlead|unld|diesel|gasoline|premium\s*unl|reg\s*unl|mid\s*grade`,
  String.raw`|midgrade|e85|def\b|pump\s*#?\s*\d|gallons?\b|gal\s*@|price\s*\/\s*g|\$\s*\/\s*gal)\b`,
  // How a forecourt actually prints the two numbers, which the word list
  // above misses entirely: "UNLD CR #08  20.287G  SELF @ 3.999/ G". The
  // volume is three decimals and a bare G and the unit price is a figure
  // over G — neither spells a word, and an $81.13 Shell slip read as
  // not-fuel because of it.
  //
  // Three decimals required on the volume: pumps print three, and "3.5G"
  // on its own is not evidence of anything.
  String.raw`|\d\.\d{3}\s*g\b`,
  String.raw`|\d\s*\/\s*g\b`,
].join(""), "i");

/**
 * Merchants that sell fuel, as the names come through on a card feed.
 *
 * The second witness, for a slip too faint to read a line off. Brand
 * names only — no "mart", no "stop", nothing that merely suggests a
 * forecourt — because this is evidence, not a hunch.
 *
 * Bounded by LETTERS rather than by `\b`, which is the whole difficulty
 * with a card feed: Emburse hands over "RW6708RACETRAC INC", and between
 * the "8" and the "R" there is no word boundary at all, so a `\b` finds
 * nothing. A lookbehind for a letter still refuses "GRACETRAC" while
 * accepting a brand welded to a terminal number.
 */
export const FUEL_MERCHANT =
  /(?<![a-z])(shell|exxon|mobil|chevron|texaco|citgo|sunoco|valero|marathon|phillips\s*66|conoco|bp|circle\s*k|quiktrip|quik\s*trip|kwik\s*(trip|star|fill)|casey'?s|speedway|racetrac|race\s*trac|wawa|sheetz|murphy\s*(usa|express)|pilot\s*(travel|flying)|flying\s*j|love'?s\s*(travel|country)|buc-?ee|maverik|holiday\s*stationstore|petro|petroleum|fuel|gas\s*station)(?![a-z])/i;

/** The note saying, in the submitter's own words, that this was fuel. */
export const NOTE_SAYS_FUEL = /\b(gas|fuel|diesel|unleaded|petrol|gasoline)\b/i;

/**
 * Is there EVIDENCE this purchase was fuel?
 *
 * Three answers, and the third is the one that matters. A merchant that
 * sells fuel is evidence on its own and needs no reading. Failing that,
 * a reading with usable lines can be searched for a pump line. With
 * neither, the honest answer is that nobody knows yet — never "no",
 * because a rule reading "no" would act on every expense whose receipt
 * is still in the queue to be read, which after an import is all of them.
 */
export function fuelEvidence(input: {
  /** The receipt's line items, joined. Empty when none were read. */
  lines: string;
  /** The merchant as the card feed gives it, plus what the receipt printed. */
  merchantText: string;
  /** Whether a usable reading exists at all. Null means nothing read yet. */
  read: boolean | null;
}): boolean | null {
  if (FUEL_MERCHANT.test(input.merchantText)) return true;
  if (input.read === null) return null;
  if (FUEL_LINE.test(input.lines)) return true;
  // Read, and nothing on it says fuel. That is a real "no" — but only
  // because a reading exists to have said otherwise.
  return input.read ? false : null;
}
