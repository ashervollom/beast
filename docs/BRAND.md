# Beast brand guide

Hand-drawn, warm, confident. Beast feels like a doodle in the margin of your notebook, drawn by a friend who has his life together. Never glossy, never corporate.

## Logo
- `beast-logo.svg`: primary mark. Double-loop doodle head, small devil-style horns, eyes only. Graphite on transparent.
- `beast-logo-cream.svg`: same mark in cream, for dark backgrounds.
- `beast-contact-photo.svg`: warm paper square with grain, for the iMessage contact photo and app icon. Export to PNG at 1024x1024.
- Keep the slight -3 degree tilt. Don't recolor the mark except graphite or cream. Don't add drop shadows, gradients, or outlines.
- Minimum size: 24px. Below that, use the mark without the second sketch stroke if needed.

## Colors
| Token | Hex | Use |
|---|---|---|
| paper | #F1E7D6 | Main background everywhere |
| paper-deep | #E7DCC8 | Cards, inputs, hover states |
| graphite | #2A2A2A | Text, icons, strokes, the logo |
| pencil | #6B6358 | Secondary text, captions, borders |
| flame | #FF7A2F | Accent: primary buttons, overdue, big moments (use sparingly) |
| flame-glow | #FFC23D | Highlights, success, "done" moments |

Paper gets a subtle grain overlay (SVG feTurbulence fractal noise, grayscale, about 8% opacity). No pure white, no pure black.

## Type
- Wordmark: "beast" in lowercase, Gaegu Bold (Google Fonts). Logo and splash moments only, never body text.
- Headings: Gaegu Bold or Shantell Sans SemiBold for section titles.
- Body and UI: a clean readable sans (e.g. DM Sans or Nunito). Readability first; the hand-drawn feel comes from the logo, icons, and illustrations, not the body font.

## Illustration style
- Single-weight graphite strokes (about 4 to 5px at 200px scale), round caps and joins, slightly wobbly lines.
- A faint second "sketch" stroke on some edges.
- Icons are doodles in the same style: notebook, pencil, calculator, lab flask, alarm clock.
- Flames are translucent orange and yellow tongues with a soft graphite outline.

## Motion
- Idle: the logo gently bobs (6px up and down, 1.6s, ease-in-out).
- Loading screen (between landing page and sign in / sign up): doodle school icons pop in one at a time with a soft bounce (notebook, pencil, calculator, flask, clock), then the "beast" wordmark bounces in and translucent flames rise from below it like a stove burner under a pot, flicker for about 2.5s, and loop.
- Always respect prefers-reduced-motion: show the final state with no animation.
