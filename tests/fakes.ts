import type { SavedLogin } from "../src/saved-login";

export const noSavedLogin: SavedLogin = {
  available: false,
  remember: async () => {},
  recall: async () => undefined,
  forget: async () => {},
};
