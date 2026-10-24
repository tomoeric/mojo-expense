/**
 * The Dutch Miller page registry — the single list of what access can be
 * granted to.
 *
 * Its own module so that roles and users can both read it without
 * importing each other. The rail, the role editor and the `requirePage`
 * guards all come from here, so a new page is one entry plus a route.
 * Never keep a second copy in the UI: a typo in it grants access to
 * nothing while looking like access to something.
 */
export const DM_PAGES = [
  {
    key: "member-signups",
    label: "Member Signups",
    blurb: "Enrol a member and assign them an RFID tag.",
    // Sub-pages of one page, not pages of their own: access is granted at
    // the parent, so a tick-box per tab would only be a way to hand
    // somebody Add New without Review Existing.
    children: [
      { key: "review", label: "Review Existing" },
      { key: "add", label: "Add New" },
    ],
  },
  {
    key: "rfid-review",
    label: "RFID Review",
    blurb: "Upload RFID numbers and review active and used ones.",
    children: [],
  },
] as const;

export type DmPageKey = (typeof DM_PAGES)[number]["key"];
export const DM_PAGE_KEYS: DmPageKey[] = DM_PAGES.map((p) => p.key);
export const isDmPage = (v: unknown): v is DmPageKey =>
  typeof v === "string" && (DM_PAGE_KEYS as string[]).includes(v);
