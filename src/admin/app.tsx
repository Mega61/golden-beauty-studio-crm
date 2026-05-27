import type { StrapiApp } from '@strapi/strapi/admin';

const SSO_URL = '/strapi-plugin-sso/google';
const BUTTON_ID = 'gbs-sso-google-button';

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
    locales: [],
  },
  bootstrap(_app: StrapiApp) {
    injectSsoButton();

    const observer = new MutationObserver(() => injectSsoButton());
    observer.observe(document.body, { childList: true, subtree: true });
  },
};
