// CSS copied VERBATIM from Axle FS Constellations.html
// DO NOT modify the reference classes — only the app-chrome section at the bottom is custom.
export const CONSTELLATION_CSS = `
:root{
  --lime:#c9ff2e;--orange:#ff6a1a;--pink:#ff2f86;--cyan:#33ffe0;--purp:#9b8cff;--grn:#7adf9b;
  --ink:#0a0a0c;--cream:#f3eee2;--dim:rgba(243,238,226,.55);--dimmer:rgba(243,238,226,.3);
  --faint:rgba(243,238,226,.16);--line:rgba(243,238,226,.12);
  --mono:"Space Mono",monospace;--disp:"Anton",sans-serif;
}
*{box-sizing:border-box;}

/* ── FRAME (verbatim from reference) ─────────────────────────────────────── */
.gc{
  position:fixed;inset:0;
  width:100%;height:100%;overflow:hidden;color:var(--cream);
  font-family:var(--mono);-webkit-font-smoothing:antialiased;
  background:radial-gradient(130% 100% at 50% 42%, #16161a 0%, #0c0c0e 58%, #060607 100%);
}
.gc::after{
  content:"";position:absolute;inset:0;pointer-events:none;opacity:.09;z-index:60;
  background:repeating-linear-gradient(0deg,rgba(0,0,0,.6) 0 1px,transparent 1px 3px);
}
.gc-grid{
  position:absolute;inset:0;z-index:0;opacity:.45;pointer-events:none;
  background-image:
    linear-gradient(rgba(243,238,226,.03) 1px,transparent 1px),
    linear-gradient(90deg,rgba(243,238,226,.03) 1px,transparent 1px);
  background-size:30px 30px;
  -webkit-mask:radial-gradient(110% 95% at 50% 45%,#000 50%,transparent 100%);
          mask:radial-gradient(110% 95% at 50% 45%,#000 50%,transparent 100%);
}

/* ── SVG LAYER (verbatim strokes from spec §4) ────────────────────────────── */
.gc-svg{position:absolute;inset:0;z-index:1;pointer-events:none;overflow:visible;}
.teth{stroke:var(--faint);stroke-width:1;}
.teth.f{stroke:rgba(201,255,46,.5);stroke-width:1.4;}
.teth.dotted{stroke-dasharray:1 5;opacity:.7;}
.teth.dim{stroke:rgba(243,238,226,.25);stroke-dasharray:2 6;}
/* Geometric-center crosshair + drift tether — drawn only when unbalanced (§2) */
.gc-cross{stroke:rgba(243,238,226,.3);stroke-width:1;stroke-dasharray:3 3;}
.gc-drift{stroke:rgba(201,255,46,.22);stroke-width:1;stroke-dasharray:2 5;}

/* ── ACTIVE WINDOW (verbatim) ─────────────────────────────────────────────── */
.win{
  position:absolute;z-index:5;
  background:linear-gradient(180deg,rgba(22,22,26,.97),rgba(13,13,16,.97));
  border:1px solid var(--line);border-radius:13px;overflow:hidden;
  transform:translate(-50%,-50%);
}
.win.focus{
  border-color:var(--lime);
  box-shadow:0 0 0 1px rgba(201,255,46,.45),0 16px 40px rgba(0,0,0,.55),0 0 30px rgba(201,255,46,.16);
}
/* Bottom-anchored variant — popup hangs above its (x,y) point */
.win.above{transform:translate(-50%,-100%);}
.win-tab{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--line);cursor:grab;user-select:none;}
.win-tab:active{cursor:grabbing;}
.win-dot{width:7px;height:7px;border-radius:50%;background:var(--lime);box-shadow:0 0 8px var(--lime);flex:none;}
.win-name{font-size:11.5px;letter-spacing:.02em;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.win-verb{font-size:9.5px;color:var(--lime);display:flex;align-items:center;gap:5px;flex:none;}
.win-verb .sp{width:8px;height:8px;border:1.5px solid var(--lime);border-top-color:transparent;border-radius:50%;animation:gspin .8s linear infinite;}
@keyframes gspin{to{transform:rotate(360deg)}}
.win-body{padding:9px 12px;font-size:10.5px;line-height:1.65;max-height:70px;overflow:hidden;}
/* PTY-mode body: xterm fills the whole pane; no padding (xterm draws its own
   margins) and a tighter min-height so the terminal isn't crushed when the
   window starts at default SWIN_TAB_H. */
.win-body-pty{padding:0;max-height:none;min-height:140px;overflow:hidden;background:#0a0a12;}
.win-body-pty .pty-host{width:100%;height:100%;}
/* Flex layout — activated when the window has an explicit height (prop or resize) */
.win.win-flex{display:flex;flex-direction:column;}
.win.win-flex .win-body{flex:1;max-height:none;overflow-y:auto;}
.win.win-flex .win-prompt{flex:none;}
/* Resize frame — sibling of .win (outside overflow:hidden), centered on the
   same point and 12px larger so its handles straddle the window border.
   The frame itself is inert; only the 8 handles take pointer events. */
.win-frame{position:absolute;transform:translate(-50%,-50%);z-index:26;pointer-events:none;}
.rz{position:absolute;pointer-events:auto;touch-action:none;}
.rz-n{top:0;left:18px;right:18px;height:10px;cursor:ns-resize;}
.rz-s{bottom:0;left:18px;right:18px;height:10px;cursor:ns-resize;}
.rz-e{right:0;top:18px;bottom:18px;width:10px;cursor:ew-resize;}
.rz-w{left:0;top:18px;bottom:18px;width:10px;cursor:ew-resize;}
.rz-ne{top:0;right:0;width:18px;height:18px;cursor:nesw-resize;}
.rz-sw{bottom:0;left:0;width:18px;height:18px;cursor:nesw-resize;}
.rz-nw{top:0;left:0;width:18px;height:18px;cursor:nwse-resize;}
.rz-se{bottom:0;right:0;width:18px;height:18px;cursor:nwse-resize;}
/* Visible affordance: corner L at the bottom-right, just inside the window */
.rz-se::after{
  content:'';position:absolute;right:9px;bottom:9px;
  width:9px;height:9px;
  border-right:2px solid rgba(243,238,226,.5);
  border-bottom:2px solid rgba(243,238,226,.5);
  border-radius:0 0 3px 0;
}
.rz-se:hover::after{border-color:var(--lime);box-shadow:1px 1px 8px rgba(201,255,46,.5);}
/* Terminal prompt bar */
.win-prompt{display:flex;align-items:center;gap:5px;padding:6px 10px;border-top:1px solid var(--line);}
.win-prompt-in{flex:1;background:none;border:none;outline:none;color:var(--cream);
  font-family:var(--mono);font-size:10.5px;caret-color:var(--lime);min-width:0;}
.win-prompt-in::placeholder{color:var(--dimmer);}
/* Mini orb queue button — approximates the orb's visual style */
.win-orb-btn{
  width:16px;height:16px;flex:none;padding:0;border-radius:50%;cursor:pointer;
  border:1px solid rgba(201,255,46,.4);
  background:radial-gradient(circle at 42% 36%,rgba(201,255,46,.22) 0%,rgba(201,255,46,.07) 48%,transparent 72%);
  transition:box-shadow .15s ease,border-color .15s ease;
}
.win-orb-btn:hover{border-color:var(--lime);box-shadow:0 0 10px rgba(201,255,46,.45);}
.win-orb-btn.queued{
  border-color:var(--lime);
  background:radial-gradient(circle at 42% 36%,rgba(201,255,46,.45) 0%,rgba(201,255,46,.14) 48%,transparent 72%);
  animation:orb-q-pulse 1.5s ease-in-out infinite;
}
@keyframes orb-q-pulse{
  0%,100%{box-shadow:0 0 5px rgba(201,255,46,.4);}
  50%{box-shadow:0 0 14px rgba(201,255,46,.75);}
}
/* Send button in terminal prompt */
.win-send-btn{width:22px;height:20px;flex:none;border-radius:5px;
  background:rgba(243,238,226,.08);border:1px solid rgba(243,238,226,.14);
  color:var(--dim);font-size:11px;cursor:pointer;font-family:var(--mono);
  display:grid;place-items:center;}
.win-send-btn:hover{background:var(--lime);border-color:var(--lime);color:var(--ink);}
/* Tool-permission approval prompt (in terminals + main-session overlay) */
.perm-prompt{display:flex;flex-direction:column;gap:4px;padding:6px 10px;
  border-top:1px solid var(--line);background:rgba(255,106,26,.07);}
.perm-head{font-family:var(--mono);font-size:9.5px;color:var(--dim);
  text-transform:uppercase;letter-spacing:.06em;}
.perm-head b{color:#ff6a1a;font-weight:700;}
.perm-detail{font-family:var(--mono);font-size:10px;color:var(--cream);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.perm-actions{display:flex;gap:6px;}
.perm-btn{flex:1;padding:3px 0;border-radius:5px;cursor:pointer;
  font-family:var(--mono);font-size:10px;
  background:rgba(243,238,226,.08);border:1px solid rgba(243,238,226,.14);color:var(--dim);}
.perm-btn.allow:hover{background:var(--lime);border-color:var(--lime);color:var(--ink);}
.perm-btn.deny:hover{background:#ff2f3a;border-color:#ff2f3a;color:var(--ink);}
.perm-more{font-family:var(--mono);font-size:9px;color:var(--dimmer);
  background:none;border:none;cursor:pointer;padding:2px 0;text-align:left;}
.perm-more:hover{color:var(--cream);}
.perm-queue{list-style:none;margin:4px 0 0;padding:4px 0 0;border-top:1px dashed var(--line);
  display:flex;flex-direction:column;gap:3px;max-height:160px;overflow-y:auto;}
.perm-queue li{display:flex;gap:8px;font-family:var(--mono);font-size:9.5px;line-height:1.3;}
.perm-q-tool{color:#ff6a1a;font-weight:600;flex:none;}
.perm-q-detail{color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;}
/* Main-session permission overlay — sits above the chat dock */
.perm-overlay{position:absolute;left:50%;transform:translateX(-50%);bottom:96px;
  width:min(420px,calc(100vw - 32px));z-index:60;display:flex;flex-direction:column;gap:6px;}
.perm-overlay .perm-prompt{border:1px solid var(--line);border-radius:8px;
  background:rgba(20,18,14,.92);backdrop-filter:blur(6px);}
.gl{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
/* Terminal window: wrap response lines so resizing the window reveals them */
.win.win-flex .win-body .gl{white-space:pre-wrap;word-break:break-word;overflow:visible;text-overflow:clip;}
.g-axle{color:var(--cyan);} .g-out{color:var(--cream);} .g-sys{color:var(--dim);}
.g-ok{color:var(--lime);font-weight:700;} .g-you{color:var(--lime);}
.gcur{color:var(--lime);animation:gbl 1s steps(1) infinite;}
@keyframes gbl{50%{opacity:0}}

/* ── FILE STAR DIAMOND (verbatim) ─────────────────────────────────────────── */
.fstar{position:absolute;z-index:3;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;gap:7px;opacity:.8;}
/* Files on the upper half of a band flip the label ABOVE the glyph so the
   name extends OUTWARD into open sky instead of inward across the ring. */
.fstar.lab-up{flex-direction:column-reverse;}
.fstar i{width:8px;height:8px;transform:rotate(45deg);display:block;flex:none;}
.fstar .t{font-size:8.5px;color:var(--dimmer);letter-spacing:.04em;white-space:nowrap;}
.fstar.dim{opacity:.4;}

/* ── TOOL DOTS (verbatim) ─────────────────────────────────────────────────── */
.tdot{position:absolute;z-index:4;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;gap:5px;opacity:.6;}
.tdot .c{width:26px;height:26px;border-radius:50%;border:1px solid var(--line);display:grid;place-items:center;
  font-size:8px;letter-spacing:.04em;color:var(--dim);background:rgba(20,20,24,.8);}
.tdot .t{font-size:8.5px;color:var(--dimmer);letter-spacing:.08em;}
.tdot.lit{opacity:1;} .tdot.lit .c{border-color:var(--cyan);color:var(--cyan);box-shadow:0 0 12px rgba(51,255,224,.3);}

/* ── ORB HOST (verbatim) ──────────────────────────────────────────────────── */
.orb-host{
  position:absolute;z-index:8;transform:translate(-50%,-50%);
  display:grid;place-items:center;
  pointer-events:none;
  filter:drop-shadow(0 0 26px rgba(201,255,46,.12));
}
.orb-host.tap{pointer-events:auto;cursor:pointer;}

/* ── STAR SYSTEM — ring + on-rim orbiters ────────────────────────────────────
   Position/size/open-ness come from the engine every frame (spec §3) — no CSS
   position transitions here. The engine also spins every dot layer in sync via
   one --orbit-rot variable set on .gc.                                          */
.syst{position:absolute;z-index:4;transform:translate(-50%,-50%);pointer-events:none;}
.sys-body{position:absolute;inset:0;}
.syst .rim{position:absolute;inset:0;border:1.5px dashed rgba(243,238,226,.28);border-radius:50%;pointer-events:auto;cursor:pointer;}
/* Transparent annulus around the rim that keeps :hover true once the bloom
   pushes orbiters past the resting ring. Sized to swallow the worst-case
   bloomed orbit (large rings reach +0.38r, small rings reach +1r). z-index:0
   keeps it below the rim, dots and close button — its only job is hover. */
.syst .hover-pad{position:absolute;inset:-44px;border-radius:50%;
  background:transparent;pointer-events:auto;z-index:0;}
.syst.syst-sm .hover-pad{inset:-56px;}

/* The resting/traveling seed dot — fades out as the ring opens (spec §3) */
.sys-seed{position:absolute;width:14px;height:14px;border-radius:50%;transform:translate(-50%,-50%);pointer-events:none;}

/* .olayer-scale: hover-expand wrapper — dots widen into a larger orbit */
.syst .olayer-scale{position:absolute;inset:0;transform-origin:50% 50%;transition:transform .35s cubic-bezier(.2,.9,.25,1);pointer-events:none;}
.syst:hover .olayer-scale{transform:scale(1.25);}
/* .olayer: engine-driven spin; .ctr counter-rotates so labels stay upright */
.syst .olayer{position:absolute;inset:0;pointer-events:none;transform:rotate(var(--orbit-rot,0deg));}
.syst .orbiter{position:absolute;transform:translate(-50%,-50%);cursor:pointer;pointer-events:auto;}
.syst .orbiter .ctr{display:flex;flex-direction:column;align-items:center;gap:4px;transform:rotate(calc(-1 * var(--orbit-rot,0deg)));}
.syst .orbiter i{width:14px;height:14px;border-radius:50%;display:block;}
.syst .orbiter .t{font-size:8px;color:var(--dim);letter-spacing:.04em;white-space:nowrap;opacity:.75;transition:opacity .15s ease;}
.syst:hover .orbiter .t{opacity:1;color:var(--cream);}
.syst .spath{position:absolute;transform:translateX(-50%);text-align:center;z-index:3;}
.syst .spath .p{font-size:11px;color:var(--cream);letter-spacing:.03em;white-space:nowrap;}
.syst .spath .s{font-size:8.5px;color:var(--dimmer);letter-spacing:.08em;margin-top:2px;white-space:nowrap;}
.fstar .t.sm{font-size:7.5px;}

/* Small rings (light/shrunk branches): quiet by default — labels hidden, dots
   tight on the rim. Hover blooms the orbit wider and reveals the names. */
.syst.syst-sm .spath .p{font-size:9px;color:var(--dim);}
.syst.syst-sm .spath .s{display:none;}
.syst.syst-sm .fstar .t{display:none;}
.syst.syst-sm .olayer-scale{opacity:.65;}
.syst.syst-sm .orbiter .t{opacity:0;}
.syst.syst-sm:hover .olayer-scale{opacity:1;transform:scale(1.6);}
.syst.syst-sm:hover .orbiter .t{opacity:1;}

/* Close button on child rings — visible on ring hover */
.syst-close{
  position:absolute;z-index:6;
  width:18px;height:18px;border-radius:50%;
  background:rgba(20,20,24,.8);border:1px solid rgba(243,238,226,.18);
  color:var(--dimmer);font-size:12px;line-height:1;
  display:grid;place-items:center;cursor:pointer;
  transform:translate(-50%,-50%);
  opacity:0;transition:opacity .2s ease;
  pointer-events:auto;
}
.syst:hover .syst-close{opacity:1;}
.syst-close:hover{border-color:var(--pink);color:var(--pink);}

/* Queue-pending badge — bottom-right of the system box. Always visible (no
   hover gate) so the user notices pending sub-agent requests without having
   to hunt for the dir. Color is the sender dir's file-cloud tint. */
.syst-queue-badge{
  position:absolute;z-index:7;
  min-width:18px;height:18px;padding:0 5px;border-radius:9px;
  font-size:10px;font-weight:600;line-height:18px;text-align:center;
  transform:translate(-50%,-50%);
  pointer-events:auto;cursor:default;
  animation:syst-queue-pulse 1.6s ease-in-out infinite;
}
@keyframes syst-queue-pulse{
  0%,100%{transform:translate(-50%,-50%) scale(1);   filter:brightness(1);}
  50%    {transform:translate(-50%,-50%) scale(1.12);filter:brightness(1.25);}
}

/* ── CHAT DOCK — replaces .gdock from reference mobile section ────────────── */
.gdock{position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:30;width:min(580px,calc(100% - 24px));}
.gdock-hist{display:flex;flex-direction:column;gap:3px;margin-bottom:8px;max-height:58px;overflow:hidden;
  -webkit-mask:linear-gradient(0deg,#000 40%,transparent 100%);mask:linear-gradient(0deg,#000 40%,transparent 100%);}
.gdock-hist .h{font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.gdock-hist .h.user{color:var(--lime);} .gdock-hist .h.axle{color:var(--cyan);}
.gdock-in{display:flex;align-items:center;gap:10px;background:rgba(16,16,20,.88);border:1px solid var(--line);
  border-radius:11px;padding:11px 14px;backdrop-filter:blur(4px);}
.gdock-in .you{color:var(--lime);font-size:11px;flex:none;}
.gdock-in .ph{flex:1;background:none;border:none;outline:none;color:var(--cream);
  font-family:var(--mono);font-size:11.5px;caret-color:var(--lime);}
.gdock-in .ph::placeholder{color:var(--dimmer);}
.gdock-in .snd{width:26px;height:23px;border-radius:6px;background:rgba(243,238,226,.08);
  border:1px solid rgba(243,238,226,.14);display:grid;place-items:center;
  color:var(--dim);font-size:11px;cursor:pointer;font-family:var(--mono);}
.gdock-in .snd:hover{background:var(--lime);border-color:var(--lime);color:var(--ink);}

/* ── EXPANDED VIEW — fullscreen chat + agents dashboard ───────────────────── */
.ax-expand-scrim{position:fixed;inset:0;z-index:70;background:rgba(6,6,7,.7);backdrop-filter:blur(3px);animation:ax-fade .2s ease-out;}
.ax-expand{position:fixed;inset:14px;z-index:71;display:flex;flex-direction:column;overflow:hidden;
  background:linear-gradient(180deg,rgba(16,16,20,.98),rgba(10,10,13,.98));
  border:1px solid var(--line);border-radius:14px;
  animation:ax-pop .22s cubic-bezier(.2,.7,.3,1);}
@keyframes ax-pop{from{opacity:0;transform:scale(.98)}to{opacity:1;transform:scale(1)}}
.ax-expand-head{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--line2);flex:none;}
.ax-expand-title{font-family:"Anton",Impact,sans-serif;font-size:20px;letter-spacing:.16em;color:var(--cream);flex:1;}
.ax-expand-empty{color:var(--dimmer);font-size:11px;letter-spacing:.08em;padding:20px;text-align:center;}
/* Chat mode — full history, readable column */
.ax-expand-chat{flex:1;overflow-y:auto;padding:18px clamp(16px,10vw,160px);display:flex;flex-direction:column;gap:12px;}
.ax-expand-chat .m{font-size:13px;line-height:1.7;white-space:pre-wrap;word-break:break-word;color:var(--cream);}
.ax-expand-chat .m strong{display:block;font-size:9.5px;letter-spacing:.18em;text-transform:uppercase;margin-bottom:2px;}
.ax-expand-chat .m.user{color:var(--lime);}
.ax-expand-chat .m.axle strong{color:var(--cyan);}
.ax-expand-foot{flex:none;padding:12px clamp(16px,10vw,160px) 14px;border-top:1px solid var(--line2);}
/* Dashboard mode — one tile per live agent session */
.ax-dash{flex:1;overflow-y:auto;padding:16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px;align-content:start;}
.ax-dash-tile{display:flex;flex-direction:column;height:300px;
  background:linear-gradient(180deg,rgba(22,22,26,.97),rgba(13,13,16,.97));
  border:1px solid var(--line);border-radius:13px;overflow:hidden;}
.ax-dash-tile.main{border-color:rgba(201,255,46,.35);}
.ax-dash-tile .win-tab{cursor:default;}
.ax-dash-body{flex:1;overflow-y:auto;padding:9px 12px;font-size:11px;line-height:1.65;}
.ax-dash-body .gl{white-space:pre-wrap;overflow:visible;text-overflow:clip;}

/* ── SETTINGS PANEL (verbatim from networkStyles.ts — needed by SettingsPanel) ─ */
:root{ --line2:rgba(243,238,226,.06); }
.ax-settings-scrim{position:fixed;inset:0;z-index:80;background:rgba(6,6,7,.55);backdrop-filter:blur(2px);animation:ax-fade .2s ease-out;}
@keyframes ax-fade{from{opacity:0}to{opacity:1}}
.ax-settings{position:fixed;top:0;right:0;bottom:0;z-index:81;width:min(420px,100vw);
  background:linear-gradient(180deg,#101014 0%,#0a0a0c 100%);border-left:1px solid var(--line);
  display:flex;flex-direction:column;overflow-y:auto;
  animation:ax-slidein .25s cubic-bezier(.2,.7,.3,1);
  padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);padding-right:env(safe-area-inset-right);}
@keyframes ax-slidein{from{transform:translateX(100%)}to{transform:translateX(0)}}
.ax-settings-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--line2);flex-shrink:0;}
.ax-settings-title{font-family:"Anton",Impact,sans-serif;font-size:22px;letter-spacing:.16em;color:var(--cream);}
.ax-settings-close{background:transparent;border:1px solid var(--line);border-radius:6px;width:32px;height:32px;color:var(--dim);cursor:pointer;font-size:14px;}
.ax-settings-close:hover{color:var(--cream);}
.ax-settings-section{padding:16px 18px;border-bottom:1px solid var(--line2);display:flex;flex-direction:column;gap:.55rem;}
.ax-settings-section h5{font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--lime);font-weight:600;margin-bottom:.25rem;}
.ax-settings-label{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--dimmer);margin-top:.3rem;}
.ax-settings-hint{font-size:11px;color:var(--dim);line-height:1.55;}
.ax-settings-hint code,.ax-code{display:inline-block;background:#08080a;border:1px solid var(--line2);border-radius:4px;padding:2px 6px;font-size:10.5px;color:var(--cyan);word-break:break-all;}
.ax-code{display:block;padding:8px 10px;line-height:1.5;}
.ax-settings-input{background:#08080a;border:1px solid var(--line);border-radius:6px;padding:9px 11px;min-height:38px;color:var(--cream);font-family:var(--mono);font-size:12px;width:100%;}
.ax-settings-input.compact{min-height:34px;padding:7px 9px;font-size:11px;}
.ax-settings-input:focus{outline:none;border-color:var(--lime);}
.ax-settings-btn{background:#15151a;border:1px solid var(--line);border-radius:6px;padding:8px 14px;cursor:pointer;color:var(--cream);font-family:var(--mono);font-size:11px;letter-spacing:.06em;min-height:36px;}
.ax-settings-btn:hover{border-color:rgba(243,238,226,.3);}
.ax-settings-btn.primary{border-color:var(--lime);color:var(--lime);}
.ax-settings-btn.primary:hover{background:rgba(201,255,46,.08);}
.ax-settings-btn.ghost{background:transparent;color:var(--dim);}
.ax-settings-btn:disabled{opacity:.4;cursor:not-allowed;}
.ax-settings-link{font-size:11px;color:var(--cyan);word-break:break-all;text-decoration:none;padding:6px 0;}
.ax-settings-link:hover{text-decoration:underline;}
.ax-key-row{display:grid;grid-template-columns:1fr;gap:.35rem;padding:.5rem 0;border-top:1px solid var(--line2);}
.ax-key-row:first-of-type{border-top:none;}
.ax-key-name{font-size:11px;color:var(--cream);text-transform:capitalize;}
.ax-key-status{font-size:10px;}
.ax-key-status .set{color:var(--lime);letter-spacing:.06em;}
.ax-key-status .unset{color:var(--dimmer);letter-spacing:.1em;text-transform:uppercase;}
.ax-key-actions{display:flex;gap:.4rem;align-items:center;}
.ax-key-actions .ax-settings-input{flex:1;}
.ax-settings-foot{padding:12px 18px;font-size:9px;letter-spacing:.32em;text-transform:uppercase;color:var(--dimmer);flex-shrink:0;}
.ax-voice-switch{display:flex;flex-wrap:wrap;gap:.35rem;align-items:center;}
.ax-voice-btn{background:transparent;border:1px solid var(--line);border-radius:999px;padding:5px 10px;font-family:var(--mono);font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--dim);cursor:pointer;min-height:32px;}
.ax-voice-btn.is-active{color:var(--ink);background:var(--lime);border-color:var(--lime);}

/* ── APP CHROME (minimal additions, not in reference) ─────────────────────── */
.ax-topbar{
  position:fixed;top:0;left:0;right:0;z-index:40;
  display:flex;align-items:center;justify-content:space-between;
  padding:calc(15px + env(safe-area-inset-top)) calc(22px + env(safe-area-inset-right)) 0 calc(22px + env(safe-area-inset-left));
  pointer-events:none;
}
.ax-brand{display:flex;align-items:baseline;gap:10px;pointer-events:auto;}
.ax-logo{font-family:var(--disp);font-size:22px;letter-spacing:.04em;color:var(--cream);}
.ax-tag{font-size:9px;letter-spacing:.22em;color:var(--dimmer);text-transform:uppercase;}
.ax-gear{
  width:28px;height:28px;border:1px solid var(--line);border-radius:50%;
  display:grid;place-items:center;color:var(--dim);font-size:12px;
  cursor:pointer;pointer-events:auto;background:rgba(20,20,24,.7);
}
.ax-gear:hover{border-color:rgba(243,238,226,.35);color:var(--cream);}
.ax-status{position:fixed;top:calc(54px + env(safe-area-inset-top));left:50%;transform:translateX(-50%);z-index:40;
  font-size:10px;letter-spacing:.1em;color:var(--orange);pointer-events:none;}
.ax-transcript{position:fixed;bottom:100px;left:50%;transform:translateX(-50%);z-index:40;
  font-size:12px;line-height:1.5;color:var(--cream);background:rgba(12,12,14,.7);
  border:1px solid rgba(201,255,46,.3);border-radius:8px;padding:8px 13px;
  white-space:pre-wrap;word-break:break-word;max-width:380px;max-height:88px;
  overflow:hidden;pointer-events:none;}

/* ── FILE ORBITALS + POPUP EDITOR (spec §3.6) ─────────────────────────────── */
.gc-band{fill:none;stroke-width:1;stroke-opacity:.14;stroke-dasharray:2 6;}
/* File layer blooms outward on ring hover — same gesture as the orbiter dots.
   Spread is COORDINATED: dirs (olayer) bloom past the outermost file band
   (0.85r × file-scale < 1 × dir-scale) so the two layers never cross. */
.syst .flayer{position:absolute;inset:0;transform-origin:50% 50%;
  transition:transform .35s cubic-bezier(.2,.9,.25,1);pointer-events:none;}
.syst:hover .flayer{transform:scale(1.22);}
.syst:hover .olayer-scale{transform:scale(1.38);}
.syst.syst-sm:hover .flayer{transform:scale(1.7);}
.syst.syst-sm:hover .olayer-scale{transform:scale(2.0);}
/* Dir dots ride ABOVE resting file diamonds — orbit rotation must never get
   click-blocked by the outer file band */
.syst .orbiter{z-index:4;}
.syst.syst-sm:hover .fstar .t{display:block;}
.syst:hover .fstar{opacity:1;}
.syst:hover .fstar .t{color:var(--cream);opacity:1;}
.fstar.click{pointer-events:auto;cursor:pointer;}
.fstar i{transition:transform .15s ease, filter .15s ease;}
/* Hovering a specific file: foreground + glow, name highlighted on a chip */
.fstar.click:hover{opacity:1;z-index:6;}
.fstar.click:hover i{transform:rotate(45deg) scale(1.8);
  filter:brightness(1.25) drop-shadow(0 0 9px rgba(255,255,255,.45));}
.fstar.click:hover .t{color:var(--lime);opacity:1;background:rgba(8,8,10,.92);
  border:1px solid rgba(201,255,46,.4);border-radius:5px;padding:2px 6px;}
/* Small tappable core — the 64px orb visual must not swallow file clicks */
.orb-tap{position:absolute;left:50%;top:50%;width:30px;height:30px;border-radius:50%;
  transform:translate(-50%,-50%);pointer-events:auto;cursor:pointer;}
.fstar.fopen{opacity:1;}
.fstar.fopen i{outline:1.5px solid var(--lime);outline-offset:2px;}
.fdirty{display:inline-block;width:5px;height:5px;border-radius:50%;background:var(--orange);
  box-shadow:0 0 5px var(--orange);margin-left:4px;}
.teth.file{stroke:rgba(201,255,46,.45);stroke-dasharray:3 4;stroke-width:1;}
.fwin{display:flex;flex-direction:column;z-index:25;}
.fwin-tabs{display:flex;gap:4px;flex:1;min-width:0;overflow-x:auto;scrollbar-width:none;}
.ftab{display:flex;align-items:center;gap:6px;padding:3px 8px;border:1px solid var(--line);
  border-radius:6px;cursor:pointer;color:var(--dim);font-size:9.5px;white-space:nowrap;flex:none;}
.ftab:hover{border-color:rgba(243,238,226,.3);}
.ftab.on{border-color:var(--lime);color:var(--cream);background:rgba(201,255,46,.06);}
.ftab-x{background:none;border:none;color:var(--dimmer);font-size:9px;line-height:1;
  cursor:pointer;padding:0;font-family:var(--mono);}
.ftab-x:hover{color:var(--pink);}
.ftab-body{flex:1;display:flex;flex-direction:column;min-height:0;}
.fwin-body{flex:1;overflow:auto;display:flex;align-items:flex-start;}
.fwin-gut{flex:none;min-width:30px;padding:8px 6px 8px 10px;text-align:right;color:var(--dimmer);
  font-size:10.5px;line-height:1.5;user-select:none;border-right:1px solid var(--line);}
.fwin-ta{flex:1;background:none;border:none;outline:none;resize:none;color:var(--cream);
  font-family:var(--mono);font-size:10.5px;line-height:1.5;padding:8px 10px;
  caret-color:var(--lime);white-space:pre;overflow:hidden;}
.fwin-foot{display:flex;align-items:center;gap:10px;padding:7px 12px;border-top:1px solid var(--line);}
.fbtn{background:rgba(243,238,226,.06);border:1px solid var(--line);border-radius:6px;
  color:var(--dim);font-family:var(--mono);font-size:9.5px;letter-spacing:.04em;
  padding:4px 9px;cursor:pointer;}
.fbtn:hover:not(:disabled){border-color:rgba(243,238,226,.3);color:var(--cream);}
.fbtn:disabled{opacity:.4;cursor:default;}
.fbtn.primary{border-color:var(--lime);color:var(--lime);}
.fbtn.primary:hover:not(:disabled){background:rgba(201,255,46,.08);}
.fstate{flex:1;text-align:right;font-size:9.5px;letter-spacing:.06em;}
.fstate.mod{color:var(--orange);} .fstate.ok{color:var(--lime);} .fstate.clean{color:var(--dimmer);}
.fdiff{flex:1;overflow:auto;padding:8px 0;font-size:10.5px;line-height:1.5;}
.fdiff .row{padding:0 12px;white-space:pre;}
.fdiff .add{color:var(--lime);background:rgba(201,255,46,.08);}
.fdiff .del{color:var(--pink);background:rgba(255,47,134,.09);}
.fdiff .ctx{color:var(--dim);}
.fdiff-clean{padding:14px;color:var(--dimmer);font-size:10.5px;}
/* Agent-opened file extras: prompt banner, read-only view with highlights,
   and the accept/reject suggestion strip. */
.fwin-banner{padding:7px 12px;font-size:10px;letter-spacing:.04em;color:var(--cream);
  background:rgba(201,255,46,.08);border-bottom:1px solid var(--line);}
.fwin-view{flex:1;overflow:auto;}
.fwin-pre{margin:0;padding:8px 12px;font-family:var(--mono);font-size:10.5px;line-height:1.55;
  color:var(--cream);white-space:pre;}
.fhi{padding:0 2px;border-radius:2px;color:var(--cream);}
.fhi.info{background:rgba(112,206,255,.18);box-shadow:0 0 0 1px rgba(112,206,255,.35) inset;}
.fhi.warn{background:rgba(255,178,76,.18);box-shadow:0 0 0 1px rgba(255,178,76,.4) inset;}
.fhi.error{background:rgba(255,47,134,.16);box-shadow:0 0 0 1px rgba(255,47,134,.4) inset;}
.fwin-sugg{display:flex;flex-direction:column;gap:6px;padding:8px 12px;
  border-top:1px solid var(--line);background:rgba(243,238,226,.03);}
.fwin-sugg-body{display:flex;flex-direction:column;gap:5px;font-size:10.5px;}
.fwin-sugg-reason{color:var(--dim);font-size:9.5px;letter-spacing:.04em;}
.fwin-sugg-diff{display:flex;flex-direction:column;font-family:var(--mono);font-size:10px;
  border:1px solid var(--line);border-radius:5px;overflow:hidden;}
.fwin-sugg-row{padding:3px 8px;white-space:pre-wrap;word-break:break-word;}
.fwin-sugg-row.del{color:var(--pink);background:rgba(255,47,134,.08);}
.fwin-sugg-row.add{color:var(--lime);background:rgba(201,255,46,.08);}
.fwin-sugg-actions{display:flex;justify-content:flex-end;gap:6px;}

/* ── CONTEXT MENU (right-click on rings / orbiter dots) ───────────────────── */
.ctx-menu{position:absolute;z-index:65;min-width:148px;padding:4px;
  background:linear-gradient(180deg,rgba(22,22,26,.98),rgba(13,13,16,.98));
  border:1px solid var(--line);border-radius:9px;
  box-shadow:0 12px 30px rgba(0,0,0,.5);}
.ctx-title{padding:5px 10px 3px;font-size:8.5px;letter-spacing:.12em;text-transform:uppercase;
  color:var(--dimmer);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px;}
.ctx-item{display:block;width:100%;text-align:left;background:none;border:none;
  border-radius:6px;padding:7px 10px;cursor:pointer;
  color:var(--cream);font-family:var(--mono);font-size:10.5px;letter-spacing:.03em;}
.ctx-item:hover{background:rgba(201,255,46,.1);color:var(--lime);}

/* ── PROBABILITY CLOUD (ribbon body + particle scatter inside each ring) ── */
/* Ribbon: tinted radial-gradient annulus, peaks near 0.55r (BAND_FRAC) and
   tapers to transparent on both edges so the dashed rim and the central seed
   stay legible. --cloud-tint is set per-ring; color-mix builds the alpha
   ramp without us having to parse the hex. mix-blend-mode:screen lifts the
   tint off the dark background without washing the file-type colors of the
   particles that sit on top. */
.cloud-ring{position:absolute;inset:0;pointer-events:none;border-radius:50%;
  mix-blend-mode:screen;
  background:radial-gradient(circle,
    transparent 22%,
    color-mix(in srgb, var(--cloud-tint, #f3eee2) 6%, transparent) 32%,
    color-mix(in srgb, var(--cloud-tint, #f3eee2) 18%, transparent) 55%,
    color-mix(in srgb, var(--cloud-tint, #f3eee2) 6%, transparent) 78%,
    transparent 88%);
}
.cloud-layer{position:absolute;inset:0;pointer-events:none;z-index:1;}
.cloud-p{position:absolute;display:block;border-radius:50%;
  transform:translate(-50%,-50%);will-change:opacity;}

/* ── FILE PICKER (left-click in a ring opens this) ────────────────────────── */
.file-picker{position:fixed;z-index:250;width:240px;padding:4px;
  display:flex;flex-direction:column;max-height:340px;
  background:linear-gradient(180deg,rgba(22,22,26,.98),rgba(13,13,16,.98));
  border:1px solid var(--line);border-radius:9px;
  box-shadow:0 12px 30px rgba(0,0,0,.5);}
.file-picker-search{flex:none;margin:2px 4px 4px;padding:5px 8px;border-radius:6px;
  background:rgba(243,238,226,.05);border:1px solid var(--line);
  color:var(--cream);font-family:var(--mono);font-size:10.5px;outline:none;}
.file-picker-search:focus{border-color:var(--lime);}
.file-picker-list{flex:1 1 auto;overflow-y:auto;overflow-x:hidden;
  scrollbar-width:thin;scrollbar-color:var(--line) transparent;}
.file-picker-list::-webkit-scrollbar{width:6px;}
.file-picker-list::-webkit-scrollbar-thumb{background:var(--line);border-radius:3px;}
.file-picker-empty{padding:8px 10px;color:var(--dimmer);font-family:var(--mono);
  font-size:10px;letter-spacing:.04em;text-align:center;}
.file-picker-row{display:flex;align-items:center;gap:8px;width:100%;
  background:none;border:none;border-radius:6px;padding:5px 8px;cursor:pointer;
  color:var(--cream);font-family:var(--mono);font-size:10.5px;letter-spacing:.02em;
  text-align:left;}
.file-picker-row:hover{background:rgba(201,255,46,.1);color:var(--lime);}
.file-picker-row.open{color:var(--lime);}
.file-picker-row.untracked{opacity:.55;}
.file-picker-swatch{flex:none;display:inline-block;width:7px;height:7px;
  transform:rotate(45deg);}
.file-picker-name{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;}
.file-picker-dirty{flex:none;width:5px;height:5px;border-radius:50%;
  background:var(--orange);box-shadow:0 0 4px var(--orange);}

/* ── TERMINAL TABS (SessionWin) — reuses the .ftab look from file windows ──── */
.swin-tabs{display:flex;align-items:center;gap:6px;padding:5px 8px;border-bottom:1px solid var(--line);flex:none;}
.ftab.add{padding:3px 7px;color:var(--dimmer);}
.ftab.add:hover{color:var(--lime);border-color:var(--lime);}
.ftab-busy{width:6px;height:6px;border-radius:50%;background:var(--cyan);
  box-shadow:0 0 5px var(--cyan);animation:orb-q-pulse 1.5s ease-in-out infinite;flex:none;}
.ftab-perm{width:6px;height:6px;border-radius:50%;background:var(--orange);
  box-shadow:0 0 5px var(--orange);flex:none;}
.swin-btn{flex:none;width:20px;height:18px;border-radius:5px;cursor:pointer;
  background:rgba(243,238,226,.08);border:1px solid rgba(243,238,226,.14);
  color:var(--dim);font-size:10px;line-height:1;font-family:var(--mono);
  display:grid;place-items:center;padding:0;}
.swin-btn:hover{border-color:var(--lime);color:var(--lime);}

/* ── HOVER LABEL OVERLAY (portal-mounted top-layer chip) ──────────────────── */
/* Anchored at the cursor's current diamond/dot via viewport coords. position:fixed
   escapes every ancestor stacking context and z-index lifts it above the orb,
   tethers, terminals, and adjacent rings — guaranteed visibility for hovered items. */
.label-overlay{position:fixed;z-index:200;pointer-events:none;
  display:flex;align-items:center;gap:6px;
  padding:4px 9px;background:rgba(8,8,10,.96);
  border:1px solid rgba(201,255,46,.5);border-radius:6px;
  font-family:var(--mono);font-size:10.5px;letter-spacing:.04em;
  color:var(--cream);white-space:nowrap;max-width:340px;
  overflow:hidden;text-overflow:ellipsis;
  box-shadow:0 6px 20px rgba(0,0,0,.6),0 0 18px rgba(201,255,46,.18);
  animation:label-overlay-pop .12s ease-out;}
.label-overlay.below{transform:translate(-50%,14px);}
.label-overlay.above{transform:translate(-50%,calc(-100% - 14px));}
.label-overlay-dot{width:7px;height:7px;border-radius:50%;flex:none;
  box-shadow:0 0 8px currentColor;}
.label-overlay-text{display:inline-block;max-width:300px;
  overflow:hidden;text-overflow:ellipsis;}
@keyframes label-overlay-pop{from{opacity:0;}to{opacity:1;}}

/* ── 3D galaxy view ──────────────────────────────────────────────────────── */
.ax-topbar-btns{display:flex;align-items:center;gap:8px;}
.ax-gear.ax-viewtoggle{font-size:10px;letter-spacing:.05em;}
.gx-host{position:absolute;inset:0;z-index:1;}
.gx-pivot{position:absolute;top:calc(64px + env(safe-area-inset-top));left:calc(18px + env(safe-area-inset-left));z-index:2;display:flex;align-items:center;gap:7px;
  font-size:9.5px;letter-spacing:.08em;color:var(--dim);pointer-events:none;text-transform:uppercase;}
.gx-pivot-dot{width:7px;height:7px;border-radius:50%;background:var(--lime);box-shadow:0 0 8px var(--lime);}
.gx-pivot-dot.free{background:var(--orange);box-shadow:0 0 8px var(--orange);}

/* ── Tool dots: discrete left-edge rail, hidden until used ───────────────── */
.tbar-host{
  /* Same z as .gdock (the prompt) so the settings scrim (z:80) and raised
     FilePopups layer over it the same way they do the prompt. Vertically
     centered on the left edge; grows as a centered block since only a handful
     of dots are ever live at once. */
  position:fixed;left:14px;top:50%;transform:translateY(-50%);z-index:30;
  display:flex;flex-direction:column;align-items:flex-start;gap:8px;
  max-height:70vh;
  pointer-events:none;
}
.tbar-item{
  --tbar-tint: var(--lime);
  display:inline-flex;align-items:center;gap:8px;
  height:26px;padding:0 11px 0 9px;border-radius:13px;
  border:1px solid color-mix(in srgb, var(--tbar-tint) 40%, var(--line));
  background:rgba(14,16,14,.84);color:var(--cream);
  font-family:var(--mono);font-size:10px;letter-spacing:.02em;cursor:pointer;
  position:relative;outline:none;max-width:180px;
  pointer-events:auto;
  animation:tbar-in .2s cubic-bezier(.2,.7,.3,1);
  transition:border-color .15s ease, box-shadow .15s ease,
             transform .12s cubic-bezier(.2,.7,.3,1);
}
@keyframes tbar-in{from{opacity:0;transform:translateX(-10px) scale(.8);}to{opacity:1;transform:none;}}
.tbar-item:hover, .tbar-item:focus-visible, .tbar-item.is-pinned{
  border-color:color-mix(in srgb, var(--tbar-tint) 70%, transparent);
  box-shadow:0 0 14px color-mix(in srgb, var(--tbar-tint) 22%, transparent);
  transform:translateX(2px);
}
.tbar-dot{
  width:8px;height:8px;border-radius:50%;flex:none;
  background:var(--tbar-tint);
  box-shadow:0 0 6px color-mix(in srgb, var(--tbar-tint) 70%, transparent);
}
.tbar-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.tbar-count{
  position:absolute;top:-4px;right:-4px;
  min-width:14px;height:14px;padding:0 3px;border-radius:7px;
  background:var(--lime);color:var(--ink);
  font-size:9px;font-weight:700;line-height:14px;text-align:center;
  box-shadow:0 0 6px rgba(201,255,46,.5);
}
.tbar-item.is-invoking{
  animation:tbar-in .2s cubic-bezier(.2,.7,.3,1), tbar-pulse 1.2s ease-in-out infinite;
}
@keyframes tbar-pulse{
  0%,100%{box-shadow:0 0 6px color-mix(in srgb, var(--tbar-tint) 28%, transparent);}
  50%   {box-shadow:0 0 16px color-mix(in srgb, var(--tbar-tint) 60%, transparent);}
}
/* Flash then fade out: the dot is GC'd at the end of FLASH_MS, so the keyframes
   land already faded/scaled-down to make the unmount seamless. */
.tbar-item.is-flash{animation:tbar-flash .9s cubic-bezier(.2,.7,.3,1) forwards;}
@keyframes tbar-flash{
  0%  {opacity:1;box-shadow:0 0 22px color-mix(in srgb, var(--tbar-tint) 60%, transparent);}
  55% {opacity:1;}
  100%{opacity:0;transform:translateX(-10px) scale(.85);box-shadow:none;}
}
.tbar-item.is-flash.is-error{--tbar-tint:var(--pink);}
@media (prefers-reduced-motion: reduce){
  .tbar-item, .tbar-item.is-invoking, .tbar-item.is-flash{animation:none;}
}

/* ── Tool panel popover (hover card / result panel) ──────────────────────── */
.tp-pop{
  /* Just over the bubble bar (z:30). Anything that covers the bar — settings
     scrim (z:80), raised file popups past z:31 — also covers this. */
  position:fixed;z-index:31;pointer-events:none;
  max-width:340px;min-width:180px;
  padding:10px 12px;
  background:rgba(8,8,10,.96);
  border:1px solid var(--line);border-radius:8px;
  color:var(--cream);font-family:var(--mono);font-size:10.5px;line-height:1.5;
  box-shadow:0 8px 24px rgba(0,0,0,.6), 0 0 18px rgba(201,255,46,.10);
  animation:tp-pop-in-right .12s ease-out;
}
/* Anchored to the right of a left-rail dot, vertically centered on it. */
.tp-pop.tp-anchor-right{transform:translateY(-50%) translateX(14px);animation:tp-pop-in-right .12s ease-out;}
@keyframes tp-pop-in-right{from{opacity:0;transform:translateY(-50%) translateX(6px);}to{opacity:1;transform:translateY(-50%) translateX(14px);}}

/* Primitives */
.tp-text{display:inline;}
.tp-size-sm{font-size:9.5px;}
.tp-size-md{font-size:10.5px;}
.tp-size-lg{font-size:12px;}
.tp-heading{font-family:var(--disp);text-transform:uppercase;letter-spacing:.08em;
  font-size:11px;color:var(--cream);margin-bottom:4px;}
.tp-h1{font-size:14px;}
.tp-h2{font-size:12px;}
.tp-h3{font-size:10.5px;color:var(--dim);}
.tp-kv{display:flex;flex-direction:column;gap:3px;}
.tp-kv.tp-dense{gap:1px;}
.tp-kv-row{display:flex;justify-content:space-between;gap:12px;
  border-bottom:1px solid var(--line);padding:2px 0;}
.tp-kv-row:last-child{border-bottom:none;}
.tp-kv-k{color:var(--dim);}
.tp-kv-v{color:var(--cream);max-width:60%;text-align:right;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.tp-code{background:rgba(243,238,226,.06);border:1px solid var(--line);
  border-radius:5px;padding:6px 8px;margin:0;
  font-family:var(--mono);font-size:9.5px;color:var(--cream);
  white-space:pre-wrap;word-break:break-word;max-height:200px;overflow:auto;}
.tp-badge{display:inline-block;padding:1px 6px;border-radius:999px;
  font-size:9px;letter-spacing:.05em;text-transform:uppercase;
  border:1px solid var(--line);}
.tp-link{color:var(--cyan);text-decoration:underline;pointer-events:auto;}
.tp-link:hover{color:var(--lime);}
.tp-group{display:flex;}
.tp-dir-col{flex-direction:column;}
.tp-dir-row{flex-direction:row;align-items:center;}
.tp-gap-sm{gap:4px;}
.tp-gap-md{gap:8px;}
.tp-gap-lg{gap:14px;}
.tp-empty{color:var(--dim);font-style:italic;}

/* Tone palette — picks color from a closed set; unknown tones fall through */
.tp-tone-cream{color:var(--cream);}
.tp-tone-dim{color:var(--dim);}
.tp-tone-lime, .tp-tone-ok{color:var(--lime);border-color:rgba(201,255,46,.35);}
.tp-tone-cyan, .tp-tone-info{color:var(--cyan);border-color:rgba(51,255,224,.35);}
.tp-tone-pink, .tp-tone-error{color:var(--pink);border-color:rgba(255,47,134,.35);}
.tp-tone-orange, .tp-tone-warn{color:var(--orange);border-color:rgba(255,106,26,.35);}

/* ── Tool dot: is-active (steady pulse for persistent state, e.g. timer) ──── */
.tbar-item.is-active{
  border-color:color-mix(in srgb, var(--tbar-tint) 65%, transparent);
  animation:tbar-in .2s cubic-bezier(.2,.7,.3,1), tbar-active-pulse 2s ease-in-out infinite;
}
@keyframes tbar-active-pulse{
  0%,100%{box-shadow:0 0 8px color-mix(in srgb, var(--tbar-tint) 30%, transparent);}
  50%   {box-shadow:0 0 16px color-mix(in srgb, var(--tbar-tint) 55%, transparent);}
}
@media (prefers-reduced-motion: reduce){
  .tbar-item.is-active{animation:none;}
}

/* ── App popups (Timer, Notes) ───────────────────────────────────────────── */
.app-pop{
  position:fixed;left:50%;bottom:calc(var(--tbar-bottom, 96px) + 50px + env(safe-area-inset-bottom));
  transform:translateX(-50%);z-index:65;
  width:min(300px, calc(100vw - 24px));
  background:linear-gradient(180deg,rgba(22,22,26,.97),rgba(13,13,16,.97));
  border:1px solid var(--line);border-radius:11px;overflow:hidden;
  box-shadow:0 16px 40px rgba(0,0,0,.55),0 0 30px rgba(201,255,46,.10);
  font-family:var(--mono);color:var(--cream);
  animation:app-pop-in .18s cubic-bezier(.2,.7,.3,1);
}
.app-pop.app-pop-wide{width:min(440px, calc(100vw - 24px));}
@keyframes app-pop-in{from{opacity:0;transform:translate(-50%,12px);}to{opacity:1;transform:translate(-50%,0);}}
.app-pop-head{
  display:flex;align-items:center;justify-content:space-between;
  padding:8px 12px;border-bottom:1px solid var(--line);
  font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim);
}
.app-pop-title{font-family:var(--disp);letter-spacing:.1em;color:var(--cream);}
.app-pop-close{
  background:none;border:none;color:var(--dim);cursor:pointer;
  width:22px;height:22px;border-radius:4px;font-size:16px;line-height:1;
}
.app-pop-close:hover{background:rgba(243,238,226,.08);color:var(--cream);}
.app-pop-body{padding:14px;display:flex;flex-direction:column;gap:12px;}

/* Buttons shared between apps */
.app-btn{
  flex:1;padding:6px 10px;border-radius:6px;cursor:pointer;
  font-family:var(--mono);font-size:10.5px;letter-spacing:.04em;
  background:rgba(243,238,226,.08);border:1px solid rgba(243,238,226,.14);color:var(--cream);
  transition:border-color .15s ease, background .15s ease;
}
.app-btn:hover{border-color:var(--lime);}
.app-btn-primary{background:var(--lime);border-color:var(--lime);color:var(--ink);font-weight:700;}
.app-btn-primary:hover{background:#d4ff4f;}

/* Timer face */
.tm-face{
  font-family:var(--disp);font-size:48px;letter-spacing:.04em;text-align:center;
  color:var(--cream);line-height:1;padding:6px 0;
}
.tm-face.tm-paused{color:var(--orange);}
.tm-face.tm-done{color:var(--lime);animation:tm-done-flash 0.6s ease-in-out infinite alternate;}
.tm-face.tm-idle{color:var(--dimmer);}
@keyframes tm-done-flash{from{opacity:.5;}to{opacity:1;}}
.tm-bar{
  width:100%;height:3px;border-radius:2px;
  background:rgba(243,238,226,.08);overflow:hidden;
}
.tm-bar-fill{
  height:100%;background:var(--orange);
  transition:width .25s linear;
}
.tm-controls{display:flex;gap:8px;align-items:center;}
.tm-input{
  flex:none;width:64px;padding:6px 8px;border-radius:6px;
  background:rgba(243,238,226,.08);border:1px solid rgba(243,238,226,.14);
  font-family:var(--mono);font-size:11px;color:var(--cream);outline:none;text-align:center;
}
.tm-input:focus{border-color:var(--lime);}

/* Notes textarea */
.nt-area{
  width:100%;min-height:200px;padding:10px;border-radius:6px;
  background:rgba(243,238,226,.04);border:1px solid var(--line);
  font-family:var(--mono);font-size:11px;line-height:1.6;color:var(--cream);
  resize:vertical;outline:none;
}
.nt-area:focus{border-color:var(--lime);}
.nt-area::placeholder{color:var(--dimmer);}
.nt-controls{display:flex;justify-content:space-between;align-items:center;}
.nt-meta{font-size:9.5px;color:var(--dim);}

/* Multiple-choice prompt — agent posed a question. Same chrome as perm-prompt
   so the user reads them with the same visual grammar, but options stack as
   numbered buttons (cyan accent to distinguish from the orange "approve" path). */
.q-prompt{display:flex;flex-direction:column;gap:6px;padding:8px 10px;
  border-top:1px solid var(--line);background:rgba(51,255,224,.06);}
.q-head{font-family:var(--mono);font-size:11px;color:var(--cream);line-height:1.4;}
.q-options{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;}
.q-opt-btn{display:flex;align-items:center;gap:8px;width:100%;padding:5px 8px;
  border:1px solid rgba(243,238,226,.14);border-radius:6px;cursor:pointer;
  background:rgba(243,238,226,.06);color:var(--cream);
  font-family:var(--mono);font-size:10.5px;text-align:left;}
.q-opt-btn:hover{border-color:var(--cyan);background:rgba(51,255,224,.12);}
.q-opt-btn:focus-visible{outline:2px solid var(--cyan);outline-offset:1px;}
.q-opt-num{display:inline-grid;place-items:center;flex:none;
  width:18px;height:18px;border-radius:50%;
  background:rgba(51,255,224,.2);color:var(--cyan);
  font-size:9.5px;font-weight:700;}
.q-opt-text{flex:1;line-height:1.4;}
.q-actions{display:flex;align-items:center;gap:8px;}
.q-cancel{flex:none;padding:3px 10px;border-radius:5px;cursor:pointer;
  font-family:var(--mono);font-size:9.5px;
  background:none;border:1px solid var(--line);color:var(--dim);}
.q-cancel:hover{border-color:var(--cream);color:var(--cream);}
.q-more{font-family:var(--mono);font-size:9px;color:var(--dimmer);margin-left:auto;}

/* Main-session question overlay — same dock placement as the permission overlay
   but slightly above it so both can appear simultaneously without overlap. */
.q-overlay{position:absolute;left:50%;transform:translateX(-50%);bottom:180px;
  width:min(420px,calc(100vw - 32px));z-index:60;display:flex;flex-direction:column;gap:6px;}
.q-overlay .q-prompt{border:1px solid var(--line);border-radius:8px;
  background:rgba(20,18,14,.92);backdrop-filter:blur(6px);}

/* Orb mode label — fixed position above the chat dock so it tracks the user's
   gaze instead of the orb's drifting screen position. Hidden when idle. */
.ax-orb-mode{position:fixed;left:50%;bottom:148px;transform:translateX(-50%);z-index:40;
  font-family:var(--mono);font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;
  color:var(--dim);pointer-events:none;white-space:nowrap;
  padding:3px 10px;border-radius:10px;background:rgba(12,12,14,.55);border:1px solid var(--line);}
.ax-orb-mode[data-state="listening"]{color:var(--lime);border-color:rgba(201,255,46,.35);}
.ax-orb-mode[data-state="thinking"]{color:var(--cyan);border-color:rgba(51,255,224,.35);}
.ax-orb-mode[data-state="responding"]{color:#ff6a1a;border-color:rgba(255,106,26,.35);}
.ax-orb-mode[data-state="error"]{color:#ff2f3a;border-color:rgba(255,47,58,.45);}

/* Voice-help popover — discoverability surface for voice intents that are
   otherwise invisible. Modal scrim catches outside-clicks; aside floats over
   the chat dock and tops out at a reasonable height on small screens. */
.vhelp-scrim{position:fixed;inset:0;z-index:80;background:rgba(8,8,10,.55);
  display:grid;place-items:center;backdrop-filter:blur(2px);}
.vhelp{width:min(440px,calc(100vw - 32px));max-height:min(560px,calc(100vh - 64px));
  display:flex;flex-direction:column;background:rgba(16,14,12,.96);
  border:1px solid var(--line);border-radius:10px;color:var(--cream);
  font-family:var(--mono);overflow:hidden;}
.vhelp-head{display:flex;align-items:center;justify-content:space-between;
  padding:10px 14px;border-bottom:1px solid var(--line);}
.vhelp-title{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--cream);}
.vhelp-x{background:none;border:none;color:var(--dim);font-size:18px;cursor:pointer;
  width:24px;height:24px;display:grid;place-items:center;border-radius:4px;}
.vhelp-x:hover{color:var(--cream);background:rgba(243,238,226,.06);}
.vhelp-body{padding:8px 14px 14px;overflow-y:auto;}
.vhelp-sec{margin-top:10px;}
.vhelp-sec h4{margin:0 0 4px;font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;
  color:var(--lime);font-weight:600;}
.vhelp-sec dl{margin:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:3px 12px;}
.vhelp-sec dt{font-size:10.5px;color:var(--cream);line-height:1.45;}
.vhelp-sec dd{font-size:10.5px;color:var(--dim);line-height:1.45;margin:0;}

/* Queue menu — pending unread transcripts + sub-agent requests. Shares the
   .vhelp shell so the chrome (scrim, head, scroll body) stays consistent. */
.axq-empty{margin:6px 0;font-size:11px;color:var(--dim);line-height:1.55;}
.axq-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;}
.axq-item{display:block;width:100%;background:rgba(243,238,226,.04);
  border:1px solid var(--line);border-radius:6px;padding:8px 10px;
  font-family:var(--mono);color:var(--cream);text-align:left;}
button.axq-item{cursor:pointer;}
button.axq-item:hover{border-color:rgba(243,238,226,.32);background:rgba(243,238,226,.07);}
.axq-trans{display:flex;align-items:center;gap:8px;}
.axq-row{display:flex;align-items:center;gap:8px;}
.axq-name{font-size:11px;letter-spacing:.02em;flex:1 1 auto;min-width:0;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.axq-tag{font-size:9.5px;color:var(--dim);background:rgba(243,238,226,.06);
  border-radius:3px;padding:1px 5px;letter-spacing:.08em;text-transform:uppercase;}
.axq-cta{font-size:9.5px;color:var(--lime);letter-spacing:.14em;text-transform:uppercase;}
.axq-kind{font-size:9px;color:var(--dim);letter-spacing:.16em;text-transform:uppercase;
  background:rgba(243,238,226,.05);border-radius:3px;padding:1px 5px;}
.axq-prompt{margin:6px 0 0;font-size:10.5px;line-height:1.5;color:var(--cream);
  white-space:pre-wrap;word-break:break-word;}
.axq-opts{list-style:disc inside;margin:6px 0 0;padding:0;font-size:10px;color:var(--dim);}
.axq-opts li{line-height:1.5;}
.axq-req.on{border-color:rgba(51,255,224,.35);}

/* Confirm dialog (e.g. "new session") — reuses .vhelp-scrim for the centered
   backdrop and .ax-settings-btn for the actions. */
.ax-confirm{width:min(380px,calc(100vw - 48px));background:rgba(16,14,12,.97);
  border:1px solid var(--line);border-radius:10px;color:var(--cream);
  font-family:var(--mono);padding:20px;display:flex;flex-direction:column;gap:12px;}
.ax-confirm h4{margin:0;font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--lime);}
.ax-confirm p{margin:0;font-size:11.5px;line-height:1.55;color:var(--dim);}
.ax-confirm-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:4px;}
`

export function injectConstellationStyles(): void {
  let el = document.getElementById('ax-const-css')
  if (!el) {
    el = document.createElement('style')
    el.id = 'ax-const-css'
    document.head.appendChild(el)
  }
  // Always sync — ensures CSS updates land even after HMR without a full reload
  if (el.textContent !== CONSTELLATION_CSS) el.textContent = CONSTELLATION_CSS
}
