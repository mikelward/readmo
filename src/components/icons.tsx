import type { ReactNode, SVGProps } from 'react';

// Material Symbols Outlined — Apache 2.0, Google. viewBox 0 -960 960 960,
// fill-based paths that take `color` via currentColor. Monochrome, inline,
// no icon font / runtime request (SPEC.md *Visual design*).
const MS_VIEWBOX = '0 -960 960 960';

type IconProps = Omit<SVGProps<SVGSVGElement>, 'viewBox' | 'fill' | 'children'>;

function MaterialIcon({
  children,
  width = 24,
  height = 24,
  ...rest
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox={MS_VIEWBOX}
      fill="currentColor"
      width={width}
      height={height}
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

// ---- Undo (Material undo) -------------------------------------------------

export function Undo(props: IconProps) {
  return (
    <MaterialIcon {...props}>
      <path d="M280-200v-80h284q63 0 109.5-40T720-420q0-60-46.5-100T564-560H312l104 104-56 56-200-200 200-200 56 56-104 104h252q97 0 166.5 63T800-420q0 94-69.5 157T564-200H280Z" />
    </MaterialIcon>
  );
}

// ---- Sweep (Material cleaning broom) --------------------------------------

export function Sweep(props: IconProps) {
  return (
    <MaterialIcon {...props}>
      <path d="M400-240v-80h240v80H400Zm-158 0L15-467l57-57 170 170 366-366 57 57-423 423Zm318-160v-80h240v80H560Zm160-160v-80h240v80H720Z" />
    </MaterialIcon>
  );
}

// ---- Pin (push_pin) -------------------------------------------------------

// The pin glyphs use the classic Material Icons 24x24 grid (not the
// 0 -960 960 960 Symbols grid the rest of this file uses): the Symbols
// push_pin paths rendered as a broken diagonal sliver. These are the
// well-known Material `push_pin` outline/filled shapes.
function PinSvg({ children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      width={24}
      height={24}
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export function PushPinOutline(props: IconProps) {
  return (
    <PinSvg {...props}>
      <path d="M14 4v5c0 1.12.37 2.16 1 3H9c.65-.86 1-1.9 1-3V4h4m3-2H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3V4h1c.55 0 1-.45 1-1s-.45-1-1-1z" />
    </PinSvg>
  );
}

export function PushPinFilled(props: IconProps) {
  return (
    <PinSvg {...props}>
      <path d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z" />
    </PinSvg>
  );
}

// ---- Favorite (heart) -----------------------------------------------------

export function FavoriteOutline(props: IconProps) {
  return (
    <MaterialIcon {...props}>
      <path d="m480-120-58-52q-101-91-167-157T150-447.5Q111-500 95.5-544T80-634q0-94 63-157t157-63q52 0 99 22t81 62q34-40 81-62t99-22q94 0 157 63t63 157q0 46-15.5 90T810-447.5Q771-395 705-329T538-172l-58 52Zm0-108q96-86 158-147.5t98-107q36-45.5 50-81t14-70.5q0-60-40-100t-100-40q-47 0-87 26.5T518-680h-76q-15-41-55-67.5T300-774q-60 0-100 40t-40 100q0 35 14 70.5t50 81q36 45.5 98 107T480-228Zm0-273Z" />
    </MaterialIcon>
  );
}

export function FavoriteFilled(props: IconProps) {
  return (
    <MaterialIcon {...props}>
      <path d="m480-120-58-52q-101-91-167-157T150-447.5Q111-500 95.5-544T80-634q0-94 63-157t157-63q52 0 99 22t81 62q34-40 81-62t99-22q94 0 157 63t63 157q0 46-15.5 90T810-447.5Q771-395 705-329T538-172l-58 52Z" />
    </MaterialIcon>
  );
}

// ---- Done (check) ---------------------------------------------------------

// A bare check mark (Material Symbols `check`) for the reader's Done toggle —
// the done state is conveyed by the accent color, not a surrounding circle.
export function Check(props: IconProps) {
  return (
    <MaterialIcon {...props}>
      <path d="M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z" />
    </MaterialIcon>
  );
}

// `check_circle` (filled) still backs the Library "Done" section glyph.
export function CheckCircleFilled(props: IconProps) {
  return (
    <MaterialIcon {...props}>
      <path d="m424-296 282-282-56-56-226 226-114-114-56 56 170 170Zm56 216q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Z" />
    </MaterialIcon>
  );
}

// ---- Hidden (visibility_off) ----------------------------------------------

export function VisibilityOff(props: IconProps) {
  return (
    <MaterialIcon {...props}>
      <path d="m644-428-58-58q9-47-27-88t-93-32l-58-58q17-8 34.5-12t37.5-4q75 0 127.5 52.5T660-500q0 20-4 37.5T644-428Zm128 126-58-56q38-29 67.5-63.5T832-500q-50-101-143.5-160.5T480-720q-29 0-57 4t-55 12l-62-62q41-17 84-25.5t90-8.5q151 0 269 83.5T920-500q-23 59-60.5 109.5T772-302Zm20 246L624-222q-35 11-70.5 16.5T480-200q-151 0-269-83.5T40-500q21-53 53-98.5t73-81.5L56-792l56-56 736 736-56 56ZM222-624q-29 26-53 57t-41 67q50 101 143.5 160.5T480-280q20 0 39-2.5t39-5.5l-36-38q-11 3-21 4.5t-21 1.5q-75 0-127.5-52.5T300-500q0-11 1.5-21t4.5-21l-84-82Zm319 93Zm-151 75Z" />
    </MaterialIcon>
  );
}

// ---- Mark unread (mark_email_unread) --------------------------------------

export function MarkUnread(props: IconProps) {
  return (
    <MaterialIcon {...props}>
      <path d="M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h487q-5 20-6.5 40t1.5 40H160l320 200 153-96q14 12 30 21t34 15L480-440 160-640v400h640v-322q23-5 43-15t37-24v361q0 33-23.5 56.5T800-160H160Zm640-560q-50 0-85-35t-35-85q0-50 35-85t85-35q50 0 85 35t35 85q0 50-35 85t-85 35Z" />
    </MaterialIcon>
  );
}

// ---- Search ---------------------------------------------------------------

export function Search(props: IconProps) {
  return (
    <MaterialIcon {...props}>
      <path d="M784-120 532-372q-30 24-69 38t-83 14q-109 0-184.5-75.5T120-580q0-109 75.5-184.5T380-840q109 0 184.5 75.5T640-580q0 44-14 83t-38 69l252 252-56 56ZM380-400q75 0 127.5-52.5T560-580q0-75-52.5-127.5T380-760q-75 0-127.5 52.5T200-580q0 75 52.5 127.5T380-400Z" />
    </MaterialIcon>
  );
}

// ---- Menu (hamburger) -----------------------------------------------------

export function Menu(props: IconProps) {
  return (
    <MaterialIcon {...props}>
      <path d="M120-240v-80h720v80H120Zm0-200v-80h720v80H120Zm0-200v-80h720v80H120Z" />
    </MaterialIcon>
  );
}

// ---- Arrow back -----------------------------------------------------------

export function ArrowBack(props: IconProps) {
  return (
    <MaterialIcon {...props}>
      <path d="M313-440l224 224-57 56-320-320 320-320 57 56-224 224h487v80H313Z" />
    </MaterialIcon>
  );
}

// ---- Back to top (vertical_align_top) -------------------------------------

export function VerticalAlignTop(props: IconProps) {
  return (
    <MaterialIcon {...props}>
      <path d="M240-760v-80h480v80H240Zm200 640v-446L336-462l-56-58 200-200 200 200-56 58-104-104v446h-80Z" />
    </MaterialIcon>
  );
}

// ---- Collapse all (unfold_less) -------------------------------------------

// Chevrons pointing toward the center — the group-by-feed "Collapse all".
export function UnfoldLess(props: IconProps) {
  return (
    <MaterialIcon {...props}>
      <path d="m343-160-43-43 180-180 180 180-43 43-137-137-137 137Zm137-417L300-757l43-43 137 137 137-137 43 43-180 180Z" />
    </MaterialIcon>
  );
}

// ---- Expand all (unfold_more) ---------------------------------------------

// Chevrons pointing away from the center — the group-by-feed "Expand all".
export function UnfoldMore(props: IconProps) {
  return (
    <MaterialIcon {...props}>
      <path d="M480-120 300-300l44-44 136 136 136-136 44 44-180 180ZM344-612l-44-44 180-180 180 180-44 44-136-136-136 136Z" />
    </MaterialIcon>
  );
}

// ---- Group by feed toggle: flat list vs. tree -----------------------------

// The two faces of the top toolbar's group-by-feed toggle (SPEC.md *List
// toolbar*). Custom 24×24 glyphs (not Material paths) so the list↔tree contrast
// is unmistakable: `ListFlat` is the merged river (equal full-width rows);
// `ListTree` is the grouped view (a feed header with a spine and indented
// items). The toolbar renders whichever matches the current state.

// Flat river: a bulleted list (square bullet + line per row), no frame. The
// leading bullets keep it distinct from the hamburger `Menu` glyph (three plain
// full-width bars), which it would otherwise be mistaken for.
export function ListFlat(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      width={24}
      height={24}
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <rect x="3.9" y="5.5" width="2.8" height="2.8" rx="0.6" />
      <rect x="9" y="5.85" width="11" height="2.3" rx="1.15" />
      <rect x="3.9" y="10.6" width="2.8" height="2.8" rx="0.6" />
      <rect x="9" y="10.85" width="11" height="2.3" rx="1.15" />
      <rect x="3.9" y="15.7" width="2.8" height="2.8" rx="0.6" />
      <rect x="9" y="15.85" width="11" height="2.3" rx="1.15" />
    </svg>
  );
}

// Grouped: a feed header up top, a vertical spine, and two indented child rows
// branching off it — a one-level tree.
export function ListTree(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      width={24}
      height={24}
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <rect x="3.5" y="4.1" width="9" height="2.2" rx="1.1" />
      <rect x="5" y="6.3" width="1.4" height="11.4" rx="0.7" />
      <rect x="6.4" y="10.4" width="3" height="1.4" rx="0.7" />
      <rect x="10" y="9.7" width="10.5" height="2.2" rx="1.1" />
      <rect x="6.4" y="15.9" width="3" height="1.4" rx="0.7" />
      <rect x="10" y="15.2" width="10.5" height="2.2" rx="1.1" />
    </svg>
  );
}

// ---- Sort order: stacked digits + a direction arrow -----------------------

// The top toolbar's sort toggle reflects the *current* order, not both
// directions (SPEC.md *List toolbar*). Each glyph pairs a stacked digit column
// (left) with a direction arrow (right): `SortNewestFirst` reads 9→0 with a
// down arrow (descending), `SortOldestFirst` reads 0→9 with an up arrow
// (ascending) — the universal numeric-sort convention, and the two are exact
// vertical mirrors so the toggle is unmistakable. The tooltip / accessible
// name ("Newest first" / "Oldest first") stays authoritative.
// Arrows are stroked and weighted to ~2.2px so the glyph sits at the same
// visual weight as the list / tree icons instead of reading heaviest.

// Shared layout constants so the two mirror glyphs stay aligned.
const SORT_DIGIT_X = 6.25;
const SORT_DIGIT_TOP_Y = 10;
const SORT_DIGIT_BOTTOM_Y = 21.5;

export function SortNewestFirst(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={24}
      height={24}
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <text
        x={SORT_DIGIT_X}
        y={SORT_DIGIT_TOP_Y}
        textAnchor="middle"
        fontSize="11"
        fontWeight="700"
        fontFamily="system-ui, sans-serif"
        fill="currentColor"
      >
        9
      </text>
      <text
        x={SORT_DIGIT_X}
        y={SORT_DIGIT_BOTTOM_Y}
        textAnchor="middle"
        fontSize="11"
        fontWeight="700"
        fontFamily="system-ui, sans-serif"
        fill="currentColor"
      >
        0
      </text>
      <path
        d="M16.5 4.5V18M12.5 13L16.5 18L20.5 13"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SortOldestFirst(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={24}
      height={24}
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <text
        x={SORT_DIGIT_X}
        y={SORT_DIGIT_TOP_Y}
        textAnchor="middle"
        fontSize="11"
        fontWeight="700"
        fontFamily="system-ui, sans-serif"
        fill="currentColor"
      >
        0
      </text>
      <text
        x={SORT_DIGIT_X}
        y={SORT_DIGIT_BOTTOM_Y}
        textAnchor="middle"
        fontSize="11"
        fontWeight="700"
        fontFamily="system-ui, sans-serif"
        fill="currentColor"
      >
        9
      </text>
      <path
        d="M16.5 19.5V6M12.5 11L16.5 6L20.5 11"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ---- Drag handle (drag_indicator) -----------------------------------------

export function DragHandle(props: IconProps) {
  return (
    <MaterialIcon {...props}>
      <path d="M360-160q-33 0-56.5-23.5T280-240q0-33 23.5-56.5T360-320q33 0 56.5 23.5T440-240q0 33-23.5 56.5T360-160Zm240 0q-33 0-56.5-23.5T520-240q0-33 23.5-56.5T600-320q33 0 56.5 23.5T680-240q0 33-23.5 56.5T600-160ZM360-400q-33 0-56.5-23.5T280-480q0-33 23.5-56.5T360-560q33 0 56.5 23.5T440-480q0 33-23.5 56.5T360-400Zm240 0q-33 0-56.5-23.5T520-480q0-33 23.5-56.5T600-560q33 0 56.5 23.5T680-480q0 33-23.5 56.5T600-400ZM360-640q-33 0-56.5-23.5T280-720q0-33 23.5-56.5T360-800q33 0 56.5 23.5T440-720q0 33-23.5 56.5T360-640Zm240 0q-33 0-56.5-23.5T520-720q0-33 23.5-56.5T600-800q33 0 56.5 23.5T680-720q0 33-23.5 56.5T600-640Z" />
    </MaterialIcon>
  );
}

// ---- More (more_vert) -----------------------------------------------------

export function MoreVert(props: IconProps) {
  return (
    <MaterialIcon {...props}>
      <path d="M480-160q-33 0-56.5-23.5T400-240q0-33 23.5-56.5T480-320q33 0 56.5 23.5T560-240q0 33-23.5 56.5T480-160Zm0-240q-33 0-56.5-23.5T400-480q0-33 23.5-56.5T480-560q33 0 56.5 23.5T560-480q0 33-23.5 56.5T480-400Zm0-240q-33 0-56.5-23.5T400-720q0-33 23.5-56.5T480-800q33 0 56.5 23.5T560-720q0 33-23.5 56.5T480-640Z" />
    </MaterialIcon>
  );
}

// ---- Open in new ----------------------------------------------------------

export function OpenInNew(props: IconProps) {
  return (
    <MaterialIcon {...props}>
      <path d="M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h280v80H200v560h560v-280h80v280q0 33-23.5 56.5T760-120H200Zm188-212-56-56 372-372H560v-80h280v280h-80v-144L388-332Z" />
    </MaterialIcon>
  );
}

// ---- Share ----------------------------------------------------------------

export function Share(props: IconProps) {
  return (
    <MaterialIcon {...props}>
      <path d="M720-80q-50 0-85-35t-35-85q0-7 1-14.5t3-13.5L322-392q-17 15-38 23.5t-44 8.5q-50 0-85-35t-35-85q0-50 35-85t85-35q23 0 44 8.5t38 23.5l283-164q-2-6-3-13.5t-1-14.5q0-50 35-85t85-35q50 0 85 35t35 85q0 50-35 85t-85 35q-23 0-44-8.5T642-672L359-508q2 6 3 13.5t1 14.5q0 7-1 14.5t-3 13.5l283 164q17-15 38-23.5t44-8.5q50 0 85 35t35 85q0 50-35 85t-85 35Z" />
    </MaterialIcon>
  );
}

// ---- Refresh --------------------------------------------------------------

export function Refresh(props: IconProps) {
  return (
    <MaterialIcon {...props}>
      <path d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-820q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z" />
    </MaterialIcon>
  );
}

// ---- Close ----------------------------------------------------------------

export function Close(props: IconProps) {
  return (
    <MaterialIcon {...props}>
      <path d="M256-200l-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z" />
    </MaterialIcon>
  );
}

// ---- Settings -------------------------------------------------------------

export function Settings(props: IconProps) {
  return (
    <MaterialIcon {...props}>
      <path d="m370-80-16-128q-13-5-24.5-12T307-235l-119 50L78-375l103-78q-1-7-1-13.5v-27q0-6.5 1-13.5L78-585l110-190 119 50q11-8 23-15t24-12l16-128h220l16 128q13 5 24.5 12t22.5 16l119-50 110 190-103 78q1 7 1 13.5v27q0 6.5-2 13.5l103 78-110 190-118-50q-11 8-23 15t-24 12L590-80H370Zm112-260q58 0 99-41t41-99q0-58-41-99t-99-41q-59 0-99.5 41T342-480q0 58 40.5 99t99.5 41Z" />
    </MaterialIcon>
  );
}

// ---- Folder ---------------------------------------------------------------

export function Folder(props: IconProps) {
  return (
    <MaterialIcon {...props}>
      <path d="M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h240l80 80h320q33 0 56.5 23.5T880-640v400q0 33-23.5 56.5T800-160H160Zm0-80h640v-400H447l-80-80H160v480Zm0 0v-480 480Z" />
    </MaterialIcon>
  );
}

// ---- Add (subscribe / new feed) -------------------------------------------

export function Add(props: IconProps) {
  return (
    <MaterialIcon {...props}>
      <path d="M440-440H200v-80h240v-240h80v240h240v80H520v240h-80v-240Z" />
    </MaterialIcon>
  );
}

// ---- Theme: Sun (light_mode) ----------------------------------------------

export function Sun(props: IconProps) {
  return (
    <MaterialIcon {...props}>
      <path d="M480-360q50 0 85-35t35-85q0-50-35-85t-85-35q-50 0-85 35t-35 85q0 50 35 85t85 35Zm0 80q-83 0-141.5-58.5T280-480q0-83 58.5-141.5T480-680q83 0 141.5 58.5T680-480q0 83-58.5 141.5T480-280ZM200-440H40v-80h160v80Zm720 0H760v-80h160v80ZM440-760v-160h80v160h-80Zm0 720v-160h80v160h-80ZM256-650l-101-97 57-59 96 100-52 56Zm492 496-97-101 53-55 101 97-57 59Zm-98-550 97-101 59 57-100 96-56-52ZM154-212l101-97 55 53-97 101-59-57Z" />
    </MaterialIcon>
  );
}

// ---- Theme: Moon (dark_mode) ----------------------------------------------

export function Moon(props: IconProps) {
  return (
    <MaterialIcon {...props}>
      <path d="M480-120q-150 0-255-105T120-480q0-150 105-255t255-105q14 0 27.5 1t26.5 3q-41 29-65.5 75.5T444-660q0 90 63 153t153 63q55 0 101-24.5t75-65.5q2 13 3 26.5t1 27.5q0 150-105 255T480-120Zm0-80q88 0 158-48.5T740-375q-20 5-40 8t-40 3q-123 0-209.5-86.5T364-656q0-20 3-40t8-40q-78 32-126.5 102T200-480q0 116 82 198t198 82Zm-10-270Z" />
    </MaterialIcon>
  );
}

// ---- Theme: System (brightness_auto / contrast) ---------------------------

export function SystemTheme(props: IconProps) {
  return (
    <MaterialIcon {...props}>
      <path d="M480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80v-640q-133 0-226.5 93.5T160-480q0 133 93.5 226.5T480-160Z" />
    </MaterialIcon>
  );
}

// ---- Chevron right --------------------------------------------------------

export function ChevronRight(props: IconProps) {
  return (
    <MaterialIcon {...props}>
      <path d="M504-480 320-664l56-56 240 240-240 240-56-56 184-184Z" />
    </MaterialIcon>
  );
}

// ---- Brand mark -----------------------------------------------------------

// The Readmo app mark, inline. Mirrors public/favicon.svg: ink rounded-square
// tile, paper-white uppercase "R" centered slightly above the midline, and
// the paper-white home-indicator pill near the bottom edge. Defaults to 28px
// (sized to sit comfortably in the 56px header next to the wordmark); pass
// width/height to override.
export function BrandMark({
  width = 28,
  height = 28,
  ...rest
}: IconProps) {
  return (
    <svg
      viewBox="0 0 512 512"
      width={width}
      height={height}
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {/* Tile + letterform read from the palette tokens (CSS custom props only
          resolve via `style`, not the `fill` presentation attribute), so the
          mark follows the active palette — near-black ink by default, deep
          grape under Grape. Fallbacks keep it correct if rendered outside
          the app. */}
      <rect
        width="512"
        height="512"
        rx="96"
        style={{ fill: 'var(--rm-brand-tile, #1a1a1a)' }}
      />
      <text
        x="256"
        y="240"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
        fontWeight={700}
        fontSize={320}
        style={{ fill: 'var(--rm-brand-fg, #faf9f5)' }}
      >
        R
      </text>
      <rect
        x="176"
        y="400"
        width="160"
        height="12"
        rx="6"
        style={{ fill: 'var(--rm-brand-fg, #faf9f5)' }}
      />
    </svg>
  );
}
