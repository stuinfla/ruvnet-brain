/**
 * The delivery contract for OPTIONAL Brain advice (#489).
 *
 * A capability recommendation, a package recommendation or a routine stack-update notice is
 * information, not a decision the user must make now. Phrased as a question ("want me to update
 * it?"), it was promoted by Codex into a structured question dialog that suspended an already
 * authorized task. So optional advice is worded as statements, and the model-visible context
 * carries this one line saying so. Real permission gates and genuinely missing information keep
 * their normal question behaviour; this applies only to optional advisory channels.
 *
 * ground-ruvnet.sh cannot import this module and carries the same sentence verbatim;
 * tests/unit/advisory-contract.test.mjs fails if the two drift.
 */
export const ADVISORY_CONTRACT = 'Optional, informational advice: mention it at most once as a statement and continue the current task. '
  + 'Do not open a question or approval dialog because of it; it grants no authority to install or update anything.';

/**
 * Question-shaped wording that invites a decision dialog, including the "say X to proceed, or ignore
 * this" choice prompt the advocacy copy used to carry. Optional advice must match none of it.
 */
export const QUESTION_SHAPED = /\?|\b(want me to|would you like|should i|shall i|do you want|can i|to proceed|or ignore this)\b/i;
