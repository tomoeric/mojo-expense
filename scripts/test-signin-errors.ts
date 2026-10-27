/**
 * Reading what Emburse says when a sign-in does not work.
 *
 *   pnpm exec tsx scripts/test-signin-errors.ts
 *
 * These are pure functions over the page's text, and they decide
 * the single most-read sentence in the app: why a connection
 * failed. Getting one wrong does not break anything — it sends a
 * person to fix the wrong thing, which is worse, because they
 * will believe it.
 *
 * They lived in `test-export.ts`, behind a required export PDF
 * that nobody has to hand — so the checks that should have caught
 * the wording below had not run in a long time, and the wording
 * below is Emburse's own, off a real failed sign-in. A test that
 * needs a file nobody has is a test that is not run. They are
 * here now, where they need nothing.
 */
import {
  challengeKind, credentialsRejected, isCredentialFault,
} from "../server/emburse/auto-export.js";

let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

// The real one Emburse parks a half-finished sign-in on. The
// path is the evidence, not the words on the page.
const CODE_URL =
  "https://account.emburse.app/code-authentication?session_token=eyJhbGciOiJIUzI1NiJ9.abc";

console.log("1. A verification screen is never a password problem");
check("the address alone identifies a code page", challengeKind("", CODE_URL) === "code");
check("…and it is not called a password problem", !isCredentialFault("", CODE_URL));
check("“try again” alone is not a rejected password",
  !credentialsRejected("Didn't get a code? Try again."));
check("…and a code page wins over text that says both",
  !isCredentialFault("Wrong password. Try again.", CODE_URL));

console.log("\n2. EMBURSE'S OWN WORDING, off a real failed sign-in");
/*
 * The case this file exists for. The old test checked a phrase
 * somebody imagined — "wrong email or password" — and Emburse
 * says "Incorrect email address and/or password", which matched
 * neither that nor "incorrect password" nor "invalid email". So a
 * plainly rejected login fell through to the catch-all and was
 * reported as "if that looks like Emburse, the loggedIn selector
 * is what needs correcting", and the password was never flagged
 * for re-entry. Somebody went looking for a selector fault with
 * the real answer on their screen.
 */
const EMBURSE_SAYS =
  "Incorrect email address and/or password. Sign in eric.s@mojocarwash.com "
  + "Enter password LOGIN Forgot password?";
check("IT IS RECOGNISED AS A REJECTION", credentialsRejected(EMBURSE_SAYS));
check("…and counts as a credential fault, so the password is re-asked for",
  isCredentialFault(EMBURSE_SAYS));
check("…while the same text on a code screen still does not",
  !isCredentialFault(EMBURSE_SAYS, CODE_URL));

console.log("\n3. Others in the same family, which the phrase book missed too");
check("“Invalid credentials.”", credentialsRejected("Invalid credentials."));
check("“Unrecognized email or password.”",
  credentialsRejected("Unrecognized email or password."));
check("“Wrong email or password.” still reads as one",
  credentialsRejected("Wrong email or password. Please try again."));
check("“The password is incorrect.” still reads as one",
  credentialsRejected("The password is incorrect."));
check("“We could not sign you in.” still reads as one",
  credentialsRejected("We could not sign you in."));

console.log("\n4. And it does NOT fire on pages that merely mention a password");
/*
 * The risk of matching a shape rather than a phrase. Every
 * sign-in page in the world has the word "password" on it, and a
 * rule loose enough to call them all rejections would send
 * somebody to retype a working password every time a selector
 * drifted — which is the fault this whole classification exists
 * to avoid, pointing the other way.
 */
check("an ordinary sign-in page",
  !credentialsRejected("Sign in Enter password LOGIN Forgot password?"));
check("a code screen that happens to mention one",
  !credentialsRejected("Incorrect code. Enter password to try again."));
check("a password expiry notice",
  !credentialsRejected("Your password will expire in 5 days."));
check("a page offering a reset",
  !credentialsRejected("Forgot password? We will email you a reset link."));
check("…and nothing at all", !credentialsRejected(""));

console.log(failures === 0 ? "\nPASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
