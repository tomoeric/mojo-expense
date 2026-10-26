/**
 * The Dutch Miller page registry — the single list of what access can be
 * granted to.
 *
 * Its own module so that roles and users can both read it without
 * importing each other. The rail, the role editor and the `requirePage`
 * guards all come from here, so a new page is one entry plus a route.
 * Never keep a second copy in the UI: a typo in it grants access to
 * nothing while looking like access to something.
 *
 * TWO SHAPES, deliberately:
 *
 *   DM_GRANTS is what access is granted to, one flat list. It is what a
 *   role stores and what `requirePage` asks about.
 *
 *   DM_PAGES is how the rail is laid out, with sub-pages grouped under a
 *   heading. A group is not itself a grant — each sub-page names the
 *   grant it needs — so navigation can stay grouped while access is
 *   decided one page at a time.
 */

/** Everything a role can be given, flat. These strings are stored. */
export const DM_GRANTS = [
  {
    key: "member-signups",
    label: "Member Signups — Review Existing",
    blurb: "Read member records, open them, and approve them.",
  },
  {
    /*
     * Submitting is its own grant.
     *
     * Reviewing and enrolling are different jobs: a dealership's front
     * desk enrols and never approves, and somebody at MOJO reads the
     * queue without ever typing a member in. Granting them together
     * meant one of those two people always held something they did not
     * need.
     */
    key: "member-signups-add",
    label: "Member Signups — Add New",
    blurb: "Enrol a member, assign a tag, and import a file of them.",
  },
  {
    key: "vendors",
    label: "Vendors",
    blurb: "Approved vendors, and the review that approves them.",
  },
  {
    key: "rfid-instructions",
    label: "RFID Instructions",
    blurb: "Where the sticker goes on the vehicle, and how to apply it.",
  },
  {
    key: "rfid-review",
    label: "RFID Inventory",
    blurb: "Every tag: available, assigned, held back and removed.",
  },
  {
    /*
     * The partner's own business record.
     *
     * Its own grant rather than an administrator's page: the people
     * who fill it in are the dealership's, and the people who review
     * it are MOJO's, and neither of those is "administers the app".
     */
    key: "account-registration",
    label: "Account Registration",
    blurb: "The partner's business details, verification and agreement.",
  },
] as const;

export type DmPageKey = (typeof DM_GRANTS)[number]["key"];
export const DM_PAGE_KEYS: DmPageKey[] = DM_GRANTS.map((p) => p.key);
export const isDmPage = (v: unknown): v is DmPageKey =>
  typeof v === "string" && (DM_PAGE_KEYS as string[]).includes(v);

/** How the rail groups them. A group's own key is its route prefix. */
export const DM_PAGES = [
  {
    key: "member-signups",
    label: "Member Signups",
    blurb: "Enrol a member and assign them an RFID tag.",
    children: [
      { key: "review", label: "Review Existing", grant: "member-signups" },
      { key: "add", label: "Add New", grant: "member-signups-add" },
    ],
  },
  /*
   * Vendors is deliberately NOT in the partner rail.
   *
   * The rail is the work a dealership comes here to do: enrol a
   * member, find a tag, read the instructions. Approving a company to
   * be paid is not that job, and on a platform where most partners
   * will never have a vendor it is a heading that is empty for nearly
   * everybody who can see it.
   *
   * It is not removed. The grant is still in DM_GRANTS above, every
   * route still enforces it, every record is where it was, and the
   * page is reached from the account menu by anybody holding it —
   * the same place Users, Roles and Settings live, for the same
   * reason.
   */
  {
    key: "rfid-instructions",
    label: "RFID Instructions",
    blurb: "Where the sticker goes on the vehicle, and how to apply it.",
    children: [],
  },
  {
    key: "rfid-review",
    label: "RFID Inventory",
    blurb: "Every tag: available, assigned, held back and removed.",
    children: [],
  },
] as const satisfies readonly {
  key: string;
  label: string;
  blurb: string;
  children: readonly { key: string; label: string; grant: DmPageKey }[];
}[];

/**
 * Which grants a rail group needs.
 *
 * A group with no sub-pages is its own grant. One with sub-pages needs
 * whichever of theirs the person holds — the group appears if any does.
 */
export function grantsIn(group: (typeof DM_PAGES)[number]): DmPageKey[] {
  return group.children.length === 0
    ? [group.key as DmPageKey]
    : group.children.map((c) => c.grant);
}
