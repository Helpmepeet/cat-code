export const BROWSER_DIALOG_BINDING = '__catBrowserDialogReport'
// Main-world code, installed in each document before page scripts run.
export const BROWSER_DIALOG_SCRIPT = `(() => {
  if (Object.prototype.hasOwnProperty.call(window, '__catBrowserDialogs')) return;
  const state = { armed: false };
  Object.defineProperty(window, '__catBrowserDialogs', { value: state });
  const shared = () => { try { return window.top.__catBrowserDialogs || state; } catch { return state; } };
  const report = (type, message, accepted) => {
    try { window.${BROWSER_DIALOG_BINDING}(JSON.stringify({ type, message: String(message ?? '').slice(0, 2000), accepted })); } catch {}
  };
  window.alert = message => { report('alert', message, false); };
  window.confirm = message => { const s = shared(); const accepted = s.armed === true; s.armed = false; report('confirm', message, accepted); return accepted; };
})()`
export const BROWSER_ARM_CONFIRM_SCRIPT = `(() => { let state; try { state = window.top.__catBrowserDialogs; } catch {} state = state || window.__catBrowserDialogs; if (!state) throw new Error('Dialog shim is unavailable'); state.armed = true; })()`
