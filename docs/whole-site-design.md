# Whole-site design (v28)

A calm, dense personal operating workspace. One accent, quiet surfaces, clear hierarchy, honest data,
fast and stable updates. This document is the contract every frontend change in v28 follows.
Research sources (web reading, not browser testing) are listed at the end; browser verification
is recorded separately in the delivery notes.

## Principles

1. **Density with air.** Rows 32–36px on fine pointers, ≥44px targets on coarse pointers. Content max widths
   per page type instead of large empty margins. No marketing chrome: no hero banners, no large gradients,
   no glass, no oversized illustrations. The one deliberate exception is the Compass space header (a bounded, static
   sky with a decorative astrolabe; reading, editing and history pages stay plain) — see `docs/compass.md`.
2. **One accent.** `--primary` marks the primary action, the current location and selection. Status colours
   (danger, warning, success) only carry status, always with a second cue (icon or text).
3. **Surfaces, not shadows.** Page < surface (cards, panels) < raised (menus, popovers, dialogs). Separation
   comes from hairline borders and surface steps; shadows are soft hints. Dark mode surfaces step *lighter*.
4. **Honest data.** Show what the data says, label what it does not say (e.g. calendar coverage is not hours worked;
   progress is task completion, not elapsed time). Never invent dates or totals.
5. **Stable, live updates.** Content stays on screen during background fetches and mutations; first-load
   skeletons only when there is nothing to show. No whole-view blanking, no full refetch after small writes,
   no remounts that drop scroll, drafts, expanded rows or focus.
6. **Keyboard and motion.** Every action reachable by keyboard with a visible focus ring. Motion is 140–220ms
   on transform/opacity only, reduced to none with `prefers-reduced-motion`.

## Tokens (`src/styles/custom-properties/tokens.scss`)

Use tokens, not literals. Bulma and the colour scale (`--primary`, `--grey-*`, `--danger`…) still exist; tokens sit
on top of them.

| Group | Tokens | Notes |
| --- | --- | --- |
| Type | `--text-2xs` 11 · `--text-xs` 12 · `--text-sm` 13 · `--text-md` 14 · `--text-base` 15 · `--text-lg` 17 · `--text-xl` 20 · `--text-2xl` 24 | Body is `--text-base`. Page titles `--text-xl`/`--text-2xl`, section titles `--text-lg`, meta `--text-sm`/`--text-xs`. Weights `--weight-medium` 550, `--weight-semibold` 620. Headings use the UI face; Quicksand only survives in the logo SVG. CJK falls back to PingFang/YaHei/Noto. |
| Space | `--space-1`…`--space-10` (4px grid) | Gaps 8/12/16 inside components, 20–24 between sections. |
| Radius | `--radius-xs` 3 · `--radius-sm` 5 · `$radius` 6 · `--radius-md` 8 · `--radius-lg` 12 · `--radius-full` | Controls 6, cards/menus 8, sheets/dialogs 12, chips full. |
| Surfaces | `--surface-app` · `--surface` · `--surface-raised` · `--surface-sunken` · `--surface-hover` · `--surface-active` · `--surface-selected(-strong)` · `--scrim` | Hover/selected are translucent overlays; layer them over a surface (`background-image: linear-gradient(var(--surface-hover), var(--surface-hover))` on filled controls). |
| Borders | `--border-subtle` · `--border-default` · `--border-strong` · `--input-border-color` | Hairlines are decoration; inputs/checkboxes use `--input-border-color` (visible boundary). |
| Text | `--text-primary` · `--text-secondary` · `--text-tertiary` (= `--text-muted`, AA on page and card) · `--accent-text` (AA on selected tints) · `--danger-text` | Never `--grey-400` for text. |
| Tints | `--tint-info/-danger/-warning/-success` | Backgrounds behind normal-colour text. |
| Elevation | `--elevation-1` (cards) · `--elevation-2` (sticky/hover) · `--elevation-3` (menus, popovers, dialogs, toasts) | Dark mode: deep shadow + hairline. |
| Focus | `--focus-ring-color`, mixin `focus-ring` (2px outline, 2px offset) | Outline, not box-shadow (forced-colors). `:focus-visible` only; text inputs keep the `.user-is-tabbing` gate. |
| Controls | `--control-height-sm` 28 · `--control-height` 34 · `--control-height-lg` 40 · `--target-min` | Coarse pointers: 36/40/44px. Bulma `$control-height` is 2.25em. |
| Motion | `--motion-fast` 140 · `--motion-base` 180 · `--motion-slow` 220 · `--ease-standard` · `--ease-enter` · `--ease-exit` | All durations become 0ms under reduced motion. Never `transition: all`; never animate width/height/top/left/margin; never animate streamed text. |
| Layers | `--layer-sticky` 10 · `--layer-dropdown` 20 · `--layer-header` 30 · `--layer-sidebar` 40 · `--layer-floating` 50 | Native dialogs use the top layer; teleport floating UI into the open dialog as the existing helpers do. |
| Layout | `--page-max-width` 1280 · `--page-narrow-width` 860 · `--page-gutter` | |

## Shared primitives

- **XButton** (`Button.vue`): primary = solid accent; secondary (`is-outlined`) = surface + hairline border; tertiary (`is-text`) = ghost;
  danger = deeper red fill (AA with white). `is-small` = 28px. Focus ring on `:focus-visible` only. Classes and props unchanged.
- **Card**: `--surface`, `--border-subtle`, `--radius-md`, `--elevation-1`, header bottom hairline, footer sunken.
- **Dropdown / popovers**: `--surface-raised`, hairline, `--radius-md`, `--elevation-3`, 4px inner padding, rows 32px with `--radius-sm` hover.
- **Inputs**: `$radius`, `--input-border-color`, 36px. Labels `--text-sm` semibold `--text-secondary`.
- **SegmentedControl / filter chips**: compact pills, selected = `--surface-selected` + `--accent-text`.
- **Message**: leading 3px status rule + tint; text stays `--text-primary`.
- **Toasts**: raised surface, leading status rule, short opacity/translate fade.
- **Modal**: confirm dialogs get a card surface (not text on the scrim), neutral Cancel, danger confirm when destructive.

## Page patterns

- **Page header**: `h1` (`--text-xl`, semibold) + one-line muted description + actions aligned end; wraps on phones. One h1 per page.
- **Sections**: `h2` `--text-lg`; section header row may hold actions (no negative-margin hacks).
- **Lists**: row grid `[control] [title] [meta rail] [trailing action]`; metadata as compact chips; secondary info on a muted subline.
- **States**: skeleton on first load only; inline error with Retry (`role="alert"`); empty state = short sentence + one next action;
  background refresh keeps content (optionally `aria-busy` and a subtle opacity), never blanks it.
- **Mobile (≤ 768px)**: one column, `--page-gutter`, sticky primary actions near the top where the task needs them, bottom sheets for
  pickers, no horizontal page overflow at 320px (only tables, Gantt, Kanban and year grids scroll inside their own labelled containers).

## Shell

Header 3.25rem with a hairline bottom border; compact icon buttons (`--text-secondary`), avatar 28px, username from ≥1024px.
Sidebar: grouped navigation, rows `--control-height`, hover `--surface-hover`, current `--surface-selected` + `--accent-text`,
quiet footer (brand row + compact system status). Bottom-end floating dock: upload panel stacked above the Arona launcher;
nothing else in that corner. Project backgrounds keep working; header/sidebar become translucent surfaces over them.

## Live updates (acceptance criterion)

- Queries: first load (`isPending` with no data) → skeleton; background fetch → keep data visible. Use `placeholderData` only within
  the same parent key (see `.agents/docs/api.md`).
- Mutations: patch caches precisely (`mapTaskEverywhere`, `mergeProject*`), invalidate the affected list keys with `refetchType: 'none'`
  for expensive lists. Boards are patched in place and never reset to their first page by a generic refetch.
- Changes made elsewhere (Arona receipts, `applyServerTaskChanges`): plain field edits and completion on an unfiltered board stay local
  patches. When a change can alter board membership (create, delete, a move to another project or bucket, a saved filter, a search,
  a view filter or filter buckets), the affected open board is reconciled once per batch through `kanbanServerRefresh.ts`: every
  bucket page it had loaded is re-read through its filters, the old cards stay on screen until that succeeds, and the loaded page
  count is kept. A failed reconcile keeps the patched board, marks it stale and says so. Open lists refetch only for the projects a
  change touched (global and saved-filter lists always). Details: `docs/arona-live-refresh.md`.
- Arona writes: refresh from receipts of successful action tool calls (tool, arguments, result), deduped per turn + action index,
  patching returned entities; no blanket `taskKeys.all`/`projectKeys.all` invalidation; reopening an old chat replays nothing.
- No `RouterView` keys or `v-if` toggles that remount a page for a query-only change; drafts are never overwritten by refetches.

## Project timeline (`/projects/history`)

Default tab **Timeline** aggregates real dated tasks per project (`GET /api/v2/projects/timeline`): only tasks with a start date and an
end or due date count; no created/updated inference. Per project lane: scheduled spans (gaps preserved), elapsed part (calendar time already
passed, capped at today or the task's completion), planned part (still ahead, hatched), deadline markers (next / overdue since / last),
and a separate progress meter (mean task completion) — progress is never drawn as a fill of the time bar. Year occupancy grid
(APG grid, roving focus, arrows/PageUp/PageDown/Home/End) with month zoom and day selection; 7-column month calendar on phones.
Missing-date and invalid-range counts are explained; archived/completed projects visible through the status filter.
Secondary tab **Status changes** keeps the lifecycle records (completed/archived/reopened/unarchived).

Implementation notes:
- Components: `views/project/ProjectHistory.vue` (shell: title, year picker, tabs), `components/project/history/ProjectTimelineView.vue`
  (filters, year statistics, missing-date notice, empty/error states, pagination), `TimelineOccupancy.vue` (year grid + month calendar),
  `TimelineLanes.vue` (legend, axis, lanes), `ProjectLifecycle.vue` (the former records view, unchanged behaviour). Helpers in
  `helpers/projectTimeline.ts`; query wrapper `client/queries/projectTimeline.ts` (`['project-timeline', query]`).
- URL state: `tab` (`lifecycle`; timeline is the default), `year`, `status`, `project`, `q`, `month` (1–12 zoom), `day`, `page`.
  Switching tabs drops tab-only parameters; changing year drops `day`, `month`, `page`.
- Day shading counts projects with scheduled work that day; hue/pattern says whether that day already passed (solid), is still ahead
  (hatched) or only belongs to work that finished earlier (grey). Deadline days carry a dot; today has a ring. None of it claims hours worked.
- Lane drawing: scheduled span = light tint of the project colour with an inked border; elapsed = solid; future = hatched; deadlines are
  diamonds (filled red when overdue); progress is a separate green bar with its percentage and done/total tasks. Colour is never the only cue.
- Target size: year-grid cells are below 24px on narrow desktops; the always-present month calendar offers the same selection with
  ≥36px cells (≥44px on coarse pointers), which is the WCAG 2.5.8 "equivalent" exception. Phones only get the month calendar.
- Live updates: task, project and Arona writes invalidate `['project-timeline']`; only a mounted timeline refetches, the previous data
  stays on screen at full contrast; only rows being replaced by a day/page change are dimmed (`placeholderData` within one scope).

## Accessibility

WCAG 2.2 AA: text contrast 4.5:1 on every surface tier, non-text 3:1 for control boundaries and chart marks, targets ≥24px (≥44px coarse),
reflow at 320px, focus not obscured (`scroll-padding-top` under the sticky header), colour never the only cue, APG patterns for tabs, grids,
dialogs and menu buttons.

## Sources (research)

- WCAG 2.2 Understanding: [2.5.8 Target Size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html),
  [1.4.3 Contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html),
  [1.4.11 Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html),
  [1.4.1 Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html),
  [2.4.11 Focus Not Obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html),
  [2.4.13 Focus Appearance](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html),
  [2.3.3 Animation from Interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html),
  [1.4.10 Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html);
  techniques [C39](https://www.w3.org/WAI/WCAG22/Techniques/css/C39), [C40](https://www.w3.org/WAI/WCAG22/Techniques/css/C40).
- MDN: [prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion),
  [prefers-color-scheme](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-color-scheme),
  [color-scheme](https://developer.mozilla.org/en-US/docs/Web/CSS/color-scheme).
- WAI-ARIA APG: [Tabs](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/), [Grid](https://www.w3.org/WAI/ARIA/apg/patterns/grid/),
  [Date picker dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/examples/datepicker-dialog/),
  [Dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/), [Menu button](https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/),
  [Keyboard interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/).
- Material 3 motion tokens (material-web, first-party):
  [_md-sys-motion.scss](https://raw.githubusercontent.com/material-components/material-web/main/tokens/versions/latest/sass/_md-sys-motion.scss).
- Apple HIG data endpoints: [Accessibility](https://developer.apple.com/tutorials/data/design/human-interface-guidelines/accessibility.json),
  [Layout](https://developer.apple.com/tutorials/data/design/human-interface-guidelines/layout.json).
- Vikunja help: [Views](https://vikunja.io/help/views), [Accessibility](https://vikunja.io/help/accessibility).
