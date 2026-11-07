# Organized layout (module)

Carol's layout for the Kenan app, kept in this folder so a host builds it only when it lists `organized` in `/etc/kenan/modules`. ResearchCo's Beta does not: everyone there gets Classic. The to-do list, To buy list and question cards it shows are core (`todos` extension, `web/todo/`; see DESIGN.md); the per-person switch is `organized` in `people[].extensions`, with `rooms`, `bubble`, `busyline`, `changelog` and `dictation` for the pieces around it.

Server: `modules/organized/server/` (the `organized` extension: chat groups, project files, new chats, layout and tip routes under `/api/ext/organized/`, the morning check, the manager defaults; the `bubble`, `busyline` and `changelog` extensions; the todos tool's `morning` and `onHome` and the rooms tool's project, group, pin and layout actions; origin routing). Browser: `modules/organized/web/` (`Host.tsx` is what the app shell renders).


A person whose channel config lists the `organized` extension chooses a layout per person on the server
(`person.layout`, `PUT /api/layout`, `Bootstrap.layout`, a `layout` stream event): **Classic** (the sidebar app, the
default) or **Organized** (`modules/organized/web/`, Carol's approved mockups, 2026-10-21). People without the extension
always see the current Classic layout, whatever layout setting is stored (`web/classic.test.ts` compares those two settings).
With the extension, Classic's ☰ footer gains **To-do** and the **Layout** switch. Organized is
its own lazily loaded chunk (JS and CSS), so Classic's startup download is unchanged.

- **Screens.** Phone: Home (☰ menu panel, Pinned, Waiting on you = the Today section, then a smaller Soon list (4 rows and
  "See all (N) →"), To-do/Calendar shortcuts,
  and one footer line "date · ✈️ N days until PLACE" from the next calendar event whose title starts with ✈️),
  Chats (Open/Pinned/Workers/Closed; "＋ New chat" at its top right opens a sheet: an optional "What's it about?"
  title, the people to add in a list scrolling about two at a time, Cancel / Start chat; `POST
  /api/ext/organized/chats` makes the chat with her, them and her Kenaznia, and with no title names it "New chat",
  unlocked, for Kenaznia to name from the conversation; a project page's ＋ New uses the same route), Activity (workers' reports and live runs), To-do (By urgency/By list/Done), and the
  topic, calendar, goals and usage views Classic uses. Wide screens (≥ 900 px): three panes, menu | list | open topic. The menu (default 200 px, 160–360) and the list (320 px, 260–560) are resized by dragging the border after each (arrow keys too; double-click resets), kept per person per device (`localStorage` `kenan.panes.PERSON`, `modules/organized/web/panes.ts`, Erin 2026-10-28); the open chat keeps at least 400 px, the list and then the menu giving way. One divider component (`web/Divider.tsx`) serves these and the file viewer; check `bench/ui/check-panes.mjs`.
- **Unread mark.** A chat with a message she hasn't read (`unread`: its newest previewable message is past her
  `readThrough`) shows one small 💬 after its title wherever it is listed: Chats rows, her Kenaznia row, Home's pinned
  cards (at the right end of the title line) and the wide sidebar's pins (Carol 2026-10-23: to see that Kenan answered
  in a pinned chat without opening it). Nothing else changes: no count, no colour, the card keeps its colour. Opening the
  chat reads it and the mark goes. Gated only by the Organized layout itself. Regression `modules/organized/web/home.test.ts`.
- **Chat emoji.** A chat without its own emoji shows 🌀 for her Kenaznia, 👥 when shared with other people, its group's
  emoji, else 📄: never 💬, the unread mark (Carol 2026-10-28). Classic is unchanged.
- **Home's pins** are compact chips (emoji, title, key date) that wrap onto as many lines as they need, never a
  sideways-scrolling row, on phones and wide screens alike (Carol 2026-10-28).
- **Topics** are conversations: `emoji`, `pinned_at` with an optional `key_date`/`key_label` ("Due Oct 29"), close =
  archive (Undo toast), Closed tab = archived. Closing lives only in a menu (⋯ in the topic header or row, "🗄️ Close chat") and swipe-left in Chats, never as a header button: Carol kept tapping it by accident. `title_locked`: a title set through `PATCH /api/conversations/:id` locks it
  (unless `titleLocked` says otherwise); anything that renames conversations automatically must leave locked ones alone.
- **Project pages**: tapping a project anywhere (Chats rows, Home pinned cards, sidebar pins, chat links, linked
  to-dos) opens its chat (Carol 2026-10-22); the chat header's 🗂️ Page button opens the page and Back (Android's or the page's ‹) returns to the
  chat, along the same trail chat links use. A topic with `project` set (⋯ → Make it a project page, or Kenaznia) has a page: its one-line
  `status_line` (tap to edit; Kenaznia sets it too), its to-dos (`todo.conversation_id`), its chats (the topic itself and
  rooms whose `project_id` points at it, ＋ New), its files (`GET /api/ext/organized/projects/:id/files`, from
  `conversation_file`) and the key date. On wide screens the page sits in the list pane next to its chat.
- **Kenaznia mirrors every manual action** (Carol 2026-10-21: anything she can do by hand in Organized, Kenaznia does
  when asked, and it organises proactively: sorts new rooms into groups, offers "want this to be a project?" when a chat
  has a finish line). The `rooms` tool (extension `rooms`): `list` (title, emoji, color, titleLocked, pinned/keyDate/
  keyLabel, project/status, projectId, groupId, archived, lastActivity; `includeArchived`), `create` (members: the person
  and her Kenaznia; optional emoji, groupId, projectId), `rename` (refused with `title_locked` for a name she chose
  unless `herRequest`), `lock` (unlocking her lock needs `herRequest`), `style` (emoji, #RRGGBB colour), `pin` (key date
  YYYY-MM-DD and label; unpin clears both), `close`/`reopen` (her topic rooms only; agents' chats refuse), `project`
  (page on/off, status), `group` (projectId: a project page she is in, never the room itself or a project under a
  project), the group actions below and `layout` (classic|organized). Every room action resolves the room through her
  membership (`not_found` otherwise). The `todos` tool links items to a project with `conversationId`, which must be a
  project page of hers. The `calendar` tool has `update` (edit and move a one-off event) and `restore` (undo a delete)
  next to list/create/delete, with the same validation as the routes.
- **Calendar** (Organized only, `modules/organized/web/CalendarViews.tsx`, arithmetic in `calendar.ts`): Day/Week/Month switch,
  ‹ › and Today, swipe to move, tap a day to open it, weeks always start on Monday (views and date pickers; Carol 2026-10-21). Like a phone calendar app:
  tap an empty slot (or ＋) for the event sheet (title, all-day, start/end with the tappable date picker, colour,
  location, notes), tap an event for details with Edit and Delete (Undo restores it: `POST /api/ext/calendar/:id/restore`;
  delete is soft). `PATCH /api/ext/calendar/:id` edits a one-off event; a repeating series is changed through Kenan
  (Delete on one occurrence cancels just it). Overlapping events sit side by side (`lanes`), all-day events in a strip,
  a red now line. Pinch zooms the hour scale (20–120 px/hour, anchored, per device); Ctrl+wheel on desktop; − ＋ only
  for a fine pointer (Carol, 2026-10-22: no zoom buttons on phones, pinch is enough). Drag and drop like Google
  Calendar in Day/Week: long-press an event (400 ms; a mouse just drags) to lift it, drag to move (15-minute snaps,
  across days in Week), or drag its 12 px bottom edge to resize; saved with `PATCH` and an Undo toast (`moved`/`resized`
  in `calendar.ts`). A repeating occurrence refuses: "Ask Kenan to change a repeating event".
  Hour labels are one line in the 48 px gutter (`hourLabels`: the locale's own format, day period without dots, so
  en-CA's "12 p.m." is "12 pm"; Carol 2026-10-25, it wrapped onto the next hour), and event text wraps between words,
  breaking a word only when it alone is wider than the block. `bench/ui/check-calendar.mjs` checks both in Day and
  Week at 360/412 px, every zoom end and en-CA, en-US and fr-CA.
- **Sheets** (`modules/organized/web/sheets.tsx`): in-app bottom sheets replace browser prompts: pin with a key date (label
  chips + tap a day, or No date), rename and status (text), emoji (grid), put under a project (choice list), a to-do's
  actions (action list).
- **Chat groups** (table `chat_group`, per person; a room's group is `member.group_id`, so a shared room sits in each
  member's own group, and the composite key `(group_id, person_id) → chat_group(id, owner_id)` makes another person's
  group unusable; deleting a group ungroups its rooms). Chats' Open tab: Projects first (a project shows its group's
  emoji; no key date shows nothing), then one titled section per non-empty group in position order ("💼 Business (5)"),
  then "💬 Other". Each group is a colour family (`FAMILIES` in colors.ts: amber, garnet, plum, blue, teal, lime; Other
  is sage-slate) and its rows spread within it. ⋯ on a topic → Change group (her groups, ＋ New group, No group); ⋯ on a
  section header edits or deletes the group (Undo recreates it and puts its rooms back). `ChatSection` is where
  collapsing will live. API `GET|POST /api/ext/organized/groups`, `PATCH|DELETE …/groups/:id`, `PATCH
  /api/conversations/:id {groupId}`; every change pushes `chat_groups` (the whole list). Kenaznia: the rooms tool's
  `groups`, `group_create`, `group_update`, `group_delete`, `set_group`, and `create` with `groupId`.
- **Density**: one CSS knob, `--home` on `.org-dense` (0.89; Home's Soon list 0.84), scales the type, rows, headers,
  tabs and add fields of Home and the To-do screen; touch targets stay ≥ 44 px; chat message text stays 16 px. Chats' Open tab lists Projects (status line and key date) above Topics.
- **Demo mode** (`modules/organized/web/DemoOrganized.tsx`, data in `demo.ts`): a developer and test tool, reached only by
  `?demo=1` (no menu item; nothing stores it). It renders Organized over made-up to-dos, projects, topics, events and
  activity held in memory; every write (ticks, pins, events, rooms) changes only that copy, and a Demo badge shows.
  Its own lazy chunk, so the real layout never downloads it. It works with the Classic layout saved, without changing
  it; switching layout in ☰ leaves it.
- **Colours** (`shared/colors.ts`, tints in `modules/organized/web/colors.ts`): to-dos take the warm gradient by current position;
  each topic keeps its own colour on her member row (picked once by the server, frozen for older chats), changed only by
  ⋯ → 🎨 Change colour (Chats rows, chat header, project page: `SWATCHES`, or Pick automatically, which clears it so the
  server picks again) or the rooms tool's `style`. Precomputed `#RRGGBBAA` tints (never `color-mix()`); a test keeps white text ≥ 4.5:1 on every tint (gold is capped at 50%).
- **Organized's features come with the layout** (Carol 2026-10-25): every person has `organized`, `rooms`,
  `dictation`, `bubble` and `busyline`; choosing Organized is the opt-in. On Classic the composer mic and the busy line
  don't show (`App.tsx` `organizedShown`). Agent tools have the same descriptions, schemas and accepted arguments
  on both layouts. Rooms, groups, projects and to-dos store their state on either layout; the layout controls only
  their presentation and where background answers appear.
- **🌀 bubble and quick panel** (extension `bubble`; Carol's mockups design/mic, 2026-10-22;
  `modules/organized/web/Bubble.tsx`, its own lazy chunk; decisions in `bubble.ts`, her chat in `quick.ts`). A 40 px 🌀 floats on
  Home, To-do, Chats, Calendar and project pages, never over a chat (wide screens: only while the main pane is not a chat,
  bottom right of it). Drag it anywhere: it snaps to the nearer side edge, remembered per device (`kenan.bubble`), and goes
  half-transparent while the page scrolls. Tap: it records through `web/dictation.ts` (lime ring, level bars, a "0:04 · tap
  to send" chip, itself a button that sends), streamed like the composer's; tap the bubble or the chip: the panel opens at ¼ with her pending bubble (the words so far), and the whole text goes straight to her Kenaznia chat (after anything typed in the field, it goes into the field instead). Dragging it onto the
  bottom-centre ✕ hides it (a dim 🌀 pill on the tab bar's top edge; drag or tap it back; the first time the bubble shows,
  a tip with OK explains tapping, hiding and bringing it back, marked `bubble` in her onboarding `seen`, Carol 2026-10-25), or stops a running recording and keeps
  it. Her words are never lost (Carol 2026-10-24): stopping (■, or the bubble dropped on ✕), a failed transcription,
  a failed send and the bubble going away (she opens a chat) put the words in the field, which is her Kenaznia chat's
  draft (`QuickChat.draft`, the same one its composer shows), the final text replacing the words so far unless she
  edited the field meanwhile; Try again fills the field. The panel is that chat (its live history from the top, right under its header, on dark grey #262826 with the field and the grey mic darker, hard-clipped at the top without a fade; streamed answers; one small grey line "Kenaznia is thinking…" while it works; a field with a mic that turns into Send; while recording from the panel her words so far show as her pending bubble; recording from the panel, the field becomes a wave · timer · ■ strip (■ stops and keeps the words to edit) and the button a bright white Send ↑; a clip that could not be written down offers Try again): the handle
  drags it between ¼ and ⅔ (page dimmed) and down onto the ✕ or off to close; Back closes it; the field lifts it above the
  keyboard over the tab bar. Wide screens get a floating drawer at the right of the main pane instead. Each panel message
  carries `seenFrom` (`SendRequest`, ≤ 200 chars, e.g. "To-do, By urgency" or "Calendar, Day view, Thu, Oct 22"): never
  stored or shown, it rides on the agent input and the prompt gets `[seen from: …]` after her words; the extension's
  manager snippet tells Kenaznia what it means.
- **Back.** Overlays close first (useOverlay: every dialog and menu registers, checked by `web/overlays.test.ts`; images,
  in a chat or on a project page, open in the in-app viewer); otherwise Back from any Organized screen returns Home, and
  Back on Home leaves the app. In the Android app a link to one of our files downloads instead of replacing the page
  (`web/fileLinks.ts`), so Back never lands outside the app. In Classic with the extension, on a phone, Back from a page opens the conversation list first.


### 📰 What's new (extension `changelog`, Organized only)

Carol 2026-10-27: a plain-language changelog, newest first, by day. `deploy/prepare-build.sh` writes each build's own
history to `dist/commits.log` (`git log --no-merges` of the deployed commit) and `install-build.sh` moves it into place on
every deploy, frontend-only ones too, so each channel lists exactly the commits it runs (production: what was promoted).
`server/extensions/changelog.ts` re-reads it when it changes, shows the 14 days before the newest commit (one per subject),
and has a background writer put missing commits into one line each ("Fixed: …", "New: …", "Better: …", "Changed: …", or
null for behind-the-scenes work, shown as one "Behind the scenes: N improvements." line per day): Haiku through the
subscription broker of the first person with the extension, 40 commits per call, 4 calls at a time, at start and on a read
while some are missing (a failure waits 10 minutes). Each commit is written once (`changelog_line`, keyed by hash, shared by
everyone on the channel); about $0.003 per 40 commits, so a first fill of ~1,500 commits is ~$0.10 and ~3 minutes.
`changelog_seen` keeps per person the newest entry time they saw: Organized's ☰ and its 📰 What's new tile carry a dot
while a written change is newer (`GET /api/ext/changelog/unseen`), and opening the page (`modules/organized/web/WhatsNew.tsx`, its
own lazy chunk, message-sized text) marks it seen. Classic never shows it. A person's extension config
(`/etc/kenan/domains/ID.json`) may hold `{"changelog": {"authors": ["Carol's Kenaznia"]}}` to list only those authors'
commits; without it every change shows. Regression `server/extensions/changelog.test.ts`.

