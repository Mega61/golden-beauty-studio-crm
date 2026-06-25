import type { StrapiApp } from '@strapi/strapi/admin';
import { Clock } from '@strapi/icons';
import WinbackBadge from './components/WinbackBadge';

const SSO_URL = '/strapi-plugin-sso/google';
const BUTTON_ID = 'gbs-sso-google-button';
const MOBILE_STYLE_ID = 'gbs-mobile-admin-css';

// The owner edits mostly from her phone. Strapi 5's admin is progressively going
// responsive (nav/subnav already are), but the content-manager forms can still
// be fiddly on a small screen. These additive tweaks (scoped to ≤767px, so
// desktop is untouched) target the universal touch pain points without relying
// on Strapi's hashed styled-component class names: 16px inputs to stop iOS
// zoom-on-focus, comfortable tap targets, tighter gutters, and forcing the
// two-column edit layout to stack into one column. Pair with the per-field
// "full width" edit-view setting (see docs Part 10c).
const MOBILE_CSS = `
@media (max-width: 767px) {
  /* Stop iOS Safari zooming when a field gains focus + readable text */
  input, textarea, select, [role="combobox"], [role="textbox"], [contenteditable] {
    font-size: 16px !important;
  }
  /* Comfortable touch targets */
  input:not([type="checkbox"]):not([type="radio"]),
  select,
  [role="combobox"] {
    min-height: 44px !important;
  }
  button:not([aria-hidden="true"]), a[role="button"] {
    min-height: 40px !important;
  }
  /* Use the full screen width — trim the wide desktop gutters */
  main { padding-left: 10px !important; padding-right: 10px !important; }
  /* Stack any 2+ column CSS grids in the content area (edit form + side panel,
     relation rows) into a single column so nothing scrolls off-screen */
  main [style*="grid-template-columns"] { grid-template-columns: 1fr !important; }
}
`;

function injectMobileStyles(): void {
  if (document.getElementById(MOBILE_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = MOBILE_STYLE_ID;
  style.textContent = MOBILE_CSS;
  document.head.appendChild(style);
}

function isLoginPage(): boolean {
  return window.location.pathname.endsWith('/auth/login');
}

function injectSsoButton(): void {
  if (!isLoginPage()) return;
  if (document.getElementById(BUTTON_ID)) return;

  const form = document.querySelector('main form');
  if (!form) return;

  const wrapper = document.createElement('div');
  wrapper.id = BUTTON_ID;
  wrapper.style.cssText =
    'display:flex;flex-direction:column;gap:12px;margin-top:24px;';

  const divider = document.createElement('div');
  divider.style.cssText =
    'display:flex;align-items:center;gap:12px;color:#666687;font-size:12px;text-transform:uppercase;';
  divider.innerHTML =
    '<span style="flex:1;height:1px;background:#dcdce4;"></span><span>o</span><span style="flex:1;height:1px;background:#dcdce4;"></span>';

  const button = document.createElement('a');
  button.href = SSO_URL;
  button.textContent = 'Iniciar sesión con Google';
  button.style.cssText =
    'display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 16px;background:#ffffff;color:#32324d;border:1px solid #dcdce4;border-radius:4px;font-weight:600;text-decoration:none;cursor:pointer;transition:background 0.15s;';
  button.addEventListener(
    'mouseenter',
    () => (button.style.background = '#f6f6f9'),
  );
  button.addEventListener(
    'mouseleave',
    () => (button.style.background = '#ffffff'),
  );

  wrapper.appendChild(divider);
  wrapper.appendChild(button);
  form.appendChild(wrapper);
}

export default {
  config: {
    // Enable the Spanish admin UI so the (Spanish-speaking) owner can switch the
    // whole panel to Español in her profile. English stays available too.
    locales: ['es'],
  },
  register(app: StrapiApp) {
    // Surface A — the "Retoques" dashboard page (plan §4.2).
    app.addMenuLink({
      to: '/winback',
      icon: Clock,
      intlLabel: { id: 'winback.menu.label', defaultMessage: 'Retoques' },
      permissions: [],
      Component: () => import('./pages/Winback'),
    });

    // Surface B — inline retoque badge in the Client edit view (plan §4.3).
    // 5.46 only renders the `right-links` zone in the edit view's side panels.
    app.getPlugin('content-manager').injectComponent('editView', 'right-links', {
      name: 'winback-badge',
      Component: WinbackBadge,
    });
  },
  bootstrap(_app: StrapiApp) {
    injectMobileStyles();
    injectSsoButton();

    const observer = new MutationObserver(() => injectSsoButton());
    observer.observe(document.body, { childList: true, subtree: true });
  },
};
