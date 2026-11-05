/**
 * The widget's default look. Everything hangs off a few CSS variables, so a site can restyle it
 * with `.my-class { --ob-accent: #0a7; }` or switch this sheet off with `unstyled` and write its own
 * against the `ob-*` class names and `data-ob-*` attributes.
 */
export const WIDGET_CSS = `
.ob-widget{--ob-accent:#2457d6;--ob-on-accent:#fff;--ob-fg:#1a1a1a;--ob-muted:#5c6370;--ob-bg:#fff;--ob-border:#d0d5dd;--ob-error:#b42318;--ob-radius:8px;--ob-font:inherit;
  box-sizing:border-box;max-width:32rem;padding:1rem;color:var(--ob-fg);background:var(--ob-bg);border:1px solid var(--ob-border);border-radius:var(--ob-radius);font-family:var(--ob-font);line-height:1.4}
.ob-widget *{box-sizing:border-box}
.ob-widget h2{margin:0 0 .25rem;font-size:1.25rem}
.ob-widget h3{margin:1rem 0 .5rem;font-size:1rem}
.ob-widget p{margin:.25rem 0}
.ob-muted{color:var(--ob-muted);font-size:.9em}
.ob-field{display:block;margin:.5rem 0}
.ob-field>span{display:block;font-size:.9em;margin-bottom:.2rem}
.ob-widget input:not([type=checkbox]),.ob-widget select,.ob-widget textarea{width:100%;padding:.5rem;font:inherit;color:inherit;background:var(--ob-bg);border:1px solid var(--ob-border);border-radius:calc(var(--ob-radius) - 2px)}
.ob-widget :focus-visible{outline:2px solid var(--ob-accent);outline-offset:2px}
.ob-slots{list-style:none;margin:.5rem 0;padding:0;display:flex;flex-wrap:wrap;gap:.5rem}
.ob-slot{padding:.5rem .75rem;font:inherit;color:var(--ob-fg);background:var(--ob-bg);border:1px solid var(--ob-border);border-radius:calc(var(--ob-radius) - 2px);cursor:pointer}
.ob-slot[aria-pressed=true]{border-color:var(--ob-accent);box-shadow:0 0 0 1px var(--ob-accent)}
.ob-slot:disabled{opacity:.6;cursor:default}
.ob-button{padding:.6rem 1rem;font:inherit;font-weight:600;color:var(--ob-on-accent);background:var(--ob-accent);border:0;border-radius:calc(var(--ob-radius) - 2px);cursor:pointer}
.ob-button:disabled{opacity:.5;cursor:not-allowed}
.ob-link-button{padding:0;font:inherit;color:var(--ob-accent);background:none;border:0;text-decoration:underline;cursor:pointer}
.ob-terms{margin:.75rem 0;padding:.75rem;background:rgba(127,127,127,.08);border-radius:calc(var(--ob-radius) - 2px)}
.ob-consent{display:flex;gap:.5rem;align-items:flex-start;margin:.75rem 0}
.ob-error{margin:.5rem 0;padding:.5rem .75rem;color:var(--ob-error);border:1px solid var(--ob-error);border-radius:calc(var(--ob-radius) - 2px)}
.ob-code{font-family:ui-monospace,monospace;font-size:1.25rem;letter-spacing:.05em}
`;
