type TelegramWebApp = {
  initData: string;
  ready: () => void;
  expand: () => void;
};

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export function getTelegramInitData() {
  return window.Telegram?.WebApp?.initData ?? "";
}

export function initializeTelegramWebApp() {
  window.Telegram?.WebApp?.ready();
  window.Telegram?.WebApp?.expand();
}
