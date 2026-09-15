# Windows host spacing

Use the shared `HostSpacing` defaults in the WinUI host unless a specific design
requires an exception. Dimensions are effective pixels, not physical pixels.

- Page gutters: 24.
- Card insets and section gaps: 16.
- Content row vertical insets: 12.
- Related controls: 8; label/metadata gaps: 4.
- Keep native control template padding. Add content insets only where needed;
  do not stack outer card padding with full row padding.
- Grouped settings: an unpadded card with individually padded rows and separators.
- Display maps: size the container to the arrangement; the card supplies its
  inset. Do not shrink monitors within a fixed, oversized canvas.
- Collapse responsive row gaps when the secondary row is unused.

These are VidVNC defaults following Microsoft's four-effective-pixel spacing
guidance, not a claim that every WinUI control uses one padding value:
https://learn.microsoft.com/en-us/windows/apps/develop/ui/alignment-margin-padding
