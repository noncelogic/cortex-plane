# Stitch Design Exports

Machine-exported UI screens from [Google Stitch](https://stitch.withgoogle.com/) for the Cortex Plane dashboard.

## Directory Structure

```
design/stitch/
└── 9045951354463668716/          # Stitch project ID
    ├── screens.json              # Full screen manifest (all screens, sorted by ID)
    ├── ROUTES.md                 # Screen → app route mapping with rationale
    └── <screenId>/
        ├── meta.json             # Screen metadata (title, dimensions, asset URLs)
        ├── screen.html           # Exported HTML (via get_screen_code)
        └── screenshot.jpg        # Visual screenshot of the screen
```

## How to Refresh Exports

Prerequisites: `STITCH_API_KEY` must be set (already in `~/.bashrc`).

### 1. List all screens

```bash
npx @_davideast/stitch-mcp tool list_screens \
  -d '{"projectId":"9045951354463668716"}'
```

### 2. Export a single screen's HTML

```bash
npx @_davideast/stitch-mcp tool get_screen_code \
  -d '{"projectId":"9045951354463668716","screenId":"<SCREEN_ID>"}'
```

### 3. Full re-export

The export script at `/tmp/export_stitch_screens.py` can be re-run. It is idempotent — existing HTML and screenshots are skipped unless empty. To force a full refresh, delete the screen directories first.

Alternatively, have Claude Code run the export:

```
Implement issue #85: Export all Stitch screens for project 9045951354463668716
```

## How Engineers Should Use These Exports

1. **Route mapping** — Start with `ROUTES.md` in the project directory. It maps each app route (`/`, `/agents`, `/agents/:id`, etc.) to the best desktop and mobile screen IDs with rationale.

2. **Visual reference** — Open `screenshot.jpg` in any screen directory for a quick visual of the design. These are the ground truth for layout, spacing, and component placement.

3. **HTML reference** — Open `screen.html` in a browser for an interactive preview. Extract CSS variables, class names, and component structure from the HTML source. Note: these are standalone HTML files with inline styles, not production components.

4. **Metadata** — `meta.json` contains the screen title, dimensions, device type, and original asset URLs. Use this to understand the intended viewport size.

5. **screens.json** — The full manifest of all screens sorted by screen ID. Use this to discover screens not yet mapped to routes or to find alternate design iterations.

## Notes

- All screens are exported as `deviceType: "DESKTOP"` from Stitch, but titles with "(Mobile)" indicate mobile-intended designs. Check the screenshot to confirm the actual layout.
- Multiple screens may share similar titles (e.g., several "Control Plane Overview (Mobile)" variants). These are design iterations — `ROUTES.md` documents which to use and why.
- Screenshots are JPEGs downloaded from Google's CDN. They may expire — re-run the export if screenshots become unavailable.
- Do NOT commit `STITCH_API_KEY` or any authentication tokens.
