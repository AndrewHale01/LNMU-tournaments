type TelegramWebApp = {
  initData: string;
  initDataUnsafe?: {
    user?: TelegramUser;
  };
  ready: () => void;
  expand: () => void;
};

export type TelegramUser = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
};

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export function getTelegramInitData() {
  return window.Telegram?.WebApp?.initData ?? "";
}

export function getTelegramUser() {
  return window.Telegram?.WebApp?.initDataUnsafe?.user ?? null;
}

export function initializeTelegramWebApp() {
  window.Telegram?.WebApp?.ready();
  window.Telegram?.WebApp?.expand();
}
